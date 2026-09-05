// @vitest-environment node
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
const { createNativeSourceFinalization, createTimestampEvidence, planLane, estimateScratchBytes } = require('../../src-electron/native-source-finalization');
const { beginSource, markSourceStarted, saveSourceChunk, endSource, inspectNativeSources } = require('../../src-electron/native-source-persistence');
let root;
let commands;

async function run(command, timeout = 30000) {
  commands.push(command._inputs.length);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('Media fixture timeout')); }, Math.min(timeout, 60000));
    command.on('error', error => { clearTimeout(timer); reject(error); }).on('end', () => { clearTimeout(timer); resolve(); }).run();
  });
}
function metadata(file) {
  return new Promise((resolve, reject) => ffmpeg.ffprobe(file, (error, result) => error ? reject(error) : resolve(result)));
}
function finalizer(overrides = {}) {
  return createNativeSourceFinalization({ ffmpeg, run,
    validate: async file => ({ valid: fs.statSync(file).size > 0 }),
    probe: async file => Number((await metadata(file)).format.duration), ...overrides });
}
function wave(seconds, hz, { rate = 48000, stereo = false, antiPhase = false } = {}) {
  const channels = stereo ? 2 : 1, samples = Math.round(seconds * rate);
  const bytes = Buffer.alloc(44 + samples * channels * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let sample = 0; sample < samples; sample++) {
    const value = Math.round(Math.sin(2 * Math.PI * hz * sample / rate) * 0.1 * 32767);
    for (let channel = 0; channel < channels; channel++) bytes.writeInt16LE(channel === 1 && antiPhase ? -value : value, 44 + (sample * channels + channel) * 2);
  }
  return bytes;
}
async function encoded(seconds, hz, options = {}) {
  const id = randomUUID(), wav = path.join(root, `${id}.wav`), webm = path.join(root, `${id}.webm`);
  await fs.promises.writeFile(wav, wave(seconds, hz, options));
  let command = ffmpeg(wav).audioCodec('libopus');
  if (options.filters) command = command.audioFilters(options.filters);
  await run(command.output(webm));
  return fs.readFileSync(webm);
}
async function source(bytes, { kind = 'microphone', start = 0, end, reason = 'stopped', channels = 1 } = {}) {
  const sourceId = randomUUID();
  await beginSource(root, { sourceId, kind, startOffsetMs: start, mimeType: 'audio/webm;codecs=opus', settings: { channelCount: channels } });
  await markSourceStarted(root, sourceId, { startOffsetMs: start });
  // Deliberately split through container/packet boundaries. Reconstruction
  // must join bytes before decoding; each chunk is not an independent file.
  const cuts = [0, Math.min(37, Math.floor(bytes.length / 3)), Math.floor(bytes.length / 2), bytes.length];
  for (let index = 0; index < 3; index++) await saveSourceChunk(root, sourceId, bytes.subarray(cuts[index], cuts[index + 1]), index);
  if (end !== undefined) await endSource(root, sourceId, { endOffsetMs: end, chunkCount: 3, reason });
  return sourceId;
}
async function decoded(file) {
  const raw = path.join(root, `decoded-${randomUUID()}.raw`);
  await run(ffmpeg(file).audioCodec('pcm_f32le').audioFrequency(48000).audioChannels(2).format('f32le').output(raw));
  const data = fs.readFileSync(raw);
  return { data, samples: data.length / 8 };
}
function amplitude(audio, hz, from, to, channel = 0) {
  const start = Math.round(from * 48000), end = Math.min(audio.samples, Math.round(to * 48000));
  let sine = 0, cosine = 0;
  for (let index = start; index < end; index++) {
    const value = audio.data.readFloatLE(index * 8 + channel * 4), angle = 2 * Math.PI * hz * index / 48000;
    sine += value * Math.sin(angle); cosine += value * Math.cos(angle);
  }
  return 2 * Math.hypot(sine, cosine) / (end - start);
}
beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-native-finalization-')); commands = []; });
afterEach(async () => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-native-finalization-')) throw new Error('Unsafe finalization fixture cleanup');
  await fs.promises.rm(resolved, { recursive: true, force: true });
});

describe('native source finalization real-media custody', () => {
  it('preserves independent mic/system identities and cuts only the explicit replacement overlap', async () => {
    const firstBytes = await encoded(2, 440);
    const first = await source(firstBytes, { end: 1000, reason: 'replacement' });
    const next = await source(await encoded(1, 880, { rate: 44100, stereo: true }), { start: 1000, end: 2000, channels: 2 });
    await source(await encoded(2, 660), { kind: 'system', end: 2000 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'), { expectedDurationSec: 2 });
    const audio = await decoded(result.outputPath);
    expect(audio.samples / 48000).toBeCloseTo(2, 2);
    expect(amplitude(audio, 440, 0.2, 0.8)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 880, 0.2, 0.8)).toBeLessThan(0.005);
    expect(amplitude(audio, 660, 0.2, 0.8)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 880, 1.2, 1.8)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 440, 1.2, 1.8)).toBeLessThan(0.005);
    expect(amplitude(audio, 660, 1.2, 1.8)).toBeGreaterThan(0.08);
    expect(result.warnings).toContainEqual(expect.objectContaining({ kind: 'native-source-handover-cut', sourceId: first, successorSourceId: next }));
    const archived = inspectNativeSources(root).find(item => item.sourceId === first);
    expect(Buffer.concat(archived.chunkPaths.map(file => fs.readFileSync(file))).equals(firstBytes)).toBe(true);
    expect(Math.max(...commands)).toBeLessThanOrEqual(2);
  }, 60000);

  it('keeps stereo anti-phase USB audio audible in both channels instead of cancelling it to mono', async () => {
    await source(await encoded(1, 550, { stereo: true, antiPhase: true }), { end: 1000, channels: 2 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'));
    const audio = await decoded(result.outputPath);
    expect(amplitude(audio, 550, 0.2, 0.8, 0)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 550, 0.2, 0.8, 1)).toBeGreaterThan(0.08);
    let peakSum = 0;
    for (let index = 9600; index < 38400; index++) peakSum = Math.max(peakSum, Math.abs(audio.data.readFloatLE(index * 8) + audio.data.readFloatLE(index * 8 + 4)));
    expect(peakSum).toBeLessThan(0.005);
    expect(result.plan.channels).toBe(2);
    expect(result.fastPathUsed).toBe(true);
    expect(fs.readdirSync(result.scratchDirectory).some(name => name.endsWith('.flac'))).toBe(false);
  }, 60000);

  it('places pause epochs and later device audio on active time with an explicit silent outage', async () => {
    await source(await encoded(0.8, 440), { end: 800, reason: 'paused' });
    await source(await encoded(0.8, 880), { start: 800, end: 1600, reason: 'paused' });
    await source(await encoded(0.8, 660), { start: 2000, end: 2800 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'), { expectedDurationSec: 2.8 });
    const audio = await decoded(result.outputPath);
    expect(audio.samples / 48000).toBeCloseTo(2.8, 2);
    expect(amplitude(audio, 440, 0.2, 0.6)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 880, 1.0, 1.4)).toBeGreaterThan(0.08);
    for (const hz of [440, 660, 880]) expect(amplitude(audio, hz, 1.7, 1.9)).toBeLessThan(0.002);
    expect(amplitude(audio, 660, 2.2, 2.6)).toBeGreaterThan(0.08);
  }, 60000);

  it('materializes a native packet-clock gap instead of shifting later audio earlier', async () => {
    const bytes = await encoded(2, 770, { filters: 'aselect=not(between(t\\,0.8\\,1.2))' });
    await source(bytes, { end: 2000 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'));
    const audio = await decoded(result.outputPath);
    expect(result.warnings.some(warning => warning.kind === 'native-source-timestamp-gaps')).toBe(true);
    expect(amplitude(audio, 770, 0.2, 0.6)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 770, 0.95, 1.1)).toBeLessThan(0.002);
    expect(amplitude(audio, 770, 1.5, 1.8)).toBeGreaterThan(0.08);
    expect(audio.samples / 48000).toBeCloseTo(2, 2);
  }, 60000);

  it('includes active-time AudioTee PCM once and rejects simultaneous native system copies', async () => {
    await source(await encoded(1, 440), { end: 1000 });
    await fs.promises.writeFile(path.join(root, 'system_audio.raw'), wave(1, 660).subarray(44));
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'));
    expect(result.systemPcmIncluded).toBe(true);
    expect(result.fastPathUsed).toBe(true);
    const audio = await decoded(result.outputPath);
    expect(amplitude(audio, 440, 0.2, 0.8)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 660, 0.2, 0.8)).toBeGreaterThan(0.08);
    await source(await encoded(1, 660), { kind: 'system', end: 1000 });
    const before = fs.readFileSync(result.outputPath);
    await expect(finalizer().build(root, result.outputPath)).rejects.toThrow('twice');
    expect(fs.readFileSync(result.outputPath).equals(before)).toBe(true);
  }, 60000);

  it('retains interrupted tails beyond a stop-clock estimate and makes recovery explicit', async () => {
    const id = await source(await encoded(1.2, 440));
    await expect(finalizer().build(root, path.join(root, 'audio_building.webm'))).rejects.toThrow('not durably closed');
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'), { recovery: true, expectedDurationSec: 1 });
    expect(result.warnings).toContainEqual({ kind: 'native-source-interrupted', sourceId: id });
    const audio = await decoded(result.outputPath);
    expect(audio.samples / 48000).toBeCloseTo(1.2, 2);
    expect(amplitude(audio, 440, 1.05, 1.15)).toBeGreaterThan(0.08);
  }, 60000);

  it('pads a delayed source at active zero without shifting its content earlier or allocating FLAC', async () => {
    await source(await encoded(1, 440), { start: 200, end: 1200 });
    const estimates = [];
    const result = await finalizer({ checkSpace: async bytes => estimates.push(bytes) }).build(root, path.join(root, 'audio_building.webm'));
    const audio = await decoded(result.outputPath);
    expect(result.fastPathUsed).toBe(true);
    expect(amplitude(audio, 440, 0.03, 0.15)).toBeLessThan(0.002);
    expect(amplitude(audio, 440, 0.4, 0.9)).toBeGreaterThan(0.08);
    expect(audio.samples / 48000).toBeCloseTo(1.2, 2);
    expect(estimates).toHaveLength(1);
    expect(estimates[0]).toBeLessThan(70 * 1024 * 1024);
  }, 60000);

  it('preserves ordinary stopped tails and checks space again before a two-lane fallback', async () => {
    await source(await encoded(1.2, 440), { end: 1000 });
    await source(await encoded(1, 660), { kind: 'system', end: 1000 });
    const estimates = [];
    const result = await finalizer({ checkSpace: async bytes => estimates.push(bytes) }).build(root, path.join(root, 'audio_building.webm'));
    const audio = await decoded(result.outputPath);
    expect(result.fastPathUsed).toBe(false);
    expect(estimates).toHaveLength(2);
    expect(estimates[1]).toBeGreaterThan(estimates[0]);
    expect(audio.samples / 48000).toBeCloseTo(1.2, 2);
    expect(amplitude(audio, 440, 1.05, 1.15)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 440, 1.05, 1.15)).toBeLessThan(0.12);
    expect(result.warnings.some(warning => warning.kind === 'native-source-fast-path-tail-fallback')).toBe(true);
  }, 60000);

  it('streams a late source offset through a silence segment instead of buffering it in the resampler', async () => {
    await source(await encoded(0.5, 440), { start: 6000, end: 6500 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'));
    expect(result.fastPathUsed).toBe(false);
    const audio = await decoded(result.outputPath);
    expect(audio.samples / 48000).toBeCloseTo(6.5, 2);
    expect(amplitude(audio, 440, 5.5, 5.9)).toBeLessThan(0.002);
    expect(amplitude(audio, 440, 6.1, 6.4)).toBeGreaterThan(0.08);
  }, 60000);

  it('leaves original and previous output untouched when space or final encoding fails', async () => {
    const bytes = await encoded(1, 440);
    await source(bytes, { end: 1000 });
    const output = path.join(root, 'audio_building.webm');
    await fs.promises.writeFile(output, 'previous output');
    const spaceError = Object.assign(new Error('Insufficient scratch space'), { code: 'ENOSPC' });
    await expect(finalizer({ checkSpace: async () => { throw spaceError; } }).build(root, output)).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(finalizer({ run: async () => { throw new Error('encoder failed'); } }).build(root, output)).rejects.toThrow('encoder failed');
    expect(fs.readFileSync(output, 'utf8')).toBe('previous output');
    expect(Buffer.concat(inspectNativeSources(root)[0].chunkPaths.map(file => fs.readFileSync(file))).equals(bytes)).toBe(true);
  }, 60000);

  it('keeps previous output and original bytes when input decoding or a later render fails', async () => {
    const original = Buffer.from('not-a-recording-but-preserved-source-bytes');
    const id = await source(original, { end: 1000 });
    const output = path.join(root, 'audio_building.webm');
    await fs.promises.writeFile(output, 'previous playable output');
    await expect(finalizer().build(root, output)).rejects.toThrow();
    expect(fs.readFileSync(output, 'utf8')).toBe('previous playable output');
    expect(Buffer.concat(inspectNativeSources(root).find(item => item.sourceId === id).chunkPaths.map(file => fs.readFileSync(file))).equals(original)).toBe(true);
  }, 60000);
});

describe('native timeline policy', () => {
  it('uses integer timestamps at five hours, bounds examples, and detects reversed source timing', () => {
    const evidence = createTimestampEvidence();
    const origin = 5 * 3600 * 48000;
    for (let index = 0; index < 150; index++) evidence.consume(`[Parsed_ashowinfo_1] n:${index} pts:${origin + index * 5760} pts_time:18000 rate:48000 nb_samples:2880`);
    evidence.consume(`[Parsed_ashowinfo_1] n:150 pts:${origin + 149 * 5760} pts_time:18000 rate:48000 nb_samples:2880`);
    const result = evidence.result();
    expect(result.gapCount).toBe(149);
    expect(result.overlapCount).toBe(1);
    expect(result.examples).toHaveLength(100);
    expect(result.firstPts).toBe(origin);
    evidence.consume('[aresample] Failed to compensate for timestamp delta of 3600');
    expect(evidence.result().resamplerFailure).toContain('Failed to compensate');
  });

  it('rejects ambiguous pause overlap while preserving an interrupted predecessor with no surviving successor', () => {
    const base = { sourceId: 'a', kind: 'microphone', startSample: 0, mediaSamples: 96000, normalizedPath: 'a.flac', endOffsetMs: 1000 };
    expect(() => planLane([{ ...base, reason: 'paused' }, { ...base, sourceId: 'b', startSample: 48000 }], [])).toThrow('overlap');
    expect(planLane([{ ...base, reason: 'replacement' }], []).segments[0].samples).toBe(96000);
    const warnings = [];
    expect(planLane([{ ...base, mediaSamples: 48048 }, { ...base, sourceId: 'b', startSample: 48000, mediaSamples: 100 }], warnings).samples).toBe(48148);
    expect(warnings[0]).toMatchObject({ kind: 'native-source-seam-rounding', shiftedSamples: 48 });
  });

  it('provides a conservative disk budget with no decoded-meeting RAM allocation', () => {
    expect(estimateScratchBytes({ sourceBytes: 100, timelineSeconds: 1, lanes: 2 })).toBe(100 + 48000 * 2 * 3 * 2 * 2 + 24000 + 64 * 1024 * 1024);
    expect(() => estimateScratchBytes({ timelineSeconds: Infinity })).toThrow('Invalid');
  });
});
