import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  micPlatform, micDeniedKey, micStartErrorKey, canOpenMicSettings, openMicrophoneSettings
} from '../../src/services/permissionSettings';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Electron/30.0.0';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Electron/30.0.0';

describe('microphone access denied: guidance per platform', () => {
  afterEach(() => { delete window.electronAPI; vi.restoreAllMocks(); });

  it('detects the platform', () => {
    expect(micPlatform({ electron: true, ios: false, android: false, userAgent: MAC_UA })).toBe('mac');
    expect(micPlatform({ electron: true, ios: false, android: false, userAgent: WIN_UA })).toBe('windows');
    expect(micPlatform({ electron: false, ios: true, android: false })).toBe('ios');
    expect(micPlatform({ electron: false, ios: false, android: true })).toBe('android');
    expect(micPlatform({ electron: false, ios: false, android: false, userAgent: MAC_UA })).toBe('other');
  });

  it('maps recorder error codes to translated texts', () => {
    expect(micStartErrorKey('mic_permission_denied', 'mac')).toBe('micDeniedMac');
    expect(micStartErrorKey('mic_permission_denied', 'windows')).toBe('micDeniedWindows');
    expect(micStartErrorKey('mic_permission_denied', 'ios')).toBe('micDeniedIOS');
    expect(micStartErrorKey('mic_permission_denied', 'android')).toBe('micDeniedAndroid');
    expect(micStartErrorKey('mic_permission_denied', 'other')).toBe('micPermissionDenied');
    expect(micStartErrorKey('mic_in_use', 'mac')).toBe('micInUse');
    expect(micStartErrorKey('mic_not_found', 'mac')).toBe('noMicrophoneDetected');
    expect(micStartErrorKey('mic_unsupported_settings', 'mac')).toBe('micUnsupportedSettings');
    expect(micStartErrorKey(undefined, 'mac')).toBeNull();
    expect(canOpenMicSettings('mac') && canOpenMicSettings('windows') && canOpenMicSettings('ios') && canOpenMicSettings('android')).toBe(true);
    expect(canOpenMicSettings('other')).toBe(false);
  });

  it.each(SUPPORTED_LOCALES)('every guidance text exists in %s', (locale) => {
    const messages = i18n.global.getLocaleMessage(locale);
    for (const platform of ['mac', 'windows', 'ios', 'android', 'other']) {
      expect(typeof messages[micDeniedKey(platform)]).toBe('string');
    }
    for (const key of ['micInUse', 'micUnsupportedSettings', 'noMicrophoneDetected']) expect(typeof messages[key]).toBe('string');
  });

  it('opens the OS settings through the main process on desktop', async () => {
    const openMicrophoneSettingsIpc = vi.fn(async () => ({ success: true }));
    window.electronAPI = { system: { openMicrophoneSettings: openMicrophoneSettingsIpc } };
    await expect(openMicrophoneSettings('mac')).resolves.toBe(true);
    await expect(openMicrophoneSettings('windows')).resolves.toBe(true);
    expect(openMicrophoneSettingsIpc).toHaveBeenCalledTimes(2);
  });

  it('opens the app page in iOS Settings', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await expect(openMicrophoneSettings('ios')).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith('app-settings:', '_system');
  });

  it('reports false when nothing could be opened', async () => {
    await expect(openMicrophoneSettings('other')).resolves.toBe(false);
    await expect(openMicrophoneSettings('mac')).resolves.toBe(false); // no electronAPI
  });
});
