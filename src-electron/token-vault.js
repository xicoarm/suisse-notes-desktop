'use strict';

/**
 * Desktop session token storage (main process).
 *
 * SECURITY: the token is only ever written to disk encrypted by the OS
 * keystore through Electron safeStorage (Windows DPAPI, macOS Keychain,
 * Linux Secret Service / KWallet). There is no plaintext fallback any more:
 *
 * - When encryption is unavailable, or on Linux only the "basic_text"
 *   backend is available (a fixed, publicly known key: obfuscation, not
 *   protection), a new token is kept in memory for this run only and any
 *   plaintext copy on disk is deleted. The user signs in again after a
 *   restart on such a system.
 * - Older versions stored the token in plaintext when encryption was
 *   unavailable. Such a legacy value is recognised (a JWT contains '.',
 *   base64 ciphertext never does), migrated once to the encrypted form and
 *   the plaintext copy is replaced. If it cannot be migrated it is still read
 *   (so nobody is signed out by the update) but never rewritten; it is
 *   removed on the next save, refresh or sign-out.
 *
 * The functions take the safeStorage module and the electron-store instance
 * as arguments so they can be unit tested without Electron.
 */

const TOKEN_KEY = 'authToken';

/**
 * @param {object} safeStorage - electron safeStorage
 * @param {string} [platform=process.platform]
 * @returns {boolean} true when safeStorage really protects data with an OS keystore
 */
function isSecureStorageAvailable(safeStorage, platform = process.platform) {
  try {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return false;
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === 'basic_text' || backend === 'unknown') return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A stored value is a legacy plaintext token when it looks like a JWT. */
function isLegacyPlaintext(stored) {
  return typeof stored === 'string' && stored.includes('.');
}

/**
 * @param {object} deps
 * @param {object} deps.safeStorage - electron safeStorage
 * @param {object} deps.store - electron-store instance (get/set/delete)
 * @param {string} [deps.platform]
 * @param {(msg: string) => void} [deps.warn]
 */
function createTokenVault({ safeStorage, store, platform = process.platform, warn = () => {} }) {
  // Session-only copy, used when the OS offers no secure storage.
  let memoryToken = null;

  const secure = () => isSecureStorageAvailable(safeStorage, platform);

  const encryptToStore = (token) => {
    const encrypted = safeStorage.encryptString(token).toString('base64');
    store.set(TOKEN_KEY, encrypted);
    // Read back: only a value that decrypts to the same token counts as stored.
    const check = safeStorage.decryptString(Buffer.from(store.get(TOKEN_KEY), 'base64'));
    if (check !== token) throw new Error('token read-back mismatch');
  };

  /**
   * Persist a token. Returns { success, persisted }: persisted=false means
   * it is held in memory for this run only.
   */
  function saveToken(token) {
    if (!token || typeof token !== 'string') return { success: false, persisted: false, error: 'Token is required' };
    memoryToken = token;
    if (!secure()) {
      // Never write plaintext; drop any older plaintext copy.
      if (store.get(TOKEN_KEY)) store.delete(TOKEN_KEY);
      warn('token-vault: no secure OS storage; token kept in memory for this session only');
      return { success: true, persisted: false };
    }
    try {
      encryptToStore(token);
      return { success: true, persisted: true };
    } catch (error) {
      try { store.delete(TOKEN_KEY); } catch { /* ignore */ }
      warn(`token-vault: encrypting the token failed (${error?.message || error}); kept in memory only`);
      return { success: true, persisted: false };
    }
  }

  /** @returns {string|null} */
  function getToken() {
    const stored = store.get(TOKEN_KEY);
    if (!stored) return memoryToken;

    if (isLegacyPlaintext(stored)) {
      // Older versions wrote the raw token when encryption was unavailable.
      if (secure()) {
        try {
          encryptToStore(stored);
        } catch (error) {
          warn(`token-vault: migrating the plaintext token failed (${error?.message || error})`);
          // Ciphertext may be half written: put the legacy value back so the
          // user stays signed in; it is removed on the next save or sign-out.
          try { store.set(TOKEN_KEY, stored); } catch { /* ignore */ }
        }
      } else {
        // No OS encryption: the token moves to memory for this run and the
        // plaintext copy leaves the disk (same rule as saveToken: never
        // plaintext on disk; the next start asks for a sign-in).
        try { store.delete(TOKEN_KEY); } catch { /* ignore */ }
        warn('token-vault: no secure OS storage; plaintext token removed from disk, kept in memory for this session only');
      }
      memoryToken = stored;
      return stored;
    }

    try {
      const decrypted = safeStorage.decryptString(Buffer.from(stored, 'base64'));
      memoryToken = decrypted;
      if (!secure()) {
        // Written by an older version with an insecure backend (Linux
        // basic_text: a fixed, public key - effectively plaintext). Same rule
        // as for plaintext: memory for this run, off the disk.
        try { store.delete(TOKEN_KEY); } catch { /* ignore */ }
        warn('token-vault: token stored with an insecure backend removed from disk, kept in memory for this session only');
      }
      return decrypted;
    } catch (error) {
      warn(`token-vault: decrypting the token failed (${error?.message || error})`);
      return memoryToken;
    }
  }

  function clearToken() {
    memoryToken = null;
    store.delete(TOKEN_KEY);
    return { success: true };
  }

  return { saveToken, getToken, clearToken, isSecure: secure };
}

module.exports = { createTokenVault, isSecureStorageAvailable, isLegacyPlaintext, TOKEN_KEY };
