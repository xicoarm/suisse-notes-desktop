import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mobile (Capacitor) path of src/services/secureStorage.js: the session token
// lives in the platform keystore (native SecureTokenStore plugin), never in
// plaintext Preferences; legacy plaintext values are migrated once.

const keystoreData = new Map();
const prefsData = new Map();
const keystore = {
  failWrites: false,
  failAll: false,
  get: vi.fn(async ({ key }) => {
    if (keystore.failAll) throw new Error('KEYSTORE_READ_FAILED');
    return { value: keystoreData.has(key) ? keystoreData.get(key) : null };
  }),
  set: vi.fn(async ({ key, value }) => {
    if (keystore.failAll || keystore.failWrites) throw new Error('KEYSTORE_WRITE_FAILED');
    keystoreData.set(key, value);
  }),
  remove: vi.fn(async ({ key }) => {
    if (keystore.failAll) throw new Error('KEYSTORE_REMOVE_FAILED');
    keystoreData.delete(key);
  })
};
const prefs = {
  get: vi.fn(async ({ key }) => ({ value: prefsData.has(key) ? prefsData.get(key) : null })),
  set: vi.fn(async ({ key, value }) => { prefsData.set(key, value); }),
  remove: vi.fn(async ({ key }) => { prefsData.delete(key); })
};

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  isIOS: () => false,
  isAndroid: () => true
}));
// Like Capacitor's registerPlugin: a proxy that answers EVERY property with a
// native method wrapper, including `then`. Resolving a promise with it would
// call the unimplemented native "then" and never settle (regression guard).
const capacitorProxy = (impl) => new Proxy({}, {
  get: (_, prop) => (typeof prop === 'string' && typeof impl[prop] === 'function'
    ? impl[prop]
    : () => new Promise(() => {}))
});
vi.mock('@capacitor/core', () => ({ registerPlugin: (name) => capacitorProxy(name === 'SecureTokenStore' ? keystore : {}) }));
vi.mock('@capacitor/preferences', () => ({ Preferences: capacitorProxy(prefs) }));

const storage = await import('../../src/services/secureStorage');

beforeEach(() => {
  keystoreData.clear();
  prefsData.clear();
  keystore.failWrites = false;
  keystore.failAll = false;
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('secureStorage on mobile: keystore only', () => {
  it('stores and reads the token through the keystore, never through Preferences', async () => {
    expect(await storage.storeToken('jwt.abc.def')).toEqual({ success: true });
    expect(keystoreData.get('authToken')).toBe('jwt.abc.def');
    expect(prefs.set).not.toHaveBeenCalled();
    expect(await storage.getToken()).toBe('jwt.abc.def');
  });

  it('has no plaintext fallback: a keystore failure fails the save and writes nothing', async () => {
    keystore.failWrites = true;
    const result = await storage.storeToken('jwt.abc.def');
    expect(result.success).toBe(false);
    expect(prefs.set).not.toHaveBeenCalled();
    expect(prefsData.size).toBe(0);
  });

  it('a new save removes an older plaintext copy even when the keystore fails', async () => {
    prefsData.set('authToken', 'old.plain.token');
    keystore.failWrites = true;
    await storage.storeToken('new.jwt.token');
    expect(prefsData.has('authToken')).toBe(false);
  });

  it('stores user info and the refresh token in the keystore as well', async () => {
    await storage.storeUserCredentials({ id: 'u1', email: 'a@example.com' });
    await storage.storeRefreshToken('refresh.tok.en');
    expect(JSON.parse(keystoreData.get('userInfo'))).toEqual({ id: 'u1', email: 'a@example.com' });
    expect(keystoreData.get('refreshToken')).toBe('refresh.tok.en');
    expect(prefs.set).not.toHaveBeenCalled();
    expect(await storage.getUserCredentials()).toEqual({ id: 'u1', email: 'a@example.com' });
  });

  it('exposes generic getSecureItem/setSecureItem/removeSecureItem', async () => {
    expect(await storage.setSecureItem('blePairingSecret', 's3cret')).toEqual({ success: true });
    expect(await storage.getSecureItem('blePairingSecret')).toBe('s3cret');
    await storage.removeSecureItem('blePairingSecret');
    expect(await storage.getSecureItem('blePairingSecret')).toBeNull();
  });
});

describe('secureStorage on mobile: one-time migration of plaintext values', () => {
  it('copies a legacy Preferences token into the keystore, verifies it and deletes the plaintext copy', async () => {
    prefsData.set('authToken', 'legacy.jwt.token');
    expect(await storage.getToken()).toBe('legacy.jwt.token');
    expect(keystoreData.get('authToken')).toBe('legacy.jwt.token');
    expect(prefsData.has('authToken')).toBe(false);
    // Second read comes from the keystore only.
    prefs.get.mockClear();
    expect(await storage.getToken()).toBe('legacy.jwt.token');
    expect(prefs.get).not.toHaveBeenCalled();
  });

  it('keeps the legacy value (user stays signed in) when the keystore write fails, and never rewrites it', async () => {
    prefsData.set('authToken', 'legacy.jwt.token');
    keystore.failWrites = true;
    expect(await storage.getToken()).toBe('legacy.jwt.token');
    expect(prefsData.get('authToken')).toBe('legacy.jwt.token');
    expect(prefs.set).not.toHaveBeenCalled();
  });

  it('keeps the legacy value when the keystore plugin is missing entirely', async () => {
    prefsData.set('authToken', 'legacy.jwt.token');
    keystore.failAll = true;
    expect(await storage.getToken()).toBe('legacy.jwt.token');
    expect(prefsData.get('authToken')).toBe('legacy.jwt.token');
  });

  it('migrates the oldest per-field user keys', async () => {
    prefsData.set('userId', 'u7');
    prefsData.set('userEmail', 'b@example.com');
    expect(await storage.getUserCredentials()).toEqual({ userId: 'u7', email: 'b@example.com' });
    expect(prefsData.size).toBe(0);
  });

  it('sign-out removes keystore entries and every plaintext copy', async () => {
    keystoreData.set('authToken', 't');
    keystoreData.set('userInfo', '{}');
    prefsData.set('authToken', 'legacy');
    prefsData.set('userEmail', 'c@example.com');
    prefsData.set('refreshToken', 'r');
    expect(await storage.clearAllCredentials()).toEqual({ success: true });
    expect(keystoreData.size).toBe(0);
    expect(prefsData.size).toBe(0);
  });
});
