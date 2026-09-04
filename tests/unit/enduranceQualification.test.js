// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createMultipartHasher, resolveEnduranceSeconds, diskBudget, assessSourceCoverage, DEFAULT_SECONDS } = require('../e2e-harness/endurance-qualification');
const { buildCodedScenario, verifyCodedAudio, SAMPLE_RATE } = require('../e2e-harness/lib/coded-audio');
const boundary = 'endurance-boundary-42';
const type = `multipart/form-data; boundary="${boundary}"`;
const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="recordId"\r\n\r\ntest-record\r\n--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`);
const suffix = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="userId"\r\n\r\ntest-user\r\n--${boundary}--\r\n`);

describe('endurance streaming upload evidence', () => {
  it('hashes only binary audio across every possible single split and one-byte network chunks', () => {
    const audio = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const body = Buffer.concat([prefix, audio, suffix]);
    const expected = crypto.createHash('sha256').update(audio).digest('hex');
    for (let split = 1; split < body.length; split++) {
      const parser = createMultipartHasher(type);
      parser.feed(body.subarray(0, split)); parser.feed(body.subarray(split));
      expect(parser.finish()).toMatchObject({ sha256: expected, fileSize: audio.length });
    }
    const parser = createMultipartHasher(type);
    for (const byte of body) parser.feed(Buffer.from([byte]));
    expect(parser.finish()).toMatchObject({ sha256: expected, fileSize: audio.length });
  });

  it('retains at most one network chunk plus delimiter while hashing a streamed body', () => {
    const parser = createMultipartHasher(type), expected = crypto.createHash('sha256');
    const chunk = Buffer.alloc(32768, 0xa7);
    parser.feed(prefix);
    for (let index = 0; index < 256; index++) { parser.feed(chunk); expected.update(chunk); }
    parser.feed(suffix);
    const evidence = parser.finish();
    expect(evidence).toMatchObject({ sha256: expected.digest('hex'), fileSize: 8 * 1024 * 1024 });
    expect(evidence.maxBufferedBytes).toBeLessThanOrEqual(chunk.length + boundary.length + 4);
  });

  it('rejects truncated audio, a second file, malformed separators, and oversized headers', () => {
    const truncated = createMultipartHasher(type);
    truncated.feed(Buffer.concat([prefix, Buffer.from('audio')]));
    expect(() => truncated.finish()).toThrow('Incomplete');
    const duplicate = createMultipartHasher(type);
    duplicate.feed(Buffer.concat([prefix, Buffer.from('first')]));
    expect(() => duplicate.feed(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="second"; filename="two.webm"\r\n\r\n`))).toThrow('one audio file');
    const malformed = createMultipartHasher(type);
    expect(() => malformed.feed(Buffer.concat([prefix, Buffer.from(`audio\r\n--${boundary}??`)]))).toThrow('separator');
    const oversized = createMultipartHasher(type);
    expect(() => oversized.feed(Buffer.from(`--${boundary}\r\nX: ${'a'.repeat(16385)}\r\n\r\n`))).toThrow('headers too large');
  });
});

describe('endurance duration and disk budget', () => {
  it('keeps five hours five minutes as the default and requires a bounded explicit smoke duration', () => {
    expect(DEFAULT_SECONDS).toBe(18300);
    expect(resolveEnduranceSeconds('45')).toBe(45);
    expect(resolveEnduranceSeconds('20000')).toBe(20000);
    for (const value of ['', '44', '20001', '45.5', 'NaN', null]) expect(() => resolveEnduranceSeconds(value)).toThrow();
  });

  it('budgets the streamed reference, three encoded copies at 256 kbps, and one GiB reserve', () => {
    expect(diskBudget(18300)).toEqual({ referenceBytes: 18325 * 96000 + 44, encodedCopiesBytes: 18300 * 32000 * 3, headroomBytes: 1024 ** 3 });
  });
});

describe('endurance source boundaries and acquisition clock', () => {
  const work = path.resolve('tests/e2e-harness/work');
  const recorder = { startedAt: 1000 };
  const acquisition = [{ requestedAt: 900, receivedAt: 1000 }];
  let directory, reference, wave;
  const slice = (start, end) => wave.subarray(44 + start * SAMPLE_RATE * 2, 44 + end * SAMPLE_RATE * 2);
  const output = (name, bytes) => {
    const header = Buffer.from(wave.subarray(0, 44));
    header.writeUInt32LE(bytes.length + 36, 4); header.writeUInt32LE(bytes.length, 40);
    const file = path.join(directory, name + '.wav');
    fs.writeFileSync(file, Buffer.concat([header, bytes]));
    return file;
  };
  beforeAll(() => {
    fs.mkdirSync(work, { recursive: true });
    directory = fs.mkdtempSync(path.join(work, 'endurance-boundary-tests-'));
    reference = buildCodedScenario('boundary-reference', [{ type: 'speech', seconds: 18 }], { outputDir: directory });
    wave = fs.readFileSync(reference.wavPath);
  });
  afterAll(() => {
    const target = path.resolve(directory);
    if (path.dirname(target) !== work || !path.basename(target).startsWith('endurance-boundary-tests-')) throw new Error('Unsafe endurance test cleanup path');
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('accepts complete numbered audio whose identities agree with native acquisition', async () => {
    const audio = await verifyCodedAudio(output('complete', slice(0, 12)), reference, { expectedDurationS: 12 });
    expect(audio.pass).toBe(true);
    expect(assessSourceCoverage(audio, recorder, acquisition).problems).toEqual([]);
  });

  it.each(['prefix', 'suffix'])('rejects a silent %s despite correct duration and an otherwise passing interior oracle', async boundary => {
    const zeros = Buffer.alloc(3 * SAMPLE_RATE * 2);
    const bytes = boundary === 'prefix' ? Buffer.concat([zeros, slice(3, 12)]) : Buffer.concat([slice(0, 9), zeros]);
    const audio = await verifyCodedAudio(output('missing-' + boundary, bytes), reference, { expectedDurationS: 12 });
    expect(audio.pass).toBe(true); // Reproduces the original qualification hole.
    expect(audio.durationS).toBe(12);
    expect(assessSourceCoverage(audio, recorder, acquisition).problems).toContainEqual(expect.stringMatching(new RegExp('SOURCE COVERAGE: missing .* ' + boundary)));
  });

  it('rejects a complete but wrongly shifted source interval using the independent acquisition clock', async () => {
    const audio = await verifyCodedAudio(output('shifted', slice(3, 15)), reference, { expectedDurationS: 12 });
    expect(audio.pass).toBe(true);
    const result = assessSourceCoverage(audio, recorder, acquisition);
    expect(result.prefixGapS).toBeLessThan(0.1);
    expect(result.suffixGapS).toBeLessThan(0.1);
    expect(result.problems).toContainEqual(expect.stringMatching('SOURCE CLOCK: decoded numbering'));
  });

  it('refuses a missing, replaced, or unbounded acquisition clock', () => {
    const audio = { firstFrame: 0, lastFrame: 23, durationS: 12, sourceOffsetS: 0 };
    for (const acquisitions of [[], [...acquisition, ...acquisition], [{ requestedAt: 0, receivedAt: 11000 }]]) {
      expect(assessSourceCoverage(audio, recorder, acquisitions).problems.some(problem => problem.startsWith('SOURCE CLOCK:'))).toBe(true);
    }
  });
});
