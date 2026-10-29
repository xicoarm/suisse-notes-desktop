import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { boot, createDisk, jwt, encrypted } from './support/desktopSession';

// The session record file (src-electron/session-authority.js fileRecordStore)
// on a fake fs, review round 7 (r6 low finding): a crash right before or
// right after each single fs operation of a write (open, write, fsync,
// close, rename) - or a failing operation - leaves the old or the new record
// on disk, never a partial or an empty one; a failing write never counts as
// written. The migration of the previous version's session is crashed the
// same way (E9). The crash cases failed at a3c841fa only through the
// migration (no fs operation was enumerated before).

const require = createRequire(import.meta.url);
const { fileRecordStore, createSessionAuthority, configUserStore, configMarkStore } = require('../../src-electron/session-authority.js');
const { createTokenVault } = require('../../src-electron/token-vault.js');
const ssoFlow = require('../../src-electron/sso-flow.js');
const { fakeSafeStorage } = require('./support/desktopSession');

class Crash extends Error {}

const FILE = '/user/session-authority.json';
const OPS = ['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync'];

/**
 * Fake fs with durable and volatile state. `plan`: { op, n, when: 'vor'|'nach'|'fault' }.
 * After a crash, `afterCrash(renameDurable)` is the disk a restart finds:
 * unsynced file data is lost; a rename without a directory sync may or may
 * not have reached the disk (both are checked).
 */
function fakeFs(initial = {}, plan = null) {
  const durable = { ...initial }; // path -> text that survives a crash
  const files = { ...initial }; // path -> text as the process sees it
  const fds = new Map();
  const counts = {};
  const ops = [];
  let dead = false;
  let pendingRename = null;
  let crashDisk = null;

  function op(name, effect) {
    if (dead) throw new Crash('dead');
    counts[name] = (counts[name] || 0) + 1;
    ops.push({ op: name, n: counts[name] });
    const hit = plan && plan.op === name && plan.n === counts[name];
    if (hit && plan.when === 'fault') throw Object.assign(new Error(`EIO ${name}`), { code: 'EIO' });
    if (hit && plan.when === 'vor') crash();
    const result = effect();
    if (hit && plan.when === 'nach') crash();
    return result;
  }
  function crash() {
    dead = true;
    crashDisk = { durable: { ...durable }, pendingRename };
    throw new Crash('crash');
  }

  const fs = {
    readFileSync(path) {
      if (dead) throw new Crash('dead');
      if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[path];
    },
    openSync: (path) => op('openSync', () => {
      files[path] = '';
      const fd = fds.size + 3;
      fds.set(fd, { path, synced: false });
      return fd;
    }),
    writeSync: (fd, text) => op('writeSync', () => {
      const f = fds.get(fd);
      files[f.path] += text;
      f.synced = false;
    }),
    fsyncSync: (fd) => op('fsyncSync', () => {
      const f = fds.get(fd);
      durable[f.path] = files[f.path];
      f.synced = true;
    }),
    closeSync: (fd) => op('closeSync', () => { fds.delete(fd); }),
    renameSync: (from, to) => op('renameSync', () => {
      files[to] = files[from];
      delete files[from];
      // Durable data of `from` moves with it; whether the directory entry
      // survives a crash before a directory sync is open.
      pendingRename = { from, to, text: durable[from] };
    })
  };

  return {
    fs,
    ops,
    get dead() { return dead; },
    files,
    afterCrash(renameDurable) {
      const disk = { ...crashDisk.durable };
      const r = crashDisk.pendingRename;
      if (r && renameDurable && r.text !== undefined) {
        disk[r.to] = r.text;
        delete disk[r.from];
      }
      return disk;
    }
  };
}

const OLD_TEXT = JSON.stringify({ epoch: 3, signedOut: true });
const NEW_TEXT = JSON.stringify({ epoch: 4, signedOut: false });

function enumerateWrite() {
  const f = fakeFs({ [FILE]: OLD_TEXT });
  fileRecordStore(FILE, f.fs).write(NEW_TEXT);
  return f.ops;
}

describe('fileRecordStore on a fake fs: open / write / fsync / close / rename one by one', () => {
  it('the write uses every operation once, in this order', () => {
    expect(enumerateWrite().map((o) => o.op)).toEqual(OPS);
  });

  it('a crash before or after each operation leaves the old or the new record, never a partial one', () => {
    let checked = 0;
    const seen = new Set();
    for (const { op, n } of enumerateWrite()) {
      for (const when of ['vor', 'nach']) {
        const f = fakeFs({ [FILE]: OLD_TEXT }, { op, n, when });
        expect(() => fileRecordStore(FILE, f.fs).write(NEW_TEXT)).toThrow(Crash);
        for (const renameDurable of [false, true]) {
          const disk = f.afterCrash(renameDurable);
          const text = fileRecordStore(FILE, fakeFs(disk).fs).read();
          expect([OLD_TEXT, NEW_TEXT], `${when} ${op}#${n} rename=${renameDurable}`).toContain(text);
          seen.add(text);
          checked++;
        }
      }
    }
    expect(checked).toBe(OPS.length * 4);
    // The crash points reach both outcomes.
    expect([...seen].sort()).toEqual([NEW_TEXT, OLD_TEXT].sort());
  });

  it('a failing operation throws (never counted as written) and leaves the old record readable', () => {
    for (const { op, n } of enumerateWrite()) {
      const f = fakeFs({ [FILE]: OLD_TEXT }, { op, n, when: 'fault' });
      expect(() => fileRecordStore(FILE, f.fs).write(NEW_TEXT), op).toThrow(/EIO/);
      if (op !== 'closeSync') expect(fileRecordStore(FILE, f.fs).read(), op).toBe(OLD_TEXT);
    }
  });

  it('a failing close after the data is synced throws too (the rename never runs)', () => {
    const f = fakeFs({ [FILE]: OLD_TEXT }, { op: 'closeSync', n: 1, when: 'fault' });
    expect(() => fileRecordStore(FILE, f.fs).write(NEW_TEXT)).toThrow(/EIO/);
    expect(f.ops.map((o) => o.op)).not.toContain('renameSync');
    expect(fileRecordStore(FILE, f.fs).read()).toBe(OLD_TEXT);
  });

  it('only a missing file reads as missing; every other read error throws (unreadable)', () => {
    expect(fileRecordStore(FILE, fakeFs({}).fs).read()).toBeNull();
    const broken = { readFileSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
    expect(() => fileRecordStore(FILE, broken).read()).toThrow(/EACCES/);
  });
});

describe('E9: the migration of the previous version\'s session, crashed at each fs operation', () => {
  const OLD = jwt('old', 'legacy');

  /** One desktop start on the fake fs and a config object. */
  function start(fsDisk, config, plan) {
    const f = fakeFs(fsDisk, plan);
    const store = {
      get: (k, d) => (k in config ? JSON.parse(JSON.stringify(config[k])) : d),
      // A dead instance changes nothing any more.
      set: (k, v) => { if (f.dead) throw new Crash('dead'); config[k] = JSON.parse(JSON.stringify(v)); },
      delete: (k) => { if (f.dead) throw new Crash('dead'); delete config[k]; }
    };
    let authority;
    const vault = createTokenVault({ safeStorage: fakeSafeStorage(), store, platform: 'darwin', isAllowed: () => !!authority && authority.tokenAllowed() });
    authority = createSessionAuthority({
      recordStore: fileRecordStore(FILE, f.fs),
      vault,
      userStore: configUserStore(store),
      migrationMark: configMarkStore(store),
      flows: ssoFlow.createSsoFlowStore({ storage: store }),
      now: () => 5000
    });
    try { authority.startup(); } catch (e) { if (!(e instanceof Crash)) throw e; }
    return { f, authority };
  }

  it('every crash point ends in the previous session (migrated or migrated again), never deleted, never another', () => {
    const legacyConfig = () => ({ authToken: encrypted(OLD), userInfo: { id: 'old' } });
    const probe = start({}, legacyConfig());
    expect(probe.authority.restore()).toMatchObject({ signedOut: false, token: OLD });
    const ops = probe.f.ops;
    expect(ops.map((o) => o.op)).toEqual(OPS);
    let checked = 0;
    for (const { op, n } of ops) {
      for (const when of ['vor', 'nach']) {
        const config = legacyConfig();
        const run = start({}, config, { op, n, when });
        expect(run.f.dead, `${when} ${op}`).toBe(true);
        for (const renameDurable of [false, true]) {
          const cfg = JSON.parse(JSON.stringify(config));
          const restart = start(run.f.afterCrash(renameDurable), cfg);
          const where = `${when} ${op}#${n} rename=${renameDurable}`;
          expect(restart.authority.restore(), where).toMatchObject({ signedOut: false, token: OLD, user: { id: 'old' } });
          expect(cfg.authToken, where).toBe(encrypted(OLD));
          checked++;
        }
      }
    }
    expect(checked).toBe(OPS.length * 4);
  });

  it('a failing fs operation during the migration: RAM lock, nothing deleted, the next start migrates', () => {
    for (const { op, n } of enumerateWrite()) {
      const config = { authToken: encrypted(OLD), userInfo: { id: 'old' } };
      const run = start({}, config, { op, n, when: 'fault' });
      expect(run.authority.getToken(), op).toBeNull();
      expect(run.authority.restore(), op).toMatchObject({ signedOut: true });
      expect(config.authToken, op).toBe(encrypted(OLD));
      expect(config.userInfo, op).toEqual({ id: 'old' });
      expect(config.sessionAuthorityMigrated, op).toBeUndefined();
      const next = start({ ...run.f.files }, config);
      expect(next.authority.restore(), op).toMatchObject({ signedOut: false, token: OLD });
    }
  });
});

// Sanity: the rig's legacy disk starts signed in through the migration.
describe('rig', () => {
  it('boot() migrates a legacy disk', () => {
    const disk = createDisk();
    disk.config.authToken = encrypted(jwt('old'));
    disk.config.userInfo = { id: 'old' };
    expect(boot(disk).authority.restore()).toMatchObject({ signedOut: false });
  });
});
