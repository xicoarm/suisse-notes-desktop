// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Exercise the actual main-process upload functions without starting Electron
// or a network listener. Keep their retry/receipt decisions intact and replace
// only I/O, clocks, and the direct-upload fallback boundary.
const mainSource = fs.readFileSync(path.resolve('src-electron/electron-main.js'), 'utf8');
function functionSource(start, end) {
  const from = mainSource.indexOf(start), to = mainSource.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error('Upload function boundary changed');
  return mainSource.slice(from, to);
}
const uploadFunctions = functionSource('async function uploadWithRetry(', 'async function tryDirectUpload(') +
  functionSource('async function uploadWithRetryLegacy(', '\nconst inFlightUploads');
const brokenPipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
const accepted = { status: 200, data: { success: true, audioFileId: 'accepted-id' } };

function fixture() {
  const calls = { post: vi.fn(), verify: vi.fn().mockResolvedValue({ success: true, audioFileId: 'accepted-id', canDelete: false }),
    sleep: vi.fn().mockResolvedValue(), source: vi.fn(() => ({})), receipt: vi.fn(() => null),
    report: vi.fn(), direct: vi.fn().mockResolvedValue({ handled: false, reason: 'test fallback' }) };
  const snapshot = { size: 1234, mtimeMs: 5678 };
  class FormData {
    constructor() { this.fields = []; }
    append(...values) { this.fields.push(values); }
    getHeaders() { return { 'Content-Type': 'multipart/form-data; boundary=test' }; }
  }
  const context = {
    require: name => { if (name !== 'form-data') throw new Error('Unexpected dependency'); return FormData; },
    fs: { statSync: () => snapshot, promises: { stat: async () => snapshot }, createReadStream: calls.source },
    path, API_BASE_URL: 'http://127.0.0.1:3000', axios: { post: calls.post }, getAuthToken: async () => 'test-token',
    canUploadForUser: (owner, user) => owner === user, tokenUserId: () => 'owner', recordingOwner: () => 'owner',
    readUploadReceipt: calls.receipt, verifyAcceptedUpload: calls.verify, tryDirectUpload: calls.direct,
    sleep: calls.sleep, captureUploadFailureOnce: calls.report, calculateUploadTimeout: () => 600000,
    app: { getVersion: () => 'test-version' }, mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, console: { log: vi.fn() },
    setInterval: () => 1, clearInterval: vi.fn(), AbortController,
    activeAbortControllers: new Map(), activeDirectAudioFileIds: new Map(), unsavedRecordingId: null,
  };
  const functions = vm.runInNewContext(uploadFunctions + '\n({ uploadWithRetry, uploadWithRetryLegacy });', context);
  const invoke = (retries = 3, controller = new AbortController()) => functions.uploadWithRetryLegacy(
    'record', '/synthetic/audio.webm', { duration: 45 }, retries, controller, 'owner', snapshot);
  return { calls, snapshot, invoke, functions };
}

describe('legacy upload broken-pipe recovery', () => {
  it('reopens the source for EPIPE retry and verifies the accepted response once', async () => {
    const { calls, snapshot, invoke } = fixture();
    calls.post.mockRejectedValueOnce(brokenPipe()).mockResolvedValueOnce(accepted);
    expect(await invoke()).toMatchObject({ success: true, canDelete: false });
    expect(calls.post).toHaveBeenCalledTimes(2);
    expect(calls.sleep.mock.calls).toEqual([[2000]]);
    expect(calls.source.mock.calls).toEqual([['/synthetic/audio.webm'], ['/synthetic/audio.webm']]);
    expect(calls.post.mock.calls[0][1]).not.toBe(calls.post.mock.calls[1][1]);
    expect(calls.verify).toHaveBeenCalledTimes(1);
    expect(calls.verify).toHaveBeenCalledWith('record', '/synthetic/audio.webm', accepted.data, 'owner', true, snapshot);
    expect(calls.report).not.toHaveBeenCalled();
  });

  it('bounds repeated broken pipes and keeps the recording eligible for later retry', async () => {
    const { calls, invoke } = fixture();
    calls.post.mockRejectedValue(brokenPipe());
    expect(await invoke(2)).toMatchObject({ success: false, canRetry: true, error: 'Connection was interrupted. Please try again.' });
    expect(calls.post).toHaveBeenCalledTimes(3);
    expect(calls.sleep.mock.calls).toEqual([[2000], [5000]]);
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.report).toHaveBeenCalledTimes(1);
  });

  it('does not retry a user abort even when the transport reports EPIPE', async () => {
    const { calls, invoke } = fixture(), controller = new AbortController();
    calls.post.mockRejectedValue(brokenPipe()); controller.abort();
    expect(await invoke(3, controller)).toMatchObject({ success: false, cancelled: true, canRetry: false });
    expect(calls.post).toHaveBeenCalledTimes(1);
    expect(calls.sleep).not.toHaveBeenCalled();
    expect(calls.verify).not.toHaveBeenCalled();
  });

  it.each([400, 401, 402, 403, 413, 422])('keeps HTTP %i terminal for this attempt', async status => {
    const { calls, invoke } = fixture();
    calls.post.mockRejectedValue(Object.assign(new Error('Rejected'), { response: { status, data: { error: 'Rejected' } } }));
    expect(await invoke()).toMatchObject({ success: false, canRetry: false, status });
    expect(calls.post).toHaveBeenCalledTimes(1);
    expect(calls.sleep).not.toHaveBeenCalled();
    expect(calls.verify).not.toHaveBeenCalled();
  });

  it('verifies an existing accepted ID without replaying either upload transport', async () => {
    const { calls, snapshot, functions } = fixture();
    const receipt = { audioFileId: 'already-accepted', ownerId: 'owner', fileSize: snapshot.size, fileMtimeMs: snapshot.mtimeMs };
    calls.receipt.mockReturnValue(receipt);
    calls.verify.mockResolvedValue({ success: false, pendingVerification: true, canDelete: false });
    expect(await functions.uploadWithRetry('record', '/synthetic/audio.webm', {})).toMatchObject({ pendingVerification: true, canDelete: false });
    expect(calls.verify).toHaveBeenCalledTimes(1);
    expect(calls.verify).toHaveBeenCalledWith('record', '/synthetic/audio.webm', receipt, 'owner', false);
    expect(calls.post).not.toHaveBeenCalled();
    expect(calls.direct).not.toHaveBeenCalled();
  });
});
