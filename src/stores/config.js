import { defineStore } from 'pinia';

// Hardcoded production URL - no user configuration
const API_URL = 'https://app.suisse-notes.ch';

export const useConfigStore = defineStore('config', {
  state: () => ({
    apiUrl: API_URL,
    deviceId: '',
    loaded: false
  }),

  getters: {
    // Always configured - production only
    isConfigured: () => true
  },

  actions: {
    async loadConfig() {
      try {
        const config = await window.electronAPI.config.get();
        this.deviceId = config.deviceId || '';
        this.apiUrl = config.apiUrl || API_URL;
        this.loaded = true;
      } catch (error) {
        console.error('Failed to load config:', error);
        this.loaded = true;
      }
    }
  }
});
