// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildCodedScenario, verifyCodedAudio, SAMPLE_RATE } = require('../e2e-harness/lib/coded-audio');
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path;
const workRoot = path.resolve('tests/e2e-harness/work');
let directory, scenario, original;

function region(start, end) {
  return original.subarray(44 + Math.round(start * SAMPLE_RATE) * 2, 44 + Math.round(end * SAMPLE_RATE) * 2);
}

function writeWave(name, data) {
  const header = Buffer.from(original.subarray(0, 44));
  header.writeUInt32LE(data.length + 36, 4); header.writeUInt32LE(data.length, 40);
  const filename = path.join(directory, name + '.wav');
  fs.writeFileSync(filename, Buffer.concat([header, data]));
  return filename;
}

function encode(input, name, bitrate = '64k') {
  const output = path.join(directory, name + '.webm');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-c:a', 'libopus', '-b:a', bitrate, output], { windowsHide: true, timeout: 30000 });
  return output;
}

function energy(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 2) sum += data.readInt16LE(i) ** 2;
  return sum;
}

function matchEnergy(data) {
  const output = Buffer.from(data);
  const gain = Math.sqrt(energy(region(0, 12)) / energy(data));
  for (let i = 0; i < output.length; i += 2) output.writeInt16LE(Math.round(output.readInt16LE(i) * gain), i);
  expect(Math.abs(energy(output) / energy(region(0, 12)) - 1)).toBeLessThan(0.0001);
  return output;
}

// Exercise the real grouping/verification code with exact window identities,
// avoiding codec-dependent timing when testing numerical boundary behavior.
function boundaryOracle() {
  const module = { exports: {} };
  const source = fs.readFileSync(require.resolve('../e2e-harness/lib/coded-audio'), 'utf8');
  vm.runInNewContext(source + `
    module.exports.boundaryHarness = {
      createAnalyzer,
      setWindowDecoder(fn) { decodeWindow = fn; },
      verifyAnalysis(analysis, scenario) {
        analyzeCodedAudio = async () => analysis;
        return verifyCodedAudio('', scenario);
      }
    };
  `, { module, require, Buffer, Float32Array });
  return module.exports.boundaryHarness;
}

describe('oracle numerical timing boundaries', () => {
  it.each([0, 185, 850])('keeps an exact 120ms same-ID gap together at window offset %s', base => {
    const oracle = boundaryOracle();
    const valid = new Set([base, base + 1, base + 7, base + 8]);
    oracle.setWindowDecoder((samples, offset) => valid.has(offset / 160) ? 6 : null);
    const analyzer = oracle.createAnalyzer();
    analyzer.feed(Buffer.alloc(((base + 8) * 160 + 640) * 4));
    const result = analyzer.finish();
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].windows).toBe(4);
  });

  it.each([0, 185, 850])('still splits a 140ms same-ID gap at window offset %s', base => {
    const oracle = boundaryOracle();
    const valid = new Set([base, base + 1, base + 8, base + 9]);
    oracle.setWindowDecoder((samples, offset) => valid.has(offset / 160) ? 6 : null);
    const analyzer = oracle.createAnalyzer();
    analyzer.feed(Buffer.alloc(((base + 9) * 160 + 640) * 4));
    expect(analyzer.finish().groups).toHaveLength(2);
  });

  it.each([[1.24, 1.54], [4.62, 4.92], [17.76, 18.06]])(
    'accepts an exact 300ms interior span from %s to %s, but rejects 280ms', async (start, end) => {
      const oracle = boundaryOracle();
      const center = (start + end) / 2;
      const groups = Array.from({ length: 5 }, (_, id) => ({ id,
        start: center + (id - 2) * 0.5 - 0.2,
        end: center + (id - 2) * 0.5 + 0.2, windows: 16 }));
      groups[2] = { id: 2, start, end, windows: 16 };
      const reference = { coded: { version: 1, frameSeconds: 0.5 }, timeline: [{ type: 'speech', start: 0, end: 2.5 }] };
      const analysis = { durationS: end + 1, groups, decoderWarnings: null, rejectedGroups: 0 };
      expect((await oracle.verifyAnalysis(analysis, reference)).problems).toEqual([]);
      groups[2] = { id: 2, start: start + 0.01, end: end - 0.01, windows: 15 };
      const tooShort = await oracle.verifyAnalysis(analysis, reference);
      expect(tooShort.pass).toBe(false);
      expect(tooShort.problems).toEqual(['INCOMPLETE OR REPEATED FRAME 2: identifiable span 0.280s']);
    });
});

describe('numbered-frame synthetic audio oracle', () => {
  beforeAll(() => {
    fs.mkdirSync(workRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(workRoot, 'oracle-tests-'));
    scenario = buildCodedScenario('reference', [{ type: 'speech', seconds: 12 }], { outputDir: directory });
    original = fs.readFileSync(scenario.wavPath);
  });
  afterAll(() => {
    const target = path.resolve(directory);
    if (path.dirname(target) !== workRoot || !path.basename(target).startsWith('oracle-tests-')) throw new Error('Unsafe oracle cleanup path');
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('generates the same WAV on every run without platform speech engines or cache', () => {
    const repeat = buildCodedScenario('reference-repeat', [{ type: 'speech', seconds: 12 }], { outputDir: directory });
    expect(fs.readFileSync(repeat.wavPath).equals(original)).toBe(true);
  });

  it.each(['32k', '64k', '128k'])('accepts real lossy Opus at %s', async bitrate => {
    const result = await verifyCodedAudio(encode(scenario.wavPath, 'good-' + bitrate, bitrate), scenario, { expectedDurationS: 12 });
    expect(result.problems).toEqual([]);
    expect(result.identifiedFrames).toBe(24);
  });

  it('infers arbitrary source startup offset and tolerates partial boundary frames', async () => {
    const cropped = writeWave('cropped', region(2.35, 10.63));
    const result = await verifyCodedAudio(encode(cropped, 'cropped'), scenario, { expectedDurationS: 8.28 });
    expect(result.problems).toEqual([]);
    expect(result.sourceOffsetS).toBeCloseTo(2.35, 1);
  });

  it('tolerates bounded codec padding without relaxing interior identity checks', async () => {
    const padded = writeWave('padded', Buffer.concat([Buffer.alloc(Math.round(0.117 * SAMPLE_RATE) * 2), region(0, 12), Buffer.alloc(Math.round(0.083 * SAMPLE_RATE) * 2)]));
    const result = await verifyCodedAudio(encode(padded, 'padded'), scenario, { expectedDurationS: 12, durationToleranceS: 0.3 });
    expect(result.problems).toEqual([]);
  });

  it('rejects deleted middle audio even within the permitted total duration tolerance', async () => {
    const damaged = writeWave('deleted', Buffer.concat([region(0, 5), region(6, 12)]));
    const result = await verifyCodedAudio(encode(damaged, 'deleted'), scenario, { expectedDurationS: 12, durationToleranceS: 1.5 });
    expect(result.pass).toBe(false);
    expect(result.problems.some(problem => problem.startsWith('MISSING FRAMES'))).toBe(true);
    expect(result.problems.some(problem => problem.startsWith('DURATION'))).toBe(false);
  });

  it('rejects duplication replacing different middle audio at unchanged duration and energy', async () => {
    const bytes = matchEnergy(Buffer.concat([region(0, 4), region(4, 6), region(4, 6), region(8, 12)]));
    expect(bytes.length).toBe(original.length - 44);
    const result = await verifyCodedAudio(encode(writeWave('duplicate', bytes), 'duplicate'), scenario, { expectedDurationS: 12 });
    expect(result.pass).toBe(false);
    expect(result.problems.some(problem => problem.startsWith('DUPLICATED FRAME'))).toBe(true);
    expect(result.problems.some(problem => problem.startsWith('MISSING FRAMES'))).toBe(true);
  });

  it('rejects reordered middle audio with exactly the same duration and energy', async () => {
    const bytes = Buffer.concat([region(0, 4), region(6, 8), region(4, 6), region(8, 12)]);
    expect(bytes.length).toBe(original.length - 44);
    expect(energy(bytes)).toBe(energy(region(0, 12)));
    const result = await verifyCodedAudio(encode(writeWave('reordered', bytes), 'reordered'), scenario, { expectedDurationS: 12 });
    expect(result.pass).toBe(false);
    expect(result.problems.some(problem => problem.startsWith('REORDERED AUDIO'))).toBe(true);
  });

  it('rejects a silent middle hole even when audio duration is unchanged', async () => {
    const damaged = writeWave('silence', Buffer.concat([region(0, 5), Buffer.alloc(SAMPLE_RATE * 2), region(6, 12)]));
    const result = await verifyCodedAudio(encode(damaged, 'silence'), scenario, { expectedDurationS: 12 });
    expect(result.pass).toBe(false);
    expect(result.problems.some(problem => problem.startsWith('MISSING FRAMES'))).toBe(true);
  });

  it('detects a 240ms cut inside a frame, smaller than one numbered frame', async () => {
    const damaged = writeWave('partial-cut', Buffer.concat([region(0, 5.08), region(5.32, 12)]));
    const result = await verifyCodedAudio(encode(damaged, 'partial-cut'), scenario, { expectedDurationS: 12 });
    expect(result.pass).toBe(false);
    expect(result.problems.some(problem => /INTERIOR TIMING|INCOMPLETE OR REPEATED|MISSING FRAMES/.test(problem))).toBe(true);
  });

  it('rejects repetition of one whole frame even when adjacent identical IDs merge', async () => {
    const damaged = writeWave('one-frame-repeat', Buffer.concat([region(0, 5.5), region(5, 5.5), region(5.5, 12)]));
    const result = await verifyCodedAudio(encode(damaged, 'one-frame-repeat'), scenario, { expectedDurationS: 12 });
    expect(result.pass).toBe(false);
    expect(result.problems.some(problem => /INCOMPLETE OR REPEATED|INTERIOR TIMING/.test(problem))).toBe(true);
  });

  it('preserves explicitly planned silence, noise and quiet signal semantics', async () => {
    const mixed = buildCodedScenario('mixed', [
      { type: 'speech', seconds: 4 }, { type: 'zeros', seconds: 1 },
      { type: 'noise', seconds: 1 }, { type: 'quiet', seconds: 4 },
    ], { outputDir: directory });
    const result = await verifyCodedAudio(encode(mixed.wavPath, 'mixed'), mixed, { expectedDurationS: 10 });
    expect(result.problems).toEqual([]);
  });
});
