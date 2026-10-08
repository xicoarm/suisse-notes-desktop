/**
 * Microphone access denied: what to tell the user, and the way to fix it.
 *
 * Until 4.7.15 macOS and iOS showed an English "Microphone access denied."
 * with no way forward, Windows a long English sentence, and only Android had
 * an "Open settings" button. Now every platform gets translated, specific
 * guidance plus a settings button where the platform allows opening the
 * right page:
 *   macOS   - System Settings > Privacy & Security > Microphone (main process)
 *   Windows - ms-settings:privacy-microphone (main process)
 *   Android - the app's settings page (BackgroundRecording.openAppSettings)
 *   iOS     - the app's page in Settings (app-settings: URL, opened by
 *             Capacitor through UIApplication.open)
 */

import { isElectron, isIOS, isAndroid } from '../utils/platform';

/** 'mac' | 'windows' | 'ios' | 'android' | 'other' */
export function micPlatform({ electron = isElectron(), ios = isIOS(), android = isAndroid(), userAgent } = {}) {
  if (ios) return 'ios';
  if (android) return 'android';
  if (electron) {
    const ua = String(userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : ''));
    if (/Windows/i.test(ua)) return 'windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  }
  return 'other';
}

const GUIDANCE_KEYS = {
  mac: 'micDeniedMac',
  windows: 'micDeniedWindows',
  ios: 'micDeniedIOS',
  android: 'micDeniedAndroid',
  other: 'micPermissionDenied'
};

/** i18n key of the "microphone access denied" guidance for a platform. */
export const micDeniedKey = (platform) => GUIDANCE_KEYS[platform] || GUIDANCE_KEYS.other;

/** Whether an "Open settings" action can be offered on this platform. */
export const canOpenMicSettings = (platform) => ['mac', 'windows', 'ios', 'android'].includes(platform);

/**
 * Recorder start error code (services/recordingService.js) -> i18n key, or
 * null for errors without a dedicated text.
 */
export function micStartErrorKey(errorCode, platform) {
  switch (errorCode) {
    case 'mic_permission_denied': return micDeniedKey(platform);
    case 'mic_not_found': return 'noMicrophoneDetected';
    case 'mic_in_use': return 'micInUse';
    case 'mic_unsupported_settings': return 'micUnsupportedSettings';
    default: return null;
  }
}

/**
 * Open the page where the user can allow the microphone.
 * @returns {Promise<boolean>} whether a settings page was opened
 */
export async function openMicrophoneSettings(platform = micPlatform()) {
  try {
    if (platform === 'mac' || platform === 'windows') {
      const result = await window.electronAPI?.system?.openMicrophoneSettings?.();
      return !!result?.success;
    }
    if (platform === 'android') {
      const { registerPlugin } = await import('@capacitor/core');
      await registerPlugin('BackgroundRecording').openAppSettings();
      return true;
    }
    if (platform === 'ios') {
      // UIApplication.openSettingsURLString; Capacitor hands non-app URLs of a
      // top-level navigation to UIApplication.open.
      window.open('app-settings:', '_system');
      return true;
    }
  } catch { /* fall through: the guidance text still says where to go */ }
  return false;
}
