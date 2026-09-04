/** Strict, real-time coded endurance. A shortened smoke run is never a 5h pass. */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { AppDriver, sleep } = require('./lib/app-driver');
const { startMockBackend } = require('./lib/mock-backend');
const { buildCodedScenario, WORK_DIR } = require('./lib/audio');
const { verifyCodedAudio } = require('./lib/coded-audio');

const DEFAULT_SECONDS = 5 * 3600 + 5 * 60;
const ROTATION_SECONDS = 4 * 3600 + 55 * 60;
const SAMPLE_SECONDS = 30;
const HEADROOM_BYTES = 1024 ** 3;
const CRITICAL_FREE_BYTES = 512 * 1024 ** 2;

function diskBudget(seconds) {
  return { referenceBytes: (seconds + 25) * 48000 * 2 + 44,
    encodedCopiesBytes: Math.ceil(seconds * 256000 / 8) * 3, headroomBytes: HEADROOM_BYTES };
}

function availableBytes(directory) {
  const stats = fs.statfsSync(directory);
  return stats.bavail * stats.bsize;
}

function resolveEnduranceSeconds(value = process.env.SUISSE_ENDURANCE_SECONDS) {
  const seconds = value === undefined ? DEFAULT_SECONDS : Number(value);
  if (!Number.isInteger(seconds) || seconds < 45 || seconds > 20000) throw new Error('Endurance seconds must be an explicit integer between 45 and 20000');
  return seconds;
}

async function sha256(filename) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

/** Bounded multipart reader: retains a delimiter/header, never the audio body. */
function createMultipartHasher(contentType) {
  const match = contentType?.match(/boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i);
  const boundary = match?.[1] || match?.[2];
  if (!boundary || boundary.length > 200) throw new Error('Invalid multipart boundary');
  const opening = Buffer.from('--' + boundary + '\r\n');
  const delimiter = Buffer.from('\r\n--' + boundary);
  const hash = crypto.createHash('sha256');
  let pending = Buffer.alloc(0), state = 'opening', isFile = false, files = 0, fileBytes = 0, maxBufferedBytes = 0;
  const consume = bytes => { if (isFile) { hash.update(bytes); fileBytes += bytes.length; } };
  return {
    feed(chunk) {
      pending = Buffer.concat([pending, chunk]);
      maxBufferedBytes = Math.max(maxBufferedBytes, pending.length);
      for (;;) {
        if (state === 'opening') {
          if (pending.length < opening.length) return;
          if (!pending.subarray(0, opening.length).equals(opening)) throw new Error('Invalid multipart opening');
          pending = pending.subarray(opening.length); state = 'headers';
        } else if (state === 'headers') {
          const end = pending.indexOf('\r\n\r\n');
          if (end < 0) { if (pending.length > 16384) throw new Error('Multipart headers too large'); return; }
          if (end > 16384) throw new Error('Multipart headers too large');
          isFile = /content-disposition:[^\r\n]*\bfilename=/i.test(pending.subarray(0, end).toString('utf8'));
          if (isFile && ++files > 1) throw new Error('Expected one audio file');
          pending = pending.subarray(end + 4); state = 'body';
        } else if (state === 'body') {
          const end = pending.indexOf(delimiter);
          if (end < 0) {
            const length = Math.max(0, pending.length - delimiter.length + 1);
            consume(pending.subarray(0, length)); pending = pending.subarray(length); return;
          }
          consume(pending.subarray(0, end)); pending = pending.subarray(end + delimiter.length); state = 'boundary';
        } else if (state === 'boundary') {
          if (pending.length < 2) return;
          if (pending.subarray(0, 2).equals(Buffer.from('--'))) { state = 'done'; pending = Buffer.alloc(0); return; }
          if (!pending.subarray(0, 2).equals(Buffer.from('\r\n'))) throw new Error('Invalid multipart separator');
          pending = pending.subarray(2); state = 'headers';
        } else { pending = Buffer.alloc(0); return; }
      }
    },
    finish() {
      if (state !== 'done' || files !== 1 || !fileBytes) throw new Error('Incomplete multipart audio upload');
      return { sha256: hash.digest('hex'), fileSize: fileBytes, maxBufferedBytes };
    },
  };
}

async function startStreamingMockBackend(opts) {
  const mock = await startMockBackend(opts);
  const handlers = mock.server.listeners('request');
  mock.server.removeAllListeners('request');
  mock.server.on('request', (req, res) => {
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/api/desktop/upload') {
      for (const handler of handlers) handler.call(mock.server, req, res);
      return;
    }
    void (async () => {
      let bodyBytes = 0;
      try {
        const parser = createMultipartHasher(req.headers['content-type']);
        for await (const chunk of req) { bodyBytes += chunk.length; parser.feed(chunk); }
        const uploaded = parser.finish();
        const audioFileId = 'e2e-endurance-' + crypto.randomUUID();
        mock.state.uploads.set(audioFileId, { ...uploaded, status: 'PROCESSING' });
        mock.state.requests.push({ t: Date.now(), method: req.method, url: '/api/desktop/upload', bodyBytes });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true' });
        res.end(JSON.stringify({ success: true, audioFileId, transcriptionId: audioFileId, meetingId: audioFileId }));
      } catch (error) {
        mock.state.requests.push({ t: Date.now(), method: req.method, url: '/api/desktop/upload', bodyBytes, error: error.message });
        if (!res.destroyed) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
      }
    })();
  });
  return mock;
}

class EnduranceDriver extends AppDriver {
  async observeRenderer(page) {
    await super.observeRenderer(page);
    // Keep lifecycle/recorder event logs, but replace repeated recursive
    // five-second sampling with this scenario's lean thirty-second sampler.
    const observer = this.rendererListeners.get(page);
    if (observer?.timer) { clearInterval(observer.timer); observer.timer = null; }
  }

  captureDiskProgress() {
    this.assertTestProfile();
    const filename = path.join(this.userDataDir, 'active-recording.json');
    if (!fs.existsSync(filename)) return { active: false };
    const active = JSON.parse(fs.readFileSync(filename, 'utf8')).activeSession;
    if (!active || !/^[a-f0-9-]{36}$/i.test(active.recordId || '')) return { active: false };
    const archive = path.join(this.recordingsDir, active.recordId, 'source-chunks');
    return { active: true, recordId: active.recordId, chunkCount: active.chunkCount, lastChunkAt: active.lastChunkAt,
      sourceBatches: fs.existsSync(archive) ? fs.readdirSync(archive, { withFileTypes: true }).filter(entry => entry.isDirectory()).length : 0 };
  }
}

async function installConstraintEvidence(app, processingDisabled) {
  await app.evalTimed(disabled => {
    const original = navigator.mediaDevices.getUserMedia;
    const evidence = { processingDisabled: disabled, calls: 0, tracks: [] };
    window.__enduranceConstraints = evidence;
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const requested = disabled && constraints?.audio ? { ...constraints, audio: {
        ...(typeof constraints.audio === 'object' ? constraints.audio : {}),
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } } : constraints;
      const stream = await Reflect.apply(original, this, [requested]);
      evidence.calls++;
      evidence.tracks = stream.getAudioTracks().map(track => track.getSettings());
      return stream;
    };
  }, processingDisabled);
}

function verifyRetainedSources(recordingDir, expectedBytes, expectedEvents, manifestPath) {
  const archive = path.join(recordingDir, 'source-chunks');
  const batches = fs.readdirSync(archive, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort((a, b) => Number(a) - Number(b));
  let count = 0, bytes = 0, lastIndex = -1;
  const problems = [];
  const fd = fs.openSync(manifestPath, 'wx');
  try {
    for (const batch of batches) {
      const folder = path.join(archive, batch);
      const files = fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && /^chunk_\d+\.webm$/.test(entry.name))
        .map(entry => entry.name).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      for (const file of files) {
        const index = Number(file.match(/\d+/)[0]);
        if (index !== lastIndex + 1 && problems.length < 20) problems.push(`Retained chunk index ${index} follows ${lastIndex}`);
        lastIndex = index;
        const size = fs.statSync(path.join(folder, file)).size;
        count++; bytes += size;
        fs.writeSync(fd, JSON.stringify({ batch, index, bytes: size }) + '\n');
      }
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (bytes !== expectedBytes) problems.push(`Original sources contain ${bytes} bytes, recorder emitted ${expectedBytes}`);
  if (count !== expectedEvents) problems.push(`Original sources contain ${count} chunks, recorder emitted ${expectedEvents} nonempty events`);
  return { count, bytes, batches: batches.length, firstBatch: batches[0], lastBatch: batches.at(-1), manifestPath, problems };
}

async function runCodedEndurance(opts = {}) {
  const seconds = resolveEnduranceSeconds(opts.seconds);
  const appDir = opts.appDir || process.env.SUISSE_E2E_APP_DIR;
  if (!appDir) throw new Error('Endurance requires a prebuilt app via SUISSE_E2E_APP_DIR; dev/HMR builds are not qualified');
  if (process.env.VITE_SUISSE_MAX_DURATION_SECONDS) throw new Error('Remove the accelerated rotation override before endurance qualification');
  const processingDisabled = opts.processingDisabled ?? process.env.SUISSE_ENDURANCE_PROCESSING_DISABLED === '1';
  const name = 's13-coded-endurance-' + seconds + 's-' + Date.now();
  const evidenceDir = path.join(WORK_DIR, 'qualification', name);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const summaryPath = path.join(evidenceDir, 'summary.json');
  const progressPath = path.join(evidenceDir, 'progress.jsonl');
  const progressFd = fs.openSync(progressPath, 'wx');
  const result = { name, pass: false, completed: false, fiveHourQualificationPassed: false, requestedSeconds: seconds,
    runKind: seconds < DEFAULT_SECONDS ? 'shortened-smoke' : 'full-duration', processingDisabled,
    productionBackendQualified: false, problems: [], problemCount: 0, notes: [
      'Local mock upload success above five hours does not prove production acceptance; the deployed backend has a five-hour limit.',
      'Shortened smoke runs do not qualify five hours; natural rotation is asserted only after crossing 4h55.',
      'Synthetic native microphone capture; physical Bluetooth/USB and macOS system audio are outside this scenario.',
    ], metrics: { samples: 0, maxPersistGapS: 0, maxNativeEventGapS: 0, maxRendererHeapMB: null, maxHarnessRssMB: 0,
      minFreeBytes: null, firstRotationElapsedS: null, maxBatchesDuringCapture: 0, phaseCounts: {} }, recentSamples: [], evidenceDir, summaryPath, progressPath };
  let mock = null, app = null, started = null, lastChunkCount = -1, lastPersistObservedAt = null;
  const problem = message => { result.problemCount++; if (result.problems.length < 30) result.problems.push(message); };
  const checkpoint = event => {
    if (event) { fs.writeSync(progressFd, JSON.stringify({ recordedAt: new Date().toISOString(), ...event }) + '\n'); fs.fsyncSync(progressFd); }
    fs.writeFileSync(summaryPath, JSON.stringify(result, null, 2));
  };
  try {
    const budget = diskBudget(seconds);
    result.diskPreflight = { ...budget, availableBytes: availableBytes(evidenceDir), requiredBytes: Object.values(budget).reduce((total, size) => total + size, 0) };
    if (result.diskPreflight.availableBytes < result.diskPreflight.requiredBytes) throw new Error('Insufficient free disk space for the synthetic reference, retained encoded copies, and 1 GiB headroom');
    checkpoint({ event: 'preparing-reference', requestedSeconds: seconds });
    const reference = buildCodedScenario(name, [{ type: 'speech', seconds: seconds + 25 }]);
    result.reference = reference.metaPath;
    mock = await startStreamingMockBackend({ port: opts.mockPort || 3000 });
    app = new EnduranceDriver({ name, appDir, apiUrl: mock.url, fakeAudioWav: reference.wavPath,
      env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
    await app.launch(); await app.login();
    if (await app.evalTimed(() => window.electronAPI.config.getApiUrl()) !== mock.url) throw new Error('Endurance must use the isolated local backend');
    result.bundle = { gitSha: opts.bundleSha || process.env.SUISSE_E2E_BUNDLE_SHA || null,
      appDirectory: appDir, electronMainSha256: await sha256(path.join(appDir, 'electron-main.js')) };
    await installConstraintEvidence(app, processingDisabled);
    await app.startRecording();
    result.recordId = await app.getRecordId();
    result.constraintEvidence = await app.evalTimed(() => window.__enduranceConstraints);
    if (processingDisabled && (!result.constraintEvidence.tracks.length || result.constraintEvidence.tracks.some(settings =>
      ['echoCancellation', 'noiseSuppression', 'autoGainControl'].some(flag => settings[flag] !== false)))) {
      throw new Error('Processing-disabled control not confirmed by track settings');
    }
    started = performance.now(); lastPersistObservedAt = started;
    checkpoint({ event: 'recording-started', recordId: result.recordId });
    for (;;) {
      const sampledAt = performance.now();
      const renderer = await app.evalTimed(() => {
        const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
        const state = pinia?.state?.value?.recording;
        const capture = window.__suisseCaptureDiagnostics?.snapshot();
        return { phase: state?.phase, duration: state?.duration, chunkIndex: state?.chunkIndex, chunkSaveErrors: state?.chunkSaveErrors,
          capture, heapMB: performance.memory?.usedJSHeapSize ? performance.memory.usedJSHeapSize / 1048576 : null,
          domNodes: document.getElementsByTagName('*').length };
      }, undefined, 10000);
      const disk = app.captureDiskProgress();
      const elapsedS = (sampledAt - started) / 1000;
      const monotonicPersistGapS = (sampledAt - lastPersistObservedAt) / 1000;
      const wallPersistGapS = disk.lastChunkAt ? Math.max(0, (Date.now() - Date.parse(disk.lastChunkAt)) / 1000) : null;
      if (disk.chunkCount !== lastChunkCount) { lastChunkCount = disk.chunkCount; lastPersistObservedAt = sampledAt; }
      const recorder = renderer.capture?.recorders?.at(-1);
      const nativeGapS = recorder?.lastDataAt != null ? Math.max(0, (renderer.capture.at - recorder.lastDataAt) / 1000) : elapsedS;
      const rssMB = process.memoryUsage().rss / 1048576;
      const freeBytes = availableBytes(evidenceDir);
      const minimumFinalizationFreeBytes = CRITICAL_FREE_BYTES + (recorder?.bytes || 0) * 3;
      const sample = { elapsedS, renderer, disk, wallPersistGapS, monotonicPersistGapS, nativeGapS, harnessRssMB: rssMB, freeBytes, minimumFinalizationFreeBytes };
      result.metrics.samples++;
      result.metrics.maxPersistGapS = Math.max(result.metrics.maxPersistGapS, wallPersistGapS || 0);
      result.metrics.maxNativeEventGapS = Math.max(result.metrics.maxNativeEventGapS, nativeGapS);
      result.metrics.maxHarnessRssMB = Math.max(result.metrics.maxHarnessRssMB, rssMB);
      result.metrics.minFreeBytes = Math.min(result.metrics.minFreeBytes ?? freeBytes, freeBytes);
      if (renderer.heapMB !== null) result.metrics.maxRendererHeapMB = Math.max(result.metrics.maxRendererHeapMB || 0, renderer.heapMB);
      result.metrics.phaseCounts[renderer.phase || 'unknown'] = (result.metrics.phaseCounts[renderer.phase || 'unknown'] || 0) + 1;
      result.metrics.maxBatchesDuringCapture = Math.max(result.metrics.maxBatchesDuringCapture, disk.sourceBatches || 0);
      if (disk.sourceBatches && result.metrics.firstRotationElapsedS === null) result.metrics.firstRotationElapsedS = elapsedS;
      result.recentSamples.push(sample); if (result.recentSamples.length > 8) result.recentSamples.shift();
      // Existing child-output diagnostics stay on disk; do not retain hours of
      // duplicate strings in the driver just to print a startup error excerpt.
      if (app.log.length > 200) app.log.splice(0, app.log.length - 200);
      checkpoint({ event: 'progress', ...sample });
      if (renderer.phase !== 'recording') throw new Error('Recording left the active phase before the requested endurance duration: ' + renderer.phase);
      if (freeBytes < minimumFinalizationFreeBytes) {
        // This is a disposable synthetic profile. Preserve durable sources and
        // stop its process instead of allocating more remux copies on low disk.
        await app.close({ keepProfile: true });
        throw new Error('Synthetic endurance stopped below finalization space plus 512 MiB reserve; sources retained without finalization');
      }
      if (performance.now() - started >= seconds * 1000) break;
      await sleep(Math.min(SAMPLE_SECONDS * 1000, Math.max(1, seconds * 1000 - (performance.now() - started))));
    }
    result.monotonicCaptureSeconds = (performance.now() - started) / 1000;
    checkpoint({ event: 'stopping' });
    await app.stopRecording(60000);
    await app.waitForPhase(['uploaded', 'error'], 30 * 60000);
    result.phase = await app.getPhase();
    if (result.phase !== 'uploaded') problem('Endurance recording did not complete its local mock upload');
    const capture = await app.evalTimed(() => window.__suisseCaptureDiagnostics?.snapshot());
    result.capture = capture;
    const recorder = capture?.recorders?.at(-1);
    if (recorder?.startedAt == null || recorder?.stoppedAt == null) throw new Error('Missing native recorder timing evidence');
    result.expectedDurationS = (recorder.stoppedAt - recorder.startedAt) / 1000;
    if (result.expectedDurationS < seconds - 1.5) problem('Native recording ended before the requested duration');
    if (capture.recorders.length !== 1) problem('Endurance unexpectedly created multiple MediaRecorders');
    const output = app.findOutputFile();
    if (!output) throw new Error('No final recording; retained profile contains the available source evidence');
    result.output = output;
    checkpoint({ event: 'verifying-audio', output });
    const audio = await verifyCodedAudio(output, reference, { expectedDurationS: result.expectedDurationS, durationToleranceS: 1.5 });
    result.audio = { ...audio, problems: audio.problems.slice(0, 30), problemCount: audio.problems.length };
    for (const issue of audio.problems) problem(issue);
    result.localSha256 = await sha256(output);
    const recordingDir = path.dirname(output);
    const receipt = JSON.parse(fs.readFileSync(path.join(recordingDir, 'upload-receipt.json'), 'utf8'));
    const remote = mock.state.uploads.get(receipt.audioFileId);
    result.upload = { localBytes: fs.statSync(output).size, remoteBytes: remote?.fileSize, remoteSha256: remote?.sha256,
      maxParserBufferedBytes: remote?.maxBufferedBytes, attempts: mock.state.requests.filter(request => request.url === '/api/desktop/upload').length };
    if (remote?.sha256 !== result.localSha256 || remote?.fileSize !== result.upload.localBytes) problem('Streamed multipart audio does not match the final recording');
    if (receipt.canDelete !== false || !fs.existsSync(output)) problem('Endurance local backup was not retained');
    result.sources = verifyRetainedSources(recordingDir, recorder.bytes, recorder.events - recorder.emptyEvents, path.join(evidenceDir, 'source-manifest.jsonl'));
    for (const issue of result.sources.problems) problem(issue);
    if (seconds > ROTATION_SECONDS) {
      if (result.metrics.maxBatchesDuringCapture < 1 || result.sources.batches < 2) problem('Natural 4h55 source rotation did not occur before finalization');
      if (result.metrics.firstRotationElapsedS !== null && (result.metrics.firstRotationElapsedS < ROTATION_SECONDS - SAMPLE_SECONDS || result.metrics.firstRotationElapsedS > ROTATION_SECONDS + 90)) {
        problem('Observed source rotation did not match the default 4h55 threshold');
      }
    } else if (result.metrics.maxBatchesDuringCapture > 0) problem('An unexpected accelerated source rotation occurred in a shortened run');
    result.captureWarnings = JSON.parse(fs.readFileSync(path.join(recordingDir, 'metadata.json'), 'utf8')).captureWarnings || [];
    result.completed = true;
    result.pass = result.problemCount === 0;
    result.fiveHourQualificationPassed = result.pass && seconds >= DEFAULT_SECONDS && result.expectedDurationS >= DEFAULT_SECONDS - 1.5;
  } catch (error) { problem(error.stack || error.message); }
  finally {
    result.diagnostics = app?.diagnosticsDir || null; result.profile = app?.userDataDir || null;
    const cleanupFailure = error => { problem('Evidence/cleanup: ' + error.message); result.pass = false; result.fiveHourQualificationPassed = false; };
    try { checkpoint({ event: 'finished', pass: result.pass, completed: result.completed, fiveHourQualificationPassed: result.fiveHourQualificationPassed }); }
    catch (error) { cleanupFailure(error); }
    try {
      if (app) await app.close({ keepProfile: true }).catch(cleanupFailure);
      if (mock) await mock.close().catch(cleanupFailure);
      checkpoint();
    } finally { fs.closeSync(progressFd); }
  }
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${name}: ${result.runKind}; true 5h05 qualification=${result.fiveHourQualificationPassed}`);
  return result;
}

module.exports = { runCodedEndurance, resolveEnduranceSeconds, createMultipartHasher, startStreamingMockBackend, diskBudget, DEFAULT_SECONDS, ROTATION_SECONDS };
