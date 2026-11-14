/**
 * LANES: a stalled live mix must not stop a desktop recording that is still
 * being written.
 *
 * The capture watchdog and its recovery loop watch the live mix. The rule
 * "healthy pipeline, no chunk for six ticks: the recorder is wedged, stop and
 * save" was written for the phone, where the live mix IS the recording. On
 * the desktop the saved file is built from separate source lanes (the
 * microphone lane, system audio). On a customer's Mac the live mix came back
 * 5 seconds before that rule would have stopped a 2-hour meeting recording
 * with nobody at the computer.
 *
 * Simulation: one mock recorder is the live mix (it records the mixing graph,
 * which has no tracks here), every other recorder is a source lane on the
 * microphone's own track. A one-second pump feeds whichever of them `ctrl`
 * lets flow, and plays the main process reporting written system audio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ messages: [] }));
vi.mock('../../src/boot/sentry', () => ({
  captureMessage: (message, level = 'info') => { sentry.messages.push({ message, level }); }
}));

import * as recordingService from '../../src/services/recordingService';

const ctrl = {
  mixFlows: true,
  micLaneFlows: true,
  systemAudioFor: null, // record id the system-audio capture reports written audio for
  contextStuck: false   // the audio engine refuses to resume
};
let mixRecorder;
let laneRecorders;
let contexts;
let levelListeners;
let pump;

class MockAnalyser {
  constructor() { this.fftSize = 256; this.frequencyBinCount = 128; }
  getByteFrequencyData(array) { array.fill(50); }
  getFloatTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = 0.1 * Math.sin(i * 0.3); }
}

class MockAudioContext {
  constructor() { this.state = 'running'; contexts.push(this); }
  get currentTime() { return performance.now() / 1000; }
  createAnalyser() { return new MockAnalyser(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: new MockMediaStream([]) }; }
  close() { this.state = 'closed'; return Promise.resolve(); }
  resume() { if (!ctrl.contextStuck) this.state = 'running'; return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
}

class MockMediaRecorder {
  constructor(source) {
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    if (source?.getAudioTracks().length) laneRecorders.push(this);
    else mixRecorder = this;
  }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  requestData() { /* wedged or not, a nudge delivers nothing here */ }
}
MockMediaRecorder.isTypeSupported = () => true;

class MockMediaStream {
  constructor(tracks = []) { this._tracks = tracks; }
  getAudioTracks() { return this._tracks; }
  getVideoTracks() { return []; }
  getTracks() { return this._tracks; }
}

function createTrack() {
  return {
    kind: 'audio', enabled: true, muted: false, readyState: 'live', stop: vi.fn(),
    getSettings: () => ({ deviceId: 'mic-1', sampleRate: 48000, channelCount: 1 }),
    label: 'Mic', onended: null, onmute: null, onunmute: null
  };
}

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
    chunkSaveErrors: 0,
    chunkSaveErrorWarning: false,
    isRecording: false,
    isPaused: false,
    recordingInterrupted: false,
    chunkIndex: 0,
    recordId: 'rec-lanes'
  };
}

/** The desktop bridge: source-lane persistence and the system-audio capture. */
function installDesktop() {
  const ok = () => vi.fn(async () => ({ success: true }));
  window.electronAPI = {
    recording: Object.fromEntries(['beginSource', 'markSourceStarted', 'saveSourceChunk', 'endSource',
      'setInProgress', 'setProcessing', 'setUnsavedAudio', 'saveMetadata'].map(method => [method, ok()])),
    systemAudio: {
      stop: ok(),
      setPaused: ok(),
      onLevel: listener => { levelListeners.add(listener); return () => levelListeners.delete(listener); }
    }
  };
}

const chunk = () => ({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

async function startRecording(store, { systemAudio = false } = {}) {
  navigator.mediaDevices.getUserMedia.mockResolvedValue(new MockMediaStream([createTrack()]));
  const result = await recordingService.startRecording({
    recordingStore: store, authStore: null, deviceId: 'mic-1',
    systemAudioEnabled: systemAudio, captureSystemAudio: systemAudio ? async () => true : null,
    isAutoSplitting: { value: false }, maxRecordingSeconds: null
  });
  expect(result.success).toBe(true);
  store.isRecording = true;
  pump = setInterval(() => {
    if (ctrl.mixFlows && mixRecorder.state === 'recording') {
      mixRecorder.ondataavailable?.({ target: mixRecorder, data: chunk() });
    }
    if (ctrl.micLaneFlows) {
      for (const lane of laneRecorders) if (lane.state === 'recording') lane.ondataavailable?.({ target: lane, data: chunk() });
    }
    if (ctrl.systemAudioFor) {
      for (const listener of [...levelListeners]) listener({ recordId: ctrl.systemAudioFor, percent: 0 });
    }
  }, 1000);
  await vi.advanceTimersByTimeAsync(10000); // a healthy start
}

const laneChunks = () => recordingService.getState().nativeSources.sources
  .reduce((total, source) => total + source.chunkCount, 0);
const laneReports = () => sentry.messages.filter(m => /source lanes keep saving audio/.test(m.message));
const stopReports = () => sentry.messages.filter(m => /capture recovery (FAILED|GAVE UP)/.test(m.message));

describe('a stalled live mix and the source lanes (capture recovery)', () => {
  let events;
  let listeners;
  let stalledAt;

  /** The live mix stops delivering; returns once the watchdog has noticed. */
  async function stallLiveMix() {
    const seen = events.stalled.length;
    ctrl.mixFlows = false;
    for (let i = 0; i < 45 && events.stalled.length === seen; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(events.stalled).toHaveLength(seen + 1);
  }
  /** Run to `seconds` after the watchdog fired: the recovery loop ticks at 0, 5, 10 … s. */
  const runUntil = seconds => vi.advanceTimersByTimeAsync(stalledAt + seconds * 1000 - Date.now());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    Object.assign(ctrl, { mixFlows: true, micLaneFlows: true, systemAudioFor: null, contextStuck: false });
    sentry.messages = [];
    mixRecorder = null;
    laneRecorders = [];
    contexts = [];
    levelListeners = new Set();
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
    stalledAt = null;
    listeners = {
      captureStalled: d => { stalledAt = Date.now(); events.stalled.push(d); },
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

  it('desktop: keeps recording while the microphone lane saves audio, and says so once per episode', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);
    const before = laneChunks();
    expect(before).toBeGreaterThan(0);

    await stallLiveMix();
    // Far beyond the six ticks, the 5-minute desktop window and the 30-minute
    // give-up: the meeting is still being written, so nothing stops it.
    await runUntil(35 * 60);
    expect(events.recoveryFailed).toEqual([]);
    expect(stopReports()).toEqual([]);
    expect(store.stopRecording).not.toHaveBeenCalled();
    expect(recordingService.getState().isRecording).toBe(true);
    expect(laneChunks()).toBeGreaterThan(before + 2000);
    expect(laneReports()).toHaveLength(1);
    expect(laneReports()[0].level).toBe('warning');

    // The live mix returns: the episode ends as recovered, with its real gap.
    ctrl.mixFlows = true;
    await vi.advanceTimersByTimeAsync(6000);
    expect(events.recovered.some(e => e.gapSeconds >= 35 * 60)).toBe(true);
    expect(events.recoveryFailed).toEqual([]);
    expect(levelListeners.size).toBe(0);

    // A second stall is a new episode with its own report.
    await stallLiveMix();
    await runUntil(60);
    expect(events.recoveryFailed).toEqual([]);
    expect(laneReports()).toHaveLength(2);
  });

  it('desktop: written system audio alone keeps the recording going; once it ends too, the stop comes after 5 minutes', async () => {
    installDesktop();
    const store = createStore();
    ctrl.systemAudioFor = store.recordId;
    await startRecording(store, { systemAudio: true });

    ctrl.micLaneFlows = false; // the whole renderer audio stack stands still
    await stallLiveMix();
    await runUntil(10 * 60);
    expect(events.recoveryFailed).toEqual([]);
    expect(laneReports()).toHaveLength(1);

    // Reports for another recording say nothing about this one.
    ctrl.systemAudioFor = 'another-recording';
    await runUntil(10 * 60 + 300);
    expect(events.recoveryFailed).toEqual([]);
    await runUntil(10 * 60 + 312);
    expect(events.recoveryFailed).toHaveLength(1);
    expect(events.recoveryFailed[0].gaveUp).toBeUndefined();
    expect(stopReports()).toHaveLength(1);
    expect(levelListeners.size).toBe(0);
  });

  it('desktop: when no lane saves audio either, the stop comes after 5 minutes instead of 30 seconds', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);

    ctrl.micLaneFlows = false;
    await stallLiveMix();
    await runUntil(294); // 59 ticks
    expect(events.recoveryFailed).toEqual([]);
    expect(recordingService.getState().isRecording).toBe(true);
    await runUntil(296); // the 60th
    expect(events.recoveryFailed).toHaveLength(1);
    expect(events.recoveryFailed[0].stalledForSeconds).toBe(295);
    expect(events.recoveryFailed[0].gaveUp).toBeUndefined();
    expect(laneReports()).toEqual([]);
  });

  it('phone: the six-tick rule is unchanged (no source lanes, stop after 30 seconds)', async () => {
    const store = createStore();
    await startRecording(store);
    expect(recordingService.getState().nativeSources).toBeNull();

    await stallLiveMix();
    await runUntil(24); // 5 ticks
    expect(events.recoveryFailed).toEqual([]);
    await runUntil(26); // the 6th
    expect(events.recoveryFailed).toHaveLength(1);
    expect(events.recoveryFailed[0].stalledForSeconds).toBe(25);
    expect(sentry.messages.some(m => /recorder wedged with healthy pipeline for 6 ticks/.test(m.message) && m.level === 'error')).toBe(true);
    expect(laneReports()).toEqual([]);
  });

  it('desktop: the 30-minute give-up does not stop a recording whose lanes save audio', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);

    // The audio engine is suspended and cannot be resumed: the pipeline is
    // never "healthy", so only the give-up window could end this episode.
    ctrl.contextStuck = true;
    for (const context of contexts) if (context.state === 'running') context.state = 'suspended';
    await stallLiveMix();
    await runUntil(40 * 60);
    expect(events.recoveryFailed).toEqual([]);
    expect(stopReports()).toEqual([]);
    expect(recordingService.getState().isRecording).toBe(true);
  });

  it('desktop: past the 30 minutes a lane that falls silent still gets 5 minutes before the stop', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);

    ctrl.contextStuck = true;
    for (const context of contexts) if (context.state === 'running') context.state = 'suspended';
    await stallLiveMix();
    await runUntil(31 * 60); // past the give-up window, the microphone lane saving all the time
    expect(events.recoveryFailed).toEqual([]);

    // The lane stops saving. One quiet moment does not end the recording: the
    // stop comes only once nothing was saved anywhere for the desktop window.
    ctrl.micLaneFlows = false;
    await runUntil(31 * 60 + 290);
    expect(events.recoveryFailed).toEqual([]);
    expect(recordingService.getState().isRecording).toBe(true);
    await runUntil(31 * 60 + 315);
    expect(events.recoveryFailed).toHaveLength(1);
    expect(events.recoveryFailed[0].gaveUp).toBe(true);
  });

  it('desktop: the 30-minute give-up still stops a recording that saves nothing anywhere', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);

    ctrl.contextStuck = true;
    for (const context of contexts) if (context.state === 'running') context.state = 'suspended';
    ctrl.micLaneFlows = false;
    await stallLiveMix();
    await runUntil(29 * 60);
    expect(events.recoveryFailed).toEqual([]);
    await runUntil(31 * 60);
    expect(events.recoveryFailed).toHaveLength(1);
    expect(events.recoveryFailed[0].gaveUp).toBe(true);
  });
});
