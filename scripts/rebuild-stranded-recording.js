#!/usr/bin/env node
'use strict';

// Support tool: rebuild ONE audio file from a recording folder that a customer
// copied off their machine (recordings/<id> in the app's user-data directory),
// when the app could not finalize it (for example ELECTRON-7R, "timestamp
// compensation failed"). It runs the app's own native finalization, including its
// sample-order fallbacks, on a COPY in a temporary sandbox. The folder you pass
// is only read; its files are hashed before and after to prove that.
//
//   node scripts/rebuild-stranded-recording.js <recording-folder> [--out <file.mp3|.wav|.webm>]
//        [--expected-duration <seconds>] [--work-dir <dir>] [--keep-scratch] [--ffmpeg <path> --ffprobe <path>]
//
// Writes the audio (default: <folder>-rebuilt.mp3 next to the folder) and
// <audio>.report.json with warnings, timeline evidence and hashes.
// Older recordings without native-sources/ get a best-effort join of chunks/.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { inspectNativeSources } = require('../src-electron/native-source-persistence');
const { createNativeSourceFinalization } = require('../src-electron/native-source-finalization');
const { validateNativeMedia } = require('../src-electron/native-media-validation');

const OUTPUT_FORMATS = {
  '.mp3': ['-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '48000', '-ac', '2'],
  '.wav': ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'],
  '.webm': null,
};
// Copied into the sandbox. Old scratch (native-finalization-*), outputs and
// logs are not needed: the build starts from the original sources only.
const COPIED_ENTRIES = ['native-sources', 'chunks', 'system_audio.raw', 'native-capture.json', 'metadata.json', 'finalization-plan.json'];

// Resolves symbolic links of the deepest existing ancestor (macOS /var -> /private/var),
// so containment checks compare like with like even for paths not created yet.
function realResolve(file) {
  let existing = path.resolve(file);
  const rest = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) { rest.unshift(path.basename(existing)); existing = path.dirname(existing); }
  return path.join(fs.realpathSync(existing), ...rest);
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing a symbolic link in the recording folder: ${file}`);
    if (entry.isDirectory()) files.push(...listFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort();
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const block of fs.createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

// Hash of every copied input file: relative path, size and content.
async function inventory(folder) {
  const hash = createHash('sha256');
  let files = 0, bytes = 0;
  for (const name of COPIED_ENTRIES) {
    const entry = path.join(folder, name);
    if (!fs.existsSync(entry)) continue;
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error(`Refusing a symbolic link in the recording folder: ${entry}`);
    for (const file of stat.isDirectory() ? listFiles(entry) : [entry]) {
      const size = fs.statSync(file).size;
      hash.update(`${path.relative(folder, file).split(path.sep).join('/')}\0${size}\0${await sha256(file)}\n`);
      files++; bytes += size;
    }
  }
  return { files, bytes, sha256: hash.digest('hex') };
}

async function copyInputs(folder, sandbox) {
  for (const name of COPIED_ENTRIES) {
    const entry = path.join(folder, name);
    if (fs.existsSync(entry)) await fs.promises.cp(entry, path.join(sandbox, name), { recursive: true, errorOnExist: true, force: false });
  }
}

function resolveBinaries({ ffmpegPath, ffprobePath }) {
  if (!!ffmpegPath !== !!ffprobePath) throw new Error('Pass both --ffmpeg and --ffprobe, or neither');
  return {
    ffmpegPath: ffmpegPath || require('@ffmpeg-installer/ffmpeg').path,
    ffprobePath: ffprobePath || require('@ffprobe-installer/ffprobe').path,
  };
}

function createRunner(log) {
  return (command, timeoutMs = 45 * 60000, operation = 'FFmpeg') => new Promise((resolve, reject) => {
    log(`${operation} ...`);
    const timer = setTimeout(() => { try { command.kill('SIGKILL'); } catch (_) { /* already ended */ } reject(new Error(`${operation} timed out`)); }, timeoutMs);
    command.on('error', error => { clearTimeout(timer); reject(error); })
      .on('end', () => { clearTimeout(timer); resolve(); }).run();
  });
}

function expectedDuration(folder, override) {
  if (override !== undefined) return override;
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json'), 'utf8'));
    const value = Number(metadata.duration);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (_) { return 0; }
}

// Recordings from before native capture: chunk bytes form one stream.
async function legacyBuild(ffmpeg, run, sandbox, building) {
  const directory = path.join(sandbox, 'chunks');
  const chunks = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^chunk_\d+\.webm$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])) : [];
  const pcm = path.join(sandbox, 'system_audio.raw');
  const hasPcm = fs.existsSync(pcm) && fs.statSync(pcm).size > 0;
  if (!chunks.length && !hasPcm) throw new Error('No native-sources/, chunks/chunk_N.webm or system_audio.raw found to rebuild');
  const joined = path.join(sandbox, 'legacy-joined.webm');
  if (chunks.length) {
    await fs.promises.writeFile(joined, Buffer.alloc(0));
    for (const name of chunks) await fs.promises.appendFile(joined, await fs.promises.readFile(path.join(directory, name)));
  }
  let command = ffmpeg();
  if (chunks.length) command = command.input(joined);
  if (hasPcm) command = command.input(pcm).inputOptions(['-f', 's16le', '-ar', '48000', '-ac', '1']);
  if (chunks.length && hasPcm) command = command.complexFilter(['[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[out]'], ['out']);
  await run(command.audioCodec('libopus').audioBitrate(192).audioFrequency(48000).audioChannels(2).output(building), 45 * 60000, 'Join legacy chunks');
  const warnings = [{ kind: 'legacy-best-effort', chunks: chunks.length, systemPcmIncluded: hasPcm }];
  return { success: true, outputPath: building, warnings, sourceIds: [], systemPcmIncluded: hasPcm, sourceMode: 'legacy', plan: null };
}

async function rebuildRecording({ input, output, expectedDurationSec, workDir = os.tmpdir(), keepScratch = false,
  ffmpegPath, ffprobePath, log = () => {} }) {
  const folder = fs.realpathSync(path.resolve(input));
  if (!fs.statSync(folder).isDirectory()) throw new Error(`Not a recording folder: ${folder}`);
  const outputPath = realResolve(output || `${folder}-rebuilt.mp3`);
  const extension = path.extname(outputPath).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(OUTPUT_FORMATS, extension)) throw new Error('Output must end in .mp3, .wav or .webm');
  if (within(folder, outputPath)) throw new Error('Write the output outside the customer recording folder; it is only read');
  if (fs.existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
  if (within(folder, realResolve(workDir))) throw new Error('The work directory must be outside the recording folder');

  const binaries = resolveBinaries({ ffmpegPath, ffprobePath });
  const ffmpeg = require('fluent-ffmpeg');
  ffmpeg.setFfmpegPath(binaries.ffmpegPath);
  ffmpeg.setFfprobePath(binaries.ffprobePath);
  const exec = promisify(execFile);
  const run = createRunner(log);

  log('Hashing the original folder ...');
  const before = await inventory(folder);
  const sandbox = await fs.promises.mkdtemp(path.join(workDir, 'suisse-rebuild-'));
  const report = { tool: 'rebuild-stranded-recording', createdAt: new Date().toISOString(), input: folder, inputBefore: before,
    ffmpegVersion: (await exec(binaries.ffmpegPath, ['-version'], { windowsHide: true, timeout: 30000 })).stdout.split(/\r?\n/)[0],
    sandbox, output: outputPath };
  try {
    await copyInputs(folder, sandbox);
    const copied = await inventory(sandbox);
    if (copied.sha256 !== before.sha256) throw new Error('The sandbox copy differs from the original folder');
    const sources = inspectNativeSources(sandbox);
    const pcm = path.join(sandbox, 'system_audio.raw');
    const pcmEmpty = fs.existsSync(pcm) && fs.statSync(pcm).size === 0;
    // A stranded recording may never have closed a source cleanly. Recovery
    // keeps such tails rather than refusing them; the report says so.
    const recovery = sources.some(source => source.interrupted) || pcmEmpty;
    const expected = expectedDuration(folder, expectedDurationSec);
    Object.assign(report, { recovery, expectedDurationSec: expected, sources: sources.map(source => ({ sourceId: source.sourceId,
      kind: source.kind, chunkCount: source.chunkCount, startOffsetMs: source.startOffsetMs, endOffsetMs: source.endOffsetMs,
      interrupted: source.interrupted, hasAudio: source.hasAudio, gaps: source.gaps.length, terminalMismatch: source.terminalMismatch })) });
    const building = path.join(sandbox, 'audio_rebuild_building.webm');
    let built;
    if (fs.existsSync(path.join(sandbox, 'native-sources'))) {
      const finalizer = createNativeSourceFinalization({ ffmpeg, run, ffprobePath: binaries.ffprobePath, validate: validateNativeMedia,
        probe: file => new Promise((resolve, reject) => ffmpeg.ffprobe(file, (error, data) => error ? reject(error) : resolve(Number(data.format.duration)))),
        checkSpace: async neededBytes => {
          if (typeof fs.promises.statfs !== 'function') return;
          const stat = await fs.promises.statfs(sandbox);
          if (stat.bavail * stat.bsize < neededBytes) throw Object.assign(new Error(`Not enough space in ${workDir}: ${Math.ceil(neededBytes / 1048576)} MB needed`), { code: 'ENOSPC' });
        } });
      built = await finalizer.build(sandbox, building, { recovery, expectedDurationSec: expected });
    } else {
      built = await legacyBuild(ffmpeg, run, sandbox, building);
    }
    const plan = built.plan;
    report.build = { sourceMode: built.sourceMode, sourceIds: built.sourceIds, systemPcmIncluded: built.systemPcmIncluded,
      fastPathUsed: built.fastPathUsed ?? null, warnings: built.warnings, totalSamples: plan?.totalSamples ?? null,
      validation: plan ? { status: plan.validation.status, observedDecodedSamples: plan.validation.observedDecodedSamples } : null,
      sourceEvidence: (plan?.sourceEvidence || []).map(item => ({ sourceId: item.sourceId, kind: item.kind,
        timeline: item.timeline || 'timestamps', decodedDuration: item.decodedDuration, restoredGaps: item.restoredGaps || [],
        gapCount: item.timing?.gapCount, gapSeconds: item.timing ? item.timing.gapSamples / 48000 : undefined,
        overlapCount: item.timing?.overlapCount, resamplerFailure: item.timing?.resamplerFailure || null })) };

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    const options = OUTPUT_FORMATS[extension];
    if (options) await run(ffmpeg(building).outputOptions(['-map_metadata', '-1', ...options]).output(outputPath), 45 * 60000, `Write ${extension}`);
    else await fs.promises.copyFile(building, outputPath, fs.constants.COPYFILE_EXCL);
    const duration = await new Promise((resolve, reject) => ffmpeg.ffprobe(outputPath, (error, data) => error ? reject(error) : resolve(Number(data.format.duration))));
    report.result = { path: outputPath, bytes: fs.statSync(outputPath).size, sha256: await sha256(outputPath), durationSeconds: duration };
  } catch (error) {
    report.error = { message: String(error.message), code: error.code || null };
    throw Object.assign(error, { report });
  } finally {
    report.inputAfter = await inventory(folder);
    report.inputUnchanged = report.inputAfter.sha256 === before.sha256;
    if (!keepScratch && !report.error) await fs.promises.rm(sandbox, { recursive: true, force: true });
    else report.scratchKept = sandbox;
    const reportPath = `${outputPath}.report.json`;
    if (!fs.existsSync(reportPath)) await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));
    report.reportPath = reportPath;
  }
  if (!report.inputUnchanged) throw Object.assign(new Error('The original recording folder changed during the rebuild'), { report });
  return report;
}

function parseArguments(args) {
  const values = {};
  const flags = { '--out': 'output', '--expected-duration': 'expectedDurationSec', '--work-dir': 'workDir',
    '--ffmpeg': 'ffmpegPath', '--ffprobe': 'ffprobePath' };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--keep-scratch') { values.keepScratch = true; continue; }
    if (key === '--help' || key === '-h') { values.help = true; continue; }
    if (flags[key]) {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      if (values[flags[key]] !== undefined) throw new Error(`Repeated argument: ${key}`);
      values[flags[key]] = key === '--expected-duration' ? Number(value) : path.resolve(value);
      if (key === '--expected-duration' && !(values.expectedDurationSec >= 0)) throw new Error('--expected-duration must be seconds');
      continue;
    }
    if (key.startsWith('--') || values.input) throw new Error(`Unsupported argument: ${key}`);
    values.input = key;
  }
  if (!values.help && !values.input) throw new Error('Pass the copied recording folder');
  return values;
}

async function main(args = process.argv.slice(2)) {
  const values = parseArguments(args);
  if (values.help) {
    process.stdout.write('Usage: node scripts/rebuild-stranded-recording.js <recording-folder> [--out file.mp3|.wav|.webm]\n' +
      '       [--expected-duration seconds] [--work-dir dir] [--keep-scratch] [--ffmpeg path --ffprobe path]\n');
    return 0;
  }
  const report = await rebuildRecording({ ...values, log: line => process.stderr.write(`${line}\n`) });
  const warnings = (report.build.warnings || []).map(warning => warning.kind);
  process.stdout.write(`Rebuilt ${report.result.path} (${report.result.durationSeconds.toFixed(1)} s, ${(report.result.bytes / 1048576).toFixed(1)} MB)\n` +
    `Sources: ${report.sources.map(source => source.kind).join(', ') || 'none'}${report.build.systemPcmIncluded ? ' + system PCM' : ''}, recovery: ${report.recovery}\n` +
    `Warnings: ${warnings.length ? [...new Set(warnings)].join(', ') : 'none'}\nReport: ${report.reportPath}\n`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`Rebuild failed: ${error.message}\n${error.report?.reportPath ? `Report: ${error.report.reportPath}\n` : ''}` +
      `${error.report?.scratchKept ? `Scratch kept for diagnosis: ${error.report.scratchKept}\n` : ''}`);
    process.exitCode = 1;
  });
}

module.exports = { rebuildRecording, parseArguments, inventory };
