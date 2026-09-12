'use strict';

const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const PACKET_CACHE_BYTES = 1024 * 1024;
// This is a bounded final-output inspection constraint, not an RFC maximum:
// arbitrarily padded Opus packets can be larger. Unsupported output is retained.
const MAX_PACKET_BYTES = 65536;

function invalid(message, evidence) {
  return Object.assign(new Error(`Encoded Opus evidence: ${message}`), { code: 'NATIVE_ENCODED_OPUS_INVALID', evidence });
}

// RFC 6716 sections 3.1–3.2: validate packet framing before counting frames.
// The stereo flag describes coding, not the number of samples per channel.
// Zero-length compressed frames are valid; decoding remains a separate check.
function opusPacketSamples(packet) {
  if (!Buffer.isBuffer(packet) || !packet.length || packet.length > MAX_PACKET_BYTES) throw invalid('missing or oversized Opus packet');
  const config = packet[0] >> 3, code = packet[0] & 3;
  const frameSamples = config < 12 ? [480, 960, 1920, 2880][config & 3]
    : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  let cursor = 1, end = packet.length, frames = code === 0 ? 1 : 2;
  const frameLength = length => {
    if (!Number.isInteger(length) || length < 0 || length > 1275) throw invalid('invalid Opus frame length');
  };
  const readLength = () => {
    if (cursor >= end) throw invalid('truncated Opus frame length');
    const first = packet[cursor++];
    if (first < 252) return first;
    if (cursor >= end) throw invalid('truncated Opus long frame length');
    return first + 4 * packet[cursor++];
  };
  if (code === 0) frameLength(end - cursor);
  else if (code === 1) frameLength((end - cursor) / 2);
  else if (code === 2) {
    const first = readLength();
    frameLength(first); frameLength(end - cursor - first);
  } else {
    if (cursor >= end) throw invalid('truncated Opus frame count');
    const control = packet[cursor++];
    frames = control & 63;
    if (!frames || frames * frameSamples > 5760) throw invalid('invalid Opus packet duration');
    if (control & 64) {
      let padding = 0, value;
      do {
        if (cursor >= end) throw invalid('truncated Opus padding length');
        value = packet[cursor++]; padding += value === 255 ? 254 : value;
      } while (value === 255);
      end -= padding;
      if (end < cursor) throw invalid('Opus padding exceeds packet');
    }
    if (control & 128) {
      let used = 0;
      for (let index = 0; index < frames - 1; index++) { const length = readLength(); frameLength(length); used += length; }
      frameLength(end - cursor - used);
    } else frameLength((end - cursor) / frames);
  }
  if (frames * frameSamples > 5760) throw invalid('invalid Opus packet duration');
  return frames * frameSamples;
}

function fileIdentity(stat) {
  if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('invalid encoded file');
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size),
    mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
}
function sameFile(left, right) {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw invalid('encoded file identity or length changed');
}

// FFprobe's Matroska packet.pos is the Block binary payload position: a
// TrackNumber VINT, signed 16-bit relative timestamp and flags precede data.
// Verify the complete payload against FFprobe's hash before trusting the TOC.
// This also rejects transformed/header-stripped packets and unexpected layout.
// https://github.com/FFmpeg/FFmpeg/blob/e64a1d2953/libavformat/matroskadec.c
function createPacketFileReader(file, { deadline = Infinity } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw invalid('absolute encoded file path required');
  const before = fileIdentity(fs.lstatSync(file, { bigint: true }));
  let fd = fs.openSync(file, 'r');
  let cache;
  try { sameFile(before, fileIdentity(fs.fstatSync(fd, { bigint: true }))); cache = Buffer.allocUnsafe(PACKET_CACHE_BYTES); }
  catch (error) { fs.closeSync(fd); throw error; }
  let cacheStart = -1, cacheLength = 0, previousEnd = -1, track = null, readCalls = 0, bytesRead = 0, packets = 0;
  const integer = (value, label, minimum = 0) => {
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw invalid(`invalid packet ${label}`);
    return Number(value);
  };
  const read = (position, length) => {
    if (performance.now() >= deadline) throw invalid('packet inspection timed out');
    if (fd === null || !Number.isSafeInteger(position + length) || position < 0 || length < 1 || length > MAX_PACKET_BYTES || position + length > before.size) {
      throw invalid('packet byte range exceeds encoded file');
    }
    if (position < cacheStart || position + length > cacheStart + cacheLength) {
      cacheStart = position;
      cacheLength = fs.readSync(fd, cache, 0, cache.length, position);
      readCalls++; bytesRead += cacheLength;
      if (cacheLength < length) throw invalid('encoded packet read was truncated');
    }
    return cache.subarray(position - cacheStart, position - cacheStart + length);
  };
  return {
    readPacket(value) {
      const position = integer(value.pos, 'position'), size = integer(value.size, 'size', 1);
      if (position < previousEnd || size > MAX_PACKET_BYTES) throw invalid('overlapping, nonmonotonic or oversized encoded packet');
      if (typeof value.data_hash !== 'string' || !/^SHA256:[0-9a-f]{64}$/i.test(value.data_hash)) throw invalid('missing or invalid packet SHA256');
      const first = read(position, 1)[0];
      let width = 1, marker = 128;
      while (width <= 8 && !(first & marker)) { marker >>= 1; width++; }
      if (width > 8) throw invalid('invalid Block TrackNumber VINT');
      const header = read(position, width + 3);
      let number = BigInt(first & (marker - 1));
      for (let index = 1; index < width; index++) number = number * 256n + BigInt(header[index]);
      if (!number || (track !== null && number !== track)) throw invalid('missing or changed Block track');
      track = number;
      const flags = header[width + 2];
      if (flags & 6) throw invalid('laced encoded packets are unsupported');
      if (flags & 0x70) throw invalid('reserved Block flags are set');
      const payload = read(position + width + 3, size);
      if (createHash('sha256').update(payload).digest('hex') !== value.data_hash.slice(7).toLowerCase()) throw invalid('encoded packet SHA256 does not match probe');
      previousEnd = position + width + 3 + size; packets++;
      return payload;
    },
    verifyUnchanged() {
      if (fd === null) throw invalid('encoded file closed before verification');
      sameFile(before, fileIdentity(fs.fstatSync(fd, { bigint: true })));
      sameFile(before, fileIdentity(fs.lstatSync(file, { bigint: true })));
    },
    stats() { return { method: 'sha256-bound-webm-opus-framing', cacheBytes: PACKET_CACHE_BYTES, readCalls, bytesRead, packets }; },
    close() { if (fd !== null) { const handle = fd; fd = null; fs.closeSync(handle); } },
  };
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
        consume(`packet|pts=${packet.pts}|duration=${packet.duration}|pos=${packet.pos}|size=${packet.size}|data_hash=${packet.data_hash}` +
          (packet.skip_samples === undefined ? '' : `|skip_samples=${packet.skip_samples}|discard_padding=${packet.discard_padding}`));
        packet = null;
      } else {
        const equals = line.indexOf('=');
        if (!packet || equals < 1) throw invalid('unrecognized packet probe record');
        const key = line.slice(0, equals), value = line.slice(equals + 1);
        if (side) {
          if (['side_data_type', 'skip_samples', 'discard_padding'].includes(key)) assign(side, key, value);
        } else {
          if (!['pts', 'duration', 'pos', 'size', 'data_hash'].includes(key)) throw invalid('unexpected packet probe field');
          assign(packet, key, value);
        }
      }
    },
    finish() { if (packet || side) throw invalid('truncated packet section'); },
  };
}

// Only counters, the previous packet, and delta extrema for at most 48 possible
// RFC packet durations (120..5760 samples) are retained. WebM Duration is
// a nominal container endpoint, not decoded audio duration: Opus pre-skip and
// final discard padding must be subtracted from the encoded frame sample sum.
function createOpusPacketAccounting({ readPacket } = {}) {
  let stream = null, firstPacket = null, previous = null;
  let packets = 0, durationTicks = 0, maxGapTicks = 0, maxOverlapTicks = 0;
  let nominalSamples = 0;
  let minPacketSamples = Infinity, maxPacketSamples = 0;
  const codedSpans = new Map();
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
        if (typeof readPacket !== 'function') throw invalid('verified coded-packet evidence is required');
        const packet = { pts: integer(value.pts, 'packet timestamp', -Number.MAX_SAFE_INTEGER),
          duration: integer(value.duration, 'packet duration', 1),
          samples: opusPacketSamples(readPacket(value)),
          hasSkip: value.skip_samples !== undefined,
          skip: value.skip_samples === undefined ? 0 : integer(value.skip_samples, 'packet skip'),
          discard: value.discard_padding === undefined ? 0 : integer(value.discard_padding, 'packet discard padding') };
        if (previous) {
          if (previous.discard) throw invalid('discard padding occurs before the last packet');
          if (packet.skip) throw invalid('skip samples occur after the first packet');
          const difference = packet.pts - (previous.pts + previous.duration);
          maxGapTicks = Math.max(maxGapTicks, difference);
          maxOverlapTicks = Math.max(maxOverlapTicks, -difference);
          // Container duration can be effective rather than coded. It must not
          // hide a PTS hole or overlap relative to the verified Opus payload.
          const delta = packet.pts - previous.pts;
          const span = codedSpans.get(previous.samples) || { min: Infinity, max: -Infinity };
          span.min = Math.min(span.min, delta); span.max = Math.max(span.max, delta);
          codedSpans.set(previous.samples, span);
        } else firstPacket = packet;
        previous = packet;
        durationTicks += packet.duration;
        nominalSamples += packet.samples;
        minPacketSamples = Math.min(minPacketSamples, packet.samples); maxPacketSamples = Math.max(maxPacketSamples, packet.samples);
        packets++;
        if (!Number.isSafeInteger(durationTicks) || !Number.isSafeInteger(nominalSamples) || packets > 134000002) throw invalid('packet accounting exceeds its bound');
      } else throw invalid('unrecognized probe record');
    },
    result() {
      if (!stream || !packets) throw invalid('audio metadata or packets are missing');
      if (stream.codec_name !== 'opus' || stream.sample_rate !== '48000' || stream.channels !== '2') throw invalid('expected one 48kHz stereo Opus stream');
      const timeBase = /^(\d+)\/(\d+)$/.exec(stream.time_base || '');
      if (!timeBase || !Number.isSafeInteger(Number(timeBase[1])) || !Number.isSafeInteger(Number(timeBase[2])) ||
          Number(timeBase[1]) <= 0 || Number(timeBase[2]) <= 0) throw invalid('invalid packet time base');
      const factor = 48000 * Number(timeBase[1]) / Number(timeBase[2]);
      if (!Number.isFinite(factor) || factor <= 0) throw invalid('invalid packet time base');
      if (!Number.isSafeInteger(durationTicks * factor) || !Number.isSafeInteger(previous.duration * factor)) throw invalid('ambiguous encoded sample duration');
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
      if (preSkipSamples >= firstPacket.samples || discardPaddingSamples >= previous.samples) throw invalid('invalid codec padding');
      const decodedSamples = nominalSamples - preSkipSamples - discardPaddingSamples;
      let maxCodedPacketGapSamples = 0, maxCodedPacketOverlapSamples = 0;
      for (const [samples, span] of codedSpans) {
        maxCodedPacketGapSamples = Math.max(maxCodedPacketGapSamples, span.max * factor - samples);
        maxCodedPacketOverlapSamples = Math.max(maxCodedPacketOverlapSamples, samples - span.min * factor);
      }
      const result = { codec: 'opus', sampleRate: 48000, channels: 2, packets,
        nominalSamples, minPacketSamples, maxPacketSamples, containerDurationTicks: durationTicks, preSkipSamples, discardPaddingSamples, decodedSamples,
        preSkipSource: headerPadding !== null ? 'opus-head' : initialPadding !== null ? 'stream-initial-padding' : 'first-packet-skip',
        duration: decodedSamples / 48000, firstPacketPts: firstPacket.pts, lastPacketPts: previous.pts,
        timeBase: stream.time_base, maxPacketGapSamples: maxGapTicks * factor, maxPacketOverlapSamples: maxOverlapTicks * factor,
        maxCodedPacketGapSamples, maxCodedPacketOverlapSamples };
      if (!Number.isSafeInteger(decodedSamples) || decodedSamples <= 0) throw invalid('empty decoded audio', result);
      // Final output is continuous PCM re-encoded to Opus. Allow only one
      // millisecond of Matroska timestamp quantization, not real packet gaps.
      if (result.maxPacketGapSamples > 48 || result.maxPacketOverlapSamples > 48) throw invalid('encoded packet timeline is discontinuous', result);
      if (maxCodedPacketGapSamples > 48 || maxCodedPacketOverlapSamples > 48) throw invalid('coded packet timeline is discontinuous', result);
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
  const deadline = performance.now() + timeoutMs;
  let packetFile;
  const accounting = createOpusPacketAccounting({ readPacket: value => packetFile.readPacket(value) });
  const prefix = ['-v', 'error', '-select_streams', 'a'];
  try {
    packetFile = createPacketFileReader(file, { deadline });
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
    await probeLines(ffprobePath, [...prefix, '-show_packets', '-show_data_hash', 'sha256', '-show_entries',
      'packet=pts,duration,pos,size,data_hash:packet_side_data_list', '-of', 'default=noprint_wrappers=0', file], remaining, line => reader.consume(line));
    reader.finish();
    const result = accounting.result();
    packetFile.verifyUnchanged();
    return { ...result, codedSampleEvidence: packetFile.stats() };
  } catch (error) {
    error.evidence = { ...error.evidence, probeMetadata: accounting.metadataEvidence() };
    throw error;
  } finally { packetFile?.close(); }
}

module.exports = { createOpusPacketAccounting, createPacketSectionReader, inspectEncodedOpus, opusPacketSamples, createPacketFileReader };
