// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// Review round 8, E7 with the REAL main functions (electron-main.js, cut out
// unchanged by their AST range and run in a VM; only I/O, network and the
// session authority are stand-ins): background work of a session that ended
// (sign-out, then a new sign-in) neither refreshes, nor writes a receipt or
// history, nor sends a further request. Reviewer repros of round 7
// (refreshesAfterSessionChange=1, receiptWrites=1) are the first two tests.
// Failed at 82ab3187.

const require = createRequire(import.meta.url);
const espree = require('espree');
const { verifiedUploadResult } = require('../../src-electron/upload-safety.js');

const MAIN = fs.readFileSync(path.resolve('src-electron/electron-main.js'), 'utf8');
const AST = espree.parse(MAIN, { ecmaVersion: 'latest', sourceType: 'script', range: true });

function functionSource(name) {
  const node = AST.body.find((n) => n.type === 'FunctionDeclaration' && n.id?.name === name);
  if (!node) throw new Error(`main function ${name} not found`);
  return MAIN.slice(node.range[0], node.range[1]);
}

const FUNCTIONS = ['getAuthToken', 'tokenFor', 'sessionEndedFor', 'sessionEndedResult', 'sessionEndedVerification', 'refreshMainAuthToken', 'pollServerStatus',
  'saveUploadOutcome', 'verifyAcceptedUpload', 'uploadWithRetry', 'tryDirectUpload', 'uploadWithRetryLegacy'];

const jwt = (userId) => `h.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.s`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** Let the work run until `mock` was called (it then waits on a deferred). */
async function until(mock) {
  for (let i = 0; i < 50 && mock.mock.calls.length === 0; i++) await flush();
  expect(mock).toHaveBeenCalled();
}

/** The main functions on a fake authority: sign-in A, then sign-out + sign-in B. */
function rig() {
  const session = { epoch: 1, signedOut: false, token: jwt('a'), aborted: 0 };
  const authority = {
    ticket: (extra = {}) => Object.freeze({ ...extra, epoch: session.epoch }),
    isCurrent: (t) => !!t && t.epoch === session.epoch,
    getToken: () => (session.signedOut ? null : session.token),
    getUser: () => (session.signedOut ? null : { id: 'a' }),
    applySession: vi.fn((ticket) => (ticket.epoch === session.epoch ? { applied: true, epoch: session.epoch } : { applied: false, reason: 'session_changed' }))
  };
  const signOutThenB = () => {
    session.epoch += 1; session.signedOut = true; session.token = null;
    session.epoch += 1; session.signedOut = false; session.token = jwt('b');
  };
  const calls = {
    get: vi.fn(), post: vi.fn(), writeFileAtomic: vi.fn(async () => {}), historySet: vi.fn(), sleep: vi.fn(async () => {}),
    direct: vi.fn(), abortDirect: vi.fn(async () => ({ success: true })), mkdir: vi.fn()
  };
  const recordings = [{ id: 'r1', userId: 'a', uploadStatus: 'pending' }];
  class FormData {
    append() {}
    getHeaders() { return {}; }
  }
  const context = {
    require: (name) => { if (name === 'form-data') return FormData; throw new Error(`unexpected require ${name}`); },
    sessionAuthority: authority,
    sessionTokenUserId: (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url')).userId; } catch { return null; } },
    tokenUserId: (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url')).userId; } catch { return null; } },
    canUploadForUser: (owner, user) => !!owner && owner === user,
    verifiedUploadResult,
    axios: { get: calls.get, post: calls.post },
    API_BASE_URL: 'http://127.0.0.1:1',
    writeFileAtomic: calls.writeFileAtomic,
    historyStore: { get: () => JSON.parse(JSON.stringify(recordings)), set: calls.historySet },
    fs: {
      statSync: () => ({ size: 10, mtimeMs: 5 }), mkdirSync: calls.mkdir,
      promises: { stat: async () => ({ size: 10, mtimeMs: 5 }) }, createReadStream: () => ({})
    },
    path,
    getRecordingPath: (id) => `/synthetic/${id}`,
    getRecordingsPath: () => '/synthetic',
    recordingOwner: () => 'a',
    readUploadReceipt: () => null,
    assessRecordingUpload: async () => ({ allowed: true }),
    uploadViaPresignedSas: calls.direct,
    ffmpeg: null,
    abortDirectUpload: calls.abortDirect,
    FATAL_HTTP_STATUSES: new Set([400, 402, 413, 415]),
    captureUploadFailureOnce: () => {},
    calculateUploadTimeout: () => 1000,
    sleep: calls.sleep,
    mainWindow: null,
    app: { getVersion: () => 'test' },
    activeAbortControllers: new Map(),
    activeDirectAudioFileIds: new Map(),
    unsavedRecordingId: null,
    recordingLocks: new Map(),
    isRecordingInProgress: false,
    getActiveRecording: () => null,
    Sentry: { captureMessage: () => {}, captureException: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setInterval: () => 1,
    clearInterval: () => {},
    AbortController
  };
  const fns = vm.runInNewContext(`${FUNCTIONS.map(functionSource).join('\n')}\n({ ${FUNCTIONS.join(', ')} });`, context);
  const refreshCalls = () => calls.post.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/refresh'));
  return { fns, session, authority, calls, signOutThenB, refreshCalls };
}

describe('E7: a delayed 401 of an ended session never refreshes the new one (reviewer repro r7)', () => {
  it('upload status poll: 401 arrives after sign-out and sign-in B -> no refresh, no further request', async () => {
    const { fns, authority, calls, signOutThenB, refreshCalls } = rig();
    const ticket = authority.ticket();
    const status = deferred();
    calls.get.mockReturnValueOnce(status.promise);
    const done = fns.pollServerStatus('audio-1', 15, 'a', ticket);
    await until(calls.get);
    signOutThenB();
    status.reject(Object.assign(new Error('401'), { response: { status: 401 } }));
    const result = await done;
    expect(refreshCalls()).toEqual([]);
    expect(authority.applySession).not.toHaveBeenCalled();
    expect(calls.get).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ verified: false });
  });

  it('refreshMainAuthToken with the ticket of an ended session: no request', async () => {
    const { fns, authority, signOutThenB, refreshCalls } = rig();
    const ticket = authority.ticket();
    signOutThenB();
    expect(await fns.refreshMainAuthToken(ticket)).toMatchObject({ success: false });
    expect(refreshCalls()).toEqual([]);
  });

  it('a refresh answer that arrives after the session changed applies nothing', async () => {
    const { fns, authority, calls, signOutThenB } = rig();
    const answer = deferred();
    calls.post.mockReturnValueOnce(answer.promise);
    const done = fns.refreshMainAuthToken(authority.ticket());
    await until(calls.post);
    signOutThenB();
    answer.resolve({ data: { token: jwt('a'), user: { id: 'a' } } });
    expect(await done).toMatchObject({ success: false });
    expect(authority.applySession.mock.results.every((r) => r.value.applied === false)).toBe(true);
  });
});

describe('E7: a late upload success of an ended session writes no receipt and no history (reviewer repro r7)', () => {
  it('direct upload resolves after sign-out and sign-in B: no receipt, no history, no status request', async () => {
    const { fns, authority, calls, signOutThenB } = rig();
    const upload = deferred();
    calls.direct.mockReturnValueOnce(upload.promise);
    const done = fns.uploadWithRetry('r1', '/synthetic/r1/audio.webm', {}, 0, authority.ticket());
    await until(calls.direct);
    signOutThenB();
    upload.resolve({ mode: 'azure', success: true, audioFileId: 'audio-1', canDelete: true, verified: true });
    const result = await done;
    expect(calls.writeFileAtomic).not.toHaveBeenCalled();
    expect(calls.historySet).not.toHaveBeenCalled();
    expect(calls.get).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, sessionEnded: true });
  });

  it('legacy POST resolves after sign-out and sign-in B: no receipt, no history', async () => {
    const { fns, authority, calls, signOutThenB } = rig();
    calls.direct.mockResolvedValueOnce({ mode: 'fallback' });
    const post = deferred();
    calls.post.mockReturnValueOnce(post.promise);
    const done = fns.uploadWithRetry('r1', '/synthetic/r1/audio.webm', {}, 0, authority.ticket());
    await until(calls.post);
    signOutThenB();
    post.resolve({ status: 200, data: { success: true, audioFileId: 'audio-1' } });
    const result = await done;
    expect(calls.writeFileAtomic).not.toHaveBeenCalled();
    expect(calls.historySet).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, sessionEnded: true });
  });

  it('verifyAcceptedUpload: session ends while the receipt is written -> no status request, no history', async () => {
    const { fns, authority, calls, signOutThenB } = rig();
    const write = deferred();
    calls.writeFileAtomic.mockReturnValueOnce(write.promise);
    const done = fns.verifyAcceptedUpload('r1', '/synthetic/r1/audio.webm', { success: true, audioFileId: 'audio-1' }, 'a', true, { size: 10, mtimeMs: 5 }, authority.ticket());
    await until(calls.writeFileAtomic);
    signOutThenB();
    write.resolve();
    expect(await done).toMatchObject({ success: false, sessionEnded: true });
    expect(calls.get).not.toHaveBeenCalled();
    expect(calls.historySet).not.toHaveBeenCalled();
    expect(calls.writeFileAtomic).toHaveBeenCalledTimes(1);
  });

  it('verifyAcceptedUpload: session ends while the verified receipt is written -> no history', async () => {
    const { fns, authority, calls, signOutThenB } = rig();
    calls.get.mockResolvedValueOnce({ data: { status: 'COMPLETED' } });
    const second = deferred();
    calls.writeFileAtomic.mockResolvedValueOnce().mockReturnValueOnce(second.promise);
    const done = fns.verifyAcceptedUpload('r1', '/synthetic/r1/audio.webm', { success: true, audioFileId: 'audio-1' }, 'a', true, { size: 10, mtimeMs: 5 }, authority.ticket());
    for (let i = 0; i < 5 && calls.writeFileAtomic.mock.calls.length < 2; i++) await flush();
    expect(calls.writeFileAtomic).toHaveBeenCalledTimes(2);
    signOutThenB();
    second.resolve();
    expect(await done).toMatchObject({ success: false, sessionEnded: true });
    expect(calls.historySet).not.toHaveBeenCalled();
  });

  it('the same paths without a session change still write receipt and history (control)', async () => {
    const { fns, authority, calls } = rig();
    calls.direct.mockResolvedValueOnce({ mode: 'azure', success: true, audioFileId: 'audio-1', canDelete: true, verified: true });
    calls.get.mockResolvedValueOnce({ data: { status: 'COMPLETED' } });
    const result = await fns.uploadWithRetry('r1', '/synthetic/r1/audio.webm', {}, 0, authority.ticket());
    expect(result).toMatchObject({ success: true });
    expect(calls.writeFileAtomic).toHaveBeenCalledTimes(2);
    expect(calls.historySet).toHaveBeenCalledTimes(1);
  });

  it('a direct upload that throws after the session ended: no retry request', async () => {
    const { fns, authority, calls, signOutThenB } = rig();
    const upload = deferred();
    calls.direct.mockReturnValueOnce(upload.promise);
    const done = fns.uploadWithRetry('r1', '/synthetic/r1/audio.webm', {}, 3, authority.ticket());
    await until(calls.direct);
    signOutThenB();
    upload.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    expect(await done).toMatchObject({ success: false, sessionEnded: true });
    expect(calls.direct).toHaveBeenCalledTimes(1);
    expect(calls.sleep).not.toHaveBeenCalled();
    expect(calls.post).not.toHaveBeenCalled();
  });

  it('upload work without a ticket is refused (no silent «current session» default)', async () => {
    const { fns, calls } = rig();
    expect(fns.tokenFor(null)).toBeNull();
    expect(fns.sessionEndedFor(undefined)).toBe(true);
    expect(await fns.pollServerStatus('audio-1', 1, 'a')).toMatchObject({ sessionEnded: true });
    expect(calls.get).not.toHaveBeenCalled();
  });
});
