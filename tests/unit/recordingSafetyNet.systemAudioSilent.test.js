/**
 * The main-process system-audio silence warning names the cause that fits the
 * platform. macOS: the meeting app plays on another device. Windows: the native
 * helper hears every output device, so silence means no app plays at all — the
 * old "use the default output device" advice would send the user hunting for a
 * setting that no longer matters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const notify = vi.hoisted(() => vi.fn());
vi.mock('quasar', () => ({ Notify: { create: notify } }));
vi.mock('../../src/boot/i18n', () => ({ i18n: { global: { t: (key, params) => `${key}|${params?.seconds ?? ''}` } } }));
vi.mock('../../src/services/recordingService', () => ({
  addEventListener: vi.fn(), setSystemAudioActive: vi.fn()
}));
vi.mock('../../src/stores/recording', () => ({ useRecordingStore: () => ({}) }));
vi.mock('../../src/stores/recordings-history', () => ({ useRecordingsHistoryStore: () => ({}) }));
vi.mock('../../src/utils/platform', () => ({ isElectron: () => true }));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: vi.fn() }));
vi.mock('../../src/composables/useSystemAudio', () => ({ stopSystemAudioRebindMonitor: vi.fn() }));

import { initRecordingSafetyNet } from '../../src/services/recordingSafetyNet';
import { setSystemAudioActive } from '../../src/services/recordingService';

describe('system-audio silence warning', () => {
  let onCaptureWarning;

  beforeEach(() => {
    window.electronAPI = {
      system: {
        onCaptureWarning: vi.fn(handler => { onCaptureWarning = handler; }),
        onRecordingRecovered: vi.fn(), onSuspend: vi.fn(), onResume: vi.fn()
      }
    };
    initRecordingSafetyNet();
    notify.mockClear();
    setSystemAudioActive.mockClear();
  });

  it('on Windows says no app is playing, not "check the default output device"', () => {
    onCaptureWarning({ kind: 'system-audio-silent', recordId: 'r', silentSeconds: 92, platform: 'win32' });
    expect(setSystemAudioActive).toHaveBeenCalledWith(false);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      message: 'captureWarningSystemAudioSilentWindows|92', timeout: 0, group: 'system-audio-silent'
    }));
  });

  it('keeps the macOS advice for AudioTee', () => {
    onCaptureWarning({ kind: 'system-audio-silent', recordId: 'r', silentSeconds: 95, platform: 'darwin' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'captureWarningSystemAudioSilent|95' }));
  });
});
