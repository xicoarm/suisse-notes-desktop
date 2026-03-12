import { defineStore } from 'pinia';
import { isElectron } from '../utils/platform';
import { storeToken, getToken, clearToken, storeUserCredentials, getUserCredentials, clearAllCredentials } from '../services/secureStorage';
import { apiRequest, authenticatedRequest, API_ENDPOINTS } from '../services/api';

/**
 * Platform-aware auth helpers.
 * On Electron, login/register go through IPC (main process makes the HTTP call).
 * On Capacitor/web, we call the backend directly via fetch.
 */
async function platformLogin(username, password) {
  if (isElectron()) {
    return window.electronAPI.auth.login(username, password);
  }
  // Mobile / web: direct fetch
  const response = await apiRequest(API_ENDPOINTS.login, {
    method: 'POST',
    body: JSON.stringify({ email: username, password })
  });
  const data = await response.json();
  if (!response.ok) {
    return { success: false, error: data.error || 'Login failed' };
  }
  return { success: true, token: data.token, user: data.user, minutes: data.minutes };
}

async function platformRegister(email, password, name) {
  if (isElectron()) {
    return window.electronAPI.auth.register(email, password, name);
  }
  const response = await apiRequest(API_ENDPOINTS.register, {
    method: 'POST',
    body: JSON.stringify({ email, password, name })
  });
  const data = await response.json();
  if (!response.ok) {
    return { success: false, error: data.error || 'Registration failed' };
  }
  return { success: true, token: data.token, user: data.user };
}

async function platformSaveToken(token) {
  if (isElectron()) {
    return window.electronAPI.auth.saveToken(token);
  }
  return storeToken(token);
}

async function platformGetToken() {
  if (isElectron()) {
    const result = await window.electronAPI.auth.getToken();
    return result?.token || result || null;
  }
  return getToken();
}

async function platformClearToken() {
  if (isElectron()) {
    return window.electronAPI.auth.clearToken();
  }
  return clearAllCredentials();
}

async function platformSaveUserInfo(userInfo) {
  if (isElectron()) {
    return window.electronAPI.auth.saveUserInfo(userInfo);
  }
  return storeUserCredentials(userInfo);
}

async function platformGetUserInfo() {
  if (isElectron()) {
    const result = await window.electronAPI.auth.getUserInfo();
    return result || null;
  }
  return getUserCredentials();
}

async function platformFetchMinutes(token) {
  if (isElectron()) {
    return window.electronAPI.minutes.fetch();
  }
  // Mobile / web: direct fetch
  try {
    const response = await authenticatedRequest(API_ENDPOINTS.desktopMinutes, token);
    if (!response.ok) {
      return { success: false };
    }
    const data = await response.json();
    return { success: true, minutes: data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    token: null,
    isAuthenticated: false,
    sessionChecked: false,  // Track if initial session check is complete
    loading: false,
    error: null,
    // Minutes / credits
    minutes: null,  // { remaining, unlimited, total, used }
    minutesLoading: false,
    _minutesInterval: null,
  }),

  actions: {
    async login(username, password) {
      this.loading = true;
      this.error = null;

      try {
        const result = await platformLogin(username, password);

        if (result.success) {
          this.user = result.user;
          this.token = result.token;
          this.isAuthenticated = true;

          // Save minutes from login response
          if (result.minutes) {
            this.minutes = result.minutes;
          }

          // Save token and user info securely
          await platformSaveToken(result.token);
          await platformSaveUserInfo(result.user);

          // Start periodic minutes refresh
          this.startMinutesRefresh();

          return { success: true };
        } else {
          this.error = result.error || 'Login failed';
          return { success: false, error: this.error };
        }
      } catch (error) {
        this.error = error.message || 'An unexpected error occurred';
        return { success: false, error: this.error };
      } finally {
        this.loading = false;
      }
    },

    async register(email, password, name) {
      this.loading = true;
      this.error = null;

      try {
        const result = await platformRegister(email, password, name);

        if (result.success) {
          this.user = result.user;
          this.token = result.token;
          this.isAuthenticated = true;

          // Save token and user info securely
          await platformSaveToken(result.token);
          await platformSaveUserInfo(result.user);

          // Fetch minutes after registration and start refresh
          this.fetchMinutes();
          this.startMinutesRefresh();

          return { success: true };
        } else {
          this.error = result.error || 'Registration failed';
          return { success: false, error: this.error };
        }
      } catch (error) {
        this.error = error.message || 'An unexpected error occurred';
        return { success: false, error: this.error };
      } finally {
        this.loading = false;
      }
    },

    async logout() {
      try {
        await platformClearToken();
      } catch (error) {
        console.error('Error clearing token:', error);
      }

      // Clear history store to prevent data leaks between users
      // Using dynamic import to avoid circular dependency
      const { useRecordingsHistoryStore } = await import('./recordings-history');
      const historyStore = useRecordingsHistoryStore();
      historyStore.reset();

      // Stop minutes refresh
      this.stopMinutesRefresh();

      this.user = null;
      this.token = null;
      this.isAuthenticated = false;
      this.error = null;
      this.minutes = null;
    },

    async checkSession() {
      try {
        const token = await platformGetToken();
        const userInfo = await platformGetUserInfo();

        // On mobile, getUserCredentials returns {} (empty object) when nothing is stored
        const hasUserInfo = userInfo && Object.keys(userInfo).length > 0;

        if (token && hasUserInfo) {
          this.token = token;
          this.user = userInfo;
          this.isAuthenticated = true;

          // Fetch minutes on session restore
          this.fetchMinutes();
          this.startMinutesRefresh();
        } else if (token) {
          // Token exists but no user info - clear and require re-login
          console.warn('Token found but no user info - requiring re-login');
          await platformClearToken();
          this.isAuthenticated = false;
        }
      } catch (error) {
        console.error('Error checking session:', error);
        this.isAuthenticated = false;
      } finally {
        this.sessionChecked = true;
      }
    },

    async fetchMinutes() {
      if (!this.isAuthenticated) return;
      this.minutesLoading = true;
      try {
        const result = await platformFetchMinutes(this.token);
        if (result.success && result.minutes) {
          this.minutes = result.minutes;
        }
      } catch (error) {
        console.warn('Could not fetch minutes:', error);
      } finally {
        this.minutesLoading = false;
      }
    },

    startMinutesRefresh() {
      this.stopMinutesRefresh();
      // Refresh minutes every 60 seconds
      this._minutesInterval = setInterval(() => {
        if (this.isAuthenticated) {
          this.fetchMinutes();
        }
      }, 60000);
    },

    stopMinutesRefresh() {
      if (this._minutesInterval) {
        clearInterval(this._minutesInterval);
        this._minutesInterval = null;
      }
    },

    clearError() {
      this.error = null;
    }
  }
});
