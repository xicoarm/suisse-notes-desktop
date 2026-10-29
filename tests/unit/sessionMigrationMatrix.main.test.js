import { describe, it, expect } from 'vitest';
import { boot, createDisk, jwt, encrypted } from './support/desktopSession';

// Review round 8: the migration error matrix (desktop). Every storage
// operation of the one-time migration - record read, mark read, token read,
// user read, record write and read-back, mark write and read-back - is told
// apart by its outcome {ok, missing, read error / throw}. Only a CONFIRMED
// missing pair leads to tombstone + mark + delete; every read or write error
// is «held»: RAM lock (getToken null, no background work), nothing deleted,
// nothing marked, retried at the next start. The migrated session is released
// only once the record {0,false} AND the mark are confirmed - also when the
// record already exists. Each case: two restarts with the fault still there,
// then a start without it (the previous session is kept, then migrated).
// The held cases failed at 82ab3187.

const MARK = 'sessionAuthorityMigrated';
const OLD = jwt('old', 'legacy');
const OLD_USER = { id: 'old', email: 'o@x.ch' };

/** The previous version on disk: encrypted token, its user, a queued upload. */
function legacyDisk() {
  const disk = createDisk();
  disk.config.authToken = encrypted(OLD);
  disk.config.userInfo = OLD_USER;
  disk.queue = [{ recordId: 'r-old', filePath: '/r-old', userId: 'old', retryCount: 0 }];
  return disk;
}

/** State of r7 after «record {0,false} confirmed, mark failed». */
function migratedWithoutMark() {
  const disk = legacyDisk();
  disk.record = JSON.stringify({ epoch: 0, signedOut: false });
  return disk;
}

const FAULTS = {
  'record read throws': { arrange: legacyDisk, inject: (d) => { d.failRecordRead = true; }, clear: (d) => { d.failRecordRead = false; } },
  'mark read throws (record missing)': { arrange: legacyDisk, inject: (d) => d.failGet.add(MARK), clear: (d) => d.failGet.delete(MARK) },
  'token read throws': { arrange: legacyDisk, inject: (d) => d.failGet.add('authToken'), clear: (d) => d.failGet.delete('authToken') },
  'token does not decrypt (keystore refuses)': { arrange: legacyDisk, inject: (d) => { d.failDecrypt = true; }, clear: (d) => { d.failDecrypt = false; } },
  'OS keystore not open': { arrange: legacyDisk, inject: (d) => { d.encryptionReady = false; }, clear: (d) => { d.encryptionReady = true; } },
  'user read throws (reviewer repro r7 HIGH)': { arrange: legacyDisk, inject: (d) => d.failGet.add('userInfo'), clear: (d) => d.failGet.delete('userInfo') },
  'record write throws': { arrange: legacyDisk, inject: (d) => { d.failRecordWrite = true; }, clear: (d) => { d.failRecordWrite = false; } },
  'record write lost (read-back differs)': { arrange: legacyDisk, inject: (d) => { d.dropRecordWrite = true; }, clear: (d) => { d.dropRecordWrite = false; } },
  'record read-back throws': { arrange: legacyDisk, inject: (d) => { d.failRecordReadAfterWrite = true; }, clear: (d) => { d.failRecordReadAfterWrite = false; } },
  'mark write throws (reviewer repro r7 MEDIUM)': { arrange: legacyDisk, inject: (d) => d.failSet.add(MARK), clear: (d) => d.failSet.delete(MARK) },
  'mark write lost (read-back differs)': { arrange: legacyDisk, inject: (d) => d.dropSet.add(MARK), clear: (d) => d.dropSet.delete(MARK) },
  'record {0,false} present, mark read throws': { arrange: migratedWithoutMark, inject: (d) => d.failGet.add(MARK), clear: (d) => d.failGet.delete(MARK) },
  'record {0,false} present, mark write throws': { arrange: migratedWithoutMark, inject: (d) => d.failSet.add(MARK), clear: (d) => d.failSet.delete(MARK) },
  'record {0,false} present, mark write lost': { arrange: migratedWithoutMark, inject: (d) => d.dropSet.add(MARK), clear: (d) => d.dropSet.delete(MARK) }
};

async function expectHeld(disk, app, label) {
  expect(app.authority.state().signedOut, label).toBe(true);
  expect(app.authority.getToken(), label).toBeNull();
  expect(app.authority.getUser(), label).toBeNull();
  expect(app.authority.restore(), label).toMatchObject({ signedOut: true });
  await app.processPendingUploads();
  expect(app.requests, label).toEqual([]);
  // The previous session is kept as it was, nothing is marked, no tombstone.
  expect(disk.config.authToken, label).toBe(encrypted(OLD));
  expect(disk.config.userInfo, label).toEqual(OLD_USER);
  expect(disk.config[MARK], label).not.toBe(true);
  expect(disk.record === null || JSON.parse(disk.record).signedOut === false, label).toBe(true);
  expect(disk.queue.map((i) => i.recordId), label).toEqual(['r-old']);
}

describe('migration error matrix (desktop): every read or write error is held', () => {
  for (const [name, fault] of Object.entries(FAULTS)) {
    it(`${name}: held at two starts, migrated at the first start without the fault`, async () => {
      const disk = fault.arrange();
      fault.inject(disk);
      const first = boot(disk);
      // Main calls startup() again at app ready (same fault).
      first.authority.startup();
      await expectHeld(disk, first, `${name} / start 1`);
      await expectHeld(disk, boot(disk), `${name} / start 2`);

      fault.clear(disk);
      const fine = boot(disk);
      expect(fine.authority.state(), name).toMatchObject({ epoch: 0, signedOut: false });
      expect(fine.authority.restore(), name).toMatchObject({ signedOut: false, token: OLD, user: { id: 'old' } });
      expect(JSON.parse(disk.record), name).toEqual({ epoch: 0, signedOut: false });
      expect(disk.config[MARK], name).toBe(true);
      expect(disk.config.authToken, name).toBe(encrypted(OLD));
      await fine.processPendingUploads();
      expect(fine.requests, name).toEqual([{ recordId: 'r-old', token: OLD }]);
    });
  }

  it('a fault at module load that is gone at app ready: the second startup() migrates', () => {
    for (const name of ['record read throws', 'user read throws (reviewer repro r7 HIGH)', 'mark write throws (reviewer repro r7 MEDIUM)', 'record {0,false} present, mark read throws']) {
      const disk = FAULTS[name].arrange();
      FAULTS[name].inject(disk);
      const app = boot(disk);
      expect(app.authority.state(), name).toMatchObject({ signedOut: true, migrationPending: true });
      FAULTS[name].clear(disk);
      expect(app.authority.startup(), name).toMatchObject({ signedOut: false });
      expect(app.authority.restore(), name).toMatchObject({ signedOut: false, token: OLD, user: { id: 'old' } });
      expect(disk.config[MARK], name).toBe(true);
    }
  });
});

describe('migration error matrix (desktop): only a confirmed missing pair is a decision', () => {
  /** No token (confirmed missing), a user of the previous version. */
  function userOnly() {
    const disk = createDisk();
    disk.config.userInfo = OLD_USER;
    return disk;
  }

  it('confirmed missing token: tombstone, mark, deleted', () => {
    const disk = userOnly();
    const app = boot(disk);
    expect(app.authority.restore()).toMatchObject({ signedOut: true });
    expect(JSON.parse(disk.record)).toEqual({ epoch: 0, signedOut: true });
    expect(disk.config[MARK]).toBe(true);
    expect(disk.config.userInfo).toBeUndefined();
  });

  it('tombstone not writable: held, nothing deleted or marked, at two starts; decided at the first start without the fault', () => {
    const disk = userOnly();
    for (const fault of ['failRecordWrite', 'dropRecordWrite']) {
      disk[fault] = true;
      for (let start = 1; start <= 2; start++) {
        const app = boot(disk);
        expect(app.authority.state(), `${fault}/${start}`).toMatchObject({ signedOut: true, migrationPending: true });
        expect(disk.config.userInfo, `${fault}/${start}`).toEqual(OLD_USER);
        expect(disk.config[MARK], `${fault}/${start}`).toBeUndefined();
        expect(disk.record, `${fault}/${start}`).toBeNull();
      }
      disk[fault] = false;
    }
    boot(disk);
    expect(JSON.parse(disk.record)).toEqual({ epoch: 0, signedOut: true });
    expect(disk.config[MARK]).toBe(true);
    expect(disk.config.userInfo).toBeUndefined();
  });

  it('mark not writable after the tombstone: held in that run (nothing deleted); the tombstone decides later starts', () => {
    const disk = userOnly();
    disk.failSet.add(MARK);
    const app = boot(disk);
    expect(app.authority.state()).toMatchObject({ signedOut: true, migrationPending: true });
    expect(disk.config.userInfo).toEqual(OLD_USER);
    expect(disk.config[MARK]).toBeUndefined();
    // Next start: the confirmed tombstone of a confirmed non-pair (E5 deletes).
    boot(disk);
    expect(disk.config.userInfo).toBeUndefined();
    disk.failSet.delete(MARK);
    boot(disk);
    expect(disk.config[MARK]).toBe(true);
  });

  it('a token of another user (confirmed content) is a decision, a user read error is not', () => {
    const disk = legacyDisk();
    disk.config.userInfo = { id: 'other' };
    boot(disk);
    expect(disk.config.authToken).toBeUndefined();
    expect(disk.config[MARK]).toBe(true);
  });
});

describe('a signed-in record of this build without a confirmed mark is never released', () => {
  it('record {7,false} from a sign-in while the migration was held, mark write fails: held at two starts, released without the fault', async () => {
    const disk = legacyDisk();
    disk.failRecordWrite = true;
    const held = boot(disk);
    disk.failRecordWrite = false;
    disk.failSet.add(MARK);
    expect(held.passwordSignIn('a').apply()).toMatchObject({ applied: true, persisted: true });
    for (let start = 1; start <= 2; start++) {
      const app = boot(disk);
      expect(app.authority.getToken(), `start ${start}`).toBeNull();
      expect(app.authority.restore(), `start ${start}`).toMatchObject({ signedOut: true });
      expect(disk.config.userInfo, `start ${start}`).toEqual({ id: 'a' });
    }
    disk.failSet.delete(MARK);
    expect(boot(disk).authority.restore()).toMatchObject({ signedOut: false, user: { id: 'a' } });
    expect(disk.config[MARK]).toBe(true);
  });
});
