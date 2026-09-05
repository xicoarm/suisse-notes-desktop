// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRecordingPersistence, readFinalizedRecording } = require('../../src-electron/recording-persistence');
const { assertManagedRecordingDirectory, archiveChunkBatch, listChunkBatches, writeFileAtomic, publishFile, concatenateFiles } = require('../../src-electron/durable-files');

let root;
let remux;
let persistence;
async function chunk(index, bytes) {
  const directory = path.join(root, 'chunks');
  await fs.promises.mkdir(directory, { recursive: true });
  await writeFileAtomic(path.join(directory, `chunk_${index}.webm`), bytes);
}
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-persistence-test-'));
  remux = vi.fn(async (input, output) => fs.promises.copyFile(input, output));
  persistence = createRecordingPersistence({
    prepareRaw: async () => ({}), remux,
    concatSessions: concatenateFiles,
    validate: file => ({ valid: fs.statSync(file).size > 0 }),
    probe: async file => fs.statSync(file).size,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!path.resolve(root).startsWith(path.join(os.tmpdir(), 'suisse-persistence-test-'))) throw new Error('Invalid fixture cleanup path');
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('recording disk transactions under failures', () => {
  it('preserves every batch across rolls and retries without duplicating audio', async () => {
    await chunk(0, 'first');
    await archiveChunkBatch(root);
    await chunk(1, 'second');
    const first = await persistence.finalize(root);
    expect(fs.readFileSync(first.outputPath, 'utf8')).toBe('firstsecond');
    expect(listChunkBatches(root)).toHaveLength(2);
    expect(remux).toHaveBeenCalledTimes(1); // preserve the whole MediaRecorder stream across rolls
    const again = await persistence.finalize(root);
    expect(fs.readFileSync(again.outputPath, 'utf8')).toBe('firstsecond');
    expect(remux).toHaveBeenCalledTimes(2);
    expect(await readFinalizedRecording(root)).toMatchObject({ fileSize: 11, duration: 11 });
  });

  it('refuses to publish earlier segments when the final segment fails', async () => {
    await chunk(0, 'first');
    await persistence.createSessions(root);
    await chunk(1, 'last');
    remux.mockImplementationOnce(async (input, output) => {
      await fs.promises.writeFile(output, 'partial');
      throw new Error('ENOSPC during remux');
    });
    await expect(persistence.finalize(root)).rejects.toThrow('ENOSPC');
    expect(fs.existsSync(path.join(root, 'audio.webm'))).toBe(false);
    expect(await readFinalizedRecording(root)).toBeNull();
    expect(listChunkBatches(root).map(batch => fs.readdirSync(batch.path).length)).toEqual([1, 1]);
    const recovered = await persistence.finalize(root);
    expect(fs.readFileSync(recovered.outputPath, 'utf8')).toBe('firstlast');
  });

  it('rebuilds after a crash leaves a partial final output', async () => {
    await chunk(0, 'complete audio');
    await fs.promises.writeFile(path.join(root, 'audio.webm'), 'partial');
    expect(await readFinalizedRecording(root)).toBeNull();
    const recovered = await persistence.finalize(root);
    expect(fs.readFileSync(recovered.outputPath, 'utf8')).toBe('complete audio');
  });

  it('detects same-size corruption of a published file with its checksum', async () => {
    await chunk(0, 'correct');
    const result = await persistence.finalize(root);
    await fs.promises.writeFile(result.outputPath, 'corrupt');
    expect(await readFinalizedRecording(root)).toBeNull();
    await persistence.finalize(root);
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe('correct');
  });

  it('invalidates a completion receipt when a late chunk arrives', async () => {
    await chunk(0, 'before');
    await persistence.finalize(root);
    await chunk(1, 'after');
    expect(await readFinalizedRecording(root)).toBeNull();
    const result = await persistence.finalize(root);
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe('beforeafter');
  });

  it('retains all chunks and reports missing indices instead of silently publishing a gap', async () => {
    await chunk(0, 'first'); await chunk(2, 'third');
    await expect(persistence.finalize(root)).rejects.toThrow('gap');
    expect(listChunkBatches(root)).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'audio.webm'))).toBe(false);
  });

  it('can recover system audio when a crash prevented the first microphone chunk', async () => {
    await fs.promises.writeFile(path.join(root, 'system_audio.raw'), 'system-only');
    const onlyPcm = createRecordingPersistence({
      prepareRaw: async () => ({}), remux, concatSessions: concatenateFiles,
      validate: file => ({ valid: fs.statSync(file).size > 0 }), probe: async () => 1,
      fromPcm: (input, output) => fs.promises.copyFile(input, output),
      merge: () => { throw Error('Must not mix PCM with itself'); },
    });
    const result = await onlyPcm.finalize(root);
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe('system-only');
    expect(fs.readFileSync(path.join(root, 'system_audio.raw'), 'utf8')).toBe('system-only');
    // A valid receipt also makes this path idempotent without mixing the PCM
    // with its own previous output.
    expect(await onlyPcm.finalize(root)).toMatchObject({ success: true, outputPath: result.outputPath });
  });

  it('never replaces legacy audio with system-only PCM when microphone provenance is missing', async () => {
    await fs.promises.writeFile(path.join(root, 'system_audio.raw'), 'participants');
    await fs.promises.writeFile(path.join(root, 'audio.webm'), 'surviving-microphone');
    const fromPcm = vi.fn((input, output) => fs.promises.copyFile(input, output));
    const ambiguous = createRecordingPersistence({
      prepareRaw: async () => ({}), remux, concatSessions: concatenateFiles,
      validate: file => ({ valid: fs.statSync(file).size > 0 }), probe: async () => 1, fromPcm,
    });
    await expect(ambiguous.finalize(root)).rejects.toThrow('both original files are retained');
    expect(fromPcm).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, 'audio.webm'), 'utf8')).toBe('surviving-microphone');
    expect(fs.readFileSync(path.join(root, 'system_audio.raw'), 'utf8')).toBe('participants');
    expect(await readFinalizedRecording(root)).toBeNull();
  });

  it('recovers system-only publication after a crash before its final receipt', async () => {
    await fs.promises.writeFile(path.join(root, 'system_audio.raw'), 'participants');
    const pcm = createRecordingPersistence({
      prepareRaw: async () => ({}), remux, concatSessions: concatenateFiles,
      validate: file => ({ valid: fs.statSync(file).size > 0 }), probe: async () => 1,
      fromPcm: (input, output) => fs.promises.copyFile(input, output),
    });
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((source, destination) => {
      if (destination === path.join(root, 'finalized.json')) throw new Error('crash before receipt publication');
      return rename(source, destination);
    });
    await expect(pcm.finalize(root)).rejects.toThrow('crash before receipt');
    expect(fs.readFileSync(path.join(root, 'audio.webm'), 'utf8')).toBe('participants');
    expect(await readFinalizedRecording(root)).toBeNull();
    vi.restoreAllMocks();
    const recovered = await pcm.finalize(root);
    expect(fs.readFileSync(recovered.outputPath, 'utf8')).toBe('participants');
    expect(await readFinalizedRecording(root)).toMatchObject({ success: true });
  });

  it('rejects old success receipts that could have omitted system audio, and rebuilds from both originals', async () => {
    await chunk(0, 'microphone');
    await fs.promises.writeFile(path.join(root, 'system_audio.raw'), 'participants');
    const combined = createRecordingPersistence({
      prepareRaw: async () => ({}), remux, concatSessions: concatenateFiles,
      validate: file => ({ valid: fs.statSync(file).size > 0 }), probe: async () => 1,
      merge: file => fs.promises.appendFile(file, '+participants'),
    });
    await combined.finalize(root);
    const receiptPath = path.join(root, 'finalized.json');
    const old = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(old).toMatchObject({ version: 2, sourceMode: 'microphone-and-system' });
    await fs.promises.writeFile(receiptPath, JSON.stringify({ ...old, version: 1 }));
    expect(await readFinalizedRecording(root)).toBeNull();
    const rebuilt = await combined.finalize(root);
    expect(fs.readFileSync(rebuilt.outputPath, 'utf8')).toBe('microphone+participants');
    expect(await readFinalizedRecording(root)).toMatchObject({ success: true });
  });

  it('keeps compatible microphone-only version-one receipts readable', async () => {
    await chunk(0, 'microphone');
    await persistence.finalize(root);
    const receiptPath = path.join(root, 'finalized.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    await fs.promises.writeFile(receiptPath, JSON.stringify({ ...receipt, version: 1 }));
    expect(await readFinalizedRecording(root)).toMatchObject({ success: true });
  });

  it('withholds publication if source audio changes during the merge', async () => {
    await chunk(0, 'microphone');
    await fs.promises.writeFile(path.join(root, 'system_audio.raw'), 'participants');
    const changing = createRecordingPersistence({
      prepareRaw: async () => ({}), remux, concatSessions: concatenateFiles,
      validate: file => ({ valid: fs.statSync(file).size > 0 }), probe: async () => 1,
      merge: () => fs.promises.appendFile(path.join(root, 'system_audio.raw'), 'late audio'),
    });
    await expect(changing.finalize(root)).rejects.toThrow('sources changed during finalization');
    expect(fs.existsSync(path.join(root, 'audio.webm'))).toBe(false);
    expect(await readFinalizedRecording(root)).toBeNull();
    expect(fs.readFileSync(path.join(root, 'system_audio.raw'), 'utf8')).toBe('participantslate audio');
  });

  it('never authorizes recursive deletion of an import folder, root, or sibling', () => {
    expect(assertManagedRecordingDirectory(root, path.join(root, 'record-id'))).toBe(path.join(root, 'record-id'));
    for (const unsafe of [root, path.dirname(root), path.join(root, '..', 'Downloads'), path.join(root, 'id', 'nested')]) {
      expect(() => assertManagedRecordingDirectory(root, unsafe)).toThrow('Refusing');
    }
  });

  it('retains the old destination when atomic replacement fails', async () => {
    const old = path.join(root, 'audio.webm');
    const next = path.join(root, 'new.webm');
    await fs.promises.writeFile(old, 'old playable audio');
    await fs.promises.writeFile(next, 'new audio');
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('disk error'), { code: 'EIO' }));
    await expect(publishFile(next, old)).rejects.toThrow('disk error');
    expect(fs.readFileSync(old, 'utf8')).toBe('old playable audio');
    expect(fs.readFileSync(next, 'utf8')).toBe('new audio');
  });

  it('never silently skips an unreadable input during concatenation', async () => {
    await chunk(0, 'first');
    const destination = path.join(root, 'audio.webm');
    await expect(concatenateFiles([
      path.join(root, 'chunks', 'chunk_0.webm'), path.join(root, 'missing.webm'),
    ], destination)).rejects.toThrow();
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readFileSync(path.join(root, 'chunks', 'chunk_0.webm'), 'utf8')).toBe('first');
  });

  it('finishes batch publication before accepting later chunks, even if the clock moves backwards', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    await chunk(0, 'one');
    const first = await archiveChunkBatch(root);
    Date.now.mockReturnValue(10);
    await chunk(1, 'two');
    const second = await archiveChunkBatch(root);
    expect(Number(second.id)).toBeGreaterThan(Number(first.id));
    const result = await persistence.finalize(root);
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe('onetwo');
  });
});
