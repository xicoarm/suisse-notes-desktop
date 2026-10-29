// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { createBackgroundRig, deferred, until, jwt } from './support/backgroundRig.js';

// Reviewer repros of round 7 (refreshesAfterSessionChange=1,
// receiptWrites=1), since round 9 (council 3) on the REAL background modules
// with the REAL session authority and scope registry: background work of a
// session that ended (sign-out, then a new sign-in) neither refreshes, nor
// writes a receipt or history, nor sends a further request. Every edge counts
// globally (tests/unit/support/backgroundRig.js).

const rigs = [];
const rig = (opts) => { const r = createBackgroundRig(opts); rigs.push(r); return r; };
afterEach(() => { for (const r of rigs.splice(0)) r.cleanup(); });

const refreshes = (r) => r.requests.filter((q) => q.url.endsWith('/api/auth/refresh'));

describe('E7: a delayed 401 of an ended session never refreshes the new one (reviewer repro r7)', () => {
  it.each([false, true])('upload status poll: 401 arrives after sign-out and sign-in B -> no refresh, no further request (late answer %s)', async (lateAnswers) => {
    const r = rig({ lateAnswers });
    const scope = r.scopes.open();
    const status = deferred();
    r.answer('get', /\/status$/, () => status.promise);
    const done = r.uploads.pollServerStatus(scope, 'audio-1', 15, 'a');
    await until(() => r.requests.length === 1);
    r.signOutThenB();
    status.resolve({ status: 401, data: { error: 'expired' } });
    expect(await done).toMatchObject({ verified: false, sessionEnded: true });
    expect(refreshes(r)).toEqual([]);
    expect(r.requestsAfter()).toEqual([]);
    expect(r.effectsAfter()).toEqual([]);
    // B's session is untouched.
    expect(r.s.authority.getUser()).toMatchObject({ id: 'b' });
  });

  it('refreshMainAuthToken in the scope of an ended session: no request', async () => {
    const r = rig();
    const scope = r.scopes.open();
    r.signOutThenB();
    expect(await r.uploads.refreshMainAuthToken(scope)).toMatchObject({ success: false });
    expect(refreshes(r)).toEqual([]);
  });

  it('a refresh answer that arrives after the session changed applies nothing', async () => {
    const r = rig({ lateAnswers: true });
    const scope = r.scopes.open();
    const answer = deferred();
    r.answer('post', '/api/auth/refresh', () => answer.promise);
    const done = r.uploads.refreshMainAuthToken(scope);
    await until(() => refreshes(r).length === 1);
    r.signOutThenB();
    const tokenB = r.s.authority.getToken();
    answer.resolve({ status: 200, data: { token: jwt('a', 'late'), user: { id: 'a' } } });
    expect(await done).toMatchObject({ success: false });
    expect(r.s.authority.getToken()).toBe(tokenB);
    expect(r.s.authority.getUser()).toMatchObject({ id: 'b' });
  });

  it('control: a refresh in the same session applies', async () => {
    const r = rig();
    const scope = r.scopes.open();
    expect(await r.uploads.refreshMainAuthToken(scope)).toMatchObject({ success: true });
    expect(r.s.authority.getToken()).toBe(jwt('a', 'refreshed'));
    expect(scope.alive()).toBe(true);
  });
});

describe('E7: a late upload success of an ended session writes no receipt and no history (reviewer repro r7)', () => {
  it.each([false, true])('direct upload completes after sign-out and sign-in B: no receipt, no history, no status request (late answer %s)', async (lateAnswers) => {
    const r = rig({ lateAnswers });
    const scope = r.scopes.open();
    const complete = deferred();
    r.answer('post', '/api/uploads/complete', () => complete.promise);
    const done = r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 0);
    await until(() => r.requests.some((q) => q.url.endsWith('/api/uploads/complete')));
    r.signOutThenB();
    complete.resolve({ status: 200, data: { success: true, audioFileId: 'audio-1' } });
    expect(await done).toMatchObject({ success: false, sessionEnded: true });
    expect(r.read.readUploadReceipt('r1')).toBeNull();
    expect(r.effectsAfter()).toEqual([]);
    expect(r.requestsAfter()).toEqual([]);
    expect(r.effects.filter((e) => e.kind === 'history')).toEqual([]);
  });

  it.each([false, true])('legacy POST resolves after sign-out and sign-in B: no receipt, no history (late answer %s)', async (lateAnswers) => {
    const r = rig({ lateAnswers });
    r.answer('post', '/api/uploads/init', { status: 200, data: { mode: 'fallback' } });
    const scope = r.scopes.open();
    const post = deferred();
    r.answer('post', '/api/desktop/upload', () => post.promise);
    const done = r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 0);
    await until(() => r.requests.some((q) => q.url.endsWith('/api/desktop/upload')));
    r.signOutThenB();
    post.resolve({ status: 200, data: { success: true, audioFileId: 'audio-1' } });
    expect(await done).toMatchObject({ success: false, sessionEnded: true });
    expect(r.read.readUploadReceipt('r1')).toBeNull();
    expect(r.effectsAfter()).toEqual([]);
    expect(r.requestsAfter()).toEqual([]);
  });

  it('verifyAcceptedUpload: session ends while the receipt is written -> no rename, no status request, no history', async () => {
    const r = rig();
    const scope = r.scopes.open();
    // The change lands right after the temp file of the receipt was opened
    // (before its rename).
    r.hooks.onEffect = (kind) => { if (kind === 'open') { r.hooks.onEffect = null; r.signOutThenB(); } };
    r.answer('get', /\/status$/, () => { throw new Error('no status request expected'); });
    const done = r.uploads.verifyAcceptedUpload(scope, 'r1', r.filePath(), { success: true, audioFileId: 'audio-1' }, 'a', true, null);
    expect(await done).toMatchObject({ success: false, sessionEnded: true });
    expect(r.effects.filter((e) => e.kind === 'rename')).toEqual([]);
    expect(r.read.readUploadReceipt('r1')).toBeNull();
    expect(r.requests.filter((q) => q.url.endsWith('/status'))).toEqual([]);
    expect(r.effects.filter((e) => e.kind === 'history')).toEqual([]);
  });

  it('verifyAcceptedUpload: session ends while the verified receipt is written -> unverified receipt stays, no history', async () => {
    const r = rig();
    const scope = r.scopes.open();
    let opens = 0;
    r.hooks.onEffect = (kind) => { if (kind === 'open' && ++opens === 2) { r.hooks.onEffect = null; r.signOutThenB(); } };
    const done = r.uploads.verifyAcceptedUpload(scope, 'r1', r.filePath(), { success: true, audioFileId: 'audio-1' }, 'a', true, null);
    expect(await done).toMatchObject({ success: false, sessionEnded: true });
    expect(r.read.readUploadReceipt('r1')).toMatchObject({ audioFileId: 'audio-1', verified: false });
    expect(r.effects.filter((e) => e.kind === 'rename')).toHaveLength(1);
    expect(r.effects.filter((e) => e.kind === 'history')).toEqual([]);
  });

  it('the same paths without a session change still write receipt and history (control)', async () => {
    const r = rig();
    const scope = r.scopes.open();
    const result = await r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 0);
    expect(result).toMatchObject({ success: true, verified: true });
    expect(r.read.readUploadReceipt('r1')).toMatchObject({ audioFileId: 'audio-1', verified: true });
    expect(r.effects.filter((e) => e.kind === 'rename')).toHaveLength(2);
    expect(r.effects.filter((e) => e.kind === 'history')).toHaveLength(1);
    expect(r.stores.history.data.recordings[0]).toMatchObject({ uploadStatus: 'uploaded', uploadVerified: true });
  });

  it('a direct upload that throws after the session ended: no retry request, no retry sleep', async () => {
    const r = rig({ lateAnswers: true });
    const scope = r.scopes.open();
    const init = deferred();
    r.answer('post', '/api/uploads/init', () => init.promise);
    const done = r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 3);
    await until(() => r.requests.length === 1);
    r.signOutThenB();
    init.resolve(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    expect(await done).toMatchObject({ success: false, sessionEnded: true });
    expect(r.requests).toHaveLength(1);
    expect(r.sleeps.filter((s) => s.after)).toEqual([]);
  });

  it('no scope without a released session (no silent «current session» default)', async () => {
    const r = rig();
    r.signOut();
    expect(r.scopes.open()).toBeNull();
    const stale = (() => { r.signInA(); const sc = r.scopes.open(); r.signOut(); return sc; })();
    expect(await r.uploads.pollServerStatus(stale, 'audio-1', 1, 'a')).toMatchObject({ sessionEnded: true });
    expect(r.requests).toEqual([]);
  });
});
