'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { spawn, execFileSync } = require('child_process');
const { AppDriver, sleep } = require('./lib/app-driver');
const { buildCodedScenario, WORK_DIR, FFMPEG } = require('./lib/audio');
const { verifyCodedAudio, analyzeCodedAudio } = require('./lib/coded-audio');
const { startMockBackend } = require('./lib/mock-backend');
const { concatenateFiles } = require('../../src-electron/durable-files');
const { inspectNativeSources } = require('../../src-electron/native-source-persistence');

// Passive, local to s15. The source writer converts one Blob, awaits its save
// acknowledgement, then starts the next conversion. Conversion i+1 therefore
// proves acknowledgement of i, even though the immutable preload bridge does
// not expose its exact latest acknowledgement. Do not treat conversion i itself
// as durable. This deliberately conservative lower bound keeps the 2.5s budget.
function installNativeCrashObserver() {
  if (window.__nativeCrashEvidence) throw new Error('Native crash observer already installed');
  const NativeContext = window.AudioContext, originalWebkit = window.webkitAudioContext;
  const originalStart = MediaRecorder.prototype.start, originalArrayBuffer = Blob.prototype.arrayBuffer;
  const originalAcquire = navigator.mediaDevices.getUserMedia;
  const destinations = new Set(), acquisitions = [], records = [], blobs = new WeakMap(), errors = [];
  const WrappedContext = new Proxy(NativeContext, { construct(target, args, newTarget) {
    const context = Reflect.construct(target, args, newTarget), originalDestination = context.createMediaStreamDestination;
    context.createMediaStreamDestination = function (...args) {
      const node = Reflect.apply(originalDestination, this, args);
      node.stream.getAudioTracks().forEach(track => destinations.add(track.id));
      return node;
    };
    return context;
  } });
  window.AudioContext = WrappedContext;
  if (originalWebkit === NativeContext) window.webkitAudioContext = WrappedContext;
  navigator.mediaDevices.getUserMedia = async function (...args) {
    const stream = await Reflect.apply(originalAcquire, this, args);
    acquisitions.push(stream.getAudioTracks().map(track => track.id));
    return stream;
  };
  MediaRecorder.prototype.start = function (...args) {
    const trackIds = this.stream.getAudioTracks().map(track => track.id);
    const inputIds = new Set(acquisitions.flat());
    const role = trackIds.length === 1 && destinations.has(trackIds[0]) ? 'live-mix'
      : trackIds.length === 1 && inputIds.has(trackIds[0]) ? 'native-microphone' : 'unknown';
    const entry = { recorder: this, id: records.length + 1, role, trackIds, startCalledAt: performance.now(), startedAt: null,
      stoppedAt: null, timesliceMs: args[0], events: 0, bytes: 0, chunks: [], lastConversionIndex: -1, acknowledgedCount: 0 };
    records.push(entry);
    const handler = this.ondataavailable;
    if (typeof handler !== 'function') throw new Error('Expected native source handler before start');
    this.ondataavailable = function (event) {
      entry.events++; entry.bytes += event.data.size;
      if (event.data.size) {
        const chunk = { index: entry.chunks.length, bytes: event.data.size, conversionStartedAt: null };
        entry.chunks.push(chunk); blobs.set(event.data, { entry, chunk });
      }
      return Reflect.apply(handler, this, [event]);
    };
    this.addEventListener('start', event => { entry.startedAt = event.timeStamp; });
    this.addEventListener('stop', event => { entry.stoppedAt = event.timeStamp; });
    return Reflect.apply(originalStart, this, args);
  };
  Blob.prototype.arrayBuffer = function (...args) {
    const owner = blobs.get(this);
    if (owner) {
      const { entry, chunk } = owner;
      if (chunk.index > entry.lastConversionIndex + 1 || chunk.index < entry.lastConversionIndex) errors.push('Non-serial source Blob conversion');
      if (chunk.index === entry.lastConversionIndex + 1) {
        entry.acknowledgedCount = chunk.index;
        entry.lastConversionIndex = chunk.index;
      }
      chunk.conversionStartedAt ??= performance.now();
    }
    return Reflect.apply(originalArrayBuffer, this, args);
  };
  window.__nativeCrashEvidence = { snapshot: () => ({ at: performance.now(), acquisitions: acquisitions.map(ids => [...ids]), errors: [...errors],
    acknowledgementBasis: 'Lower bound: starting the next Blob conversion proves the previous serial save acknowledged successfully.',
    records: records.map(({ recorder, ...entry }) => ({ ...entry, trackIds: [...entry.trackIds],
      chunks: entry.chunks.map(chunk => ({ ...chunk })), state: recorder.state })) }),
  dispose: () => {
    MediaRecorder.prototype.start = originalStart; Blob.prototype.arrayBuffer = originalArrayBuffer;
    navigator.mediaDevices.getUserMedia = originalAcquire; window.AudioContext = NativeContext;
    if (originalWebkit === NativeContext) window.webkitAudioContext = originalWebkit;
  } };
}

async function snapshotNativeSources(recordingDir, acknowledgedCounts = null) {
  assertSyntheticPath(recordingDir);
  const result = [];
  for (const source of inspectNativeSources(recordingDir)) {
    if (source.gaps.length || source.terminalMismatch) throw new Error('Native source sequence is incomplete');
    const limit = acknowledgedCounts ? acknowledgedCounts[source.sourceId] : source.chunkCount;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > source.chunkCount) throw new Error('Missing acknowledged native source prefix');
    const files = async filenames => Promise.all(filenames.map(async filename => ({
      relativePath: path.relative(recordingDir, filename).replaceAll('\\', '/'), bytes: fs.statSync(filename).size, sha256: await sha256(filename),
    })));
    const chunks = await files(source.chunkPaths.slice(0, limit));
    result.push({ sourceId: source.sourceId, kind: source.kind, startOffsetMs: source.startOffsetMs,
      started: source.started, interrupted: source.interrupted,
      metadata: await files([source.manifestPath, source.startedPath, source.endPath].filter(Boolean)),
      chunks: chunks.map((chunk, index) => ({ ...chunk, sourceId: source.sourceId, index })) });
  }
  return result;
}

function compareNativeSources(expected, actual, allowAdditionalChunks = true) {
  const problems = [], byId = new Map();
  for (const source of actual) {
    if (byId.has(source.sourceId)) problems.push('Duplicate native source ID ' + source.sourceId);
    byId.set(source.sourceId, source);
    for (let index = 0; index < source.chunks.length; index++) {
      const chunk = source.chunks[index];
      if (chunk.index !== index || chunk.sourceId !== source.sourceId ||
          chunk.relativePath !== `native-sources/${source.sourceId}/chunks/chunk_${index}.webm`) problems.push('Invalid native source chunk identity ' + source.sourceId);
    }
  }
  if (actual.length !== expected.length) problems.push('Unexpected native source inventory change');
  for (const source of expected) {
    const current = byId.get(source.sourceId);
    if (!current) { problems.push('Previously durable native source disappeared: ' + source.sourceId); continue; }
    if (source.kind !== current.kind || source.startOffsetMs !== current.startOffsetMs ||
        JSON.stringify(source.metadata) !== JSON.stringify(current.metadata)) problems.push('Native source metadata changed: ' + source.sourceId);
    if (!allowAdditionalChunks && source.chunks.length !== current.chunks.length) problems.push('Recovery changed native chunk count: ' + source.sourceId);
    for (const chunk of source.chunks) {
      const retained = current.chunks[chunk.index];
      if (!retained || retained.relativePath !== chunk.relativePath || retained.sourceId !== chunk.sourceId ||
          retained.index !== chunk.index || retained.bytes !== chunk.bytes || retained.sha256 !== chunk.sha256) problems.push(`Native source chunk changed or disappeared: ${source.sourceId}/${chunk.index}`);
    }
  }
  return problems;
}

function nativeCrashMapping(snapshot, sources, expectedTimesliceMs = 1000) {
  const observed = snapshot?.nativeCapture;
  const native = observed?.records?.filter(record => record.role === 'native-microphone') || [];
  const mixed = observed?.records?.filter(record => record.role === 'live-mix') || [];
  if (observed?.errors?.length || observed?.acquisitions?.length !== 1 || observed.acquisitions[0].length !== 1 ||
      observed.records.length !== 2 || native.length !== 1 || mixed.length !== 1 || sources.length !== 1 ||
      sources[0].kind !== 'microphone' || !sources[0].started || !sources[0].interrupted ||
      !Number.isFinite(sources[0].startOffsetMs) || sources[0].startOffsetMs < 0 || sources[0].startOffsetMs > 25) {
    throw new Error('Native s15 requires exactly one initial microphone epoch and one live mix; extra sources or ambiguous mappings are not qualified');
  }
  const recorder = native[0];
  if (observed.records.some(record => record.state !== 'recording' || record.startedAt === null ||
      !Number.isFinite(record.startCalledAt) || record.timesliceMs !== expectedTimesliceMs)) throw new Error('Unexpected native crash recorder lifecycle or timeslice');
  if (recorder.trackIds[0] !== observed.acquisitions[0][0] || !Number.isSafeInteger(recorder.acknowledgedCount) ||
      recorder.acknowledgedCount < 0 || recorder.acknowledgedCount > recorder.chunks.length - 1) throw new Error('Missing conservative native acknowledgement evidence');
  return { sourceId: sources[0].sourceId, kind: sources[0].kind, startOffsetMs: sources[0].startOffsetMs,
    recorder, at: observed.at, acknowledgementBasis: observed.acknowledgementBasis,
    acknowledgedCount: recorder.acknowledgedCount };
}

function compareNativeRecoveredContent(original, recovered, startOffsetS = 0, toleranceS = 0.1) {
  const problems = [], target = new Map();
  for (const group of recovered.groups || []) {
    if (target.has(group.id)) problems.push('Repeated recovered marker ' + group.id);
    target.set(group.id, group);
  }
  const interior = (original.groups || []).slice(1, -1), differences = [];
  if (interior.length < 3) problems.push('Insufficient native source interior marker evidence');
  let previous = -Infinity;
  for (const group of interior) {
    const final = target.get(group.id);
    if (!final) { problems.push('Recovered output omitted durable native marker ' + group.id); continue; }
    if (final.start <= previous) problems.push('Recovered native markers are reordered');
    previous = final.start;
    const difference = (final.start + final.end - group.start - group.end) / 2 - startOffsetS;
    differences.push(difference);
    if (Math.abs(difference) > toleranceS + 1e-9) problems.push('Recovered native marker moved on the active timeline: ' + group.id);
  }
  return { problems, requiredInteriorIds: interior.map(group => group.id), toleranceS,
    maxAbsoluteTimingDifferenceS: differences.length ? Math.max(...differences.map(Math.abs)) : null };
}

function nativeAssemblyProblems(receipt, plan, sources) {
  const problems = [], ids = sources.map(source => source.sourceId).sort();
  const covers = actual => Array.isArray(actual) && JSON.stringify([...actual].sort()) === JSON.stringify(ids);
  if (receipt?.version !== 3 || receipt.sourceMode !== 'native' || receipt.recovered !== true ||
      receipt.systemPcmIncluded !== false || !covers(receipt.sourceIds)) problems.push('Recovered native output lacks a complete v3 source receipt');
  if (plan?.version !== 1 || plan.recovery !== true || plan.codecPolicy !== 'opus-cbr-192k-20ms-reencoded-from-native-sources' ||
      plan.systemPcmIncluded !== false || !covers(plan.sourceIds) || plan.onsetIsApproximate !== true ||
      plan.sampleRate !== 48000 || !Number.isSafeInteger(plan.totalSamples) || plan.totalSamples <= 0) {
    problems.push('Recovered native output lacks the explicit re-encoding and active-timeline assembly policy');
  }
  return problems;
}

function nativeEndpointCoverage(audio, toleranceS = 1.5) {
  const { durationS, firstIdentifiedStartS, lastIdentifiedEndS } = audio || {};
  if (![durationS, firstIdentifiedStartS, lastIdentifiedEndS].every(Number.isFinite) ||
      firstIdentifiedStartS < 0 || lastIdentifiedEndS < firstIdentifiedStartS || lastIdentifiedEndS > durationS) {
    return { problems: ['Missing measured native prefix boundary positions'] };
  }
  const leadingUnidentifiedS = firstIdentifiedStartS, trailingUnidentifiedS = durationS - lastIdentifiedEndS;
  return { leadingUnidentifiedS, trailingUnidentifiedS, toleranceS,
    problems: [...(leadingUnidentifiedS > toleranceS ? ['Recovered native prefix begins with excessive unidentified audio'] : []),
      ...(trailingUnidentifiedS > toleranceS ? ['Recovered native prefix ends with excessive unidentified audio'] : [])] };
}

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
    const signalReturnedAtMs = performance.now();
    const exit = await exited;
    const exitObservedAtMs = performance.now();
    app.proc = null; // Never let later cleanup target a recycled operating-system PID.
    return { pid, platform, method: platform === 'win32' ? 'taskkill /T /F' : 'process-group SIGKILL', ...exit,
      requestAtMs: started, signalReturnedAtMs, exitObservedAtMs, elapsedMs: exitObservedAtMs - started };
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
      chunkSaveErrors: state?.chunkSaveErrors, capture: window.__suisseCaptureDiagnostics?.snapshot(),
      nativeCapture: window.__nativeCrashEvidence?.snapshot() || null };
  });
}

async function bracketRecordingSnapshot(app, clock = () => performance.now()) {
  const requestAtMs = clock();
  const snapshot = await recordingSnapshot(app);
  return { snapshot, requestAtMs, responseAtMs: clock() };
}

function observationExitEvidence(observation, exitAtMs) {
  const { requestAtMs, responseAtMs } = observation;
  if (![requestAtMs, responseAtMs, exitAtMs].every(Number.isFinite) ||
      requestAtMs < 0 || responseAtMs < requestAtMs || exitAtMs < responseAtMs) {
    throw new Error('Missing or invalid snapshot request/response/exit timing');
  }
  // The renderer samples between request and response on a different clock.
  // Starting at response omits an unknown part of the CDP round trip; starting
  // at request safely includes it without equating the two clock origins.
  return { requestAtMs, responseAtMs, exitAtMs,
    roundTripSeconds: (responseAtMs - requestAtMs) / 1000,
    responseToExitSeconds: (exitAtMs - responseAtMs) / 1000,
    requestToExitUpperSeconds: (exitAtMs - requestAtMs) / 1000 };
}

async function visibleHistory(app, recordId) {
  return app.evalTimed(rid => {
    const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
    const recordings = pinia?.state?.value?.['recordings-history']?.recordings || pinia?.state?.value?.recordingsHistory?.recordings || [];
    const recording = recordings.find(item => item.id === rid);
    const card = document.querySelector(`[data-test="history-expand"][data-record-id="${rid}"]`)?.closest('.history-card');
    const box = card?.getBoundingClientRect();
    return { id: recording?.id, recovered: recording?.recovered === true, uploadStatus: recording?.uploadStatus,
      audioFileId: recording?.audioFileId, visible: !!box?.width && !!box?.height, text: card?.textContent?.trim().slice(0, 500) || null };
  }, recordId);
}

function parseCrashOptions(opts = {}) {
  const seconds = opts.seconds ?? 50;
  if (!Number.isFinite(seconds) || seconds < 45 || seconds > 60) throw new Error('Crash qualification requires 45–60 real capture seconds');
  const expectedTimesliceMs = opts.expectedTimesliceMs ?? null;
  if (expectedTimesliceMs !== null && (!Number.isInteger(expectedTimesliceMs) || expectedTimesliceMs <= 0)) throw new Error('Expected timeslice must be a positive integer in milliseconds');
  const maxTailExposureS = opts.maxTailExposureS ?? 4.5;
  if (!Number.isFinite(maxTailExposureS) || maxTailExposureS < 0) throw new Error('Maximum tail exposure must be a finite nonnegative number of seconds');
  // The requested crash time may be fractional; the coded reference itself
  // must still contain complete half-second identities and enough spare audio.
  const referenceSeconds = Math.ceil((seconds + 25) * 2) / 2;
  return { seconds, expectedTimesliceMs, maxTailExposureS, referenceSeconds };
}

function captureTimingEvidence(snapshot, expectedTimesliceMs = null) {
  const capture = snapshot?.capture, native = capture?.recorders?.at(-1);
  const observedTimesliceMs = Number.isFinite(native?.requestedTimesliceMs) ? native.requestedTimesliceMs : null;
  const nativeElapsedS = Number.isFinite(capture?.at) && Number.isFinite(native?.startedAt)
    ? (capture.at - native.startedAt) / 1000 : null;
  const lastDataAgeS = Number.isFinite(capture?.at) && Number.isFinite(native?.lastDataAt)
    ? (capture.at - native.lastDataAt) / 1000 : null;
  const startCallElapsedS = Number.isFinite(capture?.at) && Number.isFinite(native?.startCalledAt)
    ? (capture.at - native.startCalledAt) / 1000 : null;
  const problems = [];
  if (expectedTimesliceMs !== null && observedTimesliceMs !== expectedTimesliceMs) {
    problems.push(`Observed MediaRecorder timeslice ${observedTimesliceMs === null ? 'unavailable' : observedTimesliceMs + 'ms'} differs from expected ${expectedTimesliceMs}ms`);
  }
  return { observedTimesliceMs, startCalledAt: native?.startCalledAt ?? null,
    successfulStartCalls: native?.successfulStartCalls ?? null, nativeElapsedS, startCallElapsedS,
    startEventDelayS: startCallElapsedS !== null && nativeElapsedS !== null ? startCallElapsedS - nativeElapsedS : null,
    lastDataAgeS, problems };
}

function calculateTailExposure({ nativeSecondsAtLastObservation, startCallSecondsAtLastObservation,
  acknowledgedAudioSeconds, durableAudioSeconds, observationToExitSeconds }) {
  for (const value of [nativeSecondsAtLastObservation, startCallSecondsAtLastObservation,
    acknowledgedAudioSeconds, durableAudioSeconds, observationToExitSeconds]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Missing or invalid crash timing/prefix duration');
  }
  if (acknowledgedAudioSeconds > durableAudioSeconds + 1e-9) throw new Error('Acknowledged prefix exceeds the surviving audio');
  if (nativeSecondsAtLastObservation > startCallSecondsAtLastObservation + 1e-9) throw new Error('Native start event precedes its observed start call');
  const callToAcknowledgedDeficitS = Math.max(0, startCallSecondsAtLastObservation - acknowledgedAudioSeconds);
  const callToRecoveredDeficitIncludingTerminationS = Math.max(0, startCallSecondsAtLastObservation + observationToExitSeconds - durableAudioSeconds);
  return { nativeSecondsAtLastObservation, startCallSecondsAtLastObservation, acknowledgedAudioSeconds, durableAudioSeconds,
    // onstart is queued asynchronously and can be raised after capture begins.
    // Use the earlier start() call for conservative primary estimates; this
    // includes initialization/dispatch uncertainty, not proven missing audio.
    startEventDelayS: startCallSecondsAtLastObservation - nativeSecondsAtLastObservation,
    timingBasis: 'Conservative start-call deficit; includes initialization uncertainty, not exact lost audio.',
    callToAcknowledgedDeficitS, callToRecoveredDeficitIncludingTerminationS,
    // Keep legacy result keys readable by existing evidence summaries.
    notYetDurableSecondsAtLastObservation: callToAcknowledgedDeficitS,
    tailUpperBoundIncludingTerminationDelayS: callToRecoveredDeficitIncludingTerminationS,
    eventClockUnacknowledgedEstimateS: Math.max(0, nativeSecondsAtLastObservation - acknowledgedAudioSeconds),
    eventClockTailUpperEstimateS: Math.max(0, nativeSecondsAtLastObservation + observationToExitSeconds - durableAudioSeconds) };
}

function tailExposureProblems(exposure, maxTailExposureS = 4.5) {
  if (!Number.isFinite(exposure?.notYetDurableSecondsAtLastObservation)) return ['Missing conservative call-to-acknowledged deficit'];
  return exposure.notYetDurableSecondsAtLastObservation > maxTailExposureS
    ? [`Conservative call-to-acknowledged deficit exceeded the configured ${maxTailExposureS}-second test budget`] : [];
}

async function runMainCrashQualification(opts = {}) {
  const { seconds, expectedTimesliceMs, maxTailExposureS, referenceSeconds } = parseCrashOptions(opts);
  const appDir = opts.appDir || process.env.SUISSE_E2E_APP_DIR;
  if (!appDir) throw new Error('Crash qualification requires an isolated compiled Electron bundle');
  const name = 's15-main-crash-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8);
  const evidenceDir = assertSyntheticPath(path.join(WORK_DIR, 'qualification', name));
  fs.mkdirSync(evidenceDir, { recursive: true });
  const summaryPath = path.join(evidenceDir, 'summary.json');
  const result = { name, pass: false, problems: [], notes: [
    'Abrupt whole-app process termination; no graceful stop or renderer-only crash.',
    'Only audio that reached durable storage can survive this crash. No audio is expected during process downtime.',
    'Requested seconds begin after UI recording readiness. Prefix hashing and process termination add delay; fractional requests do not control an exact native recording phase.',
    'Primary exposure uses the observed start() call and the separately decoded acknowledged prefix. Start-event and initialization delays are uncertainty, not proven capture loss.',
    'Termination timing includes the full snapshot request/response interval. Older evidence without observationTiming has an unknown response gap and cannot supply this upper bound.',
    'Synthetic microphone and localhost upload; physical devices, power-loss disk caches, and production backend acceptance are outside this test.',
  ], requestedSeconds: seconds, expectedTimesliceMs, maxTailExposureS, referenceSeconds, progress: [], evidenceDir, summaryPath };
  const checkpoint = stage => {
    result.stage = stage; result.updatedAt = new Date().toISOString();
    const fd = fs.openSync(summaryPath, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(result, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  let first = null, recovered = null, mock = null, nativeMode = false;
  try {
    checkpoint('preparing-reference');
    const reference = buildCodedScenario(name, [{ type: 'speech', seconds: referenceSeconds }]);
    result.reference = reference.metaPath;
    mock = await startMockBackend({ port: opts.mockPort || 3000 });
    first = new AppDriver({ name, appDir, apiUrl: mock.url, fakeAudioWav: reference.wavPath, env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
    result.profile = first.userDataDir;
    checkpoint('launching');
    await first.launch(); await first.login();
    if (await first.evalTimed(() => window.electronAPI.config.getApiUrl()) !== mock.url) throw new Error('Crash qualification must use only the local backend');
    result.bundleSha = opts.bundleSha || process.env.SUISSE_E2E_BUNDLE_SHA || null;
    result.profile = first.userDataDir; result.beforeDiagnostics = first.diagnosticsDir;
    nativeMode = await first.evalTimed(() => typeof window.electronAPI.recording.beginSource === 'function');
    result.captureMode = nativeMode ? 'native-sources-v1' : 'legacy-live-mix';
    if (nativeMode) {
      result.nativeMaxTailExposureS = Math.min(maxTailExposureS, 2.5);
      result.nativeExpectedTimesliceMs = expectedTimesliceMs ?? 1000;
      result.notes.push('Native qualification is bounded to one microphone epoch; no system audio or source transitions. Concurrent source durations are never summed.');
      result.notes.push('The native acknowledged prefix is a lower bound: next Blob conversion proves the preceding serial save returned success; the latest completed save may be deliberately excluded.');
      result.sourceWriterProvenance = ['src/services/recordingChunkWriter.js', 'src/services/nativeSourceRecorder.js'].map(filename => ({
        path: filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../..', filename))).digest('hex'),
      }));
      await first.page.evaluate(installNativeCrashObserver);
    }
    await first.startRecording();
    const started = performance.now();
    while (performance.now() - started < seconds * 1000) {
      const state = await recordingSnapshot(first);
      result.recordId = state.recordId;
      result.progress.push({ elapsedS: (performance.now() - started) / 1000, ...state });
      checkpoint('recording');
      if (state.phase !== 'recording') throw new Error('Capture left recording phase before crash injection');
      await sleep(Math.min(5000, Math.max(1, seconds * 1000 - (performance.now() - started))));
    }
    let before, chunks, observation, nativeMapping, acknowledgedNative;
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await recordingSnapshot(first);
      if (!/^[a-f0-9-]{36}$/i.test(state.recordId || '')) throw new Error('Invalid synthetic recording ID');
      result.recordId = state.recordId;
      const recordingDir = assertSyntheticPath(path.join(first.recordingsDir, state.recordId));
      if (nativeMode) {
        const mapping = nativeCrashMapping(state, inspectNativeSources(recordingDir), result.nativeExpectedTimesliceMs);
        acknowledgedNative = await snapshotNativeSources(recordingDir, { [mapping.sourceId]: mapping.acknowledgedCount });
      } else chunks = await snapshotChunks(recordingDir, state.acknowledgedChunks);
      observation = await bracketRecordingSnapshot(first);
      before = observation.snapshot;
      if (nativeMode) {
        nativeMapping = nativeCrashMapping(before, acknowledgedNative, result.nativeExpectedTimesliceMs);
        if (nativeMapping.acknowledgedCount === acknowledgedNative[0].chunks.length) break;
      } else if (before.acknowledgedChunks === state.acknowledgedChunks) break;
      before = null;
    }
    if (!before || before.phase !== 'recording' || before.chunkSaveErrors || (nativeMode
      ? acknowledgedNative[0].chunks.length < 5
      : chunks.length < 5 || chunks.length !== before.acknowledgedChunks)) {
      throw new Error('Could not establish a stable, acknowledged durable prefix before the crash');
    }
    result.beforeCrash = before;
    if (nativeMode) {
      result.acknowledgedNativeSources = acknowledgedNative;
      result.nativeSourceMapping = nativeMapping;
      for (const chunk of acknowledgedNative[0].chunks) {
        if (nativeMapping.recorder.chunks[chunk.index]?.bytes !== chunk.bytes) throw new Error('Acknowledged native Blob size differs from its source file');
      }
    } else {
      result.acknowledgedChunks = chunks;
      result.captureTiming = captureTimingEvidence(before, expectedTimesliceMs);
      result.problems.push(...result.captureTiming.problems);
    }
    const recordingDir = assertSyntheticPath(path.join(first.recordingsDir, result.recordId));
    if (first.findOutputFile()) throw new Error('An output already existed before the abrupt crash');
    checkpoint('durable-prefix-established');
    result.crash = await killOwnedApp(first);
    result.observationTiming = observationExitEvidence(observation, performance.now());
    result.observationToExitSeconds = result.observationTiming.requestToExitUpperSeconds;
    await first.close({ keepProfile: true });
    if (nativeMode) result.nativeCrashSurvivors = await snapshotNativeSources(recordingDir);
    else result.crashSurvivors = await snapshotChunks(recordingDir);
    const survivorProblems = nativeMode ? compareNativeSources(acknowledgedNative, result.nativeCrashSurvivors)
      : compareChunks(chunks, result.crashSurvivors);
    result.problems.push(...survivorProblems);
    if (survivorProblems.length) throw new Error('An acknowledged source did not survive full process termination');
    const rawPrefix = assertSyntheticPath(path.join(evidenceDir, 'crash-durable-prefix.webm'));
    const survivingChunks = nativeMode ? result.nativeCrashSurvivors[0].chunks : result.crashSurvivors;
    const acknowledgedChunks = nativeMode ? acknowledgedNative[0].chunks : chunks;
    await concatenateFiles(survivingChunks.map(chunk => path.join(recordingDir, chunk.relativePath)), rawPrefix);
    result.rawPrefix = rawPrefix;
    // A chunk may finish writing after the last acknowledgement snapshot but
    // before termination. It belongs in recovery, not in the earlier snapshot.
    const acknowledgedIndices = new Set(acknowledgedChunks.map(chunk => chunk.index));
    const acknowledgedSources = survivingChunks.filter(chunk => acknowledgedIndices.has(chunk.index));
    if (acknowledgedSources.length !== acknowledgedChunks.length) throw new Error('Missing acknowledged source for timing verification');
    const acknowledgedPrefix = acknowledgedSources.length === survivingChunks.length ? rawPrefix
      : assertSyntheticPath(path.join(evidenceDir, 'acknowledged-prefix.webm'));
    if (acknowledgedPrefix !== rawPrefix) await concatenateFiles(acknowledgedSources.map(chunk => path.join(recordingDir, chunk.relativePath)), acknowledgedPrefix);
    result.acknowledgedPrefix = acknowledgedPrefix;
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
    if (nativeMode) {
      result.retainedNativeSources = await snapshotNativeSources(recordingDir);
      result.problems.push(...compareNativeSources(result.nativeCrashSurvivors, result.retainedNativeSources, false));
    } else {
      result.retainedChunks = await snapshotChunks(recordingDir);
      result.problems.push(...compareChunks(result.crashSurvivors, result.retainedChunks));
      if (result.retainedChunks.length !== result.crashSurvivors.length) result.problems.push('Recovery unexpectedly added source chunks without recording new audio');
    }

    await recovered.navigate('/history');
    const historyDeadline = performance.now() + 15000;
    do { result.history = await visibleHistory(recovered, result.recordId); if (result.history.visible && result.history.uploadStatus === 'uploaded') break; await sleep(500); }
    while (performance.now() < historyDeadline);
    if (!result.history.visible || !result.history.recovered || result.history.uploadStatus !== 'uploaded') result.problems.push('Recovered, uploaded recording is not visible in its history card');
    result.screenshot = await recovered.screenshot(name + '-recovered-history');
    checkpoint('verifying-durable-prefix');
    if (nativeMode) {
      const finalReceipt = JSON.parse(fs.readFileSync(path.join(recordingDir, 'finalized.json'), 'utf8'));
      const plans = fs.readdirSync(recordingDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('native-finalization-'))
        .map(entry => path.join(recordingDir, entry.name, 'plan.json')).filter(filename => fs.existsSync(filename));
      if (plans.length !== 1) throw new Error('Expected exactly one completed native recovery assembly plan');
      const plan = JSON.parse(fs.readFileSync(plans[0], 'utf8'));
      result.nativeAssembly = { receipt: finalReceipt, plan, planPath: plans[0], planSha256: await sha256(plans[0]),
        codecPolicy: plan.codecPolicy, exactDecodedPcmEqualityRequired: false,
        equalityPolicy: 'Retained original source bytes must remain exact; the explicitly re-encoded final must preserve source identities and active-time positions.' };
      result.problems.push(...nativeAssemblyProblems(finalReceipt, plan, result.nativeCrashSurvivors));
      if (fs.existsSync(path.join(recordingDir, 'finalization-pending.json')) || finalReceipt.sha256 !== result.upload.localSha256) result.problems.push('Native recovery has not published its complete output transaction');
      await recovered.close({ keepProfile: true });
      result.originalPcm = await decodedFingerprint(rawPrefix);
      result.acknowledgedPcm = acknowledgedPrefix === rawPrefix ? result.originalPcm : await decodedFingerprint(acknowledgedPrefix);
      result.nativePrefixArtifacts = { sourceId: nativeMapping.sourceId, rawPrefix, rawSha256: await sha256(rawPrefix),
        acknowledgedPrefix, acknowledgedSha256: await sha256(acknowledgedPrefix) };
      const sourceAnalysis = await analyzeCodedAudio(rawPrefix), finalAnalysis = await analyzeCodedAudio(output);
      result.nativeContent = compareNativeRecoveredContent(sourceAnalysis, finalAnalysis, nativeMapping.startOffsetMs / 1000);
      result.problems.push(...result.nativeContent.problems);
      fs.writeFileSync(path.join(evidenceDir, 'native-source-analysis.json'), JSON.stringify(sourceAnalysis, null, 2));
      fs.writeFileSync(path.join(evidenceDir, 'recovered-final-analysis.json'), JSON.stringify(finalAnalysis, null, 2));
      result.nativeSourceAudio = await verifyCodedAudio(rawPrefix, reference);
      result.problems.push(...result.nativeSourceAudio.problems.map(problem => 'Native source: ' + problem));
      // This fixture has one epoch and no intended gaps. Use its surviving
      // source extent, never add simultaneous source durations or UI downtime.
      result.audio = await verifyCodedAudio(output, reference, { expectedDurationS: result.originalPcm.durationS + nativeMapping.startOffsetMs / 1000, durationToleranceS: 0.03 });
      result.problems.push(...result.audio.problems);
      result.endpointCoverage = nativeEndpointCoverage(result.audio);
      result.problems.push(...result.endpointCoverage.problems);
      const recorder = nativeMapping.recorder;
      const exposure = { sourceId: nativeMapping.sourceId, kind: nativeMapping.kind,
        ...calculateTailExposure({ nativeSecondsAtLastObservation: (nativeMapping.at - recorder.startedAt) / 1000,
          startCallSecondsAtLastObservation: (nativeMapping.at - recorder.startCalledAt) / 1000,
          acknowledgedAudioSeconds: result.acknowledgedPcm.durationS, durableAudioSeconds: result.originalPcm.durationS,
          observationToExitSeconds: result.observationToExitSeconds }),
        acknowledgementBasis: nativeMapping.acknowledgementBasis, acknowledgedChunkCount: acknowledgedChunks.length,
        nativeEventsAtLastObservation: recorder.events, nativeBytesAtLastObservation: recorder.bytes,
        acknowledgedBytes: acknowledgedChunks.reduce((total, chunk) => total + chunk.bytes, 0),
        crashSurvivingBytes: survivingChunks.reduce((total, chunk) => total + chunk.bytes, 0) };
      result.nativeTailExposures = [exposure];
      result.problems.push(...tailExposureProblems(exposure, result.nativeMaxTailExposureS).map(problem => `${nativeMapping.sourceId}: ${problem}`));
      if (exposure.tailUpperBoundIncludingTerminationDelayS > result.nativeMaxTailExposureS) result.problems.push('Native source conservative termination-inclusive deficit exceeded the configured ' + result.nativeMaxTailExposureS + '-second test budget');
      result.notes.push('Each source is assessed independently; this single-microphone fixture does not qualify simultaneous microphone/system alignment or device replacement.');
    } else {
    // Preserve the historical legacy/remux PCM equality oracle verbatim. Native
    // re-encoding has its own explicit source-custody and content oracle above.
    result.originalPcm = await decodedFingerprint(rawPrefix);
    result.acknowledgedPcm = acknowledgedPrefix === rawPrefix ? result.originalPcm : await decodedFingerprint(acknowledgedPrefix);
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
    result.tailExposure = { ...calculateTailExposure({
      nativeSecondsAtLastObservation: (before.capture.at - native.startedAt) / 1000,
      startCallSecondsAtLastObservation: result.captureTiming.startCallElapsedS,
      acknowledgedAudioSeconds: result.acknowledgedPcm.durationS,
      durableAudioSeconds: result.originalPcm.durationS, observationToExitSeconds: result.observationToExitSeconds }),
      acknowledgedChunkCount: chunks.length,
      nativeEventsAtLastObservation: native.events, nativeBytesAtLastObservation: native.bytes,
      acknowledgedBytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0), crashSurvivingBytes: result.crashSurvivors.reduce((total, chunk) => total + chunk.bytes, 0) };
    result.problems.push(...tailExposureProblems(result.tailExposure, maxTailExposureS));
    }
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

module.exports = { runMainCrashQualification, killOwnedApp, snapshotChunks, compareChunks, prefixEndpointCoverage, assertSyntheticPath,
  parseCrashOptions, captureTimingEvidence, tailExposureProblems, calculateTailExposure, bracketRecordingSnapshot, observationExitEvidence,
  installNativeCrashObserver, snapshotNativeSources, compareNativeSources, nativeCrashMapping, compareNativeRecoveredContent,
  nativeAssemblyProblems, nativeEndpointCoverage };
