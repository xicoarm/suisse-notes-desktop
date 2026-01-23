import { defineStore } from 'pinia';

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
    // Load global settings from electron store
    async loadGlobalSettings() {
      if (this.loaded) return;

      try {
        const settings = await window.electronAPI.config.getTranscriptionSettings();
        if (settings) {
          this.globalVocabulary = settings.vocabulary || [];
          this.defaultSpeakerCount = settings.defaultSpeakerCount ?? null;
        }
        this.loaded = true;
      } catch (error) {
        console.error('Error loading transcription settings:', error);
        this.loaded = true;
      }
    },

    // Save global settings to electron store
    async saveGlobalSettings() {
      try {
        await window.electronAPI.config.setTranscriptionSettings({
          vocabulary: this.globalVocabulary,
          defaultSpeakerCount: this.defaultSpeakerCount
        });
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
      }
    },

    removeGlobalWord(word) {
      const index = this.globalVocabulary.indexOf(word);
      if (index > -1) {
        this.globalVocabulary.splice(index, 1);
        this.saveGlobalSettings();
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
