import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// History must never lose a device recording and never show it twice:
//  - record ids are deterministic per user + recorder + file (uuid v5), so a
//    reinstall / purged cache / second phone re-syncs into the SAME meeting;
//  - a cancelled or unrecoverable transfer keeps its history entry as
//    'skipped' (re-sync offered) instead of deleting it;
//  - empty files and files that keep arriving corrupted are skipped with a
//    machine-readable reason instead of being retried every poll;
//  - device recordings honour the "delete after upload" preference.
vi.mock('uuid', () => ({
  v4: () => 'fresh-v4',
  v5: (name, ns) => `v5:${name}@${ns.slice(0, 4)}`
}));

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  getPlatform: () => 'ios'
}));
const sentry = vi.hoisted(() => ({ messages: [] }));
vi.mock('../../src/boot/sentry', () => ({
  addBreadcrumb: () => {},
  captureException: () => {},
  captureMessage: (m) => sentry.messages.push(m)
}));
vi.mock('../../src/boot/i18n', () => ({ i18n: { global: { t: (k) => k } } }));
vi.mock('../../src/utils/rawOpusToOgg', () => ({ isRawOpusPackets: () => false, rawOpusToOgg: (x) => x }));
vi.mock('../../src/services/api', () => ({ getApiUrlSync: () => 'https://api.test' }));
vi.mock('../../src/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true })
}));

const h = vi.hoisted(() => {
  const recs = [];
  const historyMock = {
    recordings: recs,
    defaultStoragePreference: 'keep',
    applied: [],
    async addRecording(rec) {
      const byId = recs.find((r) => r.id === rec.id);
      if (byId) { const { id, ...rest } = rec; Object.assign(byId, rest); return { success: true, recording: byId }; }
      const byFile = rec.deviceFilename && recs.find((r) => r.deviceFilename === rec.deviceFilename);
      if (byFile) { const { id, ...rest } = rec; Object.assign(byFile, rest); return { success: true, recording: byFile }; }
      recs.push({ ...rec });
      return { success: true, recording: recs[recs.length - 1] };
    },
    async updateRecording(id, updates) {
      const r = recs.find((x) => x.id === id);
      if (r) Object.assign(r, updates);
      return { success: true };
    },
    async deleteRecording(id) {
      const i = recs.findIndex((x) => x.id === id);
      if (i >= 0) recs.splice(i, 1);
      return { success: true };
    },
    async applyStoragePreference(id) { historyMock.applied.push(id); return { deleted: true }; },
    getRecordingByDeviceFilename(fn) { return recs.find((r) => r.deviceFilename === fn); },
    getRecordingById(id) { return recs.find((r) => r.id === id); }
  };
  return { recs, historyMock };
});
vi.mock('../../src/stores/recordings-history', () => ({ useRecordingsHistoryStore: () => h.historyMock }));

const prepState = vi.hoisted(() => ({
  store: {
    async initialize() {},
    beginDeviceSyncRun() {},
    endDeviceSyncRun() {},
    isDeviceSyncPrepPending() { return false; },
    requestDeviceSyncPrep() { return Promise.resolve({}); }
  }
}));
vi.mock('../../src/stores/meeting-prep', () => ({ useMeetingPrepStore: () => prepState.store }));

const uploadState = vi.hoisted(() => {
  const s = { calls: [], result: null };
  s.fn = (args) => { s.calls.push(args); return Promise.resolve(s.result); };
  return s;
});
vi.mock('../../src/services/upload', () => ({ uploadWithVerification: uploadState.fn }));

const ble = vi.hoisted(() => {
  const s = { downloadCalls: [], failWith: null };
  s.manager = {
    downloadFile(name) {
      s.downloadCalls.push(name);
      if (s.failWith) return Promise.reject(s.failWith);
      return Promise.resolve(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 1, 2, 3, 4, 5]));
    },
    abortDownload() {}
  };
  return s;
});
vi.mock('../../src/services/bleService', () => ({ getBleManager: () => ble.manager }));

vi.mock('@capacitor/preferences', () => {
  const m = new Map();
  return { Preferences: {
    async get({ key }) { return { value: m.has(key) ? m.get(key) : null }; },
    async set({ key, value }) { m.set(key, value); },
    async remove({ key }) { m.delete(key); }
  } };
});
const fsState = vi.hoisted(() => ({ deleted: [] }));
vi.mock('../../src/services/storage', () => ({
  createDirectory: async () => ({ success: true }),
  writeFile: async () => ({ success: true }),
  deleteFile: async (p) => { fsState.deleted.push(p); return { success: true }; }
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
    schedule: async () => {}
  }
}));

import { useDeviceStore, deviceFileRecordId, userAppUuid } from '../../src/stores/device';

const FILE = { file: 'R20260101-120000.opus', size: 10, duration_ms: 60000, creat_time: 1_750_000_000 };

describe('deterministic identities', () => {
  it('deviceFileRecordId is stable for user + recorder + file', () => {
    const a = deviceFileRecordId('u1', 'SN123', 'R1.opus');
    expect(a).toBe(deviceFileRecordId('u1', 'SN123', 'R1.opus'));
    expect(a).not.toBe(deviceFileRecordId('u2', 'SN123', 'R1.opus'));
    expect(a).not.toBe(deviceFileRecordId('u1', 'SN123', 'R2.opus'));
  });

  it('userAppUuid is stable per user and null without a user', () => {
    expect(userAppUuid('u1')).toBe(userAppUuid('u1'));
    expect(userAppUuid('u1')).not.toBe(userAppUuid('u2'));
    expect(userAppUuid(null)).toBeNull();
  });
});

describe('device store: skip / cancel keep the recording findable', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.recs.length = 0;
    h.historyMock.defaultStoragePreference = 'keep';
    h.historyMock.applied.length = 0;
    uploadState.calls.length = 0;
    uploadState.result = { success: true, transcriptionId: 't1', audioFileId: 'a1' };
    ble.downloadCalls.length = 0;
    ble.failWith = null;
    fsState.deleted.length = 0;
    sentry.messages.length = 0;
  });

  it('a fresh device file gets the deterministic id and the global storage preference', async () => {
    h.historyMock.defaultStoragePreference = 'delete_after_upload';
    const store = useDeviceStore();
    await store._downloadAndUpload(FILE);
    expect(h.recs).toHaveLength(1);
    expect(h.recs[0].id).toBe(deviceFileRecordId('u1', 'device', FILE.file));
    expect(h.recs[0].storagePreference).toBe('delete_after_upload');
    expect(h.recs[0].uploadStatus).toBe('uploaded');
    expect(h.historyMock.applied).toEqual([h.recs[0].id]);
  });

  it('cancelling a transfer keeps the entry as skipped (re-sync possible) instead of deleting it', async () => {
    const store = useDeviceStore();
    ble.failWith = new Error('BLE download cancelled');
    await expect(store._downloadAndUpload(FILE)).rejects.toThrow('cancelled');
    expect(h.recs).toHaveLength(1);
    expect(h.recs[0].uploadStatus).toBe('skipped');
    expect(h.recs[0].filePath).toBeNull();
    expect(store.skippedFiles).toContain(FILE.file);
    expect(store.syncedFiles).not.toContain(FILE.file);
  });

  it('an empty file on the recorder is skipped with a reason, not retried forever', async () => {
    const store = useDeviceStore();
    const e = new Error('Device file is empty'); e.code = 'EMPTY_FILE';
    ble.failWith = e;
    await expect(store._downloadAndUpload(FILE)).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    expect(h.recs[0].uploadStatus).toBe('skipped');
    expect(h.recs[0].uploadError).toBe('EMPTY_FILE');
    expect(store.skippedFiles).toContain(FILE.file);
    expect(uploadState.calls).toHaveLength(0);
  });

  it('corrupted transfers are retried up to the cap, then skipped with CRC_GAVE_UP', async () => {
    const store = useDeviceStore();
    ble.failWith = new Error('CRC mismatch: expected 0x1234, got 0x5678');
    await expect(store._downloadAndUpload(FILE)).rejects.toThrow('CRC mismatch');
    expect(h.recs[0].uploadStatus).toBe('pending');
    expect(store.skippedFiles).not.toContain(FILE.file);
    await expect(store._downloadAndUpload(FILE)).rejects.toThrow('CRC mismatch');
    expect(store.skippedFiles).not.toContain(FILE.file);
    await expect(store._downloadAndUpload(FILE)).rejects.toMatchObject({ code: 'CRC_GAVE_UP' });
    expect(h.recs).toHaveLength(1);
    expect(h.recs[0].uploadStatus).toBe('skipped');
    expect(h.recs[0].uploadError).toBe('CRC_GAVE_UP');
    expect(store.skippedFiles).toContain(FILE.file);
    expect(sentry.messages.some(m => /CRC_GAVE_UP/.test(m))).toBe(true);
  });

  it('a successful transfer after earlier corruption clears the counter and marks synced', async () => {
    const store = useDeviceStore();
    ble.failWith = new Error('CRC mismatch: x');
    await expect(store._downloadAndUpload(FILE)).rejects.toThrow();
    ble.failWith = null;
    await store._downloadAndUpload(FILE);
    expect(h.recs).toHaveLength(1);
    expect(h.recs[0].uploadStatus).toBe('uploaded');
    expect(store.syncedFiles).toContain(FILE.file);
    expect(store._crcFailures[FILE.file]).toBeUndefined();
  });
});
