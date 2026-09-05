import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installLoopbackFixture } = require('../e2e-harness/windows-loopback-qualification');
const API = 'http://127.0.0.1:3000';
let nativeGet, contexts, nextTrack, generators, audioFrames, writeFrame;

function makeStream() {
  const track = { id: String(++nextTrack), kind: 'audio', enabled: true, readyState: 'live',
    getSettings: () => ({ sampleRate: 48000 }), stop() { this.readyState = 'ended'; } };
  return { getTracks: () => [track], getAudioTracks: () => [track], clone: makeStream };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.stubGlobal('performance', { now: () => Date.now() });
  nextTrack = 0; contexts = []; generators = []; audioFrames = [];
  writeFrame = () => Promise.resolve();
  nativeGet = vi.fn().mockResolvedValue(makeStream());
  vi.stubGlobal('navigator', { userAgent: 'fixture-test-runtime', mediaDevices: { getUserMedia: nativeGet } });
  vi.stubGlobal('MediaRecorder', class extends EventTarget { start() {} });
  vi.stubGlobal('MediaStreamTrackGenerator', class {
    constructor({ kind }) {
      this.id = String(++nextTrack); this.kind = kind; this.enabled = true; this.readyState = 'live';
      this.writer = { write: vi.fn(frame => writeFrame(frame)), abort: vi.fn().mockResolvedValue(), releaseLock: vi.fn() };
      this.writable = { getWriter: () => this.writer };
      this.stop = vi.fn(() => { this.readyState = 'ended'; });
      generators.push(this);
    }
  });
  vi.stubGlobal('AudioData', class {
    constructor(options) { Object.assign(this, options); this.close = vi.fn(); audioFrames.push(this); }
  });
  vi.stubGlobal('MediaStream', class {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  });
  vi.stubGlobal('AudioContext', class {
    constructor() { this.destination = {}; this.state = 'running'; contexts.push(this); }
    createMediaStreamDestination() { this.streamDestination = { stream: makeStream() }; return this.streamDestination; }
    createConstantSource() {
      this.source = { offset: { value: 1 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      return this.source;
    }
    resume() { return Promise.resolve(); }
    createBuffer(channels, frames, rate) {
      this.buffer = { channels, frames, rate, duration: frames / rate, channel: new Float32Array(frames),
        getChannelData() { return this.channel; } };
      return this.buffer;
    }
    decodeAudioData() { throw new Error('Async WAV decoder must never run in the PCM fixture variant'); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  });
  window.electronAPI = { config: { getApiUrl: vi.fn().mockResolvedValue(API) }, systemAudio: { diag: vi.fn().mockResolvedValue() } };
});

afterEach(async () => {
  const disposed = window.__windowsLoopbackQualification?.dispose();
  await vi.advanceTimersByTimeAsync(1001);
  await disposed;
  delete window.__windowsLoopbackQualification; delete window.electronAPI;
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('private Windows loopback fixture boundaries', () => {
  it('never opens a hardware microphone and returns separate disabled zero tracks', async () => {
    installLoopbackFixture({ apiUrl: API });
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks()[0].stop();
    const recording = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: 'default' } });
    expect(nativeGet).not.toHaveBeenCalled();
    expect(recording.getTracks()[0]).toMatchObject({ enabled: false, readyState: 'live' });
    expect(recording.getTracks()[0]).not.toBe(probe.getTracks()[0]);
    expect(contexts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(generators[0].writer.write).toHaveBeenCalledTimes(1);
    expect(generators[0].writer.abort).toHaveBeenCalledOnce();
    expect(generators[1].writer.write).toHaveBeenCalledTimes(4);
    expect(window.__windowsLoopbackQualification.snapshot().generatorFeatures).toEqual({
      generator: 'function', audioData: 'function', userAgent: 'fixture-test-runtime', mechanism: 'timestamped-zero-generator-v1',
    });
  });

  it('paces zero mono samples with an explicit contiguous sample clock', async () => {
    installLoopbackFixture({ apiUrl: API });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    await vi.advanceTimersByTimeAsync(35);
    expect(audioFrames.map(frame => frame.timestamp)).toEqual([1000000, 1010000, 1020000, 1030000]);
    for (const frame of audioFrames) {
      expect(frame).toMatchObject({ format: 'f32', sampleRate: 48000, numberOfFrames: 480, numberOfChannels: 1 });
      expect(frame.data).toHaveLength(480);
      expect(frame.data.every(value => value === 0)).toBe(true);
      expect(frame.close).toHaveBeenCalledOnce();
    }
    expect(window.__windowsLoopbackQualification.snapshot().generators[0]).toMatchObject({
      framesWritten: 4, sampleClockSeconds: 0.04, maxLatenessMs: 0, enabled: false, active: true, failure: null,
    });
    expect(contexts).toHaveLength(0);
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it.each(['MediaStreamTrackGenerator', 'AudioData'])('fails without hardware fallback when %s is unavailable', async feature => {
    vi.stubGlobal(feature, undefined);
    installLoopbackFixture({ apiUrl: API });
    await expect(navigator.mediaDevices.getUserMedia({ audio: true })).rejects.toThrow('hardware fallback is forbidden');
    expect(nativeGet).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(0);
    expect(generators).toHaveLength(0);
  });

  it('stops and releases a generator if stream construction fails', async () => {
    vi.stubGlobal('MediaStream', class { constructor() { throw new Error('Cannot wrap generated track'); } });
    installLoopbackFixture({ apiUrl: API });
    await expect(navigator.mediaDevices.getUserMedia({ audio: true })).rejects.toThrow('Cannot wrap generated track');
    expect(generators[0].readyState).toBe('ended');
    expect(generators[0].writer.abort).toHaveBeenCalledOnce();
    expect(generators[0].writer.releaseLock).toHaveBeenCalledOnce();
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it('disposes a sleeping producer once and cannot write after disposal', async () => {
    installLoopbackFixture({ apiUrl: API });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    await vi.advanceTimersByTimeAsync(25);
    const fixture = window.__windowsLoopbackQualification;
    const disposed = fixture.dispose();
    expect(fixture.dispose()).toBe(disposed);
    await disposed;
    await vi.advanceTimersByTimeAsync(5000);
    expect(generators[0].writer.write).toHaveBeenCalledTimes(3);
    expect(generators[0].writer.abort).toHaveBeenCalledOnce();
    expect(generators[0].writer.releaseLock).toHaveBeenCalledOnce();
    expect(fixture.snapshot().generators[0]).toMatchObject({ active: false, readyState: 'ended', stoppedAt: 25, failure: null });
    expect(navigator.mediaDevices.getUserMedia).toBe(nativeGet);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resume production when a pending write resolves after disposal', async () => {
    let resolveWrite;
    writeFrame = () => new Promise(resolve => { resolveWrite = resolve; });
    installLoopbackFixture({ apiUrl: API });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const fixture = window.__windowsLoopbackQualification;
    const disposed = fixture.dispose();
    resolveWrite(); await disposed;
    await vi.advanceTimersByTimeAsync(5000);
    expect(generators[0].writer.write).toHaveBeenCalledOnce();
    expect(audioFrames[0].close).toHaveBeenCalledOnce();
    expect(generators[0].writer.releaseLock).toHaveBeenCalledOnce();
    expect(fixture.snapshot().errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records writer rejection, releases the frame and stops the producer', async () => {
    writeFrame = () => Promise.reject(new Error('Synthetic writer failed'));
    installLoopbackFixture({ apiUrl: API });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(window.__windowsLoopbackQualification.snapshot()).toMatchObject({
      errors: ['Timestamped zero input: Synthetic writer failed'],
      generators: [{ active: false, failure: 'Synthetic writer failed', framesWritten: 0, readyState: 'ended' }],
    });
    expect(audioFrames[0].close).toHaveBeenCalledOnce();
    expect(generators[0].writer.releaseLock).toHaveBeenCalledOnce();
  });

  it('fails a stalled write at its deadline and bounds disposal even when abort also hangs', async () => {
    writeFrame = () => new Promise(() => {});
    installLoopbackFixture({ apiUrl: API });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    generators[0].writer.abort.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(999);
    expect(window.__windowsLoopbackQualification.snapshot().errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await window.__windowsLoopbackQualification.dispose();
    expect(window.__windowsLoopbackQualification.snapshot().errors).toEqual(['Timestamped zero input: Silent generator write exceeded 1000ms']);
    expect(generators[0].readyState).toBe('ended');
    expect(generators[0].writer.write).toHaveBeenCalledOnce();
    expect(audioFrames[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects excessive scheduler lateness instead of emitting an unbounded catch-up burst', async () => {
    installLoopbackFixture({ apiUrl: API });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(1000);
    await vi.advanceTimersByTimeAsync(10);
    expect(generators[0].writer.write).toHaveBeenCalledOnce();
    expect(window.__windowsLoopbackQualification.snapshot().generators[0]).toMatchObject({
      failure: 'Silent generator pacing exceeded 250ms', maxLatenessMs: 1000, active: false, readyState: 'ended',
    });
  });

  it('stops at its explicit 120-second source budget without relying on external disposal', async () => {
    installLoopbackFixture({ apiUrl: API });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    await vi.advanceTimersByTimeAsync(120000);
    expect(window.__windowsLoopbackQualification.snapshot().generators[0]).toMatchObject({
      framesWritten: 12000, sampleClockSeconds: 120, failure: 'Silent generator exceeded its 120-second sample budget', active: false,
    });
    expect(generators[0].writer.write).toHaveBeenCalledTimes(12000);
    expect(generators[0].writer.abort).toHaveBeenCalledOnce();
  });

  it('passes native desktop loopback constraints through without replacement', async () => {
    installLoopbackFixture({ apiUrl: API });
    const constraints = { audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0' } },
      video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 1 } } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    expect(nativeGet).toHaveBeenCalledTimes(1);
    expect(nativeGet).toHaveBeenCalledWith(constraints);
    expect(stream).toBe(await nativeGet.mock.results[0].value);
    expect(contexts).toHaveLength(0);
    expect(window.__windowsLoopbackQualification.snapshot().desktopCalls[0].tracks[0].kind).toBe('audio');
  });

  it('rejects unexpected camera requests without acquiring any native device', async () => {
    installLoopbackFixture({ apiUrl: API });
    await expect(navigator.mediaDevices.getUserMedia({ audio: true, video: true })).rejects.toThrow('Unexpected non-microphone');
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it('refuses playout before a verified recording and app mute', async () => {
    installLoopbackFixture({ apiUrl: API });
    await expect(window.__windowsLoopbackQualification.play('')).rejects.toThrow('Playout requires verified muted');
    expect(contexts).toHaveLength(0);
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it('fails closed on a backend mismatch even for native desktop requests', async () => {
    window.electronAPI.config.getApiUrl.mockResolvedValue('https://app.suisse-notes.ch');
    installLoopbackFixture({ apiUrl: API });
    await expect(navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } } })).rejects.toThrow('backend mismatch');
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it('prepares the exact signed PCM samples without using the crashing async decoder', async () => {
    const bytes = Buffer.alloc(44 + 48 * 48000 * 2);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    bytes.writeInt16LE(-32768, 44); bytes.writeInt16LE(0, 46); bytes.writeInt16LE(32767, 48);
    installLoopbackFixture({ apiUrl: API });
    const prepared = await window.__windowsLoopbackQualification.prepare(bytes.toString('base64'));
    expect(prepared).toMatchObject({ method: 'pcm-createBuffer-v1', duration: 48 });
    expect(Array.from(contexts[0].buffer.channel.slice(0, 3))).toEqual([-1, 0, 32767 / 32768]);
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it('rejects a truncated or unsupported PCM fixture before allocating an output buffer', async () => {
    installLoopbackFixture({ apiUrl: API });
    await expect(window.__windowsLoopbackQualification.prepare(Buffer.alloc(44).toString('base64'))).rejects.toThrow('RIFF PCM16 mono 48000Hz');
    expect(contexts[0].buffer).toBeUndefined();
    expect(nativeGet).not.toHaveBeenCalled();
  });
});
