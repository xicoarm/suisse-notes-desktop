import { defineStore } from 'pinia';
import { isElectron, isCapacitor } from '../utils/platform';
import { getApiUrlSync, API_ENDPOINTS } from '../services/api';
import { useMinutesStore } from './minutes';

// Capacitor Preferences (lazy loaded)
let Preferences = null;

const initPreferences = async () => {
  if (isCapacitor() && !Preferences) {
    const module = await import('@capacitor/preferences');
    Preferences = module.Preferences;
  }
};

// Token refresh state to prevent concurrent refresh attempts
let isRefreshing = false;
let refreshPromise = null;
let refreshTimer = null;

// Token lifetime constants (in milliseconds)
const TOKEN_REFRESH_MARGIN = 5 * 60 * 1000; // Refresh 5 minutes before expiry
const TOKEN_CHECK_INTERVAL = 60 * 1000; // Check every minute
const RECORDING_KEEP_ALIVE_INTERVAL = 30 * 60 * 1000; // Refresh every 30 min while recording

// Mobile device info cache for analytics
let cachedDeviceInfo = null;

const getMobileDeviceInfo = async () => {
  if (cachedDeviceInfo) return cachedDeviceInfo;
  try {
    const { Device } = await import('@capacitor/device');
    const { App } = await import('@capacitor/app');
    const [deviceInfo, appInfo] = await Promise.all([Device.getId(), App.getInfo()]);
    const platform = window.Capacitor?.getPlatform?.() || 'unknown';
    // Use 'mob_' prefix for hardware-based device ID (enables trial abuse prevention)
    // Android: ANDROID_ID persists across reinstalls
    // iOS: UUID changes on reinstall (less effective, but still helps)
    cachedDeviceInfo = {
      deviceId: deviceInfo.identifier ? `mob_${deviceInfo.identifier}` : `mobile_${Date.now()}`,
      platform,
      appVersion: appInfo.version || 'unknown'
    };
  } catch {
    cachedDeviceInfo = {
      deviceId: `mobile_${Date.now()}`,
      platform: window.Capacitor?.getPlatform?.() || 'unknown',
      appVersion: 'unknown'
    };
  }
  return cachedDeviceInfo;
};

// Auth analytics - Non-blocking, fail-silent
const trackAuthEvent = (eventType, { userId, userEmail, errorReason, errorCode } = {}) => {
  getMobileDeviceInfo().then(info => {
    const maskedEmail = userEmail
      ? `${userEmail[0]}***${userEmail.includes('@') ? '@' + userEmail.split('@')[1] : ''}`
      : null;

    fetch(`${getApiUrlSync()}/api/analytics/auth-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType,
        ...info,
        userId,
        userEmail: maskedEmail,
        timestamp: new Date().toISOString(),
        errorReason,
        errorCode
      })
    }).catch(() => {}); // Fail silently
  });
};

// Mobile auth helpers
const mobileAuth = {
  async login(username, password) {
    const apiUrl = getApiUrlSync();
    try {
      const deviceInfo = await getMobileDeviceInfo();
      const response = await fetch(`${apiUrl}/api/auth/desktop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: username,
          password,
          deviceId: deviceInfo.deviceId,
          platform: deviceInfo.platform,
          appVersion: deviceInfo.appVersion
        })
      });

      const data = await response.json();

      if (response.ok && data.token) {
        trackAuthEvent('login_success', {
          userId: data.user?.id,
          userEmail: username
        });
        return {
          success: true,
          token: data.token,
          user: data.user || { email: username, name: username }
        };
      }

      const errorMsg = data.error || data.message || 'Login failed';
      trackAuthEvent('login_failed', {
        userEmail: username,
        errorReason: errorMsg
      });
      return { success: false, error: errorMsg };
    } catch (error) {
      console.error('Login network error:', error);
      // Provide more helpful error message for network issues
      let errorMsg;
      if (error.message === 'Failed to fetch' || error.name === 'TypeError') {
        errorMsg = 'Unable to connect to server. Please check your internet connection and try again.';
      } else {
        errorMsg = error.message || 'Network error during login';
      }
      trackAuthEvent('login_failed', {
        userEmail: username,
        errorReason: errorMsg,
        errorCode: error.name
      });
      return { success: false, error: errorMsg };
    }
  },

  async register(email, password, name) {
    const apiUrl = getApiUrlSync();
    try {
      const deviceInfo = await getMobileDeviceInfo();
      const response = await fetch(`${apiUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          name,
          deviceId: deviceInfo.deviceId,
          platform: deviceInfo.platform,
          appVersion: deviceInfo.appVersion
        })
      });

      const data = await response.json();

      if (response.ok && data.token) {
        trackAuthEvent('registration_success', {
          userId: data.user?.id,
          userEmail: email
        });
        return {
          success: true,
          token: data.token,
          user: data.user || { email, name }
        };
      }

      const errorMsg = data.error || data.message || 'Registration failed';
      trackAuthEvent('registration_failed', {
        userEmail: email,
        errorReason: errorMsg
      });
      return { success: false, error: errorMsg };
    } catch (error) {
      console.error('Registration network error:', error);
      // Provide more helpful error message for network issues
      let errorMsg;
      if (error.message === 'Failed to fetch' || error.name === 'TypeError') {
        errorMsg = 'Unable to connect to server. Please check your internet connection and try again.';
      } else {
        errorMsg = error.message || 'Network error during registration';
      }
      trackAuthEvent('registration_failed', {
        userEmail: email,
        errorReason: errorMsg,
        errorCode: error.name
      });
      return { success: false, error: errorMsg };
    }
  },

  async saveToken(token) {
    await initPreferences();
    if (Preferences) {
      await Preferences.set({ key: 'auth_token', value: token });
    }
  },

  async getToken() {
    await initPreferences();
    if (Preferences) {
      const { value } = await Preferences.get({ key: 'auth_token' });
      return value;
    }
    return null;
  },

  async clearToken() {
    await initPreferences();
    if (Preferences) {
      await Preferences.remove({ key: 'auth_token' });
      await Preferences.remove({ key: 'user_info' });
    }
  },

  async saveUserInfo(userInfo) {
    await initPreferences();
    if (Preferences) {
      await Preferences.set({ key: 'user_info', value: JSON.stringify(userInfo) });
    }
  },

  async getUserInfo() {
    await initPreferences();
    if (Preferences) {
      const { value } = await Preferences.get({ key: 'user_info' });
      return value ? JSON.parse(value) : null;
    }
    return null;
  }
};

// Get the appropriate auth implementation
const getAuth = () => {
  if (isElectron() && window.electronAPI?.auth) {
    return window.electronAPI.auth;
  }
  return mobileAuth;
};

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    token: null,
    isAuthenticated: false,
    sessionChecked: false,
    loading: false,
    error: null
  }),

  actions: {
    async login(username, password) {
      this.loading = true;
      this.error = null;

      try {
        const auth = getAuth();
        const result = await auth.login(username, password);

        if (result.success) {
          // CRITICAL SECURITY FIX: Clear any existing tokens FIRST to prevent user mixup
          // This ensures we never have a stale token from a previous user session
          try {
            await auth.clearToken();
          } catch (clearError) {
            console.warn('Could not clear existing token:', clearError);
          }

          // Save the new token and verify it was saved correctly
          const saveResult = await auth.saveToken(result.token);
          if (!saveResult || !saveResult.success) {
            console.error('CRITICAL: Failed to save auth token:', saveResult?.error);
            this.error = 'Failed to save login credentials. Please try again.';
            return { success: false, error: this.error };
          }

          // Verify the token was actually saved by reading it back
          const savedToken = await auth.getToken();
          if (!savedToken) {
            console.error('CRITICAL: Token save verification failed - token not persisted');
            this.error = 'Failed to persist login. Please try again.';
            return { success: false, error: this.error };
          }

          // Save user info
          const userInfoResult = await auth.saveUserInfo(result.user);
          if (!userInfoResult || !userInfoResult.success) {
            console.warn('Failed to save user info:', userInfoResult?.error);
            // Don't fail login for this, but log it
          }

          // Only set authenticated state AFTER token is verified saved
          this.user = result.user;
          this.token = result.token;
          this.isAuthenticated = true;

          // Start proactive token refresh
          this.startTokenRefreshTimer();

          // Fetch user's minutes balance
          const minutesStore = useMinutesStore();
          minutesStore.fetchMinutes(result.token).catch(err => {
            console.warn('Failed to fetch minutes on login:', err);
          });

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
        const auth = getAuth();
        const result = await auth.register(email, password, name);

        if (result.success) {
          // CRITICAL SECURITY FIX: Clear any existing tokens FIRST to prevent user mixup
          try {
            await auth.clearToken();
          } catch (clearError) {
            console.warn('Could not clear existing token:', clearError);
          }

          // Save the new token and verify it was saved correctly
          const saveResult = await auth.saveToken(result.token);
          if (!saveResult || !saveResult.success) {
            console.error('CRITICAL: Failed to save auth token:', saveResult?.error);
            this.error = 'Failed to save registration credentials. Please try again.';
            return { success: false, error: this.error };
          }

          // Verify the token was actually saved by reading it back
          const savedToken = await auth.getToken();
          if (!savedToken) {
            console.error('CRITICAL: Token save verification failed - token not persisted');
            this.error = 'Failed to persist registration. Please try again.';
            return { success: false, error: this.error };
          }

          // Save user info
          const userInfoResult = await auth.saveUserInfo(result.user);
          if (!userInfoResult || !userInfoResult.success) {
            console.warn('Failed to save user info:', userInfoResult?.error);
          }

          // Only set authenticated state AFTER token is verified saved
          this.user = result.user;
          this.token = result.token;
          this.isAuthenticated = true;

          // Start proactive token refresh
          this.startTokenRefreshTimer();

          // Fetch user's minutes balance (new users get 60 free minutes)
          const minutesStore = useMinutesStore();
          minutesStore.fetchMinutes(result.token).catch(err => {
            console.warn('Failed to fetch minutes on register:', err);
          });

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
      // Stop token refresh timer
      this.stopTokenRefreshTimer();

      // Track logout event (mobile only - desktop tracks in clearToken handler)
      if (isCapacitor()) {
        trackAuthEvent('logout', { userId: this.user?.id, userEmail: this.user?.email });
      }

      try {
        const auth = getAuth();
        await auth.clearToken();
      } catch (error) {
        console.error('Error clearing token:', error);
      }

      // Clear history store to prevent data leaks between users
      if (isElectron()) {
        const { useRecordingsHistoryStore } = await import('./recordings-history');
        const historyStore = useRecordingsHistoryStore();
        historyStore.reset();
      }

      // Clear minutes store
      const minutesStore = useMinutesStore();
      minutesStore.reset();

      this.user = null;
      this.token = null;
      this.isAuthenticated = false;
      this.error = null;
    },

    async checkSession() {
      try {
        const auth = getAuth();
        const token = await auth.getToken();
        const userInfo = await auth.getUserInfo();

        if (token && userInfo) {
          this.token = token;
          this.user = userInfo;
          this.isAuthenticated = true;

          // Start proactive token refresh for existing session
          this.startTokenRefreshTimer();

          // Fetch user's minutes balance
          const minutesStore = useMinutesStore();
          minutesStore.fetchMinutes(token).catch(err => {
            console.warn('Failed to fetch minutes on session restore:', err);
          });
        } else if (token) {
          console.warn('Token found but no user info - requiring re-login');
          await auth.clearToken();
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
     * Refresh the authentication token
     * Handles concurrent refresh requests by reusing a single promise
     * @returns {Promise<{success: boolean, token?: string, error?: string}>}
     */
    async refreshToken() {
      // If already refreshing, wait for the existing refresh to complete
      if (isRefreshing && refreshPromise) {
        return refreshPromise;
      }

      if (!this.token) {
        return { success: false, error: 'No token to refresh' };
      }

      isRefreshing = true;
      refreshPromise = this._doRefreshToken();

      try {
        return await refreshPromise;
      } finally {
        isRefreshing = false;
        refreshPromise = null;
      }
    },

    /**
     * Internal token refresh implementation
     * Note: If refresh endpoint returns 404, this means the server doesn't support
     * token refresh and user needs to re-login
     */
    async _doRefreshToken() {
      const apiUrl = getApiUrlSync();
      try {
        const response = await fetch(`${apiUrl}${API_ENDPOINTS.refreshToken}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token}`
          }
        });

        // If endpoint doesn't exist (404), token refresh is not supported
        if (response.status === 404) {
          console.warn('Token refresh endpoint not available - re-login required');
          return { success: false, error: 'Session expired. Please log in again.' };
        }

        const data = await response.json();

        if (response.ok && data.token) {
          const auth = getAuth();
          this.token = data.token;
          await auth.saveToken(data.token);

          // Update user info if provided
          if (data.user) {
            this.user = data.user;
            await auth.saveUserInfo(data.user);
          }

          console.log('Token refreshed successfully');
          return { success: true, token: data.token };
        }

        // Token refresh failed - user needs to re-login
        console.warn('Token refresh failed:', data.error || data.message);
        return { success: false, error: data.error || data.message || 'Token refresh failed' };
      } catch (error) {
        console.error('Token refresh network error:', error);
        // On network error, don't clear auth - might be temporary
        return { success: false, error: 'Network error during token refresh' };
      }
    },

    /**
     * Get a valid token, refreshing if necessary
     * Use this before making authenticated API calls
     * @returns {Promise<{token: string | null, error?: string}>}
     */
    async getValidToken() {
      if (!this.token) {
        return { token: null, error: 'Not authenticated' };
      }

      // Try to validate/refresh the token
      // For now, we'll just return the current token
      // The caller should handle 401 responses by calling refreshToken
      return { token: this.token };
    },

    /**
     * Handle an authentication error (401 response)
     * Attempts to refresh the token, or logs out if refresh fails
     * @returns {Promise<{success: boolean, token?: string, shouldLogout: boolean}>}
     */
    async handleAuthError() {
      const refreshResult = await this.refreshToken();

      if (refreshResult.success) {
        return { success: true, token: refreshResult.token, shouldLogout: false };
      }

      // If refresh failed with "Token expired" or similar, user needs to re-login
      const nonRetryableErrors = ['Token expired', 'Invalid token', 'Unauthorized', 'Token revoked'];
      const shouldLogout = nonRetryableErrors.some(err =>
        (refreshResult.error || '').toLowerCase().includes(err.toLowerCase())
      );

      if (shouldLogout) {
        await this.logout();
      }

      return { success: false, shouldLogout, error: refreshResult.error };
    },

    clearError() {
      this.error = null;
    },

    /**
     * Parse JWT to extract expiration time
     * @returns {number | null} Expiration timestamp in ms, or null if invalid
     */
    getTokenExpiration() {
      if (!this.token) return null;

      try {
        const parts = this.token.split('.');
        if (parts.length !== 3) return null;

        const payload = JSON.parse(atob(parts[1]));
        if (payload.exp) {
          return payload.exp * 1000; // Convert to milliseconds
        }
        return null;
      } catch (e) {
        console.warn('Could not parse token expiration:', e);
        return null;
      }
    },

    /**
     * Check if token is expired or about to expire
     * @returns {boolean}
     */
    isTokenExpiringSoon() {
      const expiration = this.getTokenExpiration();
      if (!expiration) return true; // Assume expired if can't parse

      const now = Date.now();
      return (expiration - now) < TOKEN_REFRESH_MARGIN;
    },

    /**
     * Start proactive token refresh timer
     * Automatically refreshes token before it expires
     */
    startTokenRefreshTimer() {
      this.stopTokenRefreshTimer();

      // Initial check
      this._checkAndRefreshToken();

      // Set up periodic check
      refreshTimer = setInterval(() => {
        this._checkAndRefreshToken();
      }, TOKEN_CHECK_INTERVAL);

      console.log('Token refresh timer started');
    },

    /**
     * Stop the token refresh timer
     */
    stopTokenRefreshTimer() {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
        console.log('Token refresh timer stopped');
      }
    },

    /**
     * Internal: Check if token needs refresh and do it
     */
    async _checkAndRefreshToken() {
      if (!this.isAuthenticated || !this.token) return;

      if (this.isTokenExpiringSoon()) {
        console.log('Token expiring soon, proactively refreshing...');
        const result = await this.refreshToken();

        if (!result.success) {
          console.warn('Proactive token refresh failed:', result.error);
          // If refresh completely failed and token is actually expired, auto-logout
          const expiration = this.getTokenExpiration();
          if (expiration && Date.now() > expiration) {
            console.warn('Token has expired, auto-logging out');
            await this.forceLogout('Your session has expired. Please log in again.');
          }
        }
      }
    },

    /**
     * Keep session alive while recording
     * Called periodically during active recordings
     */
    async keepAliveForRecording() {
      if (!this.isAuthenticated || !this.token) return;

      // Force refresh to ensure session stays valid during long recordings
      console.log('Keep-alive refresh for active recording');
      const result = await this.refreshToken();

      if (!result.success) {
        console.warn('Keep-alive refresh failed:', result.error);
        // Don't logout during recording - just warn
        // The recording is saved locally, so user can upload after re-login
      }

      return result;
    },

    /**
     * Force logout with optional message (for auto-logout scenarios)
     */
    async forceLogout(message = null) {
      this.stopTokenRefreshTimer();

      try {
        const auth = getAuth();
        await auth.clearToken();
      } catch (error) {
        console.error('Error clearing token:', error);
      }

      // Clear history store
      if (isElectron()) {
        const { useRecordingsHistoryStore } = await import('./recordings-history');
        const historyStore = useRecordingsHistoryStore();
        historyStore.reset();
      }

      // Clear minutes store
      const minutesStore = useMinutesStore();
      minutesStore.reset();

      this.user = null;
      this.token = null;
      this.isAuthenticated = false;
      this.error = message;

      // Navigate to login (if router available)
      // The route guard will handle this, but we can also emit an event
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('auth:forceLogout', {
          detail: { message }
        }));
      }
    }
  }
});
