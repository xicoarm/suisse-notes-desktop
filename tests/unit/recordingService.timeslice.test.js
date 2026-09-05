import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/boot/sentry', () => ({ captureMessage: vi.fn() }));

let service;
let recorder;
const originalApi = window.electronAPI;
const originalCapacitor = window.Capacitor;

class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
  getVideoTracks() { return []; }
}
class Context {
  constructor() { this.state = 'running'; }
  createAnalyser() { return { fftSize: 256, frequencyBinCount: 128, getByteFrequencyData: a => a.fill(40) }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: new Stream() }; }
  addEventListener() {}
  removeEventListener() {}
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
class Recorder {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; recorder = this; }
  start = vi.fn(() => { this.state = 'recording'; });
  stop() { this.state = 'inactive'; this.onstop?.(); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  requestData() { this.ondataavailable?.({ target: this, data: { size: 0 } }); }
}

async function start(platform, { production = true, override = '250', maxSeconds = null } = {}) {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubEnv('PROD', production);
  vi.stubEnv('VITE_SUISSE_MEDIA_RECORDER_TIMESLICE_MS', override);
  delete window.electronAPI;
  delete window.Capacitor;
  if (platform === 'electron') window.electronAPI = {};
  if (platform === 'ios') window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('MediaStream', Stream);
  window.AudioContext = Context;
  window.webkitAudioContext = Context;
  navigator.mediaDevices = { getUserMedia: vi.fn().mockResolvedValue(new Stream([{
    kind: 'audio', enabled: true, readyState: 'live', label: 'Synthetic mic',
    stop() {}, getSettings: () => ({ deviceId: 'fixture' })
  }])), addEventListener() {}, removeEventListener() {}, enumerateDevices: async () => [] };
  service = await import('../../src/services/recordingService');
  const store = {
    recordId: 'timeslice-fixture', isRecording: false, isPaused: false, recordingInterrupted: false,
    chunkSaveErrors: 0, chunkSaveErrorWarning: false, chunkIndex: 0,
    startRecording: vi.fn(async () => ({ success: true })),
    confirmCaptureStarted: vi.fn(() => { store.isRecording = true; }),
    pauseRecording: vi.fn(() => { store.isRecording = false; store.isPaused = true; }),
    resumeRecording: vi.fn(() => { store.isRecording = true; store.isPaused = false; }),
    saveChunk: vi.fn(async () => ({ success: true })), updateDuration: vi.fn(),
    setError: vi.fn(), reset: vi.fn(), handleRecordingDeath: vi.fn()
  };
  expect(await service.startRecording({ recordingStore: store, authStore: null, deviceId: 'fixture',
    systemAudioEnabled: false, isAutoSplitting: { value: false }, maxRecordingSeconds: maxSeconds })).toMatchObject({ success: true });
  return store;
}

afterEach(() => {
  service?.cleanup();
  service = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (originalApi === undefined) delete window.electronAPI; else window.electronAPI = originalApi;
  if (originalCapacitor === undefined) delete window.Capacitor; else window.Capacitor = originalCapacitor;
});

describe('native recording slice policy', () => {
  it.each([['electron', 1000], ['ios', 3000], ['web', 3000]])('uses the %s production interval and rejects stray environment overrides', async (platform, interval) => {
    await start(platform);
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(recorder.start).toHaveBeenCalledWith(interval);
  });

  it('keeps the explicit development override', async () => {
    await start('electron', { production: false });
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(recorder.start).toHaveBeenCalledWith(250);
  });

  it('does not advance the desktop capture estimate until the save acknowledges', async () => {
    const store = await start('electron');
    let acknowledge;
    store.saveChunk.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    recorder.ondataavailable({ target: recorder, data: { size: 1, arrayBuffer: async () => Uint8Array.of(42).buffer } });
    await vi.advanceTimersByTimeAsync(5000);
    const pendingDuration = store.updateDuration.mock.lastCall[0];
    const pendingSavedCount = service.getSavedChunkCount();
    acknowledge({ success: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pendingDuration).toBe(1);
    expect(pendingSavedCount).toBe(0);
    expect(store.updateDuration).toHaveBeenLastCalledWith(2);
    expect(service.getSavedChunkCount()).toBe(1);
  });

  it('keeps the elapsed-time limit independent of the saved estimate and excludes pause time', async () => {
    const store = await start('electron', { maxSeconds: 5 });
    const limit = vi.fn();
    service.addEventListener('limitReached', limit);
    await vi.advanceTimersByTimeAsync(2000);
    service.pauseRecording(store);
    await vi.advanceTimersByTimeAsync(10000);
    expect(service.getWallClockSeconds()).toBe(2);
    expect(limit).not.toHaveBeenCalled();
    service.resumeRecording(store, { value: false }, 5);
    await vi.advanceTimersByTimeAsync(3000);
    expect(service.getWallClockSeconds()).toBe(5);
    expect(store.updateDuration).toHaveBeenLastCalledWith(1);
    expect(limit).toHaveBeenCalledTimes(1);
    service.removeEventListener('limitReached', limit);
  });
});
