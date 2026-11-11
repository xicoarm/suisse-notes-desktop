// @vitest-environment node
// ELECTRON-7R end to end in the main process: a recording whose saving failed
// (resampler failure, history 'failed' without a file, originals retained) is
// finalized by startup recovery or by History "Restore and upload" and queued
// for upload into its OWNER's account only. The real recovery, adoption,
// restore, finalization, queue and owner-gate functions of electron-main.js run
// with narrow stand-ins; uploadWithRetry (the network) is a spy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ffmpeg = require('fluent-ffmpeg');
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path;
const FFPROBE = require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfmpegPath(FFMPEG);
ffmpeg.setFfprobePath(FFPROBE);
const native = require('../../src-electron/native-source-persistence');
const session = require('../../src-electron/native-recording-session');
const { createRecordingPersistence, readFinalizedRecording, listSessions } = require('../../src-electron/recording-persistence');
const { createNativeSourceFinalization } = require('../../src-electron/native-source-finalization');
const { validateNativeMedia } = require('../../src-electron/native-media-validation');
const { assessRecordingUpload, FINALIZATION_PENDING_MARKER } = require('../../src-electron/recording-upload-eligibility');
const { writeFileAtomic, syncDirectorySync, listChunkBatches } = require('../../src-electron/durable-files');
const { withCaptureWarnings } = require('../../src-electron/recording-history-warnings');
const { repairRecoveredHistoryRecord } = require('../../src-electron/recording-export');
const { tokenUserId, canUploadForUser } = require('../../src-electron/upload-safety');

const OWNER = 'owner-account-1';
const OTHER = 'other-account-2';
const LONG_GAP_SECONDS = 300;
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
function line(prefix) {
  const start = MAIN.indexOf(`\n${prefix}`);
  if (start < 0) throw new Error(`Missing ${prefix}`);
  return MAIN.slice(start + 1, MAIN.indexOf(';\n', start) + 1);
}
function memoryStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return { get: (key, fallback) => (key in data ? JSON.parse(JSON.stringify(data[key])) : fallback), set: (key, value) => { data[key] = JSON.parse(JSON.stringify(value)); } };
}
const token = userId => `h.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.s`;
function runCommand(command, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('Media timeout')); }, Math.min(timeout, 120000));
    command.on('error', error => { clearTimeout(timer); reject(error); }).on('end', () => { clearTimeout(timer); resolve(); }).run();
  });
}
const probe = file => new Promise((resolve, reject) => ffmpeg.ffprobe(file, (error, data) => error ? reject(error) : resolve(data)));

let root;
beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-stranded-main-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-stranded-main-')) throw new Error('Unsafe fixture cleanup');
  await fs.promises.rm(resolved, { recursive: true, force: true });
});

function mainProcess(history = [], { signedIn = OWNER } = {}) {
  const context = {
    fs, path, JSON, Date, Promise, Number, String, Object, Array, Math, Set, Map, Buffer, parseFloat, clearTimeout, console,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
    historyStore: memoryStore({ recordings: history }), uploadQueueStore: memoryStore(), activeRecordingStore: memoryStore(),
    getRecordingsPath: () => root, getRecordingPath: id => path.join(root, id),
    getActiveRecording: () => null, clearActiveRecording: () => {},
    inFlightUploads: new Set(), recordingLocks: new Map(), withRecordingLock: (id, fn) => fn(),
    isRecoveryRunning: false, isProcessingUploads: false, unsavedRecordingId: null, isRecordingInProgress: false,
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    // Identity: only the main-side token says who is signed in.
    getAuthToken: vi.fn(async () => (signedIn ? token(signedIn) : null)), tokenUserId, canUploadForUser,
    uploadWithRetry: vi.fn(async () => ({ success: true, audioFileId: 'remote-1', transcriptionId: 't-1' })),
    readUploadReceipt: () => null, updateRecordingPowerBlocker: () => {}, saveUploadOutcome: vi.fn(),
    FINALIZATION_PENDING_MARKER, readFinalizedRecording, listSessions, listChunkBatches, usesNativeSources: session.usesNativeSources,
    assessRecordingUpload, withCaptureWarnings, repairRecoveredHistoryRecord, writeFileAtomic, syncDirectorySync,
    validateAudioOutput: file => { const size = fs.statSync(file).size; return { valid: size > 0, size }; },
    getAudioMetadata: probe, safeParseDuration: metadata => Number(metadata?.format?.duration) || 0,
    // finalizeRecording's production dependencies, with the real native builder.
    canFinalizeRecording: async () => ({ canFinalize: true }), activeAudioTee: null,
    createRecordingPersistence, createNativeSourceFinalization, validateNativeMedia, ffmpeg,
    ffmpegWithTimeout: (command, timeout) => runCommand(command, timeout), FFMPEG_TIMEOUT_MS: 120000,
    resolveBundledBinaryPaths: () => ({ ffmpeg: FFMPEG, ffprobe: FFPROBE }), getAvailableSpaceDetailed: async () => ({ fallback: true }),
    recordCaptureWarning: vi.fn(), updateRecordingMetadataOnCompletion: vi.fn(), checkForTruncation: vi.fn(),
    ipcMain: { handle: () => {} }, validateRecordId: id => id,
  };
  const code = [line('const RECOVERY_TERMINAL_STATUSES'), ...['function recordingOwner(', 'function addToUploadQueue(',
    'function removeFromUploadQueue(', 'function updateUploadQueueRetry(', 'async function processPendingUploads(',
    'function adoptRecoveredRecording(', 'function markRecoveryFailed(', 'function hasRetainedSourceAudio(',
    'function heldUploadReason(', 'async function restoreRetainedRecording(', 'async function recoverOrphanedRecordings(',
    'async function combineChunksForRecovery(', 'async function finalizeRecording('].map(extract)].join('\n\n');
  const api = vm.runInNewContext(`${code}\n({ recoverOrphanedRecordings, restoreRetainedRecording, processPendingUploads });`, context);
  const sent = kind => context.mainWindow.webContents.send.mock.calls.filter(([channel, data]) => channel === 'system:capture-warning' && data.kind === kind).map(([, data]) => data);
  // Startup recovery starts the queue without awaiting it; wait until it is idle.
  const settle = () => vi.waitFor(() => { if (context.isProcessingUploads) throw new Error('queue busy'); }, { timeout: 10000 });
  return { ...api, context, sent, settle, history: () => context.historyStore.get('recordings', []), queue: () => context.uploadQueueStore.get('pendingUploads', []) };
}

// The folder an affected customer has: native capture, metadata with the
// owner, a microphone source with a clock gap (five minutes reproduces the
// resampler failure), the pending marker of the failed attempt.
async function strandedRecording({ bytes, gapSeconds = LONG_GAP_SECONDS, owner = OWNER } = {}) {
  const recordId = randomUUID(), recordPath = path.join(root, recordId);
  await fs.promises.mkdir(recordPath);
  await session.markNativeCaptureSession(recordPath);
  await fs.promises.writeFile(path.join(recordPath, 'metadata.json'), JSON.stringify({ recordId, ...(owner ? { userId: owner } : {}), startedAt: '2026-11-11T11:25:00.000Z', version: 1 }));
  if (!bytes) {
    const webm = path.join(root, `${recordId}.webm`);
    await runCommand(ffmpeg().input('sine=f=440:d=1:r=48000').inputFormat('lavfi').input('sine=f=880:d=1:r=48000').inputFormat('lavfi')
      .complexFilter(`[0][1]concat=n=2:v=0:a=1,asetpts='if(gte(T,1),PTS+${gapSeconds}/TB,PTS)'`).audioCodec('libopus').output(webm));
    bytes = fs.readFileSync(webm);
  }
  const sourceId = randomUUID(), cut = Math.floor(bytes.length / 2);
  await native.beginSource(recordPath, { sourceId, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm;codecs=opus', settings: { channelCount: 1 } });
  await native.markSourceStarted(recordPath, sourceId, { startOffsetMs: 0 });
  await native.saveSourceChunk(recordPath, sourceId, bytes.subarray(0, cut), 0);
  await native.saveSourceChunk(recordPath, sourceId, bytes.subarray(cut), 1);
  await native.endSource(recordPath, sourceId, { endOffsetMs: (gapSeconds + 2) * 1000, chunkCount: 2, reason: 'stopped' });
  await fs.promises.writeFile(path.join(recordPath, FINALIZATION_PENDING_MARKER), JSON.stringify({ version: 1, startedAt: '2026-11-11T12:31:00.000Z' }));
  const entry = { id: recordId, userId: owner || 'unknown', createdAt: '2026-11-11T11:25:00.000Z', duration: 3960, fileSize: 0, filePath: '',
    uploadStatus: 'failed', storagePreference: 'keep',
    uploadError: `Native source ${sourceId} timestamp compensation failed; original native audio is retained` };
  return { recordId, recordPath, sourceId, bytes, entry };
}
const originals = recordPath => native.inspectNativeSources(recordPath).map(source => Buffer.concat(source.chunkPaths.map(file => fs.readFileSync(file))));

describe('stranded recording recovery in the main process (ELECTRON-7R)', () => {
  it('startup recovery finalizes it with the fixed code and uploads it into the owner\'s account', async () => {
    const stranded = await strandedRecording();
    const main = mainProcess([stranded.entry]);
    await main.recoverOrphanedRecordings();
    await main.settle();
    const filePath = path.join(stranded.recordPath, 'audio.webm');
    expect(main.context.uploadWithRetry).toHaveBeenCalledTimes(1);
    expect(main.context.uploadWithRetry).toHaveBeenCalledWith(stranded.recordId, filePath, expect.anything(), 2);
    expect(main.history()[0]).toMatchObject({ id: stranded.recordId, userId: OWNER, uploadStatus: 'uploaded', audioFileId: 'remote-1', filePath, recovered: true });
    expect(main.queue()).toEqual([]);
    expect(main.context.mainWindow.webContents.send).toHaveBeenCalledWith('recording:recovered', expect.objectContaining({ count: 1 }));
    expect(main.sent('recovered-upload-held')).toEqual([]);
    expect(fs.existsSync(path.join(stranded.recordPath, FINALIZATION_PENDING_MARKER))).toBe(false);
    const receipt = JSON.parse(fs.readFileSync(path.join(stranded.recordPath, 'finalized.json'), 'utf8'));
    expect(receipt.warnings).toContainEqual(expect.objectContaining({ kind: 'native-source-timestamp-resample-fallback', timeline: 'sample-order-restored-gaps' }));
    expect(Math.abs(Number((await probe(filePath)).format.duration) - (LONG_GAP_SECONDS + 2))).toBeLessThan(0.1);
    expect(originals(stranded.recordPath)[0].equals(stranded.bytes)).toBe(true);
  }, 180000);

  it('"Restore and upload" rebuilds it from the retained originals and uploads it into the owner\'s account', async () => {
    const stranded = await strandedRecording();
    const main = mainProcess([stranded.entry]);
    main.context.isRecoveryRunning = true;
    expect(await main.restoreRetainedRecording(stranded.recordId)).toMatchObject({ success: false, code: 'BUSY' });
    main.context.isRecoveryRunning = false;
    const result = await main.restoreRetainedRecording(stranded.recordId);
    expect(result).toMatchObject({ success: true, queued: true, filePath: path.join(stranded.recordPath, 'audio.webm') });
    await main.settle();
    expect(main.context.uploadWithRetry).toHaveBeenCalledTimes(1);
    expect(main.context.uploadWithRetry).toHaveBeenCalledWith(stranded.recordId, result.filePath, expect.anything(), 2);
    expect(main.history()[0]).toMatchObject({ uploadStatus: 'uploaded', filePath: result.filePath, uploadError: null });
    expect(originals(stranded.recordPath)[0].equals(stranded.bytes)).toBe(true);
  }, 180000);

  it('keeps the originals, the failed status and the reason when restoring fails, and marks a failed startup', async () => {
    const stranded = await strandedRecording({ bytes: Buffer.from('not-a-recording-but-preserved-source-bytes') });
    const main = mainProcess([{ ...stranded.entry, uploadStatus: 'recording', uploadError: undefined }]);
    await main.recoverOrphanedRecordings();
    expect(main.history()[0]).toMatchObject({ uploadStatus: 'failed', filePath: null });
    expect(main.history()[0].uploadError).toBeTruthy();
    expect(main.sent('recovery-failed')).toEqual([{ kind: 'recovery-failed', recordId: stranded.recordId }]);
    const result = await main.restoreRetainedRecording(stranded.recordId);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(main.history()[0]).toMatchObject({ uploadStatus: 'failed', filePath: null, uploadError: result.error.slice(0, 500) });
    expect(main.queue()).toEqual([]);
    expect(main.context.uploadWithRetry).not.toHaveBeenCalled();
    expect(originals(stranded.recordPath)[0].equals(stranded.bytes)).toBe(true);
    expect(fs.existsSync(path.join(stranded.recordPath, FINALIZATION_PENDING_MARKER))).toBe(true);
  }, 120000);

  it('offers nothing to restore without retained originals and never touches a finished recording', async () => {
    const recordId = randomUUID();
    await fs.promises.mkdir(path.join(root, recordId));
    const main = mainProcess([{ id: recordId, userId: OWNER, uploadStatus: 'failed', filePath: '' }]);
    expect(await main.restoreRetainedRecording(recordId)).toMatchObject({ success: false, code: 'NO_RETAINED_AUDIO' });
    const stranded = await strandedRecording({ bytes: Buffer.from('preserved') });
    const done = mainProcess([{ ...stranded.entry, uploadStatus: 'uploaded', audioFileId: 'remote' }]);
    await done.recoverOrphanedRecordings();
    expect(done.history()[0]).toMatchObject({ uploadStatus: 'uploaded', audioFileId: 'remote' });
  }, 60000);
});

// Areg, 12.11.2026: a restored recording can never land in another account.
// The owner comes from history / metadata.json, never from who is signed in.
describe('a recovered recording uploads only into its owner\'s account', () => {
  const cases = [
    { name: 'the owner is signed in', signedIn: OWNER, owner: OWNER, uploads: true, code: null, held: null },
    { name: 'another account is signed in', signedIn: OTHER, owner: OWNER, uploads: false, code: 'NOT_OWNER', held: 'other-account' },
    { name: 'nobody is signed in', signedIn: null, owner: OWNER, uploads: false, code: 'SIGNED_OUT', held: null },
    { name: 'the owner is unknown', signedIn: OWNER, owner: null, uploads: false, code: 'OWNER_UNKNOWN', held: 'owner-unknown' },
  ];

  it.each(cases)('startup recovery when $name', async ({ signedIn, owner, uploads, held }) => {
    const stranded = await strandedRecording({ gapSeconds: 1, owner });
    // An unknown owner has no metadata userId and no history entry to name one.
    const main = mainProcess(owner ? [stranded.entry] : [], { signedIn });
    await main.recoverOrphanedRecordings();
    await main.settle();
    await main.processPendingUploads(); // a later run of the queue changes nothing
    const filePath = path.join(stranded.recordPath, 'audio.webm');
    expect(fs.existsSync(filePath)).toBe(true); // rebuilt locally in every case
    expect(main.history()[0]).toMatchObject({ id: stranded.recordId, userId: owner || 'unknown', filePath });
    if (uploads) {
      expect(main.context.uploadWithRetry.mock.calls.map(call => call[0])).toEqual([stranded.recordId]);
      expect(main.history()[0].uploadStatus).toBe('uploaded');
    } else {
      expect(main.context.uploadWithRetry).not.toHaveBeenCalled();
      expect(main.history()[0].uploadStatus).toBe('pending');
      // Held in the queue under the owner from metadata, never the signed-in account.
      expect(main.queue()).toEqual([expect.objectContaining({ recordId: stranded.recordId, userId: owner || 'unknown' })]);
    }
    expect(main.sent('recovered-upload-held')).toEqual(held ? [{ kind: 'recovered-upload-held', reason: held }] : []);
  }, 120000);

  it.each(cases)('"Restore and upload" when $name', async ({ signedIn, owner, uploads, code }) => {
    const stranded = await strandedRecording({ gapSeconds: 1, owner });
    const main = mainProcess([stranded.entry], { signedIn });
    const result = await main.restoreRetainedRecording(stranded.recordId);
    await main.settle();
    const filePath = path.join(stranded.recordPath, 'audio.webm');
    if (uploads) {
      expect(result).toMatchObject({ success: true, queued: true, filePath });
      expect(main.context.uploadWithRetry.mock.calls.map(call => call[0])).toEqual([stranded.recordId]);
    } else {
      // Refused before anything is built, queued or sent.
      expect(result).toMatchObject({ success: false, code });
      expect(fs.existsSync(filePath)).toBe(false);
      expect(main.queue()).toEqual([]);
      expect(main.context.uploadWithRetry).not.toHaveBeenCalled();
      expect(main.history()[0]).toMatchObject({ uploadStatus: 'failed', userId: owner || 'unknown' });
    }
    expect(originals(stranded.recordPath)[0].equals(stranded.bytes)).toBe(true);
  }, 120000);
});
