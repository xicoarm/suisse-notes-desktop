import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Forgetting or disconnecting a recorder must clear everything that draws the
// "transferring" indicator, even when a sync or an auto-sync poll is running:
// the run goes stale, stops advancing, records no failure, and no phantom
// "sync complete" notification fires. It must NOT mark the in-flight file as
// skipped (that is the user-cancel semantics).
vi.mock('uuid', () => ({ v4: () => 'fresh-v4', v5: (name) => `v5:${name}` }));
vi.mock('../../src/utils/platform', () => ({ isElectron: () => false, isCapacitor: () => true, getPlatform: () => 'android' }));
vi.mock('../../src/boot/sentry', () => ({ addBreadcrumb: () => {}, captureException: () => {}, captureMessage: () => {} }));
vi.mock('../../src/boot/i18n', () => ({ i18n: { global: { t: (k) => k } } }));
vi.mock('../../src/utils/rawOpusToOgg', () => ({ isRawOpusPackets: () => false, rawOpusToOgg: (x) => x }));
vi.mock('../../src/services/api', () => ({ getApiUrlSync: () => 'https://api.test' }));
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true }) }));

const h = vi.hoisted(() => {
  const recs = [];
  return {
    recs,
    historyMock: {
      recordings: recs,
      defaultStoragePreference: 'keep',
      async addRecording(rec) {
        const hit = recs.find((r) => r.id === rec.id) || (rec.deviceFilename && recs.find((r) => r.deviceFilename === rec.deviceFilename));
        if (hit) { const { id, ...rest } = rec; Object.assign(hit, rest); return { success: true, recording: hit }; }
        recs.push({ ...rec }); return { success: true, recording: recs[recs.length - 1] };
      },
      async updateRecording(id, updates) { const r = recs.find((x) => x.id === id); if (r) Object.assign(r, updates); return { success: true }; },
      async deleteRecording(id) { const i = recs.findIndex((x) => x.id === id); if (i >= 0) recs.splice(i, 1); return { success: true }; },
      async applyStoragePreference() { return { deleted: false }; },
      getRecordingByDeviceFilename(fn) { return recs.find((r) => r.deviceFilename === fn); },
      getRecordingById(id) { return recs.find((r) => r.id === id); }
    }
  };
});
vi.mock('../../src/stores/recordings-history', () => ({ useRecordingsHistoryStore: () => h.historyMock }));
vi.mock('../../src/stores/meeting-prep', () => ({ useMeetingPrepStore: () => ({
  async initialize() {}, beginDeviceSyncRun() {}, endDeviceSyncRun() {}, isDeviceSyncPrepPending() { return false; }, requestDeviceSyncPrep() { return Promise.resolve({}); }
}) }));

const notif = vi.hoisted(() => ({ scheduled: [], cancelled: [], removed: [] }));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: {
  checkPermissions: async () => ({ display: 'granted' }),
  requestPermissions: async () => ({ display: 'granted' }),
  schedule: async ({ notifications }) => { notif.scheduled.push(...notifications.map((n) => n.id)); },
  cancel: async ({ notifications }) => { notif.cancelled.push(...notifications.map((n) => n.id)); },
  removeDeliveredNotifications: async ({ notifications }) => { notif.removed.push(...notifications.map((n) => n.id)); }
} }));

const ble = vi.hoisted(() => {
  const s = { unpaired: false, releaseDownload: null };
  s.manager = {
    // A download that stays pending until the test releases it (forget happens meanwhile).
    downloadFile() { return new Promise((resolve, reject) => { s.releaseDownload = { resolve, reject }; }); },
    abortDownload() { if (s.releaseDownload) { s.releaseDownload.reject(Object.assign(new Error('BLE download cancelled'), { code: undefined })); s.releaseDownload = null; } },
    getBattery: async () => 80,
    getStorage: async () => ({ FreeCapacity: 1, TotalCapacity: 2 }),
    getFileList: async () => [],
    connectWithRediscovery: async () => ({ name: 'M1(BLE)', SN: 'SN1' }),
    connect: async () => ({ name: 'M1(BLE)', SN: 'SN1' }),
    disconnect: async () => { if (s.releaseDownload) { s.releaseDownload.reject(new Error('BLE disconnected during transfer')); s.releaseDownload = null; } },
    unpair: async () => { s.unpaired = true; s.manager.abortDownload(); },
    formatDevice: async () => true,
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
vi.mock('../../src/services/storage', () => ({
  createDirectory: async () => ({ success: true }),
  writeFile: async () => ({ success: true }),
  deleteFile: async () => ({ success: true }),
  exists: async () => false
}));

import { useDeviceStore } from '../../src/stores/device';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('forget / disconnect during a sync clears the transfer indicator', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.recs.length = 0;
    ble.unpaired = false;
    ble.releaseDownload = null;
    notif.scheduled.length = 0; notif.cancelled.length = 0; notif.removed.length = 0;
  });

  function connectedStore(files) {
    const store = useDeviceStore();
    store.connectionState = 'connected';
    store.pairedDevice = { name: 'M1(BLE)', SN: 'SN1' };
    store.deviceName = 'M1(BLE)';
    store.deviceSN = 'SN1';
    store.deviceFiles = files;
    return store;
  }

  it('forgetDevice mid-download: indicator idle, file kept pending (not skipped), no "complete"', async () => {
    const store = connectedStore([
      { file: 'R20260910-090000.opus', size: 4, duration_ms: 60000, creat_time: 1_757_487_600 },
      { file: 'R20260911-100000.opus', size: 4, duration_ms: 60000, creat_time: 1_757_577_600 }
    ]);
    const run = store.syncAllNew();
    // Wait until the first download is in flight.
    for (let i = 0; i < 20 && !ble.releaseDownload; i++) await flush();
    expect(store.isSyncing).toBe(true);
    expect(store.currentSyncFile).toBe('R20260910-090000.opus');

    await store.forgetDevice();
    await run.catch(() => {});
    await flush();

    expect(store.syncState).toBe('idle');
    expect(store.isSyncing).toBe(false);
    expect(store.currentSyncFile).toBeNull();
    expect(store.syncPhase).toBe('idle');
    // The in-flight file is NOT skipped by a forget (that is user-cancel only).
    expect(store.skippedFiles).not.toContain('R20260910-090000.opus');
    // No phantom "sync complete" notification; the progress notification was cleared.
    expect(notif.scheduled).not.toContain(9002);
    expect([...notif.cancelled, ...notif.removed]).toContain(9001);
    // The second file was never downloaded.
    const second = h.recs.find((r) => r.deviceFilename === 'R20260911-100000.opus');
    expect(second == null || second.uploadStatus !== 'transferring').toBe(true);
    // Pairing is gone.
    expect(store.pairedDevice).toBeNull();
    expect(store.connectionState).toBe('disconnected');
  });

  it('disconnect mid-download leaves no sync state behind', async () => {
    const store = connectedStore([{ file: 'R20260910-090000.opus', size: 4, duration_ms: 60000, creat_time: 1_757_487_600 }]);
    const run = store.syncAllNew();
    for (let i = 0; i < 20 && !ble.releaseDownload; i++) await flush();
    expect(store.isSyncing).toBe(true);
    await store.disconnect();
    await run.catch(() => {});
    await flush();
    expect(store.syncState).toBe('idle');
    expect(store.currentSyncFile).toBeNull();
    expect(notif.scheduled).not.toContain(9002);
  });

  it('an auto-sync poll that starts a sync after forget does nothing', async () => {
    const store = connectedStore([]);
    // The list arrives with a new file, but the device is forgotten meanwhile.
    let releaseList;
    ble.manager.getFileList = () => new Promise((resolve) => { releaseList = () => resolve([{ file: 'R20260912-120000.opus', size: 4, duration_ms: 1000, creat_time: 1_757_664_000 }]); });
    store._pollTick = 0;
    const poll = store._autoSyncPoll();
    for (let i = 0; i < 20 && !releaseList; i++) await flush();
    await store.forgetDevice();
    releaseList();
    await poll.catch(() => {});
    await flush();
    expect(store.syncState).toBe('idle');
    expect(store.deviceFiles).toEqual([]);
    expect(h.recs.length).toBe(0); // no phantom history record
  });
});
