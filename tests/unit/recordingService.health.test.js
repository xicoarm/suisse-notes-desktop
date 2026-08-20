import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as recordingService from '../../src/services/recordingService';

class MockAudioContext {
  constructor() {
    this.state = 'running';
  }

  createAnalyser() {
    return {
      fftSize: 256,
      frequencyBinCount: 128,
      getByteFrequencyData: (array) => array.fill(0)
    };
  }

  createMediaStreamSource() {
    return {
      connect: () => {},
      disconnect: () => {}
    };
  }

  createMediaStreamDestination() {
    return {
      stream: {
        getTracks: () => []
      }
    };
  }

  close() {
    return Promise.resolve();
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  addEventListener() {}
}

class MockMediaRecorder {
  constructor() {
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    if (this.onstop) {
      this.onstop();
    }
  }

  pause() {
    this.state = 'paused';
  }

  resume() {
    this.state = 'recording';
  }

  requestData() {
    if (this.ondataavailable) {
      this.ondataavailable({ data: { size: 0 } });
    }
  }
}

MockMediaRecorder.isTypeSupported = () => true;

class MockMediaStream {
  constructor(track) {
    this.track = track;
  }

  getAudioTracks() {
    return [this.track];
  }

  getTracks() {
    return [this.track];
  }
}

function createMockRecordingStore() {
  return {
    startRecording: vi.fn().mockResolvedValue({ success: true }),
    stopRecording: vi.fn().mockResolvedValue({ success: true, filePath: 'fake.webm' }),
    saveChunk: vi.fn().mockResolvedValue({ success: true }),
    setError: vi.fn(),
    updateDuration: vi.fn(),
    handleRecordingDeath: vi.fn(),
    reset: vi.fn(),
    chunkSaveErrors: 0,
    chunkSaveErrorWarning: false,
    isRecording: false,
    isPaused: false,
    recordingInterrupted: false,
    chunkIndex: 0,
    recordId: null
  };
}

function createTrack(settings = {}) {
  return {
    kind: 'audio',
    enabled: true,
    readyState: 'live',
    stop: vi.fn(),
    getSettings: () => settings,
    label: settings.label || 'Mock Track'
  };
}

function createStream(track) {
  return new MockMediaStream(track);
}

describe('recordingService microphone health', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    global.MediaRecorder = MockMediaRecorder;
    global.MediaStream = MockMediaStream;
    global.window.AudioContext = MockAudioContext;
    global.window.webkitAudioContext = MockAudioContext;

    global.navigator.mediaDevices = {
      getUserMedia: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
  });

  afterEach(() => {
    recordingService.cleanup();
  });

  it('marks health as critical when microphone capture fails but system audio is available', async () => {
    const recordingStore = createMockRecordingStore();
    const systemTrack = createTrack({ label: 'System Track' });
    const systemStream = createStream(systemTrack);

    global.navigator.mediaDevices.getUserMedia.mockRejectedValue(new Error('Mic unavailable'));

    const result = await recordingService.startRecording({
      recordingStore,
      authStore: null,
      deviceId: 'preferred-mic',
      systemAudioEnabled: true,
      captureSystemAudio: vi.fn().mockResolvedValue(systemStream),
      isAutoSplitting: { value: false },
      maxRecordingSeconds: null
    });

    expect(result.success).toBe(true);
    expect(recordingStore.startRecording).toHaveBeenCalledTimes(1);

    const health = recordingService.getState().recordingHealth;
    expect(health.status).toBe('critical');
    expect(health.reasonCode).toBe('mic_capture_failed');
    expect(health.micActive).toBe(false);
    expect(health.systemAudioActive).toBe(true);
  });

  it('keeps microphone health as ok when microphone stream is captured', async () => {
    const recordingStore = createMockRecordingStore();
    const micTrack = createTrack({
      deviceId: 'actual-mic-id',
      sampleRate: 48000,
      channelCount: 1,
      label: 'Primary Mic'
    });
    const micStream = createStream(micTrack);

    global.navigator.mediaDevices.getUserMedia.mockResolvedValue(micStream);

    const result = await recordingService.startRecording({
      recordingStore,
      authStore: null,
      deviceId: 'selected-mic-id',
      systemAudioEnabled: false,
      captureSystemAudio: null,
      isAutoSplitting: { value: false },
      maxRecordingSeconds: null
    });

    expect(result.success).toBe(true);

    const health = recordingService.getState().recordingHealth;
    expect(health.status).toBe('ok');
    expect(health.reasonCode).toBeNull();
    expect(health.micActive).toBe(true);
    expect(health.inputDeviceId).toBe('selected-mic-id');
    expect(health.actualDeviceId).toBe('actual-mic-id');
  });

  it('coalesces concurrent start requests before MediaRecorder exists', async () => {
    const recordingStore = createMockRecordingStore();
    const micTrack = createTrack({ deviceId: 'race-mic-id' });
    const micStream = createStream(micTrack);
    const pendingMicRequests = [];

    global.navigator.mediaDevices.getUserMedia.mockImplementation(() => (
      new Promise((resolve) => pendingMicRequests.push(resolve))
    ));

    const options = {
      recordingStore,
      authStore: null,
      deviceId: 'race-mic-id',
      systemAudioEnabled: false,
      captureSystemAudio: null,
      isAutoSplitting: { value: false },
      maxRecordingSeconds: null
    };

    const firstStart = recordingService.startRecording(options);
    const secondStart = recordingService.startRecording(options);

    pendingMicRequests.forEach((resolve) => resolve(micStream));

    const [firstResult, secondResult] = await Promise.all([firstStart, secondStart]);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    expect(global.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(recordingStore.startRecording).toHaveBeenCalledTimes(1);
  });
});
