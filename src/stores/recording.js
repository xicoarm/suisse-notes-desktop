import { defineStore } from 'pinia';
import { v4 as uuidv4 } from 'uuid';
import { isElectron, isCapacitor, isMobile, PlatformConstants } from '../utils/platform';
import * as storage from '../services/storage';
import { createChunkIntegrity, createRecordingIntegrity, addChunkToRecordingIntegrity } from '../services/integrity';
import { startStorageMonitor, stopStorageMonitor, checkStorageBeforeRecording } from '../services/storageMonitor';
import { setLifecycleCallbacks, clearLifecycleCallbacks, setRecordingActive } from '../boot/lifecycle';

export const useRecordingStore = defineStore('recording', {
  state: () => ({
    recordId: null,
    userId: null, // Track userId for multi-account handling
    status: 'idle', // idle | recording | paused | stopped | uploading | uploaded | error
    startTime: null,
    duration: 0, // in seconds
    chunkIndex: 0,
    audioFilePath: null,
    uploadProgress: 0,
    bytesUploaded: 0,
    bytesTotal: 0,
    error: null,
    // Uploaded file info (persists for navigation)
    audioFileId: null,
    finalDuration: 0,
    // Upload metadata for display in other pages
    uploadMetadata: {
      createdAt: null,
      fileSize: 0,
      finalDuration: 0
    },
    // Background upload tracking (persists when starting new recording)
    backgroundUpload: {
      active: false,
      recordId: null,
      progress: 0,
      bytesUploaded: 0,
      bytesTotal: 0,
      metadata: null
    },
    // File locking for upload safety (V6 fix)
    lockedFiles: new Set(),
    // Chunk integrity tracking (V7 fix)
    integrity: null,
    // Storage status (V1 fix)
    storageStatus: {
      status: 'ok',
      freeMB: -1,
      warning: null
    },
    // Chunk save failure tracking (V1/V7 fix)
    chunkSaveErrors: 0,
    chunkSaveErrorWarning: false,
    // Recording health monitor
    recordingInterrupted: false,
    interruptionInfo: null, // { reason, chunkCount, lastChunkTimestamp, detectedAt }
    // Recovery state
    recoveryInProgress: false,
    // Mobile-specific state
    appInBackground: false,
    networkConnected: true,
    batteryLevel: 100
  }),

  getters: {
    isRecording: (state) => state.status === 'recording',
    isPaused: (state) => state.status === 'paused',
    isStopped: (state) => state.status === 'stopped',
    isUploading: (state) => state.status === 'uploading',
    isUploaded: (state) => state.status === 'uploaded',
    // Check if ANY upload is in progress (current session or background)
    hasActiveUpload: (state) => state.status === 'uploading' || state.backgroundUpload.active,
    // Get current upload progress (prioritize current session, fallback to background)
    activeUploadProgress: (state) => {
      if (state.status === 'uploading') return state.uploadProgress;
      if (state.backgroundUpload.active) return state.backgroundUpload.progress;
      return 0;
    },
    formattedDuration: (state) => {
      const hours = Math.floor(state.duration / 3600);
      const minutes = Math.floor((state.duration % 3600) / 60);
      const seconds = state.duration % 60;
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    },
    // Check if a file is locked for upload
    isFileLocked: (state) => (recordId) => state.lockedFiles.has(recordId),
    // Check if storage is low
    hasLowStorage: (state) => state.storageStatus.status === 'low' || state.storageStatus.status === 'critical',
    // Check if app can safely record
    canRecord: (state) => state.storageStatus.status !== 'critical' && !state.appInBackground && !state.recoveryInProgress,
    // Check if recording died unexpectedly (native stopped but store still says recording/paused)
    isRecordingDead: (state) => state.recordingInterrupted &&
      (state.status === 'recording' || state.status === 'paused')
  },

  actions: {
    // Initialize lifecycle callbacks for mobile
    initializeLifecycle() {
      // Restore persistent file locks on initialization (all platforms)
      this._restoreLockedFiles();

      if (isMobile()) {
        setLifecycleCallbacks({
          onBackground: async () => {
            this.appInBackground = true;
            // Flush MediaRecorder buffer to a chunk on disk, then save metadata
            if (this.status === 'recording') {
              try {
                const { flushRecordingData } = await import('../services/recordingService.js');
                await flushRecordingData();
              } catch (e) {
                console.warn('Could not flush recording data on background:', e);
              }
              await this.flushCurrentState();
            }
          },
          onForeground: async () => {
            this.appInBackground = false;
            // Check for recovery needs when coming back
            const recovery = await this.checkRecoveryState();
            if (recovery.recovered && recovery.recordings?.length > 0) {
              try {
                const { useRecordingsHistoryStore } = await import('./recordings-history');
                const { addToMobileUploadQueue, processMobileUploadQueue } = await import('../services/upload');
                const { useAuthStore } = await import('./auth');
                const { getApiUrlSync } = await import('../services/api');
                const historyStore = useRecordingsHistoryStore();
                const authStore = useAuthStore();
                for (const rec of recovery.recordings) {
                  await historyStore.addRecording(rec);
                  // Auto-queue recovered recordings for upload
                  if (rec.filePath) {
                    addToMobileUploadQueue(rec.id, rec.filePath, {
                      duration: (rec.duration || 0).toString(),
                      title: '',
                      customVocabulary: []
                    });
                  }
                }
                console.log(`Recovered ${recovery.recordings.length} recording(s) on foreground`);
                // Trigger upload queue processing
                if (authStore.token) {
                  processMobileUploadQueue(authStore, getApiUrlSync).catch(e => {
                    console.warn('Failed to process upload queue after recovery:', e);
                  });
                }
              } catch (e) {
                console.warn('Could not add recovered recordings to history:', e);
              }
            }
          },
          onOnline: async (connectionType) => {
            this.networkConnected = true;
            // Resume pending uploads when back online
            try {
              const { processMobileUploadQueue } = await import('../services/upload.js');
              const { useAuthStore } = await import('./auth');
              const { getApiUrlSync } = await import('../services/api');
              const authStore = useAuthStore();
              if (authStore.token) {
                processMobileUploadQueue(authStore, getApiUrlSync).catch(e => {
                  console.warn('Failed to process upload queue on reconnect:', e);
                });
              }
            } catch (e) {
              console.warn('Could not process upload queue on reconnect:', e);
            }
          },
          onOffline: async () => {
            this.networkConnected = false;
          },
          onLowBattery: async (batteryPercent) => {
            this.batteryLevel = batteryPercent;
            // Warning notification could be triggered here
          },
          onCriticalBattery: async (batteryPercent) => {
            this.batteryLevel = batteryPercent;
            // Emergency stop at critical battery
            if (this.status === 'recording') {
              console.warn('Critical battery - emergency stop');
              await this.emergencyStop('Critical battery level');
            }
          }
        });
      }
    },

    // Clean up lifecycle callbacks
    cleanupLifecycle() {
      if (isMobile()) {
        clearLifecycleCallbacks();
      }
    },

    async startRecording(userId = null) {
      try {
        // Check storage before starting (V1 fix)
        const storageCheck = await checkStorageBeforeRecording();
        this.storageStatus = {
          status: storageCheck.status,
          freeMB: storageCheck.freeMB,
          warning: storageCheck.message
        };

        if (!storageCheck.canStart) {
          throw new Error(storageCheck.message || 'Insufficient storage to start recording');
        }

        this.recordId = uuidv4();
        this.userId = userId; // Store userId for use in saveChunk
        this.status = 'recording';
        this.startTime = Date.now();
        this.duration = 0;
        this.chunkIndex = 0;
        this.error = null;
        this.integrity = createRecordingIntegrity(this.recordId);

        if (isElectron()) {
          // Electron: use preload API
          await window.electronAPI.recording.setInProgress(true);

          // Pass userId to createSession for metadata.json persistence
          const result = await window.electronAPI.recording.createSession(this.recordId, '.webm', userId);

          if (!result.success) {
            await window.electronAPI.recording.setInProgress(false);
            throw new Error(result.error || 'Failed to create recording session');
          }
        } else if (isCapacitor()) {
          // Capacitor: use storage service to create directory
          await storage.createDirectory(`recordings/${this.recordId}/chunks`);

          // Initialize metadata (include userId for multi-account handling)
          await storage.saveMetadata(this.recordId, {
            id: this.recordId,
            userId: userId,
            startTime: this.startTime,
            startedAt: new Date(this.startTime).toISOString(),
            status: 'recording',
            chunks: [],
            platform: 'mobile',
            version: 1
          });
        }

        // P0 Data Loss Fix: Notify lifecycle for adaptive battery monitoring (V9)
        setRecordingActive(true);

        // Start storage monitoring during recording (V1 fix)
        await startStorageMonitor({
          onLow: (freeMB) => {
            this.storageStatus = { status: 'low', freeMB, warning: `Low storage: ${freeMB}MB remaining` };
          },
          onCritical: async (freeMB) => {
            this.storageStatus = { status: 'critical', freeMB, warning: `Critical storage: ${freeMB}MB remaining` };
            await this.emergencyStop('Storage full');
          },
          onRecovered: (freeMB) => {
            this.storageStatus = { status: 'ok', freeMB, warning: null };
          }
        });

        return { success: true, recordId: this.recordId, storageWarning: storageCheck.message };
      } catch (error) {
        this.error = error.message;
        this.status = 'error';
        if (isElectron()) {
          await window.electronAPI.recording.setInProgress(false);
        }
        return { success: false, error: error.message };
      }
    },

    pauseRecording() {
      if (this.status === 'recording') {
        this.status = 'paused';
      }
    },

    resumeRecording() {
      if (this.status === 'paused') {
        this.status = 'recording';
      }
    },

    async stopRecording() {
      try {
        this.status = 'stopped';
        stopStorageMonitor();
        // P0 Data Loss Fix: Notify lifecycle for adaptive battery monitoring (V9)
        setRecordingActive(false);

        if (isElectron()) {
          // Electron: use preload API
          await window.electronAPI.recording.setInProgress(false);
          await window.electronAPI.recording.setProcessing(true);

          const result = await window.electronAPI.recording.combineChunks(this.recordId, '.webm');

          await window.electronAPI.recording.setProcessing(false);

          if (result.success) {
            this.audioFilePath = result.outputPath;
            return { success: true, filePath: result.outputPath, warning: result.warning };
          } else {
            throw new Error(result.error || 'Failed to combine recording chunks');
          }
        } else if (isCapacitor()) {
          // Capacitor: combine chunks using native method or concatenation
          // For now, mark as ready for upload (chunks will be combined by native code)
          const result = await this.combineChunksNative();
          if (result.success) {
            this.audioFilePath = result.outputPath;
            return { success: true, filePath: result.outputPath, fileSize: result.fileSize };
          } else {
            throw new Error(result.error || 'Failed to combine recording chunks');
          }
        }

        return { success: false, error: 'Unsupported platform' };
      } catch (error) {
        this.error = error.message;
        this.status = 'error';
        if (isElectron()) {
          await window.electronAPI.recording.setInProgress(false);
          await window.electronAPI.recording.setProcessing(false);
        }
        return { success: false, error: error.message, partialRecovery: this.chunkIndex > 0, chunkCount: this.chunkIndex, recordId: this.recordId };
      }
    },

    // Handle recording death (native recorder stopped unexpectedly)
    async handleRecordingDeath({ reason = 'unknown', chunkCount = 0, lastChunkTimestamp = null } = {}) {
      if (this.recordingInterrupted) return; // Prevent duplicate handling

      console.warn('Recording death detected:', reason);
      this.recordingInterrupted = true;
      this.interruptionInfo = {
        reason,
        chunkCount: chunkCount || this.chunkIndex,
        lastChunkTimestamp,
        detectedAt: Date.now()
      };

      // Flush state on mobile so chunks are persisted
      if (isCapacitor()) {
        await this.flushCurrentState();
      }

      // Do NOT change status to 'stopped' - keep it so the UI can show the alert
    },

    // Emergency stop for critical situations (battery, storage)
    async emergencyStop(reason) {
      console.warn('Emergency stop triggered:', reason);
      try {
        // Save current chunk immediately
        await this.flushCurrentState();
        // Stop recording
        this.status = 'stopped';
        this.error = `Recording stopped: ${reason}`;
        stopStorageMonitor();

        if (isElectron()) {
          await window.electronAPI.recording.setInProgress(false);
        }
      } catch (error) {
        console.error('Error during emergency stop:', error);
      }
    },

    // Flush current state for recovery
    async flushCurrentState() {
      // Save integrity metadata
      if (this.integrity && isCapacitor()) {
        await storage.saveMetadata(this.recordId, {
          id: this.recordId,
          userId: this.userId,
          startTime: this.startTime,
          duration: this.duration,
          chunkIndex: this.chunkIndex,
          status: this.status,
          integrity: this.integrity,
          platform: 'mobile',
          lastUpdated: Date.now()
        });
      }
    },

    // Check for recordings that need recovery — auto-combines chunks and returns recovered recordings
    async checkRecoveryState() {
      this.recoveryInProgress = true;
      try {
        if (isElectron()) {
          // Electron: Check for interrupted recordings via main process
          // The main process already handles this on startup - see electron-main.js recoverInterruptedRecordings
          console.log('Recovery check: Electron handles recovery on startup');
          return { success: true, recovered: false, recordings: [] };
        } else if (isCapacitor()) {
          // Capacitor: Scan for recordings with 'recording' or 'interrupted' status
          const listResult = await storage.listFiles('recordings');

          if (!listResult.success || !listResult.files) {
            console.log('No recordings directory or empty');
            return { success: true, recovered: false, recordings: [] };
          }

          const recoveredRecordings = [];

          for (const recordId of listResult.files) {
            // Skip current active recording
            if (recordId === this.recordId) continue;

            try {
              const metaResult = await storage.loadMetadata(recordId);
              if (!metaResult.success || !metaResult.metadata) continue;

              const metadata = metaResult.metadata;

              // Check if this recording was interrupted
              if (metadata.status === 'recording' || metadata.status === 'interrupted') {
                console.warn('Found orphaned recording:', recordId);

                // Check if there are chunks
                const chunksResult = await storage.listFiles(`recordings/${recordId}/chunks`);
                const chunkCount = chunksResult.success ? (chunksResult.files?.length || 0) : 0;

                if (chunkCount > 0) {
                  console.log('Orphaned recording has', chunkCount, 'chunks - auto-combining');

                  const combineResult = await this.combineChunksNative(recordId);

                  if (combineResult.success) {
                    // Update metadata to mark as recovered
                    await storage.saveMetadata(recordId, {
                      ...metadata,
                      status: 'recovered',
                      recoveredAt: Date.now()
                    });

                    recoveredRecordings.push({
                      id: recordId,
                      userId: metadata.userId || null,
                      createdAt: metadata.startedAt || new Date(metadata.startTime || Date.now()).toISOString(),
                      duration: metadata.duration || 0,
                      fileSize: combineResult.fileSize || 0,
                      filePath: combineResult.outputPath,
                      uploadStatus: 'pending',
                      recovered: true
                    });
                  } else {
                    console.warn('Could not combine chunks for', recordId, combineResult.error);
                    // Still mark as interrupted for future attempts
                    await storage.saveMetadata(recordId, {
                      ...metadata,
                      status: 'interrupted',
                      recoverable: true,
                      chunkCount,
                      lastUpdated: Date.now()
                    });
                  }
                }
              }
            } catch (e) {
              console.error('Error recovering orphaned recording:', recordId, e);
            }
          }

          return {
            success: true,
            recovered: recoveredRecordings.length > 0,
            recordings: recoveredRecordings
          };
        }

        return { success: true, recovered: false, recordings: [] };
      } catch (error) {
        console.error('Error in checkRecoveryState:', error);
        return { success: false, error: error.message, recordings: [] };
      } finally {
        this.recoveryInProgress = false;
      }
    },

    async saveChunk(chunkData) {
      const maxRetries = 3;
      const retryDelays = [1000, 2000, 4000];

      // Create chunk integrity before saving (V7 fix)
      const chunkIntegrity = createChunkIntegrity(this.chunkIndex, chunkData);

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          let result;

          if (isElectron()) {
            // Pass userId for crash recovery state tracking
            result = await window.electronAPI.recording.saveChunk(
              this.recordId,
              chunkData,
              this.chunkIndex,
              '.webm',
              this.userId
            );
          } else if (isCapacitor()) {
            result = await storage.saveChunk(
              this.recordId,
              chunkData,
              this.chunkIndex,
              '.webm' // Mobile uses webm format
            );
          } else {
            throw new Error('Unsupported platform');
          }

          if (result.success) {
            // Track integrity
            if (this.integrity) {
              this.integrity = addChunkToRecordingIntegrity(this.integrity, chunkIntegrity);
            }
            this.chunkIndex++;
            return { success: true };
          } else {
            throw new Error(result.error || 'Failed to save chunk');
          }
        } catch (error) {
          console.error(`Error saving chunk (attempt ${attempt + 1}/${maxRetries + 1}):`, error);

          if (attempt < maxRetries) {
            const delay = retryDelays[attempt];
            console.log(`Retrying chunk save in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            console.error('All chunk save retries exhausted, chunk may be lost');
            return { success: false, error: error.message, retriesExhausted: true };
          }
        }
      }

      return { success: false, error: 'Unexpected error in saveChunk' };
    },

    // Combine chunks on mobile using native plugin (proper M4A merging)
    async combineChunksNative(recordIdOverride = null) {
      if (!isCapacitor()) {
        return { success: false, error: 'Not on mobile platform' };
      }

      try {
        const targetRecordId = recordIdOverride || this.recordId;

        // Use native plugin for proper M4A/AAC combining via platform APIs
        // (AVMutableComposition on iOS, MediaMuxer on Android)
        const { registerPlugin } = await import('@capacitor/core');
        const BackgroundRecording = registerPlugin('BackgroundRecording');
        const result = await BackgroundRecording.combineChunks({ recordId: targetRecordId });

        if (result.success) {
          return {
            success: true,
            outputPath: result.outputPath,
            fileSize: result.fileSize,
            chunkCount: result.chunkCount
          };
        }
        return { success: false, error: result.error || 'Native combine failed' };
      } catch (error) {
        console.error('Error combining chunks on mobile:', error);
        return { success: false, error: error.message };
      }
    },

    // P0 Data Loss Fix: Clean up chunks after successful upload (V5)
    async cleanupChunksAfterUpload(recordId) {
      if (!isCapacitor()) return; // Only needed on mobile

      try {
        const chunksDir = `recordings/${recordId}/chunks`;
        const listResult = await storage.listFiles(chunksDir);
        if (listResult.success && listResult.files && listResult.files.length > 0) {
          for (const file of listResult.files) {
            try {
              await storage.deleteFile(`${chunksDir}/${file}`);
            } catch (e) {
              console.warn(`Failed to delete chunk ${file}:`, e);
            }
          }
          console.log(`Cleaned up ${listResult.files.length} chunks for recording ${recordId}`);
        }
      } catch (e) {
        console.warn('Failed to clean up chunks after upload:', e);
      }
    },

    updateDuration(seconds) {
      this.duration = seconds;
    },

    // Create session file from current chunks (for auto-split)
    async createSessionFile() {
      try {
        if (isElectron()) {
          const result = await window.electronAPI.recording.createSessionFile(this.recordId, '.webm');
          if (result.success) {
            console.log('Session file created successfully');
            return { success: true };
          } else {
            throw new Error(result.error || 'Failed to create session file');
          }
        } else if (isCapacitor()) {
          // On mobile, save current state for recovery
          await this.flushCurrentState();
          return { success: true };
        }
        return { success: false, error: 'Unsupported platform' };
      } catch (error) {
        console.error('Error creating session file:', error);
        return { success: false, error: error.message };
      }
    },

    // Reset chunk index after auto-split
    resetChunkIndex() {
      this.chunkIndex = 0;
      // Reset integrity for new session
      if (this.recordId) {
        this.integrity = createRecordingIntegrity(this.recordId);
      }
      console.log('Chunk index reset for new session');
    },

    // File locking for upload safety (V6 fix - now persistent)
    async lockForUpload(recordId) {
      this.lockedFiles.add(recordId);
      // Persist to disk so locks survive app restart
      if (isElectron() && window.electronAPI?.recording?.lockForUpload) {
        try {
          await window.electronAPI.recording.lockForUpload(recordId);
        } catch (e) {
          console.warn('Failed to persist lock to electron-store:', e);
        }
      } else if (isCapacitor() || !isElectron()) {
        try {
          localStorage.setItem('locked_recordings', JSON.stringify([...this.lockedFiles]));
        } catch (e) {
          console.warn('Failed to persist lock to localStorage:', e);
        }
      }
    },

    async unlockFile(recordId) {
      this.lockedFiles.delete(recordId);
      // Remove persistent lock
      if (isElectron() && window.electronAPI?.recording?.unlockAfterUpload) {
        try {
          await window.electronAPI.recording.unlockAfterUpload(recordId);
        } catch (e) {
          console.warn('Failed to remove persistent lock:', e);
        }
      } else if (isCapacitor() || !isElectron()) {
        try {
          localStorage.setItem('locked_recordings', JSON.stringify([...this.lockedFiles]));
        } catch (e) {
          console.warn('Failed to update persistent locks:', e);
        }
      }
    },

    canDelete(recordId) {
      return !this.lockedFiles.has(recordId);
    },

    // Restore locks from persistent storage on initialization
    async _restoreLockedFiles() {
      try {
        if (isElectron() && window.electronAPI?.recording?.getLockedRecordings) {
          const locked = await window.electronAPI.recording.getLockedRecordings();
          if (Array.isArray(locked)) {
            locked.forEach(id => this.lockedFiles.add(id));
          }
        } else {
          const raw = localStorage.getItem('locked_recordings');
          if (raw) {
            const locked = JSON.parse(raw);
            if (Array.isArray(locked)) {
              locked.forEach(id => this.lockedFiles.add(id));
            }
          }
        }
        if (this.lockedFiles.size > 0) {
          console.log('Restored persistent file locks:', [...this.lockedFiles]);
        }
      } catch (e) {
        console.warn('Failed to restore locked files:', e);
      }
    },

    updateUploadProgress(progress, bytesUploaded, bytesTotal) {
      this.uploadProgress = progress;
      this.bytesUploaded = bytesUploaded;
      this.bytesTotal = bytesTotal;
    },

    setUploading(metadata = {}) {
      this.status = 'uploading';
      this.uploadProgress = 0;
      if (metadata.createdAt) this.uploadMetadata.createdAt = metadata.createdAt;
      if (metadata.fileSize) this.uploadMetadata.fileSize = metadata.fileSize;
      if (metadata.finalDuration !== undefined) this.uploadMetadata.finalDuration = metadata.finalDuration;
    },

    setUploaded(audioFileId = null) {
      this.status = 'uploaded';
      this.uploadProgress = 100;
      if (audioFileId) {
        this.audioFileId = audioFileId;
      }
    },

    setFinalDuration(duration) {
      this.finalDuration = duration;
    },

    setError(error) {
      this.error = error;
      this.status = 'error';
    },

    // Move current upload to background (when starting new recording)
    moveToBackgroundUpload() {
      if (this.status === 'uploading') {
        this.backgroundUpload = {
          active: true,
          recordId: this.recordId,
          progress: this.uploadProgress,
          bytesUploaded: this.bytesUploaded,
          bytesTotal: this.bytesTotal,
          metadata: { ...this.uploadMetadata }
        };
      }
    },

    updateBackgroundUploadProgress(recordId, progress, bytesUploaded, bytesTotal) {
      if (this.backgroundUpload.active && this.backgroundUpload.recordId === recordId) {
        this.backgroundUpload.progress = progress;
        this.backgroundUpload.bytesUploaded = bytesUploaded;
        this.backgroundUpload.bytesTotal = bytesTotal;
      }
    },

    clearBackgroundUpload() {
      this.backgroundUpload = {
        active: false,
        recordId: null,
        progress: 0,
        bytesUploaded: 0,
        bytesTotal: 0,
        metadata: null
      };
    },

    reset() {
      this.recordId = null;
      this.userId = null;
      this.status = 'idle';
      this.startTime = null;
      this.duration = 0;
      this.chunkIndex = 0;
      this.audioFilePath = null;
      this.uploadProgress = 0;
      this.bytesUploaded = 0;
      this.bytesTotal = 0;
      this.error = null;
      this.audioFileId = null;
      this.finalDuration = 0;
      this.uploadMetadata = {
        createdAt: null,
        fileSize: 0,
        finalDuration: 0
      };
      this.integrity = null;
      this.chunkSaveErrors = 0;
      this.chunkSaveErrorWarning = false;
      this.recordingInterrupted = false;
      this.interruptionInfo = null;
      this.recoveryInProgress = false;
      this.storageStatus = {
        status: 'ok',
        freeMB: -1,
        warning: null
      };
    }
  }
});
