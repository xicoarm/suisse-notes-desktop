/**
 * SASIG: system-audio silence watchdog.
 *
 * The Windows loopback can hold a `live`, unmuted track and deliver pure digital
 * silence for an entire meeting — WASAPI loopback binds to the default MULTIMEDIA
 * output endpoint while conferencing apps render to the default COMMUNICATION
 * endpoint (proven 2026-08-14: 68 min recorded mic-only, meeting cmssqh4sh…).
 * The mic has had health monitoring since MSIG; the loopback had none, so an hour
 * of silence produced no warning at all. These tests pin the watchdog's contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: mocks.captureMessage }));

import * as recordingService from '../../src/services/recordingService';

// Separate signal control per pipeline: the SASIG analyser lives on the MIXING
// context (the first AudioContext built during startRecording), the mic-health
// and level analysers on later ones.
const ctrl = { micAmplitude: 0.1, systemAmplitude: 0.1 };
let contextsCreated = 0;

class MockAnalyser {
  constructor(isSystem) {
    this.fftSize = 256;
    this.frequencyBinCount = 128;
    this._isSystem = isSystem;
  }
  getByteFrequencyData(array) { array.fill(ctrl.micAmplitude > 0 ? 50 : 0); }
  getFloatTimeDomainData(buf) {
    const amp = this._isSystem ? ctrl.systemAmplitude : ctrl.micAmplitude;
    for (let i = 0; i < buf.length; i++) buf[i] = amp * Math.sin(i * 0.3);
  }
}

class MockAudioContext {
  constructor() {
    this.state = 'running';
    // Context #0 is the mixing pipeline — its analyser is the SASIG probe.
    this._isMixing = contextsCreated++ === 0;
  }
  createAnalyser() { return new MockAnalyser(this._isMixing); }
  createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
  createMediaStreamDestination() { return { stream: new MockMediaStream([]) }; }
  close() { return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
}

class MockMediaRecorder {
  constructor() { this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  requestData() {}
}
MockMediaRecorder.isTypeSupported = () => true;

class MockMediaStream {
  constructor(tracks = []) { this._tracks = tracks; }
  getAudioTracks() { return this._tracks; }
  getVideoTracks() { return []; }
  getTracks() { return this._tracks; }
}

function createTrack(label = 'Mock') {
  return {
    kind: 'audio', enabled: true, muted: false, readyState: 'live',
    stop: vi.fn(), getSettings: () => ({ deviceId: 'mic-1', label }), label,
    onended: null, onmute: null, onunmute: null
  };
}

function createMockRecordingStore() {
  return {
    startRecording: vi.fn().mockResolvedValue({ success: true }),
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
    recordId: 'rec-test'
  };
}

// Start a recording on the WINDOWS system-audio path: captureSystemAudio
// resolves to a MediaStream, which the service wires into the mixing pipeline.
async function startWithSystemAudio(store) {
  global.navigator.mediaDevices.getUserMedia.mockResolvedValue(
    new MockMediaStream([createTrack('Mic')])
  );
  const sysStream = new MockMediaStream([createTrack('Loopback')]);

  const result = await recordingService.startRecording({
    recordingStore: store,
    authStore: null,
    deviceId: 'mic-1',
    systemAudioEnabled: true,
    captureSystemAudio: vi.fn().mockResolvedValue(sysStream),
    isAutoSplitting: { value: false },
    maxRecordingSeconds: null
  });
  expect(result.success).toBe(true);
  store.isRecording = true; // the real store flips this; the mock must too
  return sysStream;
}

// Only the SASIG reports — recordingService shares captureMessage with the
// chunk-stall / capture-recovery watchdogs, which also fire under these mocks.
const sysAudioReports = () =>
  mocks.captureMessage.mock.calls.filter(c => /^system-audio:/.test(String(c[0])));

describe('recordingService — system-audio silence watchdog (SASIG)', () => {
  let silentEvents;
  let onSilent;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    contextsCreated = 0;
    ctrl.micAmplitude = 0.1;
    ctrl.systemAmplitude = 0.1;

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

    silentEvents = [];
    onSilent = (d) => silentEvents.push(d);
    recordingService.addEventListener('systemAudioSilent', onSilent);
  });

  afterEach(() => {
    recordingService.removeEventListener('systemAudioSilent', onSilent);
    recordingService.cleanup();
    vi.useRealTimers();
  });

  it('warns once after 90s of digital silence on the loopback', async () => {
    const store = createMockRecordingStore();
    await startWithSystemAudio(store);

    // The incident: loopback bound to an endpoint nothing plays to.
    ctrl.systemAmplitude = 0;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(silentEvents).toEqual([]); // not yet — must survive quiet passages

    await vi.advanceTimersByTimeAsync(35_000);
    const warnings = silentEvents.filter(Boolean);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].silentSeconds).toBeGreaterThanOrEqual(90);

    // Keeps warning state — does not re-fire every tick.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(silentEvents.filter(Boolean)).toHaveLength(1);
    // Exactly one Sentry report per episode. (Other watchdogs share
    // captureMessage — the mock MediaRecorder never emits chunks, so the
    // chunk-stall reporter also fires here; filter to our own signal.)
    expect(sysAudioReports()).toHaveLength(1);
  });

  it('never warns while the loopback delivers real audio', async () => {
    const store = createMockRecordingStore();
    await startWithSystemAudio(store);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(silentEvents).toEqual([]);
    expect(sysAudioReports()).toHaveLength(0);
  });

  it('clears the warning as soon as system audio comes back', async () => {
    const store = createMockRecordingStore();
    await startWithSystemAudio(store);

    ctrl.systemAmplitude = 0;
    await vi.advanceTimersByTimeAsync(95_000);
    expect(silentEvents.filter(Boolean)).toHaveLength(1);

    // User switches their Windows default output device mid-meeting.
    ctrl.systemAmplitude = 0.1;
    await vi.advanceTimersByTimeAsync(3000);

    expect(silentEvents[silentEvents.length - 1]).toBeNull();
  });

  it('does not age the silence timer while the recording is paused', async () => {
    const store = createMockRecordingStore();
    await startWithSystemAudio(store);

    ctrl.systemAmplitude = 0;
    store.isRecording = false; // paused: capture is legitimately silent
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(silentEvents).toEqual([]);

    // Resume: the 90s budget starts fresh, it is not already exhausted.
    store.isRecording = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(silentEvents).toEqual([]);

    await vi.advanceTimersByTimeAsync(35_000);
    expect(silentEvents.filter(Boolean)).toHaveLength(1);
  });

  it('does not arm at all when system audio is off', async () => {
    const store = createMockRecordingStore();
    global.navigator.mediaDevices.getUserMedia.mockResolvedValue(
      new MockMediaStream([createTrack('Mic')])
    );
    await recordingService.startRecording({
      recordingStore: store,
      authStore: null,
      deviceId: 'mic-1',
      systemAudioEnabled: false,
      captureSystemAudio: null,
      isAutoSplitting: { value: false },
      maxRecordingSeconds: null
    });
    store.isRecording = true;

    ctrl.systemAmplitude = 0;
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(silentEvents).toEqual([]);
  });
});
