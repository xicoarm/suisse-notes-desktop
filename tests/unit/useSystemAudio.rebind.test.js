/**
 * Bluetooth profile-flip rebind monitor (Windows system audio).
 *
 * WASAPI loopback binds to the default output device once at capture start.
 * A Bluetooth headset switching A2DP <-> HFP (any app opening its mic does
 * this) suspends the bound endpoint and the capture silently records pure
 * silence. useSystemAudio must react to `devicechange` by re-acquiring the
 * loopback and hot-swapping the fresh stream into the live mix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toRaw } from 'vue';

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => true,
  isAndroid: () => false,
  isCapacitor: () => false
}));

vi.mock('../../src/services/recordingService', () => ({
  addSystemAudioStream: vi.fn()
}));

import { useSystemAudio } from '../../src/composables/useSystemAudio';
import { addSystemAudioStream } from '../../src/services/recordingService';

class FakeMediaStream {
  constructor(tracks = []) {
    this._tracks = Array.isArray(tracks) ? [...tracks] : [];
  }
  getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
  getTracks() { return this._tracks; }
}

function makeTrack(kind) {
  return {
    kind,
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
}

function makeLoopbackStream() {
  return new FakeMediaStream([makeTrack('audio'), makeTrack('video')]);
}

describe('useSystemAudio — Windows loopback rebind on devicechange', () => {
  let deviceChangeListeners;
  let mediaDevices;
  let sysAudio;

  const fireDeviceChange = () => {
    deviceChangeListeners.forEach(fn => fn());
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    global.MediaStream = FakeMediaStream;

    deviceChangeListeners = new Set();
    mediaDevices = {
      getUserMedia: vi.fn().mockImplementation(() => Promise.resolve(makeLoopbackStream())),
      addEventListener: vi.fn((ev, fn) => { if (ev === 'devicechange') deviceChangeListeners.add(fn); }),
      removeEventListener: vi.fn((ev, fn) => { deviceChangeListeners.delete(fn); })
    };
    Object.defineProperty(global.navigator, 'mediaDevices', {
      value: mediaDevices,
      configurable: true,
      writable: true
    });

    global.window.electronAPI = {
      systemAudio: {
        isSupported: vi.fn().mockResolvedValue({ supported: true, platform: 'win32' }),
        getEnabled: vi.fn().mockResolvedValue(true),
        setEnabled: vi.fn().mockResolvedValue(true),
        getSources: vi.fn().mockResolvedValue([{ id: 'screen:0:0', name: 'Entire Screen' }]),
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        diag: vi.fn()
      }
    };

    addSystemAudioStream.mockReset();
    addSystemAudioStream.mockReturnValue(true);

    sysAudio = useSystemAudio();
    await sysAudio.loadState();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete global.window.electronAPI;
    delete global.MediaStream;
  });

  async function startCapture() {
    const stream = await sysAudio.startCapture('rec-1');
    expect(stream).toBeTruthy();
    return stream;
  }

  it('rebinds the loopback and swaps the new stream into the mix on devicechange', async () => {
    const initial = await startCapture();
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(mediaDevices.addEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));

    fireDeviceChange();
    await vi.advanceTimersByTimeAsync(1500);

    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(addSystemAudioStream).toHaveBeenCalledTimes(1);
    const swapped = addSystemAudioStream.mock.calls[0][0];
    expect(swapped).not.toBe(initial);
    // toRaw: the fake stream is a plain class instance so Vue deep-proxies it
    // in the ref; real MediaStream instances are not proxied (invalid reactive
    // target), so production hands out the raw stream.
    expect(toRaw(sysAudio.systemAudioStream.value)).toBe(swapped);
  });

  it('coalesces a burst of devicechange events into a single rebind', async () => {
    await startCapture();

    fireDeviceChange();
    await vi.advanceTimersByTimeAsync(500);
    fireDeviceChange();
    await vi.advanceTimersByTimeAsync(500);
    fireDeviceChange();
    await vi.advanceTimersByTimeAsync(1500);

    // 1 initial + exactly 1 rebind despite 3 events
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(addSystemAudioStream).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous stream when re-acquisition fails', async () => {
    const initial = await startCapture();

    // Both the combined and the audio-only retry fail
    mediaDevices.getUserMedia.mockRejectedValue(
      Object.assign(new Error('device busy'), { name: 'NotReadableError' })
    );

    fireDeviceChange();
    await vi.advanceTimersByTimeAsync(1500);

    expect(addSystemAudioStream).not.toHaveBeenCalled();
    expect(sysAudio.systemAudioStream.value).toBe(initial);
    initial.getAudioTracks().forEach(t => expect(t.stop).not.toHaveBeenCalled());
  });

  it('stops the stale stream itself when no recording mix is active', async () => {
    const initial = await startCapture();
    addSystemAudioStream.mockReturnValue(false); // no active mixing pipeline

    fireDeviceChange();
    await vi.advanceTimersByTimeAsync(1500);

    // New binding carried forward, old one released manually
    expect(sysAudio.systemAudioStream.value).not.toBe(initial);
    initial.getAudioTracks().forEach(t => expect(t.stop).toHaveBeenCalled());
  });

  it('ignores devicechange after stopCapture', async () => {
    await startCapture();
    await sysAudio.stopCapture();

    expect(deviceChangeListeners.size).toBe(0);

    fireDeviceChange();
    await vi.advanceTimersByTimeAsync(1500);

    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(addSystemAudioStream).not.toHaveBeenCalled();
  });

  it('disposes a late loopback stream after stop while permission acquisition was pending', async () => {
    let resolve; mediaDevices.getUserMedia.mockReturnValue(new Promise(r => { resolve = r; }));
    const starting = sysAudio.startCapture('rec-1');
    await vi.advanceTimersByTimeAsync(0);
    await sysAudio.stopCapture();
    const late = makeLoopbackStream(); resolve(late);
    expect(await starting).toBeNull();
    late.getAudioTracks().forEach(track => expect(track.stop).toHaveBeenCalled());
  });

  it('ignores an old rebind that completes after another instance owns capture', async () => {
    await startCapture();
    let resolve; mediaDevices.getUserMedia.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    fireDeviceChange(); await vi.advanceTimersByTimeAsync(1500);
    const replacement = useSystemAudio(); await replacement.loadState(); await replacement.startCapture('rec-2');
    const late = makeLoopbackStream(); resolve(late); await vi.advanceTimersByTimeAsync(0);
    expect(addSystemAudioStream).not.toHaveBeenCalled();
    late.getAudioTracks().forEach(track => expect(track.stop).toHaveBeenCalled());
    await replacement.stopCapture();
  });

  it('does not rebind while capture was never started', async () => {
    fireDeviceChange();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
});
