// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createBackgroundRig } from './support/backgroundRig.js';

// The real background upload (src-electron/background/upload.js, since
// review round 9) on the real session scope: retry and receipt decisions of
// the legacy POST stay intact; only the transport, files and clocks are
// stand-ins (tests/unit/support/backgroundRig.js).

const brokenPipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
const accepted = { status: 200, data: { success: true, audioFileId: 'accepted-id' } };
const LEGACY = '/api/desktop/upload';

const rigs = [];
afterEach(() => { for (const r of rigs.splice(0)) r.cleanup(); });

/** A rig whose server asks for the legacy POST (local-storage mode). */
function fixture(opts) {
  const r = createBackgroundRig(opts);
  rigs.push(r);
  r.answer('post', '/api/uploads/init', { status: 200, data: { mode: 'fallback' } });
  const scope = r.scopes.open();
  const snapshot = fs.statSync(r.filePath());
  const legacyPosts = () => r.requests.filter((q) => q.method === 'post' && q.url.endsWith(LEGACY));
  const invoke = (retries = 3, controller = new AbortController(), sc = scope) =>
    r.uploads.uploadWithRetryLegacy(sc, 'r1', r.filePath(), { duration: 45 }, retries, controller, 'a', snapshot);
  return { r, scope, snapshot, legacyPosts, invoke };
}

describe('legacy upload broken-pipe recovery', () => {
  it('blocks both upload transports and accepted-receipt resume while saved sources require finalization', async () => {
    let receiptReads = 0;
    const { r, scope } = fixture({
      read: {
        assessRecordingUpload: async () => ({ allowed: false, requiresFinalization: true, error: 'Combine the saved sources first' }),
        readUploadReceipt: () => { receiptReads++; return { audioFileId: 'stale-accepted-id' }; },
      },
    });
    expect(await r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 3)).toMatchObject({
      success: false, canDelete: false, requiresFinalization: true, error: 'Combine the saved sources first',
    });
    expect(receiptReads).toBe(0);
    expect(r.requests).toEqual([]);
    expect(r.streams).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it('reopens the source for EPIPE retry and verifies the accepted response once', async () => {
    const { r, legacyPosts, invoke } = fixture();
    r.answer('post', LEGACY, brokenPipe());
    r.answer('post', LEGACY, accepted);
    expect(await invoke()).toMatchObject({ success: true, verified: true, audioFileId: 'accepted-id' });
    expect(legacyPosts()).toHaveLength(2);
    expect(r.sleeps.map((s) => s.ms)).toEqual([2000]);
    expect(r.streams).toEqual([r.filePath(), r.filePath()]);
    expect(legacyPosts()[0].body).not.toBe(legacyPosts()[1].body);
    expect(r.requests.filter((q) => q.url.endsWith('/accepted-id/status'))).toHaveLength(1);
    expect(r.read.readUploadReceipt('r1')).toMatchObject({ audioFileId: 'accepted-id', verified: true });
    expect(r.report.failures).toEqual([]);
  });

  it('bounds repeated broken pipes and keeps the recording eligible for later retry', async () => {
    const { r, legacyPosts, invoke } = fixture();
    for (let i = 0; i < 3; i++) r.answer('post', LEGACY, brokenPipe());
    expect(await invoke(2)).toMatchObject({ success: false, canRetry: true, error: 'Connection was interrupted. Please try again.' });
    expect(legacyPosts()).toHaveLength(3);
    expect(r.sleeps.map((s) => s.ms)).toEqual([2000, 5000]);
    expect(r.read.readUploadReceipt('r1')).toBeNull();
    expect(r.report.failures).toHaveLength(1);
  });

  it('does not retry a user abort even when the transport reports EPIPE', async () => {
    const { r, legacyPosts, invoke } = fixture({ lateAnswers: true });
    const controller = new AbortController();
    r.answer('post', LEGACY, brokenPipe());
    controller.abort();
    expect(await invoke(3, controller)).toMatchObject({ success: false, cancelled: true, canRetry: false });
    // axios refuses an already aborted signal before the transport.
    expect(legacyPosts()).toHaveLength(0);
    expect(r.sleeps).toEqual([]);
    expect(r.read.readUploadReceipt('r1')).toBeNull();
  });

  it('does not retry when the user aborts while the POST is on the wire and it then fails with EPIPE', async () => {
    const { r, legacyPosts, invoke } = fixture({ lateAnswers: true });
    const controller = new AbortController();
    let fail;
    r.answer('post', LEGACY, () => new Promise((resolve) => { fail = () => resolve(brokenPipe()); }));
    const done = invoke(3, controller);
    for (let i = 0; i < 100 && !fail; i++) await new Promise((res) => setTimeout(res, 0));
    controller.abort();
    fail();
    expect(await done).toMatchObject({ success: false, cancelled: true, canRetry: false });
    expect(legacyPosts()).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
  });

  it.each([400, 401, 402, 403, 413, 422])('keeps HTTP %i terminal for this attempt', async (status) => {
    const { r, legacyPosts, invoke } = fixture();
    r.answer('post', LEGACY, { status, data: { error: 'Rejected' } });
    expect(await invoke()).toMatchObject({ success: false, canRetry: false, status });
    expect(legacyPosts()).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
    expect(r.read.readUploadReceipt('r1')).toBeNull();
  });

  it('verifies an existing accepted ID without replaying either upload transport', async () => {
    const { r, scope, snapshot } = fixture();
    const receipt = { audioFileId: 'already-accepted', ownerId: 'a', fileSize: snapshot.size, fileMtimeMs: snapshot.mtimeMs, verified: false };
    fs.writeFileSync(path.join(r.root, 'r1', 'upload-receipt.json'), JSON.stringify(receipt));
    r.answer('get', /\/status$/, { status: 200, data: { status: 'RECORDING' } });
    r.answer('get', /\/status$/, { status: 404, data: {} });
    expect(await r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 3)).toMatchObject({ pendingVerification: true, canDelete: false });
    expect(r.requests.map((q) => q.url)).toEqual([
      expect.stringMatching(/already-accepted\/status$/), expect.stringMatching(/already-accepted\/status$/),
    ]);
  });

  // E7 (council decision 2): a sign-out during the retry sleep stops the
  // upload - no further request, nothing deleted, the recording stays queued.
  it('stops after a sign-out during the retry sleep without a further request', async () => {
    const { r, scope, legacyPosts } = fixture();
    r.answer('post', LEGACY, brokenPipe());
    r.answer('post', LEGACY, accepted);
    r.hooks.onTimer = (ms) => { if (ms === 2000) { r.hooks.onTimer = null; r.signOut(); } };
    expect(await r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 3)).toMatchObject({ success: false, canDelete: false, sessionEnded: true });
    expect(legacyPosts()).toHaveLength(1);
    expect(r.requestsAfter()).toEqual([]);
    expect(r.effectsAfter()).toEqual([]);
  });

  it('the main upload path refuses to start in an ended scope', async () => {
    const { r, scope } = fixture();
    r.signOutThenB();
    expect(await r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 3)).toMatchObject({ success: false, sessionEnded: true });
    expect(r.requests).toEqual([]);
    expect(r.streams).toEqual([]);
    expect(r.effects).toEqual([]);
  });
});
