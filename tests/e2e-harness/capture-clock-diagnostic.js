'use strict';
// Same-source measurement: a successful diagnostic does not qualify five hours.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { startBufferTrace, summarizeTrace } = require('./lib/capture-buffer-trace');
const { classifyWitnessRecorders, legacyChunkFiles } = require('./lib/native-recorder-evidence');
const { concatenateFiles } = require('../../src-electron/durable-files');
const ROOT = path.resolve(__dirname, '../..');
const WORK = path.join(__dirname, 'work');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2));

function inventory(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return inventory(filename, base);
    if (!entry.isFile()) throw new Error('Unexpected bundle link: ' + filename);
    return [{ path: path.relative(base, filename).replaceAll('\\', '/'), sha256: hash(fs.readFileSync(filename)) }];
  });
}

function provenance(appDirectory, applicationBuildCommit) {
  const executable = require('electron');
  return { appDirectory, applicationBuildCommit, platform: process.platform, architecture: process.arch,
    currentHarnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim(),
    compiledFiles: inventory(appDirectory), electron: require('electron/package.json').version,
    electronSha256: hash(fs.readFileSync(executable)),
    inputs: Object.fromEntries([__filename, path.join(ROOT, 'package-lock.json'),
      path.join(__dirname, 'lib/app-driver.js'), path.join(__dirname, 'lib/coded-audio.js'), path.join(__dirname, 'lib/mock-backend.js'),
      path.join(__dirname, 'lib/capture-buffer-trace.js'),
      path.join(__dirname, 'lib/native-recorder-evidence.js'), path.join(ROOT, 'src-electron/durable-files.js'),
      require('@ffmpeg-installer/ffmpeg').path].map(file => [path.relative(ROOT, file).replaceAll('\\', '/'), hash(fs.readFileSync(file))])) };
}

function verifyUnchanged(before) {
  const after = provenance(before.appDirectory, before.applicationBuildCommit);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Bundle, runtime, or harness changed during diagnostic');
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

// This function executes only in the synthetic app renderer.
function installWitness({ processingDisabled }) {
  if (window.__directMixedWitness) throw new Error('Witness already installed');
  const devices = navigator.mediaDevices;
  const originalGet = devices.getUserMedia;
  const originalStart = MediaRecorder.prototype.start;
  const originalContext = window.AudioContext;
  const originalWebkit = window.webkitAudioContext;
  const contexts = [], recorders = [], acquisitions = [], errors = [], blobs = [];
  const witnessRecorders = new WeakSet();
  let direct = null, clone = null, directBytes = 0, disposed = false, witnessDeadline = null, directStopPromise = null;
  const maxBytes = 16 * 1024 * 1024;
  const noteError = error => { if (errors.length < 20) errors.push(String(error?.message || error)); };
  const snapshot = () => ({ at: performance.now(), visibility: document.visibilityState,
    acquisitions: acquisitions.map(entry => ({ ...entry })), errors: [...errors], directBytes, directChunks: blobs.length,
    contexts: contexts.map(entry => ({ id: entry.id, createdAt: entry.createdAt, currentTime: entry.ref.currentTime,
      sampleRate: entry.ref.sampleRate, state: entry.ref.state, destinationTrackIds: [...entry.destinationTrackIds], states: [...entry.states] })),
    recorders: recorders.map(entry => ({ role: entry.role, startCalledAt: entry.startCalledAt, startedAt: entry.startedAt,
      stoppedAt: entry.stoppedAt, timesliceMs: entry.timesliceMs, bytes: entry.bytes, events: entry.events, emptyEvents: entry.emptyEvents,
      trackIds: entry.trackIds, state: entry.ref.state, lifecycle: [...entry.lifecycle] })) });
  const ContextProxy = new Proxy(originalContext, {
    construct(target, args, newTarget) {
      const context = Reflect.construct(target, args, newTarget);
      const entry = { id: contexts.length + 1, ref: context, createdAt: performance.now(), destinationTrackIds: [], states: [] };
      contexts.push(entry);
      const originalDestination = context.createMediaStreamDestination;
      context.createMediaStreamDestination = function (...destinationArgs) {
        const destination = Reflect.apply(originalDestination, this, destinationArgs);
        entry.destinationTrackIds.push(...destination.stream.getAudioTracks().map(track => track.id));
        return destination;
      };
      context.addEventListener('statechange', () => {
        if (entry.states.length < 100) entry.states.push({ at: performance.now(), state: context.state, currentTime: context.currentTime });
      });
      return context;
    },
  });
  window.AudioContext = ContextProxy;
  if (originalWebkit === originalContext) window.webkitAudioContext = ContextProxy;
  MediaRecorder.prototype.start = function (...args) {
    const entry = { ref: this, role: witnessRecorders.has(this) ? 'direct-witness' : 'actual-application', startCalledAt: performance.now(),
      startedAt: null, stoppedAt: null, timesliceMs: args[0], bytes: 0, events: 0, emptyEvents: 0, trackIds: this.stream.getAudioTracks().map(track => track.id), lifecycle: [] };
    recorders.push(entry);
    for (const eventName of ['start', 'dataavailable', 'stop', 'pause', 'resume', 'error']) {
      this.addEventListener(eventName, event => {
        if (eventName === 'start') entry.startedAt = event.timeStamp;
        if (eventName === 'stop') entry.stoppedAt = event.timeStamp;
        if (eventName === 'dataavailable') { entry.bytes += event.data?.size || 0; entry.events++; if (!event.data?.size) entry.emptyEvents++; }
        else if (entry.lifecycle.length < 50) entry.lifecycle.push({ event: eventName, at: performance.now(), eventTimeStamp: event.timeStamp, error: event.error?.name || null });
      });
    }
    return Reflect.apply(originalStart, this, args);
  };
  const stopDirect = async () => {
    if (!direct) return;
    if (direct.state !== 'inactive') direct.stop();
    await Promise.race([directStopPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('Direct witness final event timeout')), 10000))]);
    clone?.getTracks().forEach(track => track.stop());
    clearTimeout(witnessDeadline);
  };
  devices.getUserMedia = async function (constraints) {
    if (disposed) throw new Error('Diagnostic disposed');
    if (!constraints?.audio || constraints.video || constraints.audio?.mandatory?.chromeMediaSource) {
      noteError('Non-microphone capture attempt rejected'); throw new Error('Synthetic microphone only');
    }
    if (acquisitions.length) { noteError('A second native microphone acquisition was attempted'); throw new Error('Single-source diagnostic cannot reacquire'); }
    const requested = processingDisabled ? { ...constraints, audio: { ...(typeof constraints.audio === 'object' ? constraints.audio : {}),
      echoCancellation: false, noiseSuppression: false, autoGainControl: false } } : constraints;
    const acquisition = { requestedAt: performance.now(), receivedAt: null, requestedAudio: requested.audio, settings: [], sourceTrackIds: [], clonedTrackIds: [] };
    acquisitions.push(acquisition);
    const source = await Reflect.apply(originalGet, this, [requested]);
    acquisition.receivedAt = performance.now();
    acquisition.settings = source.getAudioTracks().map(track => track.getSettings());
    acquisition.sourceTrackIds = source.getAudioTracks().map(track => track.id);
    try {
      if (source.getAudioTracks().length !== 1) throw new Error('Expected exactly one native microphone track');
      clone = new MediaStream([source.getAudioTracks()[0].clone()]);
      acquisition.clonedTrackIds = clone.getAudioTracks().map(track => track.id);
      direct = new MediaRecorder(clone, { mimeType: 'audio/webm;codecs=opus' });
      witnessRecorders.add(direct);
      directStopPromise = new Promise(resolve => direct.addEventListener('stop', resolve, { once: true }));
      direct.addEventListener('error', event => noteError(event.error || 'Direct recorder error'));
      direct.addEventListener('dataavailable', event => {
        if (directBytes + event.data.size > maxBytes) {
          noteError('Direct witness exceeded 16 MiB memory cap');
          if (direct.state !== 'inactive') direct.stop();
          return;
        }
        blobs.push(event.data); directBytes += event.data.size;
      });
      direct.start(1000);
      witnessDeadline = setTimeout(() => { noteError('Direct witness reached five-minute cap'); void stopDirect().catch(noteError); }, 300000);
    } catch (error) { noteError(error); clone?.getTracks().forEach(track => track.stop()); }
    // Preserve the application's acquired stream and native recording behavior.
    return source;
  };
  window.__directMixedWitness = { snapshot, stopDirect,
    exportChunk: async index => {
      if (direct?.state !== 'inactive') throw new Error('Do not export or decode during capture');
      const blob = blobs[index]; if (!blob) throw new Error('Unknown witness chunk');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return { index, size: blob.size, type: blob.type, base64: btoa(binary) };
    },
    dispose: async () => {
      disposed = true;
      try { await stopDirect(); } finally {
        clearTimeout(witnessDeadline); clone?.getTracks().forEach(track => track.stop());
        devices.getUserMedia = originalGet; MediaRecorder.prototype.start = originalStart;
        window.AudioContext = originalContext; if (originalWebkit === originalContext) window.webkitAudioContext = originalWebkit;
      }
    },
  };
}

function compareGroups(direct, mixed) {
  const summary = { notes: ['Compare only common interior numbered source identities; recording endpoints differ.',
    'The direct witness adds native encoder workload. This is a diagnostic, not five-hour or hardware qualification.'], problems: [], alignedFrames: [] };
  if (!direct.groups.length || !mixed.groups.length) { summary.problems.push('Missing identifiable source groups'); return summary; }
  const first = Math.max(direct.groups[0].id, mixed.groups[0].id) + 1;
  const last = Math.min(direct.groups.at(-1).id, mixed.groups.at(-1).id) - 1;
  if (last - first < 10) { summary.problems.push('Insufficient common interior source interval'); return summary; }
  summary.commonSourceInterval = { firstFrame: first, lastFrame: last, startSourceSeconds: first * 0.5, endSourceSeconds: (last + 1) * 0.5 };
  for (const [role, analysis] of [['direct', direct], ['mixed', mixed]]) {
    let previous = null;
    for (const group of analysis.groups.filter(group => group.id >= first && group.id <= last)) {
      if (previous !== null && group.id < previous) summary.problems.push(`${role}: reordered source frame ${previous} followed by ${group.id}`);
      previous = group.id;
    }
  }
  const maps = [direct, mixed].map(analysis => {
    const map = new Map(); for (const group of analysis.groups) { if (!map.has(group.id)) map.set(group.id, []); map.get(group.id).push(group); } return map;
  });
  let baseline = null;
  for (let id = first; id <= last; id++) {
    const a = maps[0].get(id) || [], b = maps[1].get(id) || [];
    if (a.length !== 1 || b.length !== 1) { summary.problems.push(`Frame ${id}: direct groups=${a.length}, mixed groups=${b.length}`); continue; }
    const directCenterS = (a[0].start + a[0].end) / 2, mixedCenterS = (b[0].start + b[0].end) / 2;
    const mixedMinusDirectS = mixedCenterS - directCenterS; baseline ??= mixedMinusDirectS;
    summary.alignedFrames.push({ id, directCenterS, mixedCenterS, directSpanS: a[0].end - a[0].start,
      mixedSpanS: b[0].end - b[0].start, mixedMinusDirectS, relativeDriftFromFirstS: mixedMinusDirectS - baseline });
  }
  const drifts = summary.alignedFrames.map(frame => frame.relativeDriftFromFirstS);
  summary.maximumAbsoluteRelativeDriftS = drifts.length ? Math.max(...drifts.map(Math.abs)) : null;
  summary.lastRelativeDriftS = drifts.at(-1) ?? null;
  return summary;
}

function clockReadout(samples, finalSnapshot) {
  return finalSnapshot.contexts.map(context => {
    const points = samples.map(sample => { const point = sample.renderer.contexts.find(entry => entry.id === context.id);
      return point ? { performanceS: sample.renderer.at / 1000, currentTimeS: point.currentTime, state: point.state } : null; }).filter(Boolean);
    const first = points[0], last = points.at(-1);
    const appRecorder = finalSnapshot.recorders.find(recorder => recorder.role === 'actual-application' && recorder.trackIds.some(id => context.destinationTrackIds.includes(id)));
    return { id: context.id, isActualApplicationRecordingContext: !!appRecorder, destinationTrackIds: context.destinationTrackIds,
      sampleRate: context.sampleRate, points, intervalPerformanceS: last && first ? last.performanceS - first.performanceS : null,
      intervalAudioContextS: last && first ? last.currentTimeS - first.currentTimeS : null,
      performanceMinusContextS: last && first ? last.performanceS - first.performanceS - (last.currentTimeS - first.currentTimeS) : null };
  });
}

async function capture(directory, options, expectedProvenance) {
  const { AppDriver, sleep } = require(path.join(ROOT, 'tests/e2e-harness/lib/app-driver'));
  const { startMockBackend } = require(path.join(ROOT, 'tests/e2e-harness/lib/mock-backend'));
  const { buildCodedScenario, analyzeCodedAudio } = require(path.join(ROOT, 'tests/e2e-harness/lib/coded-audio'));
  class ClockDriver extends AppDriver {
    async observeRenderer(page) {
      await super.observeRenderer(page);
      const observer = this.rendererListeners.get(page);
      if (observer?.timer) { clearInterval(observer.timer); observer.timer = null; }
    }
  }
  const result = { diagnostic: 'same-native-source-direct-vs-actual-app-mixed', measurementCompleted: false, controlsValid: false,
    fiveHourQualificationPassed: false, productionBackendQualified: false, physicalHardwareQualified: false, options,
    provenance: expectedProvenance, samples: [], problems: [], notes: [
      'The actual app recorder remains unchanged; the direct native recorder tees a clone of its single acquired microphone.',
      'Synthetic microphone, local mock backend, no system audio or playback. All original app source chunks stay in the isolated profile.',
      'Witness buffers at most five minutes and 16 MiB; export and offline decoding occur only after both capture branches stop.',
      'The additional witness is an experimental workload. Passing this diagnostic is not production or five-hour qualification.',
    ] };
  const checkpoint = () => writeJson(path.join(directory, 'result.json'), result);
  let mock = null, app = null, trace = null;
  try {
    verifyUnchanged(expectedProvenance);
    const name = path.basename(path.dirname(directory)) + '-' + path.basename(directory);
    const reference = buildCodedScenario(name, [{ type: 'speech', seconds: options.seconds + 45 }], { outputDir: path.join(directory, 'reference') });
    result.reference = { ...reference, wavSha256: hash(fs.readFileSync(reference.wavPath)) };
    mock = await startMockBackend({ port: 3000 });
    if (mock.url !== 'http://127.0.0.1:3000' && mock.url !== 'http://localhost:3000') throw new Error('Unexpected local backend URL');
    app = new ClockDriver({ name, apiUrl: mock.url, appDir: expectedProvenance.appDirectory, cdpPort: await unusedPort(), fakeAudioWav: reference.wavPath,
      env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
    result.profile = app.userDataDir; checkpoint();
    await app.launch(); result.diagnostics = app.diagnosticsDir; result.ownedElectronPid = app.proc?.pid; checkpoint();
    await app.login();
    if (await app.evalTimed(() => window.electronAPI.config.getApiUrl()) !== mock.url) throw new Error('App did not select isolated mock backend');
    // The component appears only after its asynchronous support check finishes.
    await app.page.waitForSelector('[data-test="system-audio-toggle"]', { visible: true, timeout: 20000 });
    const toggle = await app.evalTimed(() => {
      const element = document.querySelector('[data-test="system-audio-toggle"]');
      return element ? { exists: true, checked: element.getAttribute('aria-checked') } : { exists: false };
    });
    if (!toggle.exists || !['true', 'false'].includes(toggle.checked)) throw new Error('Cannot confirm system-audio toggle');
    if (toggle.checked === 'true') await app.clickByTest('[data-test="system-audio-toggle"]');
    if (await app.evalTimed(() => document.querySelector('[data-test="system-audio-toggle"]')?.getAttribute('aria-checked')) !== 'false') throw new Error('System audio must be off');
    result.systemAudioEnabled = false;
    result.expectedNativeRecorders = await app.evalTimed(() => typeof window.electronAPI.recording.beginSource === 'function' ? 1 : 0);
    await app.evalTimed(installWitness, { processingDisabled: options.processingDisabled });
    await app.startRecording(); result.recordId = await app.getRecordId();
    console.log('Both diagnostic branches are recording: ' + directory);
    const began = performance.now();
    const traceStartS = Math.max(5, options.seconds / 2 - 15);
    while (performance.now() - began < options.seconds * 1000) {
      const before = performance.now();
      if (options.traceBuffers && !trace && (before - began) / 1000 >= traceStartS) {
        trace = await startBufferTrace(app.page);
        result.bufferTrace = trace.state; result.bufferTrace.requestedStartElapsedS = (before - began) / 1000;
      }
      if (trace && trace.state.stopRequestedAt === null && performance.now() - trace.state.startedAt >= 30000) await trace.stop();
      const renderer = await app.evalTimed(() => window.__directMixedWitness.snapshot(), undefined, 10000);
      result.samples.push({ before, after: performance.now(), elapsedS: (before - began) / 1000, renderer });
      checkpoint();
      if (renderer.errors.length) throw new Error(renderer.errors.join('; '));
      const roles = classifyWitnessRecorders(renderer, result.expectedNativeRecorders);
      if (roles.problems.length) throw new Error(roles.problems.join('; '));
      if (renderer.recorders.some(recorder => recorder.state !== 'recording')) throw new Error('A capture branch stopped early');
      await sleep(Math.min(5000, Math.max(1, options.seconds * 1000 - (performance.now() - began))));
    }
    // Capture branches may have different endpoints; common source IDs are compared offline.
    await app.stopRecording(60000);
    await app.evalTimed(() => window.__directMixedWitness.stopDirect(), undefined, 15000);
    if (trace) {
      await trace.exportTo(path.join(directory, 'audio-buffer-trace.json'));
      await trace.dispose();
      if (trace.state.problems.length) throw new Error(trace.state.problems.join('; '));
    }
    const witnessStoppedSnapshot = await app.evalTimed(() => window.__directMixedWitness.snapshot());
    const directDir = path.join(directory, 'direct-chunks'); fs.mkdirSync(directDir);
    const directPath = path.join(directory, 'direct-original.webm');
    const joined = fs.openSync(directPath, 'wx');
    result.directChunks = [];
    try {
      for (let index = 0; index < witnessStoppedSnapshot.directChunks; index++) {
        const item = await app.evalTimed(chunkIndex => window.__directMixedWitness.exportChunk(chunkIndex), index);
        const bytes = Buffer.from(item.base64, 'base64'); if (bytes.length !== item.size) throw new Error('Direct chunk export length differs');
        const filename = path.join(directDir, 'chunk_' + index + '.webm'); fs.writeFileSync(filename, bytes, { flag: 'wx' });
        fs.writeSync(joined, bytes); result.directChunks.push({ index, size: bytes.length, sha256: hash(bytes), filename });
      }
      fs.fsyncSync(joined);
    } finally { fs.closeSync(joined); }
    result.directPath = directPath; result.directSha256 = hash(fs.readFileSync(directPath));
    await app.waitForPhase(['uploaded', 'error'], 120000); result.phase = await app.getPhase();
    if (result.phase !== 'uploaded') throw new Error('Actual app failed local mock upload');
    result.finalSnapshot = await app.evalTimed(() => window.__directMixedWitness.snapshot());
    result.recorderRoles = classifyWitnessRecorders(result.finalSnapshot, result.expectedNativeRecorders);
    if (result.recorderRoles.problems.length) throw new Error(result.recorderRoles.problems.join('; '));
    result.clockReadout = clockReadout(result.samples, result.finalSnapshot);
    result.finalPath = app.findOutputFile(); if (!result.finalPath) throw new Error('Missing actual app final recording');
    result.finalSha256 = hash(fs.readFileSync(result.finalPath));
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(result.finalPath), 'upload-receipt.json'), 'utf8'));
    const remote = mock.state.uploads.get(receipt.audioFileId);
    result.upload = { remoteSha256: remote?.sha256, localSha256: result.finalSha256, canDelete: receipt.canDelete,
      attempts: mock.state.requests.filter(request => request.url === '/api/desktop/upload').length };
    if (remote?.sha256 !== result.finalSha256 || receipt.canDelete !== false) throw new Error('Actual app local upload custody check failed');
    // Native-source finalization protects the uploaded artifact. Reconstruct
    // the actual live mix separately so its original diagnostic failures are
    // not hidden by comparing the independent witness to a protected final.
    const mixedChunks = legacyChunkFiles(path.dirname(result.finalPath));
    result.mixedSourceChunks = mixedChunks.map(chunk => ({ index: chunk.index, file: chunk.file,
      size: fs.statSync(chunk.file).size, sha256: hash(fs.readFileSync(chunk.file)) }));
    const mixedRecorder = result.recorderRoles.mixed;
    if (result.mixedSourceChunks.reduce((bytes, chunk) => bytes + chunk.size, 0) !== mixedRecorder.bytes ||
        mixedChunks.length !== mixedRecorder.events - mixedRecorder.emptyEvents) throw new Error('Live-mix original bytes/events do not match their recorder');
    result.mixedPath = path.join(directory, 'actual-live-mix-original.webm');
    await concatenateFiles(mixedChunks.map(chunk => chunk.file), result.mixedPath);
    result.mixedSha256 = hash(fs.readFileSync(result.mixedPath));
    result.notes.push('mixedPath is the actual live-mix original chunk stream; finalPath is the separately finalized and uploaded recording.');
    const acquisition = result.finalSnapshot.acquisitions;
    if (acquisition.length !== 1 || !acquisition[0].receivedAt || !acquisition[0].settings.length) throw new Error('Missing single native acquisition evidence');
    if (options.processingDisabled && acquisition[0].settings.some(settings => ['echoCancellation', 'noiseSuppression', 'autoGainControl'].some(flag => settings[flag] !== false))) throw new Error('Disabled audio processing not confirmed by native settings');
    if (!result.clockReadout.some(context => context.isActualApplicationRecordingContext)) throw new Error('Actual app mixing context was not identified');
    if (result.finalSnapshot.recorders.some(recorder => recorder.timesliceMs !== 1000 || recorder.startedAt === null || recorder.stoppedAt === null)) throw new Error('Unexpected recorder lifecycle or interval');
    await app.evalTimed(() => window.__directMixedWitness.dispose());
    await app.close({ keepProfile: true }); app = null;
    await mock.close(); mock = null;
    // No live capture, playback, or app process overlaps decoding.
    if (result.bufferTrace?.exportCompleted) {
      result.bufferTrace.summary = summarizeTrace(JSON.parse(fs.readFileSync(result.bufferTrace.file, 'utf8')));
      if (!Object.keys(result.bufferTrace.summary.counts).length) throw new Error('No native media-stream events in audio trace');
    }
    checkpoint();
    const directAnalysis = await analyzeCodedAudio(result.directPath);
    writeJson(path.join(directory, 'direct-analysis.json'), directAnalysis);
    const mixedAnalysis = await analyzeCodedAudio(result.mixedPath);
    writeJson(path.join(directory, 'mixed-analysis.json'), mixedAnalysis);
    result.decoded = { directDurationS: directAnalysis.durationS, mixedDurationS: mixedAnalysis.durationS,
      directDecoderWarnings: directAnalysis.decoderWarnings, mixedDecoderWarnings: mixedAnalysis.decoderWarnings };
    result.commonSourceComparison = compareGroups(directAnalysis, mixedAnalysis);
    const finalAnalysis = await analyzeCodedAudio(result.finalPath);
    writeJson(path.join(directory, 'final-analysis.json'), finalAnalysis);
    result.finalSourceComparison = compareGroups(directAnalysis, finalAnalysis);
    result.decoded.finalDurationS = finalAnalysis.durationS;
    verifyUnchanged(expectedProvenance); result.controlsValid = true; result.measurementCompleted = true;
  } catch (error) { result.problems.push(error.stack || error.message); }
  finally {
    if (app) {
      try { result.failureSnapshot = await app.evalTimed(() => window.__directMixedWitness?.snapshot(), undefined, 3000); } catch (_) { /* retain available evidence */ }
      try { await app.evalTimed(() => window.__directMixedWitness?.dispose(), undefined, 12000); } catch (error) { result.problems.push('Renderer cleanup: ' + error.message); }
      if (trace) {
        if (!trace.state.exportCompleted) {
          try {
            const snapshot = await app.evalTimed(() => window.__directMixedWitness?.snapshot(), undefined, 3000);
            if (snapshot?.recorders.every(recorder => recorder.state === 'inactive')) await trace.exportTo(path.join(directory, 'failed-audio-buffer-trace.json'));
            else result.problems.push('Trace export skipped because capture did not stop');
          } catch (error) { result.problems.push('Trace preservation: ' + error.message); }
        }
        await trace.dispose();
      }
      // Preserve whatever the diagnostic witness captured on a failed case too.
      // The normal success path already exported it; never overwrite that output.
      if (!result.directPath) {
        try {
          const witness = await app.evalTimed(() => window.__directMixedWitness?.snapshot(), undefined, 3000);
          if (witness?.directChunks) {
            const retained = fs.mkdtempSync(path.join(directory, 'failed-direct-chunks-'));
            result.failedDirectEvidence = { directory: retained, chunks: [] };
            for (let index = 0; index < witness.directChunks; index++) {
              const item = await app.evalTimed(i => window.__directMixedWitness.exportChunk(i), index);
              const bytes = Buffer.from(item.base64, 'base64');
              if (bytes.length !== item.size) result.problems.push('Failed witness export length differs');
              const file = path.join(retained, 'chunk_' + index + '.webm');
              fs.writeFileSync(file, bytes, { flag: 'wx' });
              result.failedDirectEvidence.chunks.push({ index, bytes: bytes.length, sha256: hash(bytes) });
            }
          }
        } catch (error) { result.problems.push('Failed witness preservation: ' + error.message); }
      }
      await app.close({ keepProfile: true }).catch(error => result.problems.push('App cleanup: ' + error.message));
    }
    if (mock) { mock.server.closeAllConnections?.(); await mock.close().catch(error => result.problems.push('Mock cleanup: ' + error.message)); }
    try { verifyUnchanged(expectedProvenance); } catch (error) { result.problems.push(error.message); result.controlsValid = false; }
    result.finishedAt = new Date().toISOString(); checkpoint();
  }
  return result;
}


async function runCaptureClockDiagnostic(opts = {}) {
  const seconds = opts.seconds ?? 180;
  const traceBuffers = opts.traceBuffers ?? process.env.SUISSE_CAPTURE_CLOCK_TRACE === '1';
  if (!Number.isInteger(seconds) || seconds < 45 || seconds > 240) throw new Error('Diagnostic capture must be 45–240 seconds');
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Native Windows or macOS required');
  if (process.env.SUISSE_E2E_HOOKS !== '1' || process.env.SUISSE_TEST_NETWORK_ISOLATION !== '1') throw new Error('Explicit synthetic/network-isolation flags required');
  if (process.env.SUISSE_E2E_PACKAGED_EXE) throw new Error('Release installers cannot be used by this diagnostic');
  const appDirectory = path.resolve(opts.appDir || process.env.SUISSE_E2E_APP_DIR || 'dist/electron/UnPackaged');
  const applicationBuildCommit = opts.bundleSha || process.env.SUISSE_E2E_BUNDLE_SHA;
  if (!/^[a-f0-9]{40}$/i.test(applicationBuildCommit || '')) throw new Error('Explicit application build SHA required');
  const recorded = provenance(appDirectory, applicationBuildCommit);
  const parent = path.join(WORK, 'qualification'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 's16-capture-clock-'));
  const result = { name: 's16-capture-clock-diagnostic', pass: false, measurementCompleted: false, problems: [],
    fiveHourQualificationPassed: false, productionBackendQualified: false, physicalHardwareQualified: false,
    secondsPerCase: seconds, traceBuffers, evidenceDir: directory, cases: [],
    notes: ['Success means the diagnostic completed with valid controls; it does not clear existing capture or endurance failures.',
      'Default and disabled processing may negotiate different sample rates/channel counts. Read the observed settings before attributing a difference to processing.',
      'Direct and mixed endpoints differ; source identities are compared only over their common interior interval.'] };
  const checkpoint = () => writeJson(path.join(directory, 'summary.json'), result);
  checkpoint();
  for (const processingDisabled of [false, true]) {
    const caseDir = path.join(directory, processingDisabled ? 'processing-disabled' : 'default-processing');
    fs.mkdirSync(caseDir);
    const caseResult = await capture(caseDir, { seconds, processingDisabled, traceBuffers }, recorded);
    result.cases.push(caseResult);
    if (!caseResult.measurementCompleted || !caseResult.controlsValid || caseResult.problems.length) {
      result.problems.push(...caseResult.problems.map(problem => path.basename(caseDir) + ': ' + problem));
      if (!caseResult.problems.length) result.problems.push(path.basename(caseDir) + ': diagnostic incomplete or controls invalid');
    }
    for (const problem of caseResult.commonSourceComparison?.problems || []) result.problems.push(path.basename(caseDir) + ': ' + problem);
    for (const problem of caseResult.finalSourceComparison?.problems || []) result.problems.push(path.basename(caseDir) + ': final: ' + problem);
    checkpoint();
  }
  result.measurementCompleted = result.cases.every(entry => entry.measurementCompleted && entry.controlsValid);
  result.pass = result.measurementCompleted && result.problems.length === 0;
  checkpoint(); return result;
}

module.exports = { runCaptureClockDiagnostic, compareGroups, clockReadout, installWitness };
