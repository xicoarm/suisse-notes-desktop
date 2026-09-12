'use strict';

// Test-only observability. A completed measurement cannot qualify a recording
// or override the native finalization suite which runs after this command.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '../../..');
const WORK = path.join(ROOT, 'tests/e2e-harness/work/macos-packaged');
const LIMITS = Object.freeze({ totalMs: 180000, commandMs: 30000, stdoutBytes: 8 * 1024 * 1024,
  stderrBytes: 256 * 1024, binaryBytes: 512 * 1024 * 1024, fixtureSamples: 592560 });
const SCOPE = 'Synthetic media measurements only; not capture, hardware, backend, or release qualification. Existing strict tests and historical failures remain unchanged.';
const OPUS_OPTIONS = Object.freeze(['-c:a', 'libopus', '-b:a', '192k', '-ar', '48000', '-ac', '2',
  '-threads', '1', '-vbr', 'off', '-frame_duration', '20', '-application', 'audio',
  '-map_metadata', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1']);

function save(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx' }); }
function regular(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Expected an absolute regular file');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > LIMITS.binaryBytes) throw new Error('Invalid or oversized diagnostic file');
  return stat;
}
function binaryPair(ffmpeg, ffprobe) {
  if (!ffmpeg || !ffprobe) throw new Error('Both explicit FFmpeg and ffprobe paths are required; there is no fallback');
  regular(ffmpeg); regular(ffprobe);
  if (path.dirname(ffmpeg) !== path.dirname(ffprobe) ||
      !/^ffmpeg(?:\.exe)?$/.test(path.basename(ffmpeg)) || !/^ffprobe(?:\.exe)?$/.test(path.basename(ffprobe))) {
    throw new Error('Expected paired FFmpeg and ffprobe resources in one directory');
  }
  return { ffmpeg, ffprobe };
}
async function fingerprint(file) {
  const stat = regular(file), hash = crypto.createHash('sha256');
  for await (const data of fs.createReadStream(file)) hash.update(data);
  const after = fs.statSync(file);
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('File changed during fingerprint');
  return { path: file, bytes: stat.size, mode: stat.mode & 0o777, sha256: hash.digest('hex') };
}
async function mediaFingerprint(file) {
  if (regular(file).size >= LIMITS.stdoutBytes) throw new Error('Media evidence reached its file-size cap');
  return fingerprint(file);
}
async function provenance(pair) {
  const files = [__filename, path.join(ROOT, 'src-electron/native-source-finalization.js'),
    path.join(ROOT, 'src-electron/encoded-opus-evidence.js'), path.join(ROOT, 'package-lock.json'),
    require.resolve('fluent-ffmpeg/lib/capabilities'), require.resolve('fluent-ffmpeg/lib/utils'),
    require.resolve('fluent-ffmpeg/package.json'), process.execPath, pair.ffmpeg, pair.ffprobe];
  const result = [];
  for (const file of files) result.push(await fingerprint(file));
  return result;
}
function sameProvenance(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Diagnostic source or binary provenance changed');
}

function wave(samples) {
  if (!Number.isSafeInteger(samples) || samples <= 0 || samples > LIMITS.fixtureSamples) throw new Error('Synthetic sample count exceeds its bound');
  const buffer = Buffer.alloc(44 + samples * 4);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(48000, 24); buffer.writeUInt32LE(192000, 28); buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 4, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(3276.7 * Math.sin(2 * Math.PI * 440 * i / 48000)), 44 + i * 4);
    buffer.writeInt16LE(Math.round(3276.7 * Math.sin(2 * Math.PI * 880 * i / 48000)), 46 + i * 4);
  }
  return buffer;
}

// execFile owns only this direct native process, uses no shell/detachment, and
// kills it on timeout or buffer overflow. Retain partial stdout/stderr on error.
function command(file, args, { directory, name, deadline, cwd = ROOT, commandMs = LIMITS.commandMs,
  stdoutBytes = LIMITS.stdoutBytes, stderrBytes = LIMITS.stderrBytes } = {}) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error('Media diagnostic command budget exhausted');
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid diagnostic command name');
  const timeout = Math.min(commandMs, remaining);
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const child = execFile(file, args, { cwd, windowsHide: true, encoding: 'buffer', timeout,
      maxBuffer: Math.max(stdoutBytes, stderrBytes), killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      try {
        stdout ||= Buffer.alloc(0); stderr ||= Buffer.alloc(0);
        // Native tools should never reach either bound for these tiny inputs.
        const exceeded = stdout.length > stdoutBytes || stderr.length > stderrBytes;
        const out = path.join(directory, `${name}.stdout`), err = path.join(directory, `${name}.stderr`);
        fs.writeFileSync(out, stdout.subarray(0, stdoutBytes), { flag: 'wx' });
        fs.writeFileSync(err, stderr.subarray(0, stderrBytes), { flag: 'wx' });
        const record = { file, args, pid: child.pid || null, startedAt, timeoutMs: timeout,
          elapsedMs: performance.now() - started, exitCode: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
          signal: error?.signal || null, error: error?.message || (exceeded ? 'Output bound exceeded' : null),
          errorCode: typeof error?.code === 'string' ? error.code : null, killed: !!error?.killed,
          stdout: out, stderr: err, stdoutBytes: stdout.length, stderrBytes: stderr.length,
          stdoutCap: stdoutBytes, stderrCap: stderrBytes, complete: !error && !exceeded };
        record.retainedStdoutSha256 = crypto.createHash('sha256').update(stdout.subarray(0, stdoutBytes)).digest('hex');
        record.retainedStderrSha256 = crypto.createHash('sha256').update(stderr.subarray(0, stderrBytes)).digest('hex');
        save(path.join(directory, `${name}.command.json`), record);
        resolve(record);
      } catch (failure) { reject(failure); }
    });
    // Enforce the smaller stderr cap while the process is still running.
    let errBytes = 0;
    child.stderr.on('data', data => { errBytes += data.length; if (errBytes > stderrBytes) child.kill('SIGKILL'); });
  });
}

function parseActualFormats(stdout) {
  const source = require.resolve('fluent-ffmpeg/lib/capabilities');
  delete require.cache[source]; // Do not reuse a capability cache from a different binary.
  const proto = {};
  require(source)(proto);
  let output;
  proto._spawnFfmpeg = (args, options, callback) => {
    if (JSON.stringify(args) !== JSON.stringify(['-formats'])) throw new Error('Unexpected format-parser command');
    callback(null, { get: () => stdout });
  };
  proto.availableFormats((error, formats) => { if (error) throw error; output = formats; });
  if (!output) throw new Error('Format parser did not complete synchronously');
  return { method: 'Actual saved -formats stdout replayed through installed fluent-ffmpeg availableFormats parser',
    version: require('fluent-ffmpeg/package.json').version, lavfiRecognized: output.lavfi?.canDemux === true, formats: output };
}
function packetSummary(probe) {
  if (!Array.isArray(probe.streams) || probe.streams.length !== 1 || !Array.isArray(probe.packets) || !probe.packets.length || probe.packets.length > 1000) {
    throw new Error('Missing or unbounded packet/stream evidence');
  }
  for (const packet of probe.packets) {
    if (typeof packet.data !== 'string' || !packet.data.trim()) throw new Error('Full packet data including Opus TOC is missing');
    if (!Number.isSafeInteger(packet.duration) || packet.duration <= 0 || !Number.isSafeInteger(packet.pts)) throw new Error('Invalid packet duration or timestamp evidence');
  }
  const stream = probe.streams[0];
  if (stream.codec_name !== 'opus' || stream.sample_rate !== '48000' || stream.channels !== 2 || typeof stream.extradata !== 'string' || !stream.extradata.trim()) {
    throw new Error('Unexpected encoded format or missing OpusHead');
  }
  const timeBase = /^(\d+)\/(\d+)$/.exec(stream.time_base || '');
  if (!timeBase || !Number.isSafeInteger(Number(timeBase[1])) || !Number.isSafeInteger(Number(timeBase[2])) ||
      Number(timeBase[1]) <= 0 || Number(timeBase[2]) <= 0) throw new Error('Invalid stream time base evidence');
  return { stream, packets: probe.packets.length, first: probe.packets[0], last: probe.packets.at(-1),
    containerDurationTicks: probe.packets.reduce((sum, packet) => sum + Number(packet.duration), 0),
    note: 'Container packet duration is not asserted to equal coded Opus duration. Full raw packet data is preserved for independent TOC/skip/discard analysis.' };
}

async function diagnose({ ffmpegPath, ffprobePath, work = WORK } = {}) {
  const pair = binaryPair(ffmpegPath, ffprobePath);
  fs.mkdirSync(work, { recursive: true });
  const directory = fs.mkdtempSync(path.join(work, 'media-diagnostic-'));
  const deadline = performance.now() + LIMITS.totalMs;
  const summary = { scope: SCOPE, qualificationPass: false, measurementComplete: false, directory,
    limits: LIMITS, platform: process.platform, arch: process.arch, node: process.version,
    memory: { freeBytes: os.freemem(), totalBytes: os.totalmem() }, failures: [], commands: [], fixtures: [] };
  const run = async (file, args, name) => {
    const result = await command(file, args, { directory, name, deadline });
    summary.commands.push(result);
    return result;
  };
  const required = async (...args) => {
    const result = await run(...args);
    if (!result.complete) throw new Error(`Evidence command ${args[2]} did not complete`);
    return result;
  };
  let before;
  try {
    before = await provenance(pair); save(path.join(directory, 'provenance-before.json'), before);
    save(path.join(directory, 'context.json'), { ...summary, opusOptions: OPUS_OPTIONS,
      sourcePremises: [
        'https://raw.githubusercontent.com/FFmpeg/FFmpeg/e64a1d2953/libavformat/matroskaenc.c',
        'https://raw.githubusercontent.com/FFmpeg/FFmpeg/e64a1d2953/libavcodec/libopusenc.c',
        'https://raw.githubusercontent.com/FFmpeg/FFmpeg/e64a1d2953/fftools/opt_common.c'
      ] });
    const revision = await required('git', ['rev-parse', 'HEAD'], 'revision');
    summary.commit = fs.readFileSync(revision.stdout, 'utf8').trim();
    if (!/^[a-f0-9]{40}$/.test(summary.commit) || (process.env.SUISSE_E2E_BUNDLE_SHA && process.env.SUISSE_E2E_BUNDLE_SHA !== summary.commit)) {
      throw new Error('Missing or mismatched checked-out revision');
    }
    await required(pair.ffmpeg, ['-version'], 'ffmpeg-version');
    await required(pair.ffprobe, ['-version'], 'ffprobe-version');
    const formats = await required(pair.ffmpeg, ['-formats'], 'ffmpeg-formats');
    summary.fluentFormats = parseActualFormats(fs.readFileSync(formats.stdout, 'utf8'));
    save(path.join(directory, 'fluent-formats.json'), summary.fluentFormats);
    const common = ['-hide_banner', '-nostdin', '-y', '-xerror', '-max_alloc', '67108864', '-filter_threads', '1', '-filter_complex_threads', '1'];
    const lavfi = await run(pair.ffmpeg, [...common, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', '0.25', '-c:a', 'pcm_f32le', '-f', 'f32le', '-fs', String(LIMITS.stdoutBytes), path.join(directory, 'lavfi.f32le')], 'direct-lavfi');
    if (!lavfi.complete && (lavfi.killed || lavfi.errorCode || !Number.isInteger(lavfi.exitCode) ||
        lavfi.stdoutBytes > lavfi.stdoutCap || lavfi.stderrBytes > lavfi.stderrCap)) throw new Error('Direct lavfi diagnostic was incomplete or truncated');
    summary.lavfi = { directCommandComplete: lavfi.complete, fluentRecognized: summary.fluentFormats.lavfiRecognized,
      pcm: lavfi.complete ? await mediaFingerprint(path.join(directory, 'lavfi.f32le')) : null };
    for (const samples of [48000, 592560]) {
      const name = `samples-${samples}`, input = path.join(directory, `${name}.wav`), encoded = path.join(directory, `${name}.webm`);
      fs.writeFileSync(input, wave(samples), { flag: 'wx' });
      const item = { expectedSamples: samples, input: await fingerprint(input) };
      summary.fixtures.push(item);
      try {
        await required(pair.ffmpeg, [...common, '-i', input, ...OPUS_OPTIONS, '-f', 'webm', '-fs', String(LIMITS.stdoutBytes), encoded], `${name}-encode`);
        item.encoded = await mediaFingerprint(encoded);
        const probe = await required(pair.ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_streams', '-show_packets', '-show_data', '-of', 'json', encoded], `${name}-probe`);
        item.probe = packetSummary(JSON.parse(fs.readFileSync(probe.stdout, 'utf8')));
        const raw = path.join(directory, `${name}.decoded.f32le`);
        await required(pair.ffmpeg, [...common, '-i', encoded, '-map', '0:a:0', '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', '-threads', '1', '-f', 'f32le', '-fs', String(LIMITS.stdoutBytes), raw], `${name}-decode`);
        item.decoded = await mediaFingerprint(raw);
        item.decodedSamples = item.decoded.bytes / 8;
        item.wholeStereoFloatFrames = Number.isInteger(item.decodedSamples);
        if (!item.wholeStereoFloatFrames) throw new Error('Decoded PCM evidence contains a partial stereo float frame');
        item.exactSampleCount = item.decodedSamples === samples;
        // Deliberately report mismatches. Only the existing strict suite can qualify its contracts.
      } catch (error) { item.error = error.message; summary.failures.push(`${name}: ${error.message}`); }
      save(path.join(directory, `${name}.result.json`), item);
    }
  } catch (error) { summary.failures.push(error.stack || error.message); }
  finally {
    try {
      const after = await provenance(pair); save(path.join(directory, 'provenance-after.json'), after);
      if (!before) { summary.provenanceUnchanged = false; summary.failures.push('Before provenance missing'); }
      else { sameProvenance(before, after); summary.provenanceUnchanged = true; }
    } catch (error) { summary.provenanceUnchanged = false; summary.failures.push(error.message); }
    summary.elapsedMs = LIMITS.totalMs - (deadline - performance.now());
    if (summary.elapsedMs > LIMITS.totalMs) summary.failures.push('Media diagnostic total deadline exceeded');
    summary.measurementComplete = !summary.failures.length && summary.fixtures.length === 2 && summary.provenanceUnchanged;
    save(path.join(directory, 'summary.json'), summary);
  }
  return summary;
}

if (require.main === module) {
  diagnose({ ffmpegPath: process.env.SUISSE_TEST_FFMPEG_PATH, ffprobePath: process.env.SUISSE_TEST_FFPROBE_PATH })
    .then(result => { console.log(JSON.stringify({ directory: result.directory, measurementComplete: result.measurementComplete,
      qualificationPass: false, failures: result.failures })); if (!result.measurementComplete) process.exitCode = 1; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { LIMITS, OPUS_OPTIONS, SCOPE, binaryPair, fingerprint, sameProvenance, wave, command, parseActualFormats, packetSummary, diagnose };
