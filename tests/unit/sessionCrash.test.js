import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { createCrashPersistence, Crash, Fault } from './support/crashPersistence';

// R5 / E9 (security review 10/2026 round 6): a crash right before or right
// after EVERY storage operation of a whole life of the app - first start
// after the update, password sign-in, refresh, sign-out, SSO, sign-out while
// an upload runs - ends, after a restart with new modules and instances on
// the snapshot, in the last confirmed state or signed out: never an old or a
// foreign session, never a consumed SSO state valid again; checked are E5,
// E6, E8, E9 and T1-T5. Failed at 2349920b (no session authority).

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isMobile: () => true, isIOS: () => false, isAndroid: () => true,
  getPlatform: () => 'android', PlatformConstants: {}
}));

const require = createRequire(import.meta.url);
// Hundreds of restarts with fresh modules: slow on a loaded CI runner.
const HEAVY = 120_000;
const { createSessionAuthority, configUserStore } = require('../../src-electron/session-authority.js');
const { createTokenVault } = require('../../src-electron/token-vault.js');
const ssoFlow = require('../../src-electron/sso-flow.js');
const { createPendingUploadProcessor } = require('../../src-electron/pending-uploads.js');
const { tokenUserId, canUploadForUser } = require('../../src-electron/upload-safety.js');

const jwt = (userId, tag) => `h.${Buffer.from(JSON.stringify({ userId, tag })).toString('base64url')}.s`;
const userB64 = (user) => Buffer.from(JSON.stringify(user)).toString('base64url');
const sessionOf = (s) => (s ? `${s.user?.id}:${s.token}` : null);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Run a life, collect the operations, and return what happened. */
async function enumerate(life) {
  const run = await life(null);
  return run.p.ops.map(({ op, n }) => ({ op, n }));
}

function parseRecordText(text) {
  try {
    const r = JSON.parse(text);
    return Number.isSafeInteger(r.epoch) && typeof r.signedOut === 'boolean' ? r : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- desktop --

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s) => Buffer.from(`enc:${s.split('').reverse().join('')}`),
    decryptString: (buf) => {
      const s = buf.toString();
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
      return s.slice(4).split('').reverse().join('');
    }
  };
}
const encrypted = (token) => fakeSafeStorage().encryptString(token).toString('base64');

/** One desktop app start on persistence `p`. */
function bootDesktop(p, { upload } = {}) {
  const config = p.kv('config');
  const queue = p.kv('queue');
  if (!p.state.record) p.state.record = {};
  const recordStore = {
    read: () => p.read(() => (p.state.record.text === undefined ? null : p.state.record.text)),
    write: (text) => p.op('record.write', () => { p.state.record.text = text; })
  };
  let authority;
  const vault = createTokenVault({ safeStorage: fakeSafeStorage(), store: config, platform: 'darwin', isAllowed: () => !!authority && authority.tokenAllowed() });
  const flows = ssoFlow.createSsoFlowStore({ storage: config, now: () => 5000 });
  authority = createSessionAuthority({ recordStore, vault, userStore: configUserStore(config), flows, now: () => 5000 });
  authority.startup();
  const handleCallback = ssoFlow.createSsoCallbackHandler({ authority, flows, exchange: async () => ({ error: 'invalid_callback' }), deliver: (x) => authority.setPending(x) });
  const requests = [];
  const processPendingUploads = createPendingUploadProcessor({
    authority,
    getQueue: () => queue.get('items', []),
    removeFromQueue: (id) => queue.set('items', queue.get('items', []).filter((i) => i.recordId !== id)),
    bumpRetry: (id) => queue.set('items', queue.get('items', []).map((i) => (i.recordId === id ? { ...i, retryCount: i.retryCount + 1 } : i))),
    inFlight: new Set(),
    upload: async (recordId, filePath, metadata, maxRetries, ticket) => {
      const token = authority.isCurrent(ticket) ? authority.getToken() : null;
      if (!token) return { success: false, status: 401, canRetry: false };
      requests.push({ recordId, token });
      return upload ? upload() : { success: false, canRetry: true, error: 'offline' };
    },
    mayUpload: (item, userId) => canUploadForUser(item.userId, userId),
    readReceipt: () => null,
    access: async () => {},
    updateHistory: () => p.op('history.set', () => {}),
    saveOutcome: () => {},
    notify: () => {},
    tokenUserId,
    wait: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  return { authority, vault, flows, handleCallback, processPendingUploads, requests, config };
}

const OLD = jwt('old', 'legacy');
const A1 = jwt('a', 'login');
const A2 = jwt('a', 'refresh');
const B1 = jwt('b', 'sso');
const DESKTOP_START = {
  // The previous version: an encrypted token and its user, no record; the
  // upload queue holds a recording of b.
  config: { authToken: encrypted(OLD), userInfo: { id: 'old' } },
  queue: { items: [{ recordId: 'rec-b', filePath: '/rec-b', userId: 'b', retryCount: 0 }] }
};

/** What a restart on the snapshot finds; also replays the SSO callback. */
async function desktopRestart(snapshot, ssoState) {
  const p = createCrashPersistence(snapshot);
  const app = bootDesktop(p);
  const restored = app.authority.restore();
  const session = restored.signedOut ? null : { token: restored.token, user: restored.user };
  await app.processPendingUploads();
  const after = { config: JSON.parse(JSON.stringify(p.state.config || {})) };
  let replayApplied = false;
  if (ssoState && !session) {
    const res = await app.handleCallback(`suissenotes://auth/callback?state=${ssoState}&token=${B1}&user=${userB64({ id: 'b' })}`);
    replayApplied = !!res.delivered?.applied;
  }
  return { session, requests: app.requests, after, replayApplied, queue: p.state.queue?.items || [] };
}

// The upload run needs the processor with a waiting upload: build it once per app.
function bootDesktopWithRun(p) {
  const holder = {};
  const app = bootDesktop(p, { upload: () => holder.running.promise });
  app.processPendingUploadsWith = (running) => { holder.running = running; return app.processPendingUploads(); };
  return app;
}

// The desktop life with the upload that is aborted by the second sign-out.
async function desktopLifeWithRun(plan) {
  const p = createCrashPersistence(DESKTOP_START);
  if (plan?.when === 'fault') p.faultAt(plan.op, plan.n);
  else if (plan) p.crashAt(plan.op, plan.n, plan.when);
  const life = { p, phase: 'update', ssoState: null, boundaries: [] };
  const step = async (phase, fn) => {
    if (p.dead) return;
    life.phase = phase;
    try { await fn(); } catch (e) { if (!(e instanceof Crash) && !(e instanceof Fault) && !p.dead) throw e; }
    if (!p.dead) life.boundaries.push({ phase, state: JSON.parse(JSON.stringify(p.state)), ssoState: life.ssoState });
  };
  let app;
  await step('update', () => { app = bootDesktopWithRun(p); });
  await step('login', () => { app.authority.applySession(app.authority.ticket(), { token: A1, user: { id: 'a' } }, { kind: 'login' }); });
  await step('refresh', () => { app.authority.applySession(app.authority.ticket({ userId: 'a' }), { token: A2, user: { id: 'a' } }, { kind: 'refresh' }); });
  await step('logout', () => { app.authority.signOut(); });
  await step('sso', async () => {
    const flow = app.flows.begin('microsoft', app.authority.state().epoch);
    life.ssoState = flow.state;
    await app.handleCallback(`suissenotes://auth/callback?state=${flow.state}&token=${B1}&user=${userB64({ id: 'b' })}`);
  });
  await step('upload-logout', async () => {
    const running = deferred();
    const uploading = app.processPendingUploadsWith(running);
    uploading.catch(() => {}); // a crash inside the run is awaited below
    try {
      await new Promise((r) => setTimeout(r, 0));
      app.authority.signOut();
    } finally {
      // The abort of the sign-out ends the request as cancelled.
      running.resolve({ success: false, cancelled: true, canRetry: false });
    }
    await uploading;
  });
  return life;
}


const DESKTOP_ALLOWED = {
  update: [null],
  login: [null, `a:${A1}`],
  refresh: [null, `a:${A1}`, `a:${A2}`],
  logout: [null, `a:${A2}`],
  sso: [null, `b:${B1}`],
  'upload-logout': [null, `b:${B1}`]
};

function checkDesktop({ plan, phase, snapshot, restart, ssoState }) {
  const where = `${plan.when} ${plan.op}#${plan.n} (${phase})`;
  const restored = sessionOf(restart.session);
  // E9: last confirmed state or signed out - never old or foreign.
  expect(DESKTOP_ALLOWED[phase], where).toContain(restored);
  // E6: tombstone, missing or unreadable record -> nothing restored.
  const record = parseRecordText(snapshot.record?.text);
  if (!record || record.signedOut) expect(restored, where).toBeNull();
  // Token and user always of the same account.
  if (restart.session) expect(tokenUserId(restart.session.token), where).toBe(restart.session.user.id);
  // T1/T3: never a plaintext token on disk; the legacy token is never used.
  for (const cfg of [snapshot.config, restart.after.config]) {
    if (cfg?.authToken) expect(String(cfg.authToken), where).not.toContain('.');
  }
  expect(String(restored), where).not.toContain(OLD);
  // E5: a signed-out start deletes token and user again.
  if (!restart.session) {
    expect(restart.after.config.authToken, where).toBeUndefined();
    expect(restart.after.config.userInfo, where).toBeUndefined();
  }
  // E6/E7: requests only for the restored session; the recording stays queued.
  for (const r of restart.requests) expect(r.token, where).toBe(restart.session?.token);
  if (!restart.session) expect(restart.requests, where).toEqual([]);
  expect(restart.queue.map((i) => i.recordId), where).toContain('rec-b');
  // E9: a consumed SSO state never becomes valid again.
  if (restart.replayApplied) expect(snapshot.config?.ssoPendingFlow?.state, where).toBe(ssoState);
}

// ----------------------------------------------------------------- mobile --

const mobileDisk = vi.hoisted(() => ({ p: null }));
vi.mock('@capacitor/core', () => {
  const keystore = {
    get: async ({ key }) => { const v = mobileDisk.p.kv('ks').get(key); return { value: v === undefined ? null : v }; },
    set: async ({ key, value }) => { mobileDisk.p.kv('ks').set(key, value); },
    remove: async ({ key }) => { mobileDisk.p.kv('ks').delete(key); }
  };
  return { registerPlugin: () => new Proxy({}, { get: (_, k) => (typeof keystore[k] === 'function' ? keystore[k] : undefined) }) };
});
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }) => { const v = mobileDisk.p.kv('prefs').get(key); return { value: v === undefined ? null : v }; },
    set: async ({ key, value }) => { mobileDisk.p.kv('prefs').set(key, value); },
    remove: async ({ key }) => { mobileDisk.p.kv('prefs').delete(key); }
  }
}));

const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

async function mobileModules(p) {
  mobileDisk.p = p;
  vi.resetModules();
  return {
    authority: await import('../../src/services/sessionAuthority'),
    flow: await import('../../src/services/ssoFlow'),
    storage: await import('../../src/services/secureStorage')
  };
}

const LEGACY = jwt('old', 'legacy');
const MOBILE_START = {
  // The previous version: the session in plaintext Preferences.
  prefs: { authToken: LEGACY, userInfo: JSON.stringify({ id: 'old' }), userId: 'old', ble_app_uuid: 'pairing' },
  ks: {},
  ls: {}
};

async function mobileLife(plan) {
  const p = createCrashPersistence(MOBILE_START);
  if (plan?.when === 'fault') p.faultAt(plan.op, plan.n);
  else if (plan) p.crashAt(plan.op, plan.n, plan.when);
  const life = { p, phase: 'update', ssoState: null, boundaries: [] };
  const step = async (phase, fn) => {
    if (p.dead) return;
    life.phase = phase;
    try { await fn(); } catch (e) { if (!(e instanceof Crash) && !(e instanceof Fault) && !p.dead) throw e; }
    if (!p.dead) life.boundaries.push({ phase, state: JSON.parse(JSON.stringify(p.state)), ssoState: life.ssoState });
  };
  let m;
  await step('update', async () => { m = await mobileModules(p); await m.authority.loadSession(); });
  await step('login', () => m.authority.applySession(m.authority.sessionTicket(), { token: A1, user: { id: 'a' } }, { kind: 'login' }));
  await step('refresh', () => m.authority.applySession(m.authority.sessionTicket({ userId: 'a' }), { token: A2, user: { id: 'a' } }, { kind: 'refresh' }));
  await step('logout', () => m.authority.signOut());
  await step('sso', async () => {
    const flow = await m.flow.beginSsoFlow('google');
    life.ssoState = flow.state;
    const binding = m.flow.consumeSsoFlow({ state: flow.state, token: B1, user: { id: 'b' } });
    if (binding.ok) await m.authority.applySession({ epoch: binding.epoch }, { token: B1, user: { id: 'b' } }, { kind: 'sso' });
  });
  await step('logout2', () => m.authority.signOut());
  return life;
}

async function mobileRestart(snapshot, ssoState) {
  const p = createCrashPersistence(snapshot);
  const m = await mobileModules(p);
  const loaded = await m.authority.loadSession();
  const session = loaded.signedOut ? null : { token: loaded.token, user: loaded.user };
  const token = await m.storage.getToken();
  const after = JSON.parse(JSON.stringify(p.state));
  let replayApplied = false;
  if (ssoState && !session) {
    const binding = m.flow.consumeSsoFlow({ state: ssoState, token: B1, user: { id: 'b' } });
    if (binding.ok) {
      replayApplied = (await m.authority.applySession({ epoch: binding.epoch }, { token: B1, user: { id: 'b' } }, { kind: 'sso' })).applied;
    }
  }
  return { session, token, after, replayApplied, ops: p.ops };
}

const MOBILE_ALLOWED = {
  update: [null],
  login: [null, `a:${A1}`],
  refresh: [null, `a:${A1}`, `a:${A2}`],
  logout: [null, `a:${A2}`],
  sso: [null, `b:${B1}`],
  logout2: [null, `b:${B1}`]
};

function checkMobile({ plan, phase, snapshot, restart, ssoState, lifeOps }) {
  const where = `${plan.when} ${plan.op}#${plan.n} (${phase})`;
  const restored = sessionOf(restart.session);
  expect(MOBILE_ALLOWED[phase], where).toContain(restored);
  const record = parseRecordText(snapshot.ls?.['auth.session.v1']);
  if (!record || record.signedOut || snapshot.ls?.['auth.signedOut'] === '1') expect(restored, where).toBeNull();
  // E6: getToken follows the authority.
  expect(restart.token, where).toBe(restart.session ? restart.session.token : null);
  if (restart.session) expect(tokenUserId(restart.session.token), where).toBe(restart.session.user.id);
  // T1: the plaintext session is never adopted; T2: a fault-free start purges
  // it; T3: nothing is ever written to Preferences.
  expect(String(restored), where).not.toContain(LEGACY);
  for (const k of ['authToken', 'refreshToken', 'userId', 'userEmail', 'userInfo']) expect(restart.after.prefs?.[k], where).toBeUndefined();
  expect(restart.after.prefs?.ble_app_uuid, where).toBe('pairing');
  expect([...lifeOps, ...restart.ops].some((o) => o.op === 'prefs.set'), where).toBe(false);
  // E5: a signed-out start deletes the keystore session again.
  if (!restart.session) {
    expect(restart.after.ks?.authToken, where).toBeUndefined();
    expect(restart.after.ks?.userInfo, where).toBeUndefined();
  }
  if (restart.replayApplied) expect(JSON.parse(snapshot.ls?.['sso.pendingFlow.v1'] || 'null')?.state, where).toBe(ssoState);
}

// ------------------------------------------------------------------ tests --

describe('R5: crash at every storage operation - desktop (main)', () => {
  it('ends in the last confirmed state or signed out after a restart (E5, E6, E8, E9, T1-T5)', async () => {
    const ops = await enumerate(desktopLifeWithRun);
    // The life really writes everything there is to write.
    for (const name of ['record.write', 'config.set', 'config.delete', 'queue.set']) {
      expect(ops.map((o) => o.op), name).toContain(name);
    }
    expect(ops.length).toBeGreaterThan(20);
    let checked = 0;
    const seen = new Set();
    for (const { op, n } of ops) {
      for (const when of ['vor', 'nach']) {
        const plan = { op, n, when };
        const life = await desktopLifeWithRun(plan);
        expect(life.p.dead, `${when} ${op}#${n}`).toBe(true);
        const snapshot = life.p.snapshot();
        const restart = await desktopRestart(snapshot, life.ssoState);
        seen.add(sessionOf(restart.session));
        if (restart.replayApplied) seen.add('replay');
        checkDesktop({ plan, phase: life.phase, snapshot, restart, ssoState: life.ssoState });
        checked++;
      }
    }
    expect(checked).toBe(ops.length * 2);
    // The crash points really reach every confirmed state and the SSO replay.
    expect([...seen].sort()).toEqual([null, `a:${A1}`, `a:${A2}`, `b:${B1}`, 'replay'].sort());
  }, HEAVY);
});

describe('R5: crash at every storage operation - mobile', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => mobileDisk.p.webStorage('ls') });
  });
  afterAll(() => {
    Object.defineProperty(globalThis, 'localStorage', realLocalStorage);
  });

  it('ends in the last confirmed state or signed out after a restart (E5, E6, E8, E9, T1-T5)', async () => {
    const ops = await enumerate(mobileLife);
    for (const name of ['ls.set', 'ls.delete', 'ks.set', 'ks.delete', 'prefs.delete']) {
      expect(ops.map((o) => o.op), name).toContain(name);
    }
    expect(ops.length).toBeGreaterThan(20);
    let checked = 0;
    const seen = new Set();
    for (const { op, n } of ops) {
      for (const when of ['vor', 'nach']) {
        const plan = { op, n, when };
        const life = await mobileLife(plan);
        expect(life.p.dead, `${when} ${op}#${n}`).toBe(true);
        const snapshot = life.p.snapshot();
        const restart = await mobileRestart(snapshot, life.ssoState);
        seen.add(sessionOf(restart.session));
        if (restart.replayApplied) seen.add('replay');
        checkMobile({ plan, phase: life.phase, snapshot, restart, ssoState: life.ssoState, lifeOps: life.p.ops });
        checked++;
      }
    }
    expect(checked).toBe(ops.length * 2);
    // The crash points really reach every confirmed state and the SSO replay.
    expect([...seen].sort()).toEqual([null, `a:${A1}`, `a:${A2}`, `b:${B1}`, 'replay'].sort());
  }, HEAVY);
});

describe('R5 control: the snapshot is taken at the crash point', () => {
  it('a write after the crash point is missing in the snapshot; the dead instance changes nothing', async () => {
    const before = await desktopLifeWithRun({ op: 'record.write', n: 1, when: 'vor' });
    expect(before.phase).toBe('login');
    expect(before.p.snapshot().record.text).toBeUndefined();
    expect(before.p.snapshot().config.authToken).toBeUndefined(); // the update start had deleted the old one

    const after = await desktopLifeWithRun({ op: 'record.write', n: 1, when: 'nach' });
    const snap = after.p.snapshot();
    expect(JSON.parse(snap.record.text)).toMatchObject({ signedOut: true });
    // The next operation of the sign-in (the token) never happened.
    expect(snap.config.authToken).toBeUndefined();
    // The dead instance: every further operation is refused, nothing changes.
    expect(() => after.p.op('config.set', () => { throw new Error('must not run'); })).toThrow(Crash);
    expect(() => after.p.kv('config').get('authToken')).toThrow(Crash);
    expect(after.p.state.record.text).toBe(snap.record.text);
    expect(after.p.state.config).toEqual(snap.config);
  });
});

describe('R5 / E8: a single failing storage operation anywhere (the app lives on)', () => {
  // T4: a failed save keeps the previous value or ends signed out; after
  // every step a restart finds the last confirmed state or nothing.
  it('desktop: every step boundary restarts into an allowed state', async () => {
    const ops = await enumerate(desktopLifeWithRun);
    for (const { op, n } of ops) {
      const plan = { op, n, when: 'fault' };
      const life = await desktopLifeWithRun(plan);
      expect(life.boundaries.length, `fault ${op}#${n}`).toBe(6);
      for (const b of life.boundaries) {
        const restart = await desktopRestart(b.state, b.ssoState);
        checkDesktop({ plan, phase: b.phase, snapshot: b.state, restart, ssoState: b.ssoState });
      }
      // The last step was a sign-out: nothing survives a restart.
      expect((await desktopRestart(life.boundaries.at(-1).state)).session, `fault ${op}#${n}`).toBeNull();
    }
  }, HEAVY);

  describe('mobile', () => {
    beforeAll(() => {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => mobileDisk.p.webStorage('ls') });
    });
    afterAll(() => {
      Object.defineProperty(globalThis, 'localStorage', realLocalStorage);
    });

    it('every step boundary restarts into an allowed state', async () => {
      const ops = await enumerate(mobileLife);
      for (const { op, n } of ops) {
        const plan = { op, n, when: 'fault' };
        const life = await mobileLife(plan);
        expect(life.boundaries.length, `fault ${op}#${n}`).toBe(6);
        for (const b of life.boundaries) {
          const restart = await mobileRestart(b.state, b.ssoState);
          checkMobile({ plan, phase: b.phase, snapshot: b.state, restart, ssoState: b.ssoState, lifeOps: life.p.ops });
        }
        expect((await mobileRestart(life.boundaries.at(-1).state)).session, `fault ${op}#${n}`).toBeNull();
      }
    }, HEAVY);
  });
});
