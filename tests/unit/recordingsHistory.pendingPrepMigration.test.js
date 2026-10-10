// Up to 3.9.40 a Suisse Meets Pro recording waited in uploadStatus 'pending_prep'
// for the context/template prompt. The prompt is gone (Areg, 10.10.2026): a record
// left in that state on a phone must become an ordinary pending upload, online and
// offline, so the auto-retry picks it up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const auth = vi.hoisted(() => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true }));
vi.mock('../../src/utils/platform', () => ({ isElectron: () => false, isCapacitor: () => true, getPlatform: () => 'android' }));
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('../../src/stores/recording', () => ({ useRecordingStore: () => ({}) }));
vi.mock('../../src/services/api', () => ({
  getApiUrlSync: () => 'https://api.test',
  fetchWithTimeout: (url, options) => fetch(url, options),
  readJson: (response) => response.json(),
  ApiResponseError: class ApiResponseError extends Error {}
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} }
}));
import { useRecordingsHistoryStore } from '../../src/stores/recordings-history';

const CACHE_KEY = 'recordings_history_cache_u1';
const stranded = {
  id: 'device-1',
  userId: 'u1',
  source: 'device',
  deviceFilename: 'R20260922-171358.opus',
  filePath: 'suissenotes_recordings/R20260922-171358.opus',
  uploadStatus: 'pending_prep',
  title: 'Aufnahme vom Suisse Meets Pro',
  createdAt: '2026-09-22T15:13:58.000Z'
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  localStorage.setItem(CACHE_KEY, JSON.stringify([stranded]));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a recording left in 'pending_prep' by 3.9.40", () => {
  it('is a pending upload as soon as the history loads, also offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const store = useRecordingsHistoryStore();
    await store.loadRecordings();

    expect(store.recordings).toHaveLength(1);
    expect(store.recordings[0]).toMatchObject({ id: 'device-1', uploadStatus: 'pending', filePath: stranded.filePath });
  });

  it('stays a pending upload after the merge with the server history', async () => {
    // The server knows the recording only as registered (no audio yet).
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ recordings: [{ id: 'device-1', status: 'RECORDING', title: stranded.title }] })
    })));
    const store = useRecordingsHistoryStore();
    await store.loadRecordings();

    const rec = store.recordings.find((r) => r.id === 'device-1');
    expect(rec).toMatchObject({ uploadStatus: 'pending', filePath: stranded.filePath, deviceFilename: stranded.deviceFilename });
    expect(JSON.parse(localStorage.getItem(CACHE_KEY))[0].uploadStatus).toBe('pending');
  });
});
