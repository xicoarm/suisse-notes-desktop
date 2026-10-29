import { describe, it, expect, beforeEach, vi } from 'vitest';

// Security of the Bluetooth recorder link (device data is untrusted):
//  - a recorder-reported file name never becomes part of a local path
//    (path traversal into shared_prefs / other app files);
//  - mobile writes and deletes are confined to the app's storage roots;
//  - transfers and lists have size / count limits;
//  - format / delete on the recorder need an explicit confirmation;
//  - the pairing key is random per install (keystore), the old user-derived
//    UUID is only offered where it reveals nothing, and a pinned recorder
//    must present its protocol UUID before any key is sent.

const fsState = vi.hoisted(() => ({ writes: [], deletes: [], mkdirs: [], rmdirs: [] }));

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  isAndroid: () => true,
  isIOS: () => false,
  getPlatform: () => 'android',
  PlatformConstants: { CRITICAL_STORAGE_MB: 100, MIN_STORAGE_MB: 500 }
}));
vi.mock('../../src/boot/sentry', () => ({ addBreadcrumb: () => {}, captureException: () => {}, captureMessage: () => {} }));
vi.mock('../../src/boot/i18n', () => ({ i18n: { global: { t: (k) => k } } }));
vi.mock('../../src/utils/rawOpusToOgg', () => ({ isRawOpusPackets: () => false, rawOpusToOgg: (x) => x }));
vi.mock('../../src/services/api', () => ({ getApiUrlSync: () => 'https://api.test' }));
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true }) }));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { External: 'EXTERNAL', Documents: 'DOCUMENTS', Cache: 'CACHE' },
  Filesystem: {
    stat: async ({ path }) => {
      const w = fsState.writes.find((x) => x.path === path);
      if (w) return { type: 'file', size: w.size };
      throw new Error('File does not exist');
    },
    writeFile: async ({ path, data, directory }) => { fsState.writes.push({ path, directory, size: Math.floor(data.length * 3 / 4) }); return { uri: 'x' }; },
    deleteFile: async ({ path, directory }) => { fsState.deletes.push({ path, directory }); },
    mkdir: async ({ path, directory }) => { fsState.mkdirs.push({ path, directory }); },
    rmdir: async ({ path, directory }) => { fsState.rmdirs.push({ path, directory }); }
  }
}));

const prefs = vi.hoisted(() => new Map());
vi.mock('@capacitor/preferences', () => ({ Preferences: {
  async get({ key }) { return { value: prefs.has(key) ? prefs.get(key) : null }; },
  async set({ key, value }) { prefs.set(key, value); },
  async remove({ key }) { prefs.delete(key); }
} }));
// Behaves like src/services/secureStorage.js over the native plugins: both
// reject keys outside ^[A-Za-z0-9_.-]{1,128}$ (INVALID_KEY); the JS layer
// turns that into { success: false } / null.
const vault = vi.hoisted(() => ({ map: new Map(), failWrites: false, rejectedKeys: [] }));
const nativeKeyOk = (k) => typeof k === 'string' && k.length >= 1 && k.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(k);
vi.mock('../../src/services/secureStorage', () => ({
  getSecureItem: async (k) => {
    if (!nativeKeyOk(k)) { vault.rejectedKeys.push(k); return null; }
    return vault.map.has(k) ? vault.map.get(k) : null;
  },
  setSecureItem: async (k, v) => {
    if (!nativeKeyOk(k)) { vault.rejectedKeys.push(k); return { success: false, error: 'INVALID_KEY' }; }
    if (vault.failWrites) return { success: false };
    vault.map.set(k, v);
    return { success: true };
  },
  removeSecureItem: async (k) => {
    if (!nativeKeyOk(k)) { vault.rejectedKeys.push(k); return { success: false, error: 'INVALID_KEY' }; }
    vault.map.delete(k);
    return { success: true };
  }
}));

const h = vi.hoisted(() => {
  const recs = [];
  return {
    recs,
    historyMock: {
      recordings: recs,
      defaultStoragePreference: 'keep',
      async addRecording(rec) {
        const hit = recs.find((r) => r.id === rec.id);
        if (hit) { Object.assign(hit, rec); return { success: true, recording: hit }; }
        recs.push({ ...rec }); return { success: true, recording: recs[recs.length - 1] };
      },
      async updateRecording(id, u) { const r = recs.find((x) => x.id === id); if (r) Object.assign(r, u); return { success: true }; },
      async deleteRecording() { return { success: true }; },
      async applyStoragePreference() { return { deleted: false }; },
      getRecordingByDeviceFilename(fn) { return recs.find((r) => r.deviceFilename === fn); },
      getRecordingById(id) { return recs.find((r) => r.id === id); }
    }
  };
});
vi.mock('../../src/stores/recordings-history', () => ({ useRecordingsHistoryStore: () => h.historyMock }));
vi.mock('../../src/services/upload', () => ({ uploadWithVerification: async () => ({ success: true, verified: true }) }));

const ble = vi.hoisted(() => {
  const s = { connectCalls: [], downloadCalls: [], formatCalls: 0, connectImpl: null };
  s.manager = {
    deviceUuid: 'dev-uuid',
    connect: async (id, key, opts) => { s.connectCalls.push({ id, key, opts }); return s.connectImpl ? s.connectImpl(id, key, opts) : { name: 'M1', SN: 'SN1' }; },
    connectWithRediscovery: async (id, key, opts) => { s.connectCalls.push({ id, key, opts }); return { name: 'M1', SN: 'SN1' }; },
    downloadFile: async (name) => { s.downloadCalls.push(name); return new Uint8Array([1, 2, 3, 4]); },
    getBattery: async () => 80,
    getStorage: async () => ({ FreeCapacity: 1, TotalCapacity: 2 }),
    getFileList: async () => s.list || [],
    formatDevice: async () => { s.formatCalls++; return true; },
    unpair: async () => {},
    disconnect: async () => {},
    abortDownload() {},
    initialize: async () => {},
    onDisconnect() {}, onRecordingStateChange() {}
  };
  return s;
});
vi.mock('../../src/services/bleService', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, getBleManager: () => ble.manager };
});

import {
  isConfinedPath,
  normalizeDeviceFileEntry,
  localPathForDeviceFile,
  isSafeDeviceFilename,
  MAX_DEVICE_FILE_COUNT
} from '../../src/utils/deviceFileSafety';
import * as storage from '../../src/services/storage';
import { BleDeviceManager, crc16Compute } from '../../src/services/bleService';
import { loadAppKeys, keyForRecord, userAppUuid, secureScopedKey } from '../../src/services/bleAppKeys';
import { useDeviceStore } from '../../src/stores/device';
import { setActivePinia, createPinia } from 'pinia';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOSTILE_NAMES = [
  '../recordings/x.opus',
  '../../shared_prefs/CapWebViewSettings.xml',
  '/data/data/ch.suissenotes.app/shared_prefs/x.xml',
  '..\\x',
  '%2e%2e/x',
  'R20260101-120000.opus/../../x',
  'R20260101-120000.opus\u0000.xml',
  'R20260101-120000.OPUS.xml',
  'file:///etc/hosts'
];

describe('device file names and local paths', () => {
  it('accepts only the recorder naming scheme', () => {
    expect(isSafeDeviceFilename('R20260101-120000.opus')).toBe(true);
    expect(isSafeDeviceFilename('R20260101-120000.wav')).toBe(true);
    for (const n of HOSTILE_NAMES) expect(isSafeDeviceFilename(n)).toBe(false);
    expect(isSafeDeviceFilename('R20260101-120000.exe')).toBe(false);
    expect(isSafeDeviceFilename(42)).toBe(false);
  });

  it('marks hostile list entries unsafe and keeps only a sanitized display name', () => {
    for (const n of HOSTILE_NAMES) {
      const e = normalizeDeviceFileEntry({ file: n, size: 10, creat_time: 1, extra: '<x>' });
      expect(e.unsafe).toBe(true);
      expect(e.file).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(e.file).not.toContain('/');
      expect(e).not.toHaveProperty('extra');
    }
    const ok = normalizeDeviceFileEntry({ file: 'R20260101-120000.opus', size: '10', creat_time: 5 });
    expect(ok.unsafe).toBeUndefined();
    expect(ok.size).toBe(0); // non-number size is not trusted
    expect(normalizeDeviceFileEntry({ file: 'R20260101-120000.opus', size: 2 * 1024 ** 3 }).unsafe).toBe(true);
  });

  it('builds the local path from a fresh UUID, never from the device name', () => {
    const a = localPathForDeviceFile('R20260101-120000.opus');
    const b = localPathForDeviceFile('R20260101-120000.opus');
    expect(a).toMatch(/^suissenotes_recordings\/[0-9a-f-]{36}\.opus$/);
    expect(a.split('/')[1].replace('.opus', '')).toMatch(UUID_RE);
    expect(a).not.toBe(b);
    expect(a).not.toContain('R20260101');
    expect(localPathForDeviceFile('R20260101-120000.wav')).toMatch(/\.wav$/);
    for (const n of HOSTILE_NAMES) expect(() => localPathForDeviceFile(n)).toThrow(/cannot be processed safely/);
  });

  it('confines paths to the app storage roots', () => {
    expect(isConfinedPath('recordings/abc/combined.m4a')).toBe(true);
    expect(isConfinedPath('suissenotes_recordings/R20260101-120000.opus')).toBe(true); // legacy record
    for (const p of [
      'suissenotes_recordings/../shared_prefs/CapWebViewSettings.xml',
      'suissenotes_recordings/../../shared_prefs/x.xml',
      '/data/data/x', 'recordings/..\\x', 'recordings/%2e%2e/x', 'recordings/./x',
      'recordings//x', 'shared_prefs/x.xml', '', 'recordings/a\u0000b', 'file:///x', '~/x', 'C:/x', null
    ]) expect(isConfinedPath(p)).toBe(false);
  });
});

describe('storage refuses writes and deletes outside the app roots (mobile)', () => {
  beforeEach(() => { fsState.writes.length = 0; fsState.deletes.length = 0; fsState.mkdirs.length = 0; fsState.rmdirs.length = 0; });

  it('nothing reaches the filesystem for a traversal path', async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    // (a merely odd name without traversal, e.g. "x.OPUS.xml", would stay
    // inside the folder; the store never builds such a path anyway)
    for (const n of HOSTILE_NAMES.filter((x) => x !== 'R20260101-120000.OPUS.xml')) {
      const path = `suissenotes_recordings/${n}`;
      expect((await storage.writeFile(path, data)).success).toBe(false);
      expect((await storage.deleteFile(path)).success).toBe(false);
      expect((await storage.createDirectory(path)).success).toBe(false);
      expect((await storage.deleteDirectory(path)).success).toBe(false);
      expect((await storage.writeFile(n, data)).code).toBe('PATH_NOT_CONFINED');
    }
    expect((await storage.writeFile('R20260101-120000.OPUS.xml', data)).code).toBe('PATH_NOT_CONFINED');
    expect(fsState.writes).toEqual([]);
    expect(fsState.deletes).toEqual([]);
    expect(fsState.mkdirs).toEqual([]);
    expect(fsState.rmdirs).toEqual([]);
  });

  it('confined paths still work (existing recordings keep working)', async () => {
    const res = await storage.writeFile('suissenotes_recordings/0b4e2a52-1d2f-4c3a-9b1e-2f3a4b5c6d7e.opus', new Uint8Array([1, 2, 3, 4]).buffer);
    expect(res.success).toBe(true);
    expect((await storage.deleteFile('suissenotes_recordings/R20260101-120000.opus')).success).toBe(true);
    expect(fsState.writes.map((w) => w.path)).toEqual(['suissenotes_recordings/0b4e2a52-1d2f-4c3a-9b1e-2f3a4b5c6d7e.opus']);
  });
});

describe('device store: hostile recorder list', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.recs.length = 0;
    fsState.writes.length = 0; fsState.deletes.length = 0; fsState.mkdirs.length = 0;
    ble.downloadCalls.length = 0;
  });

  it('never downloads or writes an unsafe entry; a valid one is stored under a UUID', async () => {
    const store = useDeviceStore();
    store.connectionState = 'connected';
    store.pairedDevice = { deviceId: 'dev-1', uuid: 'dev-uuid', sn: 'SN1' };
    store.deviceSN = 'SN1';
    ble.list = [
      ...HOSTILE_NAMES.map((file) => ({ file, size: 4, creat_time: 1 })),
      { file: 'R20260101-120000.opus', size: 4, creat_time: 2 }
    ];
    await store.fetchFileList();
    expect(store.unsafeDeviceFiles).toHaveLength(HOSTILE_NAMES.length);
    expect(store.autoSyncableFiles.map((f) => f.file)).toEqual(['R20260101-120000.opus']);
    expect(store.newFiles.map((f) => f.file)).toEqual(['R20260101-120000.opus']);

    for (const f of store.unsafeDeviceFiles) {
      await expect(store.syncFile(f)).rejects.toMatchObject({ code: 'UNSAFE_FILENAME' });
    }
    // Even a raw hostile entry handed straight to the pipeline is refused.
    await expect(store._downloadAndUpload({ file: '../../shared_prefs/CapWebViewSettings.xml', size: 4 }))
      .rejects.toMatchObject({ code: 'UNSAFE_FILENAME' });
    expect(ble.downloadCalls).toEqual([]);

    await store.syncFile(store.autoSyncableFiles[0]);
    expect(ble.downloadCalls).toEqual(['R20260101-120000.opus']);
    expect(fsState.writes).toHaveLength(1);
    const written = fsState.writes[0].path;
    expect(written).toMatch(/^suissenotes_recordings\/[0-9a-f-]{36}\.opus$/);
    expect(written.split('/')[1].slice(0, 36)).toMatch(UUID_RE);
    const rec = h.recs.find((r) => r.deviceFilename === 'R20260101-120000.opus');
    expect(rec.filePath).toBe(written);
  });

  it('format requires the explicit confirmation token', async () => {
    const store = useDeviceStore();
    store.connectionState = 'connected';
    ble.formatCalls = 0;
    await expect(store.resetDevice()).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(store.resetDevice({ confirmed: 'yes' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(ble.formatCalls).toBe(0);
    await store.resetDevice({ confirmed: true });
    expect(ble.formatCalls).toBe(1);
  });
});

// ---- protocol-level limits (real BleDeviceManager, scripted device) --------

const enc = (s) => Array.from(new TextEncoder().encode(s));
function attachDevice(m, handlers) {
  const writes = [];
  m.deviceId = 'dev-1';
  m.connected = true;
  m.ble = {
    writeWithoutResponse: async (_id, _svc, _chr, dv) => {
      const bytes = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      writes.push(bytes);
      const fn = handlers[bytes[1]];
      const frames = fn ? fn(bytes.slice(3), bytes) : [];
      setTimeout(() => {
        for (const f of frames) {
          const u8 = Uint8Array.from(f);
          m._onNotify(new DataView(u8.buffer, u8.byteOffset, u8.byteLength));
        }
      }, 0);
    }
  };
  return writes;
}
const syncEcho = (p) => [[0x01, 0x74, 0x00, ...p]];

describe('BleDeviceManager limits and confirmations', () => {
  let m;
  beforeEach(() => { m = new BleDeviceManager(); });

  it('rejects a file list that claims more than the cap', async () => {
    attachDevice(m, { 0x74: syncEcho, 0x1B: () => [[0x01, 0x1B, 0x00, ...enc(JSON.stringify({ FileNum: MAX_DEVICE_FILE_COUNT + 1 }))]] });
    await expect(m.getFileList()).rejects.toMatchObject({ code: 'LIST_TOO_LARGE' });
  });

  it('refuses a download without a valid announced size', async () => {
    attachDevice(m, { 0x74: syncEcho });
    await expect(m.downloadFile('R20260101-120000.opus', null, 0)).rejects.toMatchObject({ code: 'UNSAFE_SIZE' });
    await expect(m.downloadFile('R20260101-120000.opus', null, 5 * 1024 ** 3)).rejects.toMatchObject({ code: 'UNSAFE_SIZE' });
  });

  it('aborts a transfer that sends more than announced + one frame', async () => {
    const frame = (i) => [0x02, 0x1C, 0x00, (i >> 8) & 0xFF, i & 0xFF, ...new Array(100).fill(7)];
    const data = new Uint8Array(1000).fill(7);
    const crc = crc16Compute(data);
    attachDevice(m, {
      0x74: syncEcho,
      0x1C: () => [...Array.from({ length: 10 }, (_, i) => frame(i)), [0x01, 0x1D, 0x00, crc & 0xFF, (crc >> 8) & 0xFF]]
    });
    // announced 300 bytes, device streams 1000
    await expect(m.downloadFile('R20260101-120000.opus', null, 300)).rejects.toMatchObject({ code: 'SIZE_EXCEEDED' });
  });

  it('format and delete refuse without confirmation and send nothing', async () => {
    const writes = attachDevice(m, { 0x68: () => [[0x01, 0x68, 0x00, 0x00]], 0x1E: () => [[0x01, 0x1E, 0x00, 0x01]] });
    await expect(m.formatDevice()).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(m.deleteFile('R20260101-120000.opus')).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(writes).toEqual([]);
    await expect(m.formatDevice({ confirmed: true })).resolves.toBe(true);
    expect(writes.map((w) => w[1])).toEqual([0x68]);
  });

  it('a pinned recorder with another protocol UUID never receives the key', async () => {
    const writes = attachDevice(m, {});
    const step1 = [0x01, 0x01, 0x00, 0x00, ...enc(JSON.stringify({ uuid: 'look-alike' }))];
    setTimeout(() => { const u8 = Uint8Array.from(step1); m._onNotify(new DataView(u8.buffer)); }, 0);
    await expect(m._handshake('secret-key', { expectedDeviceUuid: 'dev-uuid' })).rejects.toMatchObject({ code: 'BLE_DEVICE_MISMATCH' });
    expect(writes).toEqual([]); // step 2 (which carries the key) was never written
    expect(writes.flat().join(',')).not.toContain(enc('secret-key').join(','));
  });
});

// ---- pairing keys ----------------------------------------------------------

describe('pairing keys', () => {
  beforeEach(() => {
    prefs.clear();
    vault.map.clear();
    vault.failWrites = false;
    vault.rejectedKeys.length = 0;
    setActivePinia(createPinia());
    ble.connectCalls.length = 0;
    ble.connectImpl = null;
  });

  it('a fresh install gets a random key in secure storage, not the user-derived one', async () => {
    const keys = await loadAppKeys({ userId: 'u1', isNative: true });
    expect(keys.install).toMatch(UUID_RE);
    expect(keys.install).not.toBe(userAppUuid('u1'));
    expect(vault.map.get('ble.appKey.install')).toBe(keys.install);
    expect([...prefs.keys()].filter((k) => k.startsWith('ble_app_uuid'))).toEqual([]);
    const again = await loadAppKeys({ userId: 'u1', isNative: true });
    expect(again.install).toBe(keys.install);
  });

  it('the per-user scoped key of the migration period is stored under a key both native plugins accept', async () => {
    const scoped = '99999999-2222-4333-8444-555555555555';
    const install = '11111111-2222-4333-8444-555555555555';
    for (const userId of ['u1', 'user:with:colons', 'ü/ä 42']) {
      prefs.clear();
      vault.map.clear();
      prefs.set('ble_app_uuid', install);
      prefs.set(`ble_app_uuid:u${userId}`, scoped);
      const keys = await loadAppKeys({ userId, isNative: true });
      expect(keys.legacyScoped).toBe(scoped);
      const scopedKey = await secureScopedKey(userId);
      expect(scopedKey).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      expect(vault.map.get(scopedKey)).toBe(scoped);
      // Migration complete: the plaintext copies are gone.
      expect(prefs.has(`ble_app_uuid:u${userId}`)).toBe(false);
      expect(prefs.has('ble_app_uuid')).toBe(false);
    }
    expect(vault.rejectedKeys).toEqual([]);
  });

  it('migrates the plaintext UUID of earlier versions once and removes the plaintext copy', async () => {
    const old = '11111111-2222-4333-8444-555555555555';
    prefs.set('ble_app_uuid', old);
    const keys = await loadAppKeys({ userId: 'u1', isNative: true });
    expect(keys.legacy).toBe(old);
    expect(vault.map.get('ble.appKey.legacy')).toBe(old);
    expect(prefs.has('ble_app_uuid')).toBe(false);
    // A record paired before this version (no keyKind) keeps the old key.
    expect(keyForRecord({ deviceId: 'd', uuid: 'x' }, keys, 'u1')).toBe(old);
    expect(keyForRecord({ deviceId: 'd', uuid: 'x', keyKind: 'install' }, keys, 'u1')).toBe(keys.install);
  });

  it('keeps the plaintext copy when the keystore cannot store it, and refuses to create a key without it', async () => {
    prefs.set('ble_app_uuid', '11111111-2222-4333-8444-555555555555');
    vault.failWrites = true;
    await expect(loadAppKeys({ userId: 'u1', isNative: true })).rejects.toMatchObject({ code: 'BLE_SECRET_STORE_FAILED' });
    expect(prefs.has('ble_app_uuid')).toBe(true);
  });

  it('an already-paired recorder reconnects with its old key and must present its pinned UUID', async () => {
    const old = '11111111-2222-4333-8444-555555555555';
    prefs.set('ble_app_uuid', old);
    const store = useDeviceStore();
    store.pairedDevice = { deviceId: 'dev-1', uuid: 'dev-uuid', name: 'M1', sn: 'SN1' };
    await store.autoConnect();
    expect(ble.connectCalls).toHaveLength(1);
    expect(ble.connectCalls[0].key).toBe(old);
    expect(ble.connectCalls[0].opts.expectedDeviceUuid).toBe('dev-uuid');
  });

  it('an unknown recorder that rejects us only gets the public user-derived UUID, never an older secret', async () => {
    const old = '11111111-2222-4333-8444-555555555555';
    prefs.set('ble_app_uuid', old);
    ble.connectImpl = (id, key) => {
      if (key === userAppUuid('u1')) return { name: 'M1', SN: 'SN9' };
      throw new Error('Handshake failed: Device rejected pairing (already paired to another app)');
    };
    const store = useDeviceStore();
    await store.connectAndPair('other-dev');
    const keysSent = ble.connectCalls.map((c) => c.key);
    expect(keysSent).not.toContain(old);
    expect(keysSent).toEqual([vault.map.get('ble.appKey.install'), userAppUuid('u1')]);
    expect(store.pairedDevice.keyKind).toBe('derived');
    expect(ble.connectCalls.every((c) => c.opts.expectedDeviceUuid === null)).toBe(true);
  }, 10000);

  it('a pinned recorder may be offered the older keys, always with the UUID check', async () => {
    const old = '11111111-2222-4333-8444-555555555555';
    prefs.set('ble_app_uuid', old);
    const store = useDeviceStore();
    store.pairedDevice = { deviceId: 'dev-1', uuid: 'dev-uuid', name: 'M1', sn: 'SN1', keyKind: 'install' };
    ble.connectImpl = (id, key) => {
      if (key === old) return { name: 'M1', SN: 'SN1' };
      throw new Error('Handshake failed: Device rejected pairing (already paired to another app)');
    };
    await store.connectAndPair('dev-1');
    expect(ble.connectCalls.map((c) => c.key)).toEqual([vault.map.get('ble.appKey.install'), old]);
    expect(ble.connectCalls.every((c) => c.opts.expectedDeviceUuid === 'dev-uuid')).toBe(true);
    expect(store.pairedDevice.keyKind).toBe('legacy');
  }, 10000);
});
