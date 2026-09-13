import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// The Settings choice "do not keep recordings on this phone" must actually
// remove the local audio once the cloud copy is verified — on mobile it
// never did (the deletion branch was Electron-only), so the History kept a
// playable file for every "deleted" recording.
vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  getPlatform: () => 'ios'
}));
vi.mock('../../src/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true })
}));
const rs = vi.hoisted(() => ({ locked: new Set(), unlocked: [], cleaned: [] }));
vi.mock('../../src/stores/recording', () => ({
  useRecordingStore: () => ({
    canDelete: (id) => !rs.locked.has(id),
    unlockFile: (id) => rs.unlocked.push(id),
    cleanupChunksAfterUpload: (id) => rs.cleaned.push(id)
  })
}));
vi.mock('../../src/services/api', () => ({
  getApiUrlSync: () => 'https://api.test',
  fetchWithTimeout: async () => { throw new Error('offline (test)'); }
}));
const fs = vi.hoisted(() => ({ deletedFiles: [], deletedDirs: [], failNext: null }));
vi.mock('../../src/services/storage', () => ({
  deleteFile: async (p) => {
    if (fs.failNext) { const e = fs.failNext; fs.failNext = null; return { success: false, error: e }; }
    fs.deletedFiles.push(p); return { success: true };
  },
  deleteDirectory: async (p) => { fs.deletedDirs.push(p); return { success: true }; }
}));
const q = vi.hoisted(() => ({ removed: [] }));
vi.mock('../../src/services/upload', () => ({
  removeFromMobileUploadQueue: (id) => q.removed.push(id)
}));
vi.mock('@capacitor/preferences', () => {
  const m = new Map();
  return { Preferences: {
    async get({ key }) { return { value: m.has(key) ? m.get(key) : null }; },
    async set({ key, value }) { m.set(key, value); },
    async remove({ key }) { m.delete(key); }
  } };
});

import { useRecordingsHistoryStore } from '../../src/stores/recordings-history';

const base = (over = {}) => ({
  id: 'rec-1', userId: 'u1', title: 'Meeting', filePath: 'recordings/rec-1/combined.webm',
  uploadStatus: 'uploaded', audioFileId: 'a1', transcriptionId: 't1', storagePreference: 'delete_after_upload', ...over
});

describe('recordings-history.applyStoragePreference (mobile)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    fs.deletedFiles.length = 0; fs.deletedDirs.length = 0; fs.failNext = null;
    q.removed.length = 0; rs.locked.clear(); rs.unlocked.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ recording: {} }) })));
  });

  it('deletes the combined file and the chunk folder of a verified app recording', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings.push(base());
    const r = await store.applyStoragePreference('rec-1');
    expect(r.deleted).toBe(true);
    expect(fs.deletedFiles).toEqual(['recordings/rec-1/combined.webm']);
    expect(fs.deletedDirs).toEqual(['recordings/rec-1']);
    const rec = store.recordings[0];
    expect(rec.filePath).toBeNull();
    expect(rec.uploadStatus).toBe('uploaded');      // history entry + transcript link survive
    expect(rec.localAudioDeletedAt).toBeTruthy();
    expect(rs.unlocked).toContain('rec-1');
    expect(q.removed).toContain('rec-1');
  });

  it('device recordings: deletes the file only (no chunk folder)', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings.push(base({ source: 'device', deviceFilename: 'R1.opus', filePath: 'recordings/device/R1.opus' }));
    const r = await store.applyStoragePreference('rec-1');
    expect(r.deleted).toBe(true);
    expect(fs.deletedFiles).toEqual(['recordings/device/R1.opus']);
    expect(fs.deletedDirs).toEqual([]);
  });

  it('keeps the audio when the preference is keep', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings.push(base({ storagePreference: 'keep' }));
    const r = await store.applyStoragePreference('rec-1');
    expect(r).toEqual({ deleted: false, reason: 'keep' });
    expect(fs.deletedFiles).toEqual([]);
    expect(store.recordings[0].filePath).toBe('recordings/rec-1/combined.webm');
  });

  it('falls back to the global default preference when the record has none', async () => {
    const store = useRecordingsHistoryStore();
    store.defaultStoragePreference = 'delete_after_upload';
    store.recordings.push(base({ storagePreference: undefined }));
    const r = await store.applyStoragePreference('rec-1');
    expect(r.deleted).toBe(true);
  });

  it('never deletes without a verified cloud copy or while the file is locked', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings.push(base({ id: 'no-audio', audioFileId: null }));
    store.recordings.push(base({ id: 'failed', uploadStatus: 'failed' }));
    store.recordings.push(base({ id: 'locked' }));
    rs.locked.add('locked');
    expect((await store.applyStoragePreference('no-audio')).reason).toBe('not_uploaded');
    expect((await store.applyStoragePreference('failed')).reason).toBe('not_uploaded');
    expect((await store.applyStoragePreference('locked')).reason).toBe('locked');
    expect((await store.applyStoragePreference('missing')).reason).toBe('not_found');
    expect(fs.deletedFiles).toEqual([]);
  });

  it('a failed delete keeps the path (audio still reachable) and reports the reason', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings.push(base());
    fs.failNext = 'EBUSY';
    const r = await store.applyStoragePreference('rec-1');
    expect(r).toEqual({ deleted: false, reason: 'EBUSY' });
    expect(store.recordings[0].filePath).toBe('recordings/rec-1/combined.webm');
  });
});

describe('recordings-history.deleteAll (mobile)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    fs.deletedFiles.length = 0; fs.deletedDirs.length = 0; q.removed.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  });

  it('removes every local file, keeps cloud-backed entries without audio, drops local-only entries', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings.push(base({ id: 'cloud', filePath: 'recordings/cloud/c.webm' }));
    store.recordings.push(base({ id: 'dev', source: 'device', deviceFilename: 'R2.opus', filePath: 'recordings/device/R2.opus' }));
    store.recordings.push(base({ id: 'local-only', uploadStatus: 'failed', audioFileId: null, filePath: 'recordings/local-only/c.webm' }));
    const r = await store.deleteAll();
    expect(r.success).toBe(true);
    expect(r.deletedCount).toBe(3);
    expect(fs.deletedFiles.sort()).toEqual(['recordings/cloud/c.webm', 'recordings/device/R2.opus', 'recordings/local-only/c.webm']);
    expect(fs.deletedDirs.sort()).toEqual(['recordings/cloud', 'recordings/local-only']);
    expect(store.recordings.map(r => r.id).sort()).toEqual(['cloud', 'dev']);
    expect(store.recordings.every(r => r.filePath === null)).toBe(true);
    expect(q.removed.sort()).toEqual(['cloud', 'dev', 'local-only']);
  });
});
