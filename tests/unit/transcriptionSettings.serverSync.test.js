import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Custom vocabulary on the phone must follow the server: words deleted on the
// web disappear, words added on the web appear without restarting the app, a
// second account on the phone never sees the first account's words, and an
// edit the server refused does not stay on the phone only.
const h = vi.hoisted(() => ({
  prefs: new Map(),
  server: { org: [], user: [], failAdd: null, failRemove: null, failMerged: null },
  calls: { merged: 0, add: [], remove: [] },
  auth: { token: 'tok', user: { id: 'u1' } }
}));

vi.mock('../../src/utils/platform', () => ({ isElectron: () => false, isCapacitor: () => true }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    async get({ key }) { return { value: h.prefs.has(key) ? h.prefs.get(key) : null }; },
    async set({ key, value }) { h.prefs.set(key, value); }
  }
}));
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => h.auth }));
vi.mock('../../src/services/api', () => ({
  async getMergedSpellings() {
    h.calls.merged++;
    if (h.server.failMerged) throw new Error(h.server.failMerged);
    const { org, user } = h.server;
    return { spellings: [...new Set([...org, ...user])], orgSpellings: [...org], userSpellings: [...user] };
  },
  async addUserSpellings(token, terms) {
    h.calls.add.push(terms);
    if (h.server.failAdd) throw new Error(h.server.failAdd);
    for (const t of terms) if (!h.server.user.includes(t)) h.server.user.push(t);
    return { spellings: [...h.server.user], added: terms };
  },
  async removeUserSpelling(token, term) {
    h.calls.remove.push(term);
    if (h.server.failRemove) throw new Error(h.server.failRemove);
    h.server.user = h.server.user.filter((w) => w !== term);
    return { spellings: [...h.server.user], removed: term };
  }
}));

import { useTranscriptionSettingsStore } from '../../src/stores/transcription-settings';

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(store) {
  for (let i = 0; i < 5; i++) await flush();
  await store.syncFromServer(); // joins an in-flight sync if any (throttled otherwise)
}

describe('custom vocabulary follows the server', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.prefs.clear();
    h.server = { org: [], user: [], failAdd: null, failRemove: null, failMerged: null };
    h.calls = { merged: 0, add: [], remove: [] };
    h.auth.token = 'tok';
    h.auth.user = { id: 'u1' };
  });

  it('a word deleted on the web disappears from the phone (server list replaces the saved copy)', async () => {
    h.prefs.set('transcription_settings:uu1', JSON.stringify({ vocabulary: ['Kanton', 'OldBrand'], defaultSpeakerCount: 3 }));
    h.server.user = ['Kanton', 'Gemeinderat'];
    const store = useTranscriptionSettingsStore();
    await store.loadGlobalSettings();
    await settle(store);
    expect(store.globalVocabulary).toEqual(['Kanton', 'Gemeinderat']);
    expect(store.defaultSpeakerCount).toBe(3);
    expect(JSON.parse(h.prefs.get('transcription_settings:uu1')).vocabulary).toEqual(['Kanton', 'Gemeinderat']);
  });

  it('words added on the web appear on the next page open after 30 s or on foreground, without a restart', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-12T10:00:00Z'), toFake: ['Date'] });
    try {
      const store = useTranscriptionSettingsStore();
      await store.loadGlobalSettings();
      await settle(store);
      expect(h.calls.merged).toBe(1);
      h.server.user = ['Neu'];
      await store.loadGlobalSettings(); // page opened again within 30 s → no second request
      await settle(store);
      expect(h.calls.merged).toBe(1);
      vi.setSystemTime(Date.parse('2026-09-12T10:00:31Z'));
      await store.syncFromServer(); // foreground after 31 s
      expect(h.calls.merged).toBe(2);
      expect(store.globalVocabulary).toEqual(['Neu']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed first sync does not freeze the list for the rest of the process', async () => {
    h.server.failMerged = 'Network request failed';
    const store = useTranscriptionSettingsStore();
    await store.loadGlobalSettings();
    await settle(store);
    expect(store.lastSyncedAt).toBe(0);
    h.server.failMerged = null;
    h.server.user = ['Zürich'];
    await store.loadGlobalSettings(); // next page open retries immediately (never synced)
    await settle(store);
    expect(store.globalVocabulary).toEqual(['Zürich']);
  });

  it('a second account on the phone never sees the first account\'s words; logout clears them', async () => {
    h.server.user = ['PrivateWord'];
    const store = useTranscriptionSettingsStore();
    await store.loadGlobalSettings();
    await settle(store);
    expect(store.globalVocabulary).toEqual(['PrivateWord']);

    store.reset(); // logout
    expect(store.globalVocabulary).toEqual([]);
    h.auth.user = { id: 'u2' };
    h.server.user = [];
    h.server.failMerged = 'offline'; // even offline, u1's saved copy must not leak
    await store.loadGlobalSettings();
    await settle(store);
    expect(store.globalVocabulary).toEqual([]);
  });

  it('ignores the words of the old shared key but keeps its speaker default', async () => {
    h.prefs.set('transcription_settings', JSON.stringify({ vocabulary: ['SomeoneElse'], defaultSpeakerCount: 2 }));
    h.server.failMerged = 'offline';
    const store = useTranscriptionSettingsStore();
    await store.loadGlobalSettings();
    await settle(store);
    expect(store.globalVocabulary).toEqual([]);
    expect(store.defaultSpeakerCount).toBe(2);
  });

  it('an added word the server refuses is rolled back and reported', async () => {
    const store = useTranscriptionSettingsStore();
    await store.loadGlobalSettings();
    await settle(store);
    h.server.failAdd = 'Maximum 200 terms';
    const result = await store.addGlobalWord('Überlauf');
    expect(result).toEqual({ ok: false, error: 'Maximum 200 terms' });
    expect(store.globalVocabulary).not.toContain('Überlauf');
  });

  it('an added word the server accepts stays and the list is re-synced', async () => {
    h.server.org = ['OrgWord'];
    const store = useTranscriptionSettingsStore();
    await store.loadGlobalSettings();
    await settle(store);
    const before = h.calls.merged;
    expect(await store.addGlobalWord('  Mein Wort ')).toEqual({ ok: true });
    expect(h.calls.add).toEqual([['Mein Wort']]);
    expect(h.calls.merged).toBe(before + 1);
    expect(store.globalVocabulary).toEqual(['OrgWord', 'Mein Wort']);
  });

  it('organization words are read-only; a failed personal removal is restored', async () => {
    h.server.org = ['OrgWord'];
    h.server.user = ['Mine'];
    const store = useTranscriptionSettingsStore();
    await store.loadGlobalSettings();
    await settle(store);
    expect(store.personalVocabulary).toEqual(['Mine']);
    expect(store.organizationOnlyVocabulary).toEqual(['OrgWord']);
    expect(await store.removeGlobalWord('OrgWord')).toEqual({ ok: false, error: 'organization' });
    expect(h.calls.remove).toEqual([]);
    h.server.failRemove = 'offline';
    expect((await store.removeGlobalWord('Mine')).ok).toBe(false);
    expect(store.globalVocabulary).toEqual(['OrgWord', 'Mine']);
  });

  it('a sync that returns after the account switched is discarded', async () => {
    const store = useTranscriptionSettingsStore();
    await store.loadGlobalSettings();
    await settle(store);
    h.server.user = ['FromU1'];
    const pending = store.syncFromServer({ force: true });
    h.auth.user = { id: 'u2' };
    await pending;
    expect(store.globalVocabulary).not.toContain('FromU1');
  });
});
