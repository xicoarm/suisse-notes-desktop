'use strict';

const { spawn } = require('child_process');

function invalid(message, evidence) {
  return Object.assign(new Error(`Encoded Opus evidence: ${message}`), { code: 'NATIVE_ENCODED_OPUS_INVALID', evidence });
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
  function fields(line) {
    const result = {};
    for (const field of line.split('|').slice(1)) {
      const equals = field.indexOf('=');
      if (equals > 0) result[field.slice(0, equals)] = field.slice(equals + 1);
    }
    return result;
  }
  return {
    consume(line) {
      if (!line.trim()) return;
      const value = fields(line);
      if (line.startsWith('stream|')) {
        if (stream) throw invalid('multiple audio streams');
        stream = value;
      } else if (line.startsWith('packet|')) {
        const packet = { pts: integer(value.pts, 'packet timestamp', -Number.MAX_SAFE_INTEGER),
          duration: integer(value.duration, 'packet duration', 1),
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
      const initialPadding = integer(stream.initial_padding, 'Opus initial padding');
      if (firstPacket.skip && initialPadding && firstPacket.skip !== initialPadding) throw invalid('conflicting first-packet and stream skip values');
      const preSkipSamples = Math.max(initialPadding, firstPacket.skip);
      const discardPaddingSamples = previous.discard;
      if (preSkipSamples >= firstPacket.duration * factor || discardPaddingSamples >= previous.duration * factor) throw invalid('invalid codec padding');
      const decodedSamples = nominalSamples - preSkipSamples - discardPaddingSamples;
      const result = { codec: 'opus', sampleRate: 48000, channels: 2, packets,
        nominalSamples, preSkipSamples, discardPaddingSamples, decodedSamples,
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

function inspectEncodedOpus(file, { ffprobePath, timeoutMs = 300000 } = {}) {
  if (typeof ffprobePath !== 'string' || !ffprobePath || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    return Promise.reject(invalid('ffprobe path and bounded timeout are required'));
  }
  return new Promise((resolve, reject) => {
    const accounting = createOpusPacketAccounting();
    let buffered = '', stderr = '', failure = null, timer;
    const proc = spawn(ffprobePath, ['-v', 'error', '-select_streams', 'a', '-show_packets', '-show_streams',
      '-show_entries', 'stream=codec_name,sample_rate,channels,initial_padding,time_base:stream_tags=:stream_disposition=:packet=pts,duration:packet_side_data=skip_samples,discard_padding',
      '-of', 'compact=p=1:nk=0', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
          accounting.consume(buffered.slice(0, newline).replace(/\r$/, ''));
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
      try { if (buffered) accounting.consume(buffered.replace(/\r$/, '')); resolve(accounting.result()); }
      catch (error) { reject(error); }
    });
  });
}

module.exports = { createOpusPacketAccounting, inspectEncodedOpus };
