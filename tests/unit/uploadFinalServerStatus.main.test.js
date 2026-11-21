// @vitest-environment node
// ELECTRON-8P in the main process: a recording the server has answered for
// good (FAILED "no speech recognised", CANCELLED) used to stay in the upload
// queue as "verification pending" and was asked about every five minutes,
// forever (seen in production at attempt 305). The real queue, receipt,
// verification and status-poll functions of electron-main.js run here with
// narrow stand-ins; only the status request (axios.get) and clocks are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { writeFileAtomic } = require('../../src-electron/durable-files');
const { tokenUserId, canUploadForUser, verifiedUploadResult } = require('../../src-electron/upload-safety');

const OWNER = 'owner-account-1';
const NO_SPEECH = 'In dieser Aufnahme konnte keine Sprache erkannt werden. Ihre Minuten wurden zurückerstattet.';
const MAIN = fs.readFileSync(path.resolve('src-electron/electron-main.js'), 'utf8').replace(/\r\n/g, '\n');

// Source of one top-level function, from its signature to its closing brace.
function extract(signature) {
  const start = MAIN.indexOf(`\n${signature}`);
  if (start < 0) throw new Error(`Missing ${signature}`);
  let index = MAIN.indexOf(') {\n', start) + 2, depth = 0;
  for (; index < MAIN.length; index++) {
    if (MAIN[index] === '{') depth++;
    else if (MAIN[index] === '}' && --depth === 0) return MAIN.slice(start + 1, index + 1);
  }
  throw new Error(`Unbalanced ${signature}`);
}
function memoryStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return { get: (key, fallback) => (key in data ? JSON.parse(JSON.stringify(data[key])) : fallback), set: (key, value) => { data[key] = JSON.parse(JSON.stringify(value)); } };
}
const token = userId => `h.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.s`;
const answer = (status, errorMessage) => ({ data: { audioFileId: 'remote-1', meetingId: 'meeting-1', status, ...(errorMessage ? { errorMessage } : {}) } });
const notFound = () => Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });

let root;
beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-final-status-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-final-status-')) throw new Error('Unsafe fixture cleanup');
  await fs.promises.rm(resolved, { recursive: true, force: true });
});

// A saved recording that was uploaded earlier: audio on disk, the upload
// receipt beside it, a history entry and a queue item that never left.
async function acceptedRecording({ receipt = true, status = 'pending_verification', retryCount = 304 } = {}) {
  const recordId = randomUUID(), recordPath = path.join(root, recordId), filePath = path.join(recordPath, 'audio.webm');
  await fs.promises.mkdir(recordPath);
  await fs.promises.writeFile(filePath, Buffer.alloc(2048, 7));
  await fs.promises.writeFile(path.join(recordPath, 'metadata.json'), JSON.stringify({ recordId, userId: OWNER, version: 1 }));
  const stats = fs.statSync(filePath);
  if (receipt) {
    await fs.promises.writeFile(path.join(recordPath, 'upload-receipt.json'), JSON.stringify({
      success: true, audioFileId: 'remote-1', verified: false, contentVerified: false, canDelete: false,
      ownerId: OWNER, filePath, fileSize: stats.size, fileMtimeMs: stats.mtimeMs }));
  }
  const entry = { id: recordId, userId: OWNER, createdAt: '2026-11-17T09:00:00.000Z', duration: 4, fileSize: stats.size, filePath,
    uploadStatus: status, storagePreference: 'keep', ...(receipt ? { audioFileId: 'remote-1' } : {}) };
  const queued = { recordId, filePath, metadata: { duration: '4' }, userId: OWNER, addedAt: '2026-11-17T09:00:10.000Z', retryCount };
  return { recordId, recordPath, filePath, entry, queued };
}

function mainProcess(history, queue) {
  const context = {
    fs, path, JSON, Date, Promise, Number, String, Object, Array, Math, Set, Map, Buffer, AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
    historyStore: memoryStore({ recordings: history }), uploadQueueStore: memoryStore({ pendingUploads: queue }),
    getRecordingsPath: () => root, getRecordingPath: id => path.join(root, id), getActiveRecording: () => null,
    inFlightUploads: new Set(), recordingLocks: new Map(), activeAbortControllers: new Map(), activeDirectAudioFileIds: new Map(),
    isProcessingUploads: false, unsavedRecordingId: null, isRecordingInProgress: false,
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    getAuthToken: vi.fn(async () => token(OWNER)), refreshMainAuthToken: vi.fn(async () => ({ success: false })),
    tokenUserId, canUploadForUser, verifiedUploadResult, writeFileAtomic,
    assessRecordingUpload: vi.fn(async () => ({ allowed: true })), updateRecordingPowerBlocker: () => {},
    API_BASE_URL: 'http://127.0.0.1:3000', axios: { get: vi.fn() },
    // The upload transports must stay unused: every case here has, or gets, its bytes accepted.
    tryDirectUpload: vi.fn(async () => ({ handled: false, reason: 'test' })),
    uploadWithRetryLegacy: vi.fn(async () => ({ success: false, canRetry: true, error: 'transport must not run' })),
  };
  const code = ['function recordingOwner(', 'function readUploadReceipt(', 'function saveUploadOutcome(',
    'async function verifyAcceptedUpload(', 'function addToUploadQueue(', 'function removeFromUploadQueue(',
    'function updateUploadQueueRetry(', 'async function processPendingUploads(', 'function sleep(',
    'async function pollServerStatus(', 'async function uploadWithRetry('].map(extract).join('\n\n');
  const api = vm.runInNewContext(`${code}\n({ processPendingUploads, pollServerStatus, uploadWithRetry });`, context);
  const completed = () => context.mainWindow.webContents.send.mock.calls.filter(([channel]) => channel === 'upload:complete').map(([, data]) => data);
  return { ...api, context, completed, statusRequests: () => context.axios.get.mock.calls.length,
    history: () => context.historyStore.get('recordings', []), queue: () => context.uploadQueueStore.get('pendingUploads', []) };
}
const receiptOf = recordPath => JSON.parse(fs.readFileSync(path.join(recordPath, 'upload-receipt.json'), 'utf8'));

describe('a final server status ends the upload re-check (ELECTRON-8P)', () => {
  it('the queued recording without speech is asked about once more, then parked with the server\'s reason', async () => {
    const recording = await acceptedRecording();
    const main = mainProcess([recording.entry], [recording.queued]);
    main.context.axios.get.mockResolvedValue(answer('FAILED', NO_SPEECH));

    await main.processPendingUploads();

    expect(main.statusRequests()).toBe(1);
    expect(main.context.axios.get.mock.calls[0][0]).toBe('http://127.0.0.1:3000/api/desktop/upload/remote-1/status');
    expect(main.queue()).toEqual([]);
    expect(main.history()[0]).toMatchObject({ id: recording.recordId, uploadStatus: 'failed', uploadTerminal: true,
      audioFileId: 'remote-1', uploadError: NO_SPEECH, uploadVerified: false, filePath: recording.filePath });
    expect(main.completed()).toEqual([{ recordId: recording.recordId, success: false, error: NO_SPEECH, terminal: true, background: true }]);
    // Nothing was sent again and nothing local was given up.
    expect(main.context.tryDirectUpload).not.toHaveBeenCalled();
    expect(main.context.uploadWithRetryLegacy).not.toHaveBeenCalled();
    expect(fs.readFileSync(recording.filePath).equals(Buffer.alloc(2048, 7))).toBe(true);
    expect(receiptOf(recording.recordPath)).toMatchObject({ audioFileId: 'remote-1', verified: false, canDelete: false });

    // The next five-minute tick has nothing left to ask.
    await main.processPendingUploads();
    await main.processPendingUploads();
    expect(main.statusRequests()).toBe(1);
    expect(main.completed()).toHaveLength(1);
  });

  it.each([
    ['FAILED', NO_SPEECH, NO_SPEECH],
    ['CANCELLED', undefined, 'Server reported status=CANCELLED'],
    ['failed', undefined, 'Server reported status=failed'],
  ])('status %s is final: one request, no waiting, the server\'s reason', async (status, errorMessage, expected) => {
    const main = mainProcess([], []);
    main.context.axios.get.mockResolvedValue(answer(status, errorMessage));
    expect(await main.pollServerStatus('remote-1', 15, OWNER)).toEqual({ persisted: false, verified: false, terminal: true, error: expected });
    expect(main.statusRequests()).toBe(1);
  });

  it('a fresh upload answered FAILED at once is a final result for the caller and leaves History consistent', async () => {
    const recording = await acceptedRecording({ receipt: false, status: 'uploading' });
    const main = mainProcess([recording.entry], [recording.queued]);
    main.context.tryDirectUpload.mockResolvedValue({ handled: true, result: { success: true, audioFileId: 'remote-1', transcriptionId: 'meeting-1' } });
    main.context.axios.get.mockResolvedValue(answer('FAILED', NO_SPEECH));

    const result = await main.uploadWithRetry(recording.recordId, recording.filePath, { duration: '4' });

    // upload:start drops a result with canRetry === false (and no 401) from the queue.
    expect(MAIN).toContain('if ((result.success || (result.canRetry === false && !authFailure)) && !abortedByQuit) {');
    expect(result).toMatchObject({ success: false, canRetry: false, pendingVerification: false, serverFinal: true,
      verified: false, canDelete: false, audioFileId: 'remote-1', error: NO_SPEECH });
    expect(result.status).toBeUndefined();
    expect(main.context.tryDirectUpload).toHaveBeenCalledTimes(1);
    expect(main.history()[0]).toMatchObject({ uploadStatus: 'failed', uploadTerminal: true, audioFileId: 'remote-1', transcriptionId: 'meeting-1', uploadError: NO_SPEECH });
    expect(receiptOf(recording.recordPath)).toMatchObject({ audioFileId: 'remote-1', ownerId: OWNER, verified: false, canDelete: false });
    expect(fs.existsSync(recording.filePath)).toBe(true);
  });

  it('the user\'s Retry after the server finished the recording turns it into an uploaded one', async () => {
    const recording = await acceptedRecording({ status: 'failed' });
    const main = mainProcess([{ ...recording.entry, uploadTerminal: true, uploadError: NO_SPEECH }], []);
    main.context.axios.get.mockResolvedValue(answer('COMPLETED'));

    expect(await main.uploadWithRetry(recording.recordId, recording.filePath, {})).toMatchObject({ success: true, verified: true, canDelete: false, pendingVerification: false });
    expect(main.history()[0]).toMatchObject({ uploadStatus: 'uploaded', audioFileId: 'remote-1', uploadError: null });
    expect(main.context.tryDirectUpload).not.toHaveBeenCalled();
  });

  it('an answer that is not final keeps the recording queued and pending, as before', async () => {
    const missing = await acceptedRecording(), slow = await acceptedRecording();
    const main = mainProcess([missing.entry, slow.entry], [missing.queued, slow.queued]);
    // First recording: the server does not know it (404). Second: still ingesting until the poll gives up.
    main.context.axios.get.mockRejectedValueOnce(notFound()).mockResolvedValue(answer('RECORDING'));

    await main.processPendingUploads();

    expect(main.queue().map(item => item.recordId)).toEqual([missing.recordId, slow.recordId]);
    expect(main.queue().map(item => item.retryCount)).toEqual([305, 305]);
    expect(main.history()).toEqual([
      expect.objectContaining({ id: missing.recordId, uploadStatus: 'pending_verification', uploadError: 'Server has not confirmed this recording (404)' }),
      expect.objectContaining({ id: slow.recordId, uploadStatus: 'pending_verification', uploadError: 'Server confirmation timeout' }),
    ]);
    expect(main.history().some(entry => entry.uploadTerminal)).toBe(false);
    expect(main.statusRequests()).toBe(1 + 15);
    expect(main.completed()).toEqual([]);
  });

  it('a recording the server is processing leaves the queue as uploaded, as before', async () => {
    const recording = await acceptedRecording();
    const main = mainProcess([recording.entry], [recording.queued]);
    main.context.axios.get.mockResolvedValue(answer('PROCESSING'));

    await main.processPendingUploads();

    expect(main.queue()).toEqual([]);
    expect(main.history()[0]).toMatchObject({ uploadStatus: 'uploaded', audioFileId: 'remote-1' });
    expect(main.completed()).toEqual([expect.objectContaining({ recordId: recording.recordId, success: true, background: true })]);
  });
});
