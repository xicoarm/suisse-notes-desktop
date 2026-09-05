/**
 * Portable, deterministic capture oracle. Six simultaneous FSK symbols encode
 * a unique half-second frame number plus CRC-8. Unlike periodic pilot pulses,
 * the identity and order of middle audio survive lossy encoding and expose
 * deletion/repetition/reordering even when file duration and energy agree.
 * This is a synthetic signal qualification, not a speech/transcription test.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path;

const SAMPLE_RATE = 48000;
const ANALYSIS_RATE = 8000;
const FRAME_SECONDS = 0.5;
const WINDOW_SECONDS = 0.08;
const HOP_SECONDS = 0.02;
// One nanosecond absorbs timestamp subtraction roundoff, including long
// recordings, without widening any boundary by even one analysis sample.
const TIMING_EPSILON_SECONDS = 1e-9;
const BASE_FREQUENCIES = [275, 875, 1475, 2075, 2675, 3275];
const FREQUENCY_STEP = 25;
const MULTIPLIER = 40503;
let inverse = 1;
for (let i = 0; i < 5; i++) inverse = Math.imul(inverse, 2 - Math.imul(MULTIPLIER, inverse)) & 65535;

function crc8(value) {
  let crc = 0;
  for (const byte of [value >> 8, value & 255]) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 128 ? 7 : 0)) & 255;
  }
  return crc;
}

function symbolsForFrame(id) {
  const code = (Math.imul(id, MULTIPLIER) + 17) & 65535;
  const crc = crc8(code);
  return [code & 15, (code >> 4) & 15, (code >> 8) & 15, code >> 12, crc & 15, crc >> 4];
}

function wavHeader(samples) {
  const bytes = samples * 2;
  if (bytes > 0xffffffff - 36) throw new Error('Synthetic WAV exceeds RIFF size limit');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return header;
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}

/**
 * plan uses the legacy segment vocabulary, in multiples of 0.5 seconds.
 * "speech" is a modulated coded test signal, never generated spoken words;
 * "quiet" attenuates it, while zeros/noise retain their original meanings.
 * opts.outputDir is optional; by default artifacts stay in ignored harness work.
 */
function buildCodedScenario(name, plan, opts = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Synthetic scenario name must be a simple filename');
  if (opts.frameSeconds !== undefined && opts.frameSeconds !== FRAME_SECONDS) throw new Error('Coded oracle uses fixed 0.5-second frames');
  const dir = path.resolve(opts.outputDir || path.join(__dirname, '..', 'work', 'scenarios'));
  fs.mkdirSync(dir, { recursive: true });
  let totalSeconds = 0;
  const timeline = plan.map(segment => {
    if (!['speech', 'quiet', 'zeros', 'noise'].includes(segment.type) || !Number.isFinite(segment.seconds) || segment.seconds <= 0) {
      throw new Error('Invalid synthetic segment');
    }
    if (Math.abs(segment.seconds / FRAME_SECONDS - Math.round(segment.seconds / FRAME_SECONDS)) > 1e-8) {
      throw new Error('Coded segments must be multiples of 0.5 seconds');
    }
    const start = totalSeconds; totalSeconds += segment.seconds;
    return { ...segment, start, end: totalSeconds };
  });
  if (!timeline.length || totalSeconds / FRAME_SECONDS > 65536) throw new Error('Coded reference must contain 1–65536 frames (at most 9h6m8s)');
  const samplesPerFrame = FRAME_SECONDS * SAMPLE_RATE;
  // Precompute only 96 short tone shapes (~9 MB); long references stream out
  // frame by frame instead of allocating hours of PCM in memory.
  const tones = BASE_FREQUENCIES.map(base => Array.from({ length: 16 }, (_, symbol) => {
    const tone = new Float32Array(samplesPerFrame);
    for (let i = 0; i < tone.length; i++) {
      const fade = Math.min(1, i / 240, (tone.length - 1 - i) / 240);
      tone[i] = Math.sin(2 * Math.PI * (base + symbol * FREQUENCY_STEP) * i / SAMPLE_RATE) * fade;
    }
    return tone;
  }));
  const wavPath = path.join(dir, name + '.wav');
  const metaPath = path.join(dir, name + '.json');
  const fd = fs.openSync(wavPath, 'w');
  const output = Buffer.alloc(samplesPerFrame * 2);
  let segmentIndex = 0;
  let noiseSeed = 0x13579bdf;
  try {
    writeAll(fd, wavHeader(totalSeconds * SAMPLE_RATE));
    for (let frame = 0; frame < totalSeconds / FRAME_SECONDS; frame++) {
      const start = frame * FRAME_SECONDS;
      while (start >= timeline[segmentIndex].end) segmentIndex++;
      const segment = timeline[segmentIndex];
      const symbols = symbolsForFrame(frame);
      const gain = segment.type === 'quiet' ? 10 ** ((segment.gainDb ?? -30) / 20) : 1;
      for (let sample = 0; sample < samplesPerFrame; sample++) {
        let value = 0;
        if (segment.type === 'noise') {
          noiseSeed ^= noiseSeed << 13; noiseSeed ^= noiseSeed >>> 17; noiseSeed ^= noiseSeed << 5;
          value = ((noiseSeed >>> 0) / 0xffffffff * 2 - 1) * 0.003;
        } else if (segment.type !== 'zeros') {
          for (let band = 0; band < 6; band++) value += tones[band][symbols[band]][sample] * 0.065;
          // A modulated harmonic bed exercises varying speech-like level;
          // it contains no spoken words and has no platform voice dependency.
          const t = start + sample / SAMPLE_RATE;
          value += 0.025 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3.7 * t)) *
            (Math.sin(2 * Math.PI * 135 * t) + 0.4 * Math.sin(2 * Math.PI * 270 * t));
          value *= gain;
        }
        output.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), sample * 2);
      }
      writeAll(fd, output);
    }
  } finally { fs.closeSync(fd); }
  const meta = { name, totalSeconds, timeline, coded: { version: 1, frameSeconds: FRAME_SECONDS,
    sampleRate: SAMPLE_RATE, description: 'Deterministic synthetic signal; not spoken speech' } };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return { wavPath, metaPath, ...meta };
}

const WINDOW = Math.round(ANALYSIS_RATE * WINDOW_SECONDS);
const HOP = Math.round(ANALYSIS_RATE * HOP_SECONDS);
const coefficients = BASE_FREQUENCIES.map(base => Array.from({ length: 16 }, (_, symbol) =>
  2 * Math.cos(2 * Math.PI * (base + symbol * FREQUENCY_STEP) / ANALYSIS_RATE)));

function decodeWindow(samples, offset) {
  const symbols = [];
  for (const band of coefficients) {
    let best = 0, second = 0, symbol = -1;
    for (let candidate = 0; candidate < band.length; candidate++) {
      const coefficient = band[candidate];
      let s1 = 0, s2 = 0;
      for (let i = 0; i < WINDOW; i++) {
        const s0 = samples[offset + i] + coefficient * s1 - s2;
        s2 = s1; s1 = s0;
      }
      const power = Math.max(0, s1 * s1 + s2 * s2 - coefficient * s1 * s2) / (WINDOW * WINDOW / 4);
      if (power > best) { second = best; best = power; symbol = candidate; }
      else if (power > second) second = power;
    }
    if (best < 1e-10 || best < second * 4) return null;
    symbols.push(symbol);
  }
  const code = symbols[0] | (symbols[1] << 4) | (symbols[2] << 8) | (symbols[3] << 12);
  if (crc8(code) !== (symbols[4] | (symbols[5] << 4))) return null;
  return Math.imul((code - 17) & 65535, inverse) & 65535;
}

function createAnalyzer() {
  let bytes = Buffer.alloc(0), tail = new Float32Array(0), sampleBase = 0, totalSamples = 0;
  let active = null;
  const groups = [];
  const finishGroup = () => { if (active) groups.push(active); active = null; };
  return {
    feed(chunk) {
      bytes = Buffer.concat([bytes, chunk]);
      const count = Math.floor(bytes.length / 4);
      const samples = new Float32Array(tail.length + count);
      samples.set(tail);
      for (let i = 0; i < count; i++) samples[tail.length + i] = bytes.readFloatLE(i * 4);
      totalSamples += count; bytes = Buffer.from(bytes.subarray(count * 4));
      let offset = 0;
      while (offset + WINDOW <= samples.length) {
        const id = decodeWindow(samples, offset);
        const time = (sampleBase + offset + WINDOW / 2) / ANALYSIS_RATE;
        if (id !== null) {
          if (!active || active.id !== id || time - active.end > 0.12 + TIMING_EPSILON_SECONDS) {
            finishGroup(); active = { id, start: time, end: time, windows: 1 };
          } else { active.end = time; active.windows++; }
        }
        offset += HOP;
      }
      tail = samples.slice(offset); sampleBase += offset;
    },
    finish() {
      finishGroup();
      return { durationS: totalSamples / ANALYSIS_RATE, groups: groups.filter(group => group.windows >= 2),
        rejectedGroups: groups.filter(group => group.windows < 2).length };
    },
  };
}

async function analyzeCodedAudio(filePath) {
  const analyzer = createAnalyzer();
  const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', filePath,
    '-vn', '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Oracle decode failed: ' + stderr)));
  });
  // Consume/handle completion even when the stream itself fails.
  completed.catch(() => {});
  try { for await (const chunk of child.stdout) analyzer.feed(chunk); await completed; }
  catch (error) { child.kill(); throw error; }
  return { ...analyzer.finish(), decoderWarnings: stderr.trim() || null };
}

/**
 * Infer source startup offset from interior frame identities. No padded
 * reference prefix/suffix is required to appear in the captured output.
 * expectations.expectedDurationS is the observed active recording time;
 * durationToleranceS defaults to 1.5 for startup/codec tail allowance.
 * Missing/duplicate/reordered interior frames cannot use that time allowance.
 */
async function verifyCodedAudio(filePath, scenario, expectations = {}) {
  if (scenario.coded?.version !== 1) throw new Error('Unsupported coded reference');
  const analysis = await analyzeCodedAudio(filePath);
  const problems = [];
  const notes = [];
  const groups = analysis.groups;
  const frameSeconds = scenario.coded.frameSeconds;
  const isCoded = id => scenario.timeline.some(segment => id * frameSeconds >= segment.start &&
    id * frameSeconds < segment.end && ['speech', 'quiet'].includes(segment.type));
  if (expectations.expectedDurationS !== undefined) {
    const tolerance = expectations.durationToleranceS ?? 1.5;
    if (Math.abs(analysis.durationS - expectations.expectedDurationS) > tolerance + TIMING_EPSILON_SECONDS) {
      problems.push(`DURATION: ${analysis.durationS.toFixed(3)}s versus expected ${expectations.expectedDurationS.toFixed(3)}s (tolerance ${tolerance}s)`);
    }
  }
  if (groups.length < 3) problems.push('INSUFFICIENT IDENTIFIABLE AUDIO: fewer than three numbered frames');
  const seen = new Set();
  let previous = null;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!isCoded(group.id)) problems.push(`UNEXPECTED FRAME ${group.id}`);
    if (seen.has(group.id)) problems.push(`DUPLICATED FRAME ${group.id}`);
    seen.add(group.id);
    if (previous) {
      if (group.id <= previous.id) problems.push(`REORDERED AUDIO: frame ${previous.id} followed by ${group.id}`);
      else {
        const missing = [];
        for (let id = previous.id + 1; id < group.id; id++) if (isCoded(id)) missing.push(id);
        if (missing.length) problems.push(`MISSING FRAMES: ${missing.slice(0, 12).join(',')}${missing.length > 12 ? '…' : ''}`);
        const actualStep = (group.start + group.end - previous.start - previous.end) / 2;
        const expectedStep = (group.id - previous.id) * frameSeconds;
        // Ignore partial boundary frames. Interior timing catches a shortened
        // or elongated fragment even when its numbered frame still appears.
        if (i > 1 && i < groups.length - 1 && Math.abs(actualStep - expectedStep) > WINDOW_SECONDS + HOP_SECONDS + expectedStep * 0.003 + TIMING_EPSILON_SECONDS) {
          problems.push(`INTERIOR TIMING: frames ${previous.id}→${group.id}, ${actualStep.toFixed(3)}s versus ${expectedStep.toFixed(3)}s`);
        }
      }
    }
    const span = group.end - group.start;
    if ((i > 0 && i < groups.length - 1 && span < frameSeconds - 2 * WINDOW_SECONDS - 2 * HOP_SECONDS - TIMING_EPSILON_SECONDS) || span > frameSeconds + 0.12 + TIMING_EPSILON_SECONDS) {
      problems.push(`INCOMPLETE OR REPEATED FRAME ${group.id}: identifiable span ${span.toFixed(3)}s`);
    }
    previous = group;
  }
  const first = groups[0], last = groups[groups.length - 1];
  const offsets = groups.slice(1, -1).map(group => (group.id + 0.5) * frameSeconds - (group.start + group.end) / 2).sort((a, b) => a - b);
  const sourceOffsetS = offsets.length ? offsets[Math.floor(offsets.length / 2)] : null;
  notes.push('Identity/order checked independently of duration and energy; first/last partial frames tolerated.');
  notes.push('Resolution: 0.5-second identities, 80ms spectral windows; this does not certify every individual audio sample.');
  return { pass: problems.length === 0, problems, notes, durationS: analysis.durationS, sourceOffsetS,
    identifiedFrames: groups.length, firstFrame: first?.id ?? null, lastFrame: last?.id ?? null,
    firstIdentifiedStartS: first?.start ?? null, lastIdentifiedEndS: last?.end ?? null,
    decoderWarnings: analysis.decoderWarnings, rejectedGroups: analysis.rejectedGroups };
}

module.exports = { buildCodedScenario, verifyCodedAudio, analyzeCodedAudio, symbolsForFrame,
  SAMPLE_RATE, FRAME_SECONDS, ANALYSIS_RATE };
