import { defineStore } from 'pinia';
import { isElectron } from '../utils/platform';

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
        if (isElectron() && window.electronAPI?.config?.get) {
          const config = await window.electronAPI.config.get();
          this.deviceId = config.deviceId || '';
          this.apiUrl = config.apiUrl || API_URL;
        } else {
          // Mobile: use hardcoded values
          this.apiUrl = API_URL;
          this.deviceId = 'mobile-' + Date.now();
        }
        this.loaded = true;
      } catch (error) {
        console.error('Failed to load config:', error);
        this.loaded = true;
      }
    }
  }
});
