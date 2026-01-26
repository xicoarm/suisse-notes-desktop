import { defineStore } from 'pinia';
import { useAuthStore } from './auth';
import { useRecordingStore } from './recording';
import { isElectron } from '../utils/platform';

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
    // Helper to get current user ID
    _getUserId() {
      const authStore = useAuthStore();
      return authStore.user?.id || authStore.user?.userId || null;
    },

    // Load recordings from electron store (filtered by current user)
    // Only works on Electron - mobile uses server-side history
    async loadRecordings() {
      if (this.loading) return;

      // Only load from electronAPI on desktop
      if (!isElectron()) {
        this.recordings = [];
        this.loaded = true;
        return;
      }

      try {
        this.loading = true;
        const userId = this._getUserId();
        if (!userId) {
          console.warn('No userId available, cannot load recordings');
          this.recordings = [];
          this.loaded = true;
          return;
        }
        this.recordings = await window.electronAPI.history.getAll(userId);
        this.defaultStoragePreference =
          await window.electronAPI.history.getDefaultStoragePreference();
        this.loaded = true;
      } catch (error) {
        console.error('Error loading recordings history:', error);
      } finally {
        this.loading = false;
      }
    },

    // Add a new recording to history (with userId)
    async addRecording(recording) {
      try {
        const userId = this._getUserId();
        if (!userId) {
          console.error('SECURITY: Cannot add recording without userId');
          return { success: false, error: 'Not authenticated' };
        }

        // Add userId to recording
        const recordingWithUser = { ...recording, userId };
        const result = await window.electronAPI.history.add(recordingWithUser);

        if (result.success) {
          // Add to local state
          this.recordings.unshift(result.recording);
          return { success: true, recording: result.recording };
        }

        return { success: false, error: result.error };
      } catch (error) {
        console.error('Error adding recording to history:', error);
        return { success: false, error: error.message };
      }
    },

    // Update a recording in history (with userId check)
    async updateRecording(id, updates) {
      try {
        const userId = this._getUserId();
        if (!userId) {
          console.error('SECURITY: Cannot update recording without userId');
          return { success: false, error: 'Not authenticated' };
        }

        const result = await window.electronAPI.history.update(id, updates, userId);

        if (result.success) {
          // Update local state
          const index = this.recordings.findIndex(r => r.id === id);
          if (index !== -1) {
            this.recordings[index] = { ...this.recordings[index], ...updates };
          }
          return { success: true };
        }

        return { success: false, error: result.error };
      } catch (error) {
        console.error('Error updating recording:', error);
        return { success: false, error: error.message };
      }
    },

    // Delete a recording from history (with userId check)
    async deleteRecording(id, deleteFile = false) {
      try {
        const userId = this._getUserId();
        if (!userId) {
          console.error('SECURITY: Cannot delete recording without userId');
          return { success: false, error: 'Not authenticated' };
        }

        const result = await window.electronAPI.history.delete(id, deleteFile, userId);

        if (result.success) {
          // Remove from local state
          this.recordings = this.recordings.filter(r => r.id !== id);
          return { success: true };
        }

        return { success: false, error: result.error };
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
        await window.electronAPI.history.setDefaultStoragePreference(preference);
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
      if (recording && recording.storagePreference === 'delete_after_upload') {
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
