import { describe, it, expect } from 'vitest';
import { boot, createDisk } from './support/desktopSession';

// E7 (security review 10/2026 round 6): main's upload queue takes a session
// ticket per run and checks it before every request and after every await or
// sleep. A sign-out stops it: no further request, queue and history unchanged
// by this run. Failed at 2349920b (the loop kept going and dropped the
// recording on the abort the sign-out caused).

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const item = (recordId, userId = 'a') => ({ recordId, filePath: `/rec/${recordId}`, userId, retryCount: 0 });

function signedIn(disk, opts) {
  const app = boot(disk, opts);
  app.passwordSignIn('a').apply();
  return app;
}

describe('E7: sign-out while main uploads in the background', () => {
  it('sign-out during the sleep between two uploads: no further request, the queue keeps the rest', async () => {
    const disk = createDisk();
    disk.queue = [item('r1'), item('r2')];
    let app;
    app = signedIn(disk, {
      wait: async () => { app.authority.signOut(); }
    });
    await app.processPendingUploads();
    expect(app.requests.map((r) => r.recordId)).toEqual(['r1']);
    expect(disk.queue).toEqual([item('r2')]);
    expect(disk.log.filter((l) => l.includes('r2'))).toEqual([]);
  });

  it('sign-out while an upload runs (aborted by the sign-out): the recording stays queued, history untouched', async () => {
    const disk = createDisk();
    disk.queue = [item('r1'), item('r2')];
    const running = deferred();
    const app = signedIn(disk, {
      upload: () => running.promise
    });
    const run = app.processPendingUploads();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.requests.map((r) => r.recordId)).toEqual(['r1']);
    app.authority.signOut();
    // The abort makes the upload end as cancelled / not retryable.
    running.resolve({ success: false, cancelled: true, canRetry: false, error: 'Upload cancelled' });
    await run;
    expect(app.requests.map((r) => r.recordId)).toEqual(['r1']);
    expect(disk.queue.map((i) => i.recordId)).toEqual(['r1', 'r2']);
    expect(disk.history).toEqual([]);
    expect(disk.log.some((l) => l.startsWith('queue.remove'))).toBe(false);
  });

  it('a sign-in of another account during the run does not upload with its token', async () => {
    const disk = createDisk();
    disk.queue = [item('r1'), item('r2')];
    let app;
    app = signedIn(disk, {
      wait: async () => { app.authority.signOut(); app.passwordSignIn('a', 'again').apply(); }
    });
    await app.processPendingUploads();
    expect(app.requests.map((r) => r.recordId)).toEqual(['r1']);
    expect(disk.queue.map((i) => i.recordId)).toEqual(['r2']);
  });

  it('signed out from the start: no request at all', async () => {
    const disk = createDisk();
    disk.queue = [item('r1')];
    const app = boot(disk);
    await app.processPendingUploads();
    expect(app.requests).toEqual([]);
    expect(disk.queue).toEqual([item('r1')]);
  });

  it('without a session change the queue is processed as before', async () => {
    const disk = createDisk();
    disk.queue = [item('r1'), item('r2'), item('other', 'b')];
    const app = signedIn(disk);
    await app.processPendingUploads();
    expect(app.requests.map((r) => r.recordId)).toEqual(['r1', 'r2']);
    expect(disk.queue.map((i) => i.recordId)).toEqual(['other']);
  });
});

// Review round 7 (r6 low finding): the run belongs to its ticket. A run of an
// ended session no longer blocks the run after the next sign-in (it used to
// stay «already running» through the 5 s pause, so the queue waited for the
// 5-minute timer). Failed at a3c841fa.
describe('E7: one run per session ticket', () => {
  it('sign-out and sign-in during the pause: the run after the sign-in is not skipped', async () => {
    const disk = createDisk();
    disk.queue = [item('r1'), item('r2')];
    const pause = deferred();
    const app = signedIn(disk, { wait: () => pause.promise });
    const first = app.processPendingUploads();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.requests.map((r) => r.recordId)).toEqual(['r1']);
    app.authority.signOut();
    app.passwordSignIn('a', 'again').apply();
    // afterSessionApplied: the run of the new session starts at once.
    const second = app.processPendingUploads();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.requests.map((r) => r.recordId)).toEqual(['r1', 'r2']);
    pause.resolve();
    await Promise.all([first, second]);
    expect(app.requests.map((r) => r.recordId)).toEqual(['r1', 'r2']);
    expect(disk.queue).toEqual([]);
  });

  it('a second call in the same session is still skipped', async () => {
    const disk = createDisk();
    disk.queue = [item('r1'), item('r2')];
    const pause = deferred();
    const app = signedIn(disk, { wait: () => pause.promise });
    const first = app.processPendingUploads();
    await new Promise((r) => setTimeout(r, 0));
    await app.processPendingUploads();
    expect(app.requests.map((r) => r.recordId)).toEqual(['r1']);
    pause.resolve();
    await first;
    expect(app.requests.map((r) => r.recordId)).toEqual(['r1', 'r2']);
  });
});
