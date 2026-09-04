'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { spawn, execFileSync } = require('child_process');
const { AppDriver, sleep } = require('./lib/app-driver');
const { buildCodedScenario, WORK_DIR, FFMPEG } = require('./lib/audio');
const { verifyCodedAudio } = require('./lib/coded-audio');
const { startMockBackend } = require('./lib/mock-backend');
const { concatenateFiles } = require('../../src-electron/durable-files');

function assertSyntheticPath(filename) {
  const target = path.resolve(filename), root = path.resolve(WORK_DIR);
  if (!target.startsWith(root + path.sep)) throw new Error('Crash evidence must stay inside synthetic harness work');
  return target;
}

async function sha256(filename) {
  assertSyntheticPath(filename);
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

async function snapshotChunks(recordingDir, acknowledgedCount = Infinity) {
  assertSyntheticPath(recordingDir);
  const archive = path.join(recordingDir, 'source-chunks');
  const directories = [path.join(recordingDir, 'chunks')];
  if (fs.existsSync(archive)) {
    for (const entry of fs.readdirSync(archive, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d+$/.test(entry.name)) directories.push(path.join(archive, entry.name));
    }
  }
  const chunks = [];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const match = entry.name.match(/^chunk_(\d+)\.webm$/);
      if (!entry.isFile() || !match || Number(match[1]) >= acknowledgedCount) continue;
      const filename = path.join(directory, entry.name);
      chunks.push({ index: Number(match[1]), relativePath: path.relative(recordingDir, filename),
        bytes: fs.statSync(filename).size, sha256: await sha256(filename) });
    }
  }
  return chunks.sort((a, b) => a.index - b.index);
}

function compareChunks(expected, actual) {
  const problems = [];
  const byIndex = new Map();
  for (const chunk of actual) {
    if (byIndex.has(chunk.index)) problems.push('Duplicate durable chunk index ' + chunk.index);
    byIndex.set(chunk.index, chunk);
  }
  for (let index = 0; index < actual.length; index++) {
    if (!byIndex.has(index)) problems.push('Durable chunk sequence is missing index ' + index);
  }
  for (const chunk of expected) {
    const current = byIndex.get(chunk.index);
    if (!current) problems.push('Previously durable chunk disappeared: ' + chunk.index);
    else if (current.bytes !== chunk.bytes || current.sha256 !== chunk.sha256) problems.push('Previously durable chunk changed: ' + chunk.index);
  }
  return problems;
}

function prefixEndpointCoverage(audio, toleranceS = 1.5) {
  if (!Number.isFinite(audio?.sourceOffsetS) || !Number.isFinite(audio.durationS) || !Number.isInteger(audio.firstFrame) || !Number.isInteger(audio.lastFrame)) {
    return { problems: ['Missing numbered-frame evidence at the recovered prefix boundaries'] };
  }
  const leadingUnidentifiedS = Math.max(0, audio.firstFrame * 0.5 - audio.sourceOffsetS);
  const trailingUnidentifiedS = Math.max(0, audio.durationS - ((audio.lastFrame + 1) * 0.5 - audio.sourceOffsetS));
  const problems = [];
  if (leadingUnidentifiedS > toleranceS) problems.push('Recovered prefix begins with excessive unidentified audio');
  if (trailingUnidentifiedS > toleranceS) problems.push('Recovered prefix ends with excessive unidentified audio');
  return { leadingUnidentifiedS, trailingUnidentifiedS, toleranceS, problems };
}

async function killOwnedApp(app, operations = {}) {
  app.assertTestProfile();
  const child = app.proc, platform = operations.platform || process.platform;
  const pid = child?.pid;
  if (!app.appDir || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || child.exitCode !== null || child.signalCode !== null) {
    throw new Error('Refusing to kill anything except the observed live synthetic Electron child');
  }
  const bundle = path.resolve(app.appDir);
  if (!child.spawnargs?.some(argument => path.resolve(argument) === bundle)) throw new Error('Observed child is not the requested compiled app');
  if (!['win32', 'darwin'].includes(platform)) throw new Error('Native crash qualification requires Windows or macOS');
  const started = performance.now();
  let timer, exitHandler;
  const exited = new Promise((resolve, reject) => {
    exitHandler = (code, signal) => resolve({ code, signal });
    child.once('exit', exitHandler);
    timer = setTimeout(() => reject(new Error('Killed synthetic process did not exit within 20 seconds')), 20000);
  });
  exited.catch(() => {});
  try {
    app.writeDiagnostic('driver', `Abrupt main-process crash injection; observed PID=${pid}`);
    if (platform === 'win32') {
      (operations.execFileSync || execFileSync)('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    } else {
      // AppDriver launches this exact child in its own detached process group.
      (operations.kill || process.kill)(-pid, 'SIGKILL');
    }
    const exit = await exited;
    app.proc = null; // Never let later cleanup target a recycled operating-system PID.
    return { pid, platform, method: platform === 'win32' ? 'taskkill /T /F' : 'process-group SIGKILL', ...exit, elapsedMs: performance.now() - started };
  } finally {
    clearTimeout(timer); child.removeListener('exit', exitHandler);
  }
}

async function decodedFingerprint(filename) {
  assertSyntheticPath(filename);
  const hash = crypto.createHash('sha256');
  const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', filename, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
  let bytes = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Crash-prefix decode failed: ' + stderr)));
  });
  finished.catch(() => {});
  try {
    for await (const chunk of child.stdout) { hash.update(chunk); bytes += chunk.length; }
    await finished;
  } catch (error) { child.kill(); throw error; }
  return { sha256: hash.digest('hex'), bytes, durationS: bytes / 96000, decoderWarnings: stderr.trim() || null };
}

async function recordingSnapshot(app) {
  return app.evalTimed(() => {
    const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
    const state = pinia?.state?.value?.recording;
    return { phase: state?.phase, recordId: state?.recordId, acknowledgedChunks: state?.chunkIndex,
      chunkSaveErrors: state?.chunkSaveErrors, capture: window.__suisseCaptureDiagnostics?.snapshot() };
  });
}

async function visibleHistory(app, recordId) {
  return app.evalTimed(rid => {
    const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
    const recordings = pinia?.state?.value?.['recordings-history']?.recordings || pinia?.state?.value?.recordingsHistory?.recordings || [];
    const recording = recordings.find(item => item.id === rid);
    const card = [...document.querySelectorAll('.history-card')].find(element => {
      let owner = element.__vueParentComponent;
      while (owner) { if (owner.props?.recording?.id === rid) return true; owner = owner.parent; }
      return false;
    });
    const box = card?.getBoundingClientRect();
    return { id: recording?.id, recovered: recording?.recovered === true, uploadStatus: recording?.uploadStatus,
      audioFileId: recording?.audioFileId, visible: !!box?.width && !!box?.height, text: card?.textContent?.trim().slice(0, 500) || null };
  }, recordId);
}

async function runMainCrashQualification(opts = {}) {
  const seconds = opts.seconds ?? 48;
  if (!Number.isInteger(seconds) || seconds < 45 || seconds > 60) throw new Error('Crash qualification requires 45–60 real capture seconds');
  const appDir = opts.appDir || process.env.SUISSE_E2E_APP_DIR;
  if (!appDir) throw new Error('Crash qualification requires an isolated compiled Electron bundle');
  const name = 's15-main-crash-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8);
  const evidenceDir = assertSyntheticPath(path.join(WORK_DIR, 'qualification', name));
  fs.mkdirSync(evidenceDir, { recursive: true });
  const summaryPath = path.join(evidenceDir, 'summary.json');
  const result = { name, pass: false, problems: [], notes: [
    'Abrupt whole-app process termination; no graceful stop or renderer-only crash.',
    'Only audio that reached durable storage can survive this crash. No audio is expected during process downtime.',
    'Synthetic microphone and localhost upload; physical devices, power-loss disk caches, and production backend acceptance are outside this test.',
  ], requestedSeconds: seconds, progress: [], evidenceDir, summaryPath };
  const checkpoint = stage => {
    result.stage = stage; result.updatedAt = new Date().toISOString();
    const fd = fs.openSync(summaryPath, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(result, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  let first = null, recovered = null, mock = null;
  try {
    const reference = buildCodedScenario(name, [{ type: 'speech', seconds: seconds + 25 }]);
    result.reference = reference.metaPath;
    mock = await startMockBackend({ port: opts.mockPort || 3000 });
    first = new AppDriver({ name, appDir, apiUrl: mock.url, fakeAudioWav: reference.wavPath, env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
    await first.launch(); await first.login();
    if (await first.evalTimed(() => window.electronAPI.config.getApiUrl()) !== mock.url) throw new Error('Crash qualification must use only the local backend');
    result.bundleSha = opts.bundleSha || process.env.SUISSE_E2E_BUNDLE_SHA || null;
    result.profile = first.userDataDir; result.beforeDiagnostics = first.diagnosticsDir;
    await first.startRecording();
    const started = performance.now();
    while (performance.now() - started < seconds * 1000) {
      const state = await recordingSnapshot(first);
      result.progress.push({ elapsedS: (performance.now() - started) / 1000, ...state });
      checkpoint('recording');
      if (state.phase !== 'recording') throw new Error('Capture left recording phase before crash injection');
      await sleep(Math.min(5000, Math.max(1, seconds * 1000 - (performance.now() - started))));
    }
    let before, chunks, observationHostAt;
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await recordingSnapshot(first);
      if (!/^[a-f0-9-]{36}$/i.test(state.recordId || '')) throw new Error('Invalid synthetic recording ID');
      result.recordId = state.recordId;
      const recordingDir = assertSyntheticPath(path.join(first.recordingsDir, state.recordId));
      chunks = await snapshotChunks(recordingDir, state.acknowledgedChunks);
      before = await recordingSnapshot(first);
      observationHostAt = performance.now();
      if (before.acknowledgedChunks === state.acknowledgedChunks) break;
      before = null;
    }
    if (!before || before.phase !== 'recording' || before.chunkSaveErrors || chunks.length < 5 || chunks.length !== before.acknowledgedChunks) {
      throw new Error('Could not establish a stable, acknowledged durable prefix before the crash');
    }
    result.beforeCrash = before; result.acknowledgedChunks = chunks;
    const recordingDir = assertSyntheticPath(path.join(first.recordingsDir, result.recordId));
    if (first.findOutputFile()) throw new Error('An output already existed before the abrupt crash');
    checkpoint('durable-prefix-established');
    result.crash = await killOwnedApp(first);
    result.observationToExitSeconds = (performance.now() - observationHostAt) / 1000;
    await first.close({ keepProfile: true });
    result.crashSurvivors = await snapshotChunks(recordingDir);
    result.problems.push(...compareChunks(chunks, result.crashSurvivors));
    if (result.problems.length) throw new Error('An acknowledged source did not survive full process termination');
    const rawPrefix = assertSyntheticPath(path.join(evidenceDir, 'crash-durable-prefix.webm'));
    await concatenateFiles(result.crashSurvivors.map(chunk => path.join(recordingDir, chunk.relativePath)), rawPrefix);
    result.rawPrefix = rawPrefix;
    checkpoint('restarting-same-profile');

    recovered = new AppDriver({ name: name + '-restarted', appDir, userDataDir: first.userDataDir,
      cdpPort: 9341, apiUrl: mock.url, fakeAudioWav: reference.wavPath, env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
    await recovered.launch({ freshProfile: false }); await recovered.login();
    result.afterDiagnostics = recovered.diagnosticsDir;
    if (await recovered.evalTimed(() => window.electronAPI.config.getApiUrl()) !== mock.url) throw new Error('Recovery must use only the local backend');
    // Do not age chunk timestamps or invoke private finalization IPC. Exercise
    // the real startup scan and its scheduled freshness re-scan unchanged.
    const deadline = performance.now() + 180000;
    const receiptPath = path.join(recordingDir, 'upload-receipt.json');
    while (!fs.existsSync(receiptPath) && performance.now() < deadline) await sleep(1000);
    if (!fs.existsSync(receiptPath)) throw new Error('Native startup recovery did not finalize and upload within three minutes');
    const output = path.join(recordingDir, 'audio.webm');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    result.receipt = receipt;
    result.output = output;
    const remote = mock.state.uploads.get(receipt.audioFileId);
    result.upload = { localSha256: await sha256(output), localBytes: fs.statSync(output).size,
      remoteSha256: remote?.sha256, remoteBytes: remote?.fileSize,
      attempts: mock.state.requests.filter(request => request.url === '/api/desktop/upload').length };
    if (result.upload.localSha256 !== remote?.sha256 || result.upload.localBytes !== remote?.fileSize) result.problems.push('Recovered upload differs from the finalized local file');
    if (result.upload.attempts !== 1) result.problems.push('Recovery should upload once against the healthy mock');
    if (receipt.canDelete !== false || !fs.existsSync(output)) result.problems.push('Recovery did not retain its local backup');
    result.retainedChunks = await snapshotChunks(recordingDir);
    result.problems.push(...compareChunks(result.crashSurvivors, result.retainedChunks));
    if (result.retainedChunks.length !== result.crashSurvivors.length) result.problems.push('Recovery unexpectedly added source chunks without recording new audio');

    await recovered.navigate('/history');
    const historyDeadline = performance.now() + 15000;
    do { result.history = await visibleHistory(recovered, result.recordId); if (result.history.visible && result.history.uploadStatus === 'uploaded') break; await sleep(500); }
    while (performance.now() < historyDeadline);
    if (!result.history.visible || !result.history.recovered || result.history.uploadStatus !== 'uploaded') result.problems.push('Recovered, uploaded recording is not visible in its history card');
    result.screenshot = await recovered.screenshot(name + '-recovered-history');
    checkpoint('verifying-durable-prefix');
    result.originalPcm = await decodedFingerprint(rawPrefix);
    result.recoveredPcm = await decodedFingerprint(output);
    if (result.originalPcm.sha256 !== result.recoveredPcm.sha256 || result.originalPcm.bytes !== result.recoveredPcm.bytes) {
      result.problems.push('Final recovery changed or omitted audio from the crash-surviving durable prefix');
    }
    result.audio = await verifyCodedAudio(output, reference, { expectedDurationS: result.originalPcm.durationS, durationToleranceS: 0.03 });
    result.problems.push(...result.audio.problems);
    result.endpointCoverage = prefixEndpointCoverage(result.audio);
    result.problems.push(...result.endpointCoverage.problems);
    const native = before.capture?.recorders?.at(-1);
    if (native?.startedAt == null || native.state !== 'recording') throw new Error('Missing active native recording evidence at crash');
    result.tailExposure = { nativeSecondsAtLastObservation: (before.capture.at - native.startedAt) / 1000,
      durableAudioSeconds: result.originalPcm.durationS, acknowledgedChunkCount: chunks.length,
      nativeEventsAtLastObservation: native.events, nativeBytesAtLastObservation: native.bytes,
      acknowledgedBytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0), crashSurvivingBytes: result.crashSurvivors.reduce((total, chunk) => total + chunk.bytes, 0) };
    result.tailExposure.notYetDurableSecondsAtLastObservation = Math.max(0, result.tailExposure.nativeSecondsAtLastObservation - result.originalPcm.durationS);
    result.tailExposure.tailUpperBoundIncludingTerminationDelayS = Math.max(0, result.tailExposure.nativeSecondsAtLastObservation + result.observationToExitSeconds - result.originalPcm.durationS);
    if (result.tailExposure.notYetDurableSecondsAtLastObservation > 4.5) result.problems.push('Observed undurable tail exceeded the ordinary three-second slice plus 1.5-second timing allowance');
    result.pass = result.problems.length === 0;
  } catch (error) { result.failureStage = result.stage; result.problems.push(error.stack || error.message); }
  finally {
    result.profile = first?.userDataDir || null;
    result.beforeDiagnostics = first?.diagnosticsDir || null; result.afterDiagnostics = recovered?.diagnosticsDir || null;
    const cleanupError = error => { result.pass = false; result.problems.push('Evidence/cleanup: ' + error.message); };
    try { checkpoint('finished'); } catch (error) { cleanupError(error); }
    if (recovered) await recovered.close({ keepProfile: true }).catch(cleanupError);
    if (first) await first.close({ keepProfile: true }).catch(cleanupError);
    if (mock) await mock.close().catch(cleanupError);
    try { checkpoint('finished'); } catch (error) { cleanupError(error); }
  }
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${name}: ${result.problems.join('; ') || 'durable prefix, recovery, upload hash and visible history verified'}`);
  return result;
}

module.exports = { runMainCrashQualification, killOwnedApp, snapshotChunks, compareChunks, prefixEndpointCoverage, assertSyntheticPath };
