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
    close() { this.state = 'closed'; return Promise.resolve(); }
  });
  window.electronAPI = { config: { getApiUrl: vi.fn().mockResolvedValue(API) } };
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
});
