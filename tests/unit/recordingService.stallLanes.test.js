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
  contextStuck: false,  // the audio engine refuses to resume
  micMuted: false       // every microphone track opened from now on is muted
};
let mixRecorder;
let laneRecorders;
let contexts;
let levelListeners;
let micTracks; // every microphone track handed out so far
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
  const track = {
    kind: 'audio', enabled: true, muted: ctrl.micMuted, readyState: 'live', stop: vi.fn(),
    getSettings: () => ({ deviceId: 'mic-1', sampleRate: 48000, channelCount: 1 }),
    label: 'Mic', onended: null, onmute: null, onunmute: null
  };
  micTracks.push(track);
  return track;
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
    pauseRecording() { this.isRecording = false; this.isPaused = true; },
    resumeRecording() { this.isRecording = true; this.isPaused = false; },
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
/** One chunk from the microphone lane that is recording right now. */
const laneChunk = () => {
  for (const lane of laneRecorders) if (lane.state === 'recording') lane.ondataavailable?.({ target: lane, data: chunk() });
};
/** The system-audio capture reports a level for `recordId` (its last report, when it closes, looks the same). */
const levelReport = recordId => { for (const listener of [...levelListeners]) listener({ recordId, percent: 0 }); };

async function startRecording(store, { systemAudio = false, isAutoSplitting = { value: false } } = {}) {
  // Every open hands out a fresh microphone stream (a re-open is a new track).
  navigator.mediaDevices.getUserMedia.mockImplementation(async () => new MockMediaStream([createTrack()]));
  const result = await recordingService.startRecording({
    recordingStore: store, authStore: null, deviceId: 'mic-1',
    systemAudioEnabled: systemAudio, captureSystemAudio: systemAudio ? async () => true : null,
    isAutoSplitting, maxRecordingSeconds: null
  });
  expect(result.success).toBe(true);
  store.isRecording = true;
  pump = setInterval(() => {
    if (ctrl.mixFlows && mixRecorder.state === 'recording') {
      mixRecorder.ondataavailable?.({ target: mixRecorder, data: chunk() });
    }
    if (ctrl.micLaneFlows) laneChunk();
    if (ctrl.systemAudioFor) levelReport(ctrl.systemAudioFor);
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
    Object.assign(ctrl, { mixFlows: true, micLaneFlows: true, systemAudioFor: null, contextStuck: false, micMuted: false });
    sentry.messages = [];
    mixRecorder = null;
    laneRecorders = [];
    micTracks = [];
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
    events = { stalled: [], recovered: [], recoveryFailed: [], lanes: [] };
    stalledAt = null;
    listeners = {
      captureStallLanes: d => events.lanes.push(d.lanesSaving),
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
    expect(events.lanes).toEqual([]);
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

  it('desktop: tells the page when the lanes start and stop saving, and ends the notice with the episode', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);

    await stallLiveMix();
    await runUntil(6); // the second tick sees the microphone lane grow
    expect(events.lanes).toEqual([true]);

    ctrl.micLaneFlows = false; // nothing is saved any more: the normal warning has to come back
    await runUntil(26);
    expect(events.lanes).toEqual([true, false]);

    ctrl.micLaneFlows = true;
    await runUntil(41);
    expect(events.lanes).toEqual([true, false, true]);

    // The live mix returns: the episode is over, and so is the notice.
    ctrl.mixFlows = true;
    await vi.advanceTimersByTimeAsync(6000);
    expect(events.recovered.some(e => e.gapSeconds > 0)).toBe(true);
    expect(events.lanes).toEqual([true, false, true, false]);
    expect(events.recoveryFailed).toEqual([]);
  });

  it('desktop: a level report handled after a wake, before the first timer, does not keep the stops off for the length of the sleep', async () => {
    installDesktop();
    const store = createStore();
    ctrl.systemAudioFor = store.recordId;
    await startRecording(store, { systemAudio: true });

    await stallLiveMix();
    await runUntil(60);
    expect(events.recoveryFailed).toEqual([]);
    expect(laneReports()).toHaveLength(1); // the lanes are seen saving

    // The process is frozen for three hours (no timer runs). The first thing
    // handled after the wake is a level report; then no lane saves any more.
    vi.setSystemTime(Date.now() + 3 * 3600 * 1000);
    levelReport(store.recordId);
    const wokeAt = Date.now();
    ctrl.micLaneFlows = false;
    ctrl.systemAudioFor = null;

    await vi.advanceTimersByTimeAsync(295000);
    expect(events.recoveryFailed).toEqual([]);
    // 10 s of "just saved" after the report, then the 5 minutes: not 3 hours.
    await vi.advanceTimersByTimeAsync(25000);
    expect(events.recoveryFailed).toHaveLength(1);
    expect(Date.now() - wokeAt).toBeLessThanOrEqual(320000);
  });

  it('desktop: a muted microphone is re-opened at most six times per episode while system audio keeps the recording going', async () => {
    installDesktop();
    const store = createStore();
    ctrl.systemAudioFor = store.recordId;
    await startRecording(store, { systemAudio: true });
    const opensAtStart = navigator.mediaDevices.getUserMedia.mock.calls.length;
    const micSegments = () => recordingService.getState().nativeSources.sources.filter(source => source.kind === 'microphone').length;
    expect(micSegments()).toBe(1);

    // The microphone is muted at the device and stays muted however often it
    // is re-opened; its lane saves nothing. System audio is still written.
    ctrl.micMuted = true;
    for (const track of micTracks) track.muted = true;
    ctrl.micLaneFlows = false;
    await stallLiveMix();
    await runUntil(30 * 60);
    expect(events.recoveryFailed).toEqual([]);
    expect(recordingService.getState().isRecording).toBe(true);
    expect(navigator.mediaDevices.getUserMedia.mock.calls.length - opensAtStart).toBe(6);
    expect(micSegments()).toBe(7);
    expect(events.lanes).toEqual([true]);

    // System audio ends too: now nothing is saved anywhere, and the stop comes.
    ctrl.systemAudioFor = null;
    await runUntil(30 * 60 + 295);
    expect(events.recoveryFailed).toEqual([]);
    await runUntil(30 * 60 + 312);
    expect(events.recoveryFailed).toHaveLength(1);
    expect(navigator.mediaDevices.getUserMedia.mock.calls.length - opensAtStart).toBe(6);
  });

  it('phone: a muted microphone is still re-opened on every tick (no cap without source lanes)', async () => {
    const store = createStore();
    await startRecording(store);
    const opensAtStart = navigator.mediaDevices.getUserMedia.mock.calls.length;

    ctrl.micMuted = true;
    for (const track of micTracks) track.muted = true;
    await stallLiveMix();
    await runUntil(24); // ticks at 0, 5, 10, 15, 20 s: five re-opens, each followed by a healthy tick
    expect(navigator.mediaDevices.getUserMedia.mock.calls.length - opensAtStart).toBe(5);
    expect(events.recoveryFailed).toEqual([]);
    await runUntil(26); // the sixth tick re-opens once more and then declares the recorder wedged
    expect(navigator.mediaDevices.getUserMedia.mock.calls.length - opensAtStart).toBe(6);
    expect(events.recoveryFailed).toHaveLength(1);
    expect(events.recoveryFailed[0].stalledForSeconds).toBe(25);
  });

  it('desktop: one last level report when the capture closes restarts the 5 minutes once, with at most 10 s on top', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);

    ctrl.micLaneFlows = false;
    await stallLiveMix(); // nothing is saved: the count runs from the first tick
    await runUntil(102);
    levelReport(store.recordId); // the capture closes: a report without audio
    // Ticks at 105 and 110 s still see "just saved"; the count starts again
    // at 115 s and its 60th tick falls at 410 s: 308 s after the report.
    await runUntil(409);
    expect(events.recoveryFailed).toEqual([]);
    await runUntil(411);
    expect(events.recoveryFailed).toHaveLength(1);
    expect(events.recoveryFailed[0].stalledForSeconds).toBe(410);
  });

  it('desktop: lane audio that returns in trickles keeps the recording; every chunk restarts the 5 minutes (by design)', async () => {
    installDesktop();
    const store = createStore();
    await startRecording(store);

    ctrl.micLaneFlows = false;
    await stallLiveMix();
    // One chunk every four minutes for twenty minutes: the count never
    // reaches its 60 ticks, so the recording goes on.
    for (let minute = 4; minute <= 20; minute += 4) {
      await runUntil(minute * 60 + 1);
      laneChunk();
      expect(events.recoveryFailed).toEqual([]);
    }
    // The page hears each trickle as "saving" and, 10 s later, "not saving".
    await runUntil(20 * 60 + 30);
    expect(events.lanes).toEqual([true, false, true, false, true, false, true, false, true, false]);

    // After the last chunk the stop comes 5 minutes (plus the two ticks) later.
    await runUntil(20 * 60 + 295);
    expect(events.recoveryFailed).toEqual([]);
    await runUntil(20 * 60 + 316);
    expect(events.recoveryFailed).toHaveLength(1);
  });

  it('desktop: pause and resume inside a lanes episode end the notice and start a new episode that keeps recording', async () => {
    installDesktop();
    const store = createStore();
    const split = { value: false };
    await startRecording(store, { isAutoSplitting: split });

    await stallLiveMix();
    await runUntil(120);
    expect(events.lanes).toEqual([true]);

    // Pause: the loop ends itself on its next tick and takes the notice down.
    expect((await recordingService.pauseRecording(store)).success).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(events.lanes).toEqual([true, false]);
    expect(levelListeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // paused: nothing is saved, and nothing stops the recording
    expect(events.recoveryFailed).toEqual([]);

    // Resume with the live mix still standing: the post-resume check starts a
    // new episode, which again sees the microphone lane saving.
    expect((await recordingService.resumeRecording(store, split)).success).toBe(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(events.lanes).toEqual([true, false, true]);
    await vi.advanceTimersByTimeAsync(35 * 60 * 1000);
    expect(events.recoveryFailed).toEqual([]);
    expect(stopReports()).toEqual([]);
    expect(recordingService.getState().isRecording).toBe(true);

    // The lane stops: the stop still comes after the 5 minutes.
    ctrl.micLaneFlows = false;
    await vi.advanceTimersByTimeAsync(290000);
    expect(events.recoveryFailed).toEqual([]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(events.recoveryFailed).toHaveLength(1);
  });

  it('desktop: an auto-split during the episode neither stops the recording nor is it counted', async () => {
    installDesktop();
    const store = createStore();
    const split = { value: false };
    await startRecording(store, { isAutoSplitting: split });

    await stallLiveMix();
    await runUntil(60);
    expect(events.lanes).toEqual([true]);

    // The split holds the loop for six minutes (longer than the 5-minute
    // window) while the microphone lane goes on saving. The flag is set by
    // hand here; the split's own file work is not part of this test.
    split.value = true;
    await runUntil(60 + 6 * 60);
    expect(events.recoveryFailed).toEqual([]);
    split.value = false;
    await runUntil(10 * 60);
    expect(events.recoveryFailed).toEqual([]);
    expect(events.lanes).toEqual([true]);

    // Nothing is saved any more, and another split holds the loop: the loop
    // stands down (as before this change), so the time under the split does
    // not count. The count goes on where it stood once the split is over.
    ctrl.micLaneFlows = false;
    await runUntil(10 * 60 + 60);       // 11 of the 60 ticks counted (610 … 660 s)
    split.value = true;
    await runUntil(10 * 60 + 60 + 400); // more than 5 minutes with nothing saved
    expect(events.recoveryFailed).toEqual([]);
    split.value = false;
    await runUntil(10 * 60 + 60 + 400 + 200);
    expect(events.recoveryFailed).toEqual([]);
    await runUntil(10 * 60 + 60 + 400 + 270); // the other 49 ticks: 1065 … 1305 s
    expect(events.recoveryFailed).toHaveLength(1);
    expect(events.recoveryFailed[0].gaveUp).toBeUndefined();
  });
});
