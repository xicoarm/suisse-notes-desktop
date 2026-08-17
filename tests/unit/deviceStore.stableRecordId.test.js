import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// ---------------------------------------------------------------------------
// The BLE device-sync pipeline (_downloadAndUpload) must use ONE recordId per
// DEVICE FILE, across every retry. The server dedupes meetings by
// botSessionId = "desktop:<recordId>"; a fresh UUID per attempt made every
// re-attempt of the same file create (and bill) a new meeting.
// ---------------------------------------------------------------------------

const uuidState = vi.hoisted(() => ({ n: 0 }));
vi.mock('uuid', () => ({ v4: () => `fresh-${++uuidState.n}` }));

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  getPlatform: () => 'ios'
}));

vi.mock('../../src/boot/sentry', () => ({
  addBreadcrumb: () => {},
  captureException: () => {},
  captureMessage: () => {}
}));

vi.mock('../../src/boot/i18n', () => ({
  i18n: { global: { t: (k) => k } }
}));

vi.mock('../../src/utils/rawOpusToOgg', () => ({
  isRawOpusPackets: () => false,
  rawOpusToOgg: (x) => x
}));

vi.mock('../../src/services/api', () => ({
  getApiUrlSync: () => 'https://api.test'
}));

vi.mock('../../src/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true })
}));

// In-memory stand-in for the recordings-history store, mirroring its dedupe
// contract: same-id updates in place; same-deviceFilename merges WITHOUT
// adopting the caller's id.
const h = vi.hoisted(() => {
  const recs = [];
  const historyMock = {
    recordings: recs,
    async addRecording(rec) {
      const byId = recs.find((r) => r.id === rec.id);
      if (byId) {
        const { id, ...rest } = rec;
        Object.assign(byId, rest);
        return { success: true, recording: byId };
      }
      const byFile = rec.deviceFilename && recs.find((r) => r.deviceFilename === rec.deviceFilename);
      if (byFile) {
        const { id, ...rest } = rec;
        Object.assign(byFile, rest);
        return { success: true, recording: byFile };
      }
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
    getRecordingByDeviceFilename(fn) {
      return recs.find((r) => r.deviceFilename === fn);
    },
    getRecordingById(id) {
      return recs.find((r) => r.id === id);
    }
  };
  return { recs, historyMock };
});
vi.mock('../../src/stores/recordings-history', () => ({
  useRecordingsHistoryStore: () => h.historyMock
}));

const prepState = vi.hoisted(() => {
  const s = { calls: [], resolveWith: {} };
  s.store = {
    async initialize() {},
    beginDeviceSyncRun() {},
    endDeviceSyncRun() {},
    isDeviceSyncPrepPending() { return false; },
    requestDeviceSyncPrep(args) {
      s.calls.push(args);
      return Promise.resolve(s.resolveWith);
    }
  };
  return s;
});
vi.mock('../../src/stores/meeting-prep', () => ({
  useMeetingPrepStore: () => prepState.store
}));

const uploadState = vi.hoisted(() => {
  const s = { calls: [], result: null };
  s.fn = (args) => {
    s.calls.push(args);
    return Promise.resolve(s.result);
  };
  return s;
});
vi.mock('../../src/services/upload', () => ({
  uploadWithVerification: uploadState.fn
}));

const ble = vi.hoisted(() => {
  const s = { downloadCalls: [] };
  s.manager = {
    downloadFile(name) {
      s.downloadCalls.push(name);
      return Promise.resolve(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 1, 2, 3, 4, 5]));
    },
    abortDownload() {}
  };
  return s;
});
vi.mock('../../src/services/bleService', () => ({
  getBleManager: () => ble.manager
}));

const prefs = vi.hoisted(() => {
  const m = new Map();
  return {
    m,
    Preferences: {
      async get({ key }) { return { value: m.has(key) ? m.get(key) : null }; },
      async set({ key, value }) { m.set(key, value); },
      async remove({ key }) { m.delete(key); }
    }
  };
});
vi.mock('@capacitor/preferences', () => ({ Preferences: prefs.Preferences }));

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: {
    mkdir: async () => {},
    writeFile: async () => {},
    deleteFile: async () => {}
  },
  Directory: { Documents: 'DOCUMENTS' }
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
    schedule: async () => {}
  }
}));

import { useDeviceStore } from '../../src/stores/device';

const FILE = {
  file: 'R20260101-120000.opus',
  size: 10,
  duration_ms: 60000,
  creat_time: 1_750_000_000
};

describe('device store: stable recordId per device file', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.recs.length = 0;
    prepState.calls.length = 0;
    prepState.resolveWith = {};
    uploadState.calls.length = 0;
    uploadState.result = { success: true, transcriptionId: 't1', audioFileId: 'a1' };
    ble.downloadCalls.length = 0;
    prefs.m.clear();
  });

  it('fresh file: one record, one prep prompt, upload uses the record id, file marked synced', async () => {
    const store = useDeviceStore();
    await store._downloadAndUpload(FILE);

    expect(h.recs).toHaveLength(1);
    const rec = h.recs[0];
    expect(uploadState.calls).toHaveLength(1);
    expect(uploadState.calls[0].recordId).toBe(rec.id);
    expect(prepState.calls).toHaveLength(1);
    expect(rec.uploadStatus).toBe('uploaded');
    expect(rec.prepAnswered).toBe(true);
    expect(store.syncedFiles).toContain(FILE.file);
  });

  it('re-attempt after a failed upload reuses the SAME recordId and does not re-prompt', async () => {
    const store = useDeviceStore();

    uploadState.result = { success: false, error: 'no minutes' };
    await expect(store._downloadAndUpload(FILE)).rejects.toThrow('no minutes');

    expect(h.recs).toHaveLength(1);
    const firstId = h.recs[0].id;
    expect(h.recs[0].uploadStatus).toBe('failed');
    expect(prepState.calls).toHaveLength(1);
    expect(store.syncedFiles).not.toContain(FILE.file);

    // Second attempt (e.g. user topped up minutes, device reconnected)
    uploadState.result = { success: true, transcriptionId: 't1', audioFileId: 'a1' };
    await store._downloadAndUpload(FILE);

    expect(h.recs).toHaveLength(1);
    expect(h.recs[0].id).toBe(firstId);
    expect(uploadState.calls).toHaveLength(2);
    expect(uploadState.calls[1].recordId).toBe(firstId);
    // Prompted once per FILE, not once per attempt.
    expect(prepState.calls).toHaveLength(1);
    expect(store.syncedFiles).toContain(FILE.file);
  });

  it('skips the file while an open prep prompt or live upload owns it', async () => {
    const store = useDeviceStore();
    h.recs.push({ id: 'busy-1', deviceFilename: FILE.file, uploadStatus: 'pending_prep' });

    await store._downloadAndUpload(FILE);
    expect(ble.downloadCalls).toHaveLength(0);
    expect(uploadState.calls).toHaveLength(0);
    expect(h.recs).toHaveLength(1);

    h.recs[0].uploadStatus = 'uploading';
    await store._downloadAndUpload(FILE);
    expect(ble.downloadCalls).toHaveLength(0);
    expect(uploadState.calls).toHaveLength(0);
  });

  it('already-uploaded record heals syncedFiles without re-download or re-upload', async () => {
    const store = useDeviceStore();
    h.recs.push({ id: 'done-1', deviceFilename: FILE.file, uploadStatus: 'uploaded', audioFileId: 'a9' });

    await store._downloadAndUpload(FILE);

    expect(ble.downloadCalls).toHaveLength(0);
    expect(uploadState.calls).toHaveLength(0);
    expect(store.syncedFiles).toContain(FILE.file);
  });
});
