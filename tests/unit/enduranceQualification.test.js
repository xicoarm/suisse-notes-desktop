// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { createMultipartHasher, resolveEnduranceSeconds, diskBudget, DEFAULT_SECONDS } = require('../e2e-harness/endurance-qualification');
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
