import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Main unified "delete after upload" for phone and desktop in
// applyStoragePreference. On desktop the local folder also holds the retained
// native sources and receipts, and the main process refuses automatic deletion
// until the backend can attest the complete remote contents. The unified path
// must therefore ask for that verification and keep the audio when refused.
vi.mock('../../src/utils/platform', () => ({
  isElectron: () => true,
  isCapacitor: () => false,
  getPlatform: () => 'electron'
}));
vi.mock('../../src/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true })
}));
const rs = vi.hoisted(() => ({ locked: new Set(), unlocked: [] }));
vi.mock('../../src/stores/recording', () => ({
  useRecordingStore: () => ({
    canDelete: (id) => !rs.locked.has(id),
    unlockFile: (id) => rs.unlocked.push(id),
    cleanupChunksAfterUpload: () => {}
  })
}));
vi.mock('../../src/services/api', () => ({
  getApiUrlSync: () => 'https://api.test',
  fetchWithTimeout: async () => { throw new Error('offline (test)'); }
}));
vi.mock('../../src/services/upload', () => ({ removeFromMobileUploadQueue: () => {} }));

import { useRecordingsHistoryStore } from '../../src/stores/recordings-history';

const base = (over = {}) => ({
  id: 'rec-1', userId: 'u1', title: 'Meeting', filePath: 'C:/Users/test/recordings/rec-1/audio.webm',
  uploadStatus: 'uploaded', audioFileId: 'a1', transcriptionId: 't1', storagePreference: 'delete_after_upload', ...over
});

describe('recordings-history.applyStoragePreference (desktop)', () => {
  let deleteRecording;
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    rs.locked.clear(); rs.unlocked.length = 0;
    deleteRecording = vi.fn(async () => ({ success: false, error: 'The server has not verified the complete audio file.' }));
    vi.stubGlobal('window', Object.assign(globalThis.window || {}, {
      electronAPI: {
        recording: { deleteRecording },
        history: { update: vi.fn(async (id, updates) => ({ success: true, recording: { id, ...updates } })) }
      }
    }));
  });

  it('requires a verified receipt and keeps the local audio when the main process refuses', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings.push(base());
    const result = await store.applyStoragePreference('rec-1');
    expect(deleteRecording).toHaveBeenCalledWith('rec-1', { requireVerified: true });
    expect(result).toEqual({ deleted: false, reason: 'The server has not verified the complete audio file.' });
    expect(store.recordings[0].filePath).toBe('C:/Users/test/recordings/rec-1/audio.webm');
    expect(store.recordings[0].localAudioDeletedAt).toBeUndefined();
    expect(window.electronAPI.history.update).not.toHaveBeenCalled();
  });

  it('records the deletion only after the main process confirms it', async () => {
    deleteRecording.mockResolvedValueOnce({ success: true });
    const store = useRecordingsHistoryStore();
    store.recordings.push(base());
    const result = await store.applyStoragePreference('rec-1');
    expect(deleteRecording).toHaveBeenCalledWith('rec-1', { requireVerified: true });
    expect(result).toEqual({ deleted: true });
    expect(store.recordings[0].filePath).toBeNull();
    expect(rs.unlocked).toContain('rec-1');
  });

  it('never asks the main process to delete an unverified, kept or locked recording', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings.push(base({ id: 'keep', storagePreference: 'keep' }));
    store.recordings.push(base({ id: 'failed', uploadStatus: 'failed' }));
    store.recordings.push(base({ id: 'locked' }));
    rs.locked.add('locked');
    expect((await store.applyStoragePreference('keep')).reason).toBe('keep');
    expect((await store.applyStoragePreference('failed')).reason).toBe('not_uploaded');
    expect((await store.applyStoragePreference('locked')).reason).toBe('locked');
    expect(deleteRecording).not.toHaveBeenCalled();
  });
});
