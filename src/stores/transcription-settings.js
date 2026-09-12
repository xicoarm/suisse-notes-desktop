import { defineStore } from 'pinia';
import { isElectron, isCapacitor } from '../utils/platform';
import { getMergedSpellings, addUserSpellings, removeUserSpelling } from '../services/api';
import { useAuthStore } from './auth';

// Capacitor Preferences (lazy loaded)
let Preferences = null;

const initPreferences = async () => {
  if (isCapacitor() && !Preferences) {
    const module = await import('@capacitor/preferences');
    Preferences = module.Preferences;
  }
};

/**
 * Custom vocabulary: the SERVER list is the truth.
 *
 * Until 3.9.37 the phone treated its saved copy as the master list: it only
 * added the server's words on top of it (words deleted or renamed on the web
 * never disappeared), asked the server at most once per app process (Android
 * resumes the same process for days), kept the copy under one key for every
 * account on the phone, and swallowed failed edits. Now:
 * - the server's merged list replaces the local one on every sync;
 * - sync runs on every page open that needs the list and on app foreground,
 *   at most every 30 s (forced right after an edit);
 * - the saved copy is per user (offline fallback only) and cleared on logout;
 * - an edit the server refused is rolled back and reported to the caller;
 * - organization words are read-only here (the personal route cannot delete them).
 */
const SYNC_MIN_INTERVAL_MS = 30_000;
const LEGACY_KEY = 'transcription_settings';
const keyForUser = (userId) => (userId ? `${LEGACY_KEY}:u${userId}` : null);

let syncInFlight = null;
const pendingAdds = new Set();
const pendingRemoves = new Set();

const currentUserId = () => {
  try {
    const auth = useAuthStore();
    return auth.user?.id ? String(auth.user.id) : null;
  } catch {
    return null;
  }
};

export const useTranscriptionSettingsStore = defineStore('transcription-settings', {
  state: () => ({
    // Global defaults (server list, saved per user as the offline fallback)
    globalVocabulary: [],        // Array of strings — merged organization + personal words
    orgVocabulary: [],           // organization words (read-only in the app)
    userVocabulary: [],          // personal words
    defaultSpeakerCount: null,   // null = auto-detect

    // Per-session values (reset after each recording/upload)
    sessionTitle: '',
    sessionSpeakerCount: null,
    sessionVocabulary: [],

    // Loading state
    loaded: false,
    loadedForUser: null,
    lastSyncedAt: 0
  }),

  getters: {
    // Combines global + session words (unique)
    mergedVocabulary: (state) => {
      const combined = [...state.globalVocabulary, ...state.sessionVocabulary];
      return [...new Set(combined)];
    },

    // Words the user can remove (everything except organization-only words)
    personalVocabulary: (state) => {
      const org = new Set(state.orgVocabulary);
      const user = new Set(state.userVocabulary);
      return state.globalVocabulary.filter((w) => !org.has(w) || user.has(w));
    },

    // Organization words not also on the personal list (shown locked)
    organizationOnlyVocabulary: (state) => {
      const user = new Set(state.userVocabulary);
      return state.orgVocabulary.filter((w) => !user.has(w) && state.globalVocabulary.includes(w));
    },

    // Session value takes precedence, then global default
    effectiveSpeakerCount: (state) => {
      return state.sessionSpeakerCount ?? state.defaultSpeakerCount;
    },

    // Get transcription options for upload
    transcriptionOptions: (state) => {
      return {
        title: state.sessionTitle || null,
        speakerCount: state.sessionSpeakerCount ?? state.defaultSpeakerCount,
        customVocabulary: [...new Set([...state.globalVocabulary, ...state.sessionVocabulary])]
      };
    }
  },

  actions: {
    /**
     * Load the saved copy for the signed-in user (fast, offline fallback), then
     * refresh from the server (non-blocking, throttled).
     */
    async loadGlobalSettings({ force = false } = {}) {
      const userId = currentUserId();
      if (!this.loaded || this.loadedForUser !== userId) {
        try {
          let settings = null;
          if (isElectron() && window.electronAPI?.config?.getTranscriptionSettings) {
            settings = await window.electronAPI.config.getTranscriptionSettings();
          } else if (isCapacitor()) {
            await initPreferences();
            if (Preferences) {
              const key = keyForUser(userId);
              const { value } = key ? await Preferences.get({ key }) : { value: null };
              if (value) {
                settings = JSON.parse(value);
              } else {
                // The pre-3.9.38 copy was shared by every account on the phone:
                // keep only the speaker default from it, never its words.
                const legacy = await Preferences.get({ key: LEGACY_KEY });
                if (legacy?.value) {
                  const parsed = JSON.parse(legacy.value);
                  settings = { defaultSpeakerCount: parsed?.defaultSpeakerCount ?? null };
                }
              }
            }
          }
          this.globalVocabulary = Array.isArray(settings?.vocabulary) ? [...settings.vocabulary] : [];
          this.orgVocabulary = Array.isArray(settings?.orgVocabulary) ? [...settings.orgVocabulary] : [];
          this.userVocabulary = Array.isArray(settings?.userVocabulary) ? [...settings.userVocabulary] : [];
          this.defaultSpeakerCount = settings?.defaultSpeakerCount ?? null;
          this.lastSyncedAt = 0;
        } catch (error) {
          console.error('Error loading transcription settings:', error);
        }
        this.loaded = true;
        this.loadedForUser = userId;
      }

      // Then sync from server (non-blocking)
      this.syncFromServer({ force });
    },

    /**
     * Replace the vocabulary with the server's merged list (organization +
     * personal). Concurrent calls share one request; unforced calls run at most
     * every 30 seconds.
     */
    async syncFromServer({ force = false } = {}) {
      if (syncInFlight) {
        if (!force) return syncInFlight;
        try { await syncInFlight; } catch { /* the forced sync below retries */ }
      }
      if (!force && this.lastSyncedAt && Date.now() - this.lastSyncedAt < SYNC_MIN_INTERVAL_MS) return;
      const authStore = useAuthStore();
      if (!authStore.token) return;
      const userAtStart = currentUserId();

      syncInFlight = (async () => {
        try {
          const data = await getMergedSpellings(authStore.token);
          if (!Array.isArray(data?.spellings)) {
            console.warn('Custom vocabulary sync: unexpected response shape', Object.keys(data || {}));
            return;
          }
          // Signed out or switched account while the request ran → discard.
          if (currentUserId() !== userAtStart) return;
          let list = [...new Set(data.spellings.filter((w) => typeof w === 'string' && w.trim()))];
          for (const word of pendingAdds) if (!list.includes(word)) list.push(word);
          list = list.filter((word) => !pendingRemoves.has(word));
          this.globalVocabulary = list;
          this.orgVocabulary = Array.isArray(data.orgSpellings) ? [...data.orgSpellings] : [];
          this.userVocabulary = Array.isArray(data.userSpellings) ? [...data.userSpellings] : [];
          this.lastSyncedAt = Date.now();
          await this.saveGlobalSettings();
        } catch (error) {
          console.warn('Could not sync spellings from server:', error.message);
        } finally {
          syncInFlight = null;
        }
      })();
      return syncInFlight;
    },

    // Save global settings to storage (plain arrays: Electron IPC cannot clone reactive proxies)
    async saveGlobalSettings() {
      try {
        const settings = {
          vocabulary: [...this.globalVocabulary],
          orgVocabulary: [...this.orgVocabulary],
          userVocabulary: [...this.userVocabulary],
          defaultSpeakerCount: this.defaultSpeakerCount
        };

        if (isElectron() && window.electronAPI?.config?.setTranscriptionSettings) {
          await window.electronAPI.config.setTranscriptionSettings(settings);
        } else if (isCapacitor()) {
          await initPreferences();
          const key = keyForUser(this.loadedForUser || currentUserId());
          if (Preferences && key) {
            await Preferences.set({ key, value: JSON.stringify(settings) });
          }
        }
      } catch (error) {
        console.error('Error saving transcription settings:', error);
      }
    },

    // Set session-specific options
    setSessionOptions({ title, speakerCount, vocabulary }) {
      if (title !== undefined) this.sessionTitle = title;
      if (speakerCount !== undefined) this.sessionSpeakerCount = speakerCount;
      if (vocabulary !== undefined) this.sessionVocabulary = vocabulary;
    },

    // Reset session values after recording/upload
    resetSession() {
      this.sessionTitle = '';
      this.sessionSpeakerCount = null;
      this.sessionVocabulary = [];
    },

    /**
     * Add a personal word: shown immediately, saved on the server, rolled back
     * when the server refuses (offline, 401, the 200-term limit).
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async addGlobalWord(word) {
      const trimmed = String(word || '').trim();
      if (!trimmed || this.globalVocabulary.includes(trimmed)) return { ok: true };
      this.globalVocabulary.push(trimmed);
      const authStore = useAuthStore();
      if (!authStore.token) return { ok: true };
      pendingAdds.add(trimmed);
      try {
        await addUserSpellings(authStore.token, [trimmed]);
        pendingAdds.delete(trimmed);
        await this.syncFromServer({ force: true });
        return { ok: true };
      } catch (err) {
        pendingAdds.delete(trimmed);
        const index = this.globalVocabulary.indexOf(trimmed);
        if (index > -1 && !this.userVocabulary.includes(trimmed) && !this.orgVocabulary.includes(trimmed)) {
          this.globalVocabulary.splice(index, 1);
        }
        console.warn('Could not save spelling on the server:', err.message);
        return { ok: false, error: err.message };
      }
    },

    /**
     * Remove a personal word. Organization words cannot be removed from the app.
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async removeGlobalWord(word) {
      const index = this.globalVocabulary.indexOf(word);
      if (index === -1) return { ok: true };
      if (this.orgVocabulary.includes(word) && !this.userVocabulary.includes(word)) {
        return { ok: false, error: 'organization' };
      }
      this.globalVocabulary.splice(index, 1);
      const authStore = useAuthStore();
      if (!authStore.token) return { ok: true };
      pendingRemoves.add(word);
      try {
        await removeUserSpelling(authStore.token, word);
        pendingRemoves.delete(word);
        await this.syncFromServer({ force: true });
        return { ok: true };
      } catch (err) {
        pendingRemoves.delete(word);
        if (!this.globalVocabulary.includes(word)) this.globalVocabulary.splice(Math.min(index, this.globalVocabulary.length), 0, word);
        console.warn('Could not remove spelling on the server:', err.message);
        return { ok: false, error: err.message };
      }
    },

    // Set default speaker count
    setDefaultSpeakerCount(count) {
      this.defaultSpeakerCount = count;
      this.saveGlobalSettings();
    },

    // Session vocabulary management
    addSessionWord(word) {
      const trimmed = word.trim();
      if (trimmed && !this.sessionVocabulary.includes(trimmed) && !this.globalVocabulary.includes(trimmed)) {
        this.sessionVocabulary.push(trimmed);
      }
    },

    removeSessionWord(word) {
      const index = this.sessionVocabulary.indexOf(word);
      if (index > -1) {
        this.sessionVocabulary.splice(index, 1);
      }
    },

    /** Logout: forget the signed-in user's words (the next account starts from its own). */
    reset() {
      pendingAdds.clear();
      pendingRemoves.clear();
      this.globalVocabulary = [];
      this.orgVocabulary = [];
      this.userVocabulary = [];
      this.defaultSpeakerCount = null;
      this.resetSession();
      this.loaded = false;
      this.loadedForUser = null;
      this.lastSyncedAt = 0;
    }
  }
});
