/**
 * Minutes Store - Manages user's transcription minutes balance
 *
 * Tracks the server-provided minutes shape:
 * - remaining: Minutes left (or -1 for unlimited)
 * - unlimited: Whether user has unlimited minutes (enterprise)
 * - total: Total allocated minutes (or -1 for unlimited)
 * - used: Total minutes consumed
 *
 * Auto-refreshes every 60 seconds while authenticated.
 */

import { defineStore } from 'pinia';
import { authenticatedRequest, API_ENDPOINTS } from '../services/api';

// Auto-refresh interval (60 seconds)
const REFRESH_INTERVAL_MS = 60 * 1000;

let refreshTimer = null;

export const useMinutesStore = defineStore('minutes', {
  state: () => ({
    remaining: 0,
    unlimited: false,
    total: 0,
    used: 0,
    loading: false,
    error: null,
    lastFetchedAt: null
  }),

  getters: {
    /**
     * Remaining minutes for display (0 if unlimited, clamped to 0 minimum)
     */
    remainingMinutes: (state) => {
      if (state.unlimited) return Infinity;
      return Math.max(0, state.remaining);
    },

    /**
     * Remaining seconds (for recording limit checks)
     */
    remainingSeconds: (state) => {
      if (state.unlimited) return Infinity;
      return Math.max(0, Math.floor(state.remaining * 60));
    },

    /**
     * Whether user has any minutes remaining (always true for unlimited)
     */
    hasMinutesRemaining: (state) => {
      if (state.unlimited) return true;
      return state.remaining > 0;
    },

    /**
     * Total allocated minutes
     */
    totalMinutes: (state) => {
      if (state.unlimited) return Infinity;
      return state.total;
    },

    /**
     * Usage percentage (0-100), 0 for unlimited users
     */
    usagePercentage: (state) => {
      if (state.unlimited || state.total <= 0) return 0;
      return Math.min(100, (state.used / state.total) * 100);
    }
  },

  actions: {
    /**
     * Set minutes data directly from a server response (login or refresh).
     * Also restarts the auto-refresh timer.
     * @param {{ remaining: number, unlimited: boolean, total: number, used: number }} data
     */
    setFromServer(data) {
      if (!data) return;
      this.remaining = data.remaining ?? 0;
      this.unlimited = data.unlimited ?? false;
      this.total = data.total ?? 0;
      this.used = data.used ?? 0;
      this.lastFetchedAt = Date.now();
      this.error = null;
    },

    /**
     * Fetch minutes from the server via GET /api/desktop/minutes
     * @param {string} token - Auth token
     * @param {boolean} force - Force refresh even if recently fetched
     */
    async fetchMinutes(token, force = false) {
      // Skip if fetched within the last 10 seconds and not forcing
      if (!force && this.lastFetchedAt && (Date.now() - this.lastFetchedAt < 10000)) {
        return { success: true, cached: true };
      }

      if (!token) {
        this.error = 'Not authenticated';
        return { success: false, error: 'Not authenticated' };
      }

      this.loading = true;
      this.error = null;

      try {
        const response = await authenticatedRequest(API_ENDPOINTS.desktopMinutes, token);
        if (!response.ok) {
          // Handle 401 — attempt token refresh and retry once
          if (response.status === 401) {
            try {
              const { useAuthStore } = await import('./auth');
              const authStore = useAuthStore();
              const refreshResult = await authStore.handleAuthError();
              if (refreshResult.success) {
                const retryResponse = await authenticatedRequest(API_ENDPOINTS.desktopMinutes, authStore.token);
                if (retryResponse.ok) {
                  const retryData = await retryResponse.json();
                  this.setFromServer(retryData);
                  return { success: true };
                }
              }
              if (refreshResult.shouldLogout) {
                return { success: false, error: 'Session expired' };
              }
            } catch (refreshErr) {
              console.warn('Token refresh failed during fetchMinutes:', refreshErr);
            }
          }
          const data = await response.json();
          throw new Error(data.error || 'Failed to fetch minutes');
        }
        const data = await response.json();
        this.setFromServer(data);
        return { success: true };
      } catch (error) {
        console.error('Failed to fetch minutes:', error);
        this.error = error.message;
        return { success: false, error: error.message };
      } finally {
        this.loading = false;
      }
    },

    /**
     * Start auto-refresh polling (every 60 seconds)
     * @param {Function} getToken - Function that returns the current auth token
     */
    startAutoRefresh(getToken) {
      this.stopAutoRefresh();
      refreshTimer = setInterval(async () => {
        // Skip fetch when app is backgrounded or offline to avoid wasted requests
        try {
          const { useRecordingStore } = await import('./recording');
          const recordingStore = useRecordingStore();
          if (recordingStore.appInBackground || !recordingStore.networkConnected) return;
        } catch {
          // Fallback for desktop: check document visibility and navigator.onLine
          if (document.hidden || !navigator.onLine) return;
        }

        const token = typeof getToken === 'function' ? getToken() : getToken;
        if (token) {
          await this.fetchMinutes(token, true);
        }
      }, REFRESH_INTERVAL_MS);
    },

    /**
     * Stop auto-refresh polling
     */
    stopAutoRefresh() {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    },

    /**
     * Sync with server (force refresh)
     * @param {string} token - Auth token
     */
    async syncWithServer(token) {
      return this.fetchMinutes(token, true);
    },

    /**
     * Check if user can record for specified duration
     * @param {number} durationSeconds - Intended recording duration
     * @returns {boolean}
     */
    canRecordFor(durationSeconds) {
      if (this.unlimited) return true;
      return this.remainingSeconds >= durationSeconds;
    },

    /**
     * Get maximum recording duration allowed
     * @returns {number} Maximum seconds user can record
     */
    getMaxRecordingDuration() {
      if (this.unlimited) return Infinity;
      return this.remainingSeconds;
    },

    /**
     * Reset store state (on logout)
     */
    reset() {
      this.stopAutoRefresh();
      this.remaining = 0;
      this.unlimited = false;
      this.total = 0;
      this.used = 0;
      this.loading = false;
      this.error = null;
      this.lastFetchedAt = null;
    }
  }
});
