import { describe, it, expect, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Mobile session storage, property test (review 10/2026, T1-T5):
// one fault at every single storage operation (keystore get/set/remove,
// Preferences get/remove, the sign-out marker), in a life of
// start (with a plaintext session of an older version) -> login -> refresh ->
// sign-out. After every step the app restarts (fresh modules, same
// persistence) and the restored session is checked:
// T1 never the plaintext value; T2 the plaintext copies are gone after a
// fault-free start; T3 nothing written to Preferences; T4 a failed save keeps
// the previous value; T5 after a sign-out nothing is restored.

const persist = { ks: new Map(), prefs: new Map() };
const fault = { op: null, n: 0, counting: false, counts: {}, always: null };
const prefsWrites = [];

function hit(op) {
  if (fault.always === op) throw new Error(`FAULT ${op} (always)`);
  if (!fault.counting) return;
  fault.counts[op] = (fault.counts[op] || 0) + 1;
  if (fault.op === op && fault.counts[op] === fault.n) throw new Error(`FAULT ${op}#${fault.n}`);
}

const keystore = {
  get: async ({ key }) => { hit('ks.get'); return { value: persist.ks.has(key) ? persist.ks.get(key) : null }; },
  set: async ({ key, value }) => { hit('ks.set'); persist.ks.set(key, value); },
  remove: async ({ key }) => { hit('ks.remove'); persist.ks.delete(key); }
};
const prefs = {
  get: async ({ key }) => { hit('prefs.get'); return { value: persist.prefs.has(key) ? persist.prefs.get(key) : null }; },
  set: async ({ key, value }) => { prefsWrites.push(key); persist.prefs.set(key, value); },
  remove: async ({ key }) => { hit('prefs.remove'); persist.prefs.delete(key); }
};
// Capacitor plugin proxy: answers every property (also `then`).
const proxy = (impl) => new Proxy({}, {
  get: (_, prop) => (typeof prop === 'string' && typeof impl[prop] === 'function' ? impl[prop] : () => new Promise(() => {}))
});

vi.mock('@capacitor/core', () => ({ registerPlugin: (name) => proxy(name === 'SecureTokenStore' ? keystore : {}) }));
vi.mock('@capacitor/preferences', () => ({ Preferences: proxy(prefs) }));
vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isMobile: () => true, isIOS: () => false, isAndroid: () => true,
  getPlatform: () => 'android', PlatformConstants: {}
}));
vi.mock('../../src/boot/sentry', () => ({
  addBreadcrumb: () => {}, captureException: () => {}, captureMessage: () => {}, setUser: () => {}
}));
vi.mock('../../src/stores/device', () => ({ useDeviceStore: () => ({ reloadForUser: async () => {}, onLogout: async () => {} }) }));
vi.mock('../../src/stores/minutes', () => ({ useMinutesStore: () => ({ fetchMinutes: async () => ({}), setFromServer: () => {}, reset: () => {} }) }));
vi.mock('../../src/stores/recordings-history', () => ({ useRecordingsHistoryStore: () => ({ reset: () => {} }) }));
vi.mock('../../src/stores/transcription-settings', () => ({ useTranscriptionSettingsStore: () => ({ reset: () => {} }) }));
vi.mock('../../src/services/upload', () => ({ getMobileUploadQueue: () => [], processMobileUploadQueue: async () => ({}) }));
const refreshAnswer = vi.hoisted(() => ({ token: null, user: null }));
vi.mock('../../src/services/api', () => ({
  apiRequest: async () => ({}),
  authenticatedRequest: async () => ({ ok: true, status: 200 }),
  parseJsonSafe: async () => ({ token: refreshAnswer.token, user: refreshAnswer.user }),
  getApiUrlSync: () => 'https://api.example',
  API_ENDPOINTS: { refreshToken: '/api/auth/refresh' }
}));

// The sign-out marker (localStorage) is a fault point as well.
const MARKER = 'auth.signedOut';
const realSet = Storage.prototype.setItem;
const realGet = Storage.prototype.getItem;
const realRemove = Storage.prototype.removeItem;
Storage.prototype.setItem = function (k, v) { if (k === MARKER) hit('marker'); return realSet.call(this, k, v); };
Storage.prototype.getItem = function (k) { if (k === MARKER) hit('marker'); return realGet.call(this, k); };
Storage.prototype.removeItem = function (k) { if (k === MARKER) hit('marker'); return realRemove.call(this, k); };

const DAY = 24 * 60 * 60 * 1000;
const jwt = (userId, tag) => `h.${Buffer.from(JSON.stringify({ userId, tag, exp: Math.floor((Date.now() + 7 * DAY) / 1000) })).toString('base64url')}.s`;
const LEGACY = jwt('old', 'legacy');
const A1 = jwt('a', 'login');
const A2 = jwt('a', 'refresh');
const B1 = jwt('b', 'login');
const AUTH_KEYS = ['authToken', 'refreshToken', 'userId', 'userEmail', 'userInfo'];

/** App start: fresh modules, fresh pinia, same persistence. */
async function start() {
  vi.resetModules();
  setActivePinia(createPinia());
  const { useAuthStore } = await import('../../src/stores/auth');
  const store = useAuthStore();
  try { await store.checkSession(); } catch { /* an abort is a valid outcome */ }
  store.stopTokenRefresh();
  return store;
}

async function step(fn) {
  fault.counting = true;
  try { await fn(); } catch { /* the fault aborted the step */ }
  fault.counting = false;
}

/** One life with an optional fault; returns the violations found. */
async function life(op = null, n = 0) {
  persist.ks.clear();
  persist.prefs.clear();
  prefsWrites.length = 0;
  localStorage.clear();
  fault.op = op; fault.n = n; fault.counts = {};
  // An older version left the session in plaintext Preferences.
  persist.prefs.set('authToken', LEGACY);
  persist.prefs.set('userInfo', JSON.stringify({ id: 'old' }));
  persist.prefs.set('userId', 'old');
  persist.prefs.set('ble_app_uuid', 'pairing-uuid'); // not an auth key (T6)

  const bad = [];
  const check = (cond, msg) => { if (!cond) bad.push(msg); };

  // 1. First start after the update.
  let store;
  await step(async () => { store = await start(); });
  let probe = await start();
  check(probe.token !== LEGACY && store?.token !== LEGACY, 'T1: plaintext session adopted');
  check(!probe.isAuthenticated, 'T1: session restored from plaintext');
  check(AUTH_KEYS.every((k) => !persist.prefs.has(k)), 'T2: plaintext auth keys left after a fault-free start');
  check(persist.prefs.get('ble_app_uuid') === 'pairing-uuid', 'T6: pairing key touched');

  // 2. Login.
  store = probe;
  await step(() => store.loginWithSSO({ token: A1, user: { id: 'a' } }));
  check(store.token === A1, 'login: session not kept in memory');
  probe = await start();
  check(probe.token === A1 || probe.token === null, `login: restored ${probe.token}`);
  if (probe.token === null) {
    // Not stored (memory only): sign in again without a fault.
    await probe.loginWithSSO({ token: A1, user: { id: 'a' } });
    probe = await start();
    check(probe.token === A1, 'login after a failed save is not stored');
  }

  // 3. Refresh (T4).
  store = probe;
  const before = persist.ks.get('authToken');
  refreshAnswer.token = A2; refreshAnswer.user = { id: 'a' };
  await step(() => store._doTokenRefresh());
  const after = persist.ks.get('authToken');
  check(after === A2 || after === before, `T4: refresh left ${after === undefined ? 'nothing' : 'another value'} in the keystore`);
  probe = await start();
  check(probe.token === A2 || probe.token === before, 'T4: restart after refresh lost the session');

  // 4. Sign-out (T5): whatever fails, the next start is signed out.
  store = probe;
  if (!store.isAuthenticated) { await store.loginWithSSO({ token: A2, user: { id: 'a' } }); }
  await step(() => store.logout());
  probe = await start();
  check(!probe.isAuthenticated && probe.token === null, 'T5: session restored after sign-out');
  probe = await start();
  check(!probe.isAuthenticated, 'T5: session restored at the second start after sign-out');

  // 5. A later stored login is restored again (marker cleared).
  await probe.loginWithSSO({ token: B1, user: { id: 'b' } });
  probe = await start();
  check(probe.token === B1, 'marker: a stored login after sign-out is not restored');

  // T3: nothing is ever written to Preferences.
  check(prefsWrites.length === 0, 'T3: Preferences written');
  check(![...persist.prefs.values()].includes(A1) && ![...persist.prefs.values()].includes(A2), 'T3: token in Preferences');
  return { bad, counts: { ...fault.counts } };
}

describe('mobile session storage: one fault at every storage operation (T1-T5)', () => {
  it('holds T1-T5 without a fault and after a fault at every single operation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const clean = await life();
    expect(clean.bad).toEqual([]);
    const ops = ['ks.get', 'ks.set', 'ks.remove', 'prefs.get', 'prefs.remove', 'marker'];
    for (const op of ops) expect(clean.counts[op] || 0, `${op} is exercised`).toBeGreaterThan(0);
    const failures = [];
    for (const op of ops) {
      for (let n = 1; n <= clean.counts[op]; n++) {
        const { bad } = await life(op, n);
        if (bad.length) failures.push(`${op}#${n}: ${bad.join('; ')}`);
      }
    }
    expect(failures).toEqual([]);
  }, 300000);

  it('sign-out with a keystore remove that always fails: the next start is signed out (T5)', async () => {
    persist.ks.clear(); persist.prefs.clear(); localStorage.clear();
    fault.op = null; fault.counts = {};
    let store = await start();
    await store.loginWithSSO({ token: A1, user: { id: 'a' } });
    store = await start();
    expect(store.token).toBe(A1);
    fault.always = 'ks.remove';
    try {
      await store.logout();
      expect(persist.ks.get('authToken')).toBe(A1); // the removal really failed
      const next = await start();
      expect(next.isAuthenticated).toBe(false);
      expect(next.token).toBeNull();
    } finally {
      fault.always = null;
    }
    // Once the keystore works again the copy is removed at the next start.
    await start();
    expect(persist.ks.has('authToken')).toBe(false);
  }, 60000);
});
