import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../src/utils/platform', () => ({ isElectron: () => true, isCapacitor: () => false, getPlatform: () => 'windows' }));
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true }) }));
vi.mock('../../src/stores/recording', () => ({ useRecordingStore: () => ({}) }));
vi.mock('../../src/services/api', () => ({ getApiUrlSync: () => 'https://api.test' }));
import { useRecordingsHistoryStore } from '../../src/stores/recordings-history';

let history;
beforeEach(() => {
  setActivePinia(createPinia());
  history = { getAll: vi.fn(), getDefaultStoragePreference: vi.fn(async () => 'keep'), update: vi.fn() };
  window.electronAPI = { history };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ recordings: [] }) })));
});
afterEach(() => {
  delete window.electronAPI;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('desktop history warning propagation to visible records', () => {
  it('uses metadata warnings returned by main during the normal completion update', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings = [{ id: 'record-1', userId: 'u1', uploadStatus: 'recording', title: 'Meeting' }];
    history.update.mockResolvedValue({ success: true, recording: {
      id: 'record-1', userId: 'u1', uploadStatus: 'uploaded', captureWarnings: ['microphone-disconnected']
    } });
    expect(await store.updateRecording('record-1', { uploadStatus: 'uploaded' })).toEqual({ success: true });
    expect(store.recordings[0]).toMatchObject({ title: 'Meeting', uploadStatus: 'uploaded', captureWarnings: ['microphone-disconnected'] });
  });

  it('refreshes local warnings on a revisit without resetting a live upload or waiting for server history', async () => {
    const store = useRecordingsHistoryStore();
    store.loaded = true;
    store.recordings = [{ id: 'record-1', userId: 'u1', uploadStatus: 'uploading' }];
    history.getAll.mockResolvedValue([{ id: 'record-1', userId: 'u1', uploadStatus: 'uploading', captureWarnings: ['microphone-zero-signal'] }]);
    let finishServer;
    fetch.mockImplementation(() => new Promise(resolve => { finishServer = resolve; }));
    const refresh = store.loadRecordings({ background: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(history.getAll).toHaveBeenCalledWith('u1');
    expect(store.loading).toBe(false);
    expect(store.recordings[0]).toMatchObject({ uploadStatus: 'uploading', captureWarnings: ['microphone-zero-signal'] });
    expect(history.update).not.toHaveBeenCalled();
    finishServer({ ok: true, json: async () => ({ recordings: [{ id: 'record-1', status: 'UPLOADED' }] }) });
    await refresh;
    expect(store.recordings).toHaveLength(1);
    expect(store.recordings[0].captureWarnings).toEqual(['microphone-zero-signal']);
  });

  it('keeps local warnings and previously loaded remote history when an offline revisit fails', async () => {
    const store = useRecordingsHistoryStore();
    store.loaded = true;
    store.recordings = [{ id: 'remote-1', _serverOnly: true }];
    history.getAll.mockResolvedValue([{ id: 'record-1', userId: 'u1', uploadStatus: 'uploaded', captureWarnings: ['future-warning'] }]);
    fetch.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.loadRecordings({ background: true });
    expect(store.recordings).toHaveLength(2);
    expect(store.recordings[0].captureWarnings).toEqual(['future-warning']);
    expect(store.recordings[1]).toMatchObject({ id: 'remote-1', _serverOnly: true });
  });
});
