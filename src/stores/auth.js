import { defineStore } from 'pinia';

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
        // Simplified: No URL parameter - uses hardcoded backend
        const result = await window.electronAPI.auth.login(username, password);

        if (result.success) {
          this.user = result.user;
          this.token = result.token;
          this.isAuthenticated = true;

          // Save minutes from login response
          if (result.minutes) {
            this.minutes = result.minutes;
          }

          // Save token and user info securely
          await window.electronAPI.auth.saveToken(result.token);
          await window.electronAPI.auth.saveUserInfo(result.user);

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
        const result = await window.electronAPI.auth.register(email, password, name);

        if (result.success) {
          this.user = result.user;
          this.token = result.token;
          this.isAuthenticated = true;

          // Save token and user info securely
          await window.electronAPI.auth.saveToken(result.token);
          await window.electronAPI.auth.saveUserInfo(result.user);

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
        await window.electronAPI.auth.clearToken();
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
        const token = await window.electronAPI.auth.getToken();
        const userInfo = await window.electronAPI.auth.getUserInfo();

        if (token && userInfo) {
          this.token = token;
          this.user = userInfo;
          this.isAuthenticated = true;

          // Fetch minutes on session restore
          this.fetchMinutes();
          this.startMinutesRefresh();
        } else if (token) {
          // Token exists but no user info - clear and require re-login
          console.warn('Token found but no user info - requiring re-login');
          await window.electronAPI.auth.clearToken();
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
        const result = await window.electronAPI.minutes.fetch();
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
