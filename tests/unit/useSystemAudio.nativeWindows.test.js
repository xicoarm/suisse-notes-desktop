/**
 * Windows system audio through the native helper (resources/sysloopback).
 *
 * desktopCapturer only hears the default output device; the meeting played on
 * the headset (the default communication device) was recorded as silence
 * (2026-08-14, 2026-10-03). With the helper, Windows records like macOS: in
 * main, every app except ours, on every output device — and the routing
 * warning no longer applies. desktopCapturer stays only for an app without
 * the helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => true,
  isAndroid: () => false,
  isCapacitor: () => false
}));

vi.mock('../../src/services/recordingService', () => ({
  addSystemAudioStream: vi.fn(), isNativeSourceRetained: () => false
}));

import { useSystemAudio } from '../../src/composables/useSystemAudio';

class FakeMediaStream {
  constructor(tracks = []) { this._tracks = [...tracks]; }
  getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
  getTracks() { return this._tracks; }
}
const track = kind => ({ kind, stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });

describe('useSystemAudio — Windows with the native helper', () => {
  let api;
  let mediaDevices;

  beforeEach(() => {
    global.MediaStream = FakeMediaStream;
    mediaDevices = {
      getUserMedia: vi.fn(async () => new FakeMediaStream([track('audio'), track('video')])),
      enumerateDevices: vi.fn(async () => [
        { kind: 'audiooutput', deviceId: 'default', label: 'Default - Lautsprecher (Cirrus Logic)' },
        { kind: 'audiooutput', deviceId: 'communications', label: 'Communications - Kopfhörer (Jabra Evolve2 65)' },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    Object.defineProperty(global.navigator, 'mediaDevices', { value: mediaDevices, configurable: true, writable: true });
    api = {
      isSupported: vi.fn().mockResolvedValue({ supported: true, platform: 'win32', nativeCapture: true }),
      getEnabled: vi.fn().mockResolvedValue(true),
      setEnabled: vi.fn().mockResolvedValue(true),
      getSources: vi.fn().mockResolvedValue([{ id: 'screen:0:0', name: 'Entire Screen' }]),
      start: vi.fn().mockResolvedValue({ success: true, filePath: 'system_audio.raw' }),
      stop: vi.fn().mockResolvedValue({ success: true }),
      diag: vi.fn()
    };
    global.window.electronAPI = { systemAudio: api };
  });

  afterEach(() => {
    delete global.window.electronAPI;
    delete global.MediaStream;
  });

  it('records in main through the helper, at the recording offset, without desktopCapturer', async () => {
    const sys = useSystemAudio();
    await sys.loadState();
    await expect(sys.startCapture('rec-1', 17)).resolves.toBe(true);
    expect(api.start).toHaveBeenCalledWith('rec-1', 17);
    expect(api.getSources).not.toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('shows no output-device warning: the helper hears every output device', async () => {
    const sys = useSystemAudio();
    await sys.loadState();
    expect(await sys.checkOutputRouting()).toBeNull();
    expect(sys.outputRoutingMismatch.value).toBeNull();
    expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
  });

  // main reserved the PCM attempt as required evidence before spawning; a
  // desktopCapturer lane next to it would make finalization refuse "system
  // audio twice". The failure is reported instead, as on macOS.
  it('reports a helper that cannot start instead of adding a second system lane', async () => {
    api.start.mockResolvedValue({ success: false, error: 'System audio helper not found' });
    const sys = useSystemAudio();
    await sys.loadState();
    await expect(sys.startCapture('rec-1', 0)).resolves.toBeNull();
    expect(sys.error.value).toBe('System audio helper not found');
    expect(api.getSources).not.toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('keeps the desktopCapturer path and its routing warning when there is no helper', async () => {
    api.isSupported.mockResolvedValue({ supported: true, platform: 'win32', nativeCapture: false });
    const sys = useSystemAudio();
    await sys.loadState();
    expect(sys.outputRoutingMismatch.value).toEqual({
      defaultLabel: 'Lautsprecher (Cirrus Logic)', commsLabel: 'Kopfhörer (Jabra Evolve2 65)'
    });
    const stream = await sys.startCapture('rec-1', 0);
    expect(stream).toBeInstanceOf(FakeMediaStream);
    expect(api.start).not.toHaveBeenCalled();
    await sys.stopCapture();
  });
});
