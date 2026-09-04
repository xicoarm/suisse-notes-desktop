'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { AppDriver, sleep } = require('./lib/app-driver');
const { startMockBackend } = require('./lib/mock-backend');
const { buildCodedScenario, WORK_DIR } = require('./lib/audio');
const { verifyCodedAudio } = require('./lib/coded-audio');

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

async function installDelay(app) {
  await app.evalTimed(() => {
    const original = Blob.prototype.arrayBuffer;
    window.__qualificationFault = { kind: 'blob-conversion-delay', injected: false };
    Blob.prototype.arrayBuffer = async function (...args) {
      if (!window.__qualificationFault.injected && this.type.startsWith('audio/')) {
        window.__qualificationFault.injected = true;
        await new Promise(resolve => setTimeout(resolve, 14000));
      }
      return Reflect.apply(original, this, args);
    };
  });
}

async function captureCase(kind, seconds) {
  const name = 's11-' + kind;
  const reference = buildCodedScenario(name, [{ type: 'speech', seconds: seconds + 25 }]);
  const mock = await startMockBackend();
  const app = new AppDriver({ name, apiUrl: mock.url, fakeAudioWav: reference.wavPath,
    env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
  const result = { name, pass: false, problems: [], notes: [], reference: reference.metaPath, progress: [] };
  const evidenceFile = path.join(WORK_DIR, 'qualification', name + '.json');
  try {
    await app.launch();
    await app.login();
    const apiUrl = await app.evalTimed(() => window.electronAPI.config.getApiUrl());
    if (apiUrl !== mock.url) throw new Error('The app is not using the local test backend');
    if (kind === 'blob-delay') await installDelay(app);
    if (kind === 'rotation-and-network-cut') mock.setMode('upload-cut-50');
    await app.startRecording();
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
      result.progress.push({ elapsed, phase: await app.getPhase(), disk: app.captureDiskProgress() });
      writeEvidence(evidenceFile, result); // leave partial evidence if the process dies
      await sleep(Math.min(2500, Math.max(1, seconds * 1000 - (performance.now() - started))));
    }
    await app.stopRecording(45000);
    await app.waitForPhase(['uploaded', 'error'], 180000);
    result.phase = await app.getPhase();
    if (result.phase !== 'uploaded') result.problems.push('Recording did not finish uploading');
    result.capture = await recorderSnapshot(app);
    const recorder = result.capture?.recorders?.at(-1);
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
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(output), 'upload-receipt.json'), 'utf8'));
    const remote = mock.state.uploads.get(receipt.audioFileId);
    if (remote?.sha256 !== result.localSha256) result.problems.push('Multipart upload differs from finalized audio bytes');
    if (receipt.canDelete !== false || !fs.existsSync(output)) result.problems.push('Local backup was not retained');
    const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(output), 'metadata.json'), 'utf8'));
    result.captureWarnings = metadata.captureWarnings || [];
    result.uploadAttempts = mock.state.requests.filter(request => request.url === '/api/desktop/upload').length;
    if (kind === 'rotation-and-network-cut') {
      const archive = path.join(path.dirname(output), 'source-chunks');
      result.sourceBatches = fs.readdirSync(archive).length;
      if (result.sourceBatches < 3) result.problems.push('Both requested source rotations were not preserved');
      if (result.uploadAttempts !== 2) result.problems.push('Expected one cut upload and one successful retry');
    } else if (result.uploadAttempts !== 1) result.problems.push('Expected exactly one successful upload');
    if (kind === 'blob-delay') {
      result.fault = await app.evalTimed(() => window.__qualificationFault);
      if (!result.fault?.injected) result.problems.push('The blob conversion delay was not actually injected');
      if (!result.captureWarnings.includes('capture-stalled')) result.problems.push('Delayed initial persistence left no retained capture warning');
      result.notes.push('First audio Blob conversion delayed 14 seconds; every original frame must survive the queued save.');
    }
    result.pass = result.problems.length === 0;
  } catch (error) {
    result.problems.push(error.stack || error.message);
  } finally {
    result.diagnostics = app.diagnosticsDir;
    result.profile = app.userDataDir;
    writeEvidence(evidenceFile, result);
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
  return { pass: results.every(result => result.pass),
    problems: results.flatMap(result => result.problems.map(problem => result.name + ': ' + problem)),
    notes: ['Real Electron capture with synthetic, numbered audio; physical Bluetooth/USB and AudioTee permissions are not simulated by this suite.'], results };
}

module.exports = { runCaptureQualification, captureCase };
