/**
 * CLOCK: a live mix whose audio engine stands still must neither freeze the
 * time shown nor stay broken for the rest of the recording.
 *
 * A customer's Windows PC started a recording while its sound output did not
 * ask for audio (a headset that dropped out seconds later). The mixing engine
 * reported 'running', its clock stood still, the live mix delivered nothing.
 * The microphone lane recorded all 3 min 50 s and the file was complete, but
 * the app showed 0:01 for four minutes beside a stall notice; the user paused,
 * resumed, stopped and started over.
 *
 * Two rules follow. The time shown counts what the source lanes saved, not
 * only the live mix. And an engine that runs with a standing clock is moved
 * off the output device, once, because nothing it does is ever played.
 *
 * Simulation: an engine's clock advances only while its output pulls audio or
 * the engine runs on its own clock. The first engine is the mixing engine;
 * the live-mix recorder delivers a chunk only while that engine renders.
 * Recorders deliver one chunk per timeslice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ messages: [] }));
vi.mock('../../src/boot/sentry', () => ({
  captureMessage: (message, level = 'info') => { sentry.messages.push({ message, level }); }
}));

import * as recordingService from '../../src/services/recordingService';

const ctrl = {
  outputPulls: true,     // the sound output asks the engines for audio
  recorderWedged: false, // the live-mix recorder delivers nothing although its engine renders
  micLaneFlows: true,
  systemLaneFlows: true,
  sinkApi: true,         // the engine can change its output
  sinkOutcome: 'ok'      // 'ok' | 'refused' | 'hangs' | a number: answers after that many ms
};
let mixRecorder;
let laneRecorders;
let contexts;
let pump;
// The service fixes its timeslice when it loads: 3 s outside the desktop app,
// which is what these tests load it as (the desktop app itself uses 1 s).
const TIMESLICE_MS = 3000;

class MockAnalyser {
  constructor() { this.fftSize = 256; this.frequencyBinCount = 128; }
  getByteFrequencyData(array) { array.fill(50); }
  getFloatTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = 0.1 * Math.sin(i * 0.3); }
}

class MockAudioContext {
  constructor(options = {}) {
    this.state = 'running';
    this.sinkCalls = [];
    this.ownClock = options.sinkId?.type === 'none'; // opened off the output device
    this.rendered = 0;
    this.since = performance.now();
    if (!ctrl.sinkApi) this.setSinkId = undefined;
    contexts.push(this);
  }
  get renders() { return this.state === 'running' && (ctrl.outputPulls || this.ownClock); }
  /** Book the time since the last look; call before anything that changes `renders`. */
  sync() {
    const now = performance.now();
    if (this.renders) this.rendered += (now - this.since) / 1000;
    this.since = now;
  }
  get currentTime() { this.sync(); return this.rendered; }
  setSinkId(sink) {
    this.sinkCalls.push(sink);
    if (ctrl.sinkOutcome === 'hangs') return new Promise(() => {});
    if (ctrl.sinkOutcome === 'refused') return Promise.reject(Object.assign(new Error('refused'), { name: 'NotAllowedError' }));
    const move = () => { this.sync(); this.ownClock = sink?.type === 'none'; };
    if (typeof ctrl.sinkOutcome === 'number') return new Promise(resolve => setTimeout(() => { move(); resolve(); }, ctrl.sinkOutcome));
    move();
    return Promise.resolve();
  }
  createAnalyser() { return new MockAnalyser(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: new MockMediaStream([]) }; }
  close() { this.sync(); this.state = 'closed'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
}

class MockMediaRecorder {
  constructor(source) {
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this.system = source?.getAudioTracks()[0]?.system === true;
    if (source?.getAudioTracks().length) laneRecorders.push(this);
    else mixRecorder = this;
  }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  requestData() { /* an engine that renders nothing has nothing to hand over */ }
}
MockMediaRecorder.isTypeSupported = () => true;

class MockMediaStream {
  constructor(tracks = []) { this._tracks = tracks; }
  getAudioTracks() { return this._tracks; }
  getVideoTracks() { return []; }
  getTracks() { return this._tracks; }
}

const createTrack = () => ({
  kind: 'audio', enabled: true, muted: false, readyState: 'live', stop: vi.fn(),
  getSettings: () => ({ deviceId: 'mic-1', sampleRate: 48000, channelCount: 1 }),
  label: 'Mic', onended: null, onmute: null, onunmute: null
});

function createStore() {
  return {
    startRecording: vi.fn().mockResolvedValue({ success: true }),
    confirmCaptureStarted: vi.fn(),
    stopRecording: vi.fn().mockResolvedValue({ success: true, filePath: 'fake.webm' }),
    reset: vi.fn(),
    saveChunk: vi.fn().mockResolvedValue({ success: true }),
    setError: vi.fn(),
    updateDuration: vi.fn(),
    handleRecordingDeath: vi.fn(),
    pauseRecording() { this.isRecording = false; this.isPaused = true; },
    resumeRecording() { this.isRecording = true; this.isPaused = false; },
    chunkSaveErrors: 0,
    chunkSaveErrorWarning: false,
    isRecording: false,
    isPaused: false,
    recordingInterrupted: false,
    chunkIndex: 0,
    recordId: 'rec-clock'
  };
}

function installDesktop() {
  const ok = () => vi.fn(async () => ({ success: true }));
  window.electronAPI = {
    recording: Object.fromEntries(['beginSource', 'markSourceStarted', 'saveSourceChunk', 'endSource',
      'setInProgress', 'setProcessing', 'setUnsavedAudio', 'saveMetadata'].map(method => [method, ok()])),
    systemAudio: { stop: ok(), setPaused: ok(), onLevel: () => () => {} }
  };
}

const chunk = () => ({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

/** The sound output stops (or starts again) asking the engines for audio. */
function setOutputPulls(pulls) {
  for (const context of contexts) context.sync();
  ctrl.outputPulls = pulls;
}

async function startRecording(store, { systemLane = false } = {}) {
  const mixing = contexts.length; // the first engine a recording opens is its mixing engine
  navigator.mediaDevices.getUserMedia.mockImplementation(async () => new MockMediaStream([createTrack()]));
  const result = await recordingService.startRecording({
    recordingStore: store, authStore: null, deviceId: 'mic-1',
    // Windows hands the app a stream for the computer's sound: a second source lane.
    systemAudioEnabled: systemLane,
    captureSystemAudio: systemLane ? async () => new MockMediaStream([Object.assign(createTrack(), { system: true })]) : null,
    isAutoSplitting: { value: false }, maxRecordingSeconds: null
  });
  expect(result.success).toBe(true);
  store.isRecording = true;
  pump = setInterval(() => {
    if (!ctrl.recorderWedged && contexts[mixing].renders && mixRecorder.state === 'recording') {
      mixRecorder.ondataavailable?.({ target: mixRecorder, data: chunk() });
    }
    for (const lane of laneRecorders) {
      if (lane.state !== 'recording' || !(lane.system ? ctrl.systemLaneFlows : ctrl.micLaneFlows)) continue;
      lane.ondataavailable?.({ target: lane, data: chunk() });
    }
  }, TIMESLICE_MS);
}

const shown = store => store.updateDuration.mock.calls.at(-1)?.[0];
const sinkCalls = () => contexts.map(context => context.sinkCalls);
const loopRecoveries = events => events.recovered.filter(e => e.reason);
const clockReports = () => sentry.messages.filter(m => /audio clock stood still/.test(m.message));
const stallReports = () => sentry.messages.filter(m => /capture STALLED/.test(m.message));
const stallDiagnostics = () => JSON.parse(stallReports().at(-1).message.replace(/^[^{]*/, ''));

describe('a live mix whose audio clock stands still', () => {
  let events;
  let listeners;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    Object.assign(ctrl, { outputPulls: true, recorderWedged: false, micLaneFlows: true, systemLaneFlows: true, sinkApi: true, sinkOutcome: 'ok' });
    sentry.messages = [];
    mixRecorder = null;
    laneRecorders = [];
    contexts = [];
    global.MediaRecorder = MockMediaRecorder;
    global.MediaStream = MockMediaStream;
    global.window.AudioContext = MockAudioContext;
    global.window.webkitAudioContext = MockAudioContext;
    global.navigator.mediaDevices = {
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    events = { stalled: [], recovered: [], recoveryFailed: [] };
    listeners = {
      captureStalled: d => events.stalled.push(d),
      captureRecovered: d => events.recovered.push(d),
      captureRecoveryFailed: d => events.recoveryFailed.push(d)
    };
    for (const [event, fn] of Object.entries(listeners)) recordingService.addEventListener(event, fn);
  });

  afterEach(async () => {
    for (const [event, fn] of Object.entries(listeners)) recordingService.removeEventListener(event, fn);
    clearInterval(pump);
    await recordingService.cleanup();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it('desktop: the time shown follows the source lanes when the live mix never delivers', async () => {
    installDesktop();
    ctrl.outputPulls = false; // broken from the first second, as on the customer's PC
    ctrl.sinkApi = false;     // nothing repairs the engine here: the display has to be right anyway
    const store = createStore();
    await startRecording(store);

    await vi.advanceTimersByTimeAsync(230000);
    expect(recordingService.getState().isRecording).toBe(true);
    expect(events.recoveryFailed).toEqual([]);
    // Not 0:01: the microphone lane has saved the whole time.
    expect(shown(store)).toBeGreaterThanOrEqual(228);
    expect(shown(store)).toBeLessThanOrEqual(230);
    expect(sinkCalls().flat()).toEqual([]);
    expect(clockReports()).toEqual([]);

    // The stall is still reported, as what it is: lanes saving, clock standing.
    expect(stallReports()).toHaveLength(1);
    expect(stallReports()[0].level).toBe('warning');
    expect(stallDiagnostics()).toMatchObject({
      savedChunks: 0, receivedDataEvents: 0, contextState: 'running',
      contextClockSec: 0, contextOutput: 'device', lanesSaving: true
    });
    expect(stallDiagnostics().laneChunks).toBeGreaterThanOrEqual(3);
  });

  it('desktop: the time shown stands still once the lanes stop saving too', async () => {
    installDesktop();
    ctrl.sinkApi = false;
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(20000);
    expect(shown(store)).toBeGreaterThanOrEqual(19);

    setOutputPulls(false);
    ctrl.micLaneFlows = false;
    await vi.advanceTimersByTimeAsync(60000);
    expect(shown(store)).toBeLessThanOrEqual(22);
    // Nothing is being written any more: this one is an error.
    expect(stallReports()).toHaveLength(1);
    expect(stallReports()[0].level).toBe('error');
    expect(stallDiagnostics().lanesSaving).toBe(false);
  });

  it('desktop: a standing clock is repaired by moving every engine off the output device, once', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    expect(sinkCalls().flat()).toEqual([]);

    setOutputPulls(false);
    await vi.advanceTimersByTimeAsync(45000); // watchdog at 30 s, repair on the second look at the clock
    for (const calls of sinkCalls()) expect(calls).toEqual([{ type: 'none' }]);
    expect(clockReports()).toHaveLength(1);
    expect(clockReports()[0].level).toBe('warning');
    expect(clockReports()[0].message).toMatch(/live mix moved off the output device/);
    expect(clockReports()[0].message).toContain(`engines=${contexts.length}`);
    expect(loopRecoveries(events)).toHaveLength(1);
    expect(events.recoveryFailed).toEqual([]);

    // The output device no longer matters to this recording.
    const saved = recordingService.getSavedChunkCount();
    await vi.advanceTimersByTimeAsync(120000);
    expect(recordingService.getSavedChunkCount()).toBeGreaterThanOrEqual(saved + 39);
    expect(events.stalled).toHaveLength(1);

    // A later stall of another kind does not ask the engines again.
    ctrl.recorderWedged = true;
    await vi.advanceTimersByTimeAsync(60000);
    expect(events.stalled).toHaveLength(2);
    for (const calls of sinkCalls()) expect(calls).toEqual([{ type: 'none' }]);
    expect(clockReports()).toHaveLength(1);
    expect(JSON.parse(stallReports().at(-1).message.replace(/^[^{]*/, '')).contextOutput).toBe('none');
  });

  it('desktop: engines the repaired recording opens later start off the output device; the next recording does not', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);
    setOutputPulls(false);
    await vi.advanceTimersByTimeAsync(45000);
    expect(loopRecoveries(events)).toHaveLength(1);

    // A microphone change re-opens the microphone check: with the output still
    // not pulling, an engine on the device would stand still from its first second.
    const opened = contexts.length;
    const switched = await recordingService.switchMicrophoneStream('mic-1', { skipVerify: true });
    expect(switched.success).toBe(true);
    expect(contexts.length).toBeGreaterThan(opened);
    for (const context of contexts.slice(opened)) {
      expect(context.ownClock).toBe(true);
      expect(context.sinkCalls).toEqual([]);
    }

    // The next recording starts on the output device like every recording.
    clearInterval(pump);
    await recordingService.cleanup();
    setOutputPulls(true);
    const second = contexts.length;
    laneRecorders = [];
    const next = createStore();
    await startRecording(next);
    await vi.advanceTimersByTimeAsync(10000);
    expect(contexts.length).toBeGreaterThan(second);
    for (const context of contexts.slice(second)) expect(context.ownClock).toBe(false);
    expect(events.stalled).toHaveLength(1);
  });

  it('desktop: a broken output at the start is repaired within 20 seconds', async () => {
    installDesktop();
    ctrl.outputPulls = false;
    const store = createStore();
    await startRecording(store);

    await vi.advanceTimersByTimeAsync(25000);
    expect(contexts[0].sinkCalls).toEqual([{ type: 'none' }]);
    expect(loopRecoveries(events)).toHaveLength(1);
    expect(recordingService.getSavedChunkCount()).toBeGreaterThan(0);
    expect(stallReports()[0].level).toBe('warning');
  });

  it('desktop: a recorder that is wedged while the clock runs is left alone', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);

    ctrl.recorderWedged = true;
    await vi.advanceTimersByTimeAsync(120000);
    expect(events.stalled).toHaveLength(1);
    expect(sinkCalls().flat()).toEqual([]);
    expect(clockReports()).toEqual([]);
    expect(recordingService.getState().isRecording).toBe(true);
  });

  it('desktop: an engine that refuses is reported once and the recording goes on', async () => {
    installDesktop();
    ctrl.sinkOutcome = 'refused';
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);

    setOutputPulls(false);
    await vi.advanceTimersByTimeAsync(10 * 60000);
    for (const calls of sinkCalls()) expect(calls).toEqual([{ type: 'none' }]);
    expect(clockReports()).toHaveLength(1);
    expect(clockReports()[0].message).toMatch(/could not be moved off the output device \(NotAllowedError\)/);
    expect(clockReports()[0].message).toContain('engines=0');
    expect(events.recoveryFailed).toEqual([]);
    expect(recordingService.getState().isRecording).toBe(true);
    expect(shown(store)).toBeGreaterThanOrEqual(600);
  });

  it('desktop: an engine that never answers does not hold up the recovery loop', async () => {
    installDesktop();
    ctrl.sinkOutcome = 'hangs';
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);

    setOutputPulls(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(clockReports()).toHaveLength(1);
    expect(clockReports()[0].message).toMatch(/could not be moved off the output device \(TimeoutError\)/);
    // The loop went on to its lanes rule after the timeout.
    expect(sentry.messages.some(m => /source lanes keep saving audio/.test(m.message))).toBe(true);
    expect(events.recoveryFailed).toEqual([]);
  });

  it('desktop: an answer that comes after the time limit still counts', async () => {
    installDesktop();
    ctrl.sinkOutcome = 5000; // the limit is 3 s
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);

    setOutputPulls(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(clockReports()).toHaveLength(1);
    expect(clockReports()[0].message).toMatch(/could not be moved off the output device \(TimeoutError\)/);
    for (const calls of sinkCalls()) expect(calls).toEqual([{ type: 'none' }]);
    // The engine did move: the live mix is back, and later engines start off the device.
    expect(loopRecoveries(events)).toHaveLength(1);
    const opened = contexts.length;
    expect((await recordingService.switchMicrophoneStream('mic-1', { skipVerify: true })).success).toBe(true);
    expect(contexts.length).toBeGreaterThan(opened);
    for (const context of contexts.slice(opened)) expect(context.ownClock).toBe(true);
  });

  it('desktop: a pause that overtakes the repair loses neither the report nor the result', async () => {
    installDesktop();
    ctrl.sinkOutcome = 1000;
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);

    setOutputPulls(false);
    for (let i = 0; i < 240 && contexts[0].sinkCalls.length === 0; i++) await vi.advanceTimersByTimeAsync(250);
    expect(contexts[0].sinkCalls).toEqual([{ type: 'none' }]);
    expect((await recordingService.pauseRecording(store)).success).toBe(true); // the engine has not answered yet
    await vi.advanceTimersByTimeAsync(3000);
    expect(clockReports()).toHaveLength(1);
    expect(clockReports()[0].message).toMatch(/live mix moved off the output device/);

    expect((await recordingService.resumeRecording(store, { value: false })).success).toBe(true);
    const saved = recordingService.getSavedChunkCount();
    await vi.advanceTimersByTimeAsync(30000);
    expect(recordingService.getSavedChunkCount()).toBeGreaterThanOrEqual(saved + 9);
    const opened = contexts.length;
    expect((await recordingService.switchMicrophoneStream('mic-1', { skipVerify: true })).success).toBe(true);
    for (const context of contexts.slice(opened)) expect(context.ownClock).toBe(true);
    for (const calls of sinkCalls()) expect(calls.length).toBeLessThanOrEqual(1);
  });

  it('desktop: with a microphone, system audio alone does not count as saving', async () => {
    installDesktop();
    ctrl.sinkApi = false;
    const store = createStore();
    await startRecording(store, { systemLane: true });
    await vi.advanceTimersByTimeAsync(20000);
    expect(laneRecorders.filter(lane => lane.system)).toHaveLength(1);
    expect(laneRecorders.filter(lane => !lane.system)).toHaveLength(1);

    // The user's voice is no longer recorded; the computer's sound still is.
    setOutputPulls(false);
    ctrl.micLaneFlows = false;
    await vi.advanceTimersByTimeAsync(60000);
    expect(shown(store)).toBeLessThanOrEqual(22);
    expect(stallReports()).toHaveLength(1);
    expect(stallReports()[0].level).toBe('error');
    expect(stallDiagnostics().lanesSaving).toBe(false);
  });

  it('desktop: without a microphone, system audio is what counts', async () => {
    installDesktop();
    ctrl.sinkApi = false;
    ctrl.outputPulls = false;
    const store = createStore();
    navigator.mediaDevices.getUserMedia.mockRejectedValue(Object.assign(new Error('no microphone'), { name: 'NotFoundError' }));
    const result = await recordingService.startRecording({
      recordingStore: store, authStore: null, deviceId: 'mic-1', systemAudioEnabled: true,
      captureSystemAudio: async () => new MockMediaStream([Object.assign(createTrack(), { system: true })]),
      isAutoSplitting: { value: false }, maxRecordingSeconds: null
    });
    expect(result.success).toBe(true);
    store.isRecording = true;
    pump = setInterval(() => {
      for (const lane of laneRecorders) if (lane.state === 'recording') lane.ondataavailable?.({ target: lane, data: chunk() });
    }, TIMESLICE_MS);
    await vi.advanceTimersByTimeAsync(120000);
    expect(laneRecorders.length).toBeGreaterThan(0);
    expect(laneRecorders.every(lane => lane.system)).toBe(true);
    expect(shown(store)).toBeGreaterThanOrEqual(118);
    expect(stallReports()[0].level).toBe('warning');
    expect(stallDiagnostics().lanesSaving).toBe(true);
  });

  it('desktop: near a system sleep the engines are not moved', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);

    // Lid closed: audio stops, the renderer is frozen for ten minutes, then a dark wake.
    setOutputPulls(false);
    vi.setSystemTime(Date.now() + 10 * 60000);
    await vi.advanceTimersByTimeAsync(90000);
    expect(events.stalled.length).toBeGreaterThanOrEqual(1);
    expect(sinkCalls().flat()).toEqual([]);
    expect(clockReports()).toEqual([]);
    expect(events.recoveryFailed).toEqual([]);
  });

  it('phone: no source lanes, so the time shown still freezes with the live mix and no engine is moved', async () => {
    const store = createStore();
    await startRecording(store);
    expect(recordingService.getState().nativeSources).toBeNull();
    await vi.advanceTimersByTimeAsync(12000);
    const before = shown(store);
    expect(before).toBeGreaterThanOrEqual(11);

    setOutputPulls(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(shown(store)).toBeLessThanOrEqual(before + TIMESLICE_MS / 1000);
    expect(sinkCalls().flat()).toEqual([]);
    await vi.advanceTimersByTimeAsync(40000);
    expect(stallReports()[0].level).toBe('error');
    expect(stallDiagnostics()).not.toHaveProperty('lanesSaving');
    expect(sinkCalls().flat()).toEqual([]);
    expect(clockReports()).toEqual([]);
  });
});
