import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Mobile (Capacitor) platform — the deviceFilename dedupe matters on the
// BLE-device sync path, which only exists on mobile.
vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  getPlatform: () => 'ios'
}));

vi.mock('../../src/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true })
}));

vi.mock('../../src/stores/recording', () => ({
  useRecordingStore: () => ({})
}));

vi.mock('../../src/services/api', () => ({
  getApiUrlSync: () => 'https://api.test'
}));

import { useRecordingsHistoryStore } from '../../src/stores/recordings-history';

describe('recordings-history: deviceFilename dedupe keeps a stable record id', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ recording: {} })
    })));
  });

  it('merges a re-attempt into the existing record WITHOUT adopting the new id', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings.push({
      id: 'stable-1',
      deviceFilename: 'R20260101-120000.opus',
      uploadStatus: 'failed',
      prep: { context: 'Kickoff' },
      prepAnswered: true,
      userId: 'u1'
    });

    // A second sync attempt of the same device file arrives with a fresh UUID
    // (the old buggy behavior re-keyed the record to it, breaking the server's
    // botSessionId dedupe and creating duplicate meetings).
    const result = await store.addRecording({
      id: 'fresh-2',
      deviceFilename: 'R20260101-120000.opus',
      uploadStatus: 'transferring',
      title: '2026-01-01 12:00',
      duration: 60,
      filePath: null,
      fileSize: 10,
      createdAt: '2026-01-01T12:00:00.000Z',
      source: 'device'
    });

    expect(result.success).toBe(true);
    expect(store.recordings).toHaveLength(1);
    const rec = store.recordings[0];
    expect(rec.id).toBe('stable-1');
    expect(rec.uploadStatus).toBe('transferring');
    // The answered context prompt survives the merge — no re-prompt needed.
    expect(rec.prepAnswered).toBe(true);
    expect(rec.prep).toEqual({ context: 'Kickoff' });
    expect(store.recordings.some(r => r.id === 'fresh-2')).toBe(false);
  });

  it('same-id addRecording stays idempotent (updates in place)', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings.push({
      id: 'stable-1',
      deviceFilename: 'R20260101-120000.opus',
      uploadStatus: 'pending',
      userId: 'u1'
    });

    await store.addRecording({
      id: 'stable-1',
      deviceFilename: 'R20260101-120000.opus',
      uploadStatus: 'uploading'
    });

    expect(store.recordings).toHaveLength(1);
    expect(store.recordings[0].uploadStatus).toBe('uploading');
  });

  it('a genuinely new device file still creates a record', async () => {
    const store = useRecordingsHistoryStore();
    await store.addRecording({
      id: 'fresh-1',
      deviceFilename: 'R20260202-090000.opus',
      uploadStatus: 'transferring',
      source: 'device'
    });
    expect(store.recordings).toHaveLength(1);
    expect(store.recordings[0].id).toBe('fresh-1');
  });
});
