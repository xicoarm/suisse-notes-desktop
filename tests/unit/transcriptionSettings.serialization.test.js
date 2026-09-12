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
    expect(stored).toEqual({ vocabulary: [], defaultSpeakerCount: null });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('saves a detached vocabulary snapshot and reloads its exact settings', async () => {
    const store = useTranscriptionSettingsStore();
    store.globalVocabulary = ['Suisse Notes', 'Zürich'];
    store.defaultSpeakerCount = 3;
    await store.saveGlobalSettings();
    expect(stored).toEqual({ vocabulary: ['Suisse Notes', 'Zürich'], defaultSpeakerCount: 3 });
    expect(isProxy(setSettings.mock.calls[0][0].vocabulary)).toBe(false);
    store.globalVocabulary.push('unsaved change');
    expect(setSettings.mock.calls[0][0].vocabulary).toEqual(['Suisse Notes', 'Zürich']);
    setActivePinia(createPinia());
    const reloaded = useTranscriptionSettingsStore();
    await reloaded.loadGlobalSettings();
    expect(reloaded.globalVocabulary).toEqual(['Suisse Notes', 'Zürich']);
    expect(reloaded.defaultSpeakerCount).toBe(3);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('persists the real server-sync merge without passing its reactive array', async () => {
    const store = useTranscriptionSettingsStore();
    store.globalVocabulary = ['local', 'shared'];
    api.getMergedSpellings.mockResolvedValue({ spellings: ['shared', 'server'] });
    await store.syncFromServer();
    expect(store.globalVocabulary).toEqual(['local', 'shared', 'server']);
    expect(isProxy(store.globalVocabulary)).toBe(true);
    expect(stored).toEqual({ vocabulary: ['local', 'shared', 'server'], defaultSpeakerCount: null });
    expect(console.error).not.toHaveBeenCalled();
  });
});
