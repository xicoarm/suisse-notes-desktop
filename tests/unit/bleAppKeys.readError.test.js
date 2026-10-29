import { describe, it, expect, beforeEach, vi } from 'vitest';

// T6: pairing keys are only migrated, never lost. A keystore READ failure is
// not a missing key: nothing is generated or overwritten, the error is
// surfaced and the next attempt reads the existing key again (paired
// recorders keep recognising the app).

const ks = new Map();
const prefs = new Map();
const fail = vi.hoisted(() => ({ reads: 0 }));
const keystore = {
  get: vi.fn(async ({ key }) => {
    if (fail.reads > 0) { fail.reads--; throw new Error('KEYSTORE_READ_FAILED'); }
    return { value: ks.has(key) ? ks.get(key) : null };
  }),
  set: vi.fn(async ({ key, value }) => { ks.set(key, value); }),
  remove: vi.fn(async ({ key }) => { ks.delete(key); })
};
const preferences = {
  get: vi.fn(async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null })),
  set: vi.fn(async ({ key, value }) => { prefs.set(key, value); }),
  remove: vi.fn(async ({ key }) => { prefs.delete(key); })
};
const proxy = (impl) => new Proxy({}, {
  get: (_, prop) => (typeof prop === 'string' && typeof impl[prop] === 'function' ? impl[prop] : () => new Promise(() => {}))
});
vi.mock('@capacitor/core', () => ({ registerPlugin: (name) => proxy(name === 'SecureTokenStore' ? keystore : {}) }));
vi.mock('@capacitor/preferences', () => ({ Preferences: proxy(preferences) }));
vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isIOS: () => false, isAndroid: () => true, getPlatform: () => 'android'
}));

const { loadAppKeys } = await import('../../src/services/bleAppKeys');

const INSTALL = '11111111-2222-4333-8444-555555555555';
const LEGACY = '66666666-7777-4888-9999-aaaaaaaaaaaa';

beforeEach(() => {
  ks.clear();
  prefs.clear();
  fail.reads = 0;
  vi.clearAllMocks();
});

describe('pairing keys: a keystore read error is not a missing key', () => {
  it('one failed read of the install key: error surfaced, nothing generated or overwritten, next attempt reads it', async () => {
    ks.set('ble.appKey.install', INSTALL);
    fail.reads = 1;
    await expect(loadAppKeys({ userId: 'u1', isNative: true })).rejects.toMatchObject({ code: 'BLE_SECRET_STORE_UNAVAILABLE' });
    expect(keystore.set).not.toHaveBeenCalled();
    expect(ks.get('ble.appKey.install')).toBe(INSTALL);
    expect((await loadAppKeys({ userId: 'u1', isNative: true })).install).toBe(INSTALL);
  });

  it('a failed read of the legacy key never migrates over it, and the plaintext copy stays', async () => {
    ks.set('ble.appKey.install', INSTALL);
    ks.set('ble.appKey.legacy', LEGACY);
    prefs.set('ble_app_uuid', '99999999-8888-4777-8666-555555555555');
    keystore.get.mockImplementationOnce(async ({ key }) => ({ value: ks.get(key) })) // install ok
      .mockImplementationOnce(async () => { throw new Error('KEYSTORE_READ_FAILED'); }); // legacy fails
    await expect(loadAppKeys({ userId: 'u1', isNative: true })).rejects.toMatchObject({ code: 'BLE_SECRET_STORE_UNAVAILABLE' });
    expect(keystore.set).not.toHaveBeenCalled();
    expect(ks.get('ble.appKey.legacy')).toBe(LEGACY);
    expect(prefs.has('ble_app_uuid')).toBe(true);
    const keys = await loadAppKeys({ userId: 'u1', isNative: true });
    expect(keys).toMatchObject({ install: INSTALL, legacy: LEGACY });
  });

  it('a really missing install key is still created once', async () => {
    const keys = await loadAppKeys({ userId: 'u1', isNative: true });
    expect(keys.install).toMatch(/^[0-9a-f-]{36}$/);
    expect(ks.get('ble.appKey.install')).toBe(keys.install);
  });
});
