'use strict';

/**
 * Desktop session token storage (main process).
 *
 * SECURITY (review 10/2026, "option C"): the token is read only from
 * ciphertext of a real OS keystore through Electron safeStorage (Windows
 * DPAPI, macOS Keychain, Linux Secret Service / KWallet) or from memory.
 *
 * - T1 A plaintext token (older versions wrote one when encryption was
 *   unavailable; a JWT contains '.', base64 ciphertext never does) and a
 *   token encrypted with Linux "basic_text" (a fixed, public key) are never
 *   returned and never re-encrypted: they are deleted from disk. The user
 *   signs in once.
 * - T3 Without a secure keystore a new token stays in memory for this run.
 * - T4 Saving encrypts first, then writes and reads back; on any failure the
 *   previous raw value is written back (a plaintext one is not: it is
 *   deleted instead). A failed save never removes the last good copy.
 * - E6 The vault asks the session authority (session-authority.js) before it
 *   returns anything: while signed out getToken is null, even with a token
 *   still on disk or in memory. Only the authority saves and clears.
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

/** Linux with the obfuscation-only backend: its ciphertext counts as plaintext. */
function isInsecureBackend(safeStorage, platform) {
  try {
    return platform === 'linux'
      && typeof safeStorage?.getSelectedStorageBackend === 'function'
      && safeStorage.getSelectedStorageBackend() === 'basic_text';
  } catch {
    return false;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.safeStorage - electron safeStorage
 * @param {object} deps.store - electron-store instance (get/set/delete)
 * @param {string} [deps.platform]
 * @param {(msg: string) => void} [deps.warn]
 * @param {() => boolean} [deps.isAllowed] - the session authority's tokenAllowed()
 */
function createTokenVault({ safeStorage, store, platform = process.platform, warn = () => {}, isAllowed = () => true }) {
  // This run's token: set by a save (also when it could not be persisted)
  // and by a successful decrypt; it wins over the disk.
  let memoryToken = null;

  const secure = () => isSecureStorageAvailable(safeStorage, platform);

  /** Delete what must never be read: plaintext, basic_text ciphertext. */
  function dropInsecureCopy() {
    let stored;
    try { stored = store.get(TOKEN_KEY); } catch { return; }
    if (!stored) return;
    const plaintext = isLegacyPlaintext(stored);
    if (!plaintext && !isInsecureBackend(safeStorage, platform)) return;
    try {
      store.delete(TOKEN_KEY);
      warn(`token-vault: ${plaintext ? 'plaintext' : 'insecurely encrypted'} token removed from disk (sign-in required)`);
    } catch (error) {
      warn(`token-vault: removing the insecure token copy failed (${error?.message || error}); retried next start`);
    }
  }

  /**
   * Persist a token. Returns { success, persisted }: persisted=false means
   * it is held in memory for this run only and the disk is unchanged.
   * { persist: false }: memory only, and the disk copy (an older session's)
   * is removed; `deleted` tells whether that removal is confirmed (the
   * session authority refuses the sign-in otherwise, E9).
   */
  function saveToken(token, { persist = true } = {}) {
    if (!token || typeof token !== 'string') return { success: false, persisted: false, error: 'Token is required' };
    memoryToken = token;
    dropInsecureCopy();
    if (!persist) {
      let deleted;
      try {
        store.delete(TOKEN_KEY);
        deleted = !store.get(TOKEN_KEY);
      } catch {
        deleted = false;
      }
      return { success: true, persisted: false, deleted };
    }
    if (!secure()) {
      warn('token-vault: no secure OS storage; token kept in memory for this session only');
      return { success: true, persisted: false };
    }
    let previous;
    try { previous = store.get(TOKEN_KEY); } catch { previous = undefined; }
    let encrypted;
    try {
      encrypted = safeStorage.encryptString(token).toString('base64');
    } catch (error) {
      // Nothing written: the previous value is untouched.
      warn(`token-vault: encrypting the token failed (${error?.message || error}); kept in memory only`);
      return { success: true, persisted: false };
    }
    try {
      store.set(TOKEN_KEY, encrypted);
      const check = safeStorage.decryptString(Buffer.from(store.get(TOKEN_KEY), 'base64'));
      if (check !== token) throw new Error('token read-back mismatch');
      return { success: true, persisted: true };
    } catch (error) {
      // Put the previous raw value back (never a plaintext one).
      try {
        if (previous && !isLegacyPlaintext(previous)) store.set(TOKEN_KEY, previous);
        else store.delete(TOKEN_KEY);
      } catch { /* the next save or start tries again */ }
      warn(`token-vault: storing the token failed (${error?.message || error}); previous value kept, new one in memory only`);
      return { success: true, persisted: false };
    }
  }

  /** @returns {string|null} */
  function getToken() {
    dropInsecureCopy();
    if (!isAllowed()) return null;
    if (memoryToken) return memoryToken;
    let stored;
    try { stored = store.get(TOKEN_KEY); } catch { return null; }
    if (!stored || isLegacyPlaintext(stored)) return null;
    // Encryption unavailable right now (not ready, keystore locked): the
    // ciphertext stays for a later run, nothing is returned.
    if (!secure()) return null;
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(stored, 'base64'));
      if (!decrypted) return null;
      memoryToken = decrypted;
      return decrypted;
    } catch (error) {
      warn(`token-vault: decrypting the token failed (${error?.message || error})`);
      return null;
    }
  }

  /**
   * The previous version's token for the one-time migration of the session
   * authority (E1 addendum). Not gated by isAllowed (the authority asks
   * before it allows anything) and not cached. A plaintext or basic_text copy
   * is never returned (T1).
   * @returns {{ status: 'ok', token: string } | { status: 'none'|'insecure'|'invalid'|'unavailable'|'error' }}
   */
  function readStoredToken() {
    let stored;
    try { stored = store.get(TOKEN_KEY); } catch { return { status: 'error' }; }
    if (!stored) return { status: 'none' };
    if (typeof stored !== 'string' || isLegacyPlaintext(stored) || isInsecureBackend(safeStorage, platform)) return { status: 'insecure' };
    // Not open yet (Windows, Linux: before app ready) or locked.
    if (!secure()) return { status: 'unavailable' };
    try {
      const token = safeStorage.decryptString(Buffer.from(stored, 'base64'));
      return token ? { status: 'ok', token } : { status: 'invalid' };
    } catch (error) {
      warn(`token-vault: decrypting the stored token failed (${error?.message || error})`);
      return { status: 'invalid' };
    }
  }

  /** @returns {{ success: boolean, error?: string }} success only when the disk copy is gone */
  function clearToken() {
    memoryToken = null;
    try {
      store.delete(TOKEN_KEY);
      return store.get(TOKEN_KEY) ? { success: false, error: 'Token still on disk' } : { success: true };
    } catch (error) {
      return { success: false, error: error?.message || 'Token could not be removed' };
    }
  }

  return { saveToken, getToken, clearToken, readStoredToken, isSecure: secure };
}

module.exports = { createTokenVault, isSecureStorageAvailable, isLegacyPlaintext, TOKEN_KEY };
