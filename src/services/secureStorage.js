/**
 * Secure storage service for authentication tokens
 * Platform-aware secure credential storage:
 * - Desktop (Electron): Uses safeStorage API (DPAPI/Keychain/libsecret)
 * - iOS: Uses Capacitor Preferences (can be upgraded to Keychain plugin)
 * - Android: Uses Capacitor Preferences (can be upgraded to EncryptedSharedPreferences)
 */

import { isElectron, isCapacitor, isIOS, isAndroid } from '../utils/platform';

// Storage keys
const STORAGE_KEYS = {
  AUTH_TOKEN: 'authToken',
  REFRESH_TOKEN: 'refreshToken',
  USER_ID: 'userId',
  USER_EMAIL: 'userEmail'
};

// Lazy load Capacitor Preferences
let Preferences = null;

/**
 * Initialize Capacitor Preferences module if on mobile
 */
const initCapacitorPreferences = async () => {
  if (isCapacitor() && !Preferences) {
    const module = await import('@capacitor/preferences');
    Preferences = module.Preferences;
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
      // Desktop: use Electron's encrypted storage via preload API
      const result = await window.electronAPI.auth.saveToken(token);
      return result;
    }

    if (isCapacitor()) {
      await initCapacitorPreferences();

      // Mobile: use Capacitor Preferences
      // Note: For production with highly sensitive data, consider:
      // - iOS: @nicegram/capacitor-native-keychain for Keychain access
      // - Android: capacitor-secure-storage-plugin for EncryptedSharedPreferences
      await Preferences.set({
        key: STORAGE_KEYS.AUTH_TOKEN,
        value: token
      });

      return { success: true };
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error storing token:', error);
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
      // Desktop: use Electron's encrypted storage via preload API
      const result = await window.electronAPI.auth.getToken();
      return result.token || null;
    }

    if (isCapacitor()) {
      await initCapacitorPreferences();

      const result = await Preferences.get({ key: STORAGE_KEYS.AUTH_TOKEN });
      return result.value || null;
    }

    return null;
  } catch (error) {
    console.error('Error retrieving token:', error);
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
      const result = await window.electronAPI.auth.clearToken();
      return result;
    }

    if (isCapacitor()) {
      await initCapacitorPreferences();

      await Preferences.remove({ key: STORAGE_KEYS.AUTH_TOKEN });
      return { success: true };
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error clearing token:', error);
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
      // Desktop may not have separate refresh token storage
      // Use the same mechanism if available
      if (window.electronAPI.auth.saveRefreshToken) {
        return await window.electronAPI.auth.saveRefreshToken(token);
      }
      return { success: true }; // Fallback: don't store separately
    }

    if (isCapacitor()) {
      await initCapacitorPreferences();

      await Preferences.set({
        key: STORAGE_KEYS.REFRESH_TOKEN,
        value: token
      });

      return { success: true };
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error storing refresh token:', error);
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
      await initCapacitorPreferences();

      const result = await Preferences.get({ key: STORAGE_KEYS.REFRESH_TOKEN });
      return result.value || null;
    }

    return null;
  } catch (error) {
    console.error('Error retrieving refresh token:', error);
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
      await initCapacitorPreferences();

      await Preferences.remove({ key: STORAGE_KEYS.REFRESH_TOKEN });
      return { success: true };
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error clearing refresh token:', error);
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
      // Desktop stores user info via preload API
      if (window.electronAPI.auth.saveUserInfo) {
        return await window.electronAPI.auth.saveUserInfo(credentials);
      }
      return { success: true };
    }

    if (isCapacitor()) {
      await initCapacitorPreferences();

      if (credentials.userId) {
        await Preferences.set({
          key: STORAGE_KEYS.USER_ID,
          value: credentials.userId
        });
      }

      if (credentials.email) {
        await Preferences.set({
          key: STORAGE_KEYS.USER_EMAIL,
          value: credentials.email
        });
      }

      return { success: true };
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error storing user credentials:', error);
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
      await initCapacitorPreferences();

      const userId = await Preferences.get({ key: STORAGE_KEYS.USER_ID });
      const email = await Preferences.get({ key: STORAGE_KEYS.USER_EMAIL });

      return {
        userId: userId.value || undefined,
        email: email.value || undefined
      };
    }

    return {};
  } catch (error) {
    console.error('Error retrieving user credentials:', error);
    return {};
  }
};

/**
 * Clear all stored credentials (logout)
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
      await initCapacitorPreferences();

      await Preferences.remove({ key: STORAGE_KEYS.AUTH_TOKEN });
      await Preferences.remove({ key: STORAGE_KEYS.REFRESH_TOKEN });
      await Preferences.remove({ key: STORAGE_KEYS.USER_ID });
      await Preferences.remove({ key: STORAGE_KEYS.USER_EMAIL });

      return { success: true };
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error clearing all credentials:', error);
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
      storageType: 'Electron safeStorage (OS-level encryption)',
      encryptionLevel: 'high'
    };
  }

  if (isIOS()) {
    return {
      platform: 'ios',
      storageType: 'Capacitor Preferences',
      encryptionLevel: 'medium',
      upgradeAvailable: 'iOS Keychain via @nicegram/capacitor-native-keychain'
    };
  }

  if (isAndroid()) {
    return {
      platform: 'android',
      storageType: 'Capacitor Preferences',
      encryptionLevel: 'medium',
      upgradeAvailable: 'EncryptedSharedPreferences via capacitor-secure-storage-plugin'
    };
  }

  return {
    platform: 'web',
    storageType: 'none',
    encryptionLevel: 'none'
  };
};
