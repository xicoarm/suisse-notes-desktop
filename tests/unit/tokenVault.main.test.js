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

  it('a plaintext token of an older version is never returned and is deleted (all backends)', () => {
    const cases = [
      ['win32', fakeSafeStorage()],
      ['win32', fakeSafeStorage({ failEncrypt: true })],
      ['win32', fakeSafeStorage({ available: false })],
      ['linux', fakeSafeStorage({ backend: 'basic_text' })]
    ];
    for (const [platform, safe] of cases) {
      const store = memoryStore({ authToken: JWT });
      const vault = createTokenVault({ safeStorage: safe, store, platform });
      expect(vault.getToken()).toBeNull();
      expect(store.data.authToken).toBeUndefined(); // deleted, not re-encrypted
      expect(createTokenVault({ safeStorage: safe, store, platform }).getToken()).toBeNull();
    }
  });

  it('a token an older version encrypted with Linux basic_text is never returned and is deleted', () => {
    const basic = fakeSafeStorage({ backend: 'basic_text' });
    const store = memoryStore({ authToken: basic.encryptString(JWT).toString('base64') });
    const vault = createTokenVault({ safeStorage: basic, store, platform: 'linux' });
    expect(vault.getToken()).toBeNull();
    expect(store.data.authToken).toBeUndefined();
    expect(createTokenVault({ safeStorage: basic, store, platform: 'linux' }).getToken()).toBeNull();
  });

  it('secure ciphertext stays on disk while encryption is unavailable, and is read again later', () => {
    const safe = fakeSafeStorage();
    const ciphertext = safe.encryptString(JWT).toString('base64');
    const store = memoryStore({ authToken: ciphertext });
    expect(createTokenVault({ safeStorage: fakeSafeStorage({ available: false }), store, platform: 'darwin' }).getToken()).toBeNull();
    expect(store.data.authToken).toBe(ciphertext);
    expect(createTokenVault({ safeStorage: safe, store, platform: 'darwin' }).getToken()).toBe(JWT);
  });

  it('a secure backend keeps its encrypted token on disk', () => {
    const safe = fakeSafeStorage({ backend: 'gnome_libsecret' });
    const store = memoryStore({ authToken: safe.encryptString(JWT).toString('base64') });
    expect(createTokenVault({ safeStorage: safe, store, platform: 'linux' }).getToken()).toBe(JWT);
    expect(store.data.authToken).toBeDefined();
  });

  it('a failed encryption on save leaves no plaintext on disk', () => {
    const store = memoryStore({ authToken: 'old.plain.token' });
    const vault = createTokenVault({ safeStorage: fakeSafeStorage({ failEncrypt: true }), store, platform: 'win32' });
    expect(vault.saveToken(JWT)).toEqual({ success: true, persisted: false });
    expect(store.data.authToken).toBeUndefined();
  });

  it('a failed encryption keeps the previous ciphertext; the restart restores the previous token (T4)', () => {
    const safe = fakeSafeStorage();
    const OLD = 'old.jwt.token';
    const store = memoryStore({ authToken: safe.encryptString(OLD).toString('base64') });
    const vault = createTokenVault({ safeStorage: fakeSafeStorage({ failEncrypt: true }), store, platform: 'win32' });
    expect(vault.saveToken(JWT)).toEqual({ success: true, persisted: false });
    expect(vault.saveToken(JWT)).toEqual({ success: true, persisted: false }); // twice, same token
    expect(vault.getToken()).toBe(JWT); // this run uses the new token
    expect(createTokenVault({ safeStorage: safe, store, platform: 'win32' }).getToken()).toBe(OLD);
  });

  it('a read-back mismatch writes the previous raw value back; the restart restores it (T4)', () => {
    const safe = fakeSafeStorage();
    const OLD = 'old.jwt.token';
    const oldRaw = safe.encryptString(OLD).toString('base64');
    const store = memoryStore({ authToken: oldRaw });
    // The disk returns something else than what was written (once).
    const flaky = { ...store, set: (k, v) => { store.data[k] = k === 'authToken' && v !== oldRaw ? Buffer.from('enc:xxx').toString('base64') : v; } };
    const vault = createTokenVault({ safeStorage: safe, store: flaky, platform: 'darwin' });
    expect(vault.saveToken(JWT)).toEqual({ success: true, persisted: false });
    expect(store.data.authToken).toBe(oldRaw);
    expect(createTokenVault({ safeStorage: safe, store, platform: 'darwin' }).getToken()).toBe(OLD);
  });

  it('a read-back mismatch without a previous value leaves nothing on disk', () => {
    const safe = fakeSafeStorage();
    const store = memoryStore();
    const flaky = { ...store, set: (k) => { store.data[k] = Buffer.from('enc:xxx').toString('base64'); } };
    const vault = createTokenVault({ safeStorage: safe, store: flaky, platform: 'darwin' });
    expect(vault.saveToken(JWT).persisted).toBe(false);
    expect(store.data.authToken).toBeUndefined();
  });

  it('clearToken removes disk and memory copies', () => {
    const store = memoryStore();
    const vault = createTokenVault({ safeStorage: fakeSafeStorage(), store, platform: 'darwin' });
    vault.saveToken(JWT);
    expect(vault.clearToken()).toEqual({ success: true });
    expect(store.data.authToken).toBeUndefined();
    expect(vault.getToken()).toBeNull();
  });
});

describe('token-vault: clearToken reports a failed removal', () => {
  it('success only when the disk copy is gone', () => {
    const store = memoryStore();
    const vault = createTokenVault({ safeStorage: fakeSafeStorage(), store: { ...store, delete: () => { throw new Error('EACCES'); } }, platform: 'darwin' });
    vault.saveToken(JWT);
    expect(vault.clearToken().success).toBe(false);
  });
});

// Review round 7 (r6 low finding): a memory-only save (session record not
// writable) reports whether the older disk copy is really gone; the session
// authority never lets a new session live in memory over an old one that a
// restart would bring back. Failed at a3c841fa (the delete error was swallowed).
describe('token-vault: saveToken(persist:false) reports the delete', () => {
  it('deleted:true when the disk copy is gone, deleted:false when the delete fails', () => {
    const store = memoryStore({ authToken: Buffer.from('enc:xxx').toString('base64') });
    const vault = createTokenVault({ safeStorage: fakeSafeStorage(), store, platform: 'darwin' });
    expect(vault.saveToken(JWT, { persist: false })).toEqual({ success: true, persisted: false, deleted: true });
    expect(store.data.authToken).toBeUndefined();

    const stuck = memoryStore({ authToken: Buffer.from('enc:xxx').toString('base64') });
    const failing = createTokenVault({ safeStorage: fakeSafeStorage(), store: { ...stuck, delete: () => { throw new Error('EACCES'); } }, platform: 'darwin' });
    expect(failing.saveToken(JWT, { persist: false })).toEqual({ success: true, persisted: false, deleted: false });
    const silent = createTokenVault({ safeStorage: fakeSafeStorage(), store: { ...stuck, delete: () => {} }, platform: 'darwin' });
    expect(silent.saveToken(JWT, { persist: false }).deleted).toBe(false);
  });
});
