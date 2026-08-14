/**
 * Windows default-vs-communication output endpoint detection.
 *
 * Windows keeps two independent default output endpoints. Chromium's WASAPI
 * loopback binds to the default MULTIMEDIA endpoint; Teams/Zoom/Meet render call
 * audio to the default COMMUNICATION endpoint. When they differ, system-audio
 * capture yields a live track and 100% digital silence for the whole meeting —
 * the failure mode behind the 2026-08-14 68-minute mic-only recording.
 *
 * useSystemAudio must detect the split from the "default"/"communications"
 * pseudo devices so the user can be told which device to change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => true,
  isAndroid: () => false,
  isCapacitor: () => false
}));

vi.mock('../../src/services/recordingService', () => ({
  addSystemAudioStream: vi.fn()
}));

import { useSystemAudio } from '../../src/composables/useSystemAudio';

function setDevices(devices) {
  Object.defineProperty(global.navigator, 'mediaDevices', {
    value: { enumerateDevices: vi.fn().mockResolvedValue(devices) },
    configurable: true,
    writable: true
  });
}

const out = (deviceId, label) => ({ kind: 'audiooutput', deviceId, label });

describe('useSystemAudio — Windows output-endpoint routing check', () => {
  beforeEach(() => {
    global.window.electronAPI = {
      systemAudio: {
        isSupported: vi.fn().mockResolvedValue({ supported: true, platform: 'win32' }),
        diag: vi.fn()
      }
    };
  });

  it('reports the mismatch and names both devices', async () => {
    setDevices([
      out('default', 'Default - Lautsprecher (Cirrus Logic XU)'),
      out('communications', 'Communications - Kopfhörer (Jabra Evolve2 65)'),
      out('abc123', 'Kopfhörer (Jabra Evolve2 65)')
    ]);

    const sys = useSystemAudio();
    const result = await sys.checkOutputRouting();

    expect(result).toEqual({
      defaultLabel: 'Lautsprecher (Cirrus Logic XU)',
      commsLabel: 'Kopfhörer (Jabra Evolve2 65)'
    });
    expect(sys.outputRoutingMismatch.value).toEqual(result);
  });

  it('stays silent when both roles point at the same device', async () => {
    setDevices([
      out('default', 'Default - Kopfhörer (Jabra Evolve2 65)'),
      out('communications', 'Communications - Kopfhörer (Jabra Evolve2 65)')
    ]);

    const sys = useSystemAudio();
    expect(await sys.checkOutputRouting()).toBeNull();
    expect(sys.outputRoutingMismatch.value).toBeNull();
  });

  it('does not guess when device labels are not yet unlocked', async () => {
    setDevices([out('default', ''), out('communications', '')]);

    const sys = useSystemAudio();
    expect(await sys.checkOutputRouting()).toBeNull();
    expect(sys.outputRoutingMismatch.value).toBeNull();
  });

  it('does not run on macOS — AudioTee taps the process graph, not an endpoint', async () => {
    global.window.electronAPI.systemAudio.isSupported =
      vi.fn().mockResolvedValue({ supported: true, platform: 'darwin' });
    setDevices([
      out('default', 'Default - MacBook Pro Speakers'),
      out('communications', 'Communications - Jabra Evolve2 65')
    ]);

    const sys = useSystemAudio();
    expect(await sys.checkOutputRouting()).toBeNull();
    expect(sys.outputRoutingMismatch.value).toBeNull();
  });

  it('handles the German role prefixes Windows uses on a localized system', async () => {
    setDevices([
      out('default', 'Standard - Lautsprecher (Cirrus Logic XU)'),
      out('communications', 'Kommunikation - Kopfhörer (Jabra Evolve2 65)')
    ]);

    const sys = useSystemAudio();
    const result = await sys.checkOutputRouting();

    expect(result.defaultLabel).toBe('Lautsprecher (Cirrus Logic XU)');
    expect(result.commsLabel).toBe('Kopfhörer (Jabra Evolve2 65)');
  });
});
