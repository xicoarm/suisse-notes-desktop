import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/boot/sentry', () => ({ captureMessage: vi.fn() }));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const blob = value => ({ size: 1, arrayBuffer: async () => Uint8Array.of(value).buffer });
let service, store, bridge, recorders, mic, system, events, mixedStartError;
const previousApi = window.electronAPI;

class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
  getVideoTracks() { return []; }
}
function source(name) {
  return new Stream([{ kind: 'audio', name, label: name, enabled: true, readyState: 'live',
    getSettings: () => ({ deviceId: name, sampleRate: 48000, channelCount: 1 }),
    stop: vi.fn(() => events.push(['track-stop', name])),
  }]);
}
class Context {
  constructor() { this.state = 'running'; }
  createAnalyser() { return { fftSize: 256, frequencyBinCount: 128, getByteFrequencyData: values => values.fill(40) }; }
  createMediaStreamSource(stream) { return { connect() {
    if (stream.getTracks()[0].failConnect) throw new Error('Source graph connection failed');
  }, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: source('mixed') }; }
  addEventListener() {}
  removeEventListener() {}
  resume() { return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
class Recorder {
  static isTypeSupported() { return true; }
  constructor(stream) { this.stream = stream; this.state = 'inactive'; this.kind = stream.getAudioTracks()[0].name; recorders.push(this); }
  start(slice) {
    if (this.kind === 'mixed' && mixedStartError) throw new Error(mixedStartError);
    this.state = 'recording'; this.slice = slice; events.push(['start', this.kind]); this.onstart?.();
  }
  data(value = 99) { this.ondataavailable?.({ target: this, data: blob(value) }); }
  stop() {
    this.state = 'inactive';
    if (!this.delayStop) queueMicrotask(() => { this.data(); this.onstop?.(); });
  }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  requestData() { this.data(77); }
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  recorders = []; events = []; mixedStartError = null;
  mic = source('microphone'); system = source('system');
  bridge = Object.fromEntries(['beginSource', 'markSourceStarted', 'saveSourceChunk', 'endSource', 'setUnsavedAudio', 'setInProgress', 'setProcessing', 'saveMetadata']
    .map(method => [method, vi.fn(async (...args) => { events.push([method, ...args]); return { success: true }; })]));
  window.electronAPI = { recording: bridge, systemAudio: {
    stop: vi.fn(async () => ({ success: true })), setPaused: vi.fn(async () => ({ success: true })),
  } };
  vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('MediaStream', Stream);
  window.AudioContext = window.webkitAudioContext = Context;
  navigator.mediaDevices = { getUserMedia: vi.fn(async () => mic), addEventListener() {}, removeEventListener() {}, enumerateDevices: async () => [] };
  store = {
    recordId: 'e9379c79-f245-4b9e-adcd-a51938387c2c', isRecording: false, isPaused: false, recordingInterrupted: false,
    chunkSaveErrors: 0, chunkIndex: 0, chunkSaveErrorWarning: false,
    startRecording: vi.fn(async () => ({ success: true })),
    confirmCaptureStarted: vi.fn(() => { store.isRecording = true; }),
    pauseRecording: vi.fn(() => { store.isRecording = false; store.isPaused = true; }),
    resumeRecording: vi.fn(() => { store.isRecording = true; store.isPaused = false; }),
    stopRecording: vi.fn(async () => { store.isRecording = false; return { success: true, filePath: 'audio.webm' }; }),
    saveChunk: vi.fn(async () => ({ success: true })), updateDuration: vi.fn(),
    setError: vi.fn(message => { store.error = message; store.isRecording = false; }), reset: vi.fn(), handleRecordingDeath: vi.fn(),
  };
  service = await import('../../src/services/recordingService');
});

afterEach(async () => {
  await service.cancelRecording(store);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  window.electronAPI = previousApi;
});

const start = (options = {}) => service.startRecording({ recordingStore: store, authStore: null,
  systemAudioEnabled: false, isAutoSplitting: { value: false }, ...options });
const nativeMic = () => recorders.find(recorder => recorder.kind === 'microphone');

describe('desktop native source lifecycle integration', () => {
  it('marks native mode before capture and uses one precise timeline before mixing', async () => {
    const reserved = deferred(), marked = deferred();
    bridge.beginSource.mockImplementationOnce(() => reserved.promise);
    bridge.markSourceStarted.mockImplementationOnce(() => marked.promise);
    const captureSystemAudio = vi.fn(async () => system);
    const starting = start({ systemAudioEnabled: true, captureSystemAudio });
    await tick();
    expect(store.startRecording).toHaveBeenCalledWith(null, { deferCaptureStart: true, captureMode: 'native-sources-v1' });
    expect(recorders).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    reserved.resolve({ success: true });
    await tick();
    expect(events.filter(event => event[0] === 'start').map(event => event[1])).toEqual(['microphone']);
    expect(bridge.markSourceStarted.mock.calls[0][2].startOffsetMs).toBe(0);
    await vi.advanceTimersByTimeAsync(17);
    marked.resolve({ success: true });
    expect(await starting).toMatchObject({ success: true });
    expect(captureSystemAudio).toHaveBeenCalledWith(store.recordId, 17);
    expect(events.filter(event => event[0] === 'start').map(event => event[1])).toEqual(['microphone', 'system', 'mixed']);
    expect(bridge.markSourceStarted.mock.calls[1][2].startOffsetMs).toBe(17);
    expect(service.getActiveRecordingOffsetMs()).toBe(17);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('withholds combine and shared-track teardown until the native final write completes', async () => {
    await start();
    const finalWrite = deferred();
    bridge.saveSourceChunk.mockImplementationOnce(() => finalWrite.promise);
    const stopped = service.stopRecording(store);
    await tick();
    expect(nativeMic().state).toBe('inactive');
    expect(store.stopRecording).not.toHaveBeenCalled();
    expect(mic.getTracks()[0].stop).not.toHaveBeenCalled();
    finalWrite.resolve({ success: true });
    expect(await stopped).toMatchObject({ success: true });
    expect(bridge.endSource).toHaveBeenCalledWith(store.recordId, expect.any(String), expect.objectContaining({ chunkCount: 1 }));
    expect(mic.getTracks()[0].stop).toHaveBeenCalled();
    expect(store.stopRecording).toHaveBeenCalledTimes(1);
  });

  it('keeps native audio retryable when the mixed recorder never starts', async () => {
    mixedStartError = 'Mixed encoder failed to start';
    expect(await start()).toMatchObject({ success: false, partialRecovery: true, recordId: store.recordId });
    expect(store.reset).not.toHaveBeenCalled();
    expect(bridge.saveSourceChunk).toHaveBeenCalledTimes(1);
    expect(store.saveChunk).not.toHaveBeenCalled();
    expect(await service.stopRecording(store)).toMatchObject({ success: true });
    expect(store.stopRecording).toHaveBeenCalledTimes(1);
  });

  it('keeps startup rollback as the sole owner when a native start marker fails', async () => {
    bridge.markSourceStarted.mockResolvedValue({ success: false, error: 'Cannot save source start' });
    const emergency = vi.fn(() => service.stopRecording(store));
    service.addEventListener('chunkSaveFailure', emergency);
    expect(await start()).toMatchObject({ success: false, unsavedAudio: true, partialRecovery: true });
    expect(emergency).not.toHaveBeenCalled();
    expect(store.stopRecording).not.toHaveBeenCalled();
    expect(store.reset).not.toHaveBeenCalled();
    service.removeEventListener('chunkSaveFailure', emergency);
  });

  it('drains a started mixed recorder before releasing sources after a later startup failure', async () => {
    store.confirmCaptureStarted.mockImplementation(() => { throw new Error('Startup interrupted'); });
    const finalWrite = deferred(); store.saveChunk.mockImplementationOnce(() => finalWrite.promise);
    const starting = start();
    await tick();
    expect(mic.getTracks()[0].stop).not.toHaveBeenCalled();
    finalWrite.resolve({ success: true });
    expect(await starting).toMatchObject({ success: false, partialRecovery: true });
    expect(store.saveChunk).toHaveBeenCalledTimes(1);
    expect(mic.getTracks()[0].stop).toHaveBeenCalled();
    expect(await service.stopRecording(store)).toMatchObject({ success: true });
  });

  it('retains a failed native write, blocks combine/new capture, and retries the same recording', async () => {
    await start();
    bridge.saveSourceChunk.mockResolvedValue({ success: false, diskFull: true, code: 'ENOSPC', error: 'Native disk full' });
    nativeMic().data(12);
    await tick();
    const failed = await service.stopRecording(store);
    expect(failed).toMatchObject({ success: false, unsavedAudio: true, diskFull: true });
    expect(store.stopRecording).not.toHaveBeenCalled();
    expect((await start()).success).toBe(false);
    expect(bridge.setUnsavedAudio).toHaveBeenCalledWith(store.recordId);
    bridge.saveSourceChunk.mockResolvedValue({ success: true });
    expect(await service.stopRecording(store)).toMatchObject({ success: true });
    expect(store.stopRecording).toHaveBeenCalledTimes(1);
    expect(bridge.setUnsavedAudio).toHaveBeenLastCalledWith(null);
  });

  it('replaces the native source before releasing the previous shared microphone and preserves mute', async () => {
    await start();
    service.toggleMicMute();
    expect(nativeMic().stream.getAudioTracks()[0].enabled).toBe(false);
    const next = source('replacement');
    navigator.mediaDevices.getUserMedia.mockResolvedValue(next);
    const finalWrite = deferred();
    bridge.saveSourceChunk.mockImplementationOnce(() => finalWrite.promise);
    const switching = service.switchMicrophoneStream('replacement', { skipVerify: true });
    await tick();
    expect(recorders.find(recorder => recorder.kind === 'replacement').state).toBe('recording');
    expect(next.getTracks()[0].enabled).toBe(false);
    expect(mic.getTracks()[0].stop).not.toHaveBeenCalled();
    finalWrite.resolve({ success: true });
    expect(await switching).toMatchObject({ success: true });
    expect(mic.getTracks()[0].stop).toHaveBeenCalled();
    expect(next.getTracks()[0].stop).not.toHaveBeenCalled();
  });

  it('ends sources for pause, excludes paused time, and opens fresh epochs on resume', async () => {
    await start({ systemAudioEnabled: true, captureSystemAudio: async () => system });
    await vi.advanceTimersByTimeAsync(250);
    expect(await service.pauseRecording(store)).toEqual({ success: true });
    expect(bridge.endSource.mock.calls.every(call => call[2].endOffsetMs === 250)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.getActiveRecordingOffsetMs()).toBe(250);
    expect(await service.resumeRecording(store, { value: false })).toEqual({ success: true });
    expect(bridge.beginSource).toHaveBeenCalledTimes(4);
    expect(bridge.markSourceStarted.mock.calls.slice(2).every(call => call[2].startOffsetMs === 250)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(service.getActiveRecordingOffsetMs()).toBe(350);
    expect(recorders.filter(recorder => recorder.kind === 'mixed')).toHaveLength(1);
  });

  it.each(['microphone', 'system'])('keeps the previous native %s if the replacement graph cannot connect', async kind => {
    await start({ systemAudioEnabled: true, captureSystemAudio: async () => system });
    const next = source('broken-replacement');
    next.getTracks()[0].failConnect = true;
    navigator.mediaDevices.getUserMedia.mockResolvedValue(next);
    const result = kind === 'microphone'
      ? await service.switchMicrophoneStream('broken-replacement', { skipVerify: true })
      : await service.addSystemAudioStream(next);
    expect(kind === 'microphone' ? result.success : result).toBe(false);
    expect(bridge.beginSource).toHaveBeenCalledTimes(2);
    expect(recorders.find(recorder => recorder.kind === kind).state).toBe('recording');
    expect(service.getState().nativeSources.phase).toBe('open');
    expect(store.setError).not.toHaveBeenCalled();
    expect((kind === 'microphone' ? mic : system).getTracks()[0].stop).not.toHaveBeenCalled();
  });

  it('allows a system source removal to supersede a pending replacement without emergency stopping', async () => {
    await start({ systemAudioEnabled: true, captureSystemAudio: async () => system });
    const reserved = deferred(); bridge.beginSource.mockImplementationOnce(() => reserved.promise);
    const next = source('superseded-system');
    const replacing = service.addSystemAudioStream(next);
    await tick();
    const removing = service.removeSystemAudioStream();
    reserved.resolve({ success: true });
    expect(await replacing).toBe(false);
    expect(await removing).toBe(true);
    expect(service.getState().nativeSources.phase).toBe('open');
    expect(nativeMic().state).toBe('recording');
    expect(store.setError).not.toHaveBeenCalled();
    expect(recorders.find(recorder => recorder.kind === 'superseded-system')).toBeUndefined();
  });

  it('allows stop to supersede a pending pause without reporting a native capture failure', async () => {
    await start();
    const pausing = service.pauseRecording(store);
    const stopping = service.stopRecording(store);
    await pausing;
    expect(await stopping).toMatchObject({ success: true });
    expect(store.setError).not.toHaveBeenCalled();
    expect(service.getState().nativeSources.phase).toBe('closed');
  });

  it('does not revive the store after stop overtakes the system resume acknowledgement', async () => {
    await start();
    await service.pauseRecording(store);
    const resumed = deferred(); window.electronAPI.systemAudio.setPaused.mockImplementationOnce(() => resumed.promise);
    const resuming = service.resumeRecording(store, { value: false });
    await tick();
    expect(await service.stopRecording(store)).toMatchObject({ success: true });
    resumed.resolve({ success: true });
    expect(await resuming).toMatchObject({ success: false });
    expect(store.resumeRecording).not.toHaveBeenCalled();
    expect(service.getState().nativeSources.phase).toBe('closed');
  });

  it('retires an ended device without stopping the other source, then re-acquires independently', async () => {
    await start({ systemAudioEnabled: true, captureSystemAudio: async () => system });
    const recorder = nativeMic();
    mic.getTracks()[0].readyState = 'ended';
    recorder.state = 'inactive'; recorder.data(31); recorder.onstop();
    await tick();
    expect(service.getState().nativeSources.phase).toBe('open');
    expect(recorders.find(item => item.kind === 'system').state).toBe('recording');
    expect(bridge.saveMetadata).toHaveBeenCalledWith(store.recordId, expect.objectContaining({ captureWarnings: ['microphone-disconnected'] }));
    const next = source('replacement'); navigator.mediaDevices.getUserMedia.mockResolvedValue(next);
    expect(await service.switchMicrophoneStream('replacement', { skipVerify: true })).toMatchObject({ success: true });
    expect(recorders.find(item => item.kind === 'replacement').state).toBe('recording');
  });

  it('does not revive a pending native reservation after explicit cancellation', async () => {
    const reserved = deferred(); bridge.beginSource.mockImplementationOnce(() => reserved.promise);
    const starting = start(); await tick();
    const cancelling = service.cancelRecording(store);
    reserved.resolve({ success: true });
    await cancelling;
    expect(await starting).toMatchObject({ success: false, cancelled: true });
    expect(recorders).toHaveLength(0);
    expect(store.stopRecording).not.toHaveBeenCalled();
  });

  it('flushes every native source as well as the mixed comparison output', async () => {
    await start({ systemAudioEnabled: true, captureSystemAudio: async () => system });
    expect(await service.flushRecordingData()).toEqual({ flushed: true, timedOut: false });
    expect(bridge.saveSourceChunk).toHaveBeenCalledTimes(2);
    expect(store.saveChunk).toHaveBeenCalledTimes(1);
  });
});
