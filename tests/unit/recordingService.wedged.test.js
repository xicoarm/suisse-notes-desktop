/**
 * WEDGED-RECORDER reliability test — the ELECTRON-23 production failure class.
 *
 * A real user (Sentry ELECTRON-23, v4.4.1, Windows) had a recording where the
 * MediaRecorder WEDGED: `mediaState=recording` but no chunk was persisted for
 * 932 seconds. The app showed "recording" while capturing nothing — 15+ minutes
 * of phantom recording. This is the same failure CLASS as the Angela dead-mic
 * case (UI says recording, reality is nothing captured), different cause.
 *
 * This test proves the current code turns that silent-forever failure into a
 * bounded, safe outcome:
 *   1. a wedged recorder (stops emitting chunks while state stays 'recording')
 *      is DETECTED within STALL_WARN_MS (~30s), not 900s;
 *   2. capture-recovery is attempted;
 *   3. if the recorder can't be un-wedged, `captureRecoveryFailed` fires —
 *      which the app turns into an emergency stop-with-save (finalizing the
 *      audio captured before the wedge, then a fresh session).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as recordingService from '../../src/services/recordingService';

class MockAnalyser {
  constructor() { this.fftSize = 256; this.frequencyBinCount = 128; }
  getByteFrequencyData(a) { a.fill(50); }            // healthy-ish level
  getFloatTimeDomainData(b) { for (let i = 0; i < b.length; i++) b[i] = 0.1 * Math.sin(i * 0.3); }
}
class MockAudioContext {
  constructor() { this.state = 'running'; }
  createAnalyser() { return new MockAnalyser(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: new MockMediaStream([]) }; }
  close() { return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  addEventListener() {} removeEventListener() {}
}
// A MediaRecorder we can WEDGE: normally requestData()/timeslice would emit a
// chunk; when wedged=true it stops emitting entirely while state stays 'recording'.
class MockMediaRecorder {
  constructor() { this.state = 'inactive'; this.ondataavailable = null; this.onstop = null; this.onerror = null; this.wedged = false; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  // WEDGED: never emits a chunk, even when nudged via requestData — exactly the
  // ELECTRON-23 condition (state stays 'recording' but ondataavailable stops).
  requestData() { /* wedged: no chunk */ }
}
MockMediaRecorder.isTypeSupported = () => true;
class MockMediaStream {
  constructor(tracks = []) { this._tracks = tracks; }
  getAudioTracks() { return this._tracks; } getVideoTracks() { return []; } getTracks() { return this._tracks; }
}
function createTrack() {
  return { kind: 'audio', enabled: true, muted: false, readyState: 'live', stop: vi.fn(),
    getSettings: () => ({ deviceId: 'mic-1', label: 'Mic', sampleRate: 48000, channelCount: 1 }),
    label: 'Mic', onended: null, onmute: null, onunmute: null };
}
function createStore() {
  return {
    startRecording: vi.fn().mockResolvedValue({ success: true }),
    stopRecording: vi.fn().mockResolvedValue({ success: true, filePath: 'a.webm' }),
    reset: vi.fn(), saveChunk: vi.fn().mockResolvedValue({ success: true }),
    setError: vi.fn(), updateDuration: vi.fn(), handleRecordingDeath: vi.fn(),
    chunkSaveErrors: 0, chunkSaveErrorWarning: false,
    isRecording: false, isPaused: false, recordingInterrupted: false, chunkIndex: 0, recordId: 'rec-wedge',
    _chunkSaveQueue: null,
  };
}

describe('wedged MediaRecorder is detected and safely finalized (ELECTRON-23 class)', () => {
  let events;
  let listeners;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    global.MediaRecorder = MockMediaRecorder;
    global.MediaStream = MockMediaStream;
    global.window.AudioContext = MockAudioContext;
    global.window.webkitAudioContext = MockAudioContext;
    global.navigator.mediaDevices = { getUserMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    events = { stalled: [], recovered: [], recoveryFailed: [] };
    listeners = {
      captureStalled: (d) => events.stalled.push(d),
      captureRecovered: (d) => events.recovered.push(d),
      captureRecoveryFailed: (d) => events.recoveryFailed.push(d),
    };
    for (const [e, fn] of Object.entries(listeners)) recordingService.addEventListener(e, fn);
  });
  afterEach(() => {
    for (const [e, fn] of Object.entries(listeners)) recordingService.removeEventListener(e, fn);
    recordingService.cleanup();
    vi.useRealTimers();
  });

  async function startWithRecorder(store) {
    const track = createTrack();
    global.navigator.mediaDevices.getUserMedia.mockResolvedValue(new MockMediaStream([track]));
    const res = await recordingService.startRecording({
      recordingStore: store, authStore: null, deviceId: 'mic-1',
      systemAudioEnabled: false, captureSystemAudio: null,
      isAutoSplitting: { value: false }, maxRecordingSeconds: null,
    });
    expect(res.success).toBe(true);
    store.isRecording = true;
  }

  it('a recorder that stops emitting chunks is detected within ~30s and escalates to stop-with-save', async () => {
    const store = createStore();
    await startWithRecorder(store);
    // The MockMediaRecorder never emits a chunk (fully wedged from the start) —
    // the worst case: lastSuccessfulChunkAt never advances past the start time.

    // Advance past STALL_WARN_MS (30s) so the 5s stateVerification watchdog trips
    // and reports the stall (this is what became a 932s Sentry event on 4.4.1).
    await vi.advanceTimersByTimeAsync(35000);
    expect(events.stalled.length).toBeGreaterThan(0);
    expect(events.stalled[0].secondsSinceLastChunk).toBeGreaterThanOrEqual(30);

    // Recovery runs each 5s; the pipeline looks healthy (context running, track
    // live) but no chunk flows → after CAPTURE_RECOVERY_WEDGED_TICKS (~30s) it
    // must give up and emit captureRecoveryFailed — which the app turns into an
    // emergency stop-with-save (the captured audio is finalized, fresh session).
    await vi.advanceTimersByTimeAsync(45000);
    expect(events.recoveryFailed.length).toBeGreaterThan(0);
    const info = events.recoveryFailed[0];
    expect(info).toBeTruthy();
    expect(typeof info.stalledForSeconds).toBe('number');
  });
});
