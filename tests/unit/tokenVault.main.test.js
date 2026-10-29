import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createTokenVault, isSecureStorageAvailable } = require('../../src-electron/token-vault.js');

// Fake safeStorage: "encrypts" by reversing + base64, so ciphertext never
// contains '.' (like real base64) and is not the plaintext.
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret', failEncrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => {
      if (failEncrypt) throw new Error('encrypt failed');
      return Buffer.from(`enc:${s.split('').reverse().join('')}`);
    },
    decryptString: (buf) => {
      const s = buf.toString();
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
      return s.slice(4).split('').reverse().join('');
    }
  };
}

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    delete: (k) => { delete data[k]; }
  };
}

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MSJ9.sig';

describe('token-vault (desktop session token)', () => {
  it('stores the token encrypted only', () => {
    const store = memoryStore();
    const vault = createTokenVault({ safeStorage: fakeSafeStorage(), store, platform: 'darwin' });
    expect(vault.saveToken(JWT)).toEqual({ success: true, persisted: true });
    expect(store.data.authToken).not.toContain(JWT);
    expect(store.data.authToken).not.toContain('.');
    expect(vault.getToken()).toBe(JWT);
  });

  it('never writes plaintext when encryption is unavailable: memory only, older plaintext deleted', () => {
    const store = memoryStore({ authToken: 'old.plain.token' });
    const vault = createTokenVault({ safeStorage: fakeSafeStorage({ available: false }), store, platform: 'win32' });
    expect(vault.saveToken(JWT)).toEqual({ success: true, persisted: false });
    expect(store.data.authToken).toBeUndefined();
    expect(vault.getToken()).toBe(JWT);
    // A restart (new vault) has no token: the user signs in again.
    const restarted = createTokenVault({ safeStorage: fakeSafeStorage({ available: false }), store, platform: 'win32' });
    expect(restarted.getToken()).toBeNull();
  });

  it('treats the Linux basic_text backend as not secure', () => {
    expect(isSecureStorageAvailable(fakeSafeStorage({ backend: 'basic_text' }), 'linux')).toBe(false);
    expect(isSecureStorageAvailable(fakeSafeStorage({ backend: 'gnome_libsecret' }), 'linux')).toBe(true);
    expect(isSecureStorageAvailable(fakeSafeStorage({ backend: 'basic_text' }), 'darwin')).toBe(true);
    const store = memoryStore();
    const vault = createTokenVault({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }), store, platform: 'linux' });
    expect(vault.saveToken(JWT).persisted).toBe(false);
    expect(store.data.authToken).toBeUndefined();
  });

  it('migrates a legacy plaintext token once to the encrypted form', () => {
    const store = memoryStore({ authToken: JWT });
    const vault = createTokenVault({ safeStorage: fakeSafeStorage(), store, platform: 'win32' });
    expect(vault.getToken()).toBe(JWT);
    expect(store.data.authToken).not.toContain('.');
    expect(fakeSafeStorage().decryptString(Buffer.from(store.data.authToken, 'base64'))).toBe(JWT);
  });

  it('keeps a legacy plaintext token readable when it cannot be migrated (no sign-out by the update)', () => {
    const store = memoryStore({ authToken: JWT });
    const vault = createTokenVault({ safeStorage: fakeSafeStorage({ failEncrypt: true }), store, platform: 'win32' });
    expect(vault.getToken()).toBe(JWT);
    expect(store.data.authToken).toBe(JWT);
  });

  it('without OS encryption a legacy plaintext token moves to memory and leaves the disk', () => {
    for (const [platform, safe] of [['win32', fakeSafeStorage({ available: false })], ['linux', fakeSafeStorage({ backend: 'basic_text' })]]) {
      const store = memoryStore({ authToken: JWT });
      const vault = createTokenVault({ safeStorage: safe, store, platform });
      expect(vault.getToken()).toBe(JWT);
      expect(store.data.authToken).toBeUndefined();
      expect(vault.getToken()).toBe(JWT); // this run keeps working
      const restarted = createTokenVault({ safeStorage: safe, store, platform });
      expect(restarted.getToken()).toBeNull();
    }
  });

  it('update case: a token an older version encrypted with Linux basic_text leaves the disk after the RAM hand-over', () => {
    const basic = fakeSafeStorage({ backend: 'basic_text' });
    const store = memoryStore({ authToken: basic.encryptString(JWT).toString('base64') });
    const vault = createTokenVault({ safeStorage: basic, store, platform: 'linux' });
    expect(vault.getToken()).toBe(JWT);
    expect(store.data.authToken).toBeUndefined();
    expect(vault.getToken()).toBe(JWT); // this run keeps working
    expect(createTokenVault({ safeStorage: basic, store, platform: 'linux' }).getToken()).toBeNull();
  });

  it('a secure backend keeps its encrypted token on disk', () => {
    const safe = fakeSafeStorage({ backend: 'gnome_libsecret' });
    const store = memoryStore({ authToken: safe.encryptString(JWT).toString('base64') });
    expect(createTokenVault({ safeStorage: safe, store, platform: 'linux' }).getToken()).toBe(JWT);
    expect(store.data.authToken).toBeDefined();
  });

  it('a failed encryption on save leaves nothing on disk', () => {
    const store = memoryStore({ authToken: 'old.plain.token' });
    const vault = createTokenVault({ safeStorage: fakeSafeStorage({ failEncrypt: true }), store, platform: 'win32' });
    expect(vault.saveToken(JWT)).toEqual({ success: true, persisted: false });
    expect(store.data.authToken).toBeUndefined();
  });

  it('clearToken removes disk and memory copies', () => {
    const store = memoryStore();
    const vault = createTokenVault({ safeStorage: fakeSafeStorage(), store, platform: 'darwin' });
    vault.saveToken(JWT);
    vault.clearToken();
    expect(store.data.authToken).toBeUndefined();
    expect(vault.getToken()).toBeNull();
  });
});
