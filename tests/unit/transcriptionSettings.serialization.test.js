// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { isProxy } from 'vue';
import { deserialize, serialize } from 'node:v8';

const api = vi.hoisted(() => ({
  getMergedSpellings: vi.fn(), addUserSpellings: vi.fn(), removeUserSpelling: vi.fn()
}));
vi.mock('../../src/utils/platform', () => ({ isElectron: () => true, isCapacitor: () => false }));
vi.mock('../../src/services/api', () => api);
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => ({ token: 'synthetic-token' }) }));
import { useTranscriptionSettingsStore } from '../../src/stores/transcription-settings';

let stored, setSettings;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getMergedSpellings.mockResolvedValue({ spellings: [] });
  api.addUserSpellings.mockResolvedValue({});
  api.removeUserSpelling.mockResolvedValue({});
  stored = null;
  // Exercise V8 serialization instead of an IPC mock accepting every object.
  // Reactive arrays cannot cross Electron's structured-clone IPC boundary.
  setSettings = vi.fn(async settings => {
    stored = deserialize(serialize(settings));
    return { success: true };
  });
  vi.stubGlobal('window', { electronAPI: { config: {
    setTranscriptionSettings: setSettings,
    getTranscriptionSettings: async () => deserialize(serialize(stored))
  } } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('desktop transcription settings serialization', () => {
  it('persists empty defaults through the serialization boundary', async () => {
    const store = useTranscriptionSettingsStore();
    expect(isProxy(store.globalVocabulary)).toBe(true);
    await store.saveGlobalSettings();
    expect(stored).toEqual({ vocabulary: [], orgVocabulary: [], userVocabulary: [], defaultSpeakerCount: null });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('saves a detached vocabulary snapshot and reloads its exact settings', async () => {
    const store = useTranscriptionSettingsStore();
    store.globalVocabulary = ['Suisse Notes', 'Zürich'];
    store.orgVocabulary = ['Suisse Notes'];
    store.userVocabulary = ['Zürich'];
    store.defaultSpeakerCount = 3;
    await store.saveGlobalSettings();
    expect(stored).toEqual({ vocabulary: ['Suisse Notes', 'Zürich'], orgVocabulary: ['Suisse Notes'], userVocabulary: ['Zürich'], defaultSpeakerCount: 3 });
    for (const key of ['vocabulary', 'orgVocabulary', 'userVocabulary']) expect(isProxy(setSettings.mock.calls[0][0][key])).toBe(false);
    store.globalVocabulary.push('unsaved change');
    expect(setSettings.mock.calls[0][0].vocabulary).toEqual(['Suisse Notes', 'Zürich']);
    setActivePinia(createPinia());
    // Loading starts a server sync that replaces the list (main 549b9b5); hold
    // it pending so the first checks see only the persisted copy.
    let finishSync;
    api.getMergedSpellings.mockReturnValue(new Promise(resolve => { finishSync = resolve; }));
    const reloaded = useTranscriptionSettingsStore();
    await reloaded.loadGlobalSettings();
    expect(reloaded.globalVocabulary).toEqual(['Suisse Notes', 'Zürich']);
    expect(reloaded.orgVocabulary).toEqual(['Suisse Notes']);
    expect(reloaded.userVocabulary).toEqual(['Zürich']);
    expect(reloaded.defaultSpeakerCount).toBe(3);
    // Settle the shared in-flight sync so no pending request leaks into later tests.
    finishSync({ spellings: ['Suisse Notes', 'Zürich'], orgSpellings: ['Suisse Notes'], userSpellings: ['Zürich'] });
    await reloaded.syncFromServer();
    expect(reloaded.globalVocabulary).toEqual(['Suisse Notes', 'Zürich']);
    expect(console.error).not.toHaveBeenCalled();
  });

  // Since main 549b9b5 the server's merged list replaces the local one; this
  // test keeps covering that the reactive result crosses the IPC boundary.
  it('persists the server-sync result without passing its reactive arrays', async () => {
    const store = useTranscriptionSettingsStore();
    store.globalVocabulary = ['local', 'shared'];
    api.getMergedSpellings.mockResolvedValue({ spellings: ['shared', 'server'], orgSpellings: ['shared'], userSpellings: ['server'] });
    await store.syncFromServer({ force: true });
    expect(store.globalVocabulary).toEqual(['shared', 'server']);
    expect(isProxy(store.globalVocabulary)).toBe(true);
    expect(stored).toEqual({ vocabulary: ['shared', 'server'], orgVocabulary: ['shared'], userVocabulary: ['server'], defaultSpeakerCount: null });
    expect(console.error).not.toHaveBeenCalled();
  });
});
