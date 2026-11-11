// @vitest-environment node
// Support rebuild of a stranded recording folder (ELECTRON-7R): the real
// native builder and bundled FFmpeg, on a synthetic copy of what the app leaves.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path);
ffmpeg.setFfprobePath(require('@ffprobe-installer/ffprobe').path);
const { beginSource, markSourceStarted, saveSourceChunk, endSource } = require('../../src-electron/native-source-persistence');
const { rebuildRecording, parseArguments, inventory } = require('../../scripts/rebuild-stranded-recording');

let root;
beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-support-rebuild-')); });
afterEach(async () => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-support-rebuild-')) throw new Error('Unsafe fixture cleanup');
  await fs.promises.rm(resolved, { recursive: true, force: true });
});

function run(command) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('Media fixture timeout')); }, 60000);
    command.on('error', error => { clearTimeout(timer); reject(error); }).on('end', () => { clearTimeout(timer); resolve(); }).run();
  });
}
function pcm(seconds, hz) {
  const count = Math.round(seconds * 48000), bytes = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * index / 48000) * 3276), index * 2);
  return bytes;
}
async function window(file, from, to) {
  const raw = path.join(root, `window-${randomUUID()}.raw`);
  await run(ffmpeg(file).audioFilters(`atrim=start_sample=${Math.round(from * 48000)}:end_sample=${Math.round(to * 48000)}`)
    .audioCodec('pcm_f32le').audioFrequency(48000).audioChannels(2).format('f32le').output(raw));
  const data = fs.readFileSync(raw);
  return { data, samples: data.length / 8 };
}
function amplitude(audio, hz, from, to) {
  const start = Math.round(from * 48000), end = Math.min(audio.samples, Math.round(to * 48000));
  let sine = 0, cosine = 0;
  for (let index = start; index < end; index++) {
    const value = audio.data.readFloatLE(index * 8), angle = 2 * Math.PI * hz * index / 48000;
    sine += value * Math.sin(angle); cosine += value * Math.cos(angle);
  }
  return 2 * Math.hypot(sine, cosine) / (end - start);
}
// What a customer's folder looks like after finalization gave up: one native
// microphone source with a six-minute clock gap, AudioTee PCM, an empty
// legacy chunks/ folder, the app's plan and a failed scratch directory.
async function strandedFolder({ gapSeconds = 360, interrupted = false } = {}) {
  const folder = path.join(root, randomUUID());
  await fs.promises.mkdir(path.join(folder, 'chunks'), { recursive: true });
  await fs.promises.writeFile(path.join(folder, 'metadata.json'), JSON.stringify({ recordId: path.basename(folder), userId: 'user', startedAt: '2026-11-11T11:25:00.000Z', version: 1 }));
  await fs.promises.writeFile(path.join(folder, 'native-capture.json'), JSON.stringify({ version: 1, captureMode: 'native-sources-v1' }));
  await fs.promises.writeFile(path.join(folder, 'finalization-plan.json'), JSON.stringify({ version: 2, sourceMode: 'native', sourceFingerprint: 'x' }));
  await fs.promises.mkdir(path.join(folder, 'native-finalization-AbC123'));
  await fs.promises.writeFile(path.join(folder, 'native-finalization-AbC123', 'plan.json'), '{"validation":{"status":"failed"}}');
  const webm = path.join(root, 'gapped.webm');
  await run(ffmpeg().input('sine=f=440:d=1:r=48000').inputFormat('lavfi').input('sine=f=880:d=1:r=48000').inputFormat('lavfi')
    .complexFilter(`[0][1]concat=n=2:v=0:a=1,asetpts='if(gte(T,1),PTS+${gapSeconds}/TB,PTS)'`).audioCodec('libopus').output(webm));
  const bytes = fs.readFileSync(webm), sourceId = randomUUID(), cut = Math.floor(bytes.length / 2);
  await beginSource(folder, { sourceId, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm;codecs=opus', settings: { channelCount: 1 } });
  await markSourceStarted(folder, sourceId, { startOffsetMs: 0 });
  await saveSourceChunk(folder, sourceId, bytes.subarray(0, cut), 0);
  await saveSourceChunk(folder, sourceId, bytes.subarray(cut), 1);
  if (!interrupted) await endSource(folder, sourceId, { endOffsetMs: (gapSeconds + 2) * 1000, chunkCount: 2, reason: 'stopped' });
  await fs.promises.writeFile(path.join(folder, 'system_audio.raw'), pcm(2, 660));
  return { folder, sourceId };
}

describe('support rebuild of a stranded recording folder', () => {
  it('writes one MP3 with the long gap restored, a report, and never touches the folder (ELECTRON-7R)', async () => {
    const { folder, sourceId } = await strandedFolder();
    const before = await inventory(folder);
    const listing = fs.readdirSync(folder).sort();
    const output = path.join(root, 'out', 'restored.mp3');
    const report = await rebuildRecording({ input: folder, output, workDir: root });
    expect(report.inputUnchanged).toBe(true);
    expect(await inventory(folder)).toEqual(before);
    expect(fs.readdirSync(folder).sort()).toEqual(listing);
    expect(report.recovery).toBe(false);
    expect(report.build.systemPcmIncluded).toBe(true);
    expect(report.build.validation.status).toBe('passed');
    expect(report.build.warnings).toContainEqual(expect.objectContaining({ kind: 'native-source-timestamp-resample-fallback', sourceId, timeline: 'sample-order-restored-gaps' }));
    expect(report.build.sourceEvidence).toContainEqual(expect.objectContaining({ sourceId, timeline: 'sample-order-restored-gaps' }));
    expect(Math.abs(report.result.durationSeconds - 362)).toBeLessThan(0.2);
    expect(JSON.parse(fs.readFileSync(`${output}.report.json`, 'utf8')).result.sha256).toBe(report.result.sha256);
    expect(fs.readdirSync(root).filter(name => name.startsWith('suisse-rebuild-'))).toEqual([]);
    const head = await window(output, 0, 2);
    expect(amplitude(head, 440, 0.2, 0.8)).toBeGreaterThan(0.05);
    expect(amplitude(head, 660, 0.2, 1.8)).toBeGreaterThan(0.05);
    expect(amplitude(head, 880, 1.2, 1.8)).toBeLessThan(0.005);
    const resumed = await window(output, 360, 362);
    expect(amplitude(resumed, 880, 1.1, 1.9)).toBeGreaterThan(0.05);
  }, 180000);

  it('rebuilds an interrupted source as recovery into WAV', async () => {
    const { folder } = await strandedFolder({ gapSeconds: 2, interrupted: true });
    const output = path.join(root, 'restored.wav');
    const report = await rebuildRecording({ input: folder, output, workDir: root });
    expect(report.recovery).toBe(true);
    expect(report.build.warnings).toContainEqual(expect.objectContaining({ kind: 'native-source-interrupted' }));
    expect(Math.abs(report.result.durationSeconds - 4)).toBeLessThan(0.05);
    const audio = await window(output, 0, 4);
    expect(amplitude(audio, 440, 0.2, 0.8)).toBeGreaterThan(0.05);
    expect(amplitude(audio, 880, 3.2, 3.8)).toBeGreaterThan(0.05);
  }, 120000);

  it('refuses to write into the customer folder or over an existing file', async () => {
    const { folder } = await strandedFolder({ gapSeconds: 2 });
    await expect(rebuildRecording({ input: folder, output: path.join(folder, 'out.mp3') })).rejects.toThrow(/outside the customer recording folder/);
    fs.writeFileSync(path.join(root, 'taken.mp3'), 'x');
    await expect(rebuildRecording({ input: folder, output: path.join(root, 'taken.mp3') })).rejects.toThrow(/already exists/);
    await expect(rebuildRecording({ input: folder, output: path.join(root, 'out.ogg') })).rejects.toThrow(/\.mp3, \.wav or \.webm/);
    expect(parseArguments([folder, '--out', 'x.wav', '--expected-duration', '12'])).toMatchObject({ input: folder, expectedDurationSec: 12 });
    expect(() => parseArguments([folder, '--bogus'])).toThrow(/Unsupported/);
    if (process.platform !== 'win32') {
      // A dangling link at the output path must not redirect a write into the folder.
      fs.symlinkSync(path.join(folder, 'planted.mp3'), path.join(root, 'link.mp3'));
      fs.symlinkSync(path.join(folder, 'planted.json'), path.join(root, 'real.mp3.report.json'));
      await expect(rebuildRecording({ input: folder, output: path.join(root, 'link.mp3') })).rejects.toThrow(/dangling|already exists/);
      await expect(rebuildRecording({ input: folder, output: path.join(root, 'real.mp3') })).rejects.toThrow(/already exists/);
      expect(fs.existsSync(path.join(folder, 'planted.mp3')) || fs.existsSync(path.join(folder, 'planted.json'))).toBe(false);
    }
  });

  it('keeps the report and the scratch when the build fails before the output folder existed', async () => {
    const folder = path.join(root, randomUUID()), sourceId = randomUUID();
    await fs.promises.mkdir(folder);
    await beginSource(folder, { sourceId, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm;codecs=opus', settings: { channelCount: 1 } });
    await markSourceStarted(folder, sourceId, { startOffsetMs: 0 });
    await saveSourceChunk(folder, sourceId, Buffer.from('not-a-recording-but-preserved-source-bytes'), 0);
    await endSource(folder, sourceId, { endOffsetMs: 1000, chunkCount: 1, reason: 'stopped' });
    const output = path.join(root, 'new', 'folder', 'out.mp3');
    const error = await rebuildRecording({ input: folder, output, workDir: root }).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toMatch(/ENOENT/);
    const report = JSON.parse(fs.readFileSync(`${output}.report.json`, 'utf8'));
    expect(report.error.message).toBe(error.message);
    expect(report.inputUnchanged).toBe(true);
    expect(fs.existsSync(report.scratchKept)).toBe(true);
    expect(fs.existsSync(output)).toBe(false);
  }, 60000);
});
