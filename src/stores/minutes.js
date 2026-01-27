/**
 * Minutes Store - Manages user's free/bonus transcription minutes
 *
 * This store tracks:
 * - freeMinutes: Initial free minutes (60 for new users)
 * - bonusMinutes: Admin-assigned bonus minutes
 * - usedMinutes: Total minutes consumed
 * - remainingMinutes: Available minutes for recording
 */

import { defineStore } from 'pinia';
import { getUserMinutes } from '../services/api';

// Cache duration for minutes data (1 hour)
const CACHE_DURATION_MS = 60 * 60 * 1000;

export const useMinutesStore = defineStore('minutes', {
  state: () => ({
    freeMinutes: 0,
    bonusMinutes: 0,
    usedMinutes: 0,
    loading: false,
    error: null,
    lastFetchedAt: null
  }),

  getters: {
    /**
     * Total available minutes (free + bonus - used)
     */
    remainingMinutes: (state) => {
      const remaining = state.freeMinutes + state.bonusMinutes - state.usedMinutes;
      return Math.max(0, remaining);
    },

    /**
     * Remaining minutes converted to seconds (for recording limit)
     */
    remainingSeconds: (state) => {
      const remaining = state.freeMinutes + state.bonusMinutes - state.usedMinutes;
      return Math.max(0, Math.floor(remaining * 60));
    },

    /**
     * Whether user has any minutes remaining
     */
    hasMinutesRemaining: (state) => {
      const remaining = state.freeMinutes + state.bonusMinutes - state.usedMinutes;
      return remaining > 0;
    },

    /**
     * Check if cached data is still valid
     */
    isCacheValid: (state) => {
      if (!state.lastFetchedAt) return false;
      return Date.now() - state.lastFetchedAt < CACHE_DURATION_MS;
    },

    /**
     * Total minutes allocated (free + bonus)
     */
    totalMinutes: (state) => {
      return state.freeMinutes + state.bonusMinutes;
    },

    /**
     * Usage percentage (0-100)
     */
    usagePercentage: (state) => {
      const total = state.freeMinutes + state.bonusMinutes;
      if (total === 0) return 100;
      return Math.min(100, (state.usedMinutes / total) * 100);
    }
  },

  actions: {
    /**
     * Fetch user's minutes from the server
     * @param {string} token - Auth token
     * @param {boolean} force - Force refresh even if cache is valid
     */
    async fetchMinutes(token, force = false) {
      // Skip if cache is valid and not forcing refresh
      if (!force && this.isCacheValid) {
        return { success: true, cached: true };
      }

      if (!token) {
        this.error = 'Not authenticated';
        return { success: false, error: 'Not authenticated' };
      }

      this.loading = true;
      this.error = null;

      try {
        const data = await getUserMinutes(token);

        this.freeMinutes = data.freeMinutes || 0;
        this.bonusMinutes = data.bonusMinutes || 0;
        this.usedMinutes = data.usedMinutes || 0;
        this.lastFetchedAt = Date.now();

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
     * Update minutes after recording (optimistic update)
     * Server will deduct actual minutes after transcription
     * @param {number} durationSeconds - Recording duration in seconds
     */
    deductMinutesLocally(durationSeconds) {
      const minutesToDeduct = durationSeconds / 60;
      this.usedMinutes += minutesToDeduct;
    },

    /**
     * Sync with server after transcription completes
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
      return this.remainingSeconds >= durationSeconds;
    },

    /**
     * Get maximum recording duration allowed
     * @returns {number} Maximum seconds user can record
     */
    getMaxRecordingDuration() {
      return this.remainingSeconds;
    },

    /**
     * Reset store state (on logout)
     */
    reset() {
      this.freeMinutes = 0;
      this.bonusMinutes = 0;
      this.usedMinutes = 0;
      this.loading = false;
      this.error = null;
      this.lastFetchedAt = null;
    },

    /**
     * Set minutes data directly (for testing or initialization)
     */
    setMinutes({ freeMinutes, bonusMinutes, usedMinutes }) {
      if (freeMinutes !== undefined) this.freeMinutes = freeMinutes;
      if (bonusMinutes !== undefined) this.bonusMinutes = bonusMinutes;
      if (usedMinutes !== undefined) this.usedMinutes = usedMinutes;
      this.lastFetchedAt = Date.now();
    }
  }
});
