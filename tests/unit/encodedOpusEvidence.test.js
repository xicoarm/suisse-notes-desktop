// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { createOpusPacketAccounting: makeAccounting, createPacketSectionReader,
  opusPacketSamples, createPacketFileReader } = require('../../src-electron/encoded-opus-evidence');
// These arithmetic tests supply a real, valid one-frame20ms packet. File/hash
// binding is exercised separately below; absence of a reader never falls back.
const createOpusPacketAccounting = () => makeAccounting({ readPacket: () => Buffer.from([0xfc]) });
const metadata = 'stream|codec_name=opus|sample_rate=48000|channels=2|initial_padding=312|time_base=1/1000';
// FFprobe 4.4.1 (darwin-arm64 package 5.0.1) omits initial_padding AND
// extradata_size: show_stream() prints the hex dump but no size field.
// compact metadata hex dump and default packet wrappers also work in newer
// probes. Fixture shape follows n4.4.1/fftools/ffprobe.c, not its broken compact
// packet writer, which can concatenate side_data onto duration's value.
const oldMetadata = String.raw`stream|codec_name=opus|sample_rate=48000|channels=2|time_base=1/1000|extradata=\n00000000: 4f70 7573 4865 6164 0102 3801 80bb 0000  OpusHead..8.....\n00000010: 0000 00                                  ...\n`;
const packetSections = `[PACKET]
pts=-7
duration=20
[/PACKET]
[PACKET]
pts=14
duration=20
[SIDE_DATA]
side_data_type=Skip Samples
skip_samples=0
discard_padding=941
skip_reason=0
discard_reason=0
[/SIDE_DATA]
[/PACKET]`;

describe('encoded Opus decoded-sample accounting', () => {
  it.each([[51, 7, 648, 48000], [618, 12, 408, 592560]])(
    'counts %i actual coded packets when the last container duration is %ims', (count, lastDuration, discard, expected) => {
      for (const duration of [20, lastDuration]) {
        const accounting = createOpusPacketAccounting();
        accounting.consume(oldMetadata);
        for (let index = 0; index < count; index++) accounting.consume(
          `packet|pts=${index ? 14 + (index - 1) * 20 : -7}|duration=${index === count - 1 ? duration : 20}` +
          (index === count - 1 ? `|skip_samples=0|discard_padding=${discard}` : ''));
        expect(accounting.result()).toMatchObject({ decodedSamples: expected, nominalSamples: count * 960,
          minPacketSamples: 960, maxPacketSamples: 960, preSkipSamples: 312, discardPaddingSamples: discard });
      }
    }
  );

  it('derives varying coded durations and accepts mono-coded packets under a stereo OpusHead', () => {
    const packets = [Buffer.from([0xf8]), Buffer.from([0xf0]), Buffer.from([0xe8])];
    const accounting = makeAccounting({ readPacket: () => packets.shift() });
    accounting.consume(metadata.replace('initial_padding=312', 'initial_padding=0'));
    for (const [pts, duration] of [[0, 20], [20, 10], [30, 5]]) accounting.consume(`packet|pts=${pts}|duration=${duration}`);
    expect(accounting.result()).toMatchObject({ nominalSamples: 1680, decodedSamples: 1680, minPacketSamples: 240, maxPacketSamples: 960 });
    expect(() => makeAccounting().consume('packet|pts=0|duration=20')).toThrow('verified coded-packet');
  });

  it.each([10, 18, 22, 30])('rejects a coded gap/overlap hidden by nonfinal container duration %ims', duration => {
    const accounting = createOpusPacketAccounting();
    accounting.consume(metadata.replace('initial_padding=312', 'initial_padding=0'));
    accounting.consume(`packet|pts=0|duration=${duration}`);
    accounting.consume(`packet|pts=${duration}|duration=20`);
    expect(() => accounting.result()).toThrow('coded packet timeline is discontinuous');
  });

  it.each([19, 21])('retains only the original 1ms coded-timestamp quantization allowance (%ims)', duration => {
    const accounting = createOpusPacketAccounting();
    // Exercise late metadata without retaining packets: extrema are bounded by
    // the RFC's finite set of coded durations, not by recording length.
    accounting.consume(`packet|pts=0|duration=${duration}`);
    accounting.consume(`packet|pts=${duration}|duration=7|skip_samples=0|discard_padding=648`);
    accounting.consume(metadata.replace('initial_padding=312', 'initial_padding=0'));
    expect(accounting.result()).toMatchObject({ decodedSamples: 1272, maxPacketGapSamples: 0, maxPacketOverlapSamples: 0,
      maxCodedPacketGapSamples: duration > 20 ? 48 : 0, maxCodedPacketOverlapSamples: duration < 20 ? 48 : 0 });
  });

  it.each(['0/1000', '1/0', '1/' + '9'.repeat(400), '9'.repeat(400) + '/1', '1/9007199254740992'])('rejects malformed time base %s', timeBase => {
    const accounting = createOpusPacketAccounting();
    accounting.consume(metadata.replace('1/1000', timeBase));
    accounting.consume('packet|pts=0|duration=20');
    expect(() => accounting.result()).toThrow('time base');
  });
  it.each([false, true])('uses exact OpusHead pre-skip and packet side data with explicit size field=%s', hasSize => {
    const accounting = createOpusPacketAccounting();
    accounting.consume(oldMetadata + (hasSize ? '|extradata_size=19' : ''));
    const reader = createPacketSectionReader(line => accounting.consume(line));
    packetSections.split('\n').forEach(line => reader.consume(line));
    reader.finish();
    expect(accounting.result()).toMatchObject({ packets: 2, nominalSamples: 1920, preSkipSource: 'opus-head',
      preSkipSamples: 312, discardPaddingSamples: 941, decodedSamples: 667 });
  });

  it('reads a different pre-skip and escaped pipe from OpusHead rather than assuming 312 samples', () => {
    const accounting = createOpusPacketAccounting();
    accounting.consume(oldMetadata.replace('3801', '7c01').replace('..8.....', String.raw`..\|.....`));
    accounting.consume('packet|pts=-8|duration=20');
    accounting.consume('packet|pts=12|duration=20|skip_samples=0|discard_padding=941');
    expect(accounting.result()).toMatchObject({ preSkipSamples: 380, decodedSamples: 599 });
  });

  it('accepts explicit first-packet skip only when other pre-skip evidence is unavailable', () => {
    const accounting = createOpusPacketAccounting();
    accounting.consume(metadata.replace('initial_padding=312|', ''));
    accounting.consume('packet|pts=-7|duration=20|skip_samples=312|discard_padding=0');
    accounting.consume('packet|pts=13|duration=20|skip_samples=0|discard_padding=100');
    expect(accounting.result()).toMatchObject({ preSkipSource: 'first-packet-skip', decodedSamples: 1508 });
  });

  it('rejects truncated, malformed, or contradictory header evidence', () => {
    for (const header of [`${oldMetadata}|extradata_size=18`, `${oldMetadata}|extradata_size=N/A`,
      `${metadata}|extradata_size=19`,
      oldMetadata.replace('00000010: 0000 00', '00000010: 0000'),
      oldMetadata.replace('4f70', 'zzzz'), oldMetadata.replace('4f70', '4f71'), oldMetadata.replace('4f70', 'cf70'),
      oldMetadata.replace('0102', '0101'), oldMetadata.replace('00000010: 0000 00', '00000010: 0000 01'),
      oldMetadata.replace('time_base=', 'initial_padding=100|time_base=')]) {
      const accounting = createOpusPacketAccounting();
      accounting.consume(header);
      accounting.consume('packet|pts=-7|duration=20');
      expect(() => accounting.result()).toThrow();
    }
    const conflict = createOpusPacketAccounting();
    conflict.consume(oldMetadata);
    conflict.consume('packet|pts=-7|duration=20|skip_samples=100');
    expect(() => conflict.result()).toThrow('conflicting');
  });

  it('retains only bounded technical header evidence when validation fails', () => {
    const accounting = createOpusPacketAccounting();
    accounting.consume(`${oldMetadata}|extradata_size=18|tag:meeting_title=must-not-be-included`);
    accounting.consume('packet|pts=-7|duration=20');
    let error;
    try { accounting.result(); } catch (failure) { error = failure; }
    expect(error).toMatchObject({ code: 'NATIVE_ENCODED_OPUS_INVALID', evidence: { probeMetadata: {
      codec_name: 'opus', sample_rate: '48000', channels: '2', extradata_size: '18', initial_padding: null,
    } } });
    expect(error.evidence.probeMetadata.extradata).toContain('4f70 7573 4865 6164');
    expect(JSON.stringify(error.evidence)).not.toContain('must-not-be-included');
    const oversized = createOpusPacketAccounting();
    oversized.consume(`${oldMetadata}${'A'.repeat(5000)}|extradata_size=19`);
    oversized.consume('packet|pts=-7|duration=20');
    try { oversized.result(); } catch (failure) { error = failure; }
    expect(error.evidence.probeMetadata.extradataTruncated).toBe(true);
    expect(error.evidence.probeMetadata.extradata.length).toBe(1024);
  });

  it('rejects incomplete or repeated skip side data and truncated packet sections', () => {
    for (const text of [packetSections.replace('discard_padding=941\n', ''),
      packetSections.replace('skip_samples=0', 'skip_samples=0\nskip_samples=0'),
      packetSections.replace('side_data_type=Skip Samples', 'side_data_type=Unknown'),
      '[PACKET]\npts=0\nduration=20', '[PACKET]\n[PACKET]']) {
      const reader = createPacketSectionReader(() => {});
      expect(() => { text.split('\n').forEach(line => reader.consume(line)); reader.finish(); }).toThrow();
    }
  });

  it('rejects old-decoder ambiguity when final discard side data resets first-packet skip to zero', () => {
    const accounting = createOpusPacketAccounting();
    accounting.consume(oldMetadata);
    accounting.consume('packet|pts=-7|duration=20|skip_samples=0|discard_padding=100');
    expect(() => accounting.result()).toThrow('ambiguous single-packet');
  });

  it('subtracts codec pre-skip and final padding rather than trusting nominal packet endpoints', () => {
    const accounting = createOpusPacketAccounting();
    accounting.consume('packet|pts=-7|duration=20');
    accounting.consume('packet|pts=14|duration=20|side_data|skip_samples=0|discard_padding=941');
    accounting.consume(metadata);
    expect(accounting.result()).toMatchObject({ packets: 2, nominalSamples: 1920,
      preSkipSamples: 312, discardPaddingSamples: 941, decodedSamples: 667, maxPacketGapSamples: 48 });
  });

  it('does not subtract matching first-packet skip and codec initial padding twice', () => {
    const accounting = createOpusPacketAccounting();
    accounting.consume('packet|pts=-7|duration=20|side_data|skip_samples=312|discard_padding=0');
    accounting.consume('packet|pts=13|duration=20|side_data|discard_padding=100');
    accounting.consume(metadata);
    expect(accounting.result().decodedSamples).toBe(1508);
  });

  it('rejects missing or ambiguous codec metadata and discontinuous output timestamps', () => {
    for (const stream of [null, metadata.replace('channels=2', 'channels=1'),
      metadata.replace('initial_padding=312|', ''), metadata.replace('codec_name=opus', 'codec_name=vorbis')]) {
      const accounting = createOpusPacketAccounting();
      accounting.consume('packet|pts=-7|duration=20');
      if (stream) accounting.consume(stream);
      expect(() => accounting.result()).toThrow();
    }
    const accounting = createOpusPacketAccounting();
    accounting.consume('packet|pts=-7|duration=20');
    accounting.consume('packet|pts=33|duration=20');
    accounting.consume(metadata);
    expect(() => accounting.result()).toThrow('discontinuous');
  });

  it('rejects padding in the middle of a stream and contradictory first-packet skip evidence', () => {
    const middle = createOpusPacketAccounting();
    middle.consume('packet|pts=-7|duration=20|side_data|discard_padding=10');
    expect(() => middle.consume('packet|pts=13|duration=20')).toThrow('before the last');
    const conflict = createOpusPacketAccounting();
    conflict.consume('packet|pts=-7|duration=20|side_data|skip_samples=100');
    conflict.consume(metadata);
    expect(() => conflict.result()).toThrow('conflicting');
  });
});

describe('Opus packet framing independent of container duration', () => {
  const expected = [480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880,
    480, 960, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960];
  it.each(expected.map((samples, config) => [config, samples]))('counts configuration %i as %i samples regardless of stereo bit', (config, samples) => {
    expect(opusPacketSamples(Buffer.from([config << 3, 1]))).toBe(samples);
    expect(opusPacketSamples(Buffer.from([(config << 3) | 4, 1]))).toBe(samples);
  });

  it('validates all packing codes, long VBR lengths, nonzero padding and valid empty frames', () => {
    expect(opusPacketSamples(Buffer.from([0xf8]))).toBe(960);
    expect(opusPacketSamples(Buffer.from([0xf9, 1, 2]))).toBe(1920);
    expect(opusPacketSamples(Buffer.from([0xfa, 1, 7, 8, 9]))).toBe(1920);
    expect(opusPacketSamples(Buffer.concat([Buffer.from([0xfa, 252, 0]), Buffer.alloc(253)]))).toBe(1920);
    expect(opusPacketSamples(Buffer.from([0xfb, 131, 0, 1, 7, 8]))).toBe(2880);
    expect(opusPacketSamples(Buffer.from([0xfb, 0x41, 2, 7, 8, 9]))).toBe(960);
    expect(opusPacketSamples(Buffer.concat([Buffer.from([0x83, 0x41, 255, 1, 7]), Buffer.alloc(255, 9)]))).toBe(120);
    expect(opusPacketSamples(Buffer.from([0x83, 48]))).toBe(5760);
    expect(opusPacketSamples(Buffer.from([0x1a, 0]))).toBe(5760);
  });

  it.each([
    [], [0xf9, 1], [0xfa], [0xfa, 252], [0xfa, 2, 1], [0xfb], [0xfb, 0],
    [0x83, 49], [0x1b, 3], [0xfb, 3, 1], [0xfb, 131, 255],
    [0xfb, 0x41], [0xfb, 0x41, 255], [0xfb, 0x41, 3, 1],
  ])('rejects malformed framing %j', (...bytes) => {
    expect(() => opusPacketSamples(Buffer.from(bytes))).toThrow();
  });

  it('bounds frames and explicit packet resource use without claiming a padding maximum in the RFC', () => {
    expect(() => opusPacketSamples(Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(1276)]))).toThrow('frame length');
    expect(() => opusPacketSamples(Buffer.alloc(65537))).toThrow('oversized');
  });
});

const temporary = [], readers = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const directory of temporary.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-opus-packets-unit-')) throw new Error('Unsafe packet fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
function block(payload, { track = Buffer.from([0x81]), flags = 0x80 } = {}) {
  return Buffer.concat([track, Buffer.from([0, 0, flags]), payload]);
}
function fixture(bytes, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suisse-opus-packets-unit-')); temporary.push(directory);
  const file = path.join(directory, 'encoded.webm'); fs.writeFileSync(file, bytes);
  const reader = createPacketFileReader(file, options); readers.push(reader);
  return { reader, file };
}
function record(position, payload) {
  return { pos: String(position), size: String(payload.length), data_hash: 'SHA256:' + createHash('sha256').update(payload).digest('hex') };
}

describe('bounded hash-bound finalized WebM packet reads', () => {
  it.each([[0x81], [0xff], [0x40, 0x7f], [1, 0, 0, 0, 0, 0, 0, 1]])('parses TrackNumber VINT %j without fixed +4 assumptions', (...track) => {
    const payload = Buffer.from([0xfc, 7]);
    const { reader } = fixture(block(payload, { track: Buffer.from(track) }));
    expect(reader.readPacket(record(0, payload))).toEqual(payload);
    reader.verifyUnchanged();
    expect(reader.stats()).toMatchObject({ packets: 1, readCalls: 1, cacheBytes: 1048576 });
  });

  it('handles a block header across a fixed-cache boundary with bounded reads', () => {
    const payload = Buffer.from([0xfc, 7]), first = block(payload), position = 1048574;
    const bytes = Buffer.concat([first, Buffer.alloc(position - first.length), block(payload)]);
    const { reader } = fixture(bytes);
    expect(reader.readPacket(record(0, payload))).toEqual(payload);
    expect(reader.readPacket(record(position, payload))).toEqual(payload);
    reader.verifyUnchanged();
    expect(reader.stats()).toMatchObject({ packets: 2, readCalls: 2 });
  });

  it('rejects overlap, backwards/repeated positions, and a changed track', () => {
    const payload = Buffer.from([0xfc, 7]), first = block(payload);
    for (const position of [0, 1, first.length - 1]) {
      const { reader } = fixture(Buffer.concat([first, first])); reader.readPacket(record(0, payload));
      expect(() => reader.readPacket(record(position, payload))).toThrow('nonmonotonic');
    }
    const { reader } = fixture(Buffer.concat([first, block(payload, { track: Buffer.from([0x82]) })]));
    reader.readPacket(record(0, payload));
    expect(() => reader.readPacket(record(first.length, payload))).toThrow('changed Block track');
  });

  it('rejects missing/malformed hash, mismatched payload, unsafe ranges, lacing and invalid headers', () => {
    const payload = Buffer.from([0xfc, 7]), valid = record(0, payload);
    for (const change of [{ data_hash: undefined }, { data_hash: 'SHA256:abc' }, { data_hash: 'SHA256:' + '0'.repeat(64) },
      { pos: '-1' }, { pos: 'N/A' }, { pos: '9007199254740992' }, { size: '65537' }, { size: '0' }, { size: '100' }]) {
      const { reader } = fixture(block(payload));
      expect(() => reader.readPacket({ ...valid, ...change })).toThrow();
    }
    for (const bytes of [Buffer.from([0]), Buffer.from([0x40]), Buffer.from([0x81, 0]), block(payload, { track: Buffer.from([0x80]) }),
      block(payload, { flags: 2 }), block(payload, { flags: 0x10 })]) {
      const { reader } = fixture(bytes);
      expect(() => reader.readPacket(valid)).toThrow();
    }
  });

  it('detects modified or replaced files and bounds the read deadline', () => {
    const payload = Buffer.from([0xfc, 7]);
    const changed = fixture(block(payload)); changed.reader.readPacket(record(0, payload));
    fs.utimesSync(changed.file, new Date(), new Date(Date.now() + 10000));
    expect(() => changed.reader.verifyUnchanged()).toThrow('changed');
    const replaced = fixture(block(payload));
    fs.renameSync(replaced.file, path.join(path.dirname(replaced.file), 'original.webm'));
    fs.writeFileSync(replaced.file, block(payload));
    expect(() => replaced.reader.verifyUnchanged()).toThrow('changed');
    const expired = fixture(block(payload), { deadline: 0 });
    expect(() => expired.reader.readPacket(record(0, payload))).toThrow('timed out');
    expired.reader.close(); expired.reader.close();
    expect(() => expired.reader.verifyUnchanged()).toThrow('closed');
  });

  it('rejects a short read when the already-open file is truncated before its first cache fill', () => {
    const payload = Buffer.from([0xfc, 7]);
    const { reader, file } = fixture(block(payload));
    fs.truncateSync(file, 4);
    expect(() => reader.readPacket(record(0, payload))).toThrow('read was truncated');
    expect(() => reader.verifyUnchanged()).toThrow('changed');
  });
});
