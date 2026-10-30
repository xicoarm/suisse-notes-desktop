import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Mobile session authority (src/services/sessionAuthority.js), security
// review 10/2026 round 6. Every test failed at 2349920b.

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isMobile: () => true, isIOS: () => false, isAndroid: () => true,
  getPlatform: () => 'android', PlatformConstants: {}
}));
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn(), setUser: vi.fn() }));
vi.mock('../../src/boot/sentry', () => sentry);
const device = vi.hoisted(() => ({ onLogout: null }));
vi.mock('../../src/stores/device', () => ({
  useDeviceStore: () => ({ reloadForUser: vi.fn(async () => {}), onLogout: async () => { if (device.onLogout) await device.onLogout(); } })
}));
vi.mock('../../src/stores/minutes', () => ({ useMinutesStore: () => ({ fetchMinutes: vi.fn(async () => ({})), setFromServer: vi.fn(), reset: vi.fn() }) }));
vi.mock('../../src/stores/recordings-history', () => ({ useRecordingsHistoryStore: () => ({ reset: vi.fn() }) }));
vi.mock('../../src/stores/transcription-settings', () => ({ useTranscriptionSettingsStore: () => ({ reset: vi.fn() }) }));
vi.mock('../../src/services/upload', () => ({ getMobileUploadQueue: () => [], processMobileUploadQueue: async () => ({}) }));
const net = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../src/services/api', () => ({
  apiRequest: vi.fn(async (...a) => { net.calls.push(a); return { ok: false, status: 500 }; }),
  authenticatedRequest: vi.fn(async (...a) => { net.calls.push(a); return { ok: false, status: 500 }; }),
  parseJsonSafe: vi.fn(async () => ({})),
  getApiUrlSync: () => 'https://api.example',
  API_ENDPOINTS: { refreshToken: '/api/auth/refresh', login: '/api/auth/desktop' }
}));

// Device storage: keystore (with faults and a gate to hold a write), Preferences.
const disk = vi.hoisted(() => ({ ks: new Map(), prefs: new Map(), failRemove: false, failSet: false, failGet: false, gate: null }));
vi.mock('@capacitor/core', () => {
  const keystore = {
    get: async ({ key }) => {
      if (disk.failGet) throw new Error('KEYSTORE_READ_FAILED');
      return { value: disk.ks.has(key) ? disk.ks.get(key) : null };
    },
    set: async ({ key, value }) => {
      if (disk.gate) await disk.gate;
      if (disk.failSet) throw new Error('KEYSTORE_WRITE_FAILED');
      disk.ks.set(key, value);
    },
    remove: async ({ key }) => {
      if (disk.failRemove) throw new Error('KEYSTORE_REMOVE_FAILED');
      disk.ks.delete(key);
    }
  };
  return { registerPlugin: () => new Proxy({}, { get: (_, p) => (typeof keystore[p] === 'function' ? keystore[p] : undefined) }) };
});
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }) => ({ value: disk.prefs.has(key) ? disk.prefs.get(key) : null }),
    set: async ({ key, value }) => { disk.prefs.set(key, value); },
    remove: async ({ key }) => { disk.prefs.delete(key); }
  }
}));

const jwt = (userId, tag = '') => `h.${Buffer.from(JSON.stringify({ userId, tag })).toString('base64url')}.s`;
const RECORD = 'auth.session.v1';
const FLOW = 'sso.pendingFlow.v1';

let authority;
let storage;
let ssoFlow;
let useAuthStore;
let createSSOResultHandler;

async function restart() {
  vi.resetModules();
  setActivePinia(createPinia());
  authority = await import('../../src/services/sessionAuthority');
  storage = await import('../../src/services/secureStorage');
  ssoFlow = await import('../../src/services/ssoFlow');
  ({ useAuthStore } = await import('../../src/stores/auth'));
  ({ createSSOResultHandler } = await import('../../src/boot/sso'));
}

const signIn = (userId, tag = 'pw', kind = 'login', ticket = authority.sessionTicket()) =>
  authority.applySession(ticket, { token: jwt(userId, tag), user: { id: userId } }, { kind });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(async () => {
  disk.ks.clear();
  disk.prefs.clear();
  disk.failRemove = false;
  disk.failSet = false;
  disk.failGet = false;
  disk.gate = null;
  device.onLogout = null;
  net.calls.length = 0;
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await restart();
});

describe('R1: mobile - an open flow and a callback without state', () => {
  it('no session, the flow keeps waiting, no navigation, sso_missing_state counted', async () => {
    const store = useAuthStore();
    const router = { currentRoute: { value: { name: 'login' } }, isReady: vi.fn(async () => {}), push: vi.fn(async () => {}) };
    const handle = createSSOResultHandler({ getAuthStore: () => store, router, closeBrowser: vi.fn(async () => {}) });
    store.beginSSO('microsoft');
    await ssoFlow.beginSsoFlow('microsoft');
    for (const payload of [{ token: jwt('evil'), user: { id: 'evil' }, state: '' }, { authCode: 'c', state: '' }, { error: 'access_denied', state: '' }]) {
      await handle(payload);
    }
    expect(store.isAuthenticated).toBe(false);
    expect(store.error).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(ssoFlow.hasPendingSsoFlow()).toBe(true);
    const counted = sentry.captureMessage.mock.calls.filter(([m]) => m === 'sso_missing_state');
    expect(counted).toHaveLength(3);
    // Codes only: no tags, no URL, no user data.
    expect(counted[0]).toEqual(['sso_missing_state', 'warning', { fingerprint: ['sso_missing_state'] }]);
    expect(disk.ks.size).toBe(0);
    expect(net.calls).toEqual([]);
  });

  it('without an open flow nothing is counted', async () => {
    const store = useAuthStore();
    await store.completeSSO({ token: jwt('evil'), user: { id: 'evil' }, state: '' });
    expect(sentry.captureMessage.mock.calls.filter(([m]) => m === 'sso_missing_state')).toHaveLength(0);
  });
});

describe('R4: a stored flow is consumed only with a confirmed delete', () => {
  it('storage() null exactly at the delete: refused, also after a restart', async () => {
    const flow = await ssoFlow.beginSsoFlow('google');
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    let reads = 0;
    // Readable for the lookup, gone when the flow is deleted.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { reads++; if (reads > 1) throw new Error('SecurityError'); return real.get ? real.get.call(globalThis) : real.value; }
    });
    let result;
    try {
      result = ssoFlow.consumeSsoFlow({ state: flow.state, token: jwt('u1'), user: { id: 'u1' } });
    } finally {
      Object.defineProperty(globalThis, 'localStorage', real);
    }
    expect(result).toEqual({ ok: false, reason: 'flow_not_cleared' });
    // Nothing could be written in that moment (no storage at all). After the
    // restart the state, never accepted so far, is accepted at most once:
    // only with a confirmed delete, and never again afterwards.
    await restart();
    const replay = { state: flow.state, token: jwt('u1'), user: { id: 'u1' } };
    const accepted = [ssoFlow.consumeSsoFlow(replay).ok];
    expect(localStorage.getItem(FLOW)).toBeNull();
    accepted.push(ssoFlow.consumeSsoFlow(replay).ok);
    await restart();
    accepted.push(ssoFlow.consumeSsoFlow(replay).ok);
    expect(accepted.filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(accepted.slice(1)).toEqual([false, false]);
  });

  it('storage() null for the whole consume: refused in this run (the stored flow cannot be confirmed gone)', async () => {
    const flow = await ssoFlow.beginSsoFlow('google');
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
      expect(ssoFlow.consumeSsoFlow({ state: flow.state, authCode: 'c' })).toEqual({ ok: false, reason: 'flow_not_cleared' });
      expect(ssoFlow.consumeSsoFlow({ state: flow.state, authCode: 'c' }).ok).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', real);
    }
  });

  it('removeItem throws at the delete: refused, also after a restart', async () => {
    const flow = await ssoFlow.beginSsoFlow('google');
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((k) => { if (k === FLOW) throw new Error('QuotaExceeded'); });
    expect(ssoFlow.consumeSsoFlow({ state: flow.state, authCode: 'c' })).toEqual({ ok: false, reason: 'flow_not_cleared' });
    remove.mockRestore();
    await restart();
    expect(ssoFlow.consumeSsoFlow({ state: flow.state, authCode: 'c' }).ok).toBe(false);
  });
});

describe('E1: one record; unreadable = signed out', () => {
  it('a corrupt record with a session in the keystore: signed out, no token', async () => {
    await signIn('a');
    localStorage.setItem(RECORD, '{oops');
    await restart();
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    expect(await storage.getToken()).toBeNull();
    const store = useAuthStore();
    await store.checkSession();
    expect(store.isAuthenticated).toBe(false);
    expect(net.calls).toEqual([]);
  });
});

describe('E3: applySession and signOut are serialized (mutex)', () => {
  it('a sign-out while the keystore write of a sign-in runs: signed out, also after a restart', async () => {
    const gate = deferred();
    disk.gate = gate.promise;
    const signingIn = signIn('a');
    await new Promise((r) => setTimeout(r, 0));
    const signingOut = authority.signOut();
    expect(await storage.getToken()).toBeNull();
    disk.gate = null;
    gate.resolve();
    expect(await signingIn).toEqual({ applied: false, reason: 'session_changed' });
    expect(await signingOut).toMatchObject({ success: true });
    expect(authority.isSignedOut()).toBe(true);
    expect(disk.ks.size).toBe(0);
    await restart();
    expect(await authority.loadSession()).toEqual({ signedOut: true });
  });

  it('a password answer A after SSO B: B stays', async () => {
    const passwordTicket = authority.sessionTicket();
    const flow = await ssoFlow.beginSsoFlow('microsoft');
    const store = useAuthStore();
    const sso = await store.completeSSO({ token: jwt('b'), user: { id: 'b' }, state: flow.state });
    store.stopTokenRefresh();
    expect(sso.success).toBe(true);
    const late = await store._completePasswordLogin({ token: jwt('a'), user: { id: 'a' } }, passwordTicket);
    expect(late).toBe(false);
    expect(store.user.id).toBe('b');
    expect(disk.ks.get('authToken')).toBe(jwt('b'));
  });

  it('a refresh with another userId is dropped', async () => {
    await signIn('a');
    const ticket = authority.sessionTicket({ userId: 'a' });
    expect(await authority.applySession(ticket, { token: jwt('b', 'r') }, { kind: 'refresh' })).toEqual({ applied: false, reason: 'user_mismatch' });
    expect(disk.ks.get('authToken')).toBe(jwt('a', 'pw'));
  });
});

describe('E4: a flow of an old epoch', () => {
  it('a stored flow left behind by a session change is refused after a restart', async () => {
    const flow = await ssoFlow.beginSsoFlow('microsoft');
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((k) => { if (k === FLOW) throw new Error('denied'); });
    await signIn('pw');
    await authority.signOut();
    remove.mockRestore();
    expect(localStorage.getItem(FLOW)).not.toBeNull();
    await restart();
    expect(ssoFlow.consumeSsoFlow({ state: flow.state, token: jwt('sso'), user: { id: 'sso' } })).toEqual({ ok: false, reason: 'stale_flow' });
  });
});

describe('E5: sign-out order and outcome', () => {
  it('record not writable and the keystore delete failing: the UI shows an error, signed out', async () => {
    const store = useAuthStore();
    const ticket = authority.sessionTicket();
    expect(await store._completePasswordLogin({ token: jwt('a'), user: { id: 'a' } }, ticket)).toBe(true);
    store.stopTokenRefresh();
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => { if (k === RECORD) throw new Error('QuotaExceeded'); });
    disk.failRemove = true;
    const { i18n } = await import('../../src/boot/i18n');
    i18n.global.locale.value = 'en';
    expect(await store.logout()).toEqual({ success: false });
    set.mockRestore();
    expect(store.isAuthenticated).toBe(false);
    expect(store.error).toBe(i18n.global.getLocaleMessage('en').signOutIncomplete);
    expect(await storage.getToken()).toBeNull();
  });

  it('no token is readable while the BLE clean-up runs; the tombstone is written before it', async () => {
    const store = useAuthStore();
    await store._completePasswordLogin({ token: jwt('a'), user: { id: 'a' } }, authority.sessionTicket());
    store.stopTokenRefresh();
    const seen = {};
    device.onLogout = async () => {
      seen.token = await storage.getToken();
      seen.storeToken = store.token;
      seen.userId = store.user?.id;
      seen.record = JSON.parse(localStorage.getItem(RECORD));
    };
    expect(await store.logout()).toEqual({ success: true });
    expect(seen).toEqual({ token: null, storeToken: null, userId: 'a', record: { epoch: expect.any(Number), signedOut: true } });
  });
});

describe('E6: the tombstone wins', () => {
  it('restart with tombstone and a token in the keystore: nothing restored, no request', async () => {
    await signIn('a');
    disk.failRemove = true;
    await authority.signOut();
    expect(disk.ks.get('authToken')).toBe(jwt('a', 'pw'));
    await restart();
    const store = useAuthStore();
    await store.checkSession();
    expect(store.isAuthenticated).toBe(false);
    expect(store.token).toBeNull();
    expect(await storage.getToken()).toBeNull();
    expect(net.calls).toEqual([]);
  });
});

describe('E8: no write failure counts as success', () => {
  it('record not writable at sign-in: memory only, the next start is signed out', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => { if (k === RECORD) throw new Error('QuotaExceeded'); });
    expect(await signIn('a')).toMatchObject({ applied: true, persisted: false });
    set.mockRestore();
    expect(authority.memoryOnlySession()).toMatchObject({ token: jwt('a', 'pw') });
    expect(disk.ks.size).toBe(0);
    await restart();
    expect(await authority.loadSession()).toEqual({ signedOut: true });
  });

  it('keystore not writable at sign-in: the next start is signed out', async () => {
    disk.failSet = true;
    expect(await signIn('a')).toMatchObject({ applied: true, persisted: false });
    disk.failSet = false;
    await restart();
    expect(await authority.loadSession()).toEqual({ signedOut: true });
  });
});

// E1 addendum (lead decision, review round 7): «missing» record = first start
// after the update. A keystore session (only intermediate builds have one;
// the release kept the session in plaintext Preferences, which stays
// discarded, T2) without the previous version's marker auth.signedOut=1 is
// taken over once. Each test failed at a3c841fa.
describe('E1 addendum: one-time migration of a keystore session (mobile)', () => {
  const MARK = 'auth.sessionMigrated';
  const OLD = jwt('old', 'legacy');
  const legacy = (user = { id: 'old' }, token = OLD) => {
    disk.ks.set('authToken', token);
    disk.ks.set('userInfo', JSON.stringify(user));
  };

  it('keystore token and user, no record, no marker: signed in, record {0,false}, mark set', async () => {
    legacy();
    await restart();
    expect(await authority.loadSession()).toEqual({ signedOut: false, token: OLD, user: { id: 'old' }, epoch: 0 });
    expect(JSON.parse(localStorage.getItem(RECORD))).toEqual({ epoch: 0, signedOut: false });
    expect(disk.ks.get(MARK)).toBe('1');
    expect(await storage.getToken()).toBe(OLD);
    await restart();
    expect(await authority.loadSession()).toMatchObject({ signedOut: false, token: OLD });
  });

  it('a second start without record after the mark: no second migration, signed out, deleted', async () => {
    legacy();
    await restart();
    await authority.loadSession();
    localStorage.removeItem(RECORD); // e.g. web storage cleared, keystore kept (iOS reinstall)
    await restart();
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    expect(await storage.getToken()).toBeNull();
    expect(disk.ks.has('authToken')).toBe(false);
    expect(disk.ks.has('userInfo')).toBe(false);
  });

  it('with the previous version\'s marker, another user, no userId or a plaintext Preferences session: signed out', async () => {
    const cases = {
      marker: () => { legacy(); localStorage.setItem('auth.signedOut', '1'); },
      otherUser: () => legacy({ id: 'other' }),
      noUserId: () => legacy({ id: 'old' }, jwt('', 'x')),
      noUser: () => disk.ks.set('authToken', OLD),
      preferencesOnly: () => { disk.prefs.set('authToken', OLD); disk.prefs.set('userInfo', JSON.stringify({ id: 'old' })); }
    };
    for (const [name, arrange] of Object.entries(cases)) {
      disk.ks.clear();
      disk.prefs.clear();
      localStorage.clear();
      arrange();
      await restart();
      expect(await authority.loadSession(), name).toEqual({ signedOut: true });
      expect(await storage.getToken(), name).toBeNull();
      expect(disk.ks.has('authToken'), name).toBe(false);
      expect(disk.prefs.has('authToken'), name).toBe(false);
      expect(JSON.parse(localStorage.getItem(RECORD)), name).toMatchObject({ signedOut: true });
      expect(disk.ks.get(MARK), name).toBe('1');
    }
  });

  it('a corrupt record with a keystore session: signed out, never migrated', async () => {
    legacy();
    localStorage.setItem(RECORD, '{oops');
    await restart();
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    expect(localStorage.getItem(RECORD)).toBe('{oops');
    expect(disk.ks.has('authToken')).toBe(false);
  });

  it('record not writable during the migration: RAM lock, keystore untouched, the next start migrates', async () => {
    legacy();
    await restart();
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => { if (k === RECORD) throw new Error('QuotaExceeded'); });
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    set.mockRestore();
    expect(await storage.getToken()).toBeNull();
    expect(authority.isSignedOut()).toBe(true);
    expect(disk.ks.get('authToken')).toBe(OLD);
    expect(disk.ks.has('userInfo')).toBe(true);
    expect(disk.ks.has(MARK)).toBe(false);
    await restart();
    expect(await authority.loadSession()).toMatchObject({ signedOut: false, token: OLD });
  });

  it('keystore not readable during the migration: RAM lock, nothing deleted, the next start migrates', async () => {
    legacy();
    await restart();
    const real = disk.ks.get.bind(disk.ks);
    disk.ks.get = () => { throw new Error('KEYSTORE_LOCKED'); };
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    disk.ks.get = real;
    expect(disk.ks.get('authToken')).toBe(OLD);
    await restart();
    expect(await authority.loadSession()).toMatchObject({ signedOut: false, token: OLD });
  });

  it('mark not writable: RAM lock, nothing deleted; the confirmed record is read at the next start', async () => {
    legacy();
    await restart();
    disk.failSet = true;
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    disk.failSet = false;
    expect(disk.ks.get('authToken')).toBe(OLD);
    await restart();
    expect(await authority.loadSession()).toMatchObject({ signedOut: false, token: OLD });
    expect(disk.ks.get(MARK)).toBe('1');
  });
});

describe('E9 double faults (mobile, r6 low findings)', () => {
  it('invalidateTickets with the record not writable: marked unreadable', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => { if (k === RECORD) throw new Error('QuotaExceeded'); });
    authority.invalidateTickets();
    set.mockRestore();
    expect(authority.isSignedOut()).toBe(true);
    expect(authority.currentEpoch()).toBeGreaterThan(0);
    const { unreadable } = authority.sessionState();
    expect(unreadable).toBe(true);
  });

  it('sign-in with the record not writable and the old keystore session not deletable: refused, RAM lock', async () => {
    await signIn('a');
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => { if (k === RECORD) throw new Error('QuotaExceeded'); });
    disk.failRemove = true;
    expect(await signIn('b')).toEqual({ applied: false, reason: 'storage_unavailable' });
    set.mockRestore();
    disk.failRemove = false;
    expect(authority.isSignedOut()).toBe(true);
    expect(authority.memoryOnlySession()).toBeNull();
    expect(await storage.getToken()).toBeNull();
  });
});

// R-S5 (review round 9, council 3; r8-MITTEL): a released session (RAM
// signedOut:false of the current epoch, also a memory-only session) gives
// token and user on EVERY further loadSession(), with the same read and
// userId check; loadSession().signedOut === isSignedOut(). The store's
// checkSession() after a sign-in therefore keeps the user signed in. Each
// test failed at 7c121955 (the second call answered «signed out»).
describe('R-S5: loadSession() of a released session', () => {
  const twice = async () => [await authority.loadSession(), await authority.loadSession()];
  const expectSignedIn = (results, token, userId) => {
    for (const r of results) {
      expect(r).toMatchObject({ signedOut: false, token, user: { id: userId } });
      expect(r.signedOut).toBe(authority.isSignedOut());
    }
    expect(results[0]).toEqual(results[1]);
  };

  // The store applies password, 2FA and registration results through
  // _applySignIn with kind 'login' (src/stores/auth.js), SSO with 'sso'.
  it.each([['password', 'pw'], ['2FA', '2fa'], ['registration', 'reg']])('directly after a %s sign-in: twice the same session', async (_, tag) => {
    expect(await signIn('a', tag)).toMatchObject({ applied: true, persisted: true });
    expectSignedIn(await twice(), jwt('a', tag), 'a');
  });

  it('directly after SSO: twice the same session', async () => {
    expect(await signIn('s', 'sso', 'sso')).toMatchObject({ applied: true });
    expectSignedIn(await twice(), jwt('s', 'sso'), 's');
  });

  it('after a refresh: the refreshed token, twice', async () => {
    await signIn('a');
    const ticket = authority.sessionTicket({ userId: 'a' });
    expect(await authority.applySession(ticket, { token: jwt('a', 'refreshed'), user: { id: 'a' } }, { kind: 'refresh' })).toMatchObject({ applied: true });
    expectSignedIn(await twice(), jwt('a', 'refreshed'), 'a');
  });

  it('after a restart: released once, then the same session on every call', async () => {
    await signIn('a');
    await restart();
    expectSignedIn([await authority.loadSession(), await authority.loadSession(), await authority.loadSession()].slice(1), jwt('a', 'pw'), 'a');
  });

  it('after a migration: the same session on the next call', async () => {
    disk.ks.set('authToken', jwt('old', 'legacy'));
    disk.ks.set('userInfo', JSON.stringify({ id: 'old' }));
    await restart();
    expectSignedIn(await twice(), jwt('old', 'legacy'), 'old');
  });

  it('a memory-only session (record not writable at sign-in): twice, without a keystore read', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => { if (k === RECORD) throw new Error('QuotaExceeded'); });
    expect(await signIn('a')).toMatchObject({ applied: true, persisted: false });
    set.mockRestore();
    disk.failGet = true;
    expectSignedIn(await twice(), jwt('a', 'pw'), 'a');
  });

  it('a read error: held (signed out, nothing deleted); the next readable call gives the session again', async () => {
    await signIn('a');
    disk.failGet = true;
    const held = await authority.loadSession();
    expect(held).toEqual({ signedOut: true });
    expect(authority.isSignedOut()).toBe(true);
    expect(authority.sessionState().migrationPending).toBe(true);
    disk.failGet = false;
    expect(disk.ks.get('authToken')).toBe(jwt('a', 'pw'));
    expectSignedIn(await twice(), jwt('a', 'pw'), 'a');
  });

  it('a read error after invalidateTickets: the old tickets stay invalid once the session is read again', async () => {
    await signIn('a');
    const old = authority.sessionTicket();
    authority.invalidateTickets();
    disk.failGet = true;
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    disk.failGet = false;
    expect(await authority.loadSession()).toMatchObject({ signedOut: false });
    expect(authority.isCurrentTicket(old)).toBe(false);
  });

  it('keystore token gone or of another user: signed out without deleting anything, invariant holds', async () => {
    await signIn('a');
    disk.ks.set('userInfo', JSON.stringify({ id: 'b' }));
    const mismatch = await authority.loadSession();
    expect(mismatch).toMatchObject({ signedOut: true, mismatch: true });
    expect(authority.isSignedOut()).toBe(true);
    expect(disk.ks.get('authToken')).toBe(jwt('a', 'pw'));
    disk.ks.delete('authToken');
    disk.ks.set('userInfo', JSON.stringify({ id: 'a' }));
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    expect(authority.isSignedOut()).toBe(true);
  });

  it('a sign-out wins over a running loadSession', async () => {
    await signIn('a');
    const pending = authority.loadSession();
    const out = authority.signOut();
    const result = await pending;
    await out;
    expect(result).toEqual({ signedOut: true });
    expect(authority.isSignedOut()).toBe(true);
    expect(await authority.loadSession()).toEqual({ signedOut: true });
  });

  it('store: checkSession() right after a sign-in keeps the user signed in', async () => {
    const store = useAuthStore();
    const token = `h.${Buffer.from(JSON.stringify({ userId: 'a', exp: Math.floor(Date.now() / 1000) + 7 * 86400 })).toString('base64url')}.s`;
    expect(await authority.applySession(authority.sessionTicket(), { token, user: { id: 'a' } }, { kind: 'login' })).toMatchObject({ applied: true });
    await store.checkSession();
    await store.checkSession();
    expect(store.isAuthenticated).toBe(true);
    expect(store.token).toBe(token);
    store.stopTokenRefresh?.();
  });
});
