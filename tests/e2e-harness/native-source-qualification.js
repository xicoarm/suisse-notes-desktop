'use strict';

// Standalone causal reproducer. A baseline pass means the injected mixer fault
// reproduced missing content; only --expect-preserved tests a candidate fix.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { installWitness, compareGroups, clockReadout } = require('./capture-clock-diagnostic');
const ROOT = path.resolve(__dirname, '../..');
const WORK = path.join(__dirname, 'work', 'qualification');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2));
const SUPERVISOR_MS = 10 * 60 * 1000;

// Executed in the synthetic renderer after the unchanged direct witness is
// installed. Never substitutes a capture stream or a MediaRecorder.
function installMixerFault() {
  if (!window.__directMixedWitness || window.__nativeSourceFault) throw new Error('Install exactly one direct witness before the mixer fault');
  const Original = window.AudioContext;
  const originalWebkit = window.webkitAudioContext;
  const contexts = [];
  let fault = null, activeRelease = null, disposed = false;
  const errors = [];
  const noteError = error => { if (errors.length < 20) errors.push(String(error?.message || error)); };
  const Wrapped = new Proxy(Original, {
    construct(target, args, newTarget) {
      const context = Reflect.construct(target, args, newTarget);
      const entry = { ref: context, id: contexts.length + 1, sourceTrackIds: [], destinationTrackIds: [] };
      contexts.push(entry);
      const source = context.createMediaStreamSource;
      context.createMediaStreamSource = function (stream, ...rest) {
        const node = Reflect.apply(source, this, [stream, ...rest]);
        entry.sourceTrackIds.push(...stream.getAudioTracks().map(track => track.id));
        return node;
      };
      const destination = context.createMediaStreamDestination;
      context.createMediaStreamDestination = function (...args) {
        const node = Reflect.apply(destination, this, args);
        entry.destinationTrackIds.push(...node.stream.getAudioTracks().map(track => track.id));
        return node;
      };
      return context;
    },
  });
  window.AudioContext = Wrapped;
  if (originalWebkit === Original) window.webkitAudioContext = Wrapped;
  const snapshot = () => ({ at: performance.now(), errors: [...errors], fault: fault && { ...fault },
    contexts: contexts.map(entry => ({ id: entry.id, sourceTrackIds: [...entry.sourceTrackIds],
      destinationTrackIds: [...entry.destinationTrackIds], state: entry.ref.state, currentTime: entry.ref.currentTime })) });
  const inject = async () => {
    if (disposed || fault) throw new Error('The mixer fault can run only once');
    const witness = window.__directMixedWitness.snapshot();
    const inputIds = witness.acquisitions.flatMap(item => item.sourceTrackIds);
    const applicationIds = witness.recorders.filter(item => item.role === 'actual-application').flatMap(item => item.trackIds);
    const topology = contexts.filter(entry => entry.ref.state === 'running' && entry.destinationTrackIds.length &&
      entry.sourceTrackIds.some(id => inputIds.includes(id)));
    const recorded = topology.filter(entry => entry.destinationTrackIds.some(id => applicationIds.includes(id)));
    const selected = recorded.length ? recorded : topology;
    if (selected.length !== 1) throw new Error('Cannot uniquely identify the actual microphone mixing context');
    const entry = selected[0], context = entry.ref;
    const originalResume = context.resume;
    const resumeDescriptor = Object.getOwnPropertyDescriptor(context, 'resume');
    const pending = [];
    let held = true, releasePromise = null, safetyTimer, normalTimer, finishHold;
    fault = { contextId: entry.id, selection: recorded.length ? 'recorded-destination-track' : 'unique-microphone-source-and-destination',
      sourceTrackIds: [...entry.sourceTrackIds], destinationTrackIds: [...entry.destinationTrackIds],
      requestedAt: performance.now(), suspendedAt: null, releasedAt: null, resumedAt: null,
      contextTimeBefore: context.currentTime, contextTimeSuspended: null, contextTimeAfter: null,
      heldResumeCalls: 0, safetyRelease: false, requestedHoldMs: 1000, completed: false };
    const release = () => {
      if (releasePromise) return releasePromise;
      held = false; clearTimeout(safetyTimer); clearTimeout(normalTimer);
      finishHold?.();
      fault.releasedAt = performance.now();
      if (resumeDescriptor) Object.defineProperty(context, 'resume', resumeDescriptor);
      else delete context.resume;
      releasePromise = Promise.resolve().then(() => Reflect.apply(originalResume, context, [])).then(() => {
        fault.resumedAt = performance.now(); fault.contextTimeAfter = context.currentTime;
        if (context.state !== 'running') throw new Error('Injected mixer did not resume');
      }).then(() => {
        pending.splice(0).forEach(waiter => waiter.resolve());
      }, error => { pending.splice(0).forEach(waiter => waiter.reject(error)); throw error; });
      releasePromise.catch(noteError);
      return releasePromise;
    };
    activeRelease = release;
    context.resume = function (...args) {
      if (!held || this !== context) return Reflect.apply(originalResume, this, args);
      fault.heldResumeCalls++;
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    };
    // Independent renderer watchdog releases the held native context even if
    // the CDP caller disappears or native suspend never settles.
    safetyTimer = setTimeout(() => { fault.safetyRelease = true; void release(); }, 5000);
    try {
      await Promise.race([context.suspend(), new Promise((_, reject) => {
        normalTimer = setTimeout(() => reject(new Error('Native mixer suspension timed out')), 4000);
      })]);
      clearTimeout(normalTimer);
      if (context.state !== 'suspended' || !held) throw new Error('Native mixer did not enter the held suspended state');
      fault.suspendedAt = performance.now(); fault.contextTimeSuspended = context.currentTime;
      await new Promise(resolve => { finishHold = resolve; normalTimer = setTimeout(resolve, 1000); });
      await release();
      fault.completed = true;
      return snapshot();
    } finally { try { await release(); } finally { activeRelease = null; } }
  };
  window.__nativeSourceFault = { snapshot, inject,
    dispose: async () => {
      disposed = true;
      try { if (activeRelease) await activeRelease(); }
      finally {
        window.AudioContext = Original;
        if (originalWebkit === Original) window.webkitAudioContext = originalWebkit;
      }
    },
  };
}

function parseOptions(opts = {}) {
  const seconds = opts.seconds ?? 45;
  if (!Number.isInteger(seconds) || seconds < 45 || seconds > 60) throw new Error('Native source qualification requires 45–60 seconds');
  if (opts.expectPreserved !== undefined && typeof opts.expectPreserved !== 'boolean') throw new Error('expectPreserved must be boolean');
  return { seconds, injectAtS: 15, expectPreserved: opts.expectPreserved === true };
}

function assessSourcePreservation({ direct, final, directVerification, finalVerification, snapshot, fault, expectPreserved }) {
  const controlsProblems = [];
  const directRecorder = snapshot.recorders.filter(item => item.role === 'direct-witness');
  if (snapshot.acquisitions.length !== 1 || directRecorder.length !== 1) controlsProblems.push('Expected one native acquisition and one direct witness');
  if (!snapshot.acquisitions[0]?.settings?.length || snapshot.errors.length) controlsProblems.push('Native settings missing or witness reported an error');
  if (snapshot.recorders.length < 2 || snapshot.recorders.some(item => item.timesliceMs !== 1000 ||
      !Number.isFinite(item.startedAt) || !Number.isFinite(item.stoppedAt))) controlsProblems.push('Unexpected native recorder lifecycle or timeslice');
  if (directVerification.problems.length) controlsProblems.push(...directVerification.problems.map(problem => 'Native witness: ' + problem));
  const heldMs = Number.isFinite(fault?.releasedAt) && Number.isFinite(fault?.suspendedAt) ? fault.releasedAt - fault.suspendedAt : null;
  if (!fault?.completed || fault.safetyRelease || heldMs === null || heldMs < 950 || heldMs > 1500 || !Number.isFinite(fault.resumedAt)) {
    controlsProblems.push('The intended one-second mixer suspension was not confirmed');
  }
  const comparison = compareGroups(direct, final);
  const first = comparison.commonSourceInterval?.firstFrame, last = comparison.commonSourceInterval?.lastFrame;
  if (!Number.isInteger(first) || !Number.isInteger(last)) controlsProblems.push('No sufficient common interior source interval');
  const directMap = new Map(direct.groups.map(group => [group.id, group]));
  const finalMap = new Map();
  for (const group of final.groups) { if (!finalMap.has(group.id)) finalMap.set(group.id, []); finalMap.get(group.id).push(group); }
  // Native start dispatch and delivery latency make this an attribution
  // window, not a source/sample clock conversion or a loss-budget tolerance.
  const injectionPositionS = fault && directRecorder[0] ? (fault.suspendedAt - directRecorder[0].startCalledAt) / 1000 : null;
  const attributionSlackS = 2;
  const missingInteriorIds = [], affectedNearInjection = [];
  if (Number.isInteger(first) && Number.isInteger(last)) {
    for (let id = first; id <= last; id++) {
      const source = directMap.get(id), output = finalMap.get(id) || [];
      if (!source) continue;
      if (!output.length) missingInteriorIds.push(id);
      const center = (source.start + source.end) / 2;
      const malformed = output.length !== 1 || source.end - source.start - (output[0].end - output[0].start) > 0.1 + 1e-9;
      if (malformed && Number.isFinite(injectionPositionS) && center >= injectionPositionS - attributionSlackS &&
          center <= injectionPositionS + 1 + attributionSlackS) affectedNearInjection.push(id);
    }
  }
  const preservationProblems = [...finalVerification.problems, ...comparison.problems];
  // 80 ms analysis window + 20 ms hop, matching the existing oracle's basic
  // timing resolution. It is not a relaxation of historical verdicts.
  if (comparison.maximumAbsoluteRelativeDriftS > 0.1 + 1e-9) preservationProblems.push('Final/native source alignment drift exceeds 100 ms');
  const controlsValid = controlsProblems.length === 0;
  const lossReproduced = controlsValid && affectedNearInjection.length > 0;
  const contentPreserved = controlsValid && preservationProblems.length === 0;
  return { controlsValid, controlsProblems, heldMs, injectionPositionS, attributionSlackS, missingInteriorIds,
    affectedNearInjection, comparison, preservationProblems, lossReproduced, contentPreserved,
    expectation: expectPreserved ? 'final-preserves-native-input' : 'baseline-reproduces-mixer-loss',
    expectationMet: expectPreserved ? contentPreserved : lossReproduced };
}

function inventory(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return inventory(filename, base);
    if (!entry.isFile()) throw new Error('Unexpected symbolic link in diagnostic inventory');
    return [{ path: path.relative(base, filename).replaceAll('\\', '/'), size: fs.statSync(filename).size, sha256: hash(fs.readFileSync(filename)) }];
  });
}

function provenance(appDirectory, applicationBuildCommit) {
  return { appDirectory, applicationBuildCommit, platform: process.platform, architecture: process.arch,
    harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim(),
    electron: require('electron/package.json').version, electronSha256: hash(fs.readFileSync(require('electron'))),
    compiledFiles: inventory(appDirectory),
    harnessFiles: [__filename, path.join(__dirname, 'capture-clock-diagnostic.js'), path.join(__dirname, 'lib/app-driver.js'),
      path.join(__dirname, 'lib/coded-audio.js'), path.join(__dirname, 'lib/mock-backend.js'), path.join(ROOT, 'package-lock.json'),
      require('@ffmpeg-installer/ffmpeg').path].map(filename => ({ filename, sha256: hash(fs.readFileSync(filename)) })) };
}

function verifyUnchanged(before) {
  if (JSON.stringify(provenance(before.appDirectory, before.applicationBuildCommit)) !== JSON.stringify(before)) throw new Error('Bundle, runtime, or harness changed during native source case');
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function exportWitness(app, directory, prefix = 'direct') {
  const snapshot = await app.evalTimed(() => window.__directMixedWitness.snapshot());
  const chunksDirectory = fs.mkdtempSync(path.join(directory, prefix + '-chunks-'));
  const joinedPath = path.join(chunksDirectory, 'original.webm');
  const joined = fs.openSync(joinedPath, 'wx'), chunks = [];
  try {
    for (let index = 0; index < snapshot.directChunks; index++) {
      const item = await app.evalTimed(i => window.__directMixedWitness.exportChunk(i), index);
      const bytes = Buffer.from(item.base64, 'base64');
      if (bytes.length !== item.size) throw new Error('Direct witness export length differs');
      const filename = path.join(chunksDirectory, 'chunk_' + index + '.webm');
      fs.writeFileSync(filename, bytes, { flag: 'wx' });
      let written = 0;
      while (written < bytes.length) written += fs.writeSync(joined, bytes, written, bytes.length - written);
      chunks.push({ index, size: bytes.length, sha256: hash(bytes), filename });
    }
    fs.fsyncSync(joined);
  } finally { fs.closeSync(joined); }
  return { chunksDirectory, joinedPath, chunks, sha256: hash(fs.readFileSync(joinedPath)) };
}

async function runNativeSourceQualification(opts = {}) {
  const options = parseOptions(opts);
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Native Windows or macOS required');
  if (process.env.SUISSE_E2E_HOOKS !== '1' || process.env.SUISSE_TEST_NETWORK_ISOLATION !== '1') throw new Error('Explicit synthetic and network-isolation flags required');
  if (process.env.SUISSE_E2E_PACKAGED_EXE) throw new Error('Release installers cannot be used for this case');
  const appDirectory = path.resolve(opts.appDir || process.env.SUISSE_E2E_APP_DIR || 'dist/electron/UnPackaged');
  const applicationBuildCommit = opts.bundleSha || process.env.SUISSE_E2E_BUNDLE_SHA;
  if (!/^[a-f0-9]{40}$/i.test(applicationBuildCommit || '')) throw new Error('Explicit application build SHA required');
  const before = provenance(appDirectory, applicationBuildCommit);
  fs.mkdirSync(WORK, { recursive: true });
  const directory = opts.evidenceDir || fs.mkdtempSync(path.join(WORK, 'native-source-'));
  if (!path.resolve(directory).startsWith(path.resolve(WORK) + path.sep)) throw new Error('Evidence must stay in synthetic qualification work');
  if (fs.existsSync(path.join(directory, 'result.json'))) throw new Error('Refusing to overwrite historical source qualification');
  const { AppDriver, sleep } = require('./lib/app-driver');
  const { startMockBackend } = require('./lib/mock-backend');
  const { buildCodedScenario, analyzeCodedAudio, verifyCodedAudio } = require('./lib/coded-audio');
  const result = { diagnostic: 'native-input-survives-mixer-suspension', pass: false, measurementCompleted: false,
    sourcePreservationQualified: false, fiveHourQualificationPassed: false, productionBackendQualified: false, physicalHardwareQualified: false,
    options, evidenceDir: directory, provenance: before, startedAt: new Date().toISOString(), problems: [], samples: [],
    notes: ['Baseline pass means mixer loss was reproduced while the native witness remained complete. It is not qualification of the application.',
      'The fixture holds only one identified application mixer suspended for one second. It does not simulate the precise hosted FIFO scheduling.',
      'A separate direct native clone adds encoder workload. No second microphone acquisition, system capture, playback, or production upload is used.',
      'The preserved expectation qualifies only this short microphone scenario. Source replacement, pause/mute, dual-source alignment and hardware remain separate tests.'] };
  const checkpoint = () => writeJson(path.join(directory, 'result.json'), result);
  let app = null, mock = null;
  checkpoint();
  try {
    const name = path.basename(directory);
    const reference = buildCodedScenario(name, [{ type: 'speech', seconds: options.seconds + 30 }], { outputDir: path.join(directory, 'reference') });
    result.reference = { ...reference, sha256: hash(fs.readFileSync(reference.wavPath)) };
    mock = await startMockBackend({ port: 3000 });
    if (!['http://127.0.0.1:3000', 'http://localhost:3000'].includes(mock.url)) throw new Error('Unexpected local mock URL');
    app = new AppDriver({ name, apiUrl: mock.url, appDir: appDirectory, cdpPort: await unusedPort(), fakeAudioWav: reference.wavPath,
      env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
    result.profile = app.userDataDir;
    await app.launch(); result.ownedElectronPid = app.proc?.pid; result.diagnostics = app.diagnosticsDir; checkpoint();
    await app.login();
    if (await app.evalTimed(() => window.electronAPI.config.getApiUrl()) !== mock.url) throw new Error('Application did not select the isolated backend');
    await app.page.waitForSelector('[data-test="system-audio-toggle"]', { visible: true, timeout: 20000 });
    const enabled = await app.evalTimed(() => document.querySelector('[data-test="system-audio-toggle"]')?.getAttribute('aria-checked'));
    if (enabled === 'true') await app.clickByTest('[data-test="system-audio-toggle"]');
    if (await app.evalTimed(() => document.querySelector('[data-test="system-audio-toggle"]')?.getAttribute('aria-checked')) !== 'false') throw new Error('System audio must be confirmed off');
    await app.evalTimed(installWitness, { processingDisabled: false });
    await app.evalTimed(installMixerFault);
    await app.startRecording();
    result.recordId = await app.evalTimed(() => (window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia)?.state?.value?.recording?.recordId);
    if (!/^[a-f0-9-]{36}$/i.test(result.recordId || '')) throw new Error('Missing isolated recording identity');
    const began = performance.now();
    while (performance.now() - began < options.seconds * 1000) {
      const elapsedS = (performance.now() - began) / 1000;
      const renderer = await app.evalTimed(() => window.__directMixedWitness.snapshot());
      result.samples.push({ elapsedS, renderer }); checkpoint();
      if (renderer.errors.length || renderer.recorders.length < 2 || renderer.recorders.some(recorder => recorder.state !== 'recording')) throw new Error('A native capture branch failed or stopped before the intended end');
      if (!result.injection && elapsedS >= options.injectAtS) {
        result.beforeInjection = renderer; checkpoint();
        result.injection = await app.evalTimed(() => window.__nativeSourceFault.inject(), undefined, 12000);
        checkpoint();
      }
      await sleep(Math.min(1000, Math.max(1, options.seconds * 1000 - (performance.now() - began))));
    }
    await app.stopRecording(60000);
    await app.evalTimed(() => window.__directMixedWitness.stopDirect(), undefined, 15000);
    result.faultSnapshot = await app.evalTimed(() => window.__nativeSourceFault.snapshot());
    if (result.faultSnapshot.errors.length) throw new Error(result.faultSnapshot.errors.join('; '));
    result.directEvidence = await exportWitness(app, directory); checkpoint();
    await app.waitForPhase(['uploaded', 'error'], 120000);
    result.phase = await app.getPhase();
    if (result.phase !== 'uploaded') throw new Error('Application did not complete the local mock upload');
    // The stop button can leave the app in "stopping" while native final data
    // and its disk writes are still pending. Observe all final lifecycle events
    // only after the app has completed that work and its isolated upload.
    result.finalSnapshot = await app.evalTimed(() => window.__directMixedWitness.snapshot());
    result.clockReadout = clockReadout(result.samples, result.finalSnapshot);
    result.finalPath = app.findOutputFile();
    if (!result.finalPath || path.basename(path.dirname(result.finalPath)) !== result.recordId) throw new Error('No final output for this recording identity');
    result.finalSha256 = hash(fs.readFileSync(result.finalPath));
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(result.finalPath), 'upload-receipt.json'), 'utf8'));
    const remote = mock.state.uploads.get(receipt.audioFileId);
    result.upload = { remoteSha256: remote?.sha256, localSha256: result.finalSha256, canDelete: receipt.canDelete };
    if (remote?.sha256 !== result.finalSha256 || receipt.canDelete !== false) throw new Error('Final/upload custody or source retention check failed');
    result.recordingInventory = inventory(path.dirname(result.finalPath));
    if (!result.recordingInventory.some(file => /(^|\/)chunk_\d+\.webm$/.test(file.path))) throw new Error('No retained original application source chunks found');
    await app.evalTimed(() => window.__nativeSourceFault.dispose());
    await app.evalTimed(() => window.__directMixedWitness.dispose());
    await app.close({ keepProfile: true }); app = null;
    await mock.close(); mock = null;
    // All native capture and app processes are closed before any decoding.
    checkpoint();
    const direct = await analyzeCodedAudio(result.directEvidence.joinedPath);
    const final = await analyzeCodedAudio(result.finalPath);
    writeJson(path.join(directory, 'direct-analysis.json'), direct);
    writeJson(path.join(directory, 'final-analysis.json'), final);
    const directVerification = await verifyCodedAudio(result.directEvidence.joinedPath, reference);
    const finalVerification = await verifyCodedAudio(result.finalPath, reference);
    result.verification = { direct: directVerification, final: finalVerification };
    result.assessment = assessSourcePreservation({ direct, final, directVerification, finalVerification,
      snapshot: result.finalSnapshot, fault: result.faultSnapshot.fault, expectPreserved: options.expectPreserved });
    result.problems.push(...result.assessment.controlsProblems);
    if (!result.assessment.expectationMet) result.problems.push(options.expectPreserved ?
      'The final output did not preserve native input across the injected mixer suspension' : 'Baseline mixer loss was not established near the injected suspension');
    verifyUnchanged(before);
    result.measurementCompleted = true;
    result.sourcePreservationQualified = options.expectPreserved && result.assessment.contentPreserved;
  } catch (error) { result.problems.push(error.stack || error.message); }
  finally {
    if (app) {
      try { await app.evalTimed(() => window.__nativeSourceFault?.dispose(), undefined, 10000); } catch (error) { result.problems.push('Fault cleanup: ' + error.message); }
      try { await app.evalTimed(() => window.__directMixedWitness?.dispose(), undefined, 12000); } catch (error) { result.problems.push('Witness cleanup: ' + error.message); }
      if (!result.directEvidence) {
        try { result.failedDirectEvidence = await exportWitness(app, directory, 'failed-direct'); } catch (error) { result.problems.push('Witness preservation: ' + error.message); }
      }
      await app.close({ keepProfile: true }).catch(error => result.problems.push('App cleanup: ' + error.message));
    }
    if (mock) { mock.server.closeAllConnections?.(); await mock.close().catch(error => result.problems.push('Mock cleanup: ' + error.message)); }
    try { verifyUnchanged(before); } catch (error) { result.problems.push(error.message); result.sourcePreservationQualified = false; }
    result.pass = result.measurementCompleted && result.problems.length === 0;
    result.finishedAt = new Date().toISOString(); checkpoint();
  }
  return result;
}

function parseCli(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--expect-preserved') options.expectPreserved = true;
    else if (arg === '--seconds' && /^\d+$/.test(args[index + 1] || '')) options.seconds = Number(args[++index]);
    else if (arg === '--app-dir' && args[index + 1]) options.appDir = args[++index];
    else if (arg === '--bundle-sha' && args[index + 1]) options.bundleSha = args[++index];
    else throw new Error('Unknown or incomplete native-source argument: ' + arg);
  }
  parseOptions(options);
  return options;
}

function stopOwnedTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1 || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' }); }
    catch (_) { /* child may already have exited */ }
    return;
  }
  const descendants = [child.pid];
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    for (let index = 0; index < descendants.length; index++) {
      for (const [pid, parent] of rows) if (parent === descendants[index] && !descendants.includes(pid)) descendants.push(pid);
    }
  } catch (_) { /* retain the observed supervisor */ }
  for (const pid of descendants.reverse()) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already exited */ } }
}

async function standalone(options) {
  fs.mkdirSync(WORK, { recursive: true });
  const evidenceDir = fs.mkdtempSync(path.join(WORK, 'native-source-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(^|_)(TOKEN|SECRET|PASSWORD|API_KEY)(_|$)/i.test(key) && !/^(APPLE_|CSC_)/i.test(key) &&
    !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'SUISSE_TEST_USERDATA', 'SUISSE_TEST_FAKE_AUDIO'].includes(key)));
  const child = spawn(process.execPath, [__filename], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, SUISSE_NATIVE_SOURCE_WORKER: JSON.stringify({ ...options, evidenceDir }) } });
  writeJson(path.join(evidenceDir, 'supervisor.json'), { startedAt: new Date().toISOString(), timeoutMs: SUPERVISOR_MS, childPid: child.pid, options });
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('data', data => { fs.appendFileSync(path.join(evidenceDir, name + '.log'), data); process[name].write(data); });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stopOwnedTree(child); }, SUPERVISOR_MS);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
  writeJson(path.join(evidenceDir, 'exit.json'), { ...exit, timedOut, finishedAt: new Date().toISOString() });
  console.log('Native-source evidence: ' + path.join(evidenceDir, 'result.json'));
  process.exitCode = timedOut || exit.code !== 0 ? 1 : 0;
}

if (require.main === module) {
  const task = process.env.SUISSE_NATIVE_SOURCE_WORKER ?
    runNativeSourceQualification(JSON.parse(process.env.SUISSE_NATIVE_SOURCE_WORKER)).then(result => {
      console.log(JSON.stringify({ pass: result.pass, expectation: result.assessment?.expectation,
        sourcePreservationQualified: result.sourcePreservationQualified, problems: result.problems, evidenceDir: result.evidenceDir }, null, 2));
      process.exitCode = result.pass ? 0 : 1;
    }) : standalone(parseCli(process.argv.slice(2)));
  task.catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { runNativeSourceQualification, installMixerFault, assessSourcePreservation, parseOptions, parseCli };
