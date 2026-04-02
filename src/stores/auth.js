import { defineStore } from 'pinia';
import { isElectron, isCapacitor, getPlatform } from '../utils/platform';
import { storeToken, getToken, clearToken, storeUserCredentials, getUserCredentials, clearAllCredentials } from '../services/secureStorage';
import { apiRequest, authenticatedRequest, API_ENDPOINTS } from '../services/api';
import { addBreadcrumb, captureException, setUser } from '../boot/sentry';

/**
 * P1 Fix: Resume pending mobile uploads after successful authentication.
 * Uploads may have failed with 401 while the user was logged out or token was expired.
 */
async function resumeMobileUploadQueue(authStore) {
  if (!isCapacitor()) return;
  try {
    const { processMobileUploadQueue, getMobileUploadQueue } = await import('../services/upload');
    const { getApiUrlSync } = await import('../services/api');
    const queue = getMobileUploadQueue();
    if (queue.length > 0) {
      console.log(`Auth: Resuming ${queue.length} pending mobile upload(s) after authentication`);
      processMobileUploadQueue(authStore, getApiUrlSync).catch(e =>
        console.warn('Auth: Failed to resume mobile upload queue:', e)
      );
    }
  } catch (e) {
    console.warn('Auth: Could not resume mobile uploads:', e);
  }
}

/**
 * Platform-aware auth helpers.
 * On Electron, login/register go through IPC (main process makes the HTTP call).
 * On Capacitor/web, we call the backend directly via fetch.
 */
async function platformLogin(username, password) {
  const platform = getPlatform();
  addBreadcrumb({ category: 'auth', message: `Login attempt on ${platform}`, level: 'info' });

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
    addBreadcrumb({ category: 'auth', message: `Login failed: ${data.error || response.status}`, level: 'warning' });
    return { success: false, error: data.error || 'Login failed' };
  }
  addBreadcrumb({ category: 'auth', message: 'Login successful', level: 'info' });
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

// Token refresh interval: 6 hours
const TOKEN_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    token: null,
    isAuthenticated: false,
    sessionChecked: false,  // Track if initial session check is complete
    loading: false,
    error: null,
    _refreshPromise: null,  // Mutex for token refresh (prevents concurrent stampede)
    _tokenRefreshInterval: null,
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

          // Save token and user info securely
          await platformSaveToken(result.token);
          await platformSaveUserInfo(result.user);

          // Set Sentry user context
          setUser(result.user);

          // Seed minutes store from login response
          if (result.minutes) {
            const { useMinutesStore } = await import('./minutes');
            const minutesStore = useMinutesStore();
            minutesStore.setFromServer(result.minutes);
          }

          // Start periodic token refresh
          this.startTokenRefresh();

          // Reload device store for this user (user-scoped BLE pairings)
          try {
            const { useDeviceStore } = await import('./device');
            const deviceStore = useDeviceStore();
            await deviceStore.reloadForUser();
          } catch (e) {
            console.warn('Device store reload after login failed:', e);
          }

          // P1 Fix: Resume any pending uploads that failed while logged out
          resumeMobileUploadQueue(this);

          return { success: true };
        } else {
          this.error = result.error || 'Login failed';
          return { success: false, error: this.error };
        }
      } catch (error) {
        captureException(error, { tags: { action: 'login' } });
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

          // Start periodic token refresh
          this.startTokenRefresh();

          // Reload device store for this new user
          try {
            const { useDeviceStore } = await import('./device');
            const deviceStore = useDeviceStore();
            await deviceStore.reloadForUser();
          } catch (e) {
            console.warn('Device store reload after register failed:', e);
          }

          // P1 Fix: Resume any pending uploads after registration
          resumeMobileUploadQueue(this);

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
      // Disconnect BLE and clear device state BEFORE clearing user
      // (must happen while user.id is still available for scoped keys)
      try {
        const { useDeviceStore } = await import('./device');
        const deviceStore = useDeviceStore();
        await deviceStore.onLogout();
      } catch (error) {
        console.warn('Error cleaning up device store on logout:', error);
      }

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

      // Reset minutes store (stops its auto-refresh timer)
      const { useMinutesStore } = await import('./minutes');
      const minutesStore = useMinutesStore();
      minutesStore.reset();

      // Stop token refresh
      this.stopTokenRefresh();

      // Clear Sentry user context
      setUser(null);

      this.user = null;
      this.token = null;
      this.isAuthenticated = false;
      this.error = null;
      this._refreshPromise = null;
    },

    /**
     * Force logout with event dispatch for MainLayout navigation.
     * @param {string} message - Reason for force logout
     */
    async forceLogout(message) {
      await this.logout();
      window.dispatchEvent(new CustomEvent('auth:forceLogout', {
        detail: { message: message || 'Session expired' }
      }));
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

          // Set Sentry user context on session restore
          setUser(userInfo);

          // Reload device store for this user (user-scoped BLE pairings)
          try {
            const { useDeviceStore } = await import('./device');
            const deviceStore = useDeviceStore();
            await deviceStore.reloadForUser();
          } catch (e) {
            console.warn('Device store reload after session restore failed:', e);
          }

          // Start periodic token refresh
          this.startTokenRefresh();
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

    /**
     * Handle 401/auth errors — refresh token or force logout.
     * Deduplicates concurrent calls via _refreshPromise mutex.
     * Called from minutes store, upload service, RecordPage, HistoryPage, UploadPage.
     * @returns {{ success: boolean, token?: string, shouldLogout?: boolean }}
     */
    async handleAuthError() {
      // If a refresh is already in flight, return the same promise
      if (this._refreshPromise) {
        return this._refreshPromise;
      }

      this._refreshPromise = this._doTokenRefresh()
        .then((result) => {
          this._refreshPromise = null;
          if (result.success) {
            return { success: true, token: result.token };
          }
          // Refresh failed — force logout
          this.forceLogout('Your session has expired. Please log in again.');
          return { success: false, shouldLogout: true };
        })
        .catch((err) => {
          this._refreshPromise = null;
          console.error('Token refresh error:', err);
          this.forceLogout('Your session has expired. Please log in again.');
          return { success: false, shouldLogout: true };
        });

      return this._refreshPromise;
    },

    /**
     * Internal: perform the actual token refresh via platform-appropriate method.
     * @returns {{ success: boolean, token?: string, user?: object }}
     */
    async _doTokenRefresh() {
      if (!this.token && !this.isAuthenticated) {
        return { success: false };
      }

      try {
        let result;

        if (isElectron()) {
          // Electron: use IPC handler (main process has the encrypted token)
          result = await window.electronAPI.auth.refreshToken();
        } else {
          // Mobile / web: direct fetch
          const response = await authenticatedRequest(API_ENDPOINTS.refreshToken, this.token, {
            method: 'POST'
          });
          if (!response.ok) {
            return { success: false };
          }
          result = await response.json();
          // Normalize: direct API returns { token, user } at top level
          result = { success: true, token: result.token, user: result.user };
        }

        if (result.success && result.token) {
          // Update store state
          this.token = result.token;
          if (result.user) {
            this.user = result.user;
            await platformSaveUserInfo(result.user);
          }
          // Persist new token
          await platformSaveToken(result.token);

          addBreadcrumb({ category: 'auth', message: 'Token refreshed successfully', level: 'info' });

          // P1 Fix: Resume uploads that may have failed with expired token
          resumeMobileUploadQueue(this);

          return { success: true, token: result.token };
        }

        return { success: false };
      } catch (error) {
        console.warn('Token refresh failed:', error);
        return { success: false };
      }
    },

    /**
     * Start periodic token refresh (every 6 hours).
     * Silent — does not force logout on failure (next API call will handle that).
     */
    startTokenRefresh() {
      this.stopTokenRefresh();
      this._tokenRefreshInterval = setInterval(() => {
        if (this.isAuthenticated) {
          this._doTokenRefresh().catch((err) => {
            console.warn('Periodic token refresh failed (will retry):', err);
          });
        }
      }, TOKEN_REFRESH_INTERVAL_MS);
    },

    /**
     * Stop periodic token refresh.
     */
    stopTokenRefresh() {
      if (this._tokenRefreshInterval) {
        clearInterval(this._tokenRefreshInterval);
        this._tokenRefreshInterval = null;
      }
    },

    clearError() {
      this.error = null;
    }
  }
});
