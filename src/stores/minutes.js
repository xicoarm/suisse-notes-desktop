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
import { authenticatedRequest, readJson, apiErrorFromResponse, ApiResponseError, API_ENDPOINTS } from '../services/api';

// Auto-refresh interval (60 seconds)
const REFRESH_INTERVAL_MS = 60 * 1000;
const MINUTES_CACHE_KEY = 'minutes_cache';

let refreshTimer = null;
// The fetch in flight, per token ({ token, promise }); a different token
// (another account, a refreshed session) never shares it.
let inflightFetch = null;
// Bumped by reset() (logout): an answer for the previous session that lands
// afterwards is dropped instead of becoming the next user's balance.
let fetchGeneration = 0;

/**
 * True only when the server said so in this session: a balance answered by
 * the server (lastFetchedAt set) that is really used up.
 *
 * WHY: the balance starts at 0 (or yesterday's cached value) until the first
 * fetch answers. SSO and registration did not fetch it, the Record page gave
 * the fetch 3 seconds and the Upload page never asked - so brand-new accounts
 * were told "no minutes left" (10/2026). An unknown balance never blocks: the
 * server decides when the recording is uploaded.
 */
export function isKnownOutOfMinutes(state) {
  if (!state || state.lastFetchedAt == null || state.unlimited) return false;
  return !(state.remaining > 0);
}

/**
 * Auto-stop limit for a recording, in seconds, or null for none.
 * A recording is never cut by an unconfirmed balance: the cached value can
 * be yesterday's (minutes bought since), so only a balance the server
 * answered in this session sets a limit. `alreadyRecordedSeconds` extends it
 * on resume (same rule as before: the balance is deducted after upload).
 */
export function recordingCapSeconds(state, alreadyRecordedSeconds = 0) {
  if (!state || state.lastFetchedAt == null || state.unlimited) return null;
  const remaining = Math.max(0, Math.floor(Number(state.remaining) * 60));
  if (!(remaining > 0)) return null;
  return remaining + Math.max(0, Number(alreadyRecordedSeconds) || 0);
}

/** True only when a server-confirmed balance is below `minutes`. */
export function isKnownBelow(state, minutes) {
  if (!state || state.lastFetchedAt == null || state.unlimited) return false;
  return Math.max(0, state.remaining) < minutes;
}

// Persist minutes to localStorage so offline recording works
function _cacheMinutes(data) {
  try {
    localStorage.setItem(MINUTES_CACHE_KEY, JSON.stringify({
      remaining: data.remaining,
      unlimited: data.unlimited,
      total: data.total,
      used: data.used,
      cachedAt: Date.now()
    }));
  } catch { /* ignore */ }
}

function _loadCachedMinutes() {
  try {
    const raw = localStorage.getItem(MINUTES_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export const useMinutesStore = defineStore('minutes', {
  state: () => {
    // Load cached minutes immediately so offline users have a balance
    const cached = _loadCachedMinutes();
    return {
      remaining: cached?.remaining ?? 0,
      unlimited: cached?.unlimited ?? false,
      total: cached?.total ?? 0,
      used: cached?.used ?? 0,
      loading: false,
      error: null,
      // Set only by a server answer in THIS session; the cached balance
      // (cachedAt) is shown but never treated as confirmed.
      lastFetchedAt: null,
      cachedAt: cached ? cached.cachedAt : null
    };
  },

  getters: {
    /** Server-confirmed in this session that no minutes are left. */
    knownOutOfMinutes: (state) => isKnownOutOfMinutes(state),

    /** Whether the balance shown was answered by the server in this session. */
    balanceKnown: (state) => state.lastFetchedAt != null,

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
      // Handle both naming conventions (remaining vs remainingMinutes)
      const remaining = data.remaining ?? data.remainingMinutes ?? 0;
      const total = data.total ?? data.totalMinutes ?? 0;
      this.used = data.used ?? data.usedMinutes ?? 0;
      // Treat -1 as unlimited (enterprise convention) even if unlimited flag is missing
      this.unlimited = data.unlimited || remaining === -1 || total === -1
        || (data.freeMinutes != null && data.freeMinutes === -1);
      this.remaining = remaining;
      this.total = total;
      this.lastFetchedAt = Date.now();
      this.cachedAt = this.lastFetchedAt;
      this.error = null;

      // Cache to localStorage so offline recording works
      _cacheMinutes(this.$state);
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

      // One request at a time per session: sign-in, the layout's auth watcher
      // and the Record page can all ask within the same second.
      if (inflightFetch && inflightFetch.token === token) return inflightFetch.promise;
      const entry = { token, promise: null };
      entry.promise = this._fetchMinutesNow(token, fetchGeneration)
        .finally(() => { if (inflightFetch === entry) inflightFetch = null; });
      inflightFetch = entry;
      return entry.promise;
    },

    /** Apply a server answer unless the session was reset since the request went out. */
    _applyIfCurrent(data, generation) {
      if (generation !== fetchGeneration) return { success: false, stale: true };
      this.setFromServer(data);
      return { success: true };
    },

    async _fetchMinutesNow(token, generation = fetchGeneration) {
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
                  return this._applyIfCurrent(await readJson(retryResponse), generation);
                }
              }
              if (refreshResult.shouldLogout) {
                return { success: false, error: 'Session expired' };
              }
            } catch (refreshErr) {
              if (refreshErr instanceof ApiResponseError) throw refreshErr;
              console.warn('Token refresh failed during fetchMinutes:', refreshErr);
            }
          }
          throw await apiErrorFromResponse(response, 'Failed to fetch minutes');
        }
        return this._applyIfCurrent(await readJson(response), generation);
      } catch (error) {
        // An HTTP answer (gateway page during a backend restart, 5xx, 4xx) or
        // a network failure keeps the cached balance; the next tick retries.
        // Failed HTTP answers other than 502-504 already reach Sentry through
        // the HTTP-client integration, so they are not reported twice.
        // Anything else is a bug in this code path.
        const isExpected = error instanceof ApiResponseError
          || error?.name === 'TypeError'
          || error?.name === 'TimeoutError'
          || (typeof navigator !== 'undefined' && !navigator.onLine);
        if (isExpected) {
          console.warn('Minutes refresh skipped (server/network unavailable, keeping cached balance):', error.message);
        } else {
          console.error('Failed to fetch minutes:', error);
        }
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
      // Drop the previous session's request: its answer must not land in
      // the next user's balance, and a new token must not share it.
      fetchGeneration += 1;
      inflightFetch = null;
      this.remaining = 0;
      this.unlimited = false;
      this.total = 0;
      this.used = 0;
      this.loading = false;
      this.error = null;
      this.lastFetchedAt = null;
      this.cachedAt = null;
      try { localStorage.removeItem(MINUTES_CACHE_KEY); } catch { /* ignore */ }
    }
  }
});
