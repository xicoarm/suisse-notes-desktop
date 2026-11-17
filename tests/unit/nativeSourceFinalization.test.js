// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const ffmpeg = require('fluent-ffmpeg');
// The packaged Mac workflow can run this same real-media suite against its
// attested Contents/Resources binaries. Never fall back if one override is missing.
const overrideFfmpeg = process.env.SUISSE_TEST_FFMPEG_PATH;
const overrideFfprobe = process.env.SUISSE_TEST_FFPROBE_PATH;
if (!!overrideFfmpeg !== !!overrideFfprobe) throw new Error('Media compatibility requires both explicit binary paths');
for (const file of [overrideFfmpeg, overrideFfprobe].filter(Boolean)) {
  if (!path.isAbsolute(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Media compatibility requires absolute regular binary paths');
}
const FFMPEG = overrideFfmpeg || require('@ffmpeg-installer/ffmpeg').path;
const FFPROBE = overrideFfprobe || require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfmpegPath(FFMPEG);
ffmpeg.setFfprobePath(FFPROBE);
const { createNativeSourceFinalization, createTimestampEvidence, planLane, estimateScratchBytes, estimateEncodedBytes } = require('../../src-electron/native-source-finalization');
const { validateNativeMedia } = require('../../src-electron/native-media-validation');
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
  // The production watchdog subscribes to progress. This activates fluent's
  // input-metadata hook and catches no-input silence graphs that otherwise pass.
  return createNativeSourceFinalization({ ffmpeg, run: (command, ...args) => {
    expect(command._inputs.length).toBeGreaterThan(0);
    return run(command.on('progress', () => {}), ...args);
  }, ffprobePath: FFPROBE,
    validate: validateNativeMedia,
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
// Decodes only [from, to) of a long output; times inside are window-relative.
async function decodedWindow(file, from, to) {
  const raw = path.join(root, `window-${randomUUID()}.raw`);
  await run(ffmpeg(file).audioFilters(`atrim=start_sample=${Math.round(from * 48000)}:end_sample=${Math.round(to * 48000)}`)
    .audioCodec('pcm_f32le').audioFrequency(48000).audioChannels(2).format('f32le').output(raw));
  const data = fs.readFileSync(raw);
  return { data, samples: data.length / 8 };
}
// Six minutes without packets inside one encoder stream (sleep, stalled device).
// The timestamp resampler would have to buffer all of it and fails (ELECTRON-7R).
const LONG_GAP_SECONDS = 360;
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
  it.each(['fast', 'general'].flatMap(mode => [5, 95, 96, 97].flatMap(offsetSamples =>
    [false, true].map(interrupted => ({ mode, offsetSamples, interrupted })))))('preserves the $offsetSamples-sample onset through $mode finalization (interrupted=$interrupted)', async ({ mode, offsetSamples, interrupted }) => {
    // Two non-harmonic tones make the sample offset identifiable independently
    // of total duration. Appending silence at the end cannot satisfy this test.
    const wav = path.join(root, 'onset.wav'), native = path.join(root, 'onset.webm');
    const data = wave(0.25, 997, { stereo: true, antiPhase: true });
    for (let index = 0; index < 12000; index++) {
      const extra = Math.round(Math.sin(2 * Math.PI * 1709 * index / 48000) * 0.05 * 32767);
      const value = data.readInt16LE(44 + index * 4) + extra;
      data.writeInt16LE(value, 44 + index * 4);
      data.writeInt16LE(-value, 44 + index * 4 + 2);
    }
    fs.writeFileSync(wav, data);
    await run(ffmpeg(wav).audioCodec('libopus').output(native));
    const bytes = fs.readFileSync(native), reference = await decoded(native);
    expect(reference.samples).toBe(12000);
    // Match the exact observed crash offset; the other cases straddle the
    // resampler's 2 ms / 96-sample hard-compensation threshold.
    const start = offsetSamples === 5 ? 0.10000000009313226 : offsetSamples / 48;
    await source(bytes, { start, end: interrupted && mode === 'fast' ? undefined : start + 250,
      reason: mode === 'general' ? 'paused' : 'stopped', channels: 2 });
    if (mode === 'general') await source(bytes, { start: start + 250,
      end: interrupted ? undefined : start + 500, channels: 2 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'), { recovery: interrupted });
    const audio = await decoded(result.outputPath);
    const expectedSamples = (mode === 'fast' ? 12000 : 24000) + offsetSamples;
    expect(result.fastPathUsed).toBe(mode === 'fast');
    expect(result.plan.totalSamples).toBe(expectedSamples);
    expect(audio.samples).toBe(expectedSamples);
    expect(result.plan.validation.observedDecodedSamples).toBe(expectedSamples);
    if (mode === 'general') {
      const seed = fs.readFileSync(path.join(result.scratchDirectory, 'silence-frame.wav'));
      expect(seed.length).toBe(48);
      expect(seed.readUInt16LE(22)).toBe(2);
      expect(seed.readUInt32LE(24)).toBe(48000);
      expect(seed.readUInt32LE(40)).toBe(4);
      expect(seed.subarray(44)).toEqual(Buffer.alloc(4));
    }
    for (const channel of [0, 1]) {
      let bestDelay = null, bestError = Infinity;
      for (let delay = 0; delay <= 102; delay++) {
        let error = 0;
        for (let index = 2000; index < 8000; index++) {
          const delta = audio.data.readFloatLE((index + delay) * 8 + channel * 4) - reference.data.readFloatLE(index * 8 + channel * 4);
          error += delta * delta;
        }
        if (error < bestError) { bestError = error; bestDelay = delay; }
      }
      expect(bestDelay).toBe(offsetSamples);
      expect(bestError / 6000).toBeLessThan(0.00001);
    }
    for (const archived of inspectNativeSources(root)) {
      expect(Buffer.concat(archived.chunkPaths.map(file => fs.readFileSync(file))).equals(bytes)).toBe(true);
    }
  }, 60000);

  it.each(['fast', 'general'])('preserves mono microphone unity gain in both stereo channels through the %s path', async mode => {
    await source(await encoded(1, 440), { end: 1000 });
    if (mode === 'general') await source(await encoded(1, 880), { start: 1000, end: 2000 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'));
    const audio = await decoded(result.outputPath);
    expect(result.fastPathUsed).toBe(mode === 'fast');
    expect(audio.samples).toBe(mode === 'fast' ? 48000 : 96000);
    for (const channel of [0, 1]) {
      expect(amplitude(audio, 440, 0.2, 0.8, channel)).toBeGreaterThan(0.095);
      expect(amplitude(audio, 440, 0.2, 0.8, channel)).toBeLessThan(0.105);
      if (mode === 'general') {
        expect(amplitude(audio, 880, 1.2, 1.8, channel)).toBeGreaterThan(0.095);
        expect(amplitude(audio, 880, 1.2, 1.8, channel)).toBeLessThan(0.105);
      }
    }
  }, 60000);

  it.each(['fast', 'general'])('bounds %s output with 192-kbit CBR packets while preserving stereo and fractional sample count', async mode => {
    const targetSeconds = 12.345;
    await source(await encoded(mode === 'fast' ? 12 : 6, 440, { stereo: true, antiPhase: true }),
      { end: mode === 'fast' ? targetSeconds * 1000 : 6000, reason: mode === 'fast' ? 'stopped' : 'paused', channels: 2 });
    if (mode === 'general') await source(await encoded(6, 880, { stereo: true, antiPhase: true }),
      { start: 6000, end: targetSeconds * 1000, channels: 2 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'), { expectedDurationSec: targetSeconds });
    const { stdout } = await promisify(execFile)(FFPROBE,
      ['-v', 'error', '-select_streams', 'a', '-show_packets', '-show_streams', '-show_entries',
        'packet=size,duration_time:stream=codec_name,sample_rate,channels', '-of', 'json', result.outputPath],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    const packetEvidence = JSON.parse(stdout);
    expect(packetEvidence.streams).toEqual([expect.objectContaining({ codec_name: 'opus', sample_rate: '48000', channels: 2 })]);
    expect(packetEvidence.packets.length).toBeGreaterThan(600);
    expect(new Set(packetEvidence.packets.map(packet => Number(packet.size)))).toEqual(new Set([480]));
    // Container duration may trim the last packet on newer Matroska muxers.
    // Production now proves actual coded duration from hash-bound Opus bytes;
    // exact independently decoded sample count below remains the contract.
    expect(packetEvidence.packets.every(packet => Number(packet.duration_time) > 0 && Number(packet.duration_time) <= 0.02)).toBe(true);
    expect(result.plan.validation.encodedPacketEvidence).toMatchObject({
      minPacketSamples: 960, maxPacketSamples: 960, packets: packetEvidence.packets.length,
      codedSampleEvidence: { method: 'sha256-bound-webm-opus-framing', packets: packetEvidence.packets.length }
    });
    const audio = await decoded(result.outputPath);
    expect(audio.samples).toBe(Math.round(targetSeconds * 48000));
    for (const channel of [0, 1]) {
      expect(amplitude(audio, 440, 0.5, 5.5, channel)).toBeGreaterThan(0.08);
      if (mode === 'general') expect(amplitude(audio, 880, 7, 11, channel)).toBeGreaterThan(0.08);
    }
    const outputBytes = fs.statSync(result.outputPath).size;
    expect(outputBytes / targetSeconds).toBeGreaterThan(24000);
    expect(outputBytes / targetSeconds).toBeLessThan(25000);
    expect(outputBytes).toBeLessThan(estimateEncodedBytes(targetSeconds));
    expect(result.plan.validation).toMatchObject({ observedOutputBytes: outputBytes,
      observedDecodedSamples: audio.samples, estimatedMaximumOutputBytes: estimateEncodedBytes(targetSeconds) });
    expect(result.plan.codecPolicy).toBe('opus-cbr-192k-20ms-reencoded-from-native-sources');
    expect(result.plan.encoding).toEqual({ codec: 'opus', sampleRate: 48000, channels: 2, bitRate: 192000, bitRateMode: 'cbr', frameDurationMs: 20 });
    expect(result.fastPathUsed).toBe(mode === 'fast');
    expect(Math.max(...commands)).toBeLessThanOrEqual(2);
  }, 60000);

  it('finalizes a normal stop around a closed auto-recovery candidate that saved no audio (ELECTRON-66)', async () => {
    // Device loss: the dead "Default" alias is tried, emits no blob, and is
    // replaced by a working microphone. Its end marker durably confirms zero chunks.
    await source(await encoded(1, 440), { end: 1000, reason: 'device-ended' });
    const empty = randomUUID();
    await beginSource(root, { sourceId: empty, kind: 'microphone', startOffsetMs: 1000, mimeType: 'audio/webm;codecs=opus', settings: { channelCount: 1 } });
    await markSourceStarted(root, empty, { startOffsetMs: 1000 });
    await endSource(root, empty, { endOffsetMs: 1500, chunkCount: 0, reason: 'replacement' });
    await source(await encoded(1, 880), { start: 1500, end: 2500 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'), { expectedDurationSec: 2.5 });
    const audio = await decoded(result.outputPath);
    expect(audio.samples).toBe(120000);
    expect(amplitude(audio, 440, 0.2, 0.8)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 880, 1.7, 2.3)).toBeGreaterThan(0.08);
    expect(result.warnings).toContainEqual({ kind: 'native-source-audio-missing', sourceId: empty, confirmedEmpty: true });
    expect(result.sourceIds).not.toContain(empty);
  }, 60000);

  it('still refuses a normal stop whose only started source saved no audio', async () => {
    const empty = randomUUID();
    await beginSource(root, { sourceId: empty, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm;codecs=opus', settings: { channelCount: 1 } });
    await markSourceStarted(root, empty, { startOffsetMs: 0 });
    await endSource(root, empty, { endOffsetMs: 1000, chunkCount: 0, reason: 'stopped' });
    await expect(finalizer().build(root, path.join(root, 'audio_building.webm'))).rejects.toThrow(/No acknowledged native audio/);
  });

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

  it.each(['fast', 'general'].flatMap(mode => [0, 5].map(offsetSamples => ({ mode, offsetSamples }))))('materializes a native packet-clock gap in the $mode path with a $offsetSamples-sample onset', async ({ mode, offsetSamples }) => {
    const start = offsetSamples / 48;
    const bytes = await encoded(2, 770, { filters: 'aselect=not(between(t\\,0.8\\,1.2))' });
    await source(bytes, { start, end: start + 2000 });
    if (mode === 'general') await source(await encoded(1, 880), { start: start + 2000, end: start + 3000 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'));
    const audio = await decoded(result.outputPath);
    expect(result.warnings.some(warning => warning.kind === 'native-source-timestamp-gaps')).toBe(true);
    expect(amplitude(audio, 770, 0.2, 0.6)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 770, 0.95, 1.1)).toBeLessThan(0.002);
    expect(amplitude(audio, 770, 1.5, 1.8)).toBeGreaterThan(0.08);
    expect(audio.samples).toBe((mode === 'fast' ? 96000 : 144000) + offsetSamples);
    expect(result.fastPathUsed).toBe(mode === 'fast');
    if (mode === 'general') expect(amplitude(audio, 880, 2.2, 2.8)).toBeGreaterThan(0.08);
  }, 60000);

  it.each(['fast', 'general'])('keeps every sample of a source with overlapping native timestamps in the %s path (ELECTRON-68)', async mode => {
    // A backward clock step inside one encoder stream: 0.3 s of the 880-Hz
    // half is stamped on top of the 440-Hz half. Distinct speech, not duplicates.
    const webm = path.join(root, `${randomUUID()}.webm`);
    await run(ffmpeg().input('sine=f=440:d=1:r=48000').inputFormat('lavfi').input('sine=f=880:d=1:r=48000').inputFormat('lavfi')
      .complexFilter("[0][1]concat=n=2:v=0:a=1,asetpts='if(gte(T,1),PTS-0.3/TB,PTS)'").audioCodec('libopus').output(webm));
    const overlapped = await source(fs.readFileSync(webm), { end: 2000 });
    if (mode === 'general') await source(await encoded(1, 660), { start: 2000, end: 3000 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'));
    const audio = await decoded(result.outputPath);
    expect(result.fastPathUsed).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ kind: 'native-source-timestamp-overlap', sourceId: overlapped, timeline: 'sample-order' }));
    expect(amplitude(audio, 440, 0.2, 0.8)).toBeGreaterThan(0.08);
    // The overlapped start of the 880-Hz half survives instead of being dropped.
    expect(amplitude(audio, 880, 1.05, 1.3)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 880, 1.5, 1.9)).toBeGreaterThan(0.08);
    expect(audio.samples).toBeGreaterThanOrEqual(mode === 'fast' ? 96000 : 144000);
    if (mode === 'general') expect(amplitude(audio, 660, 2.2, 2.8)).toBeGreaterThan(0.08);
  }, 60000);

  it.each(['fast', 'general'])('finalizes a clock gap too long for the timestamp resampler in the %s path, keeping speech at its time (ELECTRON-7R)', async mode => {
    const webm = path.join(root, `${randomUUID()}.webm`);
    await run(ffmpeg().input('sine=f=440:d=1:r=48000').inputFormat('lavfi').input('sine=f=880:d=1:r=48000').inputFormat('lavfi')
      .complexFilter(`[0][1]concat=n=2:v=0:a=1,asetpts='if(gte(T,1),PTS+${LONG_GAP_SECONDS}/TB,PTS)'`).audioCodec('libopus').output(webm));
    const end = (LONG_GAP_SECONDS + 2) * 1000;
    const gapped = await source(fs.readFileSync(webm), { end });
    if (mode === 'general') await source(await encoded(1, 660), { start: end, end: end + 1000 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'));
    expect(result.fastPathUsed).toBe(false);
    if (mode === 'fast') expect(result.warnings).toContainEqual({ kind: 'native-source-fast-path-resample-fallback' });
    expect(result.warnings).toContainEqual(expect.objectContaining({ kind: 'native-source-timestamp-resample-fallback', sourceId: gapped,
      timeline: 'sample-order-restored-gaps', restoredGapCount: 1, onsetIsApproximate: true }));
    const evidence = result.plan.sourceEvidence.find(item => item.sourceId === gapped);
    expect(evidence.timing.resamplerFailure).toMatch(/Failed to compensate|Cannot allocate memory/);
    expect(evidence.restoredGaps).toHaveLength(1);
    expect(Math.abs(evidence.restoredGaps[0].silenceSamples - LONG_GAP_SECONDS * 48000)).toBeLessThan(960);
    const expectedSamples = (LONG_GAP_SECONDS + (mode === 'fast' ? 2 : 3)) * 48000;
    expect(Math.abs(result.plan.totalSamples - expectedSamples)).toBeLessThanOrEqual(96);
    expect(result.plan.validation.observedDecodedSamples).toBe(result.plan.totalSamples);
    const head = await decodedWindow(result.outputPath, 0, 2);
    expect(amplitude(head, 440, 0.2, 0.8)).toBeGreaterThan(0.08);
    // A collapsed timeline would put the second tone right here.
    expect(amplitude(head, 880, 1.2, 1.8)).toBeLessThan(0.002);
    const outage = await decodedWindow(result.outputPath, 100, 101);
    for (const hz of [440, 880]) expect(amplitude(outage, hz, 0, 1)).toBeLessThan(0.002);
    const resumed = await decodedWindow(result.outputPath, LONG_GAP_SECONDS, LONG_GAP_SECONDS + 3);
    expect(amplitude(resumed, 880, 0.2, 0.9)).toBeLessThan(0.002);
    expect(amplitude(resumed, 880, 1.1, 1.9)).toBeGreaterThan(0.08);
    if (mode === 'general') expect(amplitude(resumed, 660, 2.2, 2.8)).toBeGreaterThan(0.08);
    const archived = inspectNativeSources(root).find(item => item.sourceId === gapped);
    expect(Buffer.concat(archived.chunkPaths.map(file => fs.readFileSync(file))).equals(fs.readFileSync(webm))).toBe(true);
  }, 120000);

  it('replays a source that both overlaps and exceeds the resampler buffer in plain sample order (ELECTRON-7R)', async () => {
    const webm = path.join(root, `${randomUUID()}.webm`);
    await run(ffmpeg().input('sine=f=440:d=1:r=48000').inputFormat('lavfi').input('sine=f=880:d=1:r=48000').inputFormat('lavfi')
      .input('sine=f=660:d=1:r=48000').inputFormat('lavfi')
      .complexFilter(`[0][1][2]concat=n=3:v=0:a=1,asetpts='if(gte(T,2),PTS+${LONG_GAP_SECONDS - 0.3}/TB,if(gte(T,1),PTS-0.3/TB,PTS))'`)
      .audioCodec('libopus').output(webm));
    const id = await source(fs.readFileSync(webm), { end: 3000 });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'));
    expect(result.warnings).toContainEqual({ kind: 'native-source-fast-path-resample-fallback' });
    expect(result.warnings).toContainEqual(expect.objectContaining({ kind: 'native-source-timestamp-overlap', sourceId: id, timeline: 'sample-order' }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ kind: 'native-source-timestamp-resample-fallback', sourceId: id,
      timeline: 'sample-order', restoredGapCount: 0, onsetIsApproximate: true }));
    const audio = await decoded(result.outputPath);
    expect(audio.samples).toBeGreaterThanOrEqual(144000);
    expect(audio.samples).toBeLessThan(150000);
    expect(amplitude(audio, 440, 0.2, 0.8)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 880, 1.05, 1.9)).toBeGreaterThan(0.08);
    expect(amplitude(audio, 660, 2.2, 2.8)).toBeGreaterThan(0.08);
  }, 120000);

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

  it('validates decoded samples despite fractional-stop Opus discard padding extending container duration', async () => {
    const targetMs = 46893.90000000596;
    await source(await encoded(1, 440), { end: targetMs });
    const result = await finalizer().build(root, path.join(root, 'audio_building.webm'), { expectedDurationSec: targetMs / 1000 });
    const expectedSamples = Math.round(targetMs * 48);
    expect(result.plan.validation).toMatchObject({ status: 'passed', expectedDecodedSamples: expectedSamples, observedDecodedSamples: expectedSamples });
    expect(result.containerDuration - result.duration).toBeGreaterThan(0.025);
    expect(result.plan.validation.encodedPacketEvidence.discardPaddingSamples).toBeGreaterThan(0);
    expect((await decoded(result.outputPath)).samples).toBe(expectedSamples);
  }, 60000);

  it('finalizes a source whose timestamps run ahead of its samples by less than the resampler threshold (ELECTRON-73)', async () => {
    // One millisecond of clock jitter inside one encoder stream. It is below
    // the resampler's 2 ms hard-compensation threshold, so no sample is
    // inserted, while the timestamp span grows by that millisecond. The source
    // reaches its planned end, so end padding cannot hide the difference: the
    // one-command path predicts 48 samples more than the file can contain.
    const webm = path.join(root, `${randomUUID()}.webm`);
    await run(ffmpeg().input('sine=f=440:d=1:r=48000').inputFormat('lavfi')
      .audioFilters("asetpts='if(gte(T,0.5),PTS+0.001/TB,PTS)'").audioCodec('libopus').output(webm));
    const bytes = fs.readFileSync(webm), reference = await decoded(webm);
    expect(reference.samples).toBe(48000);
    const jittered = await source(bytes, { end: 1000 });
    const estimates = [];
    const result = await finalizer({ checkSpace: async size => estimates.push(size) })
      .build(root, path.join(root, 'audio_building.webm'), { expectedDurationSec: 1 });
    // The complete recording is published from measured source lengths
    // instead of being stranded behind the timestamp prediction.
    expect(result.fastPathUsed).toBe(false);
    const fallback = result.plan.fastPathFallback;
    // A miss within the timing tolerance is marked as the known rounding.
    expect(fallback).toMatchObject({ reason: 'sample-count', observedDecodedSamples: 48000, withinTimingTolerance: true });
    expect(fallback.expectedDecodedSamples - fallback.observedDecodedSamples).toBeGreaterThan(1);
    expect(fallback.expectedDecodedSamples - fallback.observedDecodedSamples).toBeLessThanOrEqual(96);
    // Every sample is kept, so History gets no "review audio" warning for it.
    expect(result.warnings.some(warning => warning.kind.startsWith('native-source-fast-path'))).toBe(false);
    expect(estimates).toHaveLength(2);
    expect(estimates[1]).toBeGreaterThan(estimates[0]);
    expect(result.plan.validation).toMatchObject({ status: 'passed', expectedDecodedSamples: 48000, observedDecodedSamples: 48000 });
    const audio = await decoded(result.outputPath);
    expect(audio.samples).toBe(48000);
    // The generated tone has an amplitude of 1/8; the mono source reaches
    // both channels at unity before and after the jitter.
    for (const [from, to] of [[0.1, 0.4], [0.6, 0.9]]) {
      for (const channel of [0, 1]) {
        expect(amplitude(audio, 440, from, to, channel)).toBeGreaterThan(0.118);
        expect(amplitude(audio, 440, from, to, channel)).toBeLessThan(0.132);
      }
    }
    // The refused one-command render and its own plan stay as evidence;
    // plan.json describes the measured rebuild that was published.
    expect(fs.existsSync(path.join(result.scratchDirectory, 'fast-rendered.webm'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(result.scratchDirectory, 'fast-plan.json'), 'utf8'))).toMatchObject({ fastPathUsed: true,
      validation: { status: 'failed', expectedDecodedSamples: fallback.expectedDecodedSamples, observedDecodedSamples: 48000,
        error: { code: 'NATIVE_FINALIZATION_SAMPLE_COUNT' } } });
    expect(JSON.parse(fs.readFileSync(path.join(result.scratchDirectory, 'plan.json'), 'utf8'))).toMatchObject({ fastPathUsed: false,
      fastPathFallback: fallback, validation: { status: 'passed' } });
    const archived = inspectNativeSources(root).find(item => item.sourceId === jittered);
    expect(Buffer.concat(archived.chunkPaths.map(file => fs.readFileSync(file))).equals(bytes)).toBe(true);
  }, 60000);

  it('still refuses a recording whose sample count differs from its measured plan (ELECTRON-73)', async () => {
    // The fallback replaces a timestamp prediction by measured lengths. A
    // difference that survives measuring is a real defect and must never be
    // published: here the measurement itself reports half a millisecond more
    // than the source holds, so the encoded file is 24 samples short of it.
    const webm = path.join(root, `${randomUUID()}.webm`);
    await run(ffmpeg().input('sine=f=440:d=1:r=48000').inputFormat('lavfi')
      .audioFilters("asetpts='if(gte(T,0.5),PTS+0.001/TB,PTS)'").audioCodec('libopus').output(webm));
    const bytes = fs.readFileSync(webm);
    const jittered = await source(bytes, { end: 1000 });
    const output = path.join(root, 'audio_building.webm');
    await fs.promises.writeFile(output, 'previous output');
    const probe = async file => Number((await metadata(file)).format.duration) + (file.endsWith('.flac') ? 0.0005 : 0);
    const error = await finalizer({ probe }).build(root, output, { expectedDurationSec: 1 }).catch(caught => caught);
    expect(error).toMatchObject({ code: 'NATIVE_FINALIZATION_SAMPLE_COUNT', expectedDecodedSamples: 48024, actualDecodedSamples: 48000 });
    // The failure still says which prediction sent the build into the rebuild.
    expect(error.fastPathFallback).toMatchObject({ reason: 'sample-count', observedDecodedSamples: 48000 });
    expect(error.fastPathFallback.expectedDecodedSamples).toBeGreaterThan(48024);
    expect(fs.readFileSync(output, 'utf8')).toBe('previous output');
    const plan = JSON.parse(fs.readFileSync(path.join(error.scratchDirectory, 'plan.json'), 'utf8'));
    expect(plan).toMatchObject({ fastPathUsed: false, fastPathFallback: error.fastPathFallback,
      validation: { status: 'failed', error: { code: 'NATIVE_FINALIZATION_SAMPLE_COUNT' } } });
    expect(JSON.parse(fs.readFileSync(path.join(error.scratchDirectory, 'fast-plan.json'), 'utf8'))).toMatchObject({ fastPathUsed: true,
      validation: { status: 'failed', error: { code: 'NATIVE_FINALIZATION_SAMPLE_COUNT' } } });
    const archived = inspectNativeSources(root).find(item => item.sourceId === jittered);
    expect(Buffer.concat(archived.chunkPaths.map(file => fs.readFileSync(file))).equals(bytes)).toBe(true);
  }, 60000);

  it('does not rebuild after a one-command render that is refused for another reason (ELECTRON-73)', async () => {
    // Only a missed length prediction is answered with the measured rebuild.
    // Here the encoded file itself reports no usable length: it stays refused.
    await source(await encoded(1, 440), { end: 1000 });
    const output = path.join(root, 'audio_building.webm');
    await fs.promises.writeFile(output, 'previous output');
    const estimates = [];
    const probe = async file => path.basename(file) === 'fast-rendered.webm' ? 0 : Number((await metadata(file)).format.duration);
    const error = await finalizer({ probe, checkSpace: async size => estimates.push(size) })
      .build(root, output, { expectedDurationSec: 1 }).catch(caught => caught);
    expect(error.code).toBe('NATIVE_FINALIZATION_INVALID');
    expect(error.message).toBe('Native audio decoded to an empty or invalid timeline; original native audio is retained');
    expect(error.fastPathFallback).toBeUndefined();
    // One space check only: the rebuild, which checks space again, never ran.
    expect(estimates).toHaveLength(1);
    expect(fs.readFileSync(output, 'utf8')).toBe('previous output');
    expect(fs.existsSync(path.join(error.scratchDirectory, 'fast-plan.json'))).toBe(false);
    const plan = JSON.parse(fs.readFileSync(path.join(error.scratchDirectory, 'plan.json'), 'utf8'));
    expect(plan).toMatchObject({ fastPathUsed: true, validation: { status: 'failed', error: { code: 'NATIVE_FINALIZATION_INVALID' } } });
    expect(plan.fastPathFallback).toBeUndefined();
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

describe('bundled resampler compatibility controls', () => {
  it.each([{ rate: 48000, stereo: false }, { rate: 44100, stereo: true, antiPhase: true }])(
    'retains identical old-binary PCM without the removed layout alias ($rate Hz, stereo=$stereo)', async options => {
      const wav = path.join(root, 'compatibility.wav');
      fs.writeFileSync(wav, wave(0.25, 440, options));
      const stereo = 'pan=stereo|c0=FL+FC+0.707*BL+0.707*SL+0.5*LFE|c1=FR+FC+0.707*BR+0.707*SR+0.5*LFE';
      const clock = 'clev=1:async=1:first_pts=0:min_hard_comp=0.002:max_soft_comp=0';
      const execute = legacy => promisify(execFile)(FFMPEG, ['-nostdin', '-hide_banner', '-v', 'error', '-i', wav,
        '-af', `${stereo},aresample=48000:${legacy ? 'ocl=stereo:' : ''}${clock}`,
        '-threads', '1', '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'buffer' });
      const corrected = await execute(false);
      expect(corrected.stdout.length).toBe(12000 * 8);
      let previous, legacyError;
      try { previous = await execute(true); } catch (error) { legacyError = error; }
      if (previous) expect(corrected.stdout.equals(previous.stdout)).toBe(true);
      else {
        // New FFmpeg must reproduce the exact removed-option rejection, not a
        // generic spawn/timeout/codec failure that could conceal a bad fixture.
        expect(String(legacyError.stderr)).toMatch(/ocl/);
        expect(String(legacyError.stderr)).toMatch(/Option not found|option.*not found/i);
      }
      const { stdout: version } = await promisify(execFile)(FFMPEG, ['-version'], { windowsHide: true, timeout: 5000 });
      console.info('resampler-compatibility', JSON.stringify({ binary: FFMPEG,
        sha256: createHash('sha256').update(fs.readFileSync(FFMPEG)).digest('hex'),
        version: version.split(/\r?\n/)[0], input: options, decodedSamples: corrected.stdout.length / 8,
        legacyAliasAccepted: !!previous, legacyStderr: legacyError ? String(legacyError.stderr).slice(0, 2048) : null,
        identicalLegacyPcm: previous ? corrected.stdout.equals(previous.stdout) : null }));
    }, 20000);
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

  it('records where long gaps sit in sample order and stops after a bounded number (ELECTRON-7R)', () => {
    const evidence = createTimestampEvidence();
    const frame = (index, pts) => evidence.consume(`[Parsed_ashowinfo_1] n:${index} pts:${pts} pts_time:0 rate:48000 nb_samples:960`);
    let pts = 312;
    frame(0, pts);
    pts += 960 + 200 * 48000; frame(1, pts); // 200-s outage: restorable
    pts += 960 + 4800; frame(2, pts); // 0.1-s gap: closes in sample order
    expect(evidence.restorableGaps()).toEqual({ gaps: [{ decodedSamples: 960, timelineSample: 960 + 200 * 48000 }], overflow: false });
    expect(evidence.result()).toMatchObject({ gapCount: 2, decodedSamples: 2880 });
    for (let index = 3; index < 67; index++) { pts += 960 + 48000; frame(index, pts); }
    expect(evidence.restorableGaps().gaps).toHaveLength(64);
    expect(evidence.restorableGaps().overflow).toBe(true);
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
    const encodedBudget = (50 + 4) * (480 + 64) + 64 * 1024;
    expect(estimateEncodedBytes(1)).toBe(encodedBudget);
    expect(estimateScratchBytes({ sourceBytes: 100, timelineSeconds: 1, lanes: 2 })).toBe(100 + 48000 * 2 * 3 * 2 * 2 + encodedBudget + 64 * 1024 * 1024);
    expect(estimateScratchBytes({ sourceBytes: 100, timelineSeconds: 1, lanes: 2, fastPath: true })).toBe(100 + encodedBudget + 64 * 1024 * 1024);
    // Output budget only: original custody and scratch are separate costs.
    // This arithmetic is not evidence that the backend accepted a long file.
    expect(estimateEncodedBytes(5 * 3600 + 5 * 60)).toBe(497827712);
    expect(() => estimateScratchBytes({ timelineSeconds: Infinity })).toThrow('Invalid');
  });
});
