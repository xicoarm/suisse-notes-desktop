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
 * - T5 Sign-out sets the marker "auth.signedOut" (localStorage, no secret)
 *   BEFORE anything is removed; it is cleared only after a login was stored.
 *   While it is set, a start restores no session and removes again - so an
 *   aborted or failed removal still ends signed out.
 */

import { isElectron, isCapacitor, isIOS, isAndroid } from '../utils/platform';

// Storage keys
const STORAGE_KEYS = {
  AUTH_TOKEN: 'authToken',
  REFRESH_TOKEN: 'refreshToken',
  USER_ID: 'userId',
  USER_EMAIL: 'userEmail',
  USER_INFO: 'userInfo'
};

/** The five auth keys (keystore entries and legacy Preferences copies). */
export const AUTH_KEYS = Object.freeze(Object.values(STORAGE_KEYS));

/** Sign-out marker (localStorage). Not a secret: only "1" or absent. */
export const SIGNED_OUT_MARKER = 'auth.signedOut';

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

/** @returns {boolean} true while a sign-out has not been followed by a stored login. */
export const isSignedOutMarked = () => {
  try {
    return localStorage.getItem(SIGNED_OUT_MARKER) === '1';
  } catch {
    return true; // cannot tell: treat as signed out (never restore blindly)
  }
};

/** @returns {boolean} true when the marker is set */
export const markSignedOut = () => {
  try {
    localStorage.setItem(SIGNED_OUT_MARKER, '1');
    return true;
  } catch {
    return false;
  }
};

/** Clear the marker; only after a login was stored (storeSession). */
export const clearSignedOutMarker = () => {
  try {
    localStorage.removeItem(SIGNED_OUT_MARKER);
    return true;
  } catch {
    return false;
  }
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
 * Read a secret from the platform keystore (mobile only). Never from
 * Preferences (T1).
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export const getSecureItem = async (key) => {
  if (!key || !isCapacitor()) return null;
  try {
    const { plugin: store } = await getKeystore();
    const result = await store.get({ key });
    return result && typeof result.value === 'string' && result.value !== '' ? result.value : null;
  } catch {
    return null;
  }
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
 * Store authentication token securely
 * @param {string} token - The authentication token to store
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const storeToken = async (token) => {
  if (!token) {
    return { success: false, error: 'Token is required' };
  }

  try {
    if (isElectron()) {
      // Desktop: OS keystore in the main process (token-vault.js)
      return await window.electronAPI.auth.saveToken(token);
    }

    if (isCapacitor()) {
      return await setSecureItem(STORAGE_KEYS.AUTH_TOKEN, token);
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error storing token:', error?.message || error);
    return { success: false, error: error.message };
  }
};

/**
 * Retrieve authentication token
 * @returns {Promise<string|null>} The stored token or null
 */
export const getToken = async () => {
  try {
    if (isElectron()) {
      const result = await window.electronAPI.auth.getToken();
      // The main handler returns the token string (older code expected { token }).
      if (typeof result === 'string') return result || null;
      return result?.token || null;
    }

    if (isCapacitor()) {
      return await getSecureItem(STORAGE_KEYS.AUTH_TOKEN);
    }

    return null;
  } catch (error) {
    console.error('Error retrieving token:', error?.message || error);
    return null;
  }
};

/**
 * Clear authentication token
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const clearToken = async () => {
  try {
    if (isElectron()) {
      return await window.electronAPI.auth.clearToken();
    }

    if (isCapacitor()) {
      return await removeSecureItem(STORAGE_KEYS.AUTH_TOKEN);
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error clearing token:', error?.message || error);
    return { success: false, error: error.message };
  }
};

/**
 * Store refresh token securely
 * @param {string} token - The refresh token to store
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const storeRefreshToken = async (token) => {
  if (!token) {
    return { success: false, error: 'Token is required' };
  }

  try {
    if (isElectron()) {
      if (window.electronAPI.auth.saveRefreshToken) {
        return await window.electronAPI.auth.saveRefreshToken(token);
      }
      return { success: true }; // Desktop has no separate refresh token storage
    }

    if (isCapacitor()) {
      return await setSecureItem(STORAGE_KEYS.REFRESH_TOKEN, token);
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error storing refresh token:', error?.message || error);
    return { success: false, error: error.message };
  }
};

/**
 * Retrieve refresh token
 * @returns {Promise<string|null>}
 */
export const getRefreshToken = async () => {
  try {
    if (isElectron()) {
      if (window.electronAPI.auth.getRefreshToken) {
        const result = await window.electronAPI.auth.getRefreshToken();
        return result.token || null;
      }
      return null;
    }

    if (isCapacitor()) {
      return await getSecureItem(STORAGE_KEYS.REFRESH_TOKEN);
    }

    return null;
  } catch (error) {
    console.error('Error retrieving refresh token:', error?.message || error);
    return null;
  }
};

/**
 * Clear refresh token
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const clearRefreshToken = async () => {
  try {
    if (isElectron()) {
      if (window.electronAPI.auth.clearRefreshToken) {
        return await window.electronAPI.auth.clearRefreshToken();
      }
      return { success: true };
    }

    if (isCapacitor()) {
      return await removeSecureItem(STORAGE_KEYS.REFRESH_TOKEN);
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error clearing refresh token:', error?.message || error);
    return { success: false, error: error.message };
  }
};

/**
 * Store user credentials (email/id for display purposes)
 * @param {Object} credentials - User credentials
 * @param {string} credentials.userId - User ID
 * @param {string} credentials.email - User email
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const storeUserCredentials = async (credentials) => {
  try {
    if (isElectron()) {
      if (window.electronAPI.auth.saveUserInfo) {
        return await window.electronAPI.auth.saveUserInfo(credentials);
      }
      return { success: true };
    }

    if (isCapacitor()) {
      // The full user object only (the per-field keys of older versions
      // are never written; the start purges their plaintext copies).
      return await setSecureItem(STORAGE_KEYS.USER_INFO, JSON.stringify(credentials || {}));
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error storing user credentials:', error?.message || error);
    return { success: false, error: error.message };
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
 * Clear all stored credentials (sign-out). The sign-out marker is set FIRST
 * (T5): if a removal fails or the app is killed in between, the next start
 * restores nothing and removes again.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const clearAllCredentials = async () => {
  markSignedOut();
  try {
    if (isElectron()) {
      let ok = true;
      const clearToken = await window.electronAPI.auth.clearToken();
      if (clearToken && clearToken.success === false) ok = false;
      if (window.electronAPI.auth.clearRefreshToken) {
        const r = await window.electronAPI.auth.clearRefreshToken();
        if (r && r.success === false) ok = false;
      }
      if (window.electronAPI.auth.clearUserInfo) {
        const r = await window.electronAPI.auth.clearUserInfo();
        if (r && r.success === false) ok = false;
      }
      return ok ? { success: true } : { success: false, error: 'Credentials not fully removed' };
    }

    if (isCapacitor()) {
      let ok = true;
      for (const key of AUTH_KEYS) {
        const result = await removeSecureItem(key);
        if (!result.success) ok = false;
      }
      if (!(await purgeLegacyAuthPreferences())) ok = false;
      return ok ? { success: true } : { success: false, error: 'Keystore unavailable' };
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error clearing all credentials:', error?.message || error);
    return { success: false, error: error.message };
  }
};

/**
 * Store a login (token + user). Clears the sign-out marker only when both
 * were persisted (T5); otherwise the session lives in memory for this run
 * and the next start is signed out.
 * @returns {Promise<{success: boolean, persisted: boolean}>}
 */
export const storeSession = async ({ token, user }) => {
  const saved = await storeToken(token);
  const info = await storeUserCredentials(user);
  const persisted = !!(saved && saved.success && saved.persisted !== false && info && info.success !== false);
  if (persisted) clearSignedOutMarker();
  return { success: !!(saved && saved.success), persisted };
};

/**
 * Start: the stored session, or nothing. Purges the legacy plaintext copies
 * (T2) and honours the sign-out marker (T5).
 * @returns {Promise<{ token: string|null, userInfo: object|null, signedOut?: boolean }>}
 */
export const loadStoredSession = async () => {
  await purgeLegacyAuthPreferences();
  if (isSignedOutMarked()) {
    await clearAllCredentials();
    return { token: null, userInfo: null, signedOut: true };
  }
  const token = await getToken();
  const userInfo = await getUserCredentials();
  return { token, userInfo };
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
