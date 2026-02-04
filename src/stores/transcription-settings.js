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

export const useTranscriptionSettingsStore = defineStore('transcription-settings', {
  state: () => ({
    // Global defaults (persisted via electron-store)
    globalVocabulary: [],        // Array of strings
    defaultSpeakerCount: null,   // null = auto-detect

    // Per-session values (reset after each recording/upload)
    sessionTitle: '',
    sessionSpeakerCount: null,
    sessionVocabulary: [],

    // Loading state
    loaded: false
  }),

  getters: {
    // Combines global + session words (unique)
    mergedVocabulary: (state) => {
      const combined = [...state.globalVocabulary, ...state.sessionVocabulary];
      return [...new Set(combined)];
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
    // Load global settings from local storage, then sync from server
    async loadGlobalSettings() {
      if (this.loaded) return;

      try {
        // Load local settings first (fast)
        if (isElectron() && window.electronAPI?.config?.getTranscriptionSettings) {
          const settings = await window.electronAPI.config.getTranscriptionSettings();
          if (settings) {
            this.globalVocabulary = settings.vocabulary || [];
            this.defaultSpeakerCount = settings.defaultSpeakerCount ?? null;
          }
        } else if (isCapacitor()) {
          await initPreferences();
          if (Preferences) {
            const { value } = await Preferences.get({ key: 'transcription_settings' });
            if (value) {
              const settings = JSON.parse(value);
              this.globalVocabulary = settings.vocabulary || [];
              this.defaultSpeakerCount = settings.defaultSpeakerCount ?? null;
            }
          }
        }
        this.loaded = true;

        // Then sync from server (non-blocking)
        this.syncFromServer();
      } catch (error) {
        console.error('Error loading transcription settings:', error);
        this.loaded = true;
      }
    },

    // Sync vocabulary from server (merges org + user spellings)
    async syncFromServer() {
      try {
        const authStore = useAuthStore();
        if (!authStore.token) return;

        const data = await getMergedSpellings(authStore.token);
        if (data?.spellings && Array.isArray(data.spellings)) {
          // Merge server spellings with local, deduplicate
          const merged = [...new Set([...this.globalVocabulary, ...data.spellings])];
          this.globalVocabulary = merged;
          this.saveGlobalSettings();
        }
      } catch (error) {
        console.warn('Could not sync spellings from server:', error.message);
      }
    },

    // Save global settings to storage
    async saveGlobalSettings() {
      try {
        const settings = {
          vocabulary: this.globalVocabulary,
          defaultSpeakerCount: this.defaultSpeakerCount
        };

        if (isElectron() && window.electronAPI?.config?.setTranscriptionSettings) {
          await window.electronAPI.config.setTranscriptionSettings(settings);
        } else if (isCapacitor()) {
          await initPreferences();
          if (Preferences) {
            await Preferences.set({ key: 'transcription_settings', value: JSON.stringify(settings) });
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

    // Global vocabulary management
    addGlobalWord(word) {
      const trimmed = word.trim();
      if (trimmed && !this.globalVocabulary.includes(trimmed)) {
        this.globalVocabulary.push(trimmed);
        this.saveGlobalSettings();

        // Sync to server (non-blocking)
        const authStore = useAuthStore();
        if (authStore.token) {
          addUserSpellings(authStore.token, [trimmed]).catch(err =>
            console.warn('Could not sync spelling to server:', err.message)
          );
        }
      }
    },

    removeGlobalWord(word) {
      const index = this.globalVocabulary.indexOf(word);
      if (index > -1) {
        this.globalVocabulary.splice(index, 1);
        this.saveGlobalSettings();

        // Sync to server (non-blocking)
        const authStore = useAuthStore();
        if (authStore.token) {
          removeUserSpelling(authStore.token, word).catch(err =>
            console.warn('Could not sync spelling removal to server:', err.message)
          );
        }
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
    }
  }
});
