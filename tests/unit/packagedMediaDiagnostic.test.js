// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { LIMITS, OPUS_OPTIONS, SCOPE, binaryPair, fingerprint, sameProvenance, wave,
  command, parseActualFormats, packetSummary } = require('../e2e-harness/ci/diagnose-packaged-media');
let directory;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suisse-media-diagnostic-unit-')); });
afterEach(() => {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-media-diagnostic-unit-')) throw new Error('Unsafe diagnostic fixture cleanup');
  fs.rmSync(resolved, { recursive: true, force: true });
});
function pair() {
  const ffmpeg = path.join(directory, 'ffmpeg'), ffprobe = path.join(directory, 'ffprobe');
  fs.writeFileSync(ffmpeg, 'not-executed'); fs.writeFileSync(ffprobe, 'not-executed');
  return { ffmpeg, ffprobe };
}

describe('bounded packaged media diagnostic evidence', () => {
  it('requires both explicit regular paired resources without installed-binary fallback', () => {
    const paths = pair();
    expect(binaryPair(paths.ffmpeg, paths.ffprobe)).toEqual(paths);
    expect(() => binaryPair(paths.ffmpeg)).toThrow(/Both explicit/);
    expect(() => binaryPair(null, paths.ffprobe)).toThrow(/Both explicit/);
    expect(() => binaryPair('ffmpeg', paths.ffprobe)).toThrow(/absolute/);
    expect(() => binaryPair(paths.ffmpeg, paths.ffmpeg)).toThrow(/paired/);
    fs.unlinkSync(paths.ffprobe); fs.mkdirSync(paths.ffprobe);
    expect(() => binaryPair(paths.ffmpeg, paths.ffprobe)).toThrow(/Invalid/);
  });

  it('detects binary/source byte changes in before/after provenance', async () => {
    const paths = pair(), before = [await fingerprint(paths.ffmpeg), await fingerprint(paths.ffprobe)];
    sameProvenance(before, await Promise.all([fingerprint(paths.ffmpeg), fingerprint(paths.ffprobe)]));
    fs.writeFileSync(paths.ffmpeg, 'changed-bytes');
    expect(() => sameProvenance(before, [before[1], before[0]])).toThrow(/changed/);
    expect(() => sameProvenance(before, [{ ...before[0], sha256: 'different' }, before[1]])).toThrow(/changed/);
    expect((await fingerprint(paths.ffmpeg)).sha256).not.toBe(before[0].sha256);
  });

  it.each([48000, 592560])('generates exactly %i stereo PCM frames with bounded allocation', samples => {
    const bytes = wave(samples);
    expect(bytes.length).toBe(44 + samples * 4);
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    expect(bytes.readUInt16LE(22)).toBe(2);
    expect(bytes.readUInt32LE(24)).toBe(48000);
    expect(bytes.readUInt32LE(40)).toBe(samples * 4);
    expect(bytes.readInt16LE(48)).not.toBe(bytes.readInt16LE(50));
  });

  it.each([0, -1, 1.5, NaN, Infinity, LIMITS.fixtureSamples + 1])('rejects invalid allocation count %s', samples => {
    expect(() => wave(samples)).toThrow(/bound/);
  });

  it('keeps production Opus CBR settings explicit and qualification unavailable', () => {
    expect(OPUS_OPTIONS).toEqual(['-c:a', 'libopus', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-threads', '1', '-vbr', 'off', '-frame_duration', '20', '-application', 'audio',
      '-map_metadata', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1']);
    expect(SCOPE).toContain('not capture, hardware, backend, or release qualification');
    expect(LIMITS.totalMs).toBeLessThanOrEqual(180000);
  });

  it('compares actual dependency parsing for old/new format flags without inventing capabilities', () => {
    const old = parseActualFormats(' D  lavfi           Libavfilter virtual input device\n DE webm            WebM\n');
    const modern = parseActualFormats(' D d lavfi           Libavfilter virtual input device\n DE  webm            WebM\n');
    expect(old.lavfiRecognized).toBe(true);
    expect(modern.lavfiRecognized).toBe(false);
    expect(modern.formats.lavfi).toBeUndefined();
    expect(modern.formats.webm.canMux).toBe(true);
  });

  it('preserves shortened final duration and separate discard padding without treating them as coded samples', () => {
    const probe = { streams: [{ codec_name: 'opus', sample_rate: '48000', channels: 2, extradata: 'OpusHead', time_base: '1/1000' }],
      packets: [{ duration: 20, data: '00000000: fc00', pts: -7 },
        { duration: 7, data: '00000000: fc00', pts: 14, side_data_list: [{ discard_padding: 648, skip_samples: 0 }] }] };
    const result = packetSummary(probe);
    expect(result.containerDurationTicks).toBe(27);
    expect(result.last).toEqual(probe.packets[1]);
    expect(result).not.toHaveProperty('decodedSamples');
    expect(() => packetSummary({ ...probe, packets: [{ duration: 20 }] })).toThrow(/packet data/);
    expect(() => packetSummary({ ...probe, streams: [] })).toThrow(/Missing/);
    expect(() => packetSummary({ ...probe, packets: Array(1001).fill(probe.packets[0]) })).toThrow(/unbounded/);
    expect(() => packetSummary({ ...probe, packets: [{ ...probe.packets[0], duration: undefined }] })).toThrow(/duration/);
    expect(() => packetSummary({ ...probe, packets: [{ ...probe.packets[0], pts: NaN }] })).toThrow(/timestamp/);
    expect(() => packetSummary({ ...probe, streams: [{ ...probe.streams[0], time_base: '1/0' }] })).toThrow(/time base/);
    expect(() => packetSummary({ ...probe, streams: [{ ...probe.streams[0], extradata: '' }] })).toThrow(/OpusHead/);
  });

  it('preserves exact native subprocess stdout/stderr and nonzero exit evidence', async () => {
    const result = await command(process.execPath, ['-e', 'process.stdout.write("exact\\u0000bytes");process.stderr.write("diagnostic");process.exitCode=7'],
      { directory, name: 'exit-seven', deadline: performance.now() + 10000 });
    expect(result.exitCode).toBe(7);
    expect(result.complete).toBe(false);
    expect(fs.readFileSync(result.stdout)).toEqual(Buffer.from('exact\0bytes'));
    expect(fs.readFileSync(result.stderr, 'utf8')).toBe('diagnostic');
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'exit-seven.command.json'))).args).toEqual(result.args);
  }, 15000);

  it('kills an owned timed-out process and saves partial output instead of reporting completion', async () => {
    const result = await command(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
      { directory, name: 'deadline', deadline: performance.now() + 5000, commandMs: 200 });
    expect(result.complete).toBe(false);
    expect(result.killed).toBe(true);
    expect(() => process.kill(result.pid, 0)).toThrow();
    expect(fs.existsSync(result.stdout)).toBe(true);
  }, 10000);

  it('marks output-cap termination as incomplete and bounds retained bytes', async () => {
    const result = await command(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(16384,65));setInterval(()=>{},1000)'],
      { directory, name: 'output-cap', deadline: performance.now() + 5000, stdoutBytes: 1024, stderrBytes: 1024 });
    expect(result.complete).toBe(false);
    expect(result.errorCode).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(fs.statSync(result.stdout).size).toBeLessThanOrEqual(1024);
    expect(() => process.kill(result.pid, 0)).toThrow();
  }, 10000);

  it('rejects an expired command budget and unsafe evidence name before spawning', () => {
    expect(() => command(process.execPath, [], { directory, name: 'expired', deadline: performance.now() - 1 })).toThrow(/budget/);
    expect(() => command(process.execPath, [], { directory, name: '../escape', deadline: performance.now() + 1000 })).toThrow(/name/);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
