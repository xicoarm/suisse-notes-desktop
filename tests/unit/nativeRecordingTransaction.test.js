// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const native = require('../../src-electron/native-source-persistence');
const session = require('../../src-electron/native-recording-session');
const { createRecordingPersistence, readFinalizedRecording } = require('../../src-electron/recording-persistence');
const { assessRecordingUpload } = require('../../src-electron/recording-upload-eligibility');
const { concatenateFiles } = require('../../src-electron/durable-files');
const { getRecordingSourceBytes } = require('../../src-electron/disk-utils');
const pcm = require('../../src-electron/pcm-capture-evidence');

let recordingsRoot, recordPath, recordId, sourceId, nativeBuild, persistence;
beforeEach(async () => {
  recordingsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-native-transaction-'));
  recordId = randomUUID();
  recordPath = path.join(recordingsRoot, recordId);
  await fs.promises.mkdir(recordPath);
  await session.markNativeCaptureSession(recordPath);
  sourceId = randomUUID();
  await native.beginSource(recordPath, { sourceId, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm;codecs=opus', settings: {} });
  await native.markSourceStarted(recordPath, sourceId, { startOffsetMs: 0 });
  await native.saveSourceChunk(recordPath, sourceId, Buffer.from('native preserved content'), 0);
  await native.endSource(recordPath, sourceId, { endOffsetMs: 2000, chunkCount: 1, reason: 'stop' });
  await fs.promises.mkdir(path.join(recordPath, 'chunks'));
  await fs.promises.writeFile(path.join(recordPath, 'chunks/chunk_0.webm'), 'deficient live mix');
  nativeBuild = vi.fn(async (directory, outputPath, options) => {
    const sources = native.inspectNativeSources(directory);
    await concatenateFiles(sources.flatMap(source => source.chunkPaths), outputPath);
    return { success: true, outputPath, duration: 2, sourceIds: sources.map(source => source.sourceId),
      systemPcmIncluded: false, warnings: options.recovery ? ['native-source-interrupted'] : [] };
  });
  persistence = createRecordingPersistence({ nativeBuild,
    validate: file => ({ valid: fs.statSync(file).size > 0 }), probe: async () => 2,
    prepareRaw: () => { throw new Error('Live mix must never be used for native finalization'); },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (path.dirname(path.resolve(recordingsRoot)) !== path.resolve(os.tmpdir()) || !path.basename(recordingsRoot).startsWith('suisse-native-transaction-')) throw new Error('Invalid fixture cleanup');
  await fs.promises.rm(recordingsRoot, { recursive: true, force: true });
});
const eligibility = () => assessRecordingUpload({ recordId, recordingsRoot, filePath: path.join(recordPath, 'audio.webm') });

describe('native recording publication and upload transaction', () => {
  it('publishes native output, retains live mix and sources, and uploads only after the source-bound receipt', async () => {
    expect(await eligibility()).toMatchObject({ allowed: false });
    const result = await persistence.finalize(recordPath);
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe('native preserved content');
    expect(fs.readFileSync(path.join(recordPath, 'chunks/chunk_0.webm'), 'utf8')).toBe('deficient live mix');
    expect(native.inspectNativeSources(recordPath)[0].chunkCount).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(recordPath, 'finalized.json')))).toMatchObject({ version: 3, sourceMode: 'native', sourceIds: [sourceId] });
    expect(await eligibility()).toMatchObject({ allowed: true });
  });

  it('never falls back to the live mix when native finalization is unavailable or fails', async () => {
    await expect(createRecordingPersistence({}).finalize(recordPath)).rejects.toThrow('unavailable');
    nativeBuild.mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(persistence.finalize(recordPath)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await readFinalizedRecording(recordPath)).toBeNull();
    expect(native.inspectNativeSources(recordPath)[0].hasAudio).toBe(true);
    expect(await eligibility()).toMatchObject({ allowed: false });
    await persistence.finalize(recordPath);
    expect(await eligibility()).toMatchObject({ allowed: true });
  });

  it('fails closed for a native marker even before a source reservation exists', async () => {
    // Simulate startup before any recorder/source has been reserved.
    const emptyId = randomUUID();
    const emptyPath = path.join(recordingsRoot, emptyId);
    await fs.promises.mkdir(emptyPath);
    await session.markNativeCaptureSession(emptyPath);
    await fs.promises.writeFile(path.join(emptyPath, 'audio.webm'), 'legacy-looking file');
    await expect(createRecordingPersistence({}).finalize(emptyPath)).rejects.toThrow('Native audio');
    expect(await assessRecordingUpload({ recordId: emptyId, recordingsRoot, filePath: path.join(emptyPath, 'audio.webm') })).toMatchObject({ allowed: false });
  });

  it('invalidates native receipts after same-size source or published-output corruption', async () => {
    await persistence.finalize(recordPath);
    const file = native.inspectNativeSources(recordPath)[0].chunkPaths[0];
    const original = fs.readFileSync(file);
    await fs.promises.writeFile(file, Buffer.alloc(original.length, 120));
    expect(await eligibility()).toMatchObject({ allowed: false });
    await fs.promises.writeFile(file, original);
    await persistence.finalize(recordPath);
    const output = path.join(recordPath, 'audio.webm');
    await fs.promises.writeFile(output, Buffer.alloc(fs.statSync(output).size, 121));
    expect(await eligibility()).toMatchObject({ allowed: false });
  });

  it('keeps an earlier playable output when native sources change during finalization', async () => {
    await persistence.finalize(recordPath);
    const old = fs.readFileSync(path.join(recordPath, 'audio.webm'));
    const build = nativeBuild.getMockImplementation();
    nativeBuild.mockImplementationOnce(async (...args) => {
      const result = await build(...args);
      await native.beginSource(recordPath, { sourceId: randomUUID(), kind: 'system', startOffsetMs: 500, mimeType: 'audio/webm', settings: {} });
      return result;
    });
    await expect(persistence.finalize(recordPath)).rejects.toThrow('changed during finalization');
    expect(fs.readFileSync(path.join(recordPath, 'audio.webm'))).toEqual(old);
    expect(await eligibility()).toMatchObject({ allowed: false });
  });

  it('passes explicit recovery through and persists recovery warnings across restarts', async () => {
    await persistence.finalize(recordPath, '.webm', { recovery: true, expectedDurationSec: 2 });
    expect(nativeBuild.mock.calls[0][2]).toEqual({ recovery: true, expectedDurationSec: 2 });
    expect(await readFinalizedRecording(recordPath)).toMatchObject({ warnings: ['native-source-interrupted'] });
    expect(JSON.parse(fs.readFileSync(path.join(recordPath, 'finalized.json'))).recovered).toBe(true);
  });

  it('refuses publication when a builder omits a saved source or separate system PCM', async () => {
    const build = nativeBuild.getMockImplementation();
    nativeBuild.mockImplementationOnce(async (...args) => ({ ...await build(...args), sourceIds: [] }));
    await expect(persistence.finalize(recordPath)).rejects.toThrow('every saved audio source');
    await fs.promises.writeFile(path.join(recordPath, 'system_audio.raw'), Buffer.alloc(96000));
    await expect(persistence.finalize(recordPath)).rejects.toThrow('system PCM');
    expect(await eligibility()).toMatchObject({ allowed: false });
  });

  it('blocks a matching complete native receipt while another finalization is pending', async () => {
    await persistence.finalize(recordPath);
    await fs.promises.writeFile(path.join(recordPath, 'finalization-pending.json'), '{}');
    expect(await eligibility()).toMatchObject({ allowed: false });
  });

  it('requires explicit recovery for an interrupted required PCM capture, preserving warnings and originals', async () => {
    const attemptId = randomUUID();
    await pcm.beginPcmAttempt(recordPath, { attemptId, required: true, requestOffsetMs: 0, requestedAt: new Date().toISOString() });
    // Simulate helper failure before its first PCM reached disk. The native mic
    // remains recoverable, but normal finalization cannot call the capture whole.
    await expect(persistence.finalize(recordPath)).rejects.toMatchObject({ code: 'PCM_CAPTURE_RECOVERY_REQUIRED' });
    expect(nativeBuild).not.toHaveBeenCalled();
    const result = await persistence.finalize(recordPath, '.webm', { recovery: true });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'system-audio-required-pcm-missing' })]));
    expect(await eligibility()).toMatchObject({ allowed: true });
    expect(native.inspectNativeSources(recordPath)[0].hasAudio).toBe(true);
    // A new event changes source provenance and invalidates the prior receipt.
    await pcm.markPcmEvent(recordPath, attemptId, { event: 'spawned', elapsedMs: 0, activeOffsetMs: 0 });
    expect(await eligibility()).toMatchObject({ allowed: false });
  });

  it('rejects an older receipt relabeled over independent native audio', async () => {
    await persistence.finalize(recordPath);
    const file = path.join(recordPath, 'finalized.json');
    const receipt = JSON.parse(fs.readFileSync(file));
    await fs.promises.writeFile(file, JSON.stringify({ ...receipt, version: 2, sourceMode: 'microphone' }));
    expect(await eligibility()).toMatchObject({ allowed: false });
  });

  it('counts retained native bytes in finalization storage estimates', () => {
    expect(getRecordingSourceBytes(recordPath)).toBeGreaterThan(Buffer.byteLength('native preserved contentdeficient live mix'));
  });

  it('rejects malformed authority markers even with valid media and an earlier receipt', async () => {
    await persistence.finalize(recordPath);
    await fs.promises.writeFile(path.join(recordPath, 'native-capture.json'), '{');
    expect(await eligibility()).toMatchObject({ allowed: false });
    await expect(persistence.finalize(recordPath)).rejects.toThrow();
  });
});

describe('real main-process native IPC registrations', () => {
  function handlers() {
    const source = fs.readFileSync(path.resolve('src-electron/electron-main.js'), 'utf8');
    const block = source.slice(source.indexOf("for (const operation of ['beginSource'"), source.indexOf('// 2. Save recording chunk'));
    const registered = new Map(), uploads = new Set();
    let chain = Promise.resolve();
    vm.runInNewContext(block, {
      ipcMain: { handle: (name, fn) => registered.set(name, fn) }, nativeSourcePersistence: native,
      readNativeCaptureMarker: session.readNativeCaptureMarker, inFlightUploads: uploads,
      validateRecordId: id => { if (id !== recordId) throw new Error('Invalid recording'); return id; },
      getRecordingPath: () => recordPath,
      withRecordingLock: (id, fn) => { const next = chain.catch(() => {}).then(fn); chain = next; return next; },
    });
    return { registered, uploads };
  }

  it('serializes durable source operations and accepts exact lost-reply retries', async () => {
    const { registered } = handlers();
    const call = (name, ...args) => registered.get(`recording:${name}`)(null, recordId, ...args);
    const id = randomUUID();
    expect(await call('beginSource', { sourceId: id, kind: 'system', startOffsetMs: 0, mimeType: 'audio/webm', settings: {} })).toMatchObject({ success: true });
    expect(await call('markSourceStarted', id, { startOffsetMs: 1 })).toMatchObject({ success: true });
    expect(await Promise.all([call('saveSourceChunk', id, Buffer.from('one'), 0), call('saveSourceChunk', id, Buffer.from('two'), 1)])).toEqual(expect.arrayContaining([expect.objectContaining({ success: true })]));
    expect(await call('saveSourceChunk', id, Buffer.from('two'), 1)).toMatchObject({ success: true, duplicate: true });
    expect(await call('endSource', id, { chunkCount: 2, endOffsetMs: 2000, reason: 'stop' })).toMatchObject({ success: true });
    expect(native.inspectNativeSources(recordPath).find(source => source.sourceId === id).chunkCount).toBe(2);
  });

  it('refuses writes during upload or after the session marker disappears', async () => {
    const { registered, uploads } = handlers();
    const save = () => registered.get('recording:saveSourceChunk')(null, recordId, sourceId, Buffer.from('native preserved content'), 0);
    uploads.add(recordId);
    expect(await save()).toMatchObject({ success: false, error: 'This recording is still uploading' });
    uploads.clear();
    await fs.promises.unlink(path.join(recordPath, 'native-capture.json'));
    expect(await save()).toMatchObject({ success: false, code: 'ENOENT' });
  });
});
