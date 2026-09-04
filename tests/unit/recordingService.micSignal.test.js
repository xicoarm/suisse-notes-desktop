/**
 * MSIG: mic signal forensics — zero-signal detection, same-device re-acquire,
 * post-switch verification, low-level detection, and verified auto-recovery.
 *
 * Built after the Insel incident (2026-07-22): a dead Bluetooth speakerphone
 * kept a live track delivering digital zeros for 6 minutes, and a manual
 * switch onto another silent BT profile was blessed as "OK" by the old
 * threshold logic while the recording stayed unusable for 20 more minutes.
 *
 * The mock analyser produces a controllable sine (ctrl.amplitude) so tests
 * can simulate: healthy speech, digital zeros, whisper-level audio, and
 * modulated-but-too-quiet speech.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as recordingService from '../../src/services/recordingService';

// Shared signal control — every analyser instance (fresh ones are created on
// each mic switch) reads from here.
const ctrl = {
  amplitude: 0.1, // sine peak (0.1 ≈ -20dBFS peak / -23dBFS RMS: healthy speech)
  byteVal: 50    // byte-frequency fill (drives the legacy NO_AUDIO/NO_VOICE logic)
};

class MockAnalyser {
  constructor() {
    this.fftSize = 256;
    this.frequencyBinCount = 128;
  }

  getByteFrequencyData(array) {
    array.fill(ctrl.byteVal);
  }

  getFloatTimeDomainData(buf) {
    for (let i = 0; i < buf.length; i++) {
      buf[i] = ctrl.amplitude * Math.sin(i * 0.3);
    }
  }
}

class MockAudioContext {
  constructor() {
    this.state = 'running';
  }

  createAnalyser() {
    return new MockAnalyser();
  }

  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }

  createMediaStreamDestination() {
    return { stream: new MockMediaStream([]) };
  }

  close() { return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
}

class MockMediaRecorder {
  constructor() {
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    MockMediaRecorder.last = this;
  }

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

function createTrack(settings = {}) {
  return {
    kind: 'audio',
    enabled: true,
    muted: false,
    readyState: 'live',
    stop: vi.fn(),
    getSettings: () => settings,
    label: settings.label || 'Mock Mic',
    onended: null,
    onmute: null,
    onunmute: null
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

async function startHealthyRecording(recordingStore, opts = {}) {
  const micTrack = createTrack({ deviceId: 'mic-1', label: 'BT Speakerphone' });
  const micStream = new MockMediaStream([micTrack]);
  global.navigator.mediaDevices.getUserMedia.mockResolvedValue(micStream);

  const result = await recordingService.startRecording({
    recordingStore,
    authStore: null,
    deviceId: 'mic-1',
    systemAudioEnabled: opts.systemAudioEnabled || false,
    captureSystemAudio: opts.captureSystemAudio || null,
    isAutoSplitting: { value: false },
    maxRecordingSeconds: null
  });
  expect(result.success).toBe(true);
  recordingStore.isRecording = true; // the real store flips this; mock must too
  return { micTrack, micStream };
}

function healthNow() {
  return recordingService.getState().recordingHealth;
}

describe('recordingService mic signal forensics (MSIG)', () => {
  let events;
  let listeners;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

    ctrl.amplitude = 0.1;
    ctrl.byteVal = 50;

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

    events = { verified: [], autoSwitched: [], recovered: [] };
    listeners = {
      micSwitchVerified: (d) => events.verified.push(d),
      micAutoSwitched: (d) => events.autoSwitched.push(d),
      micRecovered: (d) => events.recovered.push(d)
    };
    for (const [evt, fn] of Object.entries(listeners)) {
      recordingService.addEventListener(evt, fn);
    }
  });

  afterEach(() => {
    // Deregister — the service is a module singleton, so leaked listeners
    // from earlier tests would multiply-push into the current events object.
    for (const [evt, fn] of Object.entries(listeners)) {
      recordingService.removeEventListener(evt, fn);
    }
    recordingService.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('checks final audio against active elapsed time even when no chunks advance the display', async () => {
    const store = createMockRecordingStore(); await startHealthyRecording(store);
    store.duration = 3;
    await vi.advanceTimersByTimeAsync(45000);
    expect(recordingService.getWallClockSeconds()).toBeCloseTo(45, 1);
    await recordingService.stopRecording(store);
    expect(store.stopRecording).toHaveBeenCalledWith(45);
  });

  it('excludes paused time and system-clock changes from the final audio expectation', async () => {
    const store = createMockRecordingStore(); await startHealthyRecording(store);
    store.pauseRecording = () => { store.isRecording = false; store.isPaused = true; };
    store.resumeRecording = () => { store.isRecording = true; store.isPaused = false; };
    await vi.advanceTimersByTimeAsync(20000);
    recordingService.pauseRecording(store);
    await vi.advanceTimersByTimeAsync(30000);
    vi.setSystemTime(Date.now() + 3600000);
    recordingService.resumeRecording(store, { value: false });
    await vi.advanceTimersByTimeAsync(10000);
    await recordingService.stopRecording(store);
    expect(store.stopRecording).toHaveBeenCalledWith(30);
  });

  it('starts macOS system capture under the newly created recording identity', async () => {
    const store = createMockRecordingStore();
    store.recordId = 'previous-meeting';
    store.startRecording.mockImplementation(async () => { store.recordId = 'new-meeting'; return { success: true }; });
    const captureSystemAudio = vi.fn(async id => { expect(id).toBe('new-meeting'); return true; });
    await startHealthyRecording(store, { systemAudioEnabled: true, captureSystemAudio });
    expect(captureSystemAudio).toHaveBeenCalledTimes(1);
    expect(recordingService.getState().systemAudioActive).toBe(true);
  });

  it('preserves a deliberate mute when replacing the microphone', async () => {
    const store = createMockRecordingStore(); await startHealthyRecording(store);
    recordingService.toggleMicMute();
    const next = createTrack({ deviceId: 'usb' });
    navigator.mediaDevices.getUserMedia.mockResolvedValue(new MockMediaStream([next]));
    expect((await recordingService.switchMicrophoneStream('usb', { skipVerify: true })).success).toBe(true);
    expect(next.enabled).toBe(false);
  });

  it('disposes a microphone acquisition that completes after recording cleanup', async () => {
    const store = createMockRecordingStore(); await startHealthyRecording(store);
    let resolve; navigator.mediaDevices.getUserMedia.mockReturnValue(new Promise(r => { resolve = r; }));
    const switching = recordingService.switchMicrophoneStream('usb');
    recordingService.cleanup();
    const next = createTrack({ deviceId: 'usb' }); resolve(new MockMediaStream([next]));
    expect((await switching).success).toBe(false);
    expect(next.stop).toHaveBeenCalled();
  });

  it('keeps the working microphone if connecting the replacement graph fails', async () => {
    const store = createMockRecordingStore(); const { micTrack } = await startHealthyRecording(store);
    const next = createTrack({ deviceId: 'usb' });
    navigator.mediaDevices.getUserMedia.mockResolvedValue(new MockMediaStream([next]));
    vi.spyOn(MockAudioContext.prototype, 'createMediaStreamSource').mockImplementation(() => { throw Error('graph failure'); });
    expect((await recordingService.switchMicrophoneStream('usb')).success).toBe(false);
    expect(micTrack.stop).not.toHaveBeenCalled();
    expect(next.stop).toHaveBeenCalled();
  });

  it('finalizes only after the final data event and its slow disk save finish', async () => {
    const store = createMockRecordingStore(); await startHealthyRecording(store);
    let saved; store.saveChunk.mockReturnValue(new Promise(r => { saved = r; }));
    const recorder = MockMediaRecorder.last;
    recorder.stop = () => {
      recorder.state = 'inactive';
      recorder.ondataavailable({ target: recorder, data: { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } });
      recorder.onstop();
    };
    const stop = recordingService.stopRecording(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.stopRecording).not.toHaveBeenCalled();
    saved({ success: true });
    expect((await stop).success).toBe(true);
    expect(store.saveChunk).toHaveBeenCalledWith([1, 2, 3]);
    expect(store.stopRecording).toHaveBeenCalledTimes(1);
  });

  it('protects failed in-memory audio until the same bytes are saved on retry', async () => {
    const store = createMockRecordingStore(); await startHealthyRecording(store);
    const previousApi = window.electronAPI;
    const setUnsavedAudio = vi.fn().mockResolvedValue({ success: true });
    window.electronAPI = { recording: { setUnsavedAudio, setInProgress: vi.fn(), setProcessing: vi.fn() } };
    try {
      store.saveChunk.mockResolvedValueOnce({ success: false, diskFull: true, error: 'Disk full' }).mockResolvedValue({ success: true });
      const recorder = MockMediaRecorder.last;
      recorder.ondataavailable({ target: recorder, data: { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } });
      await vi.advanceTimersByTimeAsync(0);
      const failed = await recordingService.stopRecording(store);
      expect(failed.unsavedAudio).toBe(true);
      expect(setUnsavedAudio).toHaveBeenLastCalledWith('rec-test');
      expect(store.stopRecording).not.toHaveBeenCalled();
      expect((await recordingService.stopRecording(store)).success).toBe(true);
      expect(setUnsavedAudio).toHaveBeenLastCalledWith(null);
      expect(store.saveChunk.mock.calls.map(args => args[0])).toEqual([[1, 2, 3], [1, 2, 3]]);
    } finally { window.electronAPI = previousApi; }
  });

  it('healthy signal stays ok — no zero-signal false positive', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);

    await vi.advanceTimersByTimeAsync(30000);

    expect(healthNow().status).toBe('ok');
    expect(global.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('digital zeros: degraded at 15s, one same-device re-acquire, CRITICAL after silent verify', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);

    await vi.advanceTimersByTimeAsync(2000);
    expect(healthNow().status).toBe('ok');

    // Device dies: track stays live, delivers exact zeros (byte freq flat too)
    ctrl.amplitude = 0;
    ctrl.byteVal = 0;

    await vi.advanceTimersByTimeAsync(15500);
    // Escalated to degraded and fired the same-device re-acquire
    expect(global.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    const midHealth = healthNow();
    expect([recordingService.MIC_HEALTH_STATUS.DEGRADED, recordingService.MIC_HEALTH_STATUS.CRITICAL])
      .toContain(midHealth.status);

    // Verification window (5s) passes with zeros → CRITICAL, precise reason
    await vi.advanceTimersByTimeAsync(6000);
    const health = healthNow();
    expect(health.status).toBe('critical');
    expect(health.reasonCode).toBe('zero_signal');
    expect(health.afterSwitch).toBe(true);
    expect(health.silenceSince).not.toBeNull();
    expect(events.verified.some(e => e.ok === false && e.context === 'reacquire')).toBe(true);
    // No FURTHER re-acquire attempts (one per episode)
    expect(global.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('digital zeros: recovery succeeds when the re-acquired stream delivers signal', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);

    ctrl.amplitude = 0;
    ctrl.byteVal = 0;
    await vi.advanceTimersByTimeAsync(15500); // escalation + re-acquire begins

    // The re-acquired stream is healthy (e.g. Windows re-registered the endpoint)
    ctrl.amplitude = 0.1;
    ctrl.byteVal = 50;
    await vi.advanceTimersByTimeAsync(500);

    const health = healthNow();
    expect(health.status).toBe('ok');
    expect(health.verifying).toBe(false);
    expect(events.verified.some(e => e.ok === true && e.context === 'reacquire')).toBe(true);
  });

  it('manual switch onto a silent device is flagged within ~5s (not blessed as OK)', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);
    await vi.advanceTimersByTimeAsync(1000);

    const silentTrack = createTrack({ deviceId: 'mic-2', label: 'Dead BT Profile' });
    global.navigator.mediaDevices.getUserMedia.mockResolvedValue(new MockMediaStream([silentTrack]));

    const switchPromise = recordingService.switchMicrophoneStream('mic-2');
    ctrl.amplitude = 0; // the new device delivers nothing
    ctrl.byteVal = 0;
    const result = await switchPromise;
    expect(result.success).toBe(true);
    expect(healthNow().verifying).toBe(true);

    await vi.advanceTimersByTimeAsync(5500);
    const [verdict] = await Promise.all([result.verified, vi.advanceTimersByTimeAsync(100)]);
    expect(verdict).toBe('silent');

    const health = healthNow();
    expect(health.status).toBe('degraded');
    expect(health.reasonCode).toBe('zero_signal');
    expect(health.afterSwitch).toBe(true);
    expect(health.trackLabel).toBe('Dead BT Profile');
    expect(events.verified.some(e => e.ok === false && e.context === 'manual-switch')).toBe(true);
  });

  it('manual switch onto a live device verifies OK quickly', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);
    await vi.advanceTimersByTimeAsync(1000);

    const goodTrack = createTrack({ deviceId: 'mic-3', label: 'Laptop Mic Array' });
    global.navigator.mediaDevices.getUserMedia.mockResolvedValue(new MockMediaStream([goodTrack]));

    const result = await recordingService.switchMicrophoneStream('mic-3');
    expect(result.success).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    const verdict = await result.verified;
    expect(verdict).toBe('signal');
    const health = healthNow();
    expect(health.status).toBe('ok');
    expect(health.verifying).toBe(false);
    expect(events.verified.some(e => e.ok === true && e.context === 'manual-switch')).toBe(true);
  });

  it('modulated but whisper-level speech triggers LOW_LEVEL (degraded, never critical)', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);

    // Alternate: "syllables" at ≈-48dBFS RMS over a ≈-80dBFS noise floor.
    // Modulation-gated: this MUST fire (speech evidence present, far too quiet).
    for (let cycle = 0; cycle < 70; cycle++) {
      ctrl.amplitude = 0.0056; // ≈ -48dBFS RMS
      await vi.advanceTimersByTimeAsync(500);
      ctrl.amplitude = 0.0001; // ≈ -83dBFS peak floor (NOT digital zero)
      await vi.advanceTimersByTimeAsync(500);
    }

    const health = healthNow();
    expect(health.reasonCode).toBe('low_level');
    expect(health.status).toBe('degraded'); // informational — never critical
    expect(health.measuredDb).toBeLessThanOrEqual(-45);
  });

  it('a silent meeting pause does NOT trigger LOW_LEVEL (no modulation, no judgment)', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);

    // Steady faint room tone: constant level, no speech-like dynamics.
    ctrl.amplitude = 0.0005; // ≈ -66dBFS
    await vi.advanceTimersByTimeAsync(120000);

    expect(healthNow().reasonCode).not.toBe('low_level');
  });

  it('intentional mute suppresses zero-signal forensics entirely', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);
    await vi.advanceTimersByTimeAsync(1000);

    recordingService.toggleMicMute();
    ctrl.amplitude = 0;
    ctrl.byteVal = 0;
    await vi.advanceTimersByTimeAsync(60000);

    expect(healthNow().status).toBe('ok');
    expect(global.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1); // no re-acquire
  });

  it('active system audio relaxes zero-signal thresholds (no warning at 60s)', async () => {
    const store = createMockRecordingStore();
    const sysTrack = createTrack({ label: 'Loopback' });
    await startHealthyRecording(store, {
      systemAudioEnabled: true,
      captureSystemAudio: vi.fn().mockResolvedValue(new MockMediaStream([sysTrack]))
    });
    await vi.advanceTimersByTimeAsync(1000);

    ctrl.amplitude = 0;
    ctrl.byteVal = 0;
    await vi.advanceTimersByTimeAsync(60000);

    // Would be CRITICAL without system audio; with it the recording is still
    // useful, so the mic gets the relaxed 120s/300s thresholds.
    expect(healthNow().status).toBe('ok');
  });

  it('a track that dies DURING its verification probe resolves the probe (no hang)', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);
    await vi.advanceTimersByTimeAsync(1000);

    const dyingTrack = createTrack({ deviceId: 'mic-dying', label: 'Dying Device' });
    global.navigator.mediaDevices.getUserMedia.mockResolvedValue(new MockMediaStream([dyingTrack]));

    const result = await recordingService.switchMicrophoneStream('mic-dying');
    expect(result.success).toBe(true);

    ctrl.amplitude = 0;
    ctrl.byteVal = 0;
    dyingTrack.readyState = 'ended'; // unplugged right after the switch
    await vi.advanceTimersByTimeAsync(300);

    // The probe must resolve (verdict, not a hang) and health must be honest.
    const verdict = await result.verified;
    expect(verdict).toBe('silent');
    const health = healthNow();
    expect(health.reasonCode).toBe('track_ended');
    expect(health.verifying).toBe(false);
  });

  it('track-ended auto-recovery iterates candidates and only announces a VERIFIED device', async () => {
    const store = createMockRecordingStore();
    const { micTrack } = await startHealthyRecording(store);
    await vi.advanceTimersByTimeAsync(1000);

    // Capture the DREC-3 devicechange handler the service registered.
    const devChangeCall = global.navigator.mediaDevices.addEventListener.mock.calls
      .find(c => c[0] === 'devicechange');
    expect(devChangeCall).toBeTruthy();
    const fireDeviceChange = devChangeCall[1];

    // The selected device vanishes: track ends, then the device list changes.
    micTrack.readyState = 'ended';
    ctrl.amplitude = 0;
    ctrl.byteVal = 0;
    await vi.advanceTimersByTimeAsync(300); // health loop notices → TRACK_ENDED
    expect(healthNow().reasonCode).toBe('track_ended');

    global.navigator.mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'phantom-bt', label: 'Phantom BT' },
      { kind: 'audioinput', deviceId: 'communications', label: 'Comms alias' }, // must be skipped
      { kind: 'audioinput', deviceId: 'laptop-mic', label: 'Laptop Mic' }
    ]);
    global.navigator.mediaDevices.getUserMedia.mockImplementation(async (req) => {
      const id = req?.audio?.deviceId?.exact || req?.audio?.deviceId?.ideal || 'unknown';
      return new MockMediaStream([createTrack({ deviceId: id, label: id === 'laptop-mic' ? 'Laptop Mic' : 'Phantom BT' })]);
    });

    const recovery = fireDeviceChange(); // async handler
    // Candidate 1 (phantom-bt): silent for its whole 5s probe window…
    await vi.advanceTimersByTimeAsync(5500);
    // …candidate 2 (laptop-mic): delivers signal.
    ctrl.amplitude = 0.1;
    ctrl.byteVal = 50;
    await vi.advanceTimersByTimeAsync(500);
    await recovery;

    expect(events.autoSwitched.length).toBe(1);
    expect(events.autoSwitched[0].deviceId).toBe('laptop-mic');
    expect(events.recovered.length).toBe(1);
    expect(healthNow().status).toBe('ok');
    // The silent candidate was probed and rejected, not announced.
    expect(events.verified.some(e => e.ok === false && e.context === 'auto-recovery')).toBe(true);
  });
});
