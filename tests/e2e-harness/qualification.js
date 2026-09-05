'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { AppDriver, sleep } = require('./lib/app-driver');
const { startMockBackend } = require('./lib/mock-backend');
const { buildCodedScenario, WORK_DIR } = require('./lib/audio');
const { verifyCodedAudio } = require('./lib/coded-audio');
const { installRecordingRoleObserver, legacyBatchLayout } = require('./lib/native-recorder-evidence');
const { inspectNativeSources } = require('../../src-electron/native-source-persistence');

async function sha256(filename) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

function writeEvidence(filename, result) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
}

async function recorderSnapshot(app) {
  return app.evalTimed(() => window.__suisseCaptureDiagnostics?.snapshot());
}

async function installProcessingControl(app) {
  await app.evalTimed(() => {
    const original = navigator.mediaDevices.getUserMedia;
    const flags = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    window.__qualificationProcessingControl = { flags, calls: [] };
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const requested = constraints?.audio ? { ...constraints,
        audio: { ...(typeof constraints.audio === 'object' ? constraints.audio : {}), ...flags } } : constraints;
      const stream = await Reflect.apply(original, this, [requested]);
      if (requested?.audio) window.__qualificationProcessingControl.calls.push({
        requestedAudio: requested.audio,
        actualAudioSettings: stream.getAudioTracks().map(track => track.getSettings()),
      });
      return stream;
    };
  });
}

async function captureCase(kind, seconds, opts = {}) {
  if (!['baseline', 'renderer-stall', 'blob-delay', 'native-blob-delay', 'rotation-and-network-cut'].includes(kind)) throw new Error('Unknown synthetic capture case');
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 90) throw new Error('Synthetic short capture requires 30–90 seconds');
  const name = 's11-' + kind + (opts.processingDisabled ? '-processing-disabled' : '');
  const reference = buildCodedScenario(name, [{ type: 'speech', seconds: seconds + 25 }]);
  const mock = await startMockBackend();
  const app = new AppDriver({ name, apiUrl: mock.url, fakeAudioWav: reference.wavPath,
    env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
  const result = { name, pass: false, problems: [], notes: [], reference: reference.metaPath, progress: [] };
  const evidenceFile = path.join(WORK_DIR, 'qualification', name + '.json');
  try {
    await app.launch();
    await app.login();
    if (opts.bundleSha || process.env.SUISSE_E2E_BUNDLE_SHA) {
      result.bundle = { gitSha: opts.bundleSha || process.env.SUISSE_E2E_BUNDLE_SHA,
        appDirectory: app.appDir,
        electronMainSha256: app.appDir ? await sha256(path.join(app.appDir, 'electron-main.js')) : null };
    }
    const apiUrl = await app.evalTimed(() => window.electronAPI.config.getApiUrl());
    if (apiUrl !== mock.url) throw new Error('The app is not using the local test backend');
    result.nativeArchiveExpected = await app.evalTimed(() => typeof window.electronAPI.recording.beginSource === 'function');
    if (kind === 'native-blob-delay' && !result.nativeArchiveExpected) throw new Error('Native blob delay requires the native archive application');
    await app.evalTimed(installRecordingRoleObserver, { delayRole: kind === 'blob-delay' ? 'live-mix' : kind === 'native-blob-delay' ? 'native-input' : null });
    if (opts.processingDisabled) await installProcessingControl(app);
    if (kind === 'rotation-and-network-cut') mock.setMode('upload-cut-50');
    await app.startRecording();
    if (opts.processingDisabled) {
      result.processingControl = await app.evalTimed(() => window.__qualificationProcessingControl);
      const calls = result.processingControl?.calls || [];
      if (!calls.length || calls.some(call => !call.actualAudioSettings.length || call.actualAudioSettings.some(settings =>
        ['echoCancellation', 'noiseSuppression', 'autoGainControl'].some(flag => settings[flag] !== false)))) {
        result.problems.push('Processing-disabled control was not confirmed by microphone track settings');
      }
      result.notes.push('Test-only control: echo cancellation, noise suppression and automatic gain disabled; native getUserMedia, WebAudio mixing and MediaRecorder remain in use.');
    }
    const recordId = await app.getRecordId();
    const started = performance.now();
    let blocked = false;
    let rotations = 0;
    while (performance.now() - started < seconds * 1000) {
      const elapsed = (performance.now() - started) / 1000;
      if (kind === 'renderer-stall' && elapsed >= 12 && !blocked) {
        blocked = true;
        await app.evalTimed(() => {
          const until = performance.now() + 4000;
          while (performance.now() < until) { /* deliberately stall only this synthetic renderer */ }
        });
        result.notes.push('Blocked renderer JavaScript for four seconds; native audio must remain continuous.');
      }
      if (kind === 'rotation-and-network-cut' && rotations < 2 && elapsed >= (rotations + 1) * 15) {
        const rotation = await app.evalTimed(id => window.electronAPI.recording.createSessionFile(id, '.webm'), recordId);
        if (!rotation.success) throw new Error('Source rotation failed: ' + rotation.error);
        rotations++;
      }
      const roleEvidence = await app.evalTimed(() => window.__recordingRoleEvidence.sampleFault());
      result.progress.push({ elapsed, phase: await app.getPhase(), disk: app.captureDiskProgress(), roleEvidence });
      writeEvidence(evidenceFile, result); // leave partial evidence if the process dies
      await sleep(Math.min(2500, Math.max(1, seconds * 1000 - (performance.now() - started))));
    }
    await app.stopRecording(45000);
    await app.waitForPhase(['uploaded', 'error'], 180000);
    result.phase = await app.getPhase();
    if (result.phase !== 'uploaded') result.problems.push('Recording did not finish uploading');
    result.capture = await recorderSnapshot(app);
    result.recorderRoles = await app.evalTimed(() => window.__recordingRoleEvidence.snapshot());
    const mixed = result.recorderRoles.records.filter(recorder => recorder.role === 'live-mix');
    const native = result.recorderRoles.records.filter(recorder => recorder.role === 'native-input');
    if (mixed.length !== 1 || native.length !== (result.nativeArchiveExpected ? 1 : 0)) throw new Error('Unexpected short-case native/mixed recorder topology');
    for (const observed of result.recorderRoles.records) {
      if (observed.timesliceMs !== 1000 || observed.startedAt === null || observed.stoppedAt === null || observed.state !== 'inactive') throw new Error('Missing expected native recorder lifecycle or 1000 ms interval');
    }
    const recorder = result.nativeArchiveExpected ? native[0] : mixed[0];
    if (!recorder || !recorder.events || !recorder.bytes) result.problems.push('No nonempty MediaRecorder output observed');
    if (recorder?.startedAt == null || recorder?.stoppedAt == null) throw new Error('Missing recorder start/stop timing evidence');
    const expectedDurationS = (recorder.stoppedAt - recorder.startedAt) / 1000;
    const output = app.findOutputFile();
    if (!output) throw new Error('No finalized recording; original profile retained');
    result.output = output;
    result.expectedDurationS = expectedDurationS;
    result.audio = await verifyCodedAudio(output, reference, { expectedDurationS, durationToleranceS: 1.5 });
    result.problems.push(...result.audio.problems);
    result.localSha256 = await sha256(output);
    if (result.nativeArchiveExpected) {
      const sources = inspectNativeSources(path.dirname(output));
      if (sources.length !== 1 || sources[0].kind !== 'microphone' || !sources[0].complete) throw new Error('Expected one complete preserved native microphone epoch');
      const source = sources[0];
      result.nativeSource = { sourceId: source.sourceId, startOffsetMs: source.startOffsetMs, endOffsetMs: source.endOffsetMs,
        chunkCount: source.chunkCount, bytes: source.chunks.reduce((total, chunk) => total + chunk.size, 0), chunks: [] };
      if (result.nativeSource.bytes !== native[0].bytes || source.chunkCount !== native[0].events - native[0].emptyEvents) throw new Error('Native original bytes/events do not match their observed recorder');
      for (const chunk of source.chunks) result.nativeSource.chunks.push({ index: chunk.index, bytes: chunk.size,
        path: path.relative(path.dirname(output), chunk.path), sha256: await sha256(chunk.path) });
    }
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(output), 'upload-receipt.json'), 'utf8'));
    const remote = mock.state.uploads.get(receipt.audioFileId);
    if (remote?.sha256 !== result.localSha256) result.problems.push('Multipart upload differs from finalized audio bytes');
    if (receipt.canDelete !== false || !fs.existsSync(output)) result.problems.push('Local backup was not retained');
    const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(output), 'metadata.json'), 'utf8'));
    result.captureWarnings = metadata.captureWarnings || [];
    result.uploadAttempts = mock.state.requests.filter(request => request.url === '/api/desktop/upload').length;
    if (kind === 'rotation-and-network-cut') {
      const layout = legacyBatchLayout(path.dirname(output));
      // Native finalization leaves the final live-mix batch in chunks/. The two
      // actual rotations must still be archived, with every emitted byte kept.
      result.sourceBatches = layout.batches;
      result.archivedSourceBatches = layout.archivedBatches;
      result.activeBatchRetained = layout.activeBatchRetained;
      result.liveMixChunks = [];
      for (const chunk of layout.chunks) result.liveMixChunks.push({ index: chunk.index,
        path: path.relative(path.dirname(output), chunk.file), bytes: fs.statSync(chunk.file).size, sha256: await sha256(chunk.file) });
      if (rotations !== 2 || layout.archivedBatches < 2 || layout.batches < 3) result.problems.push('Both requested source rotations were not preserved');
      if (result.liveMixChunks.length !== mixed[0].events - mixed[0].emptyEvents ||
          result.liveMixChunks.reduce((total, chunk) => total + chunk.bytes, 0) !== mixed[0].bytes) result.problems.push('Rotated live-mix original bytes/events were not fully retained');
      if (result.uploadAttempts !== 2) result.problems.push('Expected one cut upload and one successful retry');
    } else if (result.uploadAttempts !== 1) result.problems.push('Expected exactly one successful upload');
    if (kind === 'blob-delay') {
      result.fault = result.recorderRoles.fault;
      if (!result.fault?.injected || result.fault.targetRole !== 'live-mix' || result.fault.recorderId !== mixed[0].id) result.problems.push('The live-mix blob conversion delay was not actually injected');
      if (!result.captureWarnings.includes('capture-stalled')) result.problems.push('Delayed initial persistence left no retained capture warning');
      result.notes.push('First live-mix Blob conversion delayed 14 seconds; its original capture-stalled warning and complete final content remain required.');
    } else if (kind === 'native-blob-delay') {
      result.fault = result.recorderRoles.fault;
      if (!result.fault?.injected || result.fault.targetRole !== 'native-input' || result.fault.recorderId !== native[0].id ||
          !Number.isFinite(result.fault.completedAt) || result.fault.completedAt - result.fault.startedAt < 14000 ||
          !result.fault.samples.some(sample => sample.at - result.fault.startedAt >= 10000 && sample.pendingBlobBytes > 0 && sample.events >= 5)) {
        result.problems.push('The native-source delay and accumulating queued audio were not established');
      }
      if (native[0].convertedBytes !== native[0].bytes) result.problems.push('Some native-source bytes never completed blob conversion');
      result.notes.push('First native archive Blob conversion delayed 14 seconds. Pending/age evidence, every saved source byte and final coded content are required; this does not claim a user-visible early warning.');
    }
    result.pass = result.problems.length === 0;
  } catch (error) {
    result.problems.push(error.stack || error.message);
  } finally {
    result.diagnostics = app.diagnosticsDir;
    result.profile = app.userDataDir;
    writeEvidence(evidenceFile, result);
    try { await app.evalTimed(() => window.__recordingRoleEvidence?.dispose(), undefined, 3000); } catch (_) { /* app/profile evidence retained */ }
    await app.close({ keepProfile: true }).catch(error => { result.problems.push('App cleanup: ' + error.message); result.pass = false; });
    await mock.close();
    writeEvidence(evidenceFile, result);
  }
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${name}: ${result.problems.join('; ') || 'decoded continuity, upload hash and local retention verified'}`);
  return result;
}

async function runCaptureQualification() {
  // Each case uses a new app process and isolated profile; all outputs survive.
  const cases = ['baseline', 'renderer-stall', 'blob-delay', 'rotation-and-network-cut'];
  const results = [];
  for (const kind of cases) results.push(await captureCase(kind, 45));
  if (results[0]?.nativeArchiveExpected) results.push(await captureCase('native-blob-delay', 45));
  return { pass: results.every(result => result.pass),
    problems: results.flatMap(result => result.problems.map(problem => result.name + ': ' + problem)),
    notes: ['Real Electron capture with synthetic, numbered audio; physical Bluetooth/USB and AudioTee permissions are not simulated by this suite.'], results };
}

module.exports = { runCaptureQualification, captureCase };
