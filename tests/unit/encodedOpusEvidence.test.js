// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOpusPacketAccounting } = require('../../src-electron/encoded-opus-evidence');
const metadata = 'stream|codec_name=opus|sample_rate=48000|channels=2|initial_padding=312|time_base=1/1000';

describe('encoded Opus decoded-sample accounting', () => {
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
