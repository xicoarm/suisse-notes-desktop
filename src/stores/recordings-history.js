import { defineStore } from 'pinia';
import { useAuthStore } from './auth';
import { useRecordingStore } from './recording';
import { isElectron, isCapacitor, getPlatform } from '../utils/platform';
import { getApiUrlSync } from '../services/api';

// Map a client `recording` object to the contract's RegisterRecordingRequest
// shape (see src/lib/api/desktop-contract.ts → POST /api/desktop/recording).
// The server only persists these four fields on register — any other client
// state (filePath, fileSize, uploadStatus, source, deviceFilename) stays
// client-side. Resync to the server happens via the upload + PATCH endpoints.
function _toRegisterRequest(recording) {
  return {
    recordId: recording.id,
    title: recording.title || undefined,
    platform: getPlatform(),
    startedAt: recording.createdAt || undefined,
  };
}

// Map a client `updates` object to the contract's UpdateRecordingRequest
// (PATCH /api/desktop/recording/{recordId}). The contract only accepts three
// fields: { title?, status?, durationSeconds? } where status is one of
// "RECORDING" | "UPLOADING" | "CANCELLED" (server owns the other transitions).
// Anything else is silently dropped — those values are local-only client state.
function _toUpdateRequest(updates) {
  const out = {};
  if (typeof updates?.title === 'string') out.title = updates.title;
  if (typeof updates?.duration === 'number' && isFinite(updates.duration)) {
    out.durationSeconds = Math.max(0, Math.round(updates.duration));
  }
  // Map the client's `uploadStatus` (richer enum) onto the contract's
  // narrower `status`. Only the three client-owned transitions cross the
  // wire; uploaded/failed/pending/transferring are server- or local-side.
  if (typeof updates?.uploadStatus === 'string') {
    if (updates.uploadStatus === 'uploading') out.status = 'UPLOADING';
    else if (updates.uploadStatus === 'cancelled') out.status = 'CANCELLED';
    // 'recording' (live capture) maps to RECORDING if we ever PATCH from there
    else if (updates.uploadStatus === 'recording') out.status = 'RECORDING';
  }
  return out;
}

function _toClientUploadStatus(status) {
  if (typeof status !== 'string') return null;
  switch (status.toUpperCase()) {
    case 'PENDING':
      return 'pending';
    case 'UPLOADING':
      return 'uploading';
    case 'UPLOADED':
    case 'COMPLETED':
      return 'uploaded';
    case 'PROCESSING':
    case 'PENDING_VERIFICATION':
      return 'pending_verification';
    case 'FAILED':
    case 'TRANSCRIPTION_FAILED':
      return 'failed';
    case 'RECORDING':
      return 'recording';
    case 'CANCELLED':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    case 'TRANSFERRING':
      return 'transferring';
    default:
      return null;
  }
}

function _normalizeServerRecording(serverRec) {
  const id = serverRec?.id || serverRec?.recordId || serverRec?.meetingId || serverRec?.audioFileId;
  const duration =
    typeof serverRec?.duration === 'number'
      ? serverRec.duration
      : (typeof serverRec?.durationSeconds === 'number' ? serverRec.durationSeconds : 0);

  return {
    ...serverRec,
    id,
    uploadStatus: _toClientUploadStatus(serverRec?.uploadStatus) ||
      _toClientUploadStatus(serverRec?.status) ||
      'pending',
    duration,
    audioFileId: serverRec?.audioFileId || serverRec?.transcriptionId || null,
    // Prefer any server-provided timestamp before falling back to 'now' —
    // a wall-clock fallback changes on every fetch and destabilizes sort order.
    createdAt: serverRec?.createdAt || serverRec?.startedAt || serverRec?.updatedAt || new Date().toISOString(),
    title: serverRec?.title || serverRec?.filename || 'Recording'
  };
}

// Auto-retry constants
const RETRY_INITIAL_DELAY_MS = 60_000;   // 1 minute
const RETRY_MAX_DELAY_MS = 1_800_000;    // 30 minutes
const _retryingIds = new Set(); // Track currently retrying uploads to prevent concurrent retries

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
    allRecordings: (state) => [...state.recordings].sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA; // newest first
    }),

    // Get recordings by status
    pendingRecordings: (state) =>
      state.recordings.filter(r => r.uploadStatus === 'pending'),

    uploadedRecordings: (state) =>
      state.recordings.filter(r => r.uploadStatus === 'uploaded'),

    failedRecordings: (state) =>
      state.recordings.filter(r => r.uploadStatus === 'failed'),

    inProgressRecordings: (state) =>
      state.recordings.filter(r => r.uploadStatus === 'recording'),

    transferringRecordings: (state) =>
      state.recordings.filter(r => r.uploadStatus === 'transferring'),

    skippedRecordings: (state) =>
      state.recordings.filter(r => r.uploadStatus === 'skipped'),

    deviceRecordings: (state) => [...state.recordings]
      .filter(r => r.source === 'device')
      .sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
      }),

    appRecordings: (state) => [...state.recordings]
      .filter(r => r.source !== 'device')
      .sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
      }),

    hasDeviceRecordings: (state) =>
      state.recordings.some(r => r.source === 'device'),

    // Get recording count
    recordingCount: (state) => state.recordings.length,

    // Get a specific recording by ID
    getRecordingById: (state) => (id) =>
      state.recordings.find(r => r.id === id),

    // Get the most recent recording for a device filename
    getRecordingByDeviceFilename: (state) => (filename) =>
      state.recordings.find(r => r.deviceFilename === filename),

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

    // Retry syncing local-only recordings to server
    async syncUnsyncedToServer() {
      const userId = this._getUserId(null, { forWrite: true });
      if (!userId) return;

      const unsynced = this.recordings.filter(r => r._serverSynced === false);
      for (const recording of unsynced) {
        try {
          // POST /api/desktop/recording is the contract endpoint for
          // registering a single recording. Idempotent on recordId.
          await _serverFetch('/api/desktop/recording', {
            method: 'POST',
            body: JSON.stringify(_toRegisterRequest(recording))
          });
          recording._serverSynced = true;
        } catch {
          // Still failed, will retry next time
        }
      }
      if (unsynced.length > 0) {
        _setCachedRecordings(userId, this.recordings);
      }
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

          // Then fetch from server and merge with local cache
          const data = await _serverFetch('/api/desktop/history');
          const rawServerRecordings = data.recordings || (Array.isArray(data) ? data : null);
          const serverRecordings = rawServerRecordings
            ? rawServerRecordings.map(_normalizeServerRecording).filter(r => r.id)
            : null;
          if (serverRecordings && serverRecordings.length < rawServerRecordings.length) {
            console.warn(`History fetch: dropped ${rawServerRecordings.length - serverRecordings.length} server recording(s) without any usable id`);
          }
          if (serverRecordings) {
            // Merge: preserve local non-zero duration/fileSize when server has 0
            const cached = _getCachedRecordings(userId);
            // Client-only bookkeeping the server never returns — losing these
            // on fetch empties the device-recordings section, breaks the
            // deviceFilename dedupe (BLE re-syncs would mint duplicates) and
            // resets retry backoff.
            const LOCAL_ONLY_FIELDS = [
              'source', 'deviceFilename', 'storagePreference',
              'retryCount', 'lastRetryAt', 'uploadError', '_serverSynced'
            ];
            const merged = serverRecordings.map(serverRec => {
              const localRec = cached.find(r => r.id === serverRec.id);
              if (localRec) {
                const updates = {};
                if (localRec.duration > 0 && (!serverRec.duration || serverRec.duration === 0)) {
                  updates.duration = localRec.duration;
                }
                if (localRec.fileSize > 0 && (!serverRec.fileSize || serverRec.fileSize === 0)) {
                  updates.fileSize = localRec.fileSize;
                }
                if (localRec.filePath && !serverRec.filePath) {
                  updates.filePath = localRec.filePath;
                }
                for (const field of LOCAL_ONLY_FIELDS) {
                  if (localRec[field] != null && serverRec[field] == null) {
                    updates[field] = localRec[field];
                  }
                }
                // Server 'recording' is synthetic ("registered, no audio
                // received yet") — it must not clobber a more advanced local
                // status like 'failed' or 'pending': that would strip the
                // record of its retry button and auto-retry eligibility,
                // dead-ending a failed upload.
                if (serverRec.uploadStatus === 'recording' &&
                    localRec.uploadStatus &&
                    localRec.uploadStatus !== 'recording') {
                  updates.uploadStatus = localRec.uploadStatus;
                }
                if (Object.keys(updates).length > 0) {
                  return { ...serverRec, ...updates };
                }
              }
              return serverRec;
            });
            // Preserve local-only recordings (e.g. device recordings pending upload)
            const serverIds = new Set(serverRecordings.map(r => r.id));
            const localOnly = cached.filter(r => r.id && !serverIds.has(r.id));
            this.recordings = [...merged, ...localOnly];
            _setCachedRecordings(userId, this.recordings);
          }

          // Fix stale 'uploading' status from crashed/killed sessions.
          // If a recording is stuck in 'uploading' from a previous app session,
          // reset it to 'pending' so the user can retry.
          let staleFixed = 0;
          for (const rec of this.recordings) {
            if (rec.uploadStatus === 'uploading') {
              rec.uploadStatus = 'pending';
              staleFixed++;
            }
          }
          if (staleFixed > 0) {
            console.warn(`Reset ${staleFixed} stale 'uploading' recording(s) to 'pending'`);
            _setCachedRecordings(userId, this.recordings);
          }

          // Retry syncing any local-only recordings to server
          this.syncUnsyncedToServer();
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

        // Prevent deviceFilename duplicates (e.g., from repeated recovery of same device file)
        if (recording.deviceFilename) {
          const existingByFilename = this.recordings.find(r => r.deviceFilename === recording.deviceFilename);
          if (existingByFilename) {
            return this.updateRecording(existingByFilename.id, recording);
          }
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
          // Mobile/Web: POST to server (contract endpoint registers a
          // single recording), update local cache. Idempotent on recordId
          // — calling twice returns the existing server-side resource.
          try {
            const data = await _serverFetch('/api/desktop/recording', {
              method: 'POST',
              body: JSON.stringify(_toRegisterRequest(recordingWithUser))
            });

            // Server returns { recording: RecordingResource } but the client
            // keeps its richer local shape (filePath, uploadStatus, etc.).
            // Mark synced so the retry loop skips it next time.
            recordingWithUser._serverSynced = true;
            // Adopt server-side meetingId/audioFileId if returned, otherwise
            // keep local-only state intact.
            if (data?.recording?.meetingId) recordingWithUser.meetingId = data.recording.meetingId;
            this.recordings.unshift(recordingWithUser);
            _setCachedRecordings(userId, this.recordings);
            return { success: true, recording: recordingWithUser };
          } catch (error) {
            // Server failed — save to local cache only so history isn't lost
            console.warn('Could not save recording to server, caching locally:', error);
            recordingWithUser._serverSynced = false;
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
        // Sanitize duration — prevent Infinity/NaN from being persisted
        if (updates.duration !== undefined && !isFinite(updates.duration)) {
          updates.duration = 0;
        }

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

          // Only PATCH the server if there's a contract-compliant change
          // (title / status transition the client owns / durationSeconds).
          // Other local-only fields like filePath, audioFileId, transcriptionId
          // are dropped — they're either server-managed or local cache.
          const patchBody = _toUpdateRequest(updates);
          if (Object.keys(patchBody).length > 0) {
            try {
              await _serverFetch(`/api/desktop/recording/${id}`, {
                method: 'PATCH',
                body: JSON.stringify(patchBody)
              });
            } catch (error) {
              console.warn('Could not update recording on server:', error);
            }
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
          // Mobile/Web: remove locally. The desktop API contract does NOT
          // include DELETE on /api/desktop/recording/{recordId} (see
          // src/lib/api/desktop-contract.ts DESKTOP_API_CONTRACT) — the
          // server intentionally has no client-side delete to prevent
          // accidental loss of uploaded transcriptions. Local removal hides
          // it from the user's history list; the server-side meeting can be
          // archived/deleted later through the meeting UI.
          this.recordings = this.recordings.filter(r => r.id !== id);
          _setCachedRecordings(userId, this.recordings);
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

      const recordingStore = useRecordingStore();

      // P0 Data Loss Fix: Check file locking before deletion
      // If storage preference is delete_after_upload, delete the file ONLY if safe
      // File deletion only applies to Electron (mobile files are managed differently)
      if (isElectron() && recording && recording.storagePreference === 'delete_after_upload') {
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

      // P0 Data Loss Fix: Clean up mobile chunks after verified upload (V5)
      if (isCapacitor() && canDelete) {
        recordingStore.cleanupChunksAfterUpload(id);
      }
    },

    // Mark recording as failed
    async markAsFailed(id, error = null) {
      await this.updateRecording(id, {
        uploadStatus: 'failed',
        uploadError: error
      });
    },

    /**
     * Auto-retry all failed/pending uploads that have a local file.
     * Uses exponential backoff based on retryCount per recording.
     * Called periodically from App.vue.
     */
    async retryFailedUploads() {
      const authStore = useAuthStore();
      if (!authStore.isAuthenticated) return;

      const retryable = this.recordings.filter(r =>
        (r.uploadStatus === 'failed' || r.uploadStatus === 'pending') &&
        r.filePath &&
        // 'failed' WITH audioFileId means the server already holds the audio
        // (transcription failed after a successful upload). Re-uploading is
        // permanently futile: the backend dedupes by recordId — including
        // FAILED meetings — and silently discards the bytes. Auto-retrying
        // here just re-reads and re-sends the entire file forever (observed
        // in production: the same 93MB blob re-uploaded for weeks). Recovery
        // for these needs a server-side re-transcribe, not a re-upload.
        !(r.uploadStatus === 'failed' && r.audioFileId) &&
        !_retryingIds.has(r.id)
      );

      if (retryable.length === 0) return;

      for (const recording of retryable) {
        // Exponential backoff: check if enough time has passed since last retry
        const retryCount = recording.retryCount || 0;
        const backoffMs = Math.min(RETRY_INITIAL_DELAY_MS * Math.pow(2, retryCount), RETRY_MAX_DELAY_MS);
        const lastRetryAt = recording.lastRetryAt ? new Date(recording.lastRetryAt).getTime() : 0;
        if (Date.now() - lastRetryAt < backoffMs) continue;

        _retryingIds.add(recording.id);
        const prevStatus = recording.uploadStatus; // 'failed' | 'pending' per filter above
        try {
          await this.updateRecording(recording.id, {
            uploadStatus: 'uploading',
            retryCount: retryCount + 1,
            lastRetryAt: new Date().toISOString()
          });

          let result;
          if (isElectron()) {
            result = await window.electronAPI.upload.start({
              recordId: recording.id,
              filePath: recording.filePath,
              metadata: {
                duration: recording.duration?.toString(),
                title: recording.title
              }
            });

            // Token expired — attempt refresh and retry once
            if (!result.success && result.status === 401) {
              const refreshResult = await authStore.handleAuthError();
              if (refreshResult.success) {
                result = await window.electronAPI.upload.start({
                  recordId: recording.id,
                  filePath: recording.filePath,
                  metadata: {
                    duration: recording.duration?.toString(),
                    title: recording.title
                  }
                });
              }
            }
          } else if (isCapacitor()) {
            const { uploadWithVerification } = await import('../services/upload');
            result = await uploadWithVerification({
              filePath: recording.filePath,
              recordId: recording.id,
              apiUrl: getApiUrlSync(),
              authToken: authStore.token,
              metadata: {
                duration: recording.duration?.toString(),
                title: recording.title
              },
              onProgress: () => {},
              getAuthStore: () => authStore
            });
          }

          if (result?.inProgress) {
            // Another driver holds the in-flight guard — this was not an
            // attempt. Revert the optimistic 'uploading' write and the
            // retryCount bump so the record isn't stranded (auto-retry and
            // the manual retry button only act on 'failed'/'pending') and
            // the backoff isn't inflated. lastRetryAt is kept so the next
            // check is naturally spaced.
            console.log(`Auto-retry skipped for recording ${recording.id}: upload already in progress`);
            await this.updateRecording(recording.id, {
              uploadStatus: prevStatus,
              retryCount
            });
          } else if (result?.success) {
            await this.updateRecording(recording.id, {
              uploadStatus: 'uploaded',
              transcriptionId: result.transcriptionId,
              audioFileId: result.audioFileId,
              uploadError: null,
              retryCount: 0
            });
            console.log(`Auto-retry succeeded for recording ${recording.id}`);
          } else {
            await this.updateRecording(recording.id, {
              uploadStatus: 'failed',
              uploadError: result?.error || 'Upload failed'
            });
          }
        } catch (error) {
          await this.updateRecording(recording.id, {
            uploadStatus: 'failed',
            uploadError: error.message
          });
        } finally {
          _retryingIds.delete(recording.id);
        }
      }
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
      if (!seconds || !isFinite(seconds)) return '0:00';

      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;

      if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      }
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    },

    // Format date for display — always DD.MM.YYYY HH:mm (24h)
    formatDateData(dateString) {
      if (!dateString) return { type: 'date', time: '', formatted: '' };

      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');

      const formatted = `${day}.${month}.${year} ${hours}:${minutes}`;

      return { type: 'date', time: `${hours}:${minutes}`, formatted };
    },

    // Legacy format date for display (backwards compatibility)
    formatDate(dateString) {
      const data = this.formatDateData(dateString);
      return data.formatted || '';
    }
  }
});
