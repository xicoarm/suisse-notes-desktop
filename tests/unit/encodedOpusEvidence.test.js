// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOpusPacketAccounting, createPacketSectionReader } = require('../../src-electron/encoded-opus-evidence');
const metadata = 'stream|codec_name=opus|sample_rate=48000|channels=2|initial_padding=312|time_base=1/1000';
// FFprobe 4.4.1 (darwin-arm64 package 5.0.1) omits initial_padding. The
// compact metadata hex dump and default packet wrappers also work in newer
// probes. Fixture shape follows n4.4.1/fftools/ffprobe.c, not its broken compact
// packet writer, which can concatenate side_data onto duration's value.
const oldMetadata = String.raw`stream|codec_name=opus|sample_rate=48000|channels=2|time_base=1/1000|extradata=\n00000000: 4f70 7573 4865 6164 0102 3801 80bb 0000  OpusHead..8.....\n00000010: 0000 00                                  ...\n|extradata_size=19`;
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
  it('uses exact OpusHead pre-skip with old macOS metadata and explicit packet side-data wrappers', () => {
    const accounting = createOpusPacketAccounting();
    accounting.consume(oldMetadata);
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
    for (const header of [oldMetadata.replace('extradata_size=19', 'extradata_size=18'),
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
