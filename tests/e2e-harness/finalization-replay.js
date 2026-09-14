'use strict';

// Replays only the pinned, generated Intel endurance input. This diagnoses
// finalization throughput; it does not repeat capture or qualify a release.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { performance } = require('perf_hooks');
const { inspectNativeSources } = require('../../src-electron/native-source-persistence');
const { createNativeSourceFinalization } = require('../../src-electron/native-source-finalization');
const { validateNativeMedia } = require('../../src-electron/native-media-validation');

const PINNED = Object.freeze({
  runId: '33988551101', artifactId: '9980360723',
  commit: 'd0352432037fb7cd8213fd973da043c1b7f72402',
  scenario: 's13-coded-endurance-18300s-1788638233219',
  recordId: 'f337a239-6f2f-439c-94c2-b16bce0e148c',
  sourceId: '6ef9dda3-8e07-473c-8fcf-089dd681b40a',
  scratchName: 'native-finalization-m82bIL',
  bytes: 295822697, chunkCount: 17931, endOffsetMs: 18301611.5,
  sha256: '80e1e9bf9720191aa292d2602de515894ad4a7e53ce6f520231099b07d740ab6',
  metadata: Object.freeze({
    'manifest.json': '1e6118986a7f55ab60bb53fb516eb0661d3cd12fb5b9498711860f0ac54876fe',
    'started.json': '8a1b404411e825e69992b985118f55032dc4a496b92d19ff090c775995b5a90c',
    'end.json': '733691990d3661551332f1b6734286321495ad295d75fb1c684ad5385be3c5cb',
  }),
});
const REPLAY_ROOT = path.resolve(__dirname, 'work/finalization-replay');
const DEADLINE_MS = 53 * 60000; // Existing 45-minute encode + 5-minute inspection + setup.

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function assertIsolatedPaths(artifactDir, outputDir) {
  if (!within(REPLAY_ROOT, outputDir)) throw new Error('Replay output must be a new child of tests/e2e-harness/work/finalization-replay');
  if (path.resolve(artifactDir) === path.resolve(outputDir) || within(artifactDir, outputDir) || within(outputDir, artifactDir)) {
    throw new Error('Replay output and original evidence must be separate');
  }
}
function validateManifest(manifest) {
  if (manifest.commit !== PINNED.commit || manifest.scenario !== 's13-coded-endurance' ||
      manifest.platform !== 'darwin' || manifest.architecture !== 'x64' || manifest.captureSeconds !== 18300 ||
      manifest.productionBackendQualified !== false || manifest.processingDisabled !== false ||
      manifest.referenceGeneration?.generator !== 'tests/e2e-harness/lib/coded-audio.js' ||
      manifest.referenceGeneration?.firstFrameId !== 0 ||
      JSON.stringify(manifest.referenceGeneration?.plan) !== JSON.stringify([{ type: 'speech', seconds: 18325 }])) {
    throw new Error('Only the pinned generated Intel artifact is accepted');
  }
}
function safeFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe replay input: ${path.basename(file)}`);
  return stat;
}
async function hashFiles(files) {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    safeFile(file);
    for await (const block of fs.createReadStream(file)) { hash.update(block); bytes += block.length; }
  }
  return { bytes, sha256: hash.digest('hex') };
}
function verifyHash(actual, expected = PINNED) {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error('Pinned generated audio hash/size mismatch');
  return actual;
}
async function provenance() {
  const files = [__filename, ...['native-source-finalization.js', 'native-source-persistence.js',
    'durable-files.js', 'encoded-opus-evidence.js', 'native-media-validation.js']
    .map(name => path.resolve(__dirname, '../../src-electron', name)),
  require('@ffmpeg-installer/ffmpeg').path, require('@ffprobe-installer/ffprobe').path];
  const values = [];
  for (const file of files) values.push({ file, ...await hashFiles([file]) });
  return values;
}
async function verifyArtifact(artifactDir) {
  validateManifest(readJson(path.join(artifactDir, 'ci/s13-coded-endurance/manifest.json')));
  const recordPath = path.join(artifactDir, 'userdata', PINNED.scenario, 'recordings', PINNED.recordId);
  const sources = inspectNativeSources(recordPath);
  const source = sources[0];
  if (sources.length !== 1 || source.sourceId !== PINNED.sourceId || source.kind !== 'microphone' ||
      source.chunkCount !== PINNED.chunkCount || source.gaps.length || source.terminalMismatch || source.interrupted ||
      source.startOffsetMs !== 0 || source.endOffsetMs !== PINNED.endOffsetMs) throw new Error('Pinned native source inventory mismatch');
  const sourceDirectory = path.join(recordPath, 'native-sources', PINNED.sourceId);
  for (const [name, expected] of Object.entries(PINNED.metadata)) {
    const actual = await hashFiles([path.join(sourceDirectory, name)]);
    if (actual.sha256 !== expected) throw new Error(`Pinned source metadata mismatch: ${name}`);
  }
  const joinedPath = path.join(recordPath, PINNED.scratchName, `${PINNED.sourceId}.webm`);
  const joined = verifyHash(await hashFiles([joinedPath]));
  return { recordPath, sourceDirectory, source, joinedPath, joined };
}

// Preserve production's supplied wall timeout and 30-second stderr watchdog.
// Progress is sampled every 15 seconds; ashowinfo's per-frame lines stay bounded.
function createCommandRunner(record, { now = () => performance.now(), intervalMs = 15000 } = {}) {
  return (command, timeoutMs, operation) => new Promise((resolve, reject) => {
    const start = now();
    let lastSignal = start, lastProgress = null, childPid = null, settled = false;
    const stderrTail = [];
    record('operation-start', { operation, timeoutMs });
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer); clearInterval(watchdog); clearInterval(progressTimer);
      record('operation-end', { operation, operationElapsedMs: now() - start, childPid, progress: lastProgress,
        status: error ? 'failed' : 'passed', error: error?.message, stderrTail: error ? stderrTail : undefined });
      if (error) reject(error); else resolve();
    };
    const kill = message => {
      if (settled) return;
      try { command.kill('SIGKILL'); } catch (_) { /* error event may already have closed it */ }
      finish(new Error(message));
    };
    const wallTimer = setTimeout(() => kill(`${operation} operation timed out`), timeoutMs);
    const watchdog = setInterval(() => {
      if (now() - lastSignal >= 30000) kill(`${operation} stalled (no stderr for 30s)`);
    }, 5000);
    const progressTimer = setInterval(() => {
      let outputBytes = null;
      const target = command._outputs?.[0]?.target;
      try { if (typeof target === 'string') outputBytes = fs.statSync(target).size; } catch (_) { /* not created yet */ }
      record('operation-progress', { operation, operationElapsedMs: now() - start, childPid, outputBytes,
        sinceSignalMs: now() - lastSignal, progress: lastProgress });
    }, intervalMs);
    command.on('start', () => {
      lastSignal = now(); childPid = command.ffmpegProc?.pid || null;
      record('operation-process-start', { operation, childPid, operationElapsedMs: now() - start });
    }).on('stderr', line => {
      lastSignal = now();
      if (!line.includes('ashowinfo')) { stderrTail.push(line.slice(0, 1024)); if (stderrTail.length > 12) stderrTail.shift(); }
    }).on('progress', value => {
      lastSignal = now(); lastProgress = { timemark: value.timemark, currentKbps: value.currentKbps, targetSize: value.targetSize };
    }).on('error', finish).on('end', () => finish());
    try { command.run(); } catch (error) { finish(error); }
  });
}

async function worker(artifactDir, outputDir) {
  const started = performance.now();
  const logFile = path.join(outputDir, 'progress.jsonl');
  const record = (phase, data = {}) => {
    fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), elapsedMs: performance.now() - started,
      phase, harnessRssBytes: process.memoryUsage().rss, ...data }) + '\n');
    if (!phase.endsWith('progress')) process.stdout.write(`${phase}\n`);
  };
  const result = { scope: 'Replay of generated native source finalization only; not capture, upload, or five-hour qualification',
    original: PINNED, platform: process.platform, architecture: process.arch,
    runtime: { node: process.version, electron: process.versions.electron || null, originalCaptureElectron: '28.3.3',
      scope: 'Standalone Node replay with installed bundled FFmpeg; not the original Electron main-process environment' },
    host: { cpus: [...new Set(os.cpus().map(cpu => cpu.model))], cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(), initialFreeMemoryBytes: os.freemem(), release: os.release() },
    completed: false, pass: false, fiveHourQualificationPassed: false, productionBackendQualified: false };
  let sandbox;
  try {
    result.provenanceBefore = await provenance();
    writeJson(path.join(outputDir, 'provenance-before.json'), result.provenanceBefore);
    record('verify-original-start');
    const original = await verifyArtifact(artifactDir);
    record('verify-original-end', original.joined);
    sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-finalization-replay-'));
    writeJson(path.join(outputDir, 'sandbox.json'), { path: sandbox, outputDir, artifactDir, sourceId: PINNED.sourceId });
    const sourceCopy = path.join(sandbox, 'native-sources', PINNED.sourceId);
    await fs.promises.mkdir(path.join(sourceCopy, 'chunks'), { recursive: true });
    record('copy-originals-start', { chunks: original.source.chunkCount });
    for (const name of Object.keys(PINNED.metadata)) {
      await fs.promises.copyFile(path.join(original.sourceDirectory, name), path.join(sourceCopy, name), fs.constants.COPYFILE_EXCL);
    }
    for (const file of original.source.chunkPaths) {
      await fs.promises.copyFile(file, path.join(sourceCopy, 'chunks', path.basename(file)), fs.constants.COPYFILE_EXCL);
    }
    for (const [name, expected] of Object.entries(PINNED.metadata)) {
      if ((await hashFiles([path.join(sourceCopy, name)])).sha256 !== expected) throw new Error(`Copied source metadata mismatch: ${name}`);
    }
    const copy = inspectNativeSources(sandbox)[0];
    result.copiedInput = verifyHash(await hashFiles(copy.chunkPaths));
    record('copy-originals-verified', result.copiedInput);
    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    const ffprobePath = require('@ffprobe-installer/ffprobe').path;
    ffmpeg.setFfmpegPath(ffmpegPath); ffmpeg.setFfprobePath(ffprobePath);
    const exec = promisify(execFile);
    result.ffmpegVersion = (await exec(ffmpegPath, ['-version'], { timeout: 30000, windowsHide: true })).stdout.split('\n')[0];
    result.ffprobeVersion = (await exec(ffprobePath, ['-version'], { timeout: 30000, windowsHide: true })).stdout.split('\n')[0];
    result.replayCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }).trim();
    const buildStart = performance.now();
    let firstOperation = true;
    const run = createCommandRunner((phase, values) => {
      if (phase === 'operation-start' && firstOperation) {
        firstOperation = false;
        record('pre-encode-aggregate', { phaseElapsedMs: performance.now() - buildStart,
          scope: 'build-start through first FFmpeg run; includes source inspection, space check and concatenation' });
      }
      record(phase, values);
    });
    const finalizer = createNativeSourceFinalization({ ffmpeg, ffprobePath, run,
      validate: async (file, options) => {
        record('container-validation-start', { file: path.basename(file) });
        const value = validateNativeMedia(file, options);
        record('container-validation-end', { valid: value.valid }); return value;
      },
      probe: async file => {
        record('metadata-probe-start');
        const { stdout } = await exec(ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
          { timeout: 30000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        const duration = Number(JSON.parse(stdout).format.duration);
        record('metadata-probe-end', { duration });
        record('packet-validation-pending', { scope: 'Production sample accounting and publication follow this boundary' });
        return duration;
      },
      checkSpace: async neededBytes => {
        const stat = await fs.promises.statfs(sandbox), freeBytes = stat.bavail * stat.bsize;
        record('space-check', { neededBytes, freeBytes });
        if (freeBytes < neededBytes) throw Object.assign(new Error('Insufficient replay scratch space'), { code: 'ENOSPC' });
      },
    });
    record('build-start');
    const built = await finalizer.build(sandbox, path.join(sandbox, 'replay_building.webm'), { expectedDurationSec: 18300 });
    record('build-end', { buildElapsedMs: performance.now() - buildStart });
    result.build = { duration: built.duration, fastPathUsed: built.fastPathUsed, plan: built.plan,
      warnings: built.warnings, buildElapsedMs: performance.now() - buildStart };
    result.final = await hashFiles([built.outputPath]);
    result.pass = built.success === true && built.plan.validation.status === 'passed';
    result.completed = true;
  } catch (error) {
    result.error = { message: error.message, code: error.code || null };
    record('replay-failed', result.error);
  } finally {
    try {
      result.provenanceAfter = await provenance();
      result.provenanceUnchanged = JSON.stringify(result.provenanceBefore) === JSON.stringify(result.provenanceAfter);
      if (!result.provenanceUnchanged) {
        result.pass = false;
        result.provenanceError = 'Replay source or media binary changed during execution';
      }
    } catch (error) { result.pass = false; result.provenanceError = error.message; }
    result.elapsedMs = performance.now() - started;
    result.sandbox = sandbox;
    writeJson(path.join(outputDir, 'result.json'), result);
  }
  return result.pass ? 0 : 1;
}

// Runs after the worker exits, including an externally interrupted worker.
// Original chunks and the joined raw input remain separate from upload artifacts.
async function preserveOutputs(outputDir) {
  const mapping = path.join(outputDir, 'sandbox.json');
  if (!fs.existsSync(mapping)) return [];
  const sandbox = path.resolve(readJson(mapping).path);
  if (path.dirname(sandbox) !== path.resolve(os.tmpdir()) || !path.basename(sandbox).startsWith('suisse-finalization-replay-')) {
    throw new Error('Invalid replay sandbox mapping');
  }
  const saved = [];
  for (const entry of fs.readdirSync(sandbox, { withFileTypes: true })) {
    const names = entry.isDirectory() && entry.name.startsWith('native-finalization-')
      ? ['plan.json', 'fast-rendered.webm', 'rendered.webm'].map(name => path.join(entry.name, name))
      : entry.name === 'replay_building.webm' ? [entry.name] : [];
    for (const name of names) {
      const source = path.join(sandbox, name);
      if (!fs.existsSync(source)) continue;
      safeFile(source);
      const destination = path.join(outputDir, name);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      saved.push({ file: name, bytes: fs.statSync(destination).size, validated: name === 'replay_building.webm' });
    }
  }
  writeJson(path.join(outputDir, 'preserved-outputs.json'), saved);
  return saved;
}
function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--artifact-dir', '--output-dir', '--worker'].includes(key) || values[key] !== undefined) throw new Error(`Unsupported or repeated argument: ${key}`);
    if (key === '--worker') values[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${key}`);
      values[key] = path.resolve(value);
    }
  }
  if (!values['--artifact-dir']) throw new Error('--artifact-dir is required; only artifact 9980360723 from run 33988551101 is accepted');
  return values;
}
async function main(args = process.argv.slice(2)) {
  const values = parseArguments(args), artifactDir = fs.realpathSync(values['--artifact-dir']);
  await fs.promises.mkdir(REPLAY_ROOT, { recursive: true });
  const outputDir = values['--output-dir'] || await fs.promises.mkdtemp(path.join(REPLAY_ROOT, 'replay-'));
  assertIsolatedPaths(artifactDir, outputDir);
  if (values['--worker']) return worker(artifactDir, outputDir);
  if (values['--output-dir']) await fs.promises.mkdir(outputDir); // EEXIST refuses evidence reuse.
  const child = spawn(process.execPath, [__filename, '--worker', '--artifact-dir', artifactDir, '--output-dir', outputDir],
    { stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true });
  let reason = null;
  const stop = signal => {
    if (reason) return;
    reason = signal;
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* already ended */ }
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* already ended */ }
    }
  };
  const timer = setTimeout(() => stop('overall-deadline'), DEADLINE_MS);
  const interrupt = () => stop('interrupted');
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const status = await new Promise(resolve => {
    child.once('error', error => resolve({ code: 1, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  await preserveOutputs(outputDir);
  writeJson(path.join(outputDir, 'supervisor.json'), { ...status, reason, deadlineMs: DEADLINE_MS,
    outputDir, completedAt: new Date().toISOString(), fiveHourQualificationPassed: false });
  process.stdout.write(`Replay evidence: ${outputDir}\n`);
  return status.code === 0 && !reason ? 0 : 1;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1;
});
module.exports = { PINNED, REPLAY_ROOT, validateManifest, verifyArtifact, hashFiles, verifyHash,
  assertIsolatedPaths, parseArguments, createCommandRunner, preserveOutputs };
