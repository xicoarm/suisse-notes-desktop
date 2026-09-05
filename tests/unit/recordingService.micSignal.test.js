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
    this.state = ctrl.contextState || 'running';
    MockAudioContext.instances.push(this);
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

  close() { this.state = 'closed'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
}
MockAudioContext.instances = [];

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
  if (opts.produceChunks) {
    const recorder = MockMediaRecorder.last;
    setInterval(() => {
      if (recorder.state === 'recording') recorder.ondataavailable?.({
        target: recorder, data: { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
      });
    }, 3000);
  }
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
    ctrl.contextState = 'running';
    MockAudioContext.instances = [];
    MockMediaRecorder.last = null;

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

  function startWithPendingContext(store) {
    const micTrack = createTrack({ deviceId: 'mic-1' });
    navigator.mediaDevices.getUserMedia.mockResolvedValue(new MockMediaStream([micTrack]));
    const starting = recordingService.startRecording({
      recordingStore: store, authStore: null, deviceId: 'mic-1',
      systemAudioEnabled: false, isAutoSplitting: { value: false }
    });
    return { starting, micTrack };
  }

  it('bounds a never-resolving audio-context resume and releases the microphone before allowing retry', async () => {
    const store = createMockRecordingStore();
    ctrl.contextState = 'suspended';
    vi.spyOn(MockAudioContext.prototype, 'resume').mockReturnValue(new Promise(() => {}));
    const { starting, micTrack } = startWithPendingContext(store);
    await vi.advanceTimersByTimeAsync(7999);
    expect(store.confirmCaptureStarted).not.toHaveBeenCalled();
    expect(MockMediaRecorder.last).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await starting).toMatchObject({ success: false, error: expect.stringContaining('8 seconds') });
    expect(micTrack.stop).toHaveBeenCalled();
    expect(MockAudioContext.instances.every(ctx => ctx.state === 'closed')).toBe(true);
    expect(store.reset).toHaveBeenCalledTimes(1);
    ctrl.contextState = 'running';
    await startHealthyRecording(createMockRecordingStore());
  });

  it.each(['suspended', 'interrupted'])('does not confirm capture when the %s audio context rejects resume', async state => {
    const store = createMockRecordingStore();
    ctrl.contextState = state;
    vi.spyOn(MockAudioContext.prototype, 'resume').mockRejectedValue(new Error('device unavailable'));
    const { starting, micTrack } = startWithPendingContext(store);
    expect(await starting).toMatchObject({ success: false, error: 'device unavailable' });
    expect(store.confirmCaptureStarted).not.toHaveBeenCalled();
    expect(micTrack.stop).toHaveBeenCalled();
    expect(MockMediaRecorder.last).toBeNull();
  });

  it.each(['closed', 'suspended'])('rejects a %s context even if resume reports success without running', async state => {
    const store = createMockRecordingStore();
    ctrl.contextState = state;
    const resume = vi.spyOn(MockAudioContext.prototype, 'resume').mockResolvedValue();
    const { starting, micTrack } = startWithPendingContext(store);
    expect((await starting).success).toBe(false);
    expect(store.confirmCaptureStarted).not.toHaveBeenCalled();
    expect(micTrack.stop).toHaveBeenCalled();
    expect(MockMediaRecorder.last).toBeNull();
    expect(resume).toHaveBeenCalledTimes(state === 'closed' ? 0 : 1);
  });

  it.each(['cancel', 'cleanup'])('cannot revive startup after %s when an earlier resume resolves late', async action => {
    const store = createMockRecordingStore();
    ctrl.contextState = 'suspended';
    let finishResume;
    vi.spyOn(MockAudioContext.prototype, 'resume').mockImplementation(function () {
      const ctx = this;
      return new Promise(resolve => { finishResume = () => { ctx.state = 'running'; resolve(); }; });
    });
    const { starting, micTrack } = startWithPendingContext(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(finishResume).toBeTypeOf('function');
    if (action === 'cancel') await recordingService.cancelRecording(store);
    else recordingService.cleanup();
    finishResume();
    expect(await starting).toMatchObject({ success: false, cancelled: true });
    expect(store.confirmCaptureStarted).not.toHaveBeenCalled();
    expect(store.reset).not.toHaveBeenCalled();
    expect(MockMediaRecorder.last).toBeNull();
    expect(micTrack.stop).toHaveBeenCalled();
    expect(MockAudioContext.instances.every(ctx => ctx.state === 'closed')).toBe(true);
  });

  it.each(['no events', 'empty events'])('warns about %s before the timer can imply a saved meeting and retains the warning after recovery', async mode => {
    const previousApi = window.electronAPI;
    const saveMetadata = vi.fn().mockResolvedValue({ success: true });
    window.electronAPI = { recording: { saveMetadata } };
    const stalled = vi.fn();
    const recovered = vi.fn();
    recordingService.addEventListener('captureStalled', stalled);
    recordingService.addEventListener('captureRecovered', recovered);
    try {
      const store = createMockRecordingStore();
      await startHealthyRecording(store);
      const recorder = MockMediaRecorder.last;
      if (mode === 'empty events') {
        for (let i = 0; i < 3; i++) {
          await vi.advanceTimersByTimeAsync(3000);
          recorder.ondataavailable({ target: recorder, data: { size: 0 } });
        }
        await vi.advanceTimersByTimeAsync(1000);
      } else await vi.advanceTimersByTimeAsync(10000);
      const eventCount = mode === 'empty events' ? 3 : 0;
      expect(stalled).toHaveBeenCalledTimes(1);
      expect(stalled).toHaveBeenLastCalledWith(expect.objectContaining({
        savedChunks: 0, receivedDataEvents: eventCount, emptyDataEvents: eventCount,
        receivedDataBytes: 0, pendingChunks: 0, mediaState: 'recording', contextState: 'running'
      }));
      expect(store.saveChunk).not.toHaveBeenCalled();
      expect(store.updateDuration).toHaveBeenLastCalledWith(3);
      expect(saveMetadata).toHaveBeenCalledWith('rec-test', expect.objectContaining({ captureWarnings: ['capture-stalled'] }));
      expect(recovered).not.toHaveBeenCalled();
      recorder.ondataavailable({ target: recorder, data: { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(store.saveChunk).toHaveBeenCalledWith([1, 2, 3]);
      expect(recovered).toHaveBeenCalled();
      expect(saveMetadata).toHaveBeenCalledTimes(1); // Recovery must never erase the gap warning.
    } finally {
      recordingService.removeEventListener('captureStalled', stalled);
      recordingService.removeEventListener('captureRecovered', recovered);
      window.electronAPI = previousApi;
    }
  });

  it('does not acknowledge an empty data event as successfully flushed audio', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);
    const recorder = MockMediaRecorder.last;
    recorder.requestData = () => recorder.ondataavailable({ target: recorder, data: { size: 0 } });
    expect(await recordingService.flushRecordingData()).toEqual({ flushed: false, timedOut: false });
    expect(store.saveChunk).not.toHaveBeenCalled();
    expect(recordingService.getSavedChunkCount()).toBe(0);
  });

  it.each([true, false])('bounds an aging backlog only on Electron (%s), retaining final audio and the warning until finalization', async electron => {
    const previousApi = window.electronAPI;
    const saveMetadata = vi.fn().mockResolvedValue({ success: true });
    window.electronAPI = electron ? { recording: { saveMetadata } } : undefined;
    const warnings = vi.fn();
    recordingService.addEventListener('chunkSaveFailure', warnings);
    let timer;
    try {
      const store = createMockRecordingStore();
      const saved = [];
      store.saveChunk.mockImplementation(bytes => new Promise(resolve => setTimeout(() => {
        saved.push(bytes[0]); resolve({ success: true });
      }, 2000)));
      await startHealthyRecording(store);
      const recorder = MockMediaRecorder.last;
      const send = value => recorder.ondataavailable({ target: recorder,
        data: { size: 1, arrayBuffer: async () => Uint8Array.of(value).buffer } });
      const stopped = vi.spyOn(recorder, 'stop').mockImplementation(() => {
        recorder.state = 'inactive';
        send(99); // Reentrant final event must not trigger another stop.
        recorder.onstop?.();
      });
      let accepted = 0;
      timer = setInterval(() => { if (recorder.state === 'recording') send(accepted++); }, 1000);
      await vi.advanceTimersByTimeAsync(32000);
      clearInterval(timer);
      if (electron) {
        expect(stopped).toHaveBeenCalledTimes(1); // No UI emergency listener installed.
        expect(warnings).toHaveBeenCalledTimes(1);
        expect(warnings.mock.calls[0][0]).toMatchObject({ backpressure: true, oldestPendingMs: 15000 });
        expect(warnings.mock.calls[0][0]).not.toHaveProperty('retriesExhausted');
        expect(store.chunkSaveErrors).toBe(0);
        expect(store.chunkSaveErrorWarning).toBe(true); // Later saves have already succeeded.
        expect(saveMetadata).toHaveBeenCalledWith('rec-test', expect.objectContaining({ captureWarnings: ['capture-backpressure'] }));
      } else {
        expect(stopped).not.toHaveBeenCalled();
        expect(warnings).not.toHaveBeenCalled();
        expect(recorder.state).toBe('recording');
      }
      const finalizing = recordingService.stopRecording(store);
      await vi.advanceTimersByTimeAsync(100000);
      expect(await finalizing).toMatchObject({ success: true });
      expect(saved).toEqual([...Array.from({ length: accepted }, (_, i) => i), 99]);
      expect(stopped).toHaveBeenCalledTimes(1);
      if (electron) {
        expect(store.chunkSaveErrorWarning).toBe(false);
        expect(warnings).toHaveBeenCalledTimes(2);
        expect(warnings).toHaveBeenLastCalledWith(null);
      }
    } finally {
      clearInterval(timer);
      recordingService.removeEventListener('chunkSaveFailure', warnings);
      window.electronAPI = previousApi;
    }
  });

  it.each([false, true])('waits for queued final events after backlog stop, with an emergency listener (%s)', async withListener => {
    const previousApi = window.electronAPI;
    window.electronAPI = { recording: {
      saveMetadata: vi.fn().mockResolvedValue({ success: true }),
      setUnsavedAudio: vi.fn(), setInProgress: vi.fn(), setProcessing: vi.fn()
    } };
    const store = createMockRecordingStore();
    const stopSystemAudio = vi.fn().mockResolvedValue();
    let finalizing, releaseFirst;
    const warning = vi.fn(data => {
      if (withListener && data?.backpressure) finalizing = recordingService.stopRecording(store, stopSystemAudio);
    });
    recordingService.addEventListener('chunkSaveFailure', warning);
    try {
      store.saveChunk.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }));
      await startHealthyRecording(store);
      const recorder = MockMediaRecorder.last;
      const send = value => recorder.ondataavailable({ target: recorder,
        data: { size: 1, arrayBuffer: async () => Uint8Array.of(value).buffer } });
      const stopped = vi.spyOn(recorder, 'stop').mockImplementation(() => {
        recorder.state = 'inactive';
        setTimeout(() => { send(99); recorder.onstop?.(); }, 50);
      });
      send(1);
      await vi.advanceTimersByTimeAsync(15000);
      send(2); // The first save is still pending: stop before more capture accumulates.
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(recorder.state).toBe('inactive');
      if (!withListener) finalizing = recordingService.stopRecording(store, stopSystemAudio);
      await vi.advanceTimersByTimeAsync(25);
      expect(stopSystemAudio).not.toHaveBeenCalled(); // Do not tear down before native final data.
      expect(store.stopRecording).not.toHaveBeenCalled();
      expect(store.chunkSaveErrorWarning).toBe(true);
      await vi.advanceTimersByTimeAsync(25);
      expect(stopSystemAudio).toHaveBeenCalledTimes(1);
      expect(store.stopRecording).not.toHaveBeenCalled(); // Final data also waits for durable FIFO saves.
      releaseFirst({ success: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(await finalizing).toMatchObject({ success: true });
      expect(store.saveChunk.mock.calls.map(([bytes]) => bytes)).toEqual([[1], [2], [99]]);
      expect(store.stopRecording).toHaveBeenCalledTimes(1);
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(store.chunkSaveErrorWarning).toBe(false);
      expect(warning).toHaveBeenLastCalledWith(null);
    } finally {
      releaseFirst?.({ success: true });
      await vi.advanceTimersByTimeAsync(50);
      await finalizing;
      recordingService.removeEventListener('chunkSaveFailure', warning);
      window.electronAPI = previousApi;
    }
  });

  it('bounds foreground resume across all suspended contexts instead of hanging on the first one', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);
    for (const ctx of MockAudioContext.instances) ctx.state = 'suspended';
    const resume = vi.spyOn(MockAudioContext.prototype, 'resume').mockReturnValue(new Promise(() => {}));
    let finished = false;
    const resuming = recordingService.resumeAudioContexts().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(7999);
    expect(finished).toBe(false);
    expect(resume.mock.calls.length).toBeGreaterThan(1); // A blocked context cannot prevent the others from resuming.
    await vi.advanceTimersByTimeAsync(1);
    await resuming;
    expect(finished).toBe(true);
  });

  it('does not announce a stale foreground resume after that recording was discarded', async () => {
    const store = createMockRecordingStore();
    await startHealthyRecording(store);
    MockAudioContext.instances[0].state = 'suspended';
    let finishResume;
    vi.spyOn(MockAudioContext.prototype, 'resume').mockReturnValue(new Promise(resolve => { finishResume = resolve; }));
    const logged = vi.spyOn(console, 'log');
    const resuming = recordingService.resumeAudioContexts();
    await recordingService.cancelRecording(store);
    await startHealthyRecording(createMockRecordingStore());
    logged.mockClear();
    finishResume();
    await resuming;
    expect(logged).not.toHaveBeenCalledWith(expect.stringContaining('Resumed AudioContext'));
  });

  it('retries capture recovery after a hung resume deadline and resumes the existing recorder', async () => {
    const store = createMockRecordingStore();
    const { micTrack } = await startHealthyRecording(store);
    const ctx = MockAudioContext.instances[0];
    const recorder = MockMediaRecorder.last;
    const requestData = vi.spyOn(recorder, 'requestData');
    const resume = vi.spyOn(MockAudioContext.prototype, 'resume')
      .mockReturnValueOnce(new Promise(() => {}))
      .mockImplementation(function () { this.state = 'running'; return Promise.resolve(); });
    await vi.advanceTimersByTimeAsync(1000);
    ctx.state = 'suspended';
    micTrack.onmute();
    await vi.advanceTimersByTimeAsync(8000);
    expect(requestData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(requestData).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.last).toBe(recorder);
    expect(ctx.state).toBe('running');
  });

  it('does not let an old recovery completion touch a new recorder or release its recovery lock', async () => {
    const oldStore = createMockRecordingStore();
    const { micTrack: oldTrack } = await startHealthyRecording(oldStore);
    const oldContext = MockAudioContext.instances[0];
    const completions = [];
    const resume = vi.spyOn(MockAudioContext.prototype, 'resume').mockImplementation(() => new Promise(resolve => completions.push(resolve)));
    await vi.advanceTimersByTimeAsync(1000);
    oldContext.state = 'suspended';
    oldTrack.onmute();
    await recordingService.cancelRecording(oldStore);
    const nextStore = createMockRecordingStore();
    const { micTrack: nextTrack } = await startHealthyRecording(nextStore);
    const nextContext = MockAudioContext.instances.find(ctx => ctx.state === 'running');
    const requestData = vi.spyOn(MockMediaRecorder.last, 'requestData');
    await vi.advanceTimersByTimeAsync(1000);
    nextContext.state = 'suspended';
    nextTrack.onmute();
    expect(resume).toHaveBeenCalledTimes(2);
    completions[0]();
    await vi.advanceTimersByTimeAsync(5000);
    expect(requestData).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(2); // Old finally must not release the new episode's in-flight latch.
    completions[1]();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('retains a disconnected microphone warning after a replacement is verified healthy', async () => {
    const previousApi = window.electronAPI;
    const metadata = { captureWarnings: ['existing-warning'] };
    const saveMetadata = vi.fn(async (id, patch) => {
      expect(id).toBe('rec-test');
      metadata.captureWarnings = [...new Set([...metadata.captureWarnings, ...patch.captureWarnings])];
      return { success: true };
    });
    window.electronAPI = { recording: { saveMetadata } };
    try {
      const store = createMockRecordingStore();
      const { micTrack } = await startHealthyRecording(store, { produceChunks: true });
      micTrack.readyState = 'ended';
      micTrack.onended();
      await vi.advanceTimersByTimeAsync(300);
      expect(saveMetadata).toHaveBeenCalledWith('rec-test', expect.objectContaining({
        captureWarnings: ['microphone-disconnected'],
        lastMicrophoneWarning: expect.objectContaining({ kind: 'microphone-disconnected', reasonCode: 'track_ended' })
      }));
      expect(saveMetadata).toHaveBeenCalledTimes(1);
      navigator.mediaDevices.getUserMedia.mockResolvedValue(new MockMediaStream([createTrack({ deviceId: 'replacement' })]));
      const result = await recordingService.switchMicrophoneStream('replacement');
      await vi.advanceTimersByTimeAsync(400);
      expect(await result.verified).toBe('signal');
      expect(healthNow().status).toBe('ok');
      expect(metadata.captureWarnings).toEqual(['existing-warning', 'microphone-disconnected']);
      expect(saveMetadata).toHaveBeenCalledTimes(1);
    } finally { window.electronAPI = previousApi; }
  });

  it('retains zero-signal evidence after the same microphone begins delivering audio again', async () => {
    const previousApi = window.electronAPI;
    const saveMetadata = vi.fn().mockResolvedValue({ success: true });
    window.electronAPI = { recording: { saveMetadata } };
    try {
      const store = createMockRecordingStore();
      await startHealthyRecording(store, { produceChunks: true });
      ctrl.amplitude = 0; ctrl.byteVal = 0;
      await vi.advanceTimersByTimeAsync(21000);
      expect(saveMetadata).toHaveBeenCalledWith('rec-test', expect.objectContaining({
        captureWarnings: ['microphone-zero-signal'],
        lastMicrophoneWarning: expect.objectContaining({ reasonCode: 'zero_signal', silenceSince: expect.any(Number) })
      }));
      expect(saveMetadata).toHaveBeenCalledTimes(1);
      ctrl.amplitude = 0.1; ctrl.byteVal = 50;
      await vi.advanceTimersByTimeAsync(4000);
      expect(healthNow().status).toBe('ok');
      expect(saveMetadata).toHaveBeenCalledTimes(1); // Healthy input must not clear the durable warning.
    } finally { window.electronAPI = previousApi; }
  });

  it('retries failed microphone-warning persistence with a bounded rate even if health remains unchanged', async () => {
    const previousApi = window.electronAPI;
    const saveMetadata = vi.fn().mockResolvedValueOnce({ success: false, error: 'temporary write failure' }).mockResolvedValue({ success: true });
    window.electronAPI = { recording: { saveMetadata } };
    try {
      const store = createMockRecordingStore();
      const { micTrack } = await startHealthyRecording(store, { produceChunks: true });
      micTrack.readyState = 'ended';
      await vi.advanceTimersByTimeAsync(4900);
      expect(saveMetadata).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveMetadata).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10000);
      expect(saveMetadata).toHaveBeenCalledTimes(2);
      expect(saveMetadata.mock.calls[0][1].lastMicrophoneWarning).toEqual(saveMetadata.mock.calls[1][1].lastMicrophoneWarning);
    } finally { window.electronAPI = previousApi; }
  });

  it('still persists earlier microphone loss if the first metadata write failed and capture already recovered', async () => {
    const previousApi = window.electronAPI;
    const saveMetadata = vi.fn().mockRejectedValueOnce(new Error('temporary IPC error')).mockResolvedValue({ success: true });
    window.electronAPI = { recording: { saveMetadata } };
    try {
      const store = createMockRecordingStore();
      const { micTrack } = await startHealthyRecording(store, { produceChunks: true });
      micTrack.readyState = 'ended';
      await vi.advanceTimersByTimeAsync(200);
      navigator.mediaDevices.getUserMedia.mockResolvedValue(new MockMediaStream([createTrack({ deviceId: 'replacement' })]));
      const switched = await recordingService.switchMicrophoneStream('replacement');
      await vi.advanceTimersByTimeAsync(400);
      expect(await switched.verified).toBe('signal');
      expect(healthNow().status).toBe('ok');
      await vi.advanceTimersByTimeAsync(5500);
      expect(saveMetadata).toHaveBeenCalledTimes(2);
      expect(saveMetadata).toHaveBeenLastCalledWith('rec-test', expect.objectContaining({ captureWarnings: ['microphone-disconnected'] }));
    } finally { window.electronAPI = previousApi; }
  });

  afterEach(() => {
    // Deregister — the service is a module singleton, so leaked listeners
    // from earlier tests would multiply-push into the current events object.
    for (const [evt, fn] of Object.entries(listeners)) {
      recordingService.removeEventListener(evt, fn);
    }
    recordingService.cleanup();
    vi.clearAllTimers();
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

  it('retains a late final blob and protects it from new recording or shutdown until saved', async () => {
    const store = createMockRecordingStore(); await startHealthyRecording(store);
    const previousApi = window.electronAPI;
    const setUnsavedAudio = vi.fn().mockResolvedValue({ success: true });
    window.electronAPI = { recording: {
      setUnsavedAudio, setInProgress: vi.fn(), setProcessing: vi.fn(), saveMetadata: vi.fn().mockResolvedValue({ success: true })
    } };
    try {
      const recorder = MockMediaRecorder.last;
      recorder.stop = () => {
        recorder.state = 'inactive';
        setTimeout(() => {
          recorder.ondataavailable({ target: recorder, data: { size: 3, arrayBuffer: async () => new Uint8Array([4, 5, 6]).buffer } });
          recorder.onstop();
        }, 11000);
      };
      const stopping = recordingService.stopRecording(store);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await stopping).toMatchObject({ success: false, unsavedAudio: true });
      expect(setUnsavedAudio).toHaveBeenLastCalledWith('rec-test');
      expect((await recordingService.startRecording({})).success).toBe(false);
      expect((await recordingService.stopRecording(store)).success).toBe(false);
      expect(setUnsavedAudio).toHaveBeenLastCalledWith('rec-test');
      expect(store.stopRecording).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1100);
      expect((await recordingService.stopRecording(store)).success).toBe(true);
      expect(store.saveChunk).toHaveBeenCalledWith([4, 5, 6]);
      expect(setUnsavedAudio).toHaveBeenLastCalledWith(null);
    } finally { window.electronAPI = previousApi; }
  });

  it('ignores a discarded recorder’s late data and stop event after a new recording starts', async () => {
    const oldStore = createMockRecordingStore(); await startHealthyRecording(oldStore);
    const old = MockMediaRecorder.last;
    old.stop = () => {
      old.state = 'inactive';
      setTimeout(() => {
        old.ondataavailable({ target: old, data: { size: 1, arrayBuffer: async () => new Uint8Array([9]).buffer } });
        old.onstop?.();
      }, 11000);
    };
    const stopping = recordingService.stopRecording(oldStore);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await stopping).success).toBe(false);
    await recordingService.cancelRecording(oldStore);
    const nextStore = createMockRecordingStore(); await startHealthyRecording(nextStore);
    const next = MockMediaRecorder.last;
    const stopNext = vi.spyOn(next, 'stop');
    await vi.advanceTimersByTimeAsync(1100);
    expect(oldStore.saveChunk).not.toHaveBeenCalled();
    expect(nextStore.saveChunk).not.toHaveBeenCalled();
    expect((await recordingService.stopRecording(nextStore)).success).toBe(true);
    expect(stopNext).toHaveBeenCalledTimes(1);
  });

  it('does not let a discarded recorder’s error stop the next recording', async () => {
    const oldStore = createMockRecordingStore(); await startHealthyRecording(oldStore);
    const old = MockMediaRecorder.last;
    await recordingService.cancelRecording(oldStore);
    const nextStore = createMockRecordingStore(); await startHealthyRecording(nextStore);
    const next = MockMediaRecorder.last;
    old.onerror({ error: new Error('late error from discarded recorder') });
    expect(next.state).toBe('recording');
    expect(nextStore.setError).not.toHaveBeenCalled();
    expect(oldStore.setError).not.toHaveBeenCalled();
    await recordingService.stopRecording(nextStore);
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
    await startHealthyRecording(store, { produceChunks: true });

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
    await startHealthyRecording(store, { produceChunks: true });

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
