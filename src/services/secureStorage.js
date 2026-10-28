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
 * SECURITY: there is NO plaintext fallback. If the keystore is unavailable,
 * storing fails ({ success: false }) and nothing is written to Capacitor
 * Preferences (UserDefaults / SharedPreferences, plaintext and part of the
 * iOS backup). The signed-in session then lasts for this run only.
 *
 * Migration (one time, per key): older versions kept these values in
 * Preferences. On the first read, a legacy value is copied into the
 * keystore, read back, and only then the plaintext copy is removed. If the
 * keystore write fails, the legacy value is left in place and still returned
 * - the user is not signed out by the update - but it is never rewritten;
 * it is deleted at the next save of that key or at sign-out.
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

let keystore = null;
let Preferences = null;

const getKeystore = async () => {
  if (!keystore) {
    const { registerPlugin } = await import('@capacitor/core');
    keystore = registerPlugin('SecureTokenStore');
  }
  return keystore;
};

const getPreferences = async () => {
  if (!Preferences) {
    const module = await import('@capacitor/preferences');
    Preferences = module.Preferences;
  }
  return Preferences;
};

/** Remove a legacy plaintext copy; never throws. */
const removeLegacy = async (key) => {
  try {
    const prefs = await getPreferences();
    await prefs.remove({ key });
  } catch { /* nothing to remove or Preferences unavailable */ }
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
  // A plaintext copy of an older value must never outlive a newer one.
  await removeLegacy(key);
  try {
    const store = await getKeystore();
    await store.set({ key, value });
    return { success: true };
  } catch (error) {
    console.error('Secure storage: keystore write failed; not stored (no plaintext fallback)');
    return { success: false, error: error?.message || 'Keystore unavailable' };
  }
};

/**
 * Read a secret from the platform keystore (mobile only), migrating a legacy
 * plaintext Preferences value once.
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export const getSecureItem = async (key) => {
  if (!key || !isCapacitor()) return null;
  let keystoreOk = true;
  try {
    const store = await getKeystore();
    const result = await store.get({ key });
    if (result && typeof result.value === 'string') return result.value;
  } catch {
    keystoreOk = false;
  }

  // Legacy plaintext value from an older version?
  let legacy = null;
  try {
    const prefs = await getPreferences();
    legacy = (await prefs.get({ key }))?.value || null;
  } catch {
    legacy = null;
  }
  if (!legacy) return null;

  if (keystoreOk) {
    try {
      const store = await getKeystore();
      await store.set({ key, value: legacy });
      const check = await store.get({ key });
      if (check?.value === legacy) {
        await removeLegacy(key);
      }
    } catch {
      // Keep the legacy value: the user stays signed in; it is never rewritten.
    }
  }
  return legacy;
};

/**
 * Remove a secret from the keystore and any legacy plaintext copy.
 * @param {string} key
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const removeSecureItem = async (key) => {
  if (!key || !isCapacitor()) return { success: false, error: 'Unsupported platform' };
  await removeLegacy(key);
  try {
    const store = await getKeystore();
    await store.remove({ key });
    return { success: true };
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
      // The full user object only; the separate userId/userEmail keys of
      // older versions are not written any more (and removed if present).
      const result = await setSecureItem(STORAGE_KEYS.USER_INFO, JSON.stringify(credentials || {}));
      await removeLegacy(STORAGE_KEYS.USER_ID);
      await removeLegacy(STORAGE_KEYS.USER_EMAIL);
      return result;
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
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch {
          // fall through to legacy keys
        }
      }

      // Oldest format: individual keys (migrated into the keystore on read)
      const userId = await getSecureItem(STORAGE_KEYS.USER_ID);
      const email = await getSecureItem(STORAGE_KEYS.USER_EMAIL);

      return {
        userId: userId || undefined,
        email: email || undefined
      };
    }

    return {};
  } catch (error) {
    console.error('Error retrieving user credentials:', error?.message || error);
    return {};
  }
};

/**
 * Clear all stored credentials (logout): keystore entries and every legacy
 * plaintext copy.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const clearAllCredentials = async () => {
  try {
    if (isElectron()) {
      await window.electronAPI.auth.clearToken();
      if (window.electronAPI.auth.clearRefreshToken) {
        await window.electronAPI.auth.clearRefreshToken();
      }
      if (window.electronAPI.auth.clearUserInfo) {
        await window.electronAPI.auth.clearUserInfo();
      }
      return { success: true };
    }

    if (isCapacitor()) {
      let ok = true;
      for (const key of Object.values(STORAGE_KEYS)) {
        const result = await removeSecureItem(key);
        if (!result.success) ok = false;
      }
      return ok ? { success: true } : { success: false, error: 'Keystore unavailable' };
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error clearing all credentials:', error?.message || error);
    return { success: false, error: error.message };
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
