'use strict';

const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

function invalid(message, evidence) {
  return Object.assign(new Error(`Encoded Opus evidence: ${message}`), { code: 'NATIVE_ENCODED_OPUS_INVALID', evidence });
}

// The compact writer C-escapes separators and the newlines of hex dumps. Split
// before unescaping so an ASCII '|' inside extradata cannot become a new field.
function compactFields(line) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '\\') index++;
    else if (line[index] === '|') { parts.push(line.slice(start, index)); start = index + 1; }
  }
  parts.push(line.slice(start));
  const fields = {};
  for (const part of parts.slice(1)) {
    const equals = part.indexOf('=');
    if (equals < 1) continue;
    const key = part.slice(0, equals);
    if (Object.hasOwn(fields, key)) throw invalid(`duplicate ${key} probe field`);
    fields[key] = part.slice(equals + 1).replace(/\\([\\|nrtbfv])/g, (_, character) =>
      ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[character] || character);
  }
  return fields;
}

function boundedStreamEvidence(stream) {
  if (!stream) return null;
  const result = {};
  for (const key of ['codec_name', 'sample_rate', 'channels', 'time_base', 'initial_padding', 'extradata_size']) {
    result[key] = typeof stream[key] === 'string' ? stream[key].slice(0, 64) : null;
  }
  result.extradata = typeof stream.extradata === 'string' ? stream.extradata.slice(0, 1024) : null;
  result.extradataTruncated = typeof stream.extradata === 'string' && stream.extradata.length > 1024;
  return result;
}

// FFprobe 4.4 (our pinned macOS ARM binary) does not expose initial_padding.
// Both its native/libopus decoders read pre-skip from OpusHead bytes 10..11.
// Parse only the exact mapping-family-0 stereo header our final encoder emits;
// never guess pre-skip from the rounded negative WebM timestamp.
// https://github.com/FFmpeg/FFmpeg/blob/n4.4.1/libavcodec/opus.c
function opusHeadPadding(stream) {
  if (stream.extradata === undefined && stream.extradata_size === undefined) return null;
  const fail = message => invalid(message, { probeMetadata: boundedStreamEvidence(stream) });
  // 4.4.1 uses par->extradata_size internally but never prints that field.
  // Derive the required length from the actual hex bytes; when a newer probe
  // supplies a size field, it must agree. Missing hex is never replaced by it.
  // https://github.com/FFmpeg/FFmpeg/blob/n4.4.1/fftools/ffprobe.c#L2535-L2539
  if (typeof stream.extradata !== 'string' ||
      (stream.extradata_size !== undefined && stream.extradata_size !== '19')) throw fail('invalid OpusHead size');
  const bytes = [];
  for (const line of stream.extradata.split('\n').filter(Boolean)) {
    const match = /^([0-9a-fA-F]{8}): ((?:[0-9a-fA-F]{4} ?)*(?:[0-9a-fA-F]{2})?) {2,}/.exec(line);
    if (!match || parseInt(match[1], 16) !== bytes.length) throw fail('invalid OpusHead hex dump');
    const hex = match[2].replace(/ /g, '');
    for (let index = 0; index < hex.length; index += 2) bytes.push(parseInt(hex.slice(index, index + 2), 16));
    if (bytes.length > 19) throw fail('oversized OpusHead');
  }
  const header = Buffer.from(bytes);
  if (header.length !== 19 || !header.subarray(0, 8).equals(Buffer.from('OpusHead')) || header[8] !== 1 ||
      header[9] !== 2 || header[18] !== 0) throw fail('unsupported or malformed stereo OpusHead');
  return header.readUInt16LE(10);
}

// The default writer's explicit wrappers are stable across the pinned probes.
// FFprobe 4.4's compact writer can attach "side_data" directly to duration's
// numeric value; using wrappers avoids depending on that version-specific bug.
function createPacketSectionReader(consume) {
  let packet = null, side = null;
  const assign = (target, key, value) => {
    if (Object.hasOwn(target, key)) throw invalid(`duplicate ${key} packet field`);
    target[key] = value;
  };
  return {
    consume(line) {
      if (!line.trim()) return;
      if (line === '[PACKET]') {
        if (packet) throw invalid('nested packet section');
        packet = {};
      } else if (line === '[SIDE_DATA]') {
        if (!packet || side) throw invalid('unexpected packet side-data section');
        side = {};
      } else if (line === '[/SIDE_DATA]') {
        if (!side) throw invalid('unmatched packet side-data end');
        if (side.side_data_type === 'Skip Samples') {
          if (side.skip_samples === undefined || side.discard_padding === undefined) throw invalid('incomplete skip side data');
          assign(packet, 'skip_samples', side.skip_samples);
          assign(packet, 'discard_padding', side.discard_padding);
        } else if (side.skip_samples !== undefined || side.discard_padding !== undefined) throw invalid('untyped packet skip values');
        side = null;
      } else if (line === '[/PACKET]') {
        if (!packet || side) throw invalid('unmatched packet end');
        consume(`packet|pts=${packet.pts}|duration=${packet.duration}` +
          (packet.skip_samples === undefined ? '' : `|skip_samples=${packet.skip_samples}|discard_padding=${packet.discard_padding}`));
        packet = null;
      } else {
        const equals = line.indexOf('=');
        if (!packet || equals < 1) throw invalid('unrecognized packet probe record');
        const key = line.slice(0, equals), value = line.slice(equals + 1);
        if (side) {
          if (['side_data_type', 'skip_samples', 'discard_padding'].includes(key)) assign(side, key, value);
        } else {
          if (!['pts', 'duration'].includes(key)) throw invalid('unexpected packet probe field');
          assign(packet, key, value);
        }
      }
    },
    finish() { if (packet || side) throw invalid('truncated packet section'); },
  };
}

// Only scalar counters and the previous packet are retained. WebM Duration is
// a nominal container endpoint, not decoded audio duration: Opus pre-skip and
// final discard padding must be subtracted from the encoded frame sample sum.
function createOpusPacketAccounting() {
  let stream = null, firstPacket = null, previous = null;
  let packets = 0, durationTicks = 0, maxGapTicks = 0, maxOverlapTicks = 0;
  const integer = (text, label, minimum = 0) => {
    if (typeof text !== 'string' || !/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < minimum) throw invalid(`invalid ${label}`);
    return Number(text);
  };
  return {
    metadataEvidence() { return boundedStreamEvidence(stream); },
    consume(line) {
      if (!line.trim()) return;
      const value = compactFields(line);
      if (line.startsWith('stream|')) {
        if (stream) throw invalid('multiple audio streams');
        stream = value;
      } else if (line.startsWith('packet|')) {
        const packet = { pts: integer(value.pts, 'packet timestamp', -Number.MAX_SAFE_INTEGER),
          duration: integer(value.duration, 'packet duration', 1),
          hasSkip: value.skip_samples !== undefined,
          skip: value.skip_samples === undefined ? 0 : integer(value.skip_samples, 'packet skip'),
          discard: value.discard_padding === undefined ? 0 : integer(value.discard_padding, 'packet discard padding') };
        if (previous) {
          if (previous.discard) throw invalid('discard padding occurs before the last packet');
          if (packet.skip) throw invalid('skip samples occur after the first packet');
          const difference = packet.pts - (previous.pts + previous.duration);
          maxGapTicks = Math.max(maxGapTicks, difference);
          maxOverlapTicks = Math.max(maxOverlapTicks, -difference);
        } else firstPacket = packet;
        previous = packet;
        durationTicks += packet.duration;
        packets++;
        if (!Number.isSafeInteger(durationTicks) || packets > 134000002) throw invalid('packet accounting exceeds its bound');
      } else throw invalid('unrecognized probe record');
    },
    result() {
      if (!stream || !packets) throw invalid('audio metadata or packets are missing');
      if (stream.codec_name !== 'opus' || stream.sample_rate !== '48000' || stream.channels !== '2') throw invalid('expected one 48kHz stereo Opus stream');
      const timeBase = /^(\d+)\/(\d+)$/.exec(stream.time_base || '');
      if (!timeBase || !Number(timeBase[1]) || !Number(timeBase[2])) throw invalid('invalid packet time base');
      const factor = 48000 * Number(timeBase[1]) / Number(timeBase[2]);
      const nominalSamples = durationTicks * factor;
      if (!Number.isSafeInteger(nominalSamples) || !Number.isSafeInteger(previous.duration * factor)) throw invalid('ambiguous encoded sample duration');
      const initialPadding = stream.initial_padding === undefined ? null : integer(stream.initial_padding, 'Opus initial padding');
      const headerPadding = opusHeadPadding(stream);
      if (initialPadding !== null && headerPadding !== null && initialPadding !== headerPadding) throw invalid('conflicting stream and OpusHead skip values');
      const declaredPadding = headerPadding ?? initialPadding;
      if (firstPacket.skip && declaredPadding !== null && firstPacket.skip !== declaredPadding) throw invalid('conflicting first-packet and stream skip values');
      if (declaredPadding === null && !firstPacket.hasSkip) throw invalid('Opus pre-skip evidence is missing');
      const preSkipSamples = declaredPadding ?? firstPacket.skip;
      // Older decoders can replace header skip with the explicit zero in a
      // first-and-last packet's discard side data. Do not guess that corner.
      if (packets === 1 && firstPacket.hasSkip && !firstPacket.skip && preSkipSamples) throw invalid('ambiguous single-packet Opus pre-skip');
      const discardPaddingSamples = previous.discard;
      if (preSkipSamples >= firstPacket.duration * factor || discardPaddingSamples >= previous.duration * factor) throw invalid('invalid codec padding');
      const decodedSamples = nominalSamples - preSkipSamples - discardPaddingSamples;
      const result = { codec: 'opus', sampleRate: 48000, channels: 2, packets,
        nominalSamples, preSkipSamples, discardPaddingSamples, decodedSamples,
        preSkipSource: headerPadding !== null ? 'opus-head' : initialPadding !== null ? 'stream-initial-padding' : 'first-packet-skip',
        duration: decodedSamples / 48000, firstPacketPts: firstPacket.pts, lastPacketPts: previous.pts,
        timeBase: stream.time_base, maxPacketGapSamples: maxGapTicks * factor, maxPacketOverlapSamples: maxOverlapTicks * factor };
      if (!Number.isSafeInteger(decodedSamples) || decodedSamples <= 0) throw invalid('empty decoded audio', result);
      // Final output is continuous PCM re-encoded to Opus. Allow only one
      // millisecond of Matroska timestamp quantization, not real packet gaps.
      if (result.maxPacketGapSamples > 48 || result.maxPacketOverlapSamples > 48) throw invalid('encoded packet timeline is discontinuous', result);
      return result;
    },
  };
}

function probeLines(ffprobePath, args, timeoutMs, consume) {
  return new Promise((resolve, reject) => {
    let buffered = '', stderr = '', failure = null, timer;
    const proc = spawn(ffprobePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const fail = error => { if (!failure) failure = error; try { proc.kill('SIGKILL'); } catch (_) { /* already closed */ } };
    timer = setTimeout(() => fail(invalid('packet inspection timed out')), timeoutMs);
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', text => {
      if (failure) return;
      buffered += text;
      try {
        let newline;
        while ((newline = buffered.indexOf('\n')) !== -1) {
          if (newline > 65536) throw invalid('probe line exceeds 64KiB');
          consume(buffered.slice(0, newline).replace(/\r$/, ''));
          buffered = buffered.slice(newline + 1);
        }
        if (buffered.length > 65536) throw invalid('probe line exceeds 64KiB');
      } catch (error) { fail(error); }
    });
    proc.stderr.on('data', text => { stderr = (stderr + text).slice(-16384); });
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('close', code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (code !== 0 || stderr.trim()) { reject(invalid(`packet probe failed (${code}): ${stderr.slice(-1024)}`)); return; }
      try { if (buffered) consume(buffered.replace(/\r$/, '')); resolve(); }
      catch (error) { reject(error); }
    });
  });
}

async function inspectEncodedOpus(file, { ffprobePath, timeoutMs = 300000 } = {}) {
  if (typeof ffprobePath !== 'string' || !ffprobePath || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw invalid('ffprobe path and bounded timeout are required');
  }
  const accounting = createOpusPacketAccounting(), deadline = performance.now() + timeoutMs;
  const prefix = ['-v', 'error', '-select_streams', 'a'];
  try {
    // Keep -show_data out of the full packet scan: older probes construct packet
    // hex dumps even when those payload fields are subsequently filtered out.
    await probeLines(ffprobePath, [...prefix, '-show_streams', '-show_data', '-show_entries',
      'stream=codec_name,sample_rate,channels,initial_padding,time_base,extradata,extradata_size:stream_tags=:stream_disposition=',
      '-of', 'compact=p=1:nk=0', file], timeoutMs, line => accounting.consume(line));
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw invalid('packet inspection timed out');
    // The list's unique name exists in 4.4 and newer. packet_side_data does not
    // exist in 4.4; generic side_data also selects frames and triggers decoding.
    const reader = createPacketSectionReader(line => accounting.consume(line));
    await probeLines(ffprobePath, [...prefix, '-show_packets', '-show_entries',
      'packet=pts,duration:packet_side_data_list', '-of', 'default=noprint_wrappers=0', file], remaining, line => reader.consume(line));
    reader.finish();
    return accounting.result();
  } catch (error) {
    error.evidence = { ...error.evidence, probeMetadata: accounting.metadataEvidence() };
    throw error;
  }
}

module.exports = { createOpusPacketAccounting, createPacketSectionReader, inspectEncodedOpus };
