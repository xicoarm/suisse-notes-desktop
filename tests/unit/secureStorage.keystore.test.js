import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mobile (Capacitor) path of src/services/secureStorage.js: the session token
// lives in the platform keystore (native SecureTokenStore plugin), never in
// plaintext Preferences. Plaintext values of older versions are never
// adopted, only deleted (review 10/2026, option C).

const keystoreData = new Map();
const prefsData = new Map();
// Key rule of both native plugins (iOS and Android reject with INVALID_KEY).
const checkKey = (key) => {
  if (typeof key !== 'string' || key.length < 1 || key.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error('INVALID_KEY');
};
const keystore = {
  failWrites: false,
  failAll: false,
  get: vi.fn(async ({ key }) => {
    checkKey(key);
    if (keystore.failAll) throw new Error('KEYSTORE_READ_FAILED');
    return { value: keystoreData.has(key) ? keystoreData.get(key) : null };
  }),
  set: vi.fn(async ({ key, value }) => {
    checkKey(key);
    if (keystore.failAll || keystore.failWrites) throw new Error('KEYSTORE_WRITE_FAILED');
    keystoreData.set(key, value);
  }),
  remove: vi.fn(async ({ key }) => {
    checkKey(key);
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

let storage;
let authority;
const RECORD = 'auth.session.v1';

// Token and user are written only by the session authority (E2).
const signIn = (token, user) => authority.applySession(authority.sessionTicket(), { token, user }, { kind: 'login' });
const restart = async () => {
  vi.resetModules();
  storage = await import('../../src/services/secureStorage');
  authority = await import('../../src/services/sessionAuthority');
};

beforeEach(async () => {
  keystoreData.clear();
  prefsData.clear();
  localStorage.clear();
  keystore.failWrites = false;
  keystore.failAll = false;
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await restart();
});

describe('secureStorage on mobile: keystore only', () => {
  it('stores and reads the token through the keystore, never through Preferences', async () => {
    expect(await signIn('jwt.abc.def', { id: 'u1' })).toMatchObject({ applied: true, persisted: true });
    expect(keystoreData.get('authToken')).toBe('jwt.abc.def');
    expect(prefs.set).not.toHaveBeenCalled();
    expect(await storage.getToken()).toBe('jwt.abc.def');
  });

  it('has no plaintext fallback: a keystore failure fails the save and writes nothing', async () => {
    keystore.failWrites = true;
    const result = await signIn('jwt.abc.def', { id: 'u1' });
    expect(result).toMatchObject({ applied: true, persisted: false });
    expect(prefs.set).not.toHaveBeenCalled();
    expect(prefsData.size).toBe(0);
    expect(keystoreData.size).toBe(0);
  });

  it('a failed save keeps the previous keystore value (T4)', async () => {
    keystoreData.set('authToken', 'old.jwt.token');
    keystore.failWrites = true;
    expect((await storage.setSecureItem('authToken', 'new.jwt.token')).success).toBe(false);
    expect(keystoreData.get('authToken')).toBe('old.jwt.token');
  });

  it('never returns a plaintext Preferences value (T1), also when the keystore fails', async () => {
    prefsData.set('authToken', 'legacy.jwt.token');
    expect(await storage.getToken()).toBeNull();
    keystore.failAll = true;
    expect(await storage.getToken()).toBeNull();
    expect(keystoreData.has('authToken')).toBe(false);
    expect(prefs.set).not.toHaveBeenCalled();
  });

  it('E6: while signed out a token left in the keystore is never returned', async () => {
    keystoreData.set('authToken', 'k.jwt.token');
    keystoreData.set('userInfo', JSON.stringify({ id: 'u1' }));
    localStorage.setItem(RECORD, JSON.stringify({ epoch: 4, signedOut: true }));
    expect(await storage.getToken()).toBeNull();
    expect(await storage.getUserCredentials()).toEqual({});
  });

  it('stores user info in the keystore as well', async () => {
    await signIn('jwt.abc.def', { id: 'u1', email: 'a@example.com' });
    expect(JSON.parse(keystoreData.get('userInfo'))).toEqual({ id: 'u1', email: 'a@example.com' });
    expect(prefs.set).not.toHaveBeenCalled();
    expect(await storage.getUserCredentials()).toEqual({ id: 'u1', email: 'a@example.com' });
  });

  it('a key the native plugins reject fails the save (nothing in plaintext)', async () => {
    expect((await storage.setSecureItem('ble.appKey.legacyScoped:u1', 'x')).success).toBe(false);
    expect(prefs.set).not.toHaveBeenCalled();
  });

  it('exposes generic getSecureItem/setSecureItem/removeSecureItem', async () => {
    expect(await storage.setSecureItem('blePairingSecret', 's3cret')).toEqual({ success: true });
    expect(await storage.getSecureItem('blePairingSecret')).toBe('s3cret');
    await storage.removeSecureItem('blePairingSecret');
    expect(await storage.getSecureItem('blePairingSecret')).toBeNull();
  });
});

describe('secureStorage on mobile: read-back', () => {
  it('a read-back mismatch fails the save and puts the previous value back (T4)', async () => {
    keystoreData.set('authToken', 'old.jwt.token');
    keystore.get
      .mockImplementationOnce(async ({ key }) => ({ value: keystoreData.get(key) })) // previous value
      .mockResolvedValueOnce({ value: 'something.else' }); // read-back
    expect((await storage.setSecureItem('authToken', 'new.jwt.token')).success).toBe(false);
    expect(keystoreData.get('authToken')).toBe('old.jwt.token');
  });

  it('a read-back mismatch without a previous value leaves no value behind', async () => {
    keystore.get
      .mockResolvedValueOnce({ value: null })
      .mockResolvedValueOnce({ value: 'something.else' });
    expect((await storage.setSecureItem('authToken', 'new.jwt.token')).success).toBe(false);
    expect(keystoreData.has('authToken')).toBe(false);
  });

  it('a successful sign-in never touches Preferences', async () => {
    prefsData.set('authToken', 'old.plain.token');
    expect(await signIn('new.jwt.token', { id: 'u1' })).toMatchObject({ applied: true, persisted: true });
    expect(prefs.set).not.toHaveBeenCalled();
    expect(prefs.get).not.toHaveBeenCalled();
  });
});

describe('secureStorage on mobile: plaintext copies of older versions are deleted, never adopted', () => {
  it('every start deletes the five auth keys from Preferences (T2), pairing keys stay (T6)', async () => {
    for (const k of ['authToken', 'refreshToken', 'userId', 'userEmail', 'userInfo']) prefsData.set(k, `legacy-${k}`);
    prefsData.set('ble_app_uuid', 'pairing-uuid');
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    expect([...prefsData.keys()]).toEqual(['ble_app_uuid']);
    // No auth key in the keystore; only the one-time migration mark (E1 addendum, round 7).
    expect([...keystoreData.keys()]).toEqual(['auth.sessionMigrated']);
    expect(prefs.set).not.toHaveBeenCalled();
  });

  it('a delete that get() does not confirm is not done: the next start tries again', async () => {
    prefsData.set('authToken', 'legacy.jwt.token');
    prefs.remove.mockImplementationOnce(async () => { throw new Error('PREFS_UNAVAILABLE'); });
    expect(await storage.purgeLegacyAuthPreferences()).toBe(false);
    expect(prefsData.get('authToken')).toBe('legacy.jwt.token');
    await restart();
    expect(await storage.purgeLegacyAuthPreferences()).toBe(true);
    expect(prefsData.has('authToken')).toBe(false);
  });

  it('a keystore session survives the start; the plaintext copy next to it is deleted', async () => {
    localStorage.setItem(RECORD, JSON.stringify({ epoch: 3, signedOut: false }));
    keystoreData.set('authToken', 'k.jwt.token');
    keystoreData.set('userInfo', JSON.stringify({ id: 'u1' }));
    prefsData.set('authToken', 'old.plain.token');
    expect(await authority.loadSession()).toEqual({ signedOut: false, token: 'k.jwt.token', user: { id: 'u1' }, epoch: 3 });
    expect(prefsData.size).toBe(0);
  });

  it('the oldest per-field user keys are never adopted', async () => {
    prefsData.set('userId', 'u7');
    prefsData.set('userEmail', 'b@example.com');
    expect(await storage.getUserCredentials()).toEqual({});
  });

  it('sign-out writes the tombstone first, then removes keystore entries and plaintext copies', async () => {
    await signIn('t.jwt.x', { id: 'u1' });
    prefsData.set('authToken', 'legacy');
    prefsData.set('userEmail', 'c@example.com');
    prefsData.set('refreshToken', 'r');
    vi.clearAllMocks();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    expect(await authority.signOut()).toMatchObject({ success: true });
    expect(setItem).toHaveBeenCalledWith(RECORD, expect.stringContaining('"signedOut":true'));
    expect(setItem.mock.invocationCallOrder[0]).toBeLessThan(keystore.remove.mock.invocationCallOrder[0]);
    expect(keystoreData.size).toBe(0);
    expect(prefsData.size).toBe(0);
    setItem.mockRestore();
  });

  it('sign-out with a failing keystore remove: reported, and the next start restores nothing (T5)', async () => {
    await signIn('k.jwt.token', { id: 'u1' });
    keystore.remove.mockImplementation(async () => { throw new Error('KEYSTORE_REMOVE_FAILED'); });
    expect((await authority.signOut()).success).toBe(false);
    expect(keystoreData.get('authToken')).toBe('k.jwt.token');
    expect(await storage.getToken()).toBeNull();
    await restart();
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    expect(await storage.getToken()).toBeNull();
    keystore.remove.mockReset();
    keystore.remove.mockImplementation(async ({ key }) => { checkKey(key); keystoreData.delete(key); });
  });

  it('the previous version\'s marker counts as signed out; only a stored login clears it', async () => {
    localStorage.setItem(RECORD, JSON.stringify({ epoch: 2, signedOut: false }));
    localStorage.setItem('auth.signedOut', '1');
    keystoreData.set('authToken', 'k.jwt.token');
    keystoreData.set('userInfo', JSON.stringify({ id: 'u1' }));
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    keystore.failWrites = true;
    expect((await signIn('n.jwt.token', { id: 'u1' })).persisted).toBe(false);
    expect(localStorage.getItem('auth.signedOut')).toBe('1');
    await restart();
    expect(await authority.loadSession()).toEqual({ signedOut: true });
    keystore.failWrites = false;
    expect((await signIn('n.jwt.token', { id: 'u1' })).persisted).toBe(true);
    expect(localStorage.getItem('auth.signedOut')).toBeNull();
    await restart();
    expect(await authority.loadSession()).toMatchObject({ signedOut: false, token: 'n.jwt.token', user: { id: 'u1' } });
  });
});
