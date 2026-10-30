/**
 * Secure storage service for authentication tokens and other secrets.
 *
 * - Desktop (Electron): main process, OS keystore via safeStorage
 *   (src-electron/token-vault.js); never plaintext on disk.
 * - iOS: Keychain, Android: Android Keystore (AES-256-GCM), both through the
 *   in-app native plugin "SecureTokenStore"
 *   (src-capacitor/ios/App/App/Plugins/SecureTokenStorePlugin.swift,
 *   src-capacitor/android/.../SecureTokenStorePlugin.kt).
 *
 * Rules (security review 10/2026, "option C"):
 * - T1 Values are read only from the keystore (or the auth store's memory).
 *   Capacitor Preferences (UserDefaults / SharedPreferences: plaintext, part
 *   of the iOS backup) is never a source - older versions kept the session
 *   there; such a value is never adopted.
 * - T2 Every start deletes the five auth keys from Preferences
 *   (purgeLegacyAuthPreferences); done only when get() confirms they are
 *   gone, otherwise again at the next start. The user signs in once after
 *   the update. Pairing keys (bleAppKeys.js) are not touched here.
 * - T3 Nothing is ever written in plaintext. Without a keystore the session
 *   lives in memory for this run only.
 * - T4 A failed save leaves the previous value in place (the native write is
 *   atomic; a read-back mismatch puts the previous value back).
 * - T5 Sign-in, sign-out and the start are decided by the session authority
 *   (sessionAuthority.js; desktop: src-electron/session-authority.js). Only
 *   it writes or deletes the auth keys; while it says signed out, getToken
 *   is null. The previous version's marker "auth.signedOut" counts as signed
 *   out there.
 */

import { isElectron, isCapacitor, isIOS, isAndroid } from '../utils/platform';
import { isSignedOut } from './sessionAuthority';

// Storage keys
export const STORAGE_KEYS = {
  AUTH_TOKEN: 'authToken',
  REFRESH_TOKEN: 'refreshToken',
  USER_ID: 'userId',
  USER_EMAIL: 'userEmail',
  USER_INFO: 'userInfo'
};

/** The five auth keys (keystore entries and legacy Preferences copies). */
export const AUTH_KEYS = Object.freeze(Object.values(STORAGE_KEYS));

/** Sign-out marker of the previous version (localStorage): "1" = signed out. */
export const LEGACY_SIGNED_OUT_MARKER = 'auth.signedOut';

let keystore = null;
let Preferences = null;

// Returns a holder, never the plugin itself: a Capacitor plugin proxy answers
// every property, including `then`, so resolving a promise with it calls a
// native "then" method that does not exist and the await never settles.
const getKeystore = async () => {
  if (!keystore) {
    const { registerPlugin } = await import('@capacitor/core');
    keystore = { plugin: registerPlugin('SecureTokenStore') };
  }
  return keystore;
};

// Same rule as getKeystore: hand out a holder, never the plugin proxy.
const getPreferences = async () => {
  if (!Preferences) {
    const module = await import('@capacitor/preferences');
    Preferences = { plugin: module.Preferences };
  }
  return Preferences;
};

const isEmpty = (v) => v === null || v === undefined || v === '';

// Telemetry counter «Keystore-Schreibfehler»: no key name, no value.
const reportKeystoreWriteFailure = (key, stage) => {
  const group = AUTH_KEYS.includes(key) ? 'auth' : 'other';
  import('../boot/sentry')
    .then(({ captureMessage }) => captureMessage(`secure-storage: keystore write failed (${stage})`, 'warning', {
      fingerprint: ['keystore-write-failed', stage],
      tags: { keystore_write_stage: stage, keystore_key_group: group }
    }))
    .catch(() => { /* telemetry optional */ });
};

/**
 * T2: delete the five auth keys from Preferences (mobile). Never reads a
 * value for use, never throws.
 * @returns {Promise<boolean>} true only when get() confirms every key is gone
 */
export const purgeLegacyAuthPreferences = async () => {
  if (!isCapacitor()) return true;
  let prefs;
  try {
    ({ plugin: prefs } = await getPreferences());
  } catch {
    return false;
  }
  let done = true;
  for (const key of AUTH_KEYS) {
    try {
      await prefs.remove({ key });
      if (!isEmpty((await prefs.get({ key }))?.value)) done = false;
    } catch {
      done = false; // next start tries again
    }
  }
  return done;
};

/**
 * Store a secret in the platform keystore (mobile only).
 * @param {string} key
 * @param {string} value
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const setSecureItem = async (key, value) => {
  if (!key || typeof value !== 'string') return { success: false, error: 'Key and string value are required' };
  if (!isCapacitor()) return { success: false, error: 'Unsupported platform' };
  let store;
  try {
    ({ plugin: store } = await getKeystore());
  } catch (error) {
    reportKeystoreWriteFailure(key, 'unavailable');
    return { success: false, error: error?.message || 'Keystore unavailable' };
  }
  // Previous value, to put back if the read-back does not match (T4).
  let previous;
  let previousKnown = false;
  try {
    const before = (await store.get({ key }))?.value;
    previous = typeof before === 'string' ? before : null;
    previousKnown = true;
  } catch { /* unknown: the write below decides */ }
  try {
    await store.set({ key, value });
  } catch (error) {
    // The native write is atomic: the previous value is unchanged.
    console.error('Secure storage: keystore write failed; not stored (no plaintext fallback)');
    reportKeystoreWriteFailure(key, 'write');
    return { success: false, error: error?.message || 'Keystore unavailable' };
  }
  let check;
  try {
    check = (await store.get({ key }))?.value;
  } catch { check = undefined; }
  if (check === value) return { success: true };
  if (previousKnown) {
    try {
      if (previous === null) await store.remove({ key });
      else await store.set({ key, value: previous });
    } catch { /* nothing more we can do; the session stays in memory */ }
  }
  reportKeystoreWriteFailure(key, 'readback');
  return { success: false, error: 'Keystore read-back mismatch' };
};

/**
 * Read a secret from the platform keystore (mobile only), telling a read
 * failure apart from a missing entry (the native get() resolves null for a
 * missing key and rejects on every failure). Never from Preferences (T1).
 * @param {string} key
 * @returns {Promise<{ ok: true, value: string|null } | { ok: false, error: string }>}
 */
export const readSecureItem = async (key) => {
  if (!key || !isCapacitor()) return { ok: false, error: 'Unsupported platform' };
  try {
    const { plugin: store } = await getKeystore();
    const result = await store.get({ key });
    return { ok: true, value: result && typeof result.value === 'string' && result.value !== '' ? result.value : null };
  } catch (error) {
    return { ok: false, error: error?.message || 'Keystore unavailable' };
  }
};

/**
 * Read a secret (null when missing OR unreadable). Callers that must not
 * treat a read failure as "missing" (pairing keys) use readSecureItem.
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export const getSecureItem = async (key) => {
  const result = await readSecureItem(key);
  return result.ok ? result.value : null;
};

/**
 * Remove a secret from the keystore.
 * @param {string} key
 * @returns {Promise<{success: boolean, error?: string}>} success only when confirmed gone
 */
export const removeSecureItem = async (key) => {
  if (!key || !isCapacitor()) return { success: false, error: 'Unsupported platform' };
  try {
    const { plugin: store } = await getKeystore();
    await store.remove({ key });
    const left = (await store.get({ key }))?.value;
    return isEmpty(left) ? { success: true } : { success: false, error: 'Keystore value still present' };
  } catch (error) {
    return { success: false, error: error?.message || 'Keystore unavailable' };
  }
};

/**
 * Retrieve authentication token
 * @returns {Promise<string|null>} The stored token or null
 */
export const getToken = async () => {
  try {
    if (isElectron()) {
      // Main's session authority decides (null while signed out).
      const result = await window.electronAPI.auth.getToken();
      // The main handler returns the token string (older code expected { token }).
      if (typeof result === 'string') return result || null;
      return result?.token || null;
    }

    if (isCapacitor()) {
      // E6: the tombstone wins over a token left in the keystore.
      if (isSignedOut()) return null;
      return await getSecureItem(STORAGE_KEYS.AUTH_TOKEN);
    }

    return null;
  } catch (error) {
    console.error('Error retrieving token:', error?.message || error);
    return null;
  }
};

/**
 * Get stored user credentials
 * @returns {Promise<{userId?: string, email?: string}>}
 */
export const getUserCredentials = async () => {
  try {
    if (isElectron()) {
      if (window.electronAPI.auth.getUserInfo) {
        return await window.electronAPI.auth.getUserInfo();
      }
      return {};
    }

    if (isCapacitor()) {
      if (isSignedOut()) return {};
      const raw = await getSecureItem(STORAGE_KEYS.USER_INFO);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    return {};
  } catch (error) {
    console.error('Error retrieving user credentials:', error?.message || error);
    return {};
  }
};

/**
 * Check if user is authenticated (has valid token)
 * @returns {Promise<boolean>}
 */
export const isAuthenticated = async () => {
  const token = await getToken();
  return !!token;
};

/**
 * Get platform-specific security info (for debugging/display)
 * @returns {Object}
 */
export const getSecurityInfo = () => {
  if (isElectron()) {
    return {
      platform: 'electron',
      storageType: 'Electron safeStorage (OS keystore)',
      encryptionLevel: 'high'
    };
  }

  if (isIOS()) {
    return {
      platform: 'ios',
      storageType: 'iOS Keychain',
      encryptionLevel: 'high'
    };
  }

  if (isAndroid()) {
    return {
      platform: 'android',
      storageType: 'Android Keystore',
      encryptionLevel: 'high'
    };
  }

  return {
    platform: 'web',
    storageType: 'none',
    encryptionLevel: 'none'
  };
};
