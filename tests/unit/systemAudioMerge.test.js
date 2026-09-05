// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRecordingPersistence, readFinalizedRecording } = require('../../src-electron/recording-persistence');
const { concatenateFiles, publishFile } = require('../../src-electron/durable-files');
const main = fs.readFileSync('src-electron/electron-main.js', 'utf8');
const declaration = main.slice(main.indexOf('async function mergeSystemAudio('), main.indexOf('// IPC handler for checking disk space before recording'));
if (!declaration.startsWith('async function mergeSystemAudio(')) throw new Error('Missing production merge handler');

let root;
let failure;
let available;
let warnings;
let persistence;
let encode;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-merge-test-'));
  await fs.promises.mkdir(path.join(root, 'chunks'));
  await fs.promises.writeFile(path.join(root, 'chunks/chunk_0.webm'), 'microphone');
  await fs.promises.writeFile(path.join(root, 'system_audio.raw'), 'participants');
  failure = null;
  available = true;
  warnings = vi.fn();
  encode = vi.fn(async command => {
    // Model a failed encoder that already created an incomplete destination.
    await fs.promises.writeFile(command.destination, 'partial');
    if (failure instanceof Error) throw failure;
    if (failure === 'invalid') return;
    await fs.promises.writeFile(command.destination, 'microphone+participants');
  });
  const ffmpeg = () => {
    const command = {};
    for (const method of ['input', 'inputOptions', 'complexFilter']) command[method] = () => command;
    command.output = destination => { command.destination = destination; return command; };
    return command;
  };
  const valid = file => ({ valid: fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== 'partial', error: 'incomplete output' });
  const merge = new Function('fs', 'path', 'getRecordingPath', 'binaryHealth', 'notifyMergeDegraded', 'log',
    'ffmpeg', 'ffmpegWithTimeout', 'FFMPEG_TIMEOUT_MS', 'validateAudioOutput', 'publishFile',
    declaration + '\nreturn mergeSystemAudio;')(
    fs, path, () => root, { ffmpeg: { get available() { return available; }, error: 'missing binary' } },
    warnings, { info() {}, warn() {} }, ffmpeg, encode, 300000, valid, publishFile);
  persistence = createRecordingPersistence({
    prepareRaw: async () => ({}), remux: (input, output) => fs.promises.copyFile(input, output),
    concatSessions: concatenateFiles, merge: file => merge(file, 'fixture'), validate: valid, probe: async () => 10,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('suisse-merge-test-')) throw new Error('Invalid cleanup path');
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('macOS system audio is required for final publication', () => {
  it.each(['unavailable', 'timeout', 'disk-full', 'invalid'])('retains both sources and withholds completion when merging fails (%s)', async reason => {
    if (reason === 'unavailable') available = false;
    if (reason === 'timeout') failure = new Error('encoder timed out');
    if (reason === 'disk-full') failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    if (reason === 'invalid') failure = 'invalid';
    await expect(persistence.finalize(root)).rejects.toThrow();
    expect(await readFinalizedRecording(root)).toBeNull();
    expect(fs.existsSync(path.join(root, 'audio.webm'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'system_audio.raw'), 'utf8')).toBe('participants');
    const batches = fs.readdirSync(path.join(root, 'source-chunks'));
    expect(batches).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'source-chunks', batches[0], 'chunk_0.webm'), 'utf8')).toBe('microphone');
    expect(warnings).toHaveBeenCalledTimes(1);

    // Retry must reconstruct the mic from retained originals, mix once, and
    // publish only after both sources have been included successfully.
    available = true;
    failure = null;
    const recovered = await persistence.finalize(root);
    expect(fs.readFileSync(recovered.outputPath, 'utf8')).toBe('microphone+participants');
    expect(await readFinalizedRecording(root)).toMatchObject({ success: true });
  });

  it('preserves ENOSPC classification for the existing free-space retry flow', async () => {
    failure = Object.assign(new Error('not enough space'), { code: 'ENOSPC' });
    await expect(persistence.finalize(root)).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('leaves an earlier complete recording intact when a later rebuild fails', async () => {
    const completed = await persistence.finalize(root);
    const previous = fs.readFileSync(completed.outputPath);
    await fs.promises.writeFile(path.join(root, 'chunks/chunk_1.webm'), 'late microphone');
    failure = new Error('merge timed out');
    await expect(persistence.finalize(root)).rejects.toThrow('merge timed out');
    expect(fs.readFileSync(completed.outputPath)).toEqual(previous);
    expect(await readFinalizedRecording(root)).toBeNull();
  });

  it('allows microphone-only recordings when no system audio was captured', async () => {
    await fs.promises.unlink(path.join(root, 'system_audio.raw'));
    const result = await persistence.finalize(root);
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe('microphone');
    expect(encode).not.toHaveBeenCalled();
  });
});
