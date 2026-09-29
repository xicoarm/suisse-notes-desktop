// @vitest-environment node
// ELECTRON-6V end to end: the real native builder (bundled FFmpeg/ffprobe) under
// the real persistence transaction, while "other software" changes timestamps
// of a freshly written source chunk during the build.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ffmpeg = require('fluent-ffmpeg');
const FFMPEG = process.env.SUISSE_TEST_FFMPEG || require('@ffmpeg-installer/ffmpeg').path;
const FFPROBE = process.env.SUISSE_TEST_FFPROBE || require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfmpegPath(FFMPEG);
ffmpeg.setFfprobePath(FFPROBE);
const { createNativeSourceFinalization } = require('../../src-electron/native-source-finalization');
const { validateNativeMedia } = require('../../src-electron/native-media-validation');
const { beginSource, markSourceStarted, saveSourceChunk, endSource, inspectNativeSources } = require('../../src-electron/native-source-persistence');
const { createRecordingPersistence, readFinalizedRecording } = require('../../src-electron/recording-persistence');

let root;
beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-native-rebuild-')); });
afterEach(async () => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-native-rebuild-')) throw new Error('Unsafe fixture cleanup');
  await fs.promises.rm(resolved, { recursive: true, force: true });
});

function run(command) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('Media fixture timeout')); }, 60000);
    command.on('error', error => { clearTimeout(timer); reject(error); }).on('end', () => { clearTimeout(timer); resolve(); }).run();
  });
}
function wave(seconds, hz) {
  const samples = Math.round(seconds * 48000), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let sample = 0; sample < samples; sample++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * sample / 48000) * 3276), 44 + sample * 2);
  return bytes;
}
async function recordedSource() {
  const wav = path.join(root, 'tone.wav'), webm = path.join(root, 'tone.webm');
  await fs.promises.writeFile(wav, wave(2, 440));
  await run(ffmpeg(wav).audioCodec('libopus').output(webm));
  const bytes = fs.readFileSync(webm), sourceId = randomUUID(), cuts = [0, Math.floor(bytes.length / 2), bytes.length];
  await beginSource(root, { sourceId, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm;codecs=opus', settings: { channelCount: 1 } });
  await markSourceStarted(root, sourceId, { startOffsetMs: 0 });
  for (let index = 0; index < 2; index++) await saveSourceChunk(root, sourceId, bytes.subarray(cuts[index], cuts[index + 1]), index);
  await endSource(root, sourceId, { endOffsetMs: 2000, chunkCount: 2, reason: 'stop' });
  return inspectNativeSources(root)[0].chunkPaths.at(-1);
}
function persistenceTouching(file, times) {
  let encodes = 0;
  const build = (directory, outputPath, options) => createNativeSourceFinalization({ ffmpeg, ffprobePath: FFPROBE, validate: validateNativeMedia,
    probe: file => new Promise((resolve, reject) => ffmpeg.ffprobe(file, (error, data) => error ? reject(error) : resolve(Number(data.format.duration)))),
    run: async command => {
      await run(command.on('progress', () => {}));
      // A virus scanner / backup agent handles the fresh chunk while the build reads it.
      if (++encodes <= times) {
        fs.utimesSync(file, new Date(), new Date(Date.now() + 10000 * encodes));
        fs.chmodSync(file, 0o444);
        fs.chmodSync(file, 0o644);
      }
    } }).build(directory, outputPath, options);
  return { persistence: createRecordingPersistence({ nativeBuild: build, validate: file => validateNativeMedia(file), probe: async () => 2 }), encodes: () => encodes };
}

describe('native finalization while other software touches fresh source chunks', () => {
  it('rebuilds once from the settled chunks and publishes a receipt that stays valid', async () => {
    const chunk = await recordedSource();
    const { persistence, encodes } = persistenceTouching(chunk, 1);
    const result = await persistence.finalize(root, '.webm', { expectedDurationSec: 2 });
    expect(encodes()).toBe(2);
    expect(result.sourceTimestampChanges).toEqual([expect.stringMatching(/chunk_1\.webm mtime\+ctime$/)]);
    expect(result.plan.validation.status).toBe('passed');
    expect(Math.abs(result.duration - 2)).toBeLessThan(0.05);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'finalized.json'), 'utf8'));
    expect(receipt).toMatchObject({ version: 3, sourceMode: 'native' });
    expect(await readFinalizedRecording(root)).toMatchObject({ success: true, outputPath: path.join(root, 'audio.webm') });
  }, 120000);

  it('refuses publication when the chunks keep changing, keeping every original', async () => {
    const chunk = await recordedSource();
    const { persistence, encodes } = persistenceTouching(chunk, 2);
    await expect(persistence.finalize(root, '.webm', { expectedDurationSec: 2 })).rejects.toThrow(/changed during finalization \(.*chunk_1\.webm mtime\+ctime\)/);
    expect(encodes()).toBe(2);
    expect(fs.existsSync(path.join(root, 'audio.webm'))).toBe(false);
    expect(inspectNativeSources(root)[0]).toMatchObject({ chunkCount: 2, complete: true });
    expect(await readFinalizedRecording(root)).toBeNull();
  }, 120000);
});
