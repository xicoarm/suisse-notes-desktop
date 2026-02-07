import { defineStore } from 'pinia';
import { useAuthStore } from './auth';
import { useRecordingStore } from './recording';
import { isElectron, isCapacitor } from '../utils/platform';
import { getApiUrlSync } from '../services/api';

// localStorage cache helpers for mobile
const CACHE_KEY = 'recordings_history_cache';
const PREF_KEY = 'recordings_storage_preference';

function _getCachedRecordings(userId) {
  try {
    const raw = localStorage.getItem(`${CACHE_KEY}_${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function _setCachedRecordings(userId, recordings) {
  try {
    localStorage.setItem(`${CACHE_KEY}_${userId}`, JSON.stringify(recordings));
  } catch (e) {
    console.warn('Failed to cache recordings to localStorage:', e);
  }
}

function _getCachedPreference() {
  try {
    return localStorage.getItem(PREF_KEY) || 'keep';
  } catch {
    return 'keep';
  }
}

function _setCachedPreference(preference) {
  try {
    localStorage.setItem(PREF_KEY, preference);
  } catch (e) {
    console.warn('Failed to cache storage preference:', e);
  }
}

// Helper for authenticated server API calls
async function _serverFetch(endpoint, options = {}) {
  const authStore = useAuthStore();
  const baseUrl = getApiUrlSync();
  const url = `${baseUrl}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authStore.token}`,
      ...options.headers
    }
  });

  if (!response.ok) {
    throw new Error(`Server returned ${response.status}`);
  }

  return response.json();
}

export const useRecordingsHistoryStore = defineStore('recordings-history', {
  state: () => ({
    recordings: [],
    defaultStoragePreference: 'keep', // 'keep' or 'delete_after_upload'
    loaded: false,
    loading: false
  }),

  getters: {
    // Get all recordings
    allRecordings: (state) => state.recordings,

    // Get recordings by status
    pendingRecordings: (state) =>
      state.recordings.filter(r => r.uploadStatus === 'pending'),

    uploadedRecordings: (state) =>
      state.recordings.filter(r => r.uploadStatus === 'uploaded'),

    failedRecordings: (state) =>
      state.recordings.filter(r => r.uploadStatus === 'failed'),

    inProgressRecordings: (state) =>
      state.recordings.filter(r => r.uploadStatus === 'recording'),

    // Get recording count
    recordingCount: (state) => state.recordings.length,

    // Get a specific recording by ID
    getRecordingById: (state) => (id) =>
      state.recordings.find(r => r.id === id),

    // Check if should show storage dialog
    shouldShowStorageDialog: (state) =>
      state.defaultStoragePreference === null
  },

  actions: {
    // Helper to get current user ID with fallback chain
    // When forWrite is true, skip the localStorage fallback to prevent cross-user data attribution
    _getUserId(fallbackUserId = null, { forWrite = false } = {}) {
      const authStore = useAuthStore();
      const userId = authStore.user?.id || authStore.user?.userId || null;

      if (userId) {
        // Cache for future use when auth may be unavailable
        try { localStorage.setItem('last_known_user_id', userId); } catch (e) { /* ignore */ }
        return userId;
      }

      // Fallback: use provided userId (e.g. from recording object)
      if (fallbackUserId) return fallbackUserId;

      // Last resort: use cached userId from localStorage (read-only operations only)
      if (!forWrite) {
        try { return localStorage.getItem('last_known_user_id'); } catch (e) { return null; }
      }

      return null;
    },

    // Load recordings (platform-aware)
    async loadRecordings() {
      if (this.loading) return;

      const userId = this._getUserId();
      if (!userId) {
        console.warn('No userId available, cannot load recordings');
        this.recordings = [];
        this.loaded = true;
        return;
      }

      if (isElectron()) {
        // Desktop: load from Electron store
        try {
          this.loading = true;
          this.recordings = await window.electronAPI.history.getAll(userId);
          this.defaultStoragePreference =
            await window.electronAPI.history.getDefaultStoragePreference();
          this.loaded = true;
        } catch (error) {
          console.error('Error loading recordings history:', error);
        } finally {
          this.loading = false;
        }
      } else {
        // Mobile/Web: load from server API, fall back to localStorage cache
        try {
          this.loading = true;

          // Load cached recordings immediately for fast UI
          this.recordings = _getCachedRecordings(userId);
          this.defaultStoragePreference = _getCachedPreference();
          this.loaded = true;

          // Then fetch from server and update
          const data = await _serverFetch('/api/desktop/history');
          if (data.recordings) {
            this.recordings = data.recordings;
            _setCachedRecordings(userId, data.recordings);
          } else if (Array.isArray(data)) {
            this.recordings = data;
            _setCachedRecordings(userId, data);
          }
        } catch (error) {
          console.warn('Could not fetch history from server, using cache:', error);
          // Cache already loaded above, so UI still works
        } finally {
          this.loading = false;
        }
      }
    },

    // Add a new recording to history (with userId) — idempotent: if ID exists, delegates to updateRecording
    async addRecording(recording) {
      try {
        const userId = this._getUserId(recording?.userId, { forWrite: true });
        if (!userId) {
          console.error('SECURITY: Cannot add recording without userId');
          return { success: false, error: 'Not authenticated' };
        }

        // Idempotent: if a recording with the same ID already exists, update it instead
        if (recording.id && this.recordings.find(r => r.id === recording.id)) {
          const { id, ...updates } = recording;
          return this.updateRecording(id, updates);
        }

        // Add userId to recording
        const recordingWithUser = { ...recording, userId };

        if (isElectron()) {
          const result = await window.electronAPI.history.add(recordingWithUser);
          if (result.success) {
            this.recordings.unshift(result.recording);
            return { success: true, recording: result.recording };
          }
          return { success: false, error: result.error };
        } else {
          // Mobile/Web: POST to server, update local cache
          try {
            const data = await _serverFetch('/api/desktop/history', {
              method: 'POST',
              body: JSON.stringify(recordingWithUser)
            });

            const saved = data.recording || recordingWithUser;
            this.recordings.unshift(saved);
            _setCachedRecordings(userId, this.recordings);
            return { success: true, recording: saved };
          } catch (error) {
            // Server failed — save to local cache only so history isn't lost
            console.warn('Could not save recording to server, caching locally:', error);
            this.recordings.unshift(recordingWithUser);
            _setCachedRecordings(userId, this.recordings);
            return { success: true, recording: recordingWithUser };
          }
        }
      } catch (error) {
        console.error('Error adding recording to history:', error);
        return { success: false, error: error.message };
      }
    },

    // Update a recording in history (with userId check)
    async updateRecording(id, updates) {
      try {
        // Try to get userId from the existing recording as fallback
        const existing = this.recordings.find(r => r.id === id);
        const userId = this._getUserId(existing?.userId || updates?.userId, { forWrite: true });
        if (!userId) {
          console.error('SECURITY: Cannot update recording without userId');
          return { success: false, error: 'Not authenticated' };
        }

        if (isElectron()) {
          const result = await window.electronAPI.history.update(id, updates, userId);
          if (result.success) {
            const index = this.recordings.findIndex(r => r.id === id);
            if (index !== -1) {
              this.recordings[index] = { ...this.recordings[index], ...updates };
            }
            return { success: true };
          }
          return { success: false, error: result.error };
        } else {
          // Mobile/Web: update locally and try server
          const index = this.recordings.findIndex(r => r.id === id);
          if (index !== -1) {
            this.recordings[index] = { ...this.recordings[index], ...updates };
          }
          _setCachedRecordings(userId, this.recordings);

          try {
            await _serverFetch(`/api/desktop/recording/${id}`, {
              method: 'PATCH',
              body: JSON.stringify(updates)
            });
          } catch (error) {
            console.warn('Could not update recording on server:', error);
          }

          return { success: true };
        }
      } catch (error) {
        console.error('Error updating recording:', error);
        return { success: false, error: error.message };
      }
    },

    // Delete a recording from history (with userId check)
    async deleteRecording(id, deleteFile = false) {
      try {
        const userId = this._getUserId(null, { forWrite: true });
        if (!userId) {
          console.error('SECURITY: Cannot delete recording without userId');
          return { success: false, error: 'Not authenticated' };
        }

        if (isElectron()) {
          const result = await window.electronAPI.history.delete(id, deleteFile, userId);
          if (result.success) {
            this.recordings = this.recordings.filter(r => r.id !== id);
            return { success: true };
          }
          return { success: false, error: result.error };
        } else {
          // Mobile/Web: remove locally and try server
          this.recordings = this.recordings.filter(r => r.id !== id);
          _setCachedRecordings(userId, this.recordings);

          try {
            await _serverFetch(`/api/desktop/recording/${id}`, {
              method: 'DELETE'
            });
          } catch (error) {
            console.warn('Could not delete recording on server:', error);
          }

          return { success: true };
        }
      } catch (error) {
        console.error('Error deleting recording:', error);
        return { success: false, error: error.message };
      }
    },

    // Reset store state (call on logout to prevent data leaks)
    reset() {
      this.recordings = [];
      this.loaded = false;
      this.loading = false;
    },

    // Set default storage preference
    async setDefaultStoragePreference(preference) {
      try {
        if (isElectron()) {
          await window.electronAPI.history.setDefaultStoragePreference(preference);
        } else {
          _setCachedPreference(preference);
        }
        this.defaultStoragePreference = preference;
        return { success: true };
      } catch (error) {
        console.error('Error setting storage preference:', error);
        return { success: false, error: error.message };
      }
    },

    // Mark recording as uploaded (and optionally delete file)
    async markAsUploaded(id, transcriptionId = null, audioFileId = null, canDelete = true) {
      const recording = this.recordings.find(r => r.id === id);

      const updates = {
        uploadStatus: 'uploaded',
        transcriptionId,
        audioFileId
      };

      await this.updateRecording(id, updates);

      // P0 Data Loss Fix: Check file locking before deletion
      // If storage preference is delete_after_upload, delete the file ONLY if safe
      // File deletion only applies to Electron (mobile files are managed differently)
      if (isElectron() && recording && recording.storagePreference === 'delete_after_upload') {
        const recordingStore = useRecordingStore();

        // Only delete if canDelete flag is true AND file is not locked
        if (canDelete && recordingStore.canDelete(id)) {
          try {
            await window.electronAPI.recording.deleteRecording(id);
            // Update file path to indicate deletion
            await this.updateRecording(id, { filePath: null });
            // Unlock file after successful deletion
            recordingStore.unlockFile(id);
          } catch (e) {
            console.warn('Could not delete file after upload:', e);
          }
        } else {
          console.warn('File not deleted: upload not verified or file is locked');
        }
      }
    },

    // Mark recording as failed
    async markAsFailed(id, error = null) {
      await this.updateRecording(id, {
        uploadStatus: 'failed',
        uploadError: error
      });
    },

    // Format file size for display
    formatFileSize(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let unitIndex = 0;
      let size = bytes;

      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }

      return `${size.toFixed(1)} ${units[unitIndex]}`;
    },

    // Format duration for display
    formatDuration(seconds) {
      if (!seconds) return '0:00';

      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;

      if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      }
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    },

    // Format date for display - returns structured data for i18n
    formatDateData(dateString) {
      if (!dateString) return { type: 'empty', time: '', formatted: '' };

      const date = new Date(dateString);
      const now = new Date();
      const diff = now - date;
      const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Today
      if (date.toDateString() === now.toDateString()) {
        return { type: 'today', time };
      }

      // Yesterday
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (date.toDateString() === yesterday.toDateString()) {
        return { type: 'yesterday', time };
      }

      // Within last 7 days
      if (diff < 7 * 24 * 60 * 60 * 1000) {
        return {
          type: 'weekday',
          time,
          formatted: date.toLocaleDateString([], {
            weekday: 'long',
            hour: '2-digit',
            minute: '2-digit'
          })
        };
      }

      // Older
      return {
        type: 'older',
        time,
        formatted: date.toLocaleDateString([], {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      };
    },

    // Legacy format date for display (backwards compatibility)
    formatDate(dateString) {
      const data = this.formatDateData(dateString);
      if (data.type === 'today') return `Today at ${data.time}`;
      if (data.type === 'yesterday') return `Yesterday at ${data.time}`;
      return data.formatted || '';
    }
  }
});
