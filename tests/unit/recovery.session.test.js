// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createBackgroundRig, flush, until } from './support/backgroundRig.js';

// Review round 9 (council 3, R-S4, r8-MITTEL recovery): crash recovery and
// the clean-up of old empty folders start only with a released session, end
// at every session change without a further effect, do not count an aborted
// attempt, and the clean-up runs only after a complete recovery in the same
// scope. Real authority, registry and background modules; every edge counts
// globally (support/backgroundRig.js). Failed at 7c121955 (recovery ran
// from a timer without any session check).

const rigs = [];
afterEach(() => { for (const r of rigs.splice(0)) r.cleanup(); });

const OLD = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;

/** An interrupted recording (old chunks, no output) and an old empty orphan folder. */
function rig(opts = {}) {
  const r = createBackgroundRig({ recordings: [], history: [], ...opts });
  rigs.push(r);
  const dir = path.join(r.root, 'c1');
  fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chunks', 'chunk_0'), Buffer.alloc(10, 3));
  fs.utimesSync(path.join(dir, 'chunks', 'chunk_0'), OLD, OLD);
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ userId: 'a', startedAt: '2026-10-01T10:00:00.000Z' }));
  const orphan = path.join(r.root, 'old1');
  fs.mkdirSync(path.join(orphan, 'chunks'), { recursive: true });
  fs.utimesSync(orphan, OLD, OLD);
  return { r, dir, orphan };
}

const kinds = (list, kind) => list.filter((e) => e.kind === kind);
const start = (r, reason = 'startup') => r.background.startRecovery(r.scopes, reason);

describe('R-S4: no recovery and no clean-up without a released session', () => {
  it.each(['signedOut', 'tombstone', 'held', 'unreadable'])('%s at start: history, queue, active and rename counters 0', async (session) => {
    const { r, orphan } = rig({ session });
    expect(await start(r)).toEqual({ noSession: true });
    await flush();
    expect(r.effects).toEqual([]);
    expect(r.requests).toEqual([]);
    expect(r.spawns).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(fs.existsSync(orphan)).toBe(true);
    expect(r.background.recovery.isRunning()).toBe(false);
  });

  it('a tombstone start runs recovery exactly once after owner A signs in', async () => {
    const { r } = rig({ session: 'tombstone' });
    expect(await start(r)).toEqual({ noSession: true });
    r.signInA();
    expect(await start(r, 'sign-in')).toEqual({ completed: true });
    expect(r.spawns.filter((s) => s.port === 'finalizeForRecovery')).toHaveLength(1);
    expect(r.stores.history.data.recordings).toEqual([expect.objectContaining({ id: 'c1', userId: 'a', uploadStatus: 'pending', recovered: true })]);
    // Same session again (the startup timer after the sign-in): skipped.
    const before = r.effects.length;
    expect(await start(r)).toEqual({ skipped: true });
    expect(r.effects.length).toBe(before);
    expect(r.spawns.filter((s) => s.port === 'finalizeForRecovery')).toHaveLength(1);
  });

  it('a held start runs recovery once the start is released (main: whenReady -> afterSessionApplied)', async () => {
    const { r } = rig({ session: 'held' });
    expect(await start(r)).toEqual({ noSession: true });
    r.disk.failRecordRead = false;
    expect(r.s.authority.startup()).toMatchObject({ signedOut: false });
    expect(await start(r, 'sign-in')).toEqual({ completed: true });
    expect(r.spawns.filter((s) => s.port === 'finalizeForRecovery')).toHaveLength(1);
  });

  it('a refresh during the recovery does not end it (control)', async () => {
    const { r, orphan } = rig();
    r.hooks.onEffect = (kind) => { if (kind === 'open') { r.hooks.onEffect = null; r.refresh(); } };
    expect(await start(r)).toEqual({ completed: true });
    expect(fs.existsSync(path.join(r.root, 'c1', 'audio.webm'))).toBe(true);
    expect(r.stores.history.data.recordings).toHaveLength(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

describe('R-S4: a session change ends the recovery without a further effect', () => {
  it.each([['sign-out', 'signOut'], ['sign-out and sign-in B', 'signOutThenB']])('%s during readFinalizedRecording: no effect afterwards', async (_, change) => {
    let reads = 0;
    const holder = {};
    const { r, orphan } = rig({
      read: { readFinalizedRecording: async () => { reads++; holder.r[change](); return null; } },
    });
    holder.r = r;
    expect(await start(r)).toEqual({ sessionEnded: true });
    await flush();
    expect(reads).toBe(1);
    expect(r.effectsAfter()).toEqual([]);
    expect(r.requestsAfter()).toEqual([]);
    expect(r.sentAfter()).toEqual([]);
    expect(r.spawnsAfter()).toEqual([]);
    expect(r.stores.history.data.recordings).toEqual([]);
    expect(r.stores.queue.data.pendingUploads).toEqual([]);
    expect(fs.existsSync(path.join(r.root, 'c1', 'chunks', 'chunk_0'))).toBe(true);
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it('sign-out while the finalized output is being published: no rename, no history, no queue', async () => {
    const { r, orphan } = rig();
    r.hooks.onEffect = (kind) => { if (kind === 'open') { r.hooks.onEffect = null; r.signOutThenB(); } };
    expect(await start(r)).toEqual({ sessionEnded: true });
    await flush();
    expect(kinds(r.effects, 'rename')).toEqual([]);
    expect(fs.existsSync(path.join(r.root, 'c1', 'audio.webm'))).toBe(false);
    // The only effect after the change: the own unpublished temp file is removed.
    expect(r.effectsAfter()).toEqual([{ kind: 'unlink', target: expect.stringMatching(/audio\.webm\.[0-9a-f-]+\.tmp$/), after: true }]);
    expect(fs.readdirSync(path.join(r.root, 'c1')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(r.stores.history.data.recordings).toEqual([]);
    expect(r.stores.queue.data.pendingUploads).toEqual([]);
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it('an aborted attempt does not count recoveryAttempts; a real failure does (control)', async () => {
    const active = { recordId: 'c1', userId: 'a', recoveryAttempts: 1 };
    const aborted = rig({
      active,
      ports: { finalizeForRecovery: async () => { aborted.r.signOut(); return { success: false, error: 'late' }; } },
    });
    expect(await start(aborted.r)).toEqual({ sessionEnded: true });
    expect(aborted.r.stores.active.data.activeSession).toEqual(active);
    expect(kinds(aborted.r.effects, 'active')).toEqual([]);

    const failed = rig({ active, ports: { finalizeForRecovery: async () => ({ success: false, error: 'ffmpeg failed' }) } });
    expect(await start(failed.r)).toEqual({ completed: true });
    expect(failed.r.stores.active.data.activeSession).toMatchObject({ recoveryAttempts: 2 });
  });

  it('a session change before the queue kick: no upload request', async () => {
    const { r } = rig();
    r.hooks.onTimer = (ms) => { if (ms === 0) { r.hooks.onTimer = null; r.signOut(); } };
    await start(r);
    for (let i = 0; i < 20; i++) await flush();
    expect(r.requests).toEqual([]);
    expect(r.effectsAfter()).toEqual([]);
  });

  it('the re-scan of fresh chunks runs only while the session is alive', async () => {
    const { r, dir } = rig();
    fs.utimesSync(path.join(dir, 'chunks', 'chunk_0'), new Date(), new Date());
    r.hooks.onTimer = (ms) => { if (ms === 120000) { r.hooks.onTimer = null; r.signOut(); } };
    expect(await start(r)).toEqual({ completed: true });
    for (let i = 0; i < 20; i++) await flush();
    expect(r.spawns).toEqual([]);
    expect(r.effectsAfter()).toEqual([]);
  });

  it('control: the re-scan of fresh chunks runs in the same session', async () => {
    const { r, dir } = rig();
    fs.utimesSync(path.join(dir, 'chunks', 'chunk_0'), new Date(), new Date());
    let rescans = 0;
    r.hooks.onTimer = (ms) => {
      if (ms === 120000 && rescans++ === 0) fs.utimesSync(path.join(dir, 'chunks', 'chunk_0'), OLD, OLD);
    };
    await start(r);
    await until(() => r.spawns.some((s) => s.port === 'finalizeForRecovery'));
    expect(r.spawns.filter((s) => s.port === 'finalizeForRecovery')).toHaveLength(1);
  });
});

describe('R-S4: clean-up only after a complete recovery in the same scope', () => {
  it('complete recovery: the old empty folder is removed (control)', async () => {
    const { r, orphan } = rig();
    await start(r);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(kinds(r.effects, 'rm')).toHaveLength(1);
  });

  it('recovery ended by a session change: no clean-up', async () => {
    const { r, orphan } = rig({ ports: { finalizeForRecovery: async () => { rigs.at(-1).signOut(); return { success: false } } } });
    expect(await start(r)).toEqual({ sessionEnded: true });
    expect(fs.existsSync(orphan)).toBe(true);
    expect(kinds(r.effects, 'rm')).toEqual([]);
  });

  it('recovery that failed unexpectedly: no clean-up', async () => {
    const { r, orphan } = rig({ read: { recordingInProgress: () => { throw new Error('boom'); } } });
    const dir = path.join(r.root, 'c1');
    fs.utimesSync(path.join(dir, 'chunks', 'chunk_0'), new Date(), new Date());
    expect(await start(r)).toEqual({ failed: true });
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it('a session change during the clean-up: no rm after it', async () => {
    const { r, orphan } = rig({ recordings: [] });
    const second = path.join(r.root, 'old2');
    fs.mkdirSync(path.join(second, 'chunks'), { recursive: true });
    fs.utimesSync(second, OLD, OLD);
    r.hooks.onEffect = (kind) => { if (kind === 'rm') { r.hooks.onEffect = null; r.signOut(); } };
    expect(await start(r)).toEqual({ sessionEnded: true });
    expect(kinds(r.effects, 'rm')).toHaveLength(1);
    expect(r.effectsAfter()).toEqual([]);
    expect([fs.existsSync(orphan), fs.existsSync(second)].filter(Boolean)).toHaveLength(1);
  });
});
