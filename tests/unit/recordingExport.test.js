// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRecordingExporter, repairRecoveredHistoryRecord, assertExportRecoveryReady, hasRetainedSources } = require('../../src-electron/recording-export');
const { createRecordingPersistence, readFinalizedRecording } = require('../../src-electron/recording-persistence');
const { archiveChunkBatch, concatenateFiles } = require('../../src-electron/durable-files');
const { beginSource, markSourceStarted, saveSourceChunk } = require('../../src-electron/native-source-persistence');

const id = 'f7fdd94a-7401-436d-802c-6664ffcfecac';
let temporary, root, directory, source, destination, row, owner, busy, locked, held, exporter, finalize, saveAs, persistence;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'suisse-export-unit-'));
  root = path.join(temporary, 'recordings'); directory = path.join(root, id);
  source = path.join(directory, 'audio.webm'); destination = path.join(temporary, 'export.webm');
  fs.mkdirSync(directory, { recursive: true });
  row = { id, userId: 'owner', filePath: source, fileSize: 999, uploadStatus: 'cancelled', storagePreference: 'keep' };
  owner = 'owner'; busy = false; locked = false; held = false;
  // Use the real disk transaction and checksum receipt. These opaque bytes
  // test export/custody, not codec validity; no media process is launched.
  persistence = createRecordingPersistence({ prepareRaw: async () => ({}), remux: (input, output) => fs.promises.copyFile(input, output),
    concatSessions: concatenateFiles, validate: file => ({ valid: fs.statSync(file).size > 0 }), probe: async () => 1 });
  finalize = vi.fn(async () => { expect(held).toBe(true); return persistence.finalize(directory); });
  saveAs = vi.fn(async input => { await fs.promises.copyFile(input, destination); return { success: true, savedPath: destination }; });
  exporter = createRecordingExporter({ recordingsPath: () => root,
    validateRecordId: value => { if (value !== id) throw new Error('invalid ID'); return value; },
    getOwner: () => row?.userId, getCurrentUserId: async () => owner,
    isBusy: () => busy, isLocked: () => locked,
    withRecordingLock: async (_id, fn) => { held = true; try { return await fn(); } finally { held = false; } },
    finalize, saveAs, repairHistory: (_id, current, result) => {
      expect(held).toBe(true);
      if (!row || row.userId !== current) return null;
      row = repairRecoveredHistoryRecord(row, result); return row;
    } });
});
afterEach(() => {
  vi.restoreAllMocks();
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-export-unit-')) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(resolved, { recursive: true, force: true });
});
function chunk(number, bytes) {
  fs.mkdirSync(path.join(directory, 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'chunks', `chunk_${number}.webm`), bytes);
}

describe('desktop missing-file export recovery', () => {
  it('keeps existing-file Save As behavior without rebuilding or requiring a network session', async () => {
    fs.writeFileSync(source, 'already saved'); owner = null;
    expect(await exporter(source, 'meeting.webm')).toEqual({ success: true, savedPath: destination });
    expect(fs.readFileSync(destination, 'utf8')).toBe('already saved');
    expect(finalize).not.toHaveBeenCalled();
  });

  it('recovers every retained batch, verifies its receipt and copies the exact bytes under the lock', async () => {
    chunk(0, 'first'); await archiveChunkBatch(directory); chunk(1, 'second');
    saveAs.mockImplementationOnce(async input => {
      expect(held).toBe(true); await fs.promises.copyFile(input, destination);
      return { success: true, savedPath: destination };
    });
    expect(await exporter(source)).toMatchObject({ success: true, recovered: true, captureWarnings: [] });
    expect(fs.readFileSync(destination, 'utf8')).toBe('firstsecond');
    expect(await readFinalizedRecording(directory)).toMatchObject({ fileSize: 11 });
    expect(row).toMatchObject({ filePath: source, fileSize: 11, uploadStatus: 'cancelled', storagePreference: 'keep' });
    expect(fs.readdirSync(path.join(directory, 'source-chunks'))).toHaveLength(2);
  });

  it('recovers native source bytes through the real native receipt transaction and returns its interruption warning', async () => {
    await beginSource(directory, { sourceId: id, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm' });
    expect(hasRetainedSources(directory)).toBe(false); // reservation alone cannot trigger recovery
    await markSourceStarted(directory, id, { startOffsetMs: 0 });
    await saveSourceChunk(directory, id, Buffer.from('native-original'), 0);
    const chunkPath = path.join(directory, 'native-sources', id, 'chunks', 'chunk_0.webm');
    const nativePersistence = createRecordingPersistence({ validate: file => ({ valid: fs.statSync(file).size > 0 }),
      nativeBuild: async (_directory, outputPath) => {
        await fs.promises.copyFile(chunkPath, outputPath);
        return { success: true, outputPath, sourceIds: [id], duration: 1, systemPcmIncluded: false,
          warnings: [{ kind: 'native-source-interrupted' }] };
      } });
    finalize.mockImplementationOnce(() => nativePersistence.finalize(directory, '.webm', { recovery: true }));
    expect(await exporter(source)).toMatchObject({ success: true, recovered: true, captureWarnings: ['native-source-interrupted'] });
    expect(fs.readFileSync(destination, 'utf8')).toBe('native-original');
    expect(fs.readFileSync(chunkPath, 'utf8')).toBe('native-original');
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'finalized.json'), 'utf8'))).toMatchObject({ version: 3, sourceIds: [id] });
  });

  it('fails before finalization when native metadata is malformed, retaining its audio', async () => {
    const native = path.join(directory, 'native-sources', id);
    fs.mkdirSync(path.join(native, 'chunks'), { recursive: true });
    fs.writeFileSync(path.join(native, 'chunks', 'chunk_0.webm'), 'retain');
    fs.writeFileSync(path.join(native, 'manifest.json'), '{}');
    expect(await exporter(source)).toMatchObject({ error: 'NATIVE_SOURCE_INVALID' });
    expect(finalize).not.toHaveBeenCalled(); expect(saveAs).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(native, 'chunks', 'chunk_0.webm'), 'utf8')).toBe('retain');
  });

  it('refuses a corrupt checksum receipt even when finalization returns success', async () => {
    chunk(0, 'retained');
    finalize.mockImplementationOnce(async () => {
      const result = await persistence.finalize(directory);
      const receiptPath = path.join(directory, 'finalized.json');
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      receipt.sha256 = '0'.repeat(64); fs.writeFileSync(receiptPath, JSON.stringify(receipt));
      return result;
    });
    expect(await exporter(source)).toMatchObject({ error: 'recovery_failed' });
    expect(saveAs).not.toHaveBeenCalled(); expect(fs.readFileSync(source, 'utf8')).toBe('retained');
  });

  it.each(['missing directory', 'marker only', 'empty chunk'])('returns source_missing without calling finalization or creating markers for %s', async kind => {
    if (kind === 'missing directory') fs.rmdirSync(directory);
    if (kind === 'marker only') fs.writeFileSync(path.join(directory, 'native-capture.json'), '{"version":1,"captureMode":"native-sources-v1"}');
    if (kind === 'empty chunk') chunk(0, '');
    const result = await exporter(source);
    expect(result).toMatchObject({ success: false, error: 'source_missing' });
    expect(finalize).not.toHaveBeenCalled(); expect(saveAs).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, 'finalization-pending.json'))).toBe(false);
    if (kind === 'missing directory') expect(fs.existsSync(directory)).toBe(false);
  });

  it.each(['other owner', 'signed out', 'unknown owner', 'missing history'])('rejects recovery for %s before mutating sources', async kind => {
    chunk(0, 'retained');
    if (kind === 'other owner') owner = 'someone-else';
    if (kind === 'signed out') owner = null;
    if (kind === 'unknown owner') row.userId = 'unknown';
    if (kind === 'missing history') row = null;
    expect(await exporter(source)).toMatchObject({ error: 'recording_owner_required' });
    expect(finalize).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(directory, 'chunks', 'chunk_0.webm'), 'utf8')).toBe('retained');
  });

  it.each(['capture', 'lock'])('does not run finalization while %s is active', async kind => {
    chunk(0, 'retained'); if (kind === 'capture') busy = true; else locked = true;
    expect(await exporter(source)).toMatchObject({ error: 'recording_busy' });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('rechecks live state after awaited owner resolution inside the lock', async () => {
    chunk(0, 'retained');
    const sourceOwner = row.userId;
    Object.defineProperty(row, 'userId', { get() { if (held) busy = true; return sourceOwner; } });
    expect(await exporter(source)).toMatchObject({ error: 'recording_busy' });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('rejects a changed account after finalization and retains the verified output and originals', async () => {
    chunk(0, 'retained');
    finalize.mockImplementationOnce(async () => { const result = await persistence.finalize(directory); owner = 'other'; return result; });
    expect(await exporter(source)).toMatchObject({ error: 'recording_owner_required' });
    expect(saveAs).not.toHaveBeenCalled(); expect(await readFinalizedRecording(directory)).not.toBeNull();
  });

  it('does not export failed or unverified finalization output and retains the input', async () => {
    chunk(0, 'retained');
    finalize.mockImplementationOnce(async () => { fs.writeFileSync(source, 'partial'); return { success: false, error: 'ENOSPC' }; });
    expect(await exporter(source)).toMatchObject({ error: 'recovery_failed' });
    expect(saveAs).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(directory, 'chunks', 'chunk_0.webm'), 'utf8')).toBe('retained');
    fs.unlinkSync(source);
    finalize.mockResolvedValueOnce({ success: true, outputPath: source });
    expect(await exporter(source)).toMatchObject({ error: 'recovery_failed' });
    expect(saveAs).not.toHaveBeenCalled();
  });

  it('returns recovery warnings even when Save As is cancelled, preserving the repaired history', async () => {
    chunk(0, 'retained');
    finalize.mockImplementationOnce(async () => ({ ...await persistence.finalize(directory), warnings: [{ kind: 'native-source-interrupted' }] }));
    saveAs.mockResolvedValueOnce({ success: false, cancelled: true });
    expect(await exporter(source)).toMatchObject({ recovered: true, cancelled: true, captureWarnings: ['native-source-interrupted'] });
    expect(row.captureWarnings).toEqual(['native-source-interrupted']);
  });

  it('does not bypass a failed finalization marker on the next export click', async () => {
    chunk(0, 'retained');
    fs.writeFileSync(source, 'unacknowledged output');
    const pending = path.join(directory, 'finalization-pending.json');
    fs.writeFileSync(pending, '{}');
    finalize.mockResolvedValueOnce({ success: false, error: 'Previous recovery failed' });
    expect(await exporter(source)).toMatchObject({ error: 'recovery_failed' });
    expect(saveAs).not.toHaveBeenCalled();
    finalize.mockImplementationOnce(async () => { const result = await persistence.finalize(directory); fs.unlinkSync(pending); return result; });
    expect(await exporter(source)).toMatchObject({ success: true, recovered: true });
    expect(fs.readFileSync(destination, 'utf8')).toBe('retained');
  });

  it('rejects prefix siblings, relative paths and noncanonical missing filenames without recovery', async () => {
    for (const file of [path.join(root + '-other', id, 'audio.webm'), 'recordings/audio.webm']) {
      expect(await exporter(file)).toMatchObject({ error: 'invalid_source' });
    }
    expect(await exporter(path.join(directory, 'other.webm'))).toMatchObject({ error: 'source_missing' });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('rejects a recording directory junction/symlink without touching its target', async () => {
    const outside = path.join(temporary, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'audio.webm'), 'private');
    fs.rmdirSync(directory); fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await exporter(source)).toMatchObject({ error: 'invalid_source' });
    expect(finalize).not.toHaveBeenCalled(); expect(saveAs).not.toHaveBeenCalled();
  });

  it('recognizes retained legacy sessions and system PCM but not generated scratch output', () => {
    fs.mkdirSync(path.join(directory, 'sessions'));
    fs.writeFileSync(path.join(directory, 'sessions', 'source_final.webm'), 'scratch');
    expect(hasRetainedSources(directory)).toBe(false);
    fs.writeFileSync(path.join(directory, 'sessions', 'session_1.webm'), 'original');
    expect(hasRetainedSources(directory)).toBe(true);
    fs.unlinkSync(path.join(directory, 'sessions', 'session_1.webm'));
    fs.writeFileSync(path.join(directory, 'system_audio.raw'), 'pcm');
    expect(hasRetainedSources(directory)).toBe(true);
  });
});

describe('actual main finalizer export guard', () => {
  const main = fs.readFileSync(new URL('../../src-electron/electron-main.js', import.meta.url), 'utf8');
  const body = main.slice(main.indexOf('async function finalizeRecording('), main.indexOf('// 5. Check for recording chunks/sessions'));
  function actualFinalizer(checkSpace) {
    const context = { getRecordingPath: () => directory, assertExportRecoveryReady,
      isExportRecoveryBusy: () => busy, path, FINALIZATION_PENDING_MARKER: 'finalization-pending.json',
      writeFileAtomic: vi.fn(async (file, value) => fs.promises.writeFile(file, value)),
      canFinalizeRecording: checkSpace, activeAudioTee: { recordId: id }, stopSystemAudio: vi.fn(), log: { error: vi.fn() } };
    const run = vm.runInNewContext(body + '\nfinalizeRecording', context);
    return { run, context };
  }
  it('refuses missing sources before any directory or pending marker write', async () => {
    fs.rmdirSync(directory);
    const { run, context } = actualFinalizer(vi.fn());
    expect(await run(id, '.webm', 0, { exportRecovery: true })).toMatchObject({ success: false, code: 'source_missing' });
    expect(context.writeFileAtomic).not.toHaveBeenCalled(); expect(context.stopSystemAudio).not.toHaveBeenCalled();
  });
  it('refuses newly started capture after the awaited space check instead of stopping AudioTee', async () => {
    chunk(0, 'retained');
    const { run, context } = actualFinalizer(async () => { busy = true; return { canFinalize: true }; });
    expect(await run(id, '.webm', 0, { exportRecovery: true })).toMatchObject({ success: false, code: 'recording_busy' });
    expect(context.writeFileAtomic).toHaveBeenCalledTimes(1); expect(context.stopSystemAudio).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(directory, 'chunks', 'chunk_0.webm'), 'utf8')).toBe('retained');
  });
});
