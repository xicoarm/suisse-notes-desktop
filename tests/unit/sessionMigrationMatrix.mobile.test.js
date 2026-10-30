import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Review round 8: the migration error matrix (mobile), the same rule as on
// desktop. Only a confirmed missing pair is a decision (tombstone + mark +
// delete); every read or write error is «held»: RAM lock, nothing deleted,
// nothing marked, retried at the next start. The migrated session is released
// only once the record {0,false} AND the mark are confirmed, also when the
// record already exists. Each case: two restarts with the fault, then one
// without (the keystore session is kept, then migrated). The held cases
// failed at 82ab3187.

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isMobile: () => true, isIOS: () => false, isAndroid: () => true,
  getPlatform: () => 'android', PlatformConstants: {}
}));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn(), setUser: vi.fn() }));

// Keystore with per-key faults: failGet (get throws), failSet (set throws),
// dropSet (set silently lost, the read-back differs).
const disk = vi.hoisted(() => ({ ks: new Map(), prefs: new Map(), failGet: new Set(), failSet: new Set(), dropSet: new Set(), failGetAfterSet: new Set() }));
vi.mock('@capacitor/core', () => {
  const keystore = {
    get: async ({ key }) => {
      if (disk.failGet.has(key)) throw new Error('KEYSTORE_LOCKED');
      if (disk.failGetAfterSet.has(key) && disk.ks.has(key)) throw new Error('KEYSTORE_READ_BACK');
      return { value: disk.ks.has(key) ? disk.ks.get(key) : null };
    },
    set: async ({ key, value }) => {
      if (disk.failSet.has(key)) throw new Error('KEYSTORE_WRITE_FAILED');
      if (disk.dropSet.has(key)) return;
      disk.ks.set(key, value);
    },
    remove: async ({ key }) => { disk.ks.delete(key); }
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
const MARK = 'auth.sessionMigrated';
const OLD = jwt('old', 'legacy');
const OLD_USER = JSON.stringify({ id: 'old' });

let authority;
let storage;
async function restart() {
  vi.resetModules();
  authority = await import('../../src/services/sessionAuthority');
  storage = await import('../../src/services/secureStorage');
}

// localStorage faults: the record entry.
const ls = { failRead: false, failWrite: false, dropWrite: false, failReadAfterWrite: false };
const realGet = Storage.prototype.getItem;
const realSet = Storage.prototype.setItem;

beforeEach(() => {
  disk.ks.clear();
  disk.prefs.clear();
  disk.failGet.clear();
  disk.failSet.clear();
  disk.dropSet.clear();
  disk.failGetAfterSet.clear();
  Object.assign(ls, { failRead: false, failWrite: false, dropWrite: false, failReadAfterWrite: false });
  localStorage.clear();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (k) {
    if (k === RECORD && ls.failRead) throw new Error('SecurityError');
    if (k === RECORD && ls.failReadAfterWrite && realGet.call(this, k) !== null) throw new Error('SecurityError');
    return realGet.call(this, k);
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) {
    if (k === RECORD && ls.failWrite) throw new Error('QuotaExceeded');
    if (k === RECORD && ls.dropWrite) return;
    return realSet.call(this, k, v);
  });
});

afterEach(() => vi.restoreAllMocks());

function legacy() {
  disk.ks.set('authToken', OLD);
  disk.ks.set('userInfo', OLD_USER);
}
function migratedWithoutMark() {
  legacy();
  realSet.call(localStorage, RECORD, JSON.stringify({ epoch: 0, signedOut: false }));
}

const FAULTS = {
  'record read throws': { arrange: legacy, inject: () => { ls.failRead = true; }, clear: () => { ls.failRead = false; } },
  'mark read throws (record missing)': { arrange: legacy, inject: () => disk.failGet.add(MARK), clear: () => disk.failGet.delete(MARK) },
  'token read throws': { arrange: legacy, inject: () => disk.failGet.add('authToken'), clear: () => disk.failGet.delete('authToken') },
  'user read throws': { arrange: legacy, inject: () => disk.failGet.add('userInfo'), clear: () => disk.failGet.delete('userInfo') },
  'record write throws': { arrange: legacy, inject: () => { ls.failWrite = true; }, clear: () => { ls.failWrite = false; } },
  'record write lost (read-back differs)': { arrange: legacy, inject: () => { ls.dropWrite = true; }, clear: () => { ls.dropWrite = false; } },
  'record read-back throws': { arrange: legacy, inject: () => { ls.failReadAfterWrite = true; }, clear: () => { ls.failReadAfterWrite = false; } },
  'mark write throws (reviewer repro r7 MEDIUM)': { arrange: legacy, inject: () => disk.failSet.add(MARK), clear: () => disk.failSet.delete(MARK) },
  'mark write lost (read-back differs)': { arrange: legacy, inject: () => disk.dropSet.add(MARK), clear: () => disk.dropSet.delete(MARK) },
  'record {0,false} present, mark read throws': { arrange: migratedWithoutMark, inject: () => disk.failGet.add(MARK), clear: () => disk.failGet.delete(MARK) },
  'record {0,false} present, mark write throws': { arrange: migratedWithoutMark, inject: () => disk.failSet.add(MARK), clear: () => disk.failSet.delete(MARK) },
  'record {0,false} present, mark write lost': { arrange: migratedWithoutMark, inject: () => disk.dropSet.add(MARK), clear: () => disk.dropSet.delete(MARK) }
};

async function expectHeld(label) {
  expect(await authority.loadSession(), label).toMatchObject({ signedOut: true });
  expect(authority.isSignedOut(), label).toBe(true);
  expect(authority.sessionState(), label).toMatchObject({ signedOut: true, migrationPending: true });
  expect(await storage.getToken(), label).toBeNull();
  expect(disk.ks.get('authToken'), label).toBe(OLD);
  expect(disk.ks.get('userInfo'), label).toBe(OLD_USER);
  expect(disk.ks.get(MARK), label).toBeUndefined();
  const rec = realGet.call(localStorage, RECORD);
  expect(rec === null || JSON.parse(rec).signedOut === false, label).toBe(true);
}

describe('migration error matrix (mobile): every read or write error is held', () => {
  for (const [name, fault] of Object.entries(FAULTS)) {
    it(`${name}: held at two starts, migrated at the first start without the fault`, async () => {
      fault.arrange();
      fault.inject();
      await restart();
      await expectHeld(`${name} / start 1`);
      await restart();
      await expectHeld(`${name} / start 2`);
      fault.clear();
      await restart();
      expect(await authority.loadSession(), name).toEqual({ signedOut: false, token: OLD, user: { id: 'old' }, epoch: 0 });
      expect(JSON.parse(realGet.call(localStorage, RECORD)), name).toEqual({ epoch: 0, signedOut: false });
      expect(disk.ks.get(MARK), name).toBe('1');
      expect(await storage.getToken(), name).toBe(OLD);
    });
  }
});

describe('migration error matrix (mobile): only a confirmed missing pair is a decision', () => {
  it('confirmed missing token: tombstone, mark, deleted', async () => {
    disk.ks.set('userInfo', OLD_USER);
    await restart();
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    expect(JSON.parse(realGet.call(localStorage, RECORD))).toEqual({ epoch: 0, signedOut: true });
    expect(disk.ks.get(MARK)).toBe('1');
    expect(disk.ks.has('userInfo')).toBe(false);
  });

  it('tombstone or mark not writable: held, nothing deleted or marked', async () => {
    for (const fault of ['tombstone', 'mark']) {
      disk.ks.clear();
      localStorage.clear();
      disk.ks.set('userInfo', OLD_USER);
      if (fault === 'tombstone') ls.failWrite = true;
      else disk.failSet.add(MARK);
      await restart();
      expect(await authority.loadSession(), fault).toEqual({ signedOut: true });
      expect(authority.sessionState(), fault).toMatchObject({ signedOut: true, migrationPending: true });
      expect(disk.ks.get('userInfo'), fault).toBe(OLD_USER);
      expect(disk.ks.get(MARK), fault).toBeUndefined();
      ls.failWrite = false;
      disk.failSet.clear();
    }
  });

  it('a stored session that cannot be read at a normal start is held, not released and not deleted', async () => {
    legacy();
    await restart();
    await authority.loadSession();
    disk.failGet.add('authToken');
    await restart();
    expect(await authority.loadSession()).toMatchObject({ signedOut: true });
    expect(authority.isSignedOut()).toBe(true);
    disk.failGet.clear();
    expect(await storage.getToken()).toBeNull();
    expect(disk.ks.get('authToken')).toBe(OLD);
    await restart();
    expect(await authority.loadSession()).toMatchObject({ signedOut: false, token: OLD });
  });
});

// r8-E8 rest (review round 9): the mark is written, its read-back throws -
// a fault of its own, not the initial read error.
describe('migration error matrix (mobile): mark read-back throws', () => {
  it('held at two starts, nothing deleted; migrated at the first start without the fault', async () => {
    legacy();
    disk.failGetAfterSet.add(MARK);
    for (let start = 1; start <= 2; start++) {
      await restart();
      expect(await authority.loadSession(), `start ${start}`).toEqual({ signedOut: true });
      expect(authority.isSignedOut(), `start ${start}`).toBe(true);
      expect(disk.ks.get('authToken'), `start ${start}`).toBe(OLD);
      expect(disk.ks.get('userInfo'), `start ${start}`).toBe(OLD_USER);
    }
    disk.failGetAfterSet.delete(MARK);
    await restart();
    expect(await authority.loadSession()).toMatchObject({ signedOut: false, token: OLD, user: { id: 'old' } });
    expect(disk.ks.get(MARK)).toBe('1');
  });
});
