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
const { installRecordingRoleObserver } = require('./lib/native-recorder-evidence');
const { inspectNativeSources } = require('../../src-electron/native-source-persistence');
const { concatenateFiles } = require('../../src-electron/durable-files');
const { readFinalizedRecording } = require('../../src-electron/recording-persistence');

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

function assessNativeLoopbackTimeline(sources, evidence, fixture, stopped = true) {
  const records = evidence?.records || [], mixed = records.filter(record => record.role === 'live-mix');
  const native = records.filter(record => record.role === 'native-input');
  const desktop = fixture?.desktopCalls || [];
  if (records.length !== 3 || mixed.length !== 1 || native.length !== 2 || sources.length !== 2 ||
      !Number.isFinite(fixture?.playback?.startedAt) ||
      desktop.length !== 1 || desktop[0].error || desktop[0].tracks?.filter(track => track.kind === 'audio').length !== 1) {
    throw new Error('Native loopback requires one microphone, one system source and one live mix without rebinds');
  }
  const systemId = desktop[0].tracks.find(track => track.kind === 'audio').id;
  const micIds = new Set(fixture.microphoneTrackIds || []);
  const microphone = native.filter(record => record.trackIds?.length === 1 && micIds.has(record.trackIds[0]));
  const system = native.filter(record => record.trackIds?.length === 1 && record.trackIds[0] === systemId);
  if (microphone.length !== 1 || system.length !== 1 || microphone[0] === system[0]) throw new Error('Ambiguous native microphone/system input identity');
  for (const record of records) {
    if (record.trackIds?.length !== 1 || record.timesliceMs !== 1000 || !Number.isFinite(record.startCalledAt) ||
        record.state !== (stopped ? 'inactive' : 'recording') ||
        (stopped && (!record.bytes || !record.events || !Number.isFinite(record.startedAt) ||
          !Number.isFinite(record.stoppedAt) || record.stoppedAt < record.startCalledAt || record.convertedBytes !== record.bytes))) {
      throw new Error('Missing native loopback recorder lifecycle, timeslice or converted bytes');
    }
  }
  const origin = microphone[0].startCalledAt, used = new Set();
  const nativeIds = new Set(native.map(record => record.trackIds[0]));
  const nativeStops = (fixture.recorderStops || []).filter(call => call.trackIds?.length === 1 && nativeIds.has(call.trackIds[0]));
  // Both lanes share a frozen meeting endpoint. Native stop() calls happen
  // sequentially and may take different amounts of time to return.
  const stopOffsetMs = stopped ? Math.min(...nativeStops.map(call => call.at)) - origin : null;
  const epochs = sources.map(source => {
    const record = source.kind === 'microphone' ? microphone[0] : source.kind === 'system' ? system[0] : null;
    if (!record || used.has(source.kind) || !source.started || source.gaps.length || source.terminalMismatch ||
        !Number.isFinite(source.startOffsetMs) || source.startOffsetMs < 0 ||
        Math.abs(record.startCalledAt - origin - source.startOffsetMs) > 2 ||
        (stopped && (!source.complete || source.interrupted || source.reason !== 'stopped' || !Number.isFinite(source.endOffsetMs)))) {
      throw new Error('Native loopback epoch cannot be matched to its source and active timeline');
    }
    used.add(source.kind);
    if (stopped) {
      const stops = (fixture.recorderStops || []).filter(call => call.trackIds?.length === 1 &&
        call.trackIds[0] === record.trackIds[0] && call.at >= record.startCalledAt && call.at <= record.stoppedAt);
      if (stops.length !== 1 || !Number.isFinite(stopOffsetMs) || Math.abs(stopOffsetMs - source.endOffsetMs) > 2 ||
          source.endOffsetMs < source.startOffsetMs || source.chunkCount !== record.events - record.emptyEvents ||
          source.chunks.reduce((total, chunk) => total + chunk.size, 0) !== record.bytes ||
          source.chunks.some((chunk, index) => chunk.index !== index)) {
        throw new Error('Native loopback terminal clock or saved chunks differ from its recorder');
      }
    }
    return { sourceId: source.sourceId, kind: source.kind, recorderId: record.id, trackId: record.trackIds[0],
      startCalledAt: record.startCalledAt, startOffsetMs: source.startOffsetMs, endOffsetMs: source.endOffsetMs };
  });
  return { epochs, origin, expectedDurationS: stopped ? stopOffsetMs / 1000 : null,
    expectedSourceOffsetS: (origin - fixture.playback.startedAt) / 1000,
    systemExpectedSourceOffsetS: (system[0].startCalledAt - fixture.playback.startedAt) / 1000 };
}

async function snapshotLoopbackCustody(recordDir, sources, limit = Infinity) {
  const describe = async file => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid native custody file');
    return { relativePath: path.relative(recordDir, file).split(path.sep).join('/'), bytes: stat.size, sha256: await sha256(file) };
  };
  return Promise.all(sources.map(async source => ({ sourceId: source.sourceId, kind: source.kind, startOffsetMs: source.startOffsetMs,
    metadata: await Promise.all([source.manifestPath, source.startedPath, source.endPath].filter(Boolean).map(describe)),
    chunks: await Promise.all(source.chunks.slice(0, limit).map(async chunk => {
      const item = { index: chunk.index, ...await describe(chunk.path) };
      if (item.relativePath !== `native-sources/${source.sourceId}/chunks/chunk_${chunk.index}.webm`) throw new Error('Native custody source/index path mismatch');
      return item;
    })) })));
}

function verifyLoopbackCustody(expected, retained, allowAdditionalChunks = true) {
  const byId = new Map(retained.map(source => [source.sourceId, source]));
  if (byId.size !== retained.length || retained.length !== expected.length) throw new Error('Native source custody inventory changed');
  for (const source of expected) {
    const current = byId.get(source.sourceId);
    if (!current || current.kind !== source.kind || current.startOffsetMs !== source.startOffsetMs) throw new Error('Native source custody identity changed');
    for (const field of ['metadata', 'chunks']) {
      const items = new Map(current[field].map(item => [item.relativePath, item]));
      if (items.size !== current[field].length || (field === 'chunks' && !allowAdditionalChunks && current[field].length !== source[field].length)) throw new Error('Native custody entries changed');
      for (const item of source[field]) {
        const actual = items.get(item.relativePath);
        if (!actual || actual.index !== item.index || actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw new Error('Native source bytes or metadata changed: ' + item.relativePath);
      }
    }
  }
}

function assessNativeLoopbackPublication(finalized, plan, timeline, output) {
  const ids = timeline.epochs.map(epoch => epoch.sourceId).sort();
  const sameIds = value => Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify(ids);
  if (finalized?.version !== 3 || finalized.sourceMode !== 'native' || finalized.recovered !== false ||
      finalized.systemPcmIncluded !== false || !sameIds(finalized.sourceIds) || finalized.sha256 !== output.sha256 ||
      finalized.size !== output.bytes || finalized.filename !== 'audio.webm') throw new Error('Final publication does not cover both native loopback sources');
  if (plan?.version !== 1 || plan.recovery !== false || plan.systemPcmIncluded !== false || !sameIds(plan.sourceIds) ||
      plan.codecPolicy !== 'opus-cbr-192k-20ms-reencoded-from-native-sources' || plan.mixingPolicy !== 'unity-sum-no-limiter' ||
      plan.onsetIsApproximate !== true || plan.sampleRate !== 48000 || plan.channels !== 2 ||
      JSON.stringify((plan.lanes || []).map(lane => lane.kind).sort()) !== JSON.stringify(['microphone', 'system']) ||
      !sameIds(plan.sourceEvidence?.map(source => source.sourceId)) || plan.validation?.status !== 'passed' ||
      !Number.isSafeInteger(plan.totalSamples) || plan.totalSamples <= 0 || plan.validation.expectedDecodedSamples !== plan.totalSamples ||
      !Number.isFinite(plan.validation.observedDecodedSamples) || Math.abs(plan.validation.observedDecodedSamples - plan.totalSamples) > 1 ||
      !Number.isFinite(finalized.duration) || Math.abs(finalized.duration - plan.validation.observedDecodedSamples / 48000) > 1 / 48000) {
    throw new Error('Native loopback assembly plan lacks two validated source lanes');
  }
  for (const epoch of timeline.epochs) {
    const source = plan.sourceEvidence.find(item => item.sourceId === epoch.sourceId);
    if (source.kind !== epoch.kind || source.startOffsetMs !== epoch.startOffsetMs || source.endOffsetMs !== epoch.endOffsetMs || source.interrupted) {
      throw new Error('Native loopback assembly changed a source timeline');
    }
  }
}

function requireNumberedLoopbackFrames(audio) {
  if (audio.firstFrame !== 0 || audio.lastFrame !== SECONDS * 2 - 1 || audio.identifiedFrames !== SECONDS * 2) {
    throw new Error('Native loopback did not preserve every supplied numbered frame, including both reference boundaries');
  }
}

// Installed before login/RecordPage mounts. Microphone requests NEVER reach the
// native API; only desktop-loopback requests pass through, unchanged. The zero
// source uses an explicit AudioData sample clock, never WebAudio or a speaker.
// Playback is never connected to a MediaStream destination or the recording graph.
function installLoopbackFixture({ apiUrl }) {
  if (window.__windowsLoopbackQualification) return;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl).hostname)) throw new Error('Loopback fixture requires localhost');
  const performance = window.performance;
  const devices = navigator.mediaDevices;
  const originalGet = devices.getUserMedia;
  const originalStart = MediaRecorder.prototype.start;
  const originalStop = MediaRecorder.prototype.stop;
  const issued = [], generators = [], desktopCalls = [], recorders = [], recorderStops = [], samples = [], errors = [];
  let playbackContext, playbackSource, playbackBuffer;
  let playback = null, disposed = false, disposalPromise;
  const generatorFeatures = { generator: typeof window.MediaStreamTrackGenerator, audioData: typeof window.AudioData,
    userAgent: navigator.userAgent, mechanism: 'timestamped-zero-generator-v1' };
  const silentStream = () => {
    if (generatorFeatures.generator !== 'function' || generatorFeatures.audioData !== 'function') {
      throw new Error('Timestamped silent microphone fixture requires MediaStreamTrackGenerator and AudioData; hardware fallback is forbidden');
    }
    const track = new window.MediaStreamTrackGenerator({ kind: 'audio' });
    track.enabled = false;
    let writer, stream;
    try { writer = track.writable.getWriter(); stream = new MediaStream([track]); }
    catch (error) {
      track.stop();
      try { Promise.resolve(writer?.abort()).catch(() => {}); writer?.releaseLock(); } catch (_) { /* startup failed */ }
      throw error;
    }
    const source = { track, writer, startedAt: performance.now(), framesWritten: 0, maxLatenessMs: 0,
      stoppedAt: null, active: true, timer: null, wake: null, done: null, failure: null };
    generators.push(source); issued.push(stream);
    const stop = () => {
      if (!source.active) return;
      source.active = false; source.stoppedAt = performance.now();
      clearTimeout(source.timer); source.wake?.(); source.wake = null;
      try { track.stop(); } catch (_) { /* continue releasing writer resources */ }
      // Abort is initiated synchronously. A pending write is independently
      // bounded below, so disposal cannot leave a producer awaiting forever.
      try { Promise.resolve(writer.abort()).catch(() => {}); } catch (_) { /* write deadline still bounds disposal */ }
    };
    source.stop = stop;
    source.done = (async () => {
      const zero = new Float32Array(480);
      try {
        while (source.active && !disposed && track.readyState === 'live') {
          if (source.framesWritten >= 12000) throw new Error('Silent generator exceeded its 120-second sample budget');
          const target = source.startedAt + source.framesWritten * 10;
          const delay = target - performance.now();
          if (delay > 0) await new Promise(resolve => { source.wake = resolve; source.timer = setTimeout(resolve, delay); });
          source.wake = null; source.timer = null;
          if (!source.active || disposed || track.readyState !== 'live') break;
          const lateness = performance.now() - target;
          source.maxLatenessMs = Math.max(source.maxLatenessMs, lateness);
          if (lateness > 250) throw new Error('Silent generator pacing exceeded 250ms');
          const audio = new window.AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: 480,
            numberOfChannels: 1, timestamp: 1000000 + source.framesWritten * 10000, data: zero });
          let deadline;
          try {
            await Promise.race([writer.write(audio), new Promise((_, reject) => {
              deadline = setTimeout(() => reject(new Error('Silent generator write exceeded 1000ms')), 1000);
            })]);
            source.framesWritten++;
          } finally { clearTimeout(deadline); audio.close(); }
        }
      } catch (error) {
        if (!disposed && source.active && track.readyState === 'live') {
          source.failure = error.message;
          if (errors.length < 20) errors.push('Timestamped zero input: ' + error.message);
        }
      } finally {
        stop();
        try { writer.releaseLock(); } catch (_) { /* pending abort owns its remaining settlement */ }
      }
    })();
    return stream;
  };
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
    return silentStream();
  };
  MediaRecorder.prototype.start = function (...args) {
    const entry = { events: 0, bytes: 0, startedAt: null, stoppedAt: null };
    recorders.push(entry);
    this.addEventListener('start', event => { entry.startedAt = event.timeStamp; });
    this.addEventListener('stop', event => { entry.stoppedAt = event.timeStamp; });
    this.addEventListener('dataavailable', event => { entry.events++; entry.bytes += event.data?.size || 0; });
    return Reflect.apply(originalStart, this, args);
  };
  MediaRecorder.prototype.stop = function (...args) {
    recorderStops.push({ at: performance.now(), trackIds: this.stream.getAudioTracks().map(track => track.id) });
    return Reflect.apply(originalStop, this, args);
  };
  const snapshot = () => {
    const store = (window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia)?.state?.value?.recording;
    const tracks = issued.flatMap(stream => stream.getAudioTracks()).filter(track => track.readyState === 'live');
    return { at: performance.now(), phase: store?.phase, playback, desktopCalls, recorders, recorderStops, errors,
      generatorFeatures, generators: generators.map(source => ({ trackId: source.track.id, startedAt: source.startedAt,
        stoppedAt: source.stoppedAt, active: source.active, framesWritten: source.framesWritten,
        sampleClockSeconds: source.framesWritten / 100, maxLatenessMs: source.maxLatenessMs, failure: source.failure,
        enabled: source.track.enabled, readyState: source.track.readyState })),
      microphoneTrackIds: issued.flatMap(stream => stream.getAudioTracks().map(track => track.id)),
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
      if (disposed) return disposalPromise;
      disposed = true; clearInterval(timer);
      devices.getUserMedia = originalGet; MediaRecorder.prototype.start = originalStart;
      MediaRecorder.prototype.stop = originalStop;
      try { playbackSource?.stop(); } catch (_) { /* already stopped */ }
      for (const source of generators) source.stop();
      playbackContext?.close().catch(() => {});
      disposalPromise = Promise.allSettled(generators.map(source => source.done));
      return disposalPromise;
    },
  };
  const timer = setInterval(() => { if (playback && !playback.endedAt) samples.push(snapshot()); }, 500);
}

async function runSystemAudioQualification() {
  const result = { name: NAME, pass: false, problems: [], notes: [
    'LOCAL PRIVATE EVIDENCE: real WASAPI loopback can include other Windows playback; never publish these artifacts.',
    'Microphone requests use disabled timestamped all-zero MediaStreamTrackGenerator/AudioData tracks; no hardware microphone or microphone WebAudio graph is acquired.',
    'Silent generator probe zero-generator-vSDlwV on Electron 28.3.3 / Chromium 120.0.6099.291 produced exactly 12s of zero PCM with no timestamp overlaps/gaps. Each source uses 480 samples/10ms, a 120s sample budget, 250ms pacing and 1000ms write deadlines; current runtime features are recorded.',
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
    result.nativeArchiveExpected = await app.evalTimed(() => typeof window.electronAPI.recording.beginSource === 'function');
    result.captureMode = result.nativeArchiveExpected ? 'native-sources-v1' : 'legacy-live-mix';
    if (result.nativeArchiveExpected) {
      await app.page.evaluateOnNewDocument(installRecordingRoleObserver);
      await app.evalTimed(installRecordingRoleObserver);
      result.notes.push('Native mode requires microphone and system source epochs plus a live mix. The microphone lane is silent; simultaneous audible microphone/system fidelity is not qualified.');
    }
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
        const files = chunksIn(recordDir).filter(file => !path.relative(recordDir, file).startsWith('native-sources' + path.sep)).slice(0, 3);
        if (files.length < 2) throw new Error('No persisted recording prefix during native loopback');
        result.prefix = await Promise.all(files.map(async file => ({ file, sha256: await sha256(file) })));
        if (result.nativeArchiveExpected) {
          const sources = inspectNativeSources(recordDir);
          const roles = await app.evalTimed(() => window.__recordingRoleEvidence.snapshot());
          assessNativeLoopbackTimeline(sources, roles, result.fixture, false);
          if (sources.some(source => source.chunkCount < 2)) throw new Error('Both native lanes need an observed persisted prefix');
          result.nativePrefix = await snapshotLoopbackCustody(recordDir, sources, 3);
        }
      }
      save();
      if (result.fixture.playback.endedAt) break;
      await sleep(1000);
    }
    if (!result.fixture?.playback?.endedAt) throw new Error('Native playback exceeded bounded deadline');
    await sleep(2000);
    await app.stopRecording(45000);
    result.fixture = await app.evalTimed(async () => {
      const state = window.__windowsLoopbackQualification.snapshot();
      state.recorderRoles = window.__recordingRoleEvidence?.snapshot();
      await window.__windowsLoopbackQualification.dispose();
      state.generatorCleanup = window.__windowsLoopbackQualification.snapshot().generators;
      return state;
    });
    if (result.fixture.errors.length) throw new Error(result.fixture.errors.join('; '));
    if (result.fixture.generatorCleanup.some(source => source.active || source.readyState !== 'ended' || source.failure)) {
      throw new Error('Timestamped silent microphone fixture failed or did not finish cleanup');
    }
    await app.waitForPhase(['uploaded', 'error'], 120000);
    result.phase = await app.getPhase();
    if (result.phase !== 'uploaded') result.problems.push('Local mock upload did not complete');
    let sources;
    if (result.nativeArchiveExpected) {
      sources = inspectNativeSources(recordDir);
      result.nativeTimeline = assessNativeLoopbackTimeline(sources, result.fixture.recorderRoles, result.fixture);
      result.expectedDurationS = result.nativeTimeline.expectedDurationS;
      result.expectedSourceOffsetS = result.nativeTimeline.expectedSourceOffsetS;
      result.nativeSources = await snapshotLoopbackCustody(recordDir, sources);
      if (!result.nativePrefix?.length) throw new Error('Missing native per-lane prefix observation');
      verifyLoopbackCustody(result.nativePrefix, result.nativeSources);
    } else {
      const recorder = result.fixture.recorders.at(-1);
      if (!recorder?.bytes || !recorder.events || recorder.startedAt === null || recorder.stoppedAt === null) throw new Error('Missing native MediaRecorder output/timing evidence');
      result.expectedDurationS = (recorder.stoppedAt - recorder.startedAt) / 1000;
      result.expectedSourceOffsetS = (recorder.startedAt - result.fixture.playback.startedAt) / 1000;
    }
    const output = app.findOutputFile();
    if (!output || path.dirname(output) !== recordDir) throw new Error('Missing finalized native loopback audio');
    result.output = output;
    result.audio = await verifyCodedAudio(output, reference, { expectedDurationS: result.expectedDurationS, durationToleranceS: 1.5 });
    result.problems.push(...result.audio.problems);
    requireNumberedLoopbackFrames(result.audio);
    if (!Number.isFinite(result.audio.sourceOffsetS) || Math.abs(result.audio.sourceOffsetS - result.expectedSourceOffsetS) > 1) {
      result.problems.push('Decoded source timing differs from scheduled real output by more than one second');
    }
    result.localSha256 = await sha256(output);
    if (result.nativeArchiveExpected) {
      const system = sources.find(source => source.kind === 'system');
      result.nativeSystemOriginal = path.join(directory, 'native-system-original.webm');
      await concatenateFiles(system.chunkPaths, result.nativeSystemOriginal);
      result.nativeSystemAudio = await verifyCodedAudio(result.nativeSystemOriginal, reference, {
        expectedDurationS: (system.endOffsetMs - system.startOffsetMs) / 1000, durationToleranceS: 1.5 });
      result.problems.push(...result.nativeSystemAudio.problems.map(problem => 'Native system original: ' + problem));
      requireNumberedLoopbackFrames(result.nativeSystemAudio);
      if (!Number.isFinite(result.nativeSystemAudio.sourceOffsetS) ||
          Math.abs(result.nativeSystemAudio.sourceOffsetS - result.nativeTimeline.systemExpectedSourceOffsetS) > 1 ||
          Math.abs(result.nativeSystemAudio.sourceOffsetS - result.audio.sourceOffsetS - system.startOffsetMs / 1000) > 1) {
        result.problems.push('Native system source/final placement differs from the output clock by more than one second');
      }
      result.finalized = JSON.parse(fs.readFileSync(path.join(recordDir, 'finalized.json'), 'utf8'));
      const plans = fs.readdirSync(recordDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('native-finalization-'))
        .map(entry => path.join(recordDir, entry.name, 'plan.json')).filter(file => fs.existsSync(file));
      if (plans.length !== 1) throw new Error('Expected one unambiguous native loopback finalization plan');
      result.nativePlan = { file: plans[0], sha256: await sha256(plans[0]), ...JSON.parse(fs.readFileSync(plans[0], 'utf8')) };
      assessNativeLoopbackPublication(result.finalized, result.nativePlan, result.nativeTimeline,
        { sha256: result.localSha256, bytes: fs.statSync(output).size });
      if (!(await readFinalizedRecording(recordDir))) throw new Error('Native finalized source fingerprint or output validation failed');
    }
    const receipt = JSON.parse(fs.readFileSync(path.join(recordDir, 'upload-receipt.json'), 'utf8'));
    if (mock.state.uploads.get(receipt.audioFileId)?.sha256 !== result.localSha256) result.problems.push('Mock upload differs from the finalized native loopback file');
    if (receipt.canDelete !== false || receipt.contentVerified !== false) result.problems.push('Native loopback backup retention receipt is incorrect');
    const retained = await Promise.all(chunksIn(recordDir).filter(file => !path.relative(recordDir, file).startsWith('native-sources' + path.sep))
      .map(async file => ({ file, sha256: await sha256(file) })));
    result.retainedPrefix = (result.prefix || []).map(original => retained.find(item => item.sha256 === original.sha256) || null);
    if (!result.prefix?.length || result.retainedPrefix.some(item => !item)) result.problems.push('Original persisted prefix changed or disappeared after upload');
    if (result.nativeArchiveExpected) {
      result.nativeSourcesAfterVerification = await snapshotLoopbackCustody(recordDir, inspectNativeSources(recordDir));
      verifyLoopbackCustody(result.nativeSources, result.nativeSourcesAfterVerification, false);
    }
    result.endpointsAfter = readEndpoints();
    if (JSON.stringify(result.endpointsBefore.defaults) !== JSON.stringify(result.endpointsAfter.defaults)) result.problems.push('Windows default endpoints changed during qualification');
    if (result.fixture.samples.some(sample => sample.silentWarning)) result.problems.push('Unexpected system-audio silence warning during supplied output');
    result.pass = result.problems.length === 0;
  } catch (error) { result.problems.push(error.stack || error.message); }
  finally {
    result.profile = app?.userDataDir || null; result.resultFile = resultFile;
    if (app) {
      await app.evalTimed(async () => { await window.__windowsLoopbackQualification?.dispose(); window.__recordingRoleEvidence?.dispose(); }, undefined, 3000).catch(() => {});
      await app.close({ keepProfile: true }).catch(error => { result.pass = false; result.problems.push('Cleanup: ' + error.message); });
      fs.writeFileSync(path.join(directory, 'app-output.log'), app.log.join(''));
    }
    if (mock) await mock.close().catch(error => { result.pass = false; result.problems.push('Mock cleanup: ' + error.message); });
    save();
  }
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${NAME}: ${result.problems.join('; ') || '96 frames, native loopback, upload hash and retained source verified'}`);
  return result;
}

module.exports = { runSystemAudioQualification, readEndpoints, installLoopbackFixture, assessNativeLoopbackTimeline,
  snapshotLoopbackCustody, verifyLoopbackCustody, assessNativeLoopbackPublication, requireNumberedLoopbackFrames };
