import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const auth = vi.hoisted(() => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true }));
vi.mock('../../src/utils/platform', () => ({ isElectron: () => true, isCapacitor: () => false, getPlatform: () => 'windows' }));
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('../../src/stores/recording', () => ({ useRecordingStore: () => ({}) }));
vi.mock('../../src/services/api', () => ({ getApiUrlSync: () => 'https://api.test' }));
import { useRecordingsHistoryStore } from '../../src/stores/recordings-history';

let history;
beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  auth.user = { id: 'u1' };
  history = { getAll: vi.fn(), getDefaultStoragePreference: vi.fn(async () => 'keep'), update: vi.fn(), add: vi.fn(), delete: vi.fn() };
  window.electronAPI = { history };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ recordings: [] }) })));
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const localRow = (id, fields = {}) => ({ id, userId: 'u1', uploadStatus: 'pending', ...fields });
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

  it('updates the correct ID when a reload inserts and reorders rows while update IPC is pending', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings = [localRow('a'), localRow('b')];
    const update = deferred();
    history.update.mockReturnValue(update.promise);
    const pending = store.updateRecording('b', { uploadStatus: 'uploaded' });
    history.getAll.mockResolvedValue([localRow('c'), localRow('a'), localRow('b', { captureWarnings: ['microphone-disconnected'] })]);
    await store.loadRecordings({ background: true });
    update.resolve({ success: true, recording: localRow('b', { uploadStatus: 'uploaded', captureWarnings: [] }) });
    await pending;
    expect(store.recordings.map(recording => recording.id)).toEqual(['c', 'a', 'b']);
    expect(store.recordings[1].uploadStatus).toBe('pending');
    expect(store.recordings[2]).toMatchObject({ uploadStatus: 'uploaded', captureWarnings: ['microphone-disconnected'] });
  });

  it.each(['reset', 'account change'])('discards awaited update responses after %s', async change => {
    const store = useRecordingsHistoryStore();
    store.recordings = [localRow('a')];
    const update = deferred();
    history.update.mockReturnValue(update.promise);
    const pending = store.updateRecording('a', { uploadStatus: 'uploaded' });
    if (change === 'reset') store.reset();
    else auth.user = { id: 'u2' };
    store.recordings = [{ id: 'a', userId: 'u2', title: 'Other account', uploadStatus: 'pending' }];
    update.resolve({ success: true, recording: localRow('a', { uploadStatus: 'uploaded', filePath: 'private-owner-audio.webm' }) });
    await pending;
    expect(store.recordings).toEqual([{ id: 'a', userId: 'u2', title: 'Other account', uploadStatus: 'pending' }]);
  });

  it.each(['reset', 'account change'])('does not repopulate records from a stale getAll after %s', async change => {
    const store = useRecordingsHistoryStore();
    const load = deferred();
    history.getAll.mockReturnValue(load.promise);
    const pending = store.loadRecordings({ background: true });
    if (change === 'reset') store.reset();
    else auth.user = { id: 'u2' };
    store.recordings = [{ id: 'other', userId: 'u2' }];
    load.resolve([localRow('private')]);
    await pending;
    expect(store.recordings).toEqual([{ id: 'other', userId: 'u2' }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('adopts warnings but preserves newer upload state and deletion against a stale local snapshot', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings = [localRow('a'), localRow('b')];
    const load = deferred();
    history.getAll.mockReturnValue(load.promise);
    const pending = store.loadRecordings({ background: true });
    history.update.mockResolvedValue({ success: true, recording: localRow('a', { uploadStatus: 'uploaded', audioFileId: 'accepted' }) });
    await store.updateRecording('a', { uploadStatus: 'uploaded', audioFileId: 'accepted' });
    history.delete.mockResolvedValue({ success: true });
    await store.deleteRecording('b');
    load.resolve([localRow('a', { captureWarnings: ['microphone-zero-signal'] }), localRow('b')]);
    await pending;
    expect(store.recordings).toHaveLength(1);
    expect(store.recordings[0]).toMatchObject({ id: 'a', uploadStatus: 'uploaded', audioFileId: 'accepted', captureWarnings: ['microphone-zero-signal'] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not resurrect a deleted record from an already pending server refresh', async () => {
    const store = useRecordingsHistoryStore();
    store.recordings = [localRow('a')];
    history.getAll.mockResolvedValue([localRow('a')]);
    const server = deferred();
    fetch.mockReturnValue(server.promise);
    const pending = store.loadRecordings({ background: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    history.delete.mockResolvedValue({ success: true });
    await store.deleteRecording('a');
    server.resolve({ ok: true, json: async () => ({ recordings: [{ id: 'a', status: 'UPLOADED' }] }) });
    await pending;
    expect(store.recordings).toEqual([]);
  });

  it('discards server rows after the account resets while their request is pending', async () => {
    const store = useRecordingsHistoryStore();
    history.getAll.mockResolvedValue([]);
    const server = deferred();
    fetch.mockReturnValue(server.promise);
    const pending = store.loadRecordings({ background: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    store.reset();
    auth.user = { id: 'u2' };
    server.resolve({ ok: true, json: async () => ({ recordings: [{ id: 'private-remote', userId: 'u1' }] }) });
    await pending;
    expect(store.recordings).toEqual([]);
    expect(store.loaded).toBe(false);
  });

  it('does not duplicate an add already returned by the local snapshot', async () => {
    const store = useRecordingsHistoryStore();
    const add = deferred();
    history.add.mockReturnValue(add.promise);
    const pending = store.addRecording(localRow('new'));
    history.getAll.mockResolvedValue([localRow('new')]);
    await store.loadRecordings({ background: true });
    add.resolve({ success: true, recording: localRow('new', { captureWarnings: ['recorder-stall'] }) });
    await pending;
    expect(store.recordings).toEqual([localRow('new', { captureWarnings: ['recorder-stall'] })]);
  });
});
