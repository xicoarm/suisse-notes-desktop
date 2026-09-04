import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installLoopbackFixture } = require('../e2e-harness/windows-loopback-qualification');
const API = 'http://127.0.0.1:3000';
let nativeGet, contexts, nextTrack;

function makeStream() {
  const track = { id: String(++nextTrack), kind: 'audio', enabled: true, readyState: 'live',
    getSettings: () => ({ sampleRate: 48000 }), stop() { this.readyState = 'ended'; } };
  return { getTracks: () => [track], getAudioTracks: () => [track], clone: makeStream };
}

beforeEach(() => {
  vi.useFakeTimers(); nextTrack = 0; contexts = [];
  nativeGet = vi.fn().mockResolvedValue(makeStream());
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: nativeGet } });
  vi.stubGlobal('MediaRecorder', class extends EventTarget { start() {} });
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

afterEach(() => {
  window.__windowsLoopbackQualification?.dispose();
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
    expect(contexts[0].source.offset.value).toBe(0);
    expect(contexts[0].source.connect).toHaveBeenCalledTimes(1);
    expect(contexts[0].source.connect).toHaveBeenCalledWith(contexts[0].streamDestination);
    expect(contexts[0].source.connect).not.toHaveBeenCalledWith(contexts[0].destination);
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
