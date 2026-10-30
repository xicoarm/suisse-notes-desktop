// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createBackgroundRig, until } from './support/backgroundRig.js';

// Review round 10 (F5, regression of round 9): an upload attempt that never
// returns because the app dies (the same place, at every start) must still
// reach the retry limit - while an attempt ended by a session change
// (SESSION_ENDED) still counts nothing (council 3, R-S3). Before the upload
// the queue entry carries an «attempt started» marker with the session
// epoch; the next run of the SAME session finds it without an outcome and
// counts it, a run of another session clears it without counting. The
// source file is kept when the limit removes the entry.
// Failed at 1f4d97d (retryCount stayed 0 through every crash).

const rigs = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.cleanup(); });

const INIT = '/api/uploads/init';
const entry = (r, retryCount = 0) => ({ recordId: 'r1', filePath: r.filePath(), metadata: {}, userId: 'a', addedAt: '2026-10-29T10:00:00.000Z', retryCount });

/** One app start on `disk` with `queue`; the upload hangs at init (the crash point). Returns the queue as persisted at the crash. */
async function crashingStart(disk, queue) {
  const r = createBackgroundRig({ disk, session: disk ? 'persisted' : 'signedIn', queue: [] });
  rigs.push(r);
  r.stores.queue.data.pendingUploads = queue ? queue.map((q) => ({ ...q, filePath: r.filePath() })) : [entry(r)];
  r.answer('post', INIT, () => new Promise(() => {}));
  r.background.pending.run(r.scopes.open());
  // The process dies while the request is on the wire: nothing after it runs.
  await until(() => r.requests.some((q) => q.url.endsWith(INIT)) || !r.stores.queue.data.pendingUploads.length);
  return { r, persisted: JSON.parse(JSON.stringify(r.stores.queue.data.pendingUploads)) };
}

describe('F5: a crash during the upload counts as an attempt; a session change does not', () => {
  it('the same place crashes at every start: the limit removes the entry after 10 starts, the source stays', async () => {
    let { r, persisted } = await crashingStart(null, null);
    const disk = r.disk;
    const counts = [persisted[0].retryCount];
    for (let start = 2; start <= 12 && persisted.length; start++) {
      ({ r, persisted } = await crashingStart(disk, persisted));
      if (persisted.length) counts.push(persisted[0].retryCount);
    }
    // Start k finds the marker of start k-1: counts 0, 1, 2, ... 9, then the limit.
    expect(counts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(persisted).toEqual([]);
    const last = rigs.at(-1);
    expect(last.requests.filter((q) => q.url.endsWith(INIT))).toEqual([]);
    expect(last.stores.history.data.recordings.find((x) => x.id === 'r1')).toMatchObject({ uploadStatus: 'failed' });
    expect(fs.existsSync(last.filePath())).toBe(true);
  }, 60000);

  it('an attempt ended by a sign-out counts nothing, also after a restart of the next session', async () => {
    const r = createBackgroundRig({ queue: [] });
    rigs.push(r);
    r.stores.queue.data.pendingUploads = [entry(r)];
    r.answer('post', INIT, () => new Promise(() => {}));
    const running = r.background.pending.run(r.scopes.open());
    await until(() => r.requests.some((q) => q.url.endsWith(INIT)));
    r.signOut();
    expect(await running).toEqual({ sessionEnded: true });
    expect(r.stores.queue.data.pendingUploads[0].retryCount).toBe(0);
    r.signInA();
    // A restart in the new session: the old marker is not this session's.
    const next = createBackgroundRig({ disk: r.disk, session: 'persisted', queue: [] });
    rigs.push(next);
    next.stores.queue.data.pendingUploads = r.stores.queue.data.pendingUploads.map((q) => ({ ...q, filePath: next.filePath() }));
    expect(await next.background.pending.run(next.scopes.open())).toEqual({ completed: true });
    expect(next.stores.queue.data.pendingUploads).toEqual([]);
    expect(next.stores.history.data.recordings.find((x) => x.id === 'r1')).toMatchObject({ uploadStatus: 'uploaded' });
    expect(next.requests.filter((q) => q.url.endsWith('/api/uploads/complete'))).toHaveLength(1);
  });

  it('a failed attempt with an outcome counts once and leaves no marker (control)', async () => {
    const r = createBackgroundRig({ queue: [] });
    rigs.push(r);
    r.stores.queue.data.pendingUploads = [entry(r)];
    r.answer('post', INIT, { status: 503, data: { error: 'down' } });
    r.answer('post', INIT, { status: 503, data: { error: 'down' } });
    r.answer('post', INIT, { status: 503, data: { error: 'down' } });
    expect(await r.background.pending.run(r.scopes.open())).toEqual({ completed: true });
    const [left] = r.stores.queue.data.pendingUploads;
    expect(left.retryCount).toBe(1);
    expect(left.attempt).toBeUndefined();
  });
});
