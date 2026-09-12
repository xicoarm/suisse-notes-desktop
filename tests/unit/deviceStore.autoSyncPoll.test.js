import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Automatic sync behaviour against the recorder:
//  - a busy card (device recording, card scan) or a dropped tick must NOT end
//    the polling for the session;
//  - files whose upload failed but that already sit on the phone are re-used
//    (no second Bluetooth transfer) and are left to the history auto-retry by
//    the automatic poll;
//  - a recorder bound to another installation stops the reconnect loops.
vi.mock('uuid', () => ({ v4: () => 'fresh-v4', v5: (name) => `v5:${name}` }));
vi.mock('../../src/utils/platform', () => ({ isElectron: () => false, isCapacitor: () => true, getPlatform: () => 'ios' }));
vi.mock('../../src/boot/sentry', () => ({ addBreadcrumb: () => {}, captureException: () => {}, captureMessage: () => {} }));
vi.mock('../../src/boot/i18n', () => ({ i18n: { global: { t: (k) => k } } }));
vi.mock('../../src/utils/rawOpusToOgg', () => ({ isRawOpusPackets: () => false, rawOpusToOgg: (x) => x }));
vi.mock('../../src/services/api', () => ({ getApiUrlSync: () => 'https://api.test' }));
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true }) }));

const h = vi.hoisted(() => {
  const recs = [];
  const historyMock = {
    recordings: recs,
    defaultStoragePreference: 'keep',
    async addRecording(rec) {
      const byId = recs.find((r) => r.id === rec.id) || (rec.deviceFilename && recs.find((r) => r.deviceFilename === rec.deviceFilename));
      if (byId) { const { id, ...rest } = rec; Object.assign(byId, rest); return { success: true, recording: byId }; }
      recs.push({ ...rec }); return { success: true, recording: recs[recs.length - 1] };
    },
    async updateRecording(id, updates) { const r = recs.find((x) => x.id === id); if (r) Object.assign(r, updates); return { success: true }; },
    async deleteRecording(id) { const i = recs.findIndex((x) => x.id === id); if (i >= 0) recs.splice(i, 1); return { success: true }; },
    async applyStoragePreference() { return { deleted: false }; },
    getRecordingByDeviceFilename(fn) { return recs.find((r) => r.deviceFilename === fn); },
    getRecordingById(id) { return recs.find((r) => r.id === id); }
  };
  return { recs, historyMock };
});
vi.mock('../../src/stores/recordings-history', () => ({ useRecordingsHistoryStore: () => h.historyMock }));
vi.mock('../../src/stores/meeting-prep', () => ({ useMeetingPrepStore: () => ({
  async initialize() {}, beginDeviceSyncRun() {}, endDeviceSyncRun() {}, isDeviceSyncPrepPending() { return false; }, requestDeviceSyncPrep() { return Promise.resolve({}); }
}) }));
const uploadState = vi.hoisted(() => { const s = { calls: [], result: null }; s.fn = (a) => { s.calls.push(a); return Promise.resolve(s.result); }; return s; });
vi.mock('../../src/services/upload', () => ({ uploadWithVerification: uploadState.fn }));

const ble = vi.hoisted(() => {
  const s = { downloadCalls: [], listResult: null, listError: null, connectError: null };
  s.manager = {
    downloadFile(name) { s.downloadCalls.push(name); return Promise.resolve(new Uint8Array([1, 2, 3, 4])); },
    abortDownload() {},
    getBattery: async () => 80,
    getStorage: async () => ({ FreeCapacity: 1, TotalCapacity: 2 }),
    getFileList: async () => { if (s.listError) throw s.listError; return s.listResult || []; },
    connectWithRediscovery: async () => { if (s.connectError) throw s.connectError; return { name: 'M1(BLE)', SN: 'SN1' }; },
    connect: async () => { if (s.connectError) throw s.connectError; return { name: 'M1(BLE)', SN: 'SN1' }; },
    disconnect: async () => {},
    unpair: async () => {},
    initialize: async () => {},
    onDisconnect() {}, onRecordingStateChange() {},
    deviceUuid: 'dev-uuid'
  };
  return s;
});
vi.mock('../../src/services/bleService', () => ({ getBleManager: () => ble.manager }));
vi.mock('@capacitor/preferences', () => { const m = new Map(); return { Preferences: {
  async get({ key }) { return { value: m.has(key) ? m.get(key) : null }; }, async set({ key, value }) { m.set(key, value); }, async remove({ key }) { m.delete(key); }
} }; });
const fsState = vi.hoisted(() => ({ existing: new Set() }));
vi.mock('../../src/services/storage', () => ({
  createDirectory: async () => ({ success: true }),
  writeFile: async () => ({ success: true }),
  deleteFile: async () => ({ success: true }),
  exists: async (p) => fsState.existing.has(p)
}));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: {
  checkPermissions: async () => ({ display: 'granted' }), requestPermissions: async () => ({ display: 'granted' }), schedule: async () => {}
} }));

import { useDeviceStore } from '../../src/stores/device';

const FILE = { file: 'R20260101-120000.opus', size: 4, duration_ms: 60000, creat_time: 1_750_000_000 };

describe('device store: automatic sync', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.recs.length = 0;
    uploadState.calls.length = 0;
    uploadState.result = { success: true, transcriptionId: 't1', audioFileId: 'a1' };
    ble.downloadCalls.length = 0; ble.listResult = null; ble.listError = null; ble.connectError = null;
    fsState.existing.clear();
  });

  it('a busy card does not end the polling for the session', async () => {
    const store = useDeviceStore();
    store.connectionState = 'connected';
    store._autoSyncTimer = setInterval(() => {}, 1_000_000);
    const busy = new Error('MemoryBusy'); busy.code = 'DEVICE_MEMORYBUSY';
    ble.listError = busy;
    await store._autoSyncPoll();
    expect(store._autoSyncTimer).not.toBeNull();       // still polling
    expect(store._listRefreshRequested).toBe(true);    // list asked again next tick
    expect(store.batteryLevel).toBe(80);
    clearInterval(store._autoSyncTimer);
  });

  it('the list is fetched on the first tick, then every third tick, and right after a recording stopped', async () => {
    const store = useDeviceStore();
    store.connectionState = 'connected';
    let listCalls = 0;
    ble.manager.getFileList = async () => { listCalls++; return []; };
    for (let i = 0; i < 6; i++) await store._autoSyncPoll();
    expect(listCalls).toBe(2); // ticks 1 and 4
    store._listRefreshRequested = true;
    await store._autoSyncPoll();
    expect(listCalls).toBe(3);
    ble.manager.getFileList = async () => { if (ble.listError) throw ble.listError; return ble.listResult || []; };
  });

  it('a failed upload whose file is already on the phone is re-uploaded without a second Bluetooth transfer', async () => {
    const store = useDeviceStore();
    h.recs.push({ id: 'rec-1', deviceFilename: FILE.file, uploadStatus: 'failed', filePath: 'suissenotes_recordings/' + FILE.file, prepAnswered: true, userId: 'u1' });
    fsState.existing.add('suissenotes_recordings/' + FILE.file);
    await store._downloadAndUpload(FILE);
    expect(ble.downloadCalls).toEqual([]);
    expect(uploadState.calls).toHaveLength(1);
    expect(uploadState.calls[0].filePath).toBe('suissenotes_recordings/' + FILE.file);
    expect(h.recs[0].uploadStatus).toBe('uploaded');
    expect(store.syncedFiles).toContain(FILE.file);
  });

  it('a saved copy that no longer exists falls back to a download', async () => {
    const store = useDeviceStore();
    h.recs.push({ id: 'rec-1', deviceFilename: FILE.file, uploadStatus: 'failed', filePath: 'suissenotes_recordings/gone.opus', prepAnswered: true, userId: 'u1' });
    await store._downloadAndUpload(FILE);
    expect(ble.downloadCalls).toEqual([FILE.file]);
    expect(h.recs[0].uploadStatus).toBe('uploaded');
  });

  it('the automatic poll leaves parked files to the history retry; a manual sync still takes them', async () => {
    const store = useDeviceStore();
    store.deviceFiles = [FILE, { ...FILE, file: 'R20260101-130000.opus' }, { ...FILE, file: 'R20260101-140000.opus' }];
    h.recs.push({ id: 'a', deviceFilename: FILE.file, uploadStatus: 'failed', filePath: 'suissenotes_recordings/' + FILE.file, userId: 'u1' });
    h.recs.push({ id: 'b', deviceFilename: 'R20260101-130000.opus', uploadStatus: 'failed', uploadTerminal: true, userId: 'u1' });
    expect(store._filesForAutoSync().map(f => f.file)).toEqual(['R20260101-140000.opus']);
    expect(store.autoSyncableFiles.map(f => f.file)).toHaveLength(3);
  });

  it('a zero-byte entry is skipped with a reason instead of being requested from the recorder', async () => {
    const store = useDeviceStore();
    await expect(store._downloadAndUpload({ ...FILE, size: 0 })).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    expect(ble.downloadCalls).toEqual([]);
    expect(h.recs[0].uploadStatus).toBe('skipped');
    expect(store.skippedFiles).toContain(FILE.file);
  });

  it('a recorder bound to another installation stops the reconnect loops', async () => {
    const store = useDeviceStore();
    store.pairedDevice = { deviceId: 'dev-1', uuid: 'dev-uuid', name: 'M1(BLE)', sn: 'SN1' };
    ble.connectError = new Error('Handshake failed: Device rejected pairing (already paired to another app)');
    await expect(store.autoConnect()).rejects.toThrow(/rejected pairing/);
    expect(store.connectionState).toBe('lost');
    expect(store._persistentReconnectTimer).toBeNull();
    expect(store._reconnectTimer).toBeNull();
  });
});
