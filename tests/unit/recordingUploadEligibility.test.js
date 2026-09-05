// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessRecordingUpload, FINALIZATION_PENDING_MARKER } = require('../../src-electron/recording-upload-eligibility');
const { createRecordingPersistence } = require('../../src-electron/recording-persistence');
const { concatenateFiles } = require('../../src-electron/durable-files');
let root, recordPath, filePath;
const recordId = '5cf80874-f25b-4244-8e17-4014663bd0a1';
const assess = (overrides = {}) => assessRecordingUpload({ recordId, filePath, recordingsRoot: root, ...overrides });

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-upload-gate-'));
  recordPath = path.join(root, recordId);
  filePath = path.join(recordPath, 'audio.webm');
  await fs.promises.mkdir(recordPath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('suisse-upload-gate-')) throw new Error('Invalid cleanup path');
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function finalized() {
  await fs.promises.mkdir(path.join(recordPath, 'chunks'));
  await fs.promises.writeFile(path.join(recordPath, 'chunks/chunk_0.webm'), 'saved meeting');
  const persistence = createRecordingPersistence({
    prepareRaw: async () => ({}), remux: (input, output) => fs.promises.copyFile(input, output),
    concatSessions: concatenateFiles, validate: async file => ({ valid: (await fs.promises.stat(file)).size > 0 }), probe: async () => 3,
  });
  return persistence.finalize(recordPath);
}

describe('generated recording upload eligibility', () => {
  it('allows a current completed receipt without changing any audio or receipt', async () => {
    await finalized();
    const beforeAudio = await fs.promises.readFile(filePath);
    const beforeReceipt = await fs.promises.readFile(path.join(recordPath, 'finalized.json'));
    expect(await assess()).toEqual({ allowed: true, requiresFinalization: false });
    expect(await fs.promises.readFile(filePath)).toEqual(beforeAudio);
    expect(await fs.promises.readFile(path.join(recordPath, 'finalized.json'))).toEqual(beforeReceipt);
  });

  it('blocks the surviving old output after late chunks invalidate its receipt', async () => {
    await finalized();
    const before = await fs.promises.readFile(filePath);
    await fs.promises.writeFile(path.join(recordPath, 'chunks/chunk_1.webm'), 'late participants');
    expect(await assess()).toMatchObject({ allowed: false, requiresFinalization: true });
    expect(await fs.promises.readFile(filePath)).toEqual(before);
  });

  it('blocks a same-size corrupted output instead of trusting its filename or size', async () => {
    await finalized();
    await fs.promises.writeFile(filePath, 'xxxxx xxxxxxx'); // Same 13-byte size as saved meeting.
    expect(await assess()).toMatchObject({ allowed: false, requiresFinalization: true });
  });

  it('keeps source-free legacy and imported paths compatible, including missing imports', async () => {
    await fs.promises.writeFile(filePath, 'legacy recording');
    await fs.promises.mkdir(path.join(recordPath, 'chunks')); // Empty default directory is not source audio.
    expect(await assess()).toEqual({ allowed: true, requiresFinalization: false });
    expect(await assess({ filePath: path.join(root, 'external-import.wav') })).toEqual({ allowed: true, requiresFinalization: false });
    await fs.promises.writeFile(path.join(recordPath, FINALIZATION_PENDING_MARKER), '{}');
    expect(await assess({ filePath: path.join(recordPath, 'import.wav') })).toEqual({ allowed: true, requiresFinalization: false });
  });

  it('blocks ambiguous legacy output with participant PCM and no receipt', async () => {
    await fs.promises.writeFile(filePath, 'old microphone only');
    await fs.promises.writeFile(path.join(recordPath, 'system_audio.raw'), 'participants');
    expect(await assess()).toMatchObject({ allowed: false, requiresFinalization: true });
    expect(await fs.promises.readFile(filePath, 'utf8')).toBe('old microphone only');
    expect(await fs.promises.readFile(path.join(recordPath, 'system_audio.raw'), 'utf8')).toBe('participants');
  });

  it.each(['invalid-json', 'wrong-version', 'receipt-directory'])('blocks an invalid completion marker even with no retained sources (%s)', async variant => {
    await fs.promises.writeFile(filePath, 'legacy recording');
    const receipt = path.join(recordPath, 'finalized.json');
    if (variant === 'receipt-directory') await fs.promises.mkdir(receipt);
    else await fs.promises.writeFile(receipt, variant === 'invalid-json' ? '{broken' : '{"version":99}');
    expect(await assess()).toMatchObject({ allowed: false, requiresFinalization: true });
  });

  it('blocks a pending/failed combine even if the previous completion still validates', async () => {
    await finalized();
    await fs.promises.writeFile(path.join(recordPath, FINALIZATION_PENDING_MARKER), 'interrupted marker');
    expect(await assess()).toMatchObject({ allowed: false, requiresFinalization: true });
  });

  it('allows verified recovery despite an unacknowledged atomic temporary left by a crash', async () => {
    await finalized();
    await fs.promises.writeFile(path.join(recordPath, 'chunks/chunk_1.webm.6ddf2cc2-7a30-4f40-8c14-55a2e5761b58.tmp'), 'unpublished partial');
    expect(await assess()).toEqual({ allowed: true, requiresFinalization: false });
  });

  it('does not allow a legacy mixed receipt to claim independent native sources are included', async () => {
    await finalized();
    await fs.promises.mkdir(path.join(recordPath, 'native-sources/orphan-source'), { recursive: true });
    expect(await assess()).toMatchObject({ allowed: false, requiresFinalization: true });
  });

  it.each(['chunks', 'source-chunks', 'sessions', 'native-sources'])('blocks malformed source directory %s', async name => {
    await fs.promises.writeFile(filePath, 'legacy recording');
    await fs.promises.writeFile(path.join(recordPath, name), 'not a directory');
    expect(await assess()).toMatchObject({ allowed: false, requiresFinalization: true });
  });

  it('blocks orphan malformed chunk/batch entries that the legacy fingerprint ignores', async () => {
    await finalized();
    await fs.promises.writeFile(path.join(recordPath, 'chunks/unnamed-recording'), 'unpublished audio');
    expect(await assess()).toMatchObject({ allowed: false, requiresFinalization: true });
    await fs.promises.unlink(path.join(recordPath, 'chunks/unnamed-recording'));
    await fs.promises.mkdir(path.join(recordPath, 'source-chunks/orphan-batch'));
    expect(await assess()).toMatchObject({ allowed: false, requiresFinalization: true });
  });

  it('never interprets permission errors during source discovery as no sources', async () => {
    await finalized();
    const original = fs.promises.readdir;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((directory, options) => {
      if (directory === path.join(recordPath, 'source-chunks')) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
      return original.call(fs.promises, directory, options);
    });
    expect(await assess()).toMatchObject({ allowed: false, requiresFinalization: true, error: expect.stringContaining('inspected') });
  });

  it('rejects unsafe managed identities and does not treat them as imported files', async () => {
    expect(await assess({ recordId: '../outside' })).toMatchObject({ allowed: false, requiresFinalization: true });
    expect(await assess({ recordId: '..\\outside' })).toMatchObject({ allowed: false, requiresFinalization: true });
  });
});
