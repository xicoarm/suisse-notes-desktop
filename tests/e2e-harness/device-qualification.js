'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { AppDriver, sleep } = require('./lib/app-driver');
const { startMockBackend } = require('./lib/mock-backend');
const { buildCodedScenario, WORK_DIR } = require('./lib/audio');
const { verifyCodedAudio } = require('./lib/coded-audio');

const LIMITATIONS = [
  'Synthetic microphone tracks and enumeration qualify application recovery; physical USB/Bluetooth drivers, codec changes and macOS permissions are not exercised.',
  'Microphone loss and zero-signal episodes currently have no dedicated persisted captureWarnings entry. Passing live warning assertions does not establish a durable gap history.',
  'A failed microphone signal probe creates a persistent silent-input toast; current recovery does not dismiss it. Healthy assertions below concern the live health indicator, not every notification.',
];

function evidence(file, result) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
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
    if (entry.isDirectory()) return chunksIn(file);
    // Do not follow symbolic links, or include finalized/combined files.
    return entry.isFile() && /^chunk_\d+\.webm$/.test(entry.name) ? [file] : [];
  });
}

/** Runs in the synthetic renderer only; it never replaces MediaRecorder. */
async function installDeviceFixture({ apiUrl, actions }) {
  if (window.__deviceQualification) throw new Error('Device fixture already installed');
  if (await window.electronAPI.config.getApiUrl() !== apiUrl ||
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl).hostname)) {
    throw new Error('Device fixture requires the isolated local backend');
  }
  if (await window.electronAPI.systemAudio.getEnabled()) {
    throw new Error('Device qualification requires microphone-only capture');
  }
  const devices = navigator.mediaDevices;
  const originalGet = devices.getUserMedia;
  const originalEnumerate = devices.enumerateDevices;
  let anchor = null, opening = null, sourceStartedAt = null, sourceRequestedAt = null;
  let unavailable = false;
  const issued = [], calls = [], events = [], samples = [], errors = [];
  const schedule = actions.map(action => ({ ...action, done: false }));
  const sourceSeconds = () => sourceStartedAt === null ? null : (performance.now() - sourceStartedAt) / 1000;
  const getStore = () => (window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia)?.state?.value?.recording;
  const activeTracks = () => issued.flatMap(item => item.stream.getAudioTracks())
    .filter(track => track.readyState === 'live' && typeof track.onended === 'function');
  const logEvent = value => {
    const event = { sourceSeconds: sourceSeconds(), at: performance.now(), ...value };
    events.push(event);
    console.debug('[synthetic-device] ' + JSON.stringify(event));
  };

  // Keep one real fake-device source alive. Every caller receives a separate
  // native clone: loadMicrophones() stops its permission-probe stream, and
  // switchMicrophoneStream() stops the former recording stream after a swap.
  devices.getUserMedia = async function (constraints) {
    if (!constraints?.audio || constraints.video || constraints.audio?.mandatory?.chromeMediaSource) {
      throw new Error('Unexpected non-microphone acquisition in device qualification');
    }
    const call = { at: performance.now(), sourceSeconds: sourceSeconds(), constraints, unavailable };
    calls.push(call);
    if (unavailable) {
      call.error = 'NotFoundError';
      throw new DOMException('Synthetic microphone disconnected', 'NotFoundError');
    }
    if (!opening) {
      sourceRequestedAt = performance.now();
      opening = Reflect.apply(originalGet, devices, [constraints]).then(stream => {
        anchor = stream;
        sourceStartedAt = performance.now();
        logEvent({ kind: 'source-open', trackId: stream.getAudioTracks()[0]?.id });
        return stream;
      });
    }
    const source = await opening;
    if (unavailable) {
      call.error = 'NotFoundError';
      throw new DOMException('Synthetic microphone disconnected during acquisition', 'NotFoundError');
    }
    const clone = source.clone();
    if (clone.getAudioTracks().length !== 1 || clone.getAudioTracks()[0].readyState !== 'live') {
      throw new Error('Synthetic microphone anchor is not live');
    }
    issued.push({ stream: clone, at: performance.now() });
    call.returnedAt = performance.now();
    call.trackId = clone.getAudioTracks()[0].id;
    call.deviceId = clone.getAudioTracks()[0].getSettings().deviceId;
    call.label = clone.getAudioTracks()[0].label;
    logEvent({ kind: 'acquired-clone', trackId: call.trackId, deviceId: call.deviceId });
    return clone;
  };
  devices.enumerateDevices = async function () {
    const list = await Reflect.apply(originalEnumerate, devices, []);
    const exposed = unavailable ? list.filter(device => device.kind !== 'audioinput') : list;
    logEvent({ kind: 'enumerated', unavailable, inputs: exposed.filter(device => device.kind === 'audioinput').map(device => device.deviceId) });
    return exposed;
  };

  const inject = action => {
    action.done = true;
    const actual = sourceSeconds();
    if (actual - action.at > 0.75) errors.push(`LATE INJECTION: ${action.kind} scheduled ${action.at}s, observed ${actual.toFixed(3)}s`);
    if (getStore()?.phase !== 'recording') {
      errors.push(`INJECTION PRECONDITION: ${action.kind} while phase=${getStore()?.phase}`);
      return;
    }
    if (action.kind === 'disconnect') {
      const tracks = activeTracks();
      if (tracks.length !== 1) {
        errors.push(`INJECTION PRECONDITION: expected one app microphone, found ${tracks.length}`);
        return;
      }
      unavailable = true;
      const track = tracks[0];
      track.stop();
      // stop() changes readyState but does not dispatch ended (W3C). This
      // explicit, untrusted event exercises the app's device-loss handler.
      track.dispatchEvent(new Event('ended'));
      devices.dispatchEvent(new Event('devicechange'));
      logEvent({ kind: action.kind, plannedAt: action.at, trackId: track.id, readyState: track.readyState,
        anchorReadyState: anchor.getAudioTracks()[0].readyState });
    } else {
      unavailable = false;
      devices.dispatchEvent(new Event('devicechange'));
      logEvent({ kind: action.kind, plannedAt: action.at });
    }
  };
  const injectionTimer = setInterval(() => {
    if (sourceStartedAt === null) return;
    for (const action of schedule) if (!action.done && sourceSeconds() >= action.at) {
      try { inject(action); } catch (error) { errors.push('INJECTION ERROR: ' + error.message); }
    }
  }, 50);
  const sample = () => {
    const globals = document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties;
    const translate = (key, params) => globals?.$t?.(key, params) || key;
    const label = activeTracks()[0]?.label || issued.at(-1)?.stream.getAudioTracks()[0]?.label || '';
    samples.push({ sourceSeconds: sourceSeconds(), at: performance.now(), phase: getStore()?.phase,
      badge: document.querySelector('.mic-health-row .q-badge')?.textContent?.trim() || null,
      message: document.querySelector('.mic-health-message')?.textContent?.trim() || null,
      critical: Boolean(document.querySelector('.health-notice--critical')),
      notifications: [...document.querySelectorAll('.q-notification__message')].map(element => element.textContent.trim()),
      labels: { healthy: translate('micHealthOk'), critical: translate('micHealthCritical'),
        disconnected: translate('micHealthTrackEnded'), checking: translate('micHealthVerifying'),
        silent: translate('micHealthZeroSignalSwitchedDesktop', { device: label }),
        silentToast: translate('micSwitchSilentToast', { device: label }),
        switchedToast: translate('micAutoSwitchedToast', { device: label }) },
      activeTrackIds: activeTracks().map(track => track.id), unavailable });
  };
  const samplingTimer = setInterval(sample, 250);
  window.__deviceQualification = {
    snapshot: () => ({ sourceStartedAt, sourceRequestedAt, sourceSeconds: sourceSeconds(), calls, events, samples, errors,
      actions: schedule, anchorState: anchor?.getAudioTracks()[0]?.readyState || null }),
    dispose: () => {
      clearInterval(injectionTimer); clearInterval(samplingTimer);
      devices.getUserMedia = originalGet; devices.enumerateDevices = originalEnumerate;
      for (const item of issued) item.stream.getTracks().forEach(track => track.stop());
      anchor?.getTracks().forEach(track => track.stop());
    },
  };
}

function assessLiveBehavior(kind, fixture, problems) {
  problems.push(...fixture.errors);
  const between = (start, end) => fixture.samples.filter(sample => sample.sourceSeconds >= start && sample.sourceSeconds <= end);
  const healthy = sample => sample.badge === sample.labels.healthy && !sample.critical;
  const requireSome = (start, end, predicate, message) => {
    if (!between(start, end).some(predicate)) problems.push(message);
  };
  requireSome(8, 25, healthy, 'Initial coded microphone did not show Healthy');
  if (between(8, 25).some(sample => !healthy(sample))) problems.push('False microphone warning during initial coded input');
  if (fixture.samples.some(sample => sample.sourceSeconds > 8 && sample.sourceSeconds < (kind === 'reconnect' ? 118 : 88) && sample.phase !== 'recording')) {
    problems.push('Recording stopped or paused during device qualification');
  }
  if (kind === 'reconnect') {
    for (const [drop, reconnect, signal] of [[32, 43, 45], [77, 88, 90]]) {
      const event = fixture.events.find(item => item.kind === 'disconnect' && item.plannedAt === drop);
      if (!event || event.readyState !== 'ended' || event.anchorReadyState !== 'live') problems.push(`Track loss at ${drop}s was not injected with a retained live source`);
      if (!fixture.events.some(item => item.kind === 'reconnect' && item.plannedAt === reconnect)) problems.push(`Reconnect at ${reconnect}s was not injected`);
      requireSome(drop, drop + 5, sample => sample.critical && sample.badge === sample.labels.critical && sample.message === sample.labels.disconnected,
        `No explicit live disconnection warning within five seconds of ${drop}s`);
      if (!fixture.events.some(item => item.kind === 'enumerated' && item.sourceSeconds >= drop && item.sourceSeconds < reconnect && item.inputs.length === 0)) {
        problems.push(`No unavailable-device enumeration observed after ${drop}s`);
      }
      requireSome(signal, signal + 5, healthy, `Microphone health did not recover after signal returned at ${signal}s`);
      requireSome(signal, signal + 8, sample => sample.notifications.includes(sample.labels.switchedToast), `No automatic microphone recovery toast after ${signal}s`);
      const returned = fixture.calls.filter(call => call.trackId && (call.returnedAt - fixture.sourceStartedAt) / 1000 >= reconnect &&
        (call.returnedAt - fixture.sourceStartedAt) / 1000 < signal + 5);
      if (!returned.some(call => call.trackId !== event?.trackId)) problems.push(`No fresh replacement microphone acquired after ${reconnect}s`);
    }
    requireSome(98, 115, healthy, 'Second replacement did not remain healthy');
  } else {
    requireSome(45, 51, sample => sample.badge !== sample.labels.healthy, 'No zero-signal warning/check within 21 seconds of digital silence');
    requireSome(49, 58, sample => sample.critical && sample.badge === sample.labels.critical && sample.message === sample.labels.silent,
      'Same-device reacquisition did not expose the failed signal probe in live health UI');
    requireSome(49, 58, sample => sample.notifications.includes(sample.labels.silentToast), 'No failed microphone signal-probe notification');
    requireSome(63, 68, healthy, 'Live microphone health did not recover after coded signal returned');
    if (between(68, 85).some(sample => !healthy(sample))) problems.push('Live microphone health was unstable after signal recovery');
    const replacements = fixture.calls.filter(call => call.trackId && call.sourceSeconds >= 40 && call.sourceSeconds <= 59);
    if (replacements.length !== 1) problems.push(`Expected one same-device reacquisition during zeros, observed ${replacements.length}`);
    const first = fixture.calls.find(call => call.trackId);
    if (replacements.some(call => call.deviceId !== first?.deviceId)) problems.push('Zero-signal recovery switched away from the original device');
    if (fixture.events.some(event => event.kind === 'disconnect' || event.unavailable)) problems.push('Zero-signal case unexpectedly removed its microphone');
  }
}

async function deviceCase(kind) {
  const name = 's12-' + kind;
  const seconds = kind === 'reconnect' ? 120 : 90;
  // Padding prevents fake-device EOF/looping during stop. Faults lie strictly
  // inside planned zeros, so the coded oracle needs no missing-frame waiver.
  const plan = kind === 'reconnect'
    ? [{ type: 'speech', seconds: 30 }, { type: 'zeros', seconds: 15 }, { type: 'speech', seconds: 30 },
      { type: 'zeros', seconds: 15 }, { type: 'speech', seconds: 45 }]
    : [{ type: 'speech', seconds: 30 }, { type: 'zeros', seconds: 30 }, { type: 'speech', seconds: 45 }];
  const reference = buildCodedScenario(name, plan);
  const actions = kind === 'reconnect' ? [
    { kind: 'disconnect', at: 32 }, { kind: 'reconnect', at: 43 },
    { kind: 'disconnect', at: 77 }, { kind: 'reconnect', at: 88 },
  ] : [];
  const result = { name, pass: false, problems: [], notes: [...LIMITATIONS], reference: reference.metaPath, progress: [], screenshots: [] };
  const file = path.join(WORK_DIR, 'qualification', name + '.json');
  let app, mock;
  try {
    mock = await startMockBackend();
    app = new AppDriver({ name, apiUrl: mock.url, fakeAudioWav: reference.wavPath,
      env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
    app.assertTestProfile();
    await app.launch();
    await app.login();
    await app.evalTimed(installDeviceFixture, { apiUrl: mock.url, actions });
    await app.startRecording();
    const recordId = await app.getRecordId();
    if (!/^[a-f0-9-]{36}$/i.test(recordId)) throw new Error('Unexpected synthetic recording ID');
    const recordDir = path.join(app.recordingsDir, recordId);
    const deadline = performance.now() + (seconds + 15) * 1000;
    const screenshotAt = kind === 'reconnect' ? [36, 48, 81, 94] : [53, 68];
    let screenshotIndex = 0;
    while (performance.now() <= deadline) {
      result.fixture = await app.evalTimed(() => window.__deviceQualification.snapshot());
      const elapsed = result.fixture.sourceSeconds;
      if (elapsed === null) throw new Error('Microphone source never started');
      if (result.fixture.errors.length) throw new Error(result.fixture.errors.join('; '));
      if (!result.prefix && elapsed >= 10) {
        const files = chunksIn(recordDir).sort((a, b) => Number(path.basename(a).match(/\d+/)[0]) - Number(path.basename(b).match(/\d+/)[0])).slice(0, 3);
        if (files.length < 2) throw new Error('Fewer than two persisted prefix chunks before fault injection');
        result.prefix = await Promise.all(files.map(async filename => ({ file: filename, sha256: await sha256(filename) })));
      }
      if (screenshotIndex < screenshotAt.length && elapsed >= screenshotAt[screenshotIndex]) {
        result.screenshots.push(await app.screenshot(name + '-' + screenshotAt[screenshotIndex++]));
      }
      result.progress.push({ sourceSeconds: elapsed, disk: app.captureDiskProgress() });
      evidence(file, result);
      if (elapsed >= seconds) break;
      await sleep(1000);
    }
    if (result.fixture.sourceSeconds < seconds) throw new Error('Device capture exceeded its bounded recording deadline');
    await app.stopRecording(45000);
    // Stop diagnostic sampling before processing/upload phases; retain copies
    // already observed. Native app capture has already completed its stop.
    result.fixture = await app.evalTimed(() => {
      const snapshot = window.__deviceQualification.snapshot();
      window.__deviceQualification.dispose();
      return snapshot;
    });
    assessLiveBehavior(kind, result.fixture, result.problems);
    await app.waitForPhase(['uploaded', 'error'], 120000);
    result.phase = await app.getPhase();
    if (result.phase !== 'uploaded') result.problems.push('Recording did not finish uploading to the local mock');
    result.capture = await app.evalTimed(() => window.__suisseCaptureDiagnostics?.snapshot());
    const recorder = result.capture?.recorders?.at(-1);
    if (!recorder?.bytes || !recorder.events || recorder.startedAt == null || recorder.stoppedAt == null) throw new Error('Missing native recorder output/timing evidence');
    result.expectedDurationS = (recorder.stoppedAt - recorder.startedAt) / 1000;
    const output = app.findOutputFile();
    if (!output || path.dirname(output) !== recordDir) throw new Error('Missing finalized audio for this recording; original profile retained');
    result.output = output;
    result.audio = await verifyCodedAudio(output, reference, { expectedDurationS: result.expectedDurationS, durationToleranceS: 1.5 });
    result.problems.push(...result.audio.problems);
    result.expectedSourceOffsetS = (recorder.startedAt - result.fixture.sourceStartedAt) / 1000;
    result.sourceClockErrorS = Math.abs(result.audio.sourceOffsetS - result.expectedSourceOffsetS);
    // Check the acquisition clock against actual decoded identities. If it is
    // inaccurate, classify the schedule as invalid instead of widening zeros.
    if (result.audio.sourceOffsetS === null || result.sourceClockErrorS > 0.75) result.problems.push('SOURCE CLOCK MISMATCH: decoded audio does not validate the injection clock within 0.75 seconds');
    if (result.expectedSourceOffsetS < -0.1 || result.expectedSourceOffsetS > 3) result.problems.push('SOURCE CLOCK PRECONDITION: capture did not start within three seconds of source acquisition');
    result.localSha256 = await sha256(output);
    const receipt = JSON.parse(fs.readFileSync(path.join(recordDir, 'upload-receipt.json'), 'utf8'));
    if (mock.state.uploads.get(receipt.audioFileId)?.sha256 !== result.localSha256) result.problems.push('Mock upload bytes differ from finalized audio');
    if (receipt.canDelete !== false || receipt.contentVerified !== false) result.problems.push('Local backup retention receipt is incorrect');
    result.retainedPrefix = [];
    const retained = await Promise.all(chunksIn(recordDir).map(async filename => ({ file: filename, sha256: await sha256(filename) })));
    for (const original of result.prefix || []) {
      const match = retained.find(candidate => candidate.sha256 === original.sha256);
      if (!match) result.problems.push('Persisted prefix source changed or disappeared: ' + path.basename(original.file));
      else result.retainedPrefix.push(match);
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(recordDir, 'metadata.json'), 'utf8'));
    result.captureWarnings = metadata.captureWarnings || [];
    result.staleSilentToastAfterRecovery = kind === 'zero-input' && result.fixture.samples.some(sample =>
      sample.sourceSeconds >= 68 && sample.badge === sample.labels.healthy && sample.notifications.includes(sample.labels.silentToast));
    result.pass = result.problems.length === 0;
  } catch (error) {
    result.problems.push(error.stack || error.message);
  } finally {
    result.diagnostics = app?.diagnosticsDir || null;
    result.profile = app?.userDataDir || null;
    evidence(file, result);
    if (app) await app.close({ keepProfile: true }).catch(error => { result.problems.push('App cleanup: ' + error.message); result.pass = false; });
    if (mock) await mock.close().catch(error => { result.problems.push('Mock cleanup: ' + error.message); result.pass = false; });
    evidence(file, result);
  }
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${name}: ${result.problems.join('; ') || 'live recovery, planned silence, uploaded bytes and original prefix retention verified'}`);
  return result;
}

async function runDeviceQualification() {
  const results = [];
  for (const kind of ['reconnect', 'zero-input']) results.push(await deviceCase(kind));
  return { pass: results.every(result => result.pass),
    problems: results.flatMap(result => result.problems.map(problem => result.name + ': ' + problem)),
    notes: [...LIMITATIONS], results };
}

module.exports = { runDeviceQualification };
