'use strict';

// Diagnostic only: getUserMedia resolution is not an observed first-sample clock.
// Chromium 120 lazily reads the entire fake WAV on its audio thread. Compare
// file sizes without adding a media consumer or changing application capture.
// Electron version pin: https://github.com/electron/electron/blob/v28.3.3/DEPS
// Lazy full-file read: https://github.com/chromium/chromium/blob/120.0.6099.291/media/audio/simple_sources.cc#L159-L213
// Sample-count and scheduled clocks can diverge after delay:
// https://github.com/chromium/chromium/blob/120.0.6099.291/media/base/fake_audio_worker.cc#L141-L176
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const ROOT = path.resolve(__dirname, '../..');
const WORK = path.join(__dirname, 'work', 'qualification');
const CAPTURE_SECONDS = 45;
const PREFIX_SECONDS = 120;
const ENDURANCE_REFERENCE_SECONDS = 18325;
const MAX_REFERENCE_BYTES = ENDURANCE_REFERENCE_SECONDS * 48000 * 2 + 44;
const COPY_BYTES = 1024 * 1024;
const CAPTURE_DEADLINE_MS = 4 * 60 * 1000;
const SUPERVISOR_MS = 10 * 60 * 1000;
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function sha256(file) {
  const digest = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file, { highWaterMark: COPY_BYTES })) digest.update(bytes);
  return digest.digest('hex');
}

// Both WAVs contain identical numbered PCM for the first two minutes. Only
// the large WAV has zero-valued PCM afterwards. No holes/truncation or RIFF
// padding shortcut: Chromium reads the same byte count as the endurance WAV.
function extendReference(prefix, destination, seconds) {
  const totalBytes = seconds * 48000 * 2 + 44;
  const stat = fs.statSync(prefix);
  if (!Number.isInteger(seconds) || seconds < PREFIX_SECONDS || totalBytes > MAX_REFERENCE_BYTES ||
      stat.size !== PREFIX_SECONDS * 48000 * 2 + 44) throw new Error('Invalid bounded startup reference size');
  const input = fs.openSync(prefix, 'r');
  let output;
  const digest = crypto.createHash('sha256'), prefixDigest = crypto.createHash('sha256');
  const block = Buffer.alloc(COPY_BYTES), header = Buffer.alloc(44);
  let written = 0;
  const write = bytes => {
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(output, bytes, offset, bytes.length - offset);
      if (!count) throw new Error('Startup reference write made no progress');
      offset += count;
    }
    digest.update(bytes); written += bytes.length;
  };
  try {
    if (fs.readSync(input, header, 0, 44, 0) !== 44 || header.toString('ascii', 0, 4) !== 'RIFF' ||
        header.toString('ascii', 8, 16) !== 'WAVEfmt ' || header.toString('ascii', 36, 40) !== 'data' ||
        header.readUInt32LE(4) !== stat.size - 8 || header.readUInt32LE(40) !== stat.size - 44 ||
        header.readUInt32LE(24) !== 48000 || header.readUInt16LE(22) !== 1 || header.readUInt16LE(34) !== 16) {
      throw new Error('Expected canonical 48 kHz mono PCM16 numbered prefix');
    }
    output = fs.openSync(destination, 'wx');
    header.writeUInt32LE(totalBytes - 8, 4); header.writeUInt32LE(totalBytes - 44, 40); write(header);
    let offset = 44;
    while (offset < stat.size) {
      const count = fs.readSync(input, block, 0, Math.min(block.length, stat.size - offset), offset);
      if (!count) throw new Error('Numbered prefix ended unexpectedly');
      const bytes = block.subarray(0, count); prefixDigest.update(bytes); write(bytes); offset += count;
    }
    block.fill(0);
    while (written < totalBytes) write(block.subarray(0, Math.min(block.length, totalBytes - written)));
    fs.fsyncSync(output);
  } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
  return { wavPath: destination, bytes: written, sha256: digest.digest('hex'), prefixPcmSha256: prefixDigest.digest('hex'),
    prefixSeconds: PREFIX_SECONDS, totalSeconds: seconds, tail: seconds > PREFIX_SECONDS ? 'zero-valued PCM' : 'none',
    generation: 'Identical coded prefix, canonical PCM16 WAV, sequential physical zero writes, 1 MiB buffers; hash computed during writing.' };
}

// Passive lifecycle observation. No source cloning, extra recorder, playback,
// MediaStreamTrackProcessor, analyser, changed constraints, or busy-wait delay.
function installStartupObserver() {
  if (window.__captureStartupEvidence) throw new Error('Startup observer already installed');
  const devices = navigator.mediaDevices, originalGet = devices.getUserMedia;
  const originalStart = MediaRecorder.prototype.start, OriginalContext = window.AudioContext;
  const originalWebkit = window.webkitAudioContext;
  const acquisitions = [], records = [], destinations = new Set();
  const WrappedContext = new Proxy(OriginalContext, { construct(target, args, newTarget) {
    const context = Reflect.construct(target, args, newTarget), create = context.createMediaStreamDestination;
    context.createMediaStreamDestination = function (...args) {
      const node = Reflect.apply(create, this, args);
      node.stream.getAudioTracks().forEach(track => destinations.add(track.id));
      return node;
    };
    return context;
  } });
  window.AudioContext = WrappedContext;
  if (originalWebkit === OriginalContext) window.webkitAudioContext = WrappedContext;
  devices.getUserMedia = async function (constraints) {
    if (acquisitions.length || !constraints?.audio || constraints.video || constraints.audio?.mandatory?.chromeMediaSource) {
      throw new Error('Startup diagnostic permits one synthetic microphone acquisition');
    }
    const item = { requestedAt: performance.now(), receivedAt: null, constraints, settings: [], trackIds: [] };
    acquisitions.push(item);
    const stream = await Reflect.apply(originalGet, this, [constraints]);
    item.receivedAt = performance.now(); item.settings = stream.getAudioTracks().map(track => track.getSettings());
    item.trackIds = stream.getAudioTracks().map(track => track.id);
    return stream;
  };
  MediaRecorder.prototype.start = function (...args) {
    const trackIds = this.stream.getAudioTracks().map(track => track.id);
    const input = new Set(acquisitions.flatMap(item => item.trackIds));
    const entry = { ref: this, trackIds, role: trackIds.length === 1 && input.has(trackIds[0]) ? 'native-microphone'
      : trackIds.length === 1 && destinations.has(trackIds[0]) ? 'live-mix' : 'unknown',
    startCalledAt: performance.now(), startedAt: null, startObservedAt: null, stoppedAt: null,
    firstDataAt: null, firstDataEventAt: null, firstDataBytes: null, events: 0, bytes: 0, emptyEvents: 0, timesliceMs: args[0] };
    records.push(entry);
    this.addEventListener('start', event => { entry.startedAt = event.timeStamp; entry.startObservedAt = performance.now(); });
    this.addEventListener('stop', event => { entry.stoppedAt = event.timeStamp; });
    this.addEventListener('dataavailable', event => {
      entry.events++; entry.bytes += event.data.size;
      if (!event.data.size) entry.emptyEvents++;
      else if (entry.firstDataAt === null) {
        entry.firstDataAt = performance.now(); entry.firstDataEventAt = event.timeStamp; entry.firstDataBytes = event.data.size;
      }
    });
    return Reflect.apply(originalStart, this, args);
  };
  window.__captureStartupEvidence = { snapshot: () => ({ at: performance.now(), acquisitions: acquisitions.map(item => ({ ...item })),
    records: records.map(({ ref, ...item }) => ({ ...item, state: ref.state })) }),
  dispose: () => {
    devices.getUserMedia = originalGet; MediaRecorder.prototype.start = originalStart;
    window.AudioContext = OriginalContext; if (originalWebkit === OriginalContext) window.webkitAudioContext = originalWebkit;
  } };
}

function startupClockReadout(audio, recorder, acquisition) {
  if (![audio?.sourceOffsetS, audio?.firstFrame, audio?.lastFrame, recorder?.startCalledAt, recorder?.startedAt,
    recorder?.firstDataAt, acquisition?.requestedAt, acquisition?.receivedAt].every(Number.isFinite)) throw new Error('Missing startup clock evidence');
  const range = origin => [(origin - acquisition.receivedAt) / 1000, (origin - acquisition.requestedAt) / 1000];
  const distance = interval => Math.max(0, interval[0] - audio.sourceOffsetS, audio.sourceOffsetS - interval[1]);
  return { acquisitionSeconds: (acquisition.receivedAt - acquisition.requestedAt) / 1000,
    acquiredToStartCallS: (recorder.startCalledAt - acquisition.receivedAt) / 1000,
    startEventDelayS: (recorder.startedAt - recorder.startCalledAt) / 1000,
    firstDataAfterAcquisitionS: (recorder.firstDataAt - acquisition.receivedAt) / 1000,
    firstFrame: audio.firstFrame, lastFrame: audio.lastFrame, sourceOffsetS: audio.sourceOffsetS,
    eventOffsetRangeS: range(recorder.startedAt), callOffsetRangeS: range(recorder.startCalledAt),
    eventClockErrorS: distance(range(recorder.startedAt)), callClockErrorS: distance(range(recorder.startCalledAt)),
    interpretation: 'Observed lifecycle clocks and decoded numbered positions only. Neither start event nor Blob delivery is an exact first-sample wall clock.' };
}

function summarizeCases(cases) {
  const measurementCompleted = cases.length === 2 && cases.every(item => item.completed && item.controlsValid);
  const result = { measurementCompleted, pass: measurementCompleted && cases.every(item => item.pass), comparison: null };
  if (!measurementCompleted) return result;
  const [small, large] = cases;
  result.comparison = Object.fromEntries(['acquisitionSeconds', 'acquiredToStartCallS', 'startEventDelayS', 'firstDataAfterAcquisitionS',
    'firstFrame', 'sourceOffsetS', 'eventClockErrorS', 'callClockErrorS'].map(key => [key, { small: small.nativeClock[key],
    large: large.nativeClock[key], largeMinusSmall: large.nativeClock[key] - small.nativeClock[key] }]));
  return result;
}

function inventory(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return inventory(file, base);
    if (!entry.isFile()) throw new Error('Unexpected bundle link: ' + file);
    return [{ path: path.relative(base, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) }];
  });
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

function validateSnapshot(snapshot, stopped = false) {
  const acquired = snapshot?.acquisitions;
  const records = snapshot?.records;
  if (acquired?.length !== 1 || acquired[0].trackIds.length !== 1 || acquired[0].settings.length !== 1 ||
      !Number.isFinite(acquired[0].receivedAt) || acquired[0].receivedAt < acquired[0].requestedAt || records?.length !== 2) {
    throw new Error('Expected one observed acquisition and two actual application recorders');
  }
  const native = records.filter(item => item.role === 'native-microphone'), mixed = records.filter(item => item.role === 'live-mix');
  if (native.length !== 1 || mixed.length !== 1 || native[0].trackIds[0] !== acquired[0].trackIds[0] ||
      records.some(item => item.timesliceMs !== 1000 || !Number.isFinite(item.startCalledAt) ||
        item.state !== (stopped ? 'inactive' : 'recording') || (stopped &&
          (!Number.isFinite(item.startedAt) || !Number.isFinite(item.stoppedAt) || !Number.isFinite(item.firstDataAt))))) {
    throw new Error('Unexpected actual recorder identity, lifecycle, or timeslice');
  }
  const settings = acquired[0].settings[0];
  if (['echoCancellation', 'noiseSuppression', 'autoGainControl'].some(flag => settings[flag] !== true)) {
    throw new Error('Ordinary enabled microphone processing was not observed');
  }
  return { native: native[0], mixed: mixed[0], acquisition: acquired[0] };
}

async function captureCase(directory, reference, options) {
  const { AppDriver, sleep } = require('./lib/app-driver');
  const { startMockBackend } = require('./lib/mock-backend');
  const { verifyCodedAudio } = require('./lib/coded-audio');
  const { inspectNativeSources } = require('../../src-electron/native-source-persistence');
  const { concatenateFiles } = require('../../src-electron/durable-files');
  const { assessSourceCoverage } = require('./endurance-qualification');
  const result = { reference, completed: false, controlsValid: false, pass: false, problems: [],
    fiveHourQualificationPassed: false, productionBackendQualified: false, physicalHardwareQualified: false };
  const checkpoint = () => writeJson(path.join(directory, 'result.json'), result);
  let app, mock, timer, expired = false;
  const guard = () => { if (expired) throw new Error('Startup capture exceeded four-minute owned-process deadline'); };
  try {
    const free = fs.statfsSync(directory), availableBytes = Number(free.bavail) * Number(free.bsize);
    result.preflight = { availableBytes, freeMemoryBytes: os.freemem(), requiredDiskBytes: 5 * 1024 ** 3, requiredMemoryBytes: 3 * 1024 ** 3 };
    if (availableBytes < result.preflight.requiredDiskBytes || result.preflight.freeMemoryBytes < result.preflight.requiredMemoryBytes) {
      throw new Error('Startup diagnostic needs at least 5 GiB free disk and 3 GiB available memory');
    }
    checkpoint();
    mock = await startMockBackend({ port: 3000 });
    app = new AppDriver({ name: path.basename(path.dirname(directory)) + '-' + path.basename(directory),
      apiUrl: mock.url, appDir: options.appDir, cdpPort: await unusedPort(), fakeAudioWav: reference.wavPath,
      env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
    result.profile = app.userDataDir; checkpoint();
    timer = setTimeout(() => {
      expired = true; result.deadlineExceeded = true; checkpoint();
      void app?.close({ keepProfile: true }).catch(error => { result.problems.push('Deadline cleanup: ' + error.message); });
    }, CAPTURE_DEADLINE_MS);
    await app.launch(); guard(); result.diagnostics = app.diagnosticsDir; result.ownedElectronPid = app.proc?.pid; checkpoint();
    await app.login(); guard();
    if (await app.evalTimed(() => window.electronAPI.config.getApiUrl()) !== mock.url) throw new Error('App did not select the isolated mock');
    guard();
    await app.page.waitForSelector('[data-test="system-audio-toggle"]', { visible: true, timeout: 20000 }); guard();
    if (await app.evalTimed(() => document.querySelector('[data-test="system-audio-toggle"]')?.getAttribute('aria-checked')) === 'true') {
      await app.clickByTest('[data-test="system-audio-toggle"]'); guard();
    }
    if (await app.evalTimed(() => document.querySelector('[data-test="system-audio-toggle"]')?.getAttribute('aria-checked')) !== 'false') {
      throw new Error('Cannot confirm system audio is disabled');
    }
    guard(); await app.evalTimed(installStartupObserver); guard();
    await app.startRecording(); guard();
    result.startSnapshot = await app.evalTimed(() => window.__captureStartupEvidence.snapshot()); guard();
    validateSnapshot(result.startSnapshot);
    result.recordId = await app.getRecordId(); guard();
    result.samples = []; const started = performance.now();
    while (performance.now() - started < CAPTURE_SECONDS * 1000) {
      await sleep(Math.min(5000, Math.max(1, CAPTURE_SECONDS * 1000 - (performance.now() - started)))); guard();
      const snapshot = await app.evalTimed(() => window.__captureStartupEvidence.snapshot()); guard();
      validateSnapshot(snapshot); result.samples.push(snapshot); checkpoint();
    }
    result.monotonicCaptureSeconds = (performance.now() - started) / 1000;
    await app.stopRecording(); guard();
    await app.waitForPhase(['uploaded', 'error'], 90000); guard();
    result.phase = await app.getPhase(); guard();
    result.finalSnapshot = await app.evalTimed(() => window.__captureStartupEvidence.snapshot()); guard();
    const roles = validateSnapshot(result.finalSnapshot, true);
    if (result.phase !== 'uploaded') throw new Error('Actual app failed finalization or localhost upload');
    result.finalPath = app.findOutputFile();
    if (!result.finalPath || path.basename(path.dirname(result.finalPath)) !== result.recordId) throw new Error('Missing current final output');
    const sources = inspectNativeSources(path.dirname(result.finalPath));
    if (sources.length !== 1 || sources[0].kind !== 'microphone' || !sources[0].complete || !sources[0].hasAudio) throw new Error('Incomplete retained native source');
    const source = sources[0];
    result.nativeChunks = source.chunks.map(chunk => ({ index: chunk.index, file: chunk.path, bytes: chunk.size, sha256: hash(fs.readFileSync(chunk.path)) }));
    if (result.nativeChunks.length !== roles.native.events - roles.native.emptyEvents ||
        result.nativeChunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== roles.native.bytes) throw new Error('Native source byte/event custody mismatch');
    result.nativePath = path.join(directory, 'native-original.webm');
    await concatenateFiles(source.chunkPaths, result.nativePath); guard();
    result.nativeSha256 = await sha256(result.nativePath); guard();
    result.finalSha256 = await sha256(result.finalPath); guard();
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(result.finalPath), 'upload-receipt.json'), 'utf8'));
    const remote = mock.state.uploads.get(receipt.audioFileId);
    result.upload = { remoteSha256: remote?.sha256, localSha256: result.finalSha256, canDelete: receipt.canDelete };
    if (remote?.sha256 !== result.finalSha256 || receipt.canDelete !== false) throw new Error('Local mock upload custody mismatch');
    await app.evalTimed(() => window.__captureStartupEvidence.dispose()); guard();
    await app.close({ keepProfile: true }); app = null; clearTimeout(timer);
    await mock.close(); mock = null;
    // Decode only after the app process has ended. The full reference is not
    // decoded: captures must stay in its identical two-minute coded prefix.
    const scenario = { coded: { version: 1, frameSeconds: 0.5 }, timeline: [{ type: 'speech', start: 0, end: PREFIX_SECONDS }] };
    result.nativeAudio = await verifyCodedAudio(result.nativePath, scenario);
    result.finalAudio = await verifyCodedAudio(result.finalPath, scenario);
    for (const [role, audio] of [['native', result.nativeAudio], ['final', result.finalAudio]]) {
      if (!audio.pass || audio.decoderWarnings || audio.lastFrame >= PREFIX_SECONDS * 2 - 2) {
        result.problems.push(role + ': content oracle failed, warned, or reached the coded prefix endpoint');
      }
    }
    result.nativeClock = startupClockReadout(result.nativeAudio, roles.native, roles.acquisition);
    result.finalClock = startupClockReadout(result.finalAudio, roles.native, roles.acquisition);
    result.unchangedEnduranceChecks = {
      native: assessSourceCoverage(result.nativeAudio, roles.native, [roles.acquisition]),
      final: assessSourceCoverage(result.finalAudio, roles.native, [roles.acquisition]),
    };
    result.referenceSha256AfterCapture = await sha256(reference.wavPath);
    if (result.referenceSha256AfterCapture !== reference.sha256) throw new Error('Synthetic reference changed during capture');
    result.controlsValid = true; result.completed = true;
  } catch (error) { result.problems.push(error.stack || error.message); }
  finally {
    clearTimeout(timer);
    if (app) {
      try { result.failureSnapshot = await app.evalTimed(() => window.__captureStartupEvidence?.snapshot(), undefined, 3000); } catch (_) { /* retain existing samples */ }
      await app.close({ keepProfile: true }).catch(error => result.problems.push('App cleanup: ' + error.message));
    }
    if (mock) { mock.server.closeAllConnections?.(); await mock.close(); }
    result.pass = result.completed && result.controlsValid && !result.problems.length && !expired;
    result.finishedAt = new Date().toISOString(); checkpoint();
  }
  return result;
}

async function runCaptureStartupDiagnostic(options) {
  if (!['win32', 'darwin'].includes(process.platform) || process.env.SUISSE_E2E_HOOKS !== '1' ||
      process.env.SUISSE_TEST_NETWORK_ISOLATION !== '1' || process.env.SUISSE_E2E_PACKAGED_EXE) throw new Error('Isolated native unsigned test bundle required');
  const appDir = path.resolve(options.appDir || process.env.SUISSE_E2E_APP_DIR || 'dist/electron/UnPackaged');
  const bundleSha = options.bundleSha || process.env.SUISSE_E2E_BUNDLE_SHA;
  if (!/^[a-f0-9]{40}$/i.test(bundleSha || '')) throw new Error('Explicit application build SHA required');
  const evidenceDir = path.resolve(options.evidenceDir);
  if (!evidenceDir.startsWith(WORK + path.sep) || !fs.statSync(evidenceDir).isDirectory()) throw new Error('Evidence must use a new synthetic work directory');
  const bundle = inventory(appDir);
  const result = { name: 'capture-startup-diagnostic', pass: false, measurementCompleted: false, cases: [], problems: [], evidenceDir,
    fiveHourQualificationPassed: false, productionBackendQualified: false, physicalHardwareQualified: false,
    provenance: { applicationBuildCommit: bundleSha, harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim(),
      appDir, bundle, platform: process.platform, architecture: process.arch, electron: require('electron/package.json').version,
      runtimeInputs: Object.fromEntries([process.execPath, require('electron'), require('@ffmpeg-installer/ffmpeg').path,
        require('@ffprobe-installer/ffprobe').path].map(file => [file, hash(fs.readFileSync(file))])),
      harnessInputs: Object.fromEntries([__filename, path.join(ROOT, 'package-lock.json'), path.join(__dirname, 'lib/coded-audio.js'), path.join(__dirname, 'lib/app-driver.js'),
        path.join(__dirname, 'lib/mock-backend.js'), path.join(__dirname, 'lib/audio.js'), path.join(__dirname, 'endurance-qualification.js'),
        ...fs.readdirSync(path.join(ROOT, 'src-electron')).filter(file => /^(native-|durable-files|pcm-).*\.js$/.test(file))
          .map(file => path.join(ROOT, 'src-electron', file))].map(file => [path.relative(ROOT, file), hash(fs.readFileSync(file))])) },
    limits: { secondsPerCase: CAPTURE_SECONDS, referenceBytes: MAX_REFERENCE_BYTES, captureDeadlineMs: CAPTURE_DEADLINE_MS, supervisorMs: SUPERVISOR_MS },
    notes: ['A green diagnostic means the measurement completed; recorded acquisition-clock disagreements remain visible and never clear a historical failure.',
      'Both fixtures have the identical 120-second coded prefix; the full-size fixture ends with zeros and is not a five-hour coded-content reference.',
      'Newly written files may be in the OS page cache. This is not a controlled cold-disk experiment, and file size changes native allocation and I/O together.',
      'No additional media consumer or encoder is introduced. Actual ordinary microphone processing, native archive, live mix and localhost upload execute.'] };
  const checkpoint = () => writeJson(path.join(evidenceDir, 'summary.json'), result);
  checkpoint();
  try {
    const stat = fs.statfsSync(evidenceDir);
    if (Number(stat.bavail) * Number(stat.bsize) < 5 * 1024 ** 3 || os.freemem() < 3 * 1024 ** 3) throw new Error('Insufficient bounded diagnostic resources');
    const { buildCodedScenario } = require('./lib/coded-audio');
    const prefix = buildCodedScenario('startup-numbered-prefix', [{ type: 'speech', seconds: PREFIX_SECONDS }], { outputDir: path.join(evidenceDir, 'reference') });
    result.prefix = prefix; checkpoint();
    for (const [name, seconds] of [['small-file', PREFIX_SECONDS], ['endurance-size-file', ENDURANCE_REFERENCE_SECONDS]]) {
      const directory = path.join(evidenceDir, name); fs.mkdirSync(directory);
      const reference = extendReference(prefix.wavPath, path.join(directory, name + '.wav'), seconds);
      writeJson(path.join(directory, 'reference.json'), reference);
      const measured = await captureCase(directory, reference, { appDir });
      result.cases.push(measured); checkpoint();
      if (!measured.completed || !measured.controlsValid) throw new Error(name + ': diagnostic measurement incomplete; retained case result has details');
      result.problems.push(...measured.problems.map(problem => name + ': ' + problem));
    }
    if (result.cases[0].reference.prefixPcmSha256 !== result.cases[1].reference.prefixPcmSha256) throw new Error('Fixture coded prefixes differ');
    Object.assign(result, summarizeCases(result.cases));
  } catch (error) { result.problems.push(error.stack || error.message); }
  if (JSON.stringify(inventory(appDir)) !== JSON.stringify(bundle)) result.problems.push('Application bundle changed during diagnostic');
  for (const [file, digest] of Object.entries(result.provenance.harnessInputs)) {
    if (hash(fs.readFileSync(path.join(ROOT, file))) !== digest) result.problems.push('Harness changed during diagnostic: ' + file);
  }
  for (const [file, digest] of Object.entries(result.provenance.runtimeInputs)) {
    if (await sha256(file) !== digest) result.problems.push('Runtime binary changed during diagnostic: ' + file);
  }
  result.pass = result.measurementCompleted && !result.problems.length;
  result.finishedAt = new Date().toISOString(); checkpoint(); return result;
}

function stopOwnedTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1 || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' }); } catch (_) { /* already exited */ }
    return;
  }
  const descendants = [child.pid];
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    for (let index = 0; index < descendants.length; index++) {
      for (const [pid, parent] of rows) if (parent === descendants[index] && !descendants.includes(pid)) descendants.push(pid);
    }
  } catch (_) { /* still stop our known worker */ }
  for (const pid of descendants.reverse()) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already exited */ } }
}

async function standalone() {
  if (process.argv.length !== 2) throw new Error('No CLI arguments; use SUISSE_E2E_APP_DIR and SUISSE_E2E_BUNDLE_SHA');
  fs.mkdirSync(WORK, { recursive: true });
  const evidenceDir = fs.mkdtempSync(path.join(WORK, 'capture-startup-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(^|_)(TOKEN|SECRET|PASSWORD|API_KEY)(_|$)/i.test(key) && !/^(APPLE_|CSC_)/i.test(key) &&
    !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'SUISSE_TEST_USERDATA', 'SUISSE_TEST_FAKE_AUDIO'].includes(key)));
  const child = spawn(process.execPath, [__filename], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, SUISSE_CAPTURE_STARTUP_WORKER: JSON.stringify({ evidenceDir }) } });
  writeJson(path.join(evidenceDir, 'supervisor.json'), { startedAt: new Date().toISOString(), timeoutMs: SUPERVISOR_MS, childPid: child.pid });
  console.log('Startup diagnostic evidence: ' + evidenceDir);
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('data', bytes => { fs.appendFileSync(path.join(evidenceDir, name + '.log'), bytes); process[name].write(bytes); });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stopOwnedTree(child); }, SUPERVISOR_MS);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); })
    .finally(() => clearTimeout(timer));
  writeJson(path.join(evidenceDir, 'exit.json'), { ...exit, timedOut, finishedAt: new Date().toISOString() });
  process.exitCode = timedOut || exit.code !== 0 ? 1 : 0;
}

if (require.main === module) {
  const task = process.env.SUISSE_CAPTURE_STARTUP_WORKER ?
    runCaptureStartupDiagnostic(JSON.parse(process.env.SUISSE_CAPTURE_STARTUP_WORKER)).then(result => {
      console.log(JSON.stringify({ pass: result.pass, measurementCompleted: result.measurementCompleted, comparison: result.comparison,
        fiveHourQualificationPassed: false, problems: result.problems, evidenceDir: result.evidenceDir }, null, 2));
      process.exitCode = result.pass ? 0 : 1;
    }) : standalone();
  task.catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { runCaptureStartupDiagnostic, extendReference, installStartupObserver, startupClockReadout, summarizeCases, validateSnapshot,
  CAPTURE_SECONDS, PREFIX_SECONDS, ENDURANCE_REFERENCE_SECONDS, MAX_REFERENCE_BYTES };
