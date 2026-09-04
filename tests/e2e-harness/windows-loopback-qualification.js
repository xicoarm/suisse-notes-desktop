'use strict';

// This is a LOCAL Windows qualification. Real loopback can include unrelated
// Windows playback; every artifact stays outside the synthetic CI artifact tree.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { AppDriver, sleep } = require('./lib/app-driver');
const { startMockBackend } = require('./lib/mock-backend');
const { buildCodedScenario, verifyCodedAudio } = require('./lib/coded-audio');

const ROOT = path.resolve(__dirname, '..', '..');
const PRIVATE_ROOT = path.join(ROOT, 'work', 'private-system-audio');
const NAME = 's14-system-audio-qualification';
const SECONDS = 48;

class PrivateLoopbackDriver extends AppDriver {
  assertTestProfile() {
    const allowed = path.resolve(PRIVATE_ROOT, 'userdata');
    const target = path.resolve(this.userDataDir);
    if (!target.startsWith(allowed + path.sep)) throw new Error('Loopback profile must remain inside private test userdata');
  }
}

function readEndpoints() {
  const helper = path.join(ROOT, 'resources', 'sysloopback', 'win-x64', 'sysloopback.exe');
  const output = execFileSync(helper, ['--list'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const devices = [], defaults = {};
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.event === 'device') {
      const separator = event.detail.lastIndexOf(' :: ');
      if (separator < 0) throw new Error('Invalid native endpoint identity');
      devices.push({ name: event.detail.slice(0, separator), id: event.detail.slice(separator + 4) });
    }
    if (event.event === 'default') {
      const separator = event.detail.indexOf(' :: ');
      defaults[event.detail.slice(0, separator)] = event.detail.slice(separator + 4);
    }
  }
  for (const role of ['console', 'multimedia', 'communications']) {
    const matches = devices.filter(device => device.name === defaults[role]);
    if (matches.length !== 1) throw new Error('Cannot uniquely identify default ' + role + ' endpoint');
    defaults[role] = matches[0];
  }
  // Playout uses the unchanged default WebAudio destination. Requiring console
  // and multimedia to agree removes any ambiguity about the default role.
  if (defaults.console.id !== defaults.multimedia.id) throw new Error('Console/multimedia defaults differ; this bounded qualification requires a shared default');
  return { devices, defaults };
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

function chunksIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? chunksIn(file) : entry.isFile() && /^chunk_\d+\.webm$/.test(entry.name) ? [file] : [];
  });
}

// Installed before login/RecordPage mounts. Microphone requests NEVER reach the
// native API; only desktop-loopback requests pass through, unchanged. The zero
// source is never connected to a speaker, and playback is never connected to a
// MediaStream destination or to the recording graph.
function installLoopbackFixture({ apiUrl }) {
  if (window.__windowsLoopbackQualification) return;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl).hostname)) throw new Error('Loopback fixture requires localhost');
  const devices = navigator.mediaDevices;
  const originalGet = devices.getUserMedia;
  const originalStart = MediaRecorder.prototype.start;
  const issued = [], desktopCalls = [], recorders = [], samples = [], errors = [];
  let zeroContext, zeroSource, zeroDestination, playbackContext, playbackSource, playbackBuffer;
  let playback = null, disposed = false;
  const trace = async stage => {
    await window.electronAPI.systemAudio.diag('info', '[s14 output] ' + stage);
  };
  const validated = Promise.resolve().then(async () => {
    if (await window.electronAPI.config.getApiUrl() !== apiUrl) throw new Error('Loopback fixture backend mismatch');
  });
  validated.catch(error => errors.push(error.message));
  devices.getUserMedia = async function (constraints) {
    await validated;
    if (disposed) throw new Error('Loopback fixture disposed');
    if (constraints?.audio?.mandatory?.chromeMediaSource === 'desktop') {
      const call = { at: performance.now(), constraints };
      desktopCalls.push(call);
      try {
        const stream = await Reflect.apply(originalGet, devices, [constraints]);
        call.tracks = stream.getTracks().map(track => ({ kind: track.kind, id: track.id, settings: track.getSettings() }));
        return stream;
      } catch (error) { call.error = error.name + ': ' + error.message; throw error; }
    }
    if (!constraints?.audio || constraints.video) throw new Error('Unexpected non-microphone acquisition');
    if (!zeroContext) {
      zeroContext = new AudioContext({ sampleRate: 48000 });
      zeroDestination = zeroContext.createMediaStreamDestination();
      zeroSource = zeroContext.createConstantSource();
      zeroSource.offset.value = 0;
      zeroSource.connect(zeroDestination); zeroSource.start();
      // A blocked resume cannot open a hardware microphone or emit sound.
      zeroContext.resume().catch(error => errors.push('Zero input context: ' + error.message));
    }
    const stream = zeroDestination.stream.clone();
    stream.getAudioTracks().forEach(track => { track.enabled = false; });
    issued.push(stream);
    return stream;
  };
  MediaRecorder.prototype.start = function (...args) {
    const entry = { events: 0, bytes: 0, startedAt: null, stoppedAt: null };
    recorders.push(entry);
    this.addEventListener('start', event => { entry.startedAt = event.timeStamp; });
    this.addEventListener('stop', event => { entry.stoppedAt = event.timeStamp; });
    this.addEventListener('dataavailable', event => { entry.events++; entry.bytes += event.data?.size || 0; });
    return Reflect.apply(originalStart, this, args);
  };
  const snapshot = () => {
    const store = (window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia)?.state?.value?.recording;
    const tracks = issued.flatMap(stream => stream.getAudioTracks()).filter(track => track.readyState === 'live');
    return { at: performance.now(), phase: store?.phase, playback, desktopCalls, recorders, errors,
      microphoneTracks: tracks.map(track => ({ id: track.id, enabled: track.enabled, readyState: track.readyState })),
      mutedUi: [...document.querySelectorAll('.recording-controls .q-icon')].some(icon => icon.textContent.trim() === 'mic_off'),
      systemAudioActive: Boolean(document.querySelector('.system-audio-indicator')),
      silentWarning: document.querySelector('[data-test=system-audio-silent-warning]')?.textContent?.trim() || null,
      routingWarning: document.querySelector('[data-test=system-audio-routing-warning]')?.textContent?.trim() || null };
  };
  window.__windowsLoopbackQualification = {
    snapshot: () => ({ ...snapshot(), samples }),
    prepare: async base64 => {
      await validated;
      if (disposed || playbackContext) throw new Error('Output preparation must run once');
      await trace('creating default output context before capture');
      playbackContext = new AudioContext({ sampleRate: 48000 });
      await trace('resuming default output context');
      await playbackContext.resume();
      if (disposed || playbackContext.state !== 'running') throw new Error('Output AudioContext did not become ready');
      if ('sinkId' in playbackContext && !['', 'default'].includes(playbackContext.sinkId)) throw new Error('Unexpected non-default output sink');
      await trace('converting numbered WAV bytes before capture (PCM createBuffer variant)');
      const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
      await trace('base64 conversion complete; validating strict PCM WAV');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const tag = (offset, expected) => [...expected].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
      if (bytes.length !== 44 + 48 * 48000 * 2 || !tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data') ||
          view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16 ||
          view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 48000 ||
          view.getUint32(28, true) !== 96000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
          view.getUint32(40, true) !== bytes.length - 44) {
        throw new Error('Expected exactly 48 seconds of RIFF PCM16 mono 48000Hz with a standard 44-byte header');
      }
      // Explicit fixture variant: Electron 28 crashed inside the former async
      // WAV decode preparation before recording. Copy the same signed PCM
      // samples synchronously; this is not a production/runtime fix.
      playbackBuffer = playbackContext.createBuffer(1, (bytes.length - 44) / 2, 48000);
      const channel = playbackBuffer.getChannelData(0);
      for (let sample = 0; sample < channel.length; sample++) channel[sample] = view.getInt16(44 + sample * 2, true) / 32768;
      await trace('PCM parse/copy complete; numbered samples unchanged');
      if (disposed || playbackBuffer.duration !== 48) throw new Error('Unexpected playback reference duration');
      await trace('output ready; no signal scheduled yet');
      return { method: 'pcm-createBuffer-v1', duration: playbackBuffer.duration, state: playbackContext.state, outputSink: playbackContext.sinkId ?? 'default' };
    },
    play: async () => {
      const state = snapshot();
      if (disposed || playback || state.phase !== 'recording' || !state.mutedUi || !state.microphoneTracks.length ||
          state.microphoneTracks.some(track => track.enabled) || !desktopCalls.some(call => call.tracks?.some(track => track.kind === 'audio'))) {
        throw new Error('Playout requires verified muted zero microphone and real desktop audio acquisition');
      }
      if (!playbackBuffer || playbackContext?.state !== 'running') throw new Error('Prepare the output source before capture');
      await trace('connecting prepared source to real default output');
      playbackSource = playbackContext.createBufferSource(); playbackSource.buffer = playbackBuffer;
      // This changes only this test's generated signal, never a Windows device
      // volume. The coded reference remains identifiable at this attenuation.
      const gain = playbackContext.createGain(); gain.gain.value = 0.25;
      playbackSource.connect(gain).connect(playbackContext.destination);
      const scheduledAt = playbackContext.currentTime + 0.25;
      playback = { startedAt: performance.now() + (scheduledAt - playbackContext.currentTime) * 1000,
        duration: playbackBuffer.duration, endedAt: null, outputSink: playbackContext.sinkId ?? 'default',
        baseLatency: playbackContext.baseLatency, outputLatency: playbackContext.outputLatency, outputGain: 0.25 };
      playbackSource.onended = () => { playback.endedAt = performance.now(); };
      playbackSource.start(scheduledAt);
      await trace('numbered output scheduled for 48 seconds');
      return playback;
    },
    dispose: () => {
      disposed = true; clearInterval(timer);
      devices.getUserMedia = originalGet; MediaRecorder.prototype.start = originalStart;
      try { playbackSource?.stop(); zeroSource?.stop(); } catch (_) { /* already stopped */ }
      for (const stream of issued) stream.getTracks().forEach(track => track.stop());
      zeroDestination?.stream.getTracks().forEach(track => track.stop());
      zeroContext?.close().catch(() => {}); playbackContext?.close().catch(() => {});
    },
  };
  const timer = setInterval(() => { if (playback && !playback.endedAt) samples.push(snapshot()); }, 500);
}

async function runSystemAudioQualification() {
  const result = { name: NAME, pass: false, problems: [], notes: [
    'LOCAL PRIVATE EVIDENCE: real WASAPI loopback can include other Windows playback; never publish these artifacts.',
    'Microphone requests use disabled zero-valued WebAudio tracks; no hardware microphone is acquired.',
    'Qualifies unchanged default Windows output through native Chromium desktop capture, recording, finalization and localhost upload.',
    'Playout fixture uses strict PCM WAV parsing and createBuffer; earlier async decode preparation crashed before capture. This variant does not fix that runtime crash.',
    'Does not qualify physical USB/Bluetooth switching, the communications endpoint, or the 90-second silence warning lifecycle.',
  ] };
  if (process.platform !== 'win32' || process.env.CI || process.env.GITHUB_ACTIONS) {
    result.problems.push('This private native-audio qualification is Windows local-only and refuses CI');
    console.error(result.problems[0]);
    return result;
  }
  if (!process.env.SUISSE_E2E_APP_DIR && !process.env.SUISSE_E2E_PACKAGED_EXE) {
    result.problems.push('Set SUISSE_E2E_APP_DIR or SUISSE_E2E_PACKAGED_EXE to a frozen build before native qualification');
    console.error(result.problems[0]);
    return result;
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const directory = path.join(PRIVATE_ROOT, runId);
  fs.mkdirSync(directory, { recursive: true });
  const resultFile = path.join(directory, 'result.json');
  const save = () => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  let app, mock;
  try {
    result.endpointsBefore = readEndpoints();
    const reference = buildCodedScenario(NAME, [{ type: 'speech', seconds: SECONDS }], { outputDir: directory });
    result.reference = reference.metaPath;
    mock = await startMockBackend();
    app = new PrivateLoopbackDriver({ name: NAME, apiUrl: mock.url, userDataDir: path.join(PRIVATE_ROOT, 'userdata', runId),
      env: { SUISSE_E2E_HOOKS: '1', SUISSE_TEST_NETWORK_ISOLATION: '1', SUISSE_TEST_FAKE_AUDIO: '' } });
    // Unique private profiles are never moved into the shared CI evidence tree.
    await app.launch({ freshProfile: false });
    if (await app.page.$('[data-test=record-start]')) throw new Error('Fresh private profile unexpectedly authenticated before mic interception');
    await app.page.evaluateOnNewDocument(installLoopbackFixture, { apiUrl: mock.url });
    await app.evalTimed(installLoopbackFixture, { apiUrl: mock.url });
    await app.login();
    if (!(await app.evalTimed(() => window.__windowsLoopbackQualification?.snapshot()))) throw new Error('Microphone interception was lost during login');
    result.systemAudioSupport = await app.evalTimed(() => window.electronAPI.systemAudio.isSupported());
    if (result.systemAudioSupport.platform !== 'win32' || !result.systemAudioSupport.supported) throw new Error('Native Windows system audio is not supported in this app');
    await app.evalTimed(async () => { await window.electronAPI.systemAudio.setEnabled(true); });
    // RecordPage renders record-start before its async microphone enumeration
    // and loadSystemAudioState complete. The toggle is gated by isSupported,
    // so login readiness alone does not imply this control exists yet.
    await app.page.waitForSelector('[data-test=system-audio-toggle]', { visible: true, timeout: 20000 });
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await app.evalTimed(() => Boolean(document.querySelector('.system-audio-active')))) break;
      await app.page.click('[data-test=system-audio-toggle]'); await sleep(500);
    }
    if (!(await app.evalTimed(() => Boolean(document.querySelector('.system-audio-active'))))) throw new Error('System audio toggle did not turn on');
    // Decode before capture: transferring/converting the WAV must not burden
    // the recording renderer during the continuity measurement.
    result.outputPreparation = await app.evalTimed(base64 => window.__windowsLoopbackQualification.prepare(base64),
      fs.readFileSync(reference.wavPath).toString('base64'));
    await app.startRecording();
    const recordId = await app.getRecordId();
    if (!/^[a-f0-9-]{36}$/i.test(recordId)) throw new Error('Invalid private recording identity');
    const recordDir = path.join(app.recordingsDir, recordId);
    await app.evalTimed(() => {
      const button = [...document.querySelectorAll('.recording-controls button')].find(element => element.querySelector('.q-icon')?.textContent.trim() === 'mic');
      if (!button) throw new Error('App microphone mute control unavailable');
      button.click();
    });
    await sleep(500);
    result.beforePlayback = await app.evalTimed(() => window.__windowsLoopbackQualification.snapshot());
    await app.evalTimed(() => window.__windowsLoopbackQualification.play());
    const deadline = performance.now() + (SECONDS + 12) * 1000;
    while (performance.now() < deadline) {
      result.fixture = await app.evalTimed(() => window.__windowsLoopbackQualification.snapshot());
      if (result.fixture.errors.length) throw new Error(result.fixture.errors.join('; '));
      if (!result.fixture.mutedUi || result.fixture.microphoneTracks.some(track => track.enabled)) throw new Error('App microphone mute did not remain active');
      if (result.fixture.phase !== 'recording') throw new Error('Recording ended during system playback');
      if (!result.prefix && result.fixture.at - result.fixture.playback.startedAt > 10000) {
        const files = chunksIn(recordDir).slice(0, 3);
        if (files.length < 2) throw new Error('No persisted recording prefix during native loopback');
        result.prefix = await Promise.all(files.map(async file => ({ file, sha256: await sha256(file) })));
      }
      save();
      if (result.fixture.playback.endedAt) break;
      await sleep(1000);
    }
    if (!result.fixture?.playback?.endedAt) throw new Error('Native playback exceeded bounded deadline');
    await sleep(2000);
    await app.stopRecording(45000);
    result.fixture = await app.evalTimed(() => {
      const state = window.__windowsLoopbackQualification.snapshot();
      window.__windowsLoopbackQualification.dispose(); return state;
    });
    await app.waitForPhase(['uploaded', 'error'], 120000);
    result.phase = await app.getPhase();
    if (result.phase !== 'uploaded') result.problems.push('Local mock upload did not complete');
    const recorder = result.fixture.recorders.at(-1);
    if (!recorder?.bytes || !recorder.events || recorder.startedAt === null || recorder.stoppedAt === null) throw new Error('Missing native MediaRecorder output/timing evidence');
    result.expectedDurationS = (recorder.stoppedAt - recorder.startedAt) / 1000;
    const output = app.findOutputFile();
    if (!output || path.dirname(output) !== recordDir) throw new Error('Missing finalized native loopback audio');
    result.output = output;
    result.audio = await verifyCodedAudio(output, reference, { expectedDurationS: result.expectedDurationS, durationToleranceS: 1.5 });
    result.problems.push(...result.audio.problems);
    if (result.audio.firstFrame !== 0 || result.audio.lastFrame !== SECONDS * 2 - 1 || result.audio.identifiedFrames !== SECONDS * 2) {
      result.problems.push('Native loopback did not preserve every supplied numbered frame, including both reference boundaries');
    }
    result.expectedSourceOffsetS = (recorder.startedAt - result.fixture.playback.startedAt) / 1000;
    if (result.audio.sourceOffsetS === null || Math.abs(result.audio.sourceOffsetS - result.expectedSourceOffsetS) > 1) {
      result.problems.push('Decoded source timing differs from scheduled real output by more than one second');
    }
    result.localSha256 = await sha256(output);
    const receipt = JSON.parse(fs.readFileSync(path.join(recordDir, 'upload-receipt.json'), 'utf8'));
    if (mock.state.uploads.get(receipt.audioFileId)?.sha256 !== result.localSha256) result.problems.push('Mock upload differs from the finalized native loopback file');
    if (receipt.canDelete !== false || receipt.contentVerified !== false) result.problems.push('Native loopback backup retention receipt is incorrect');
    const retained = await Promise.all(chunksIn(recordDir).map(async file => ({ file, sha256: await sha256(file) })));
    result.retainedPrefix = (result.prefix || []).map(original => retained.find(item => item.sha256 === original.sha256) || null);
    if (!result.prefix?.length || result.retainedPrefix.some(item => !item)) result.problems.push('Original persisted prefix changed or disappeared after upload');
    result.endpointsAfter = readEndpoints();
    if (JSON.stringify(result.endpointsBefore.defaults) !== JSON.stringify(result.endpointsAfter.defaults)) result.problems.push('Windows default endpoints changed during qualification');
    if (result.fixture.samples.some(sample => sample.silentWarning)) result.problems.push('Unexpected system-audio silence warning during supplied output');
    result.pass = result.problems.length === 0;
  } catch (error) { result.problems.push(error.stack || error.message); }
  finally {
    result.profile = app?.userDataDir || null; result.resultFile = resultFile;
    if (app) {
      await app.evalTimed(() => window.__windowsLoopbackQualification?.dispose(), undefined, 3000).catch(() => {});
      await app.close({ keepProfile: true }).catch(error => { result.pass = false; result.problems.push('Cleanup: ' + error.message); });
      fs.writeFileSync(path.join(directory, 'app-output.log'), app.log.join(''));
    }
    if (mock) await mock.close().catch(error => { result.pass = false; result.problems.push('Mock cleanup: ' + error.message); });
    save();
  }
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${NAME}: ${result.problems.join('; ') || '96 frames, native loopback, upload hash and retained source verified'}`);
  return result;
}

module.exports = { runSystemAudioQualification, readEndpoints, installLoopbackFixture };
