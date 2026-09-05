import { defineStore } from 'pinia';
import { v4 as uuidv4 } from 'uuid';
import { isElectron, isCapacitor, isMobile, PlatformConstants } from '../utils/platform';
import * as storage from '../services/storage';
import { createChunkIntegrity, createRecordingIntegrity, addChunkToRecordingIntegrity } from '../services/integrity';
import { startStorageMonitor, stopStorageMonitor, checkStorageBeforeRecording } from '../services/storageMonitor';
import { setLifecycleCallbacks, clearLifecycleCallbacks, setRecordingActive } from '../boot/lifecycle';
import { sentryRecordingStart, sentryRecordingStop, sentryRecordingPause, sentryRecordingResume, sentryRecordingError } from '../services/sentryHelpers';
import { humanizeStorageError } from '../utils/storageErrors';
import { i18n } from '../boot/i18n';
import { Notify } from 'quasar';

const t = (key, params) => i18n.global.t(key, params || {});
// Dedup battery alerts across the periodic battery poll so we notify on a
// transition (ok→low→critical), not on every poll tick. Reset per recording.
let batteryAlertShown = null; // null | 'low' | 'critical'

// Map raw Node/libuv error messages to localized, actionable text before they
// hit the UI. See utils/storageErrors.js for the classification logic.
function describeStorageError(error) {
  return humanizeStorageError(error, i18n.global.t.bind(i18n.global));
}

export const useRecordingStore = defineStore('recording', {
  state: () => ({
    recordId: null,
    userId: null, // Track userId for multi-account handling
    // Single authoritative state: idle | preparing | recording | paused | stopping | processing | uploading | uploaded | error
    phase: 'idle',
    startTime: null,
    duration: 0, // in seconds
    chunkIndex: 0,
    captureMode: null,
    audioFilePath: null,
    uploadProgress: 0,
    bytesUploaded: 0,
    bytesTotal: 0,
    uploadRetryAttempt: 0,
    uploadRetryMaxRetries: 0,
    error: null,
    uploadError: null, // Upload error message (persists across navigation)
    // Uploaded file info (persists for navigation)
    audioFileId: null,
    finalDuration: 0,
    currentFileSize: 0, // Size of recording file
    // Upload metadata for display in other pages
    uploadMetadata: {
      createdAt: null,
      fileSize: 0,
      finalDuration: 0
    },
    // File locking for upload safety (V6 fix, FIX 7: Map<recordId, timestamp> with 24h expiry)
    lockedFiles: new Map(),
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
    // FIX 8: Mutex for serializing concurrent saveChunk() calls
    _chunkSaveQueue: Promise.resolve(),
    // Recording health monitor
    recordingInterrupted: false,
    interruptionInfo: null, // { reason, chunkCount, lastChunkTimestamp, detectedAt }
    // Recovery state
    recoveryInProgress: false,
    _recoveryPromise: null, // P1 Fix: Promise to await before starting new recording
    // Mobile-specific state
    appInBackground: false,
    networkConnected: true,
    batteryLevel: 100
  }),

  getters: {
    isRecording: (state) => state.phase === 'recording',
    isPaused: (state) => state.phase === 'paused',
    isStopped: (state) => state.phase === 'stopping',
    isProcessing: (state) => state.phase === 'processing',
    isUploading: (state) => state.phase === 'uploading',
    isUploaded: (state) => state.phase === 'uploaded',
    hasActiveUpload: (state) => state.phase === 'uploading',
    activeUploadProgress: (state) => {
      if (state.phase === 'uploading') return state.uploadProgress;
      return 0;
    },
    // True during any phase where the user must stay on the record page
    isBlocking: (state) => ['preparing', 'recording', 'paused', 'stopping', 'processing', 'uploading'].includes(state.phase),
    formattedDuration: (state) => {
      if (!state.duration || !isFinite(state.duration)) return '00:00:00';
      const hours = Math.floor(state.duration / 3600);
      const minutes = Math.floor((state.duration % 3600) / 60);
      const seconds = state.duration % 60;
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    },
    // Check if a file is locked for upload (with 24h expiry - FIX 7)
    isFileLocked: (state) => (recordId) => {
      const lockTime = state.lockedFiles.get(recordId);
      if (!lockTime) return false;
      if (Date.now() - lockTime > 24 * 60 * 60 * 1000) return false;
      return true;
    },
    hasLowStorage: (state) => state.storageStatus.status === 'low' || state.storageStatus.status === 'critical',
    canRecord: (state) => state.storageStatus.status !== 'critical' && !state.appInBackground && !state.recoveryInProgress,
    isRecordingDead: (state) => state.recordingInterrupted &&
      (state.phase === 'recording' || state.phase === 'paused')
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
            if (this.phase === 'recording') {
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
            // Refresh minutes balance when returning to foreground
            try {
              const { useMinutesStore } = await import('./minutes');
              const { useAuthStore } = await import('./auth');
              const minutesStore = useMinutesStore();
              const authStore = useAuthStore();
              if (authStore.token) {
                minutesStore.fetchMinutes(authStore.token, true).catch(() => {});
              }
            } catch (e) {
              console.warn('Could not refresh minutes on foreground:', e);
            }
            // Check for recovery needs when coming back
            await this._processRecovery('foreground');
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
            // ALERT ONLY — never interrupt the recording for low battery. Chunks
            // are persisted to disk every ~3s (fsync'd), so even a sudden
            // shutdown keeps everything up to the last few seconds (recovered on
            // next launch). The user decides whether to plug in or stop.
            if (this.phase === 'recording' && batteryAlertShown === null) {
              batteryAlertShown = 'low';
              Notify.create({
                type: 'warning', icon: 'battery_alert', timeout: 10000,
                message: t('batteryLowWarning', { percent: Math.round(batteryPercent) }),
              });
            }
          },
          onCriticalBattery: async (batteryPercent) => {
            this.batteryLevel = batteryPercent;
            // ALERT ONLY — do NOT stop the recording. A persistent, urgent
            // notice; the recording keeps running and keeps saving chunks so
            // nothing is lost if the device dies. (Owner decision 2026-07-26:
            // auto-stopping at 5% was too aggressive.)
            if (this.phase === 'recording' && batteryAlertShown !== 'critical') {
              batteryAlertShown = 'critical';
              console.warn('Critical battery - alerting user (recording continues, chunks kept)');
              Notify.create({
                type: 'negative', icon: 'battery_alert', timeout: 0,
                message: t('batteryCriticalWarning', { percent: Math.round(batteryPercent) }),
                actions: [{ label: t('ok', 'OK'), color: 'white' }],
              });
            }
          }
        });

        // Cold-start recovery: check for orphaned recordings on app launch
        // P1 Fix: Store the promise so startRecording can await it (prevents race condition)
        // Delay 3s to ensure stores are initialized and UI is ready
        this._recoveryPromise = new Promise(resolve => setTimeout(resolve, 3000))
          .then(() => this._processRecovery('cold-start'))
          .catch(e => console.error('Cold-start recovery failed:', e))
          .finally(() => { this._recoveryPromise = null; });
      }
    },

    // Clean up lifecycle callbacks
    cleanupLifecycle() {
      if (isMobile()) {
        clearLifecycleCallbacks();
      }
    },

    async startRecording(userId = null, { deferCaptureStart = false, captureMode = null } = {}) {
      // Re-entrancy guard (double-start incident): a new session must not start
      // while a capture lifecycle is live — the body below regenerates recordId
      // and resets chunkIndex, which would corrupt the active chunk sequence.
      // The service-level latch blocks renderer double-starts; this protects
      // the store against any other caller.
      if (['preparing', 'recording', 'paused', 'stopping', 'processing'].includes(this.phase)) {
        console.warn(`startRecording rejected: phase is '${this.phase}'`);
        return { success: false, error: `Cannot start a recording while phase is '${this.phase}'` };
      }
      batteryAlertShown = null; // re-arm battery alerts for this recording
      try {
        // P1 Fix: Wait for cold-start recovery to complete before starting a new recording
        // Prevents race where recovery and new recording both modify store state
        if (this._recoveryPromise) {
          console.log('Waiting for recovery to complete before starting recording...');
          await this._recoveryPromise;
        }

        // Wait for Electron main process recovery to finish (prevents chunk corruption)
        if (isElectron() && window.electronAPI?.recording?.isRecoveryRunning) {
          let recoveryWaitMs = 0;
          while (await window.electronAPI.recording.isRecoveryRunning()) {
            if (recoveryWaitMs >= 15000) {
              console.warn('Recovery still running after 15s — proceeding anyway');
              break;
            }
            await new Promise(r => setTimeout(r, 500));
            recoveryWaitMs += 500;
          }
        }

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
        this.phase = deferCaptureStart ? 'preparing' : 'recording';
        this.startTime = Date.now();
        this.duration = 0;
        this.chunkIndex = 0;
        this.captureMode = captureMode;
        this.error = null;
        this.integrity = createRecordingIntegrity(this.recordId);

        if (isElectron()) {
          // Electron: use preload API
          await window.electronAPI.recording.setInProgress(true);

          // Pass userId to createSession for metadata.json persistence
          const result = captureMode
            ? await window.electronAPI.recording.createSession(this.recordId, '.webm', userId, { captureMode })
            : await window.electronAPI.recording.createSession(this.recordId, '.webm', userId);

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

        sentryRecordingStart(this.recordId);
        return { success: true, recordId: this.recordId, storageWarning: storageCheck.message };
      } catch (error) {
        this.error = describeStorageError(error);
        this.phase ='error';
        sentryRecordingError(this.recordId, error);
        if (isElectron()) {
          await window.electronAPI.recording.setInProgress(false);
        }
        return { success: false, error: error.message };
      }
    },

    confirmCaptureStarted() {
      if (this.phase !== 'preparing') return;
      this.phase = 'recording';
      this.startTime = Date.now();
    },

    pauseRecording() {
      if (this.phase === 'recording') {
        this.phase ='paused';
        sentryRecordingPause(this.recordId);
      }
    },

    resumeRecording() {
      if (this.phase === 'paused') {
        this.phase ='recording';
        sentryRecordingResume(this.recordId);
      }
    },

    async stopRecording(expectedDurationSec = this.duration) {
      try {
        this.phase ='stopped';
        stopStorageMonitor();
        // P0 Data Loss Fix: Notify lifecycle for adaptive battery monitoring (V9)
        setRecordingActive(false);

        if (isElectron()) {
          // Electron: use preload API
          await window.electronAPI.recording.setInProgress(false);
          await window.electronAPI.recording.setProcessing(true);

          // Pass the wall-clock duration so main can tell whether the combined file
          // actually contains the meeting. Main has no other source for this:
          // metadata.json only gets a duration AFTER the combine, from the probe.
          const result = await window.electronAPI.recording.combineChunks(this.recordId, '.webm', Number.isFinite(expectedDurationSec) ? expectedDurationSec : this.duration);

          await window.electronAPI.recording.setProcessing(false);

          if (result.success) {
            this.audioFilePath = result.outputPath;
            sentryRecordingStop(this.recordId, this.duration);
            return { success: true, filePath: result.outputPath, duration: result.duration || null, warning: result.warning };
          } else if (result.diskFull) {
            // Disk full at finalize: the chunks are intact on disk. Surface a
            // reassuring, actionable message instead of a raw ENOSPC error —
            // RecordPage offers Retry, and launch recovery combines the chunks
            // once space is freed even if the user walks away.
            const mb = result.shortfallMB || result.neededMB || 200;
            this.error = i18n.global.t('diskFullFinalizeMessage', { mb });
            this.phase = 'error';
            sentryRecordingError(this.recordId, new Error(`combine blocked: disk full (need ${result.neededMB}MB, free ${result.freeMB}MB)`));
            return {
              success: false,
              diskFull: true,
              shortfallMB: result.shortfallMB,
              neededMB: result.neededMB,
              error: this.error,
              partialRecovery: this.chunkIndex > 0 || this.captureMode === 'native-sources-v1',
              chunkCount: this.chunkIndex,
              recordId: this.recordId
            };
          } else {
            throw new Error(result.error || 'Failed to combine recording chunks');
          }
        } else if (isCapacitor()) {
          // Capacitor: combine chunks using native method or concatenation.
          // A2: if any chunk-save failures occurred this recording (e.g. the
          // disk-full emergency stop, or exhausted retries), the chunk sequence
          // almost certainly has gaps. Combine in recovery mode so it preserves
          // the available audio instead of hard-failing on the gap and saving
          // NOTHING — which is exactly the state an emergency stop is in.
          const result = await this.combineChunksNative(null, { isRecovery: this.chunkSaveErrors > 0 });
          if (result.success) {
            this.audioFilePath = result.outputPath;
            // Always prefer native-reported duration over JS timer
            const nativeDuration = result.duration || null;
            if (nativeDuration) {
              this.duration = nativeDuration;
            }
            sentryRecordingStop(this.recordId, this.duration);
            return { success: true, filePath: result.outputPath, fileSize: result.fileSize, duration: nativeDuration };
          } else {
            throw new Error(result.error || 'Failed to combine recording chunks');
          }
        }

        return { success: false, error: 'Unsupported platform' };
      } catch (error) {
        this.error = describeStorageError(error);
        this.phase ='error';
        sentryRecordingError(this.recordId, error);
        if (isElectron()) {
          await window.electronAPI.recording.setInProgress(false);
          await window.electronAPI.recording.setProcessing(false);
        }
        return {
          success: false,
          error: error.message,
          diskFull: /ENOSPC|no space left/i.test(error.message || ''),
          partialRecovery: this.chunkIndex > 0 || this.captureMode === 'native-sources-v1',
          chunkCount: this.chunkIndex,
          recordId: this.recordId
        };
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

    // Emergency stop for critical situations (battery, storage).
    //
    // BUGFIX (stress audit 2026-07-26): this used to only flushCurrentState()
    // and set phase='stopped' — it NEVER stopped the MediaRecorder or combined
    // the chunks. On a dying battery or a full disk the recorder kept capturing
    // into oblivion and the finished file only appeared via next-launch
    // recovery (and could be lost entirely if the device died first). Now it
    // does a real stop-with-save through recordingService.stopRecording (the
    // same graceful teardown + combine the app-level safety net uses), so the
    // recording is finalized immediately while there is still power/disk.
    // Shared desktop + mobile (recordingService is the shared engine).
    async emergencyStop(reason) {
      console.warn('Emergency stop triggered:', reason);
      stopStorageMonitor();
      try {
        const svc = await import('../services/recordingService.js');
        // Best-effort system-audio teardown (desktop only; no-op on mobile).
        const stopSystemAudio = async () => {
          try {
            await svc.removeSystemAudioStream?.();
            svc.setSystemAudioActive?.(false);
            if (isElectron() && window.electronAPI?.systemAudio?.stop) {
              await window.electronAPI.systemAudio.stop();
            }
          } catch (e) { /* best effort */ }
        };
        // stopRecording is re-entrancy-guarded (shares one in-flight promise),
        // so if the safety net's emergency stop already fired for the same
        // condition, this simply awaits it — no double-combine.
        await svc.stopRecording(this, stopSystemAudio);
        this.error = `Recording stopped: ${reason}`;
      } catch (error) {
        console.error('Error during emergency stop (falling back to flush-only):', error);
        // Fallback preserves the old behavior so chunks are at least persisted
        // for next-launch recovery if the real stop path threw.
        try { await this.flushCurrentState(); } catch (e) { /* ignore */ }
        this.phase = 'stopped';
        this.error = `Recording stopped: ${reason}`;
        if (isElectron()) {
          try { await window.electronAPI.recording.setInProgress(false); } catch (e) { /* ignore */ }
        }
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
          status: this.phase,
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

              // Fix 4: Handle recordings with missing/corrupt metadata
              if (!metaResult.success || !metaResult.metadata) {
                // No readable metadata - still check for chunks on disk
                const chunksResult = await storage.listFiles(`recordings/${recordId}/chunks`);
                const chunkCount = chunksResult.success ? (chunksResult.files?.length || 0) : 0;
                if (chunkCount > 0) {
                  // Check no combined file already exists
                  const hasM4a = await storage.exists(`recordings/${recordId}/combined.m4a`);
                  const hasWebm = await storage.exists(`recordings/${recordId}/combined.webm`);
                  const hasCombined = hasM4a || hasWebm;
                  if (!hasCombined) {
                    console.warn('Found', chunkCount, 'orphaned chunks without metadata for', recordId, '- attempting combine');
                    const combineResult = await this.combineChunksNative(recordId, { isRecovery: true });
                    if (combineResult.success) {
                      recoveredRecordings.push({
                        id: recordId, userId: null,
                        duration: combineResult.duration || 0,
                        fileSize: combineResult.fileSize || 0,
                        filePath: combineResult.outputPath,
                        uploadStatus: 'pending', recovered: true
                      });
                    }
                  }
                }
                continue;
              }

              const metadata = metaResult.metadata;

              // Check if this recording was interrupted
              if (metadata.status === 'recording' || metadata.status === 'interrupted') {
                console.warn('Found orphaned recording:', recordId);

                // Check if there are chunks
                const chunksResult = await storage.listFiles(`recordings/${recordId}/chunks`);
                const chunkCount = chunksResult.success ? (chunksResult.files?.length || 0) : 0;

                if (chunkCount > 0) {
                  console.log('Orphaned recording has', chunkCount, 'chunks - auto-combining');

                  const combineResult = await this.combineChunksNative(recordId, { isRecovery: true });

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
                      duration: metadata.duration || combineResult.duration || 0,
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

          // DMOB-3: reclaim disk from recordings already combined into a final
          // file but whose chunks were never cleaned (chunks are only deleted
          // after a *successful* upload, so repeated upload failures otherwise
          // accumulate GBs of redundant chunk data).
          await this._gcRedundantChunks(listResult.files);

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
      // FIX 8: Serialize concurrent saveChunk calls to prevent chunkIndex races
      const savePromise = this._chunkSaveQueue.then(async () => {
        // Default retry config
        let maxRetries = 3;
        let retryDelays = [1000, 2000, 4000];

        // Create chunk integrity before saving (V7 fix)
        const chunkIntegrity = createChunkIntegrity(this.chunkIndex, chunkData);

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            let result;

            if (isElectron()) {
              // Pass userId for crash recovery state tracking
              let timeout;
              try {
                result = await Promise.race([
                  window.electronAPI.recording.saveChunk(this.recordId, chunkData, this.chunkIndex, '.webm', this.userId),
                  new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Saving audio timed out; bytes retained for retry')), 30000); }),
                ]);
              } finally { clearTimeout(timeout); }
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
              // Only acknowledged writes advance integrity, inside this
              // serialized save loop with no await between its updates.
              if (this.integrity) {
                if (isElectron()) {
                  // Keep long desktop recordings linear instead of copying
                  // the entire growing array for every saved chunk.
                  this.integrity.chunks.push(chunkIntegrity);
                  this.integrity.totalSize += chunkIntegrity.size;
                } else {
                  // Mobile metadata writes retain a snapshot across an await.
                  this.integrity = addChunkToRecordingIntegrity(this.integrity, chunkIntegrity);
                }
              }
              this.chunkIndex++;
              return { success: true };
            } else {
              // Disk full: skip retries, return immediately
              if (result.diskFull) {
                return { success: false, error: 'Disk full', diskFull: true };
              }
              // Propagate error code from main process for specific handling
              const err = new Error(result.error || 'Failed to save chunk');
              err.code = result.code || null;
              throw err;
            }
          } catch (error) {
            console.error(`Error saving chunk (attempt ${attempt + 1}/${maxRetries + 1}):`, error);

            // Detect disk full — no point retrying, stop immediately
            if (error.code === 'ENOSPC') {
              console.error('Disk full (ENOSPC) — cannot save chunk, must stop recording');
              return { success: false, error: 'Disk full', code: 'ENOSPC', diskFull: true };
            }

            // Detect AV/EDR file locking (EBUSY, EACCES, EPERM) — use longer retries
            if (attempt === 0 && (error.code === 'EBUSY' || error.code === 'EACCES' || error.code === 'EPERM')) {
              console.warn('File lock detected (possible antivirus scan) — switching to extended retries');
              maxRetries = 5;
              retryDelays = [2000, 5000, 10000, 15000, 20000];
            }

            if (attempt < maxRetries) {
              const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
              console.log(`Retrying chunk save in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            } else {
              console.error('All chunk save retries exhausted, chunk may be lost');
              return { success: false, error: error.message, retriesExhausted: true };
            }
          }
        }

        return { success: false, error: 'Unexpected error in saveChunk' };
      });

      // Chain onto queue — catch to prevent queue from breaking on error
      this._chunkSaveQueue = savePromise.catch(() => {});

      return savePromise;
    },

    // Validate chunk sequence is contiguous (0, 1, 2, ..., N-1) with no gaps
    async _validateChunkSequence(recordId) {
      const chunksDir = `recordings/${recordId}/chunks`;
      const listResult = await storage.listFiles(chunksDir);

      if (!listResult.success || !listResult.files || listResult.files.length === 0) {
        return { valid: false, error: 'No chunks found', chunkCount: 0, gaps: [] };
      }

      // Parse chunk indices from filenames (chunk_000000.m4a → 0)
      const indices = listResult.files
        .map(f => {
          const match = f.match(/chunk_(\d+)\./);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter(i => i !== null)
        .sort((a, b) => a - b);

      if (indices.length === 0) {
        return { valid: false, error: 'No valid chunk files found', chunkCount: 0, gaps: [] };
      }

      // Check for gaps
      const gaps = [];
      for (let i = 0; i < indices.length - 1; i++) {
        if (indices[i + 1] !== indices[i] + 1) {
          for (let g = indices[i] + 1; g < indices[i + 1]; g++) {
            gaps.push(g);
          }
        }
      }

      // Check sequence starts at 0
      if (indices[0] !== 0) {
        for (let g = 0; g < indices[0]; g++) {
          gaps.unshift(g);
        }
      }

      return {
        valid: gaps.length === 0,
        chunkCount: indices.length,
        expectedCount: (indices[indices.length - 1] || 0) + 1,
        gaps,
        firstIndex: indices[0],
        lastIndex: indices[indices.length - 1]
      };
    },

    // Combine chunks on mobile using native plugin (proper M4A merging)
    async combineChunksNative(recordIdOverride = null, { isRecovery = false } = {}) {
      if (!isCapacitor()) {
        return { success: false, error: 'Not on mobile platform' };
      }

      try {
        const targetRecordId = recordIdOverride || this.recordId;

        // P0 Fix: Validate chunk sequence before combining
        const validation = await this._validateChunkSequence(targetRecordId);

        if (!validation.valid) {
          // No chunks at all vs. gaps in the sequence — different error messages
          if (validation.chunkCount === 0) {
            const msg = validation.error || 'No chunks found';
            console.error('Chunk validation failed:', msg);
            return { success: false, error: msg };
          }

          const gapMsg = `Chunk sequence has ${validation.gaps.length} gap(s) at indices [${validation.gaps.slice(0, 10).join(', ')}${validation.gaps.length > 10 ? '...' : ''}]. Found ${validation.chunkCount}/${validation.expectedCount} chunks.`;

          if (!isRecovery) {
            // Normal path: hard fail — do not produce audio with hidden gaps
            console.error('Chunk gap detected (hard fail):', gapMsg);
            return { success: false, error: `Chunk integrity failure: ${gapMsg}`, gapDetected: true, gaps: validation.gaps };
          }

          // Recovery path: ALWAYS proceed with whatever chunks exist. For a
          // crashed/orphaned recording, partial audio is strictly better than
          // discarding the user's recording — previously a <50% recovery was
          // refused, throwing away e.g. an hour of a gappy 3h meeting. The gap
          // is reported below so the loss is quantified, never hidden.
          console.warn(`Chunk gap detected (recovery mode, proceeding with ${validation.chunkCount}/${validation.expectedCount} chunks): ${gapMsg}`);
        }

        // Use native plugin for proper M4A/AAC combining via platform APIs
        // (AVMutableComposition on iOS, MediaMuxer on Android)
        const { registerPlugin } = await import('@capacitor/core');
        const BackgroundRecording = registerPlugin('BackgroundRecording');
        const result = await Promise.race([
          BackgroundRecording.combineChunks({ recordId: targetRecordId }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Native combineChunks timed out after 60s')), 60000)
          )
        ]);

        if (result.success) {
          // P0 Fix: Validate combined output file
          const outputPath = result.outputPath;
          if (!outputPath || !result.fileSize || result.fileSize === 0) {
            console.error('Combined file validation failed: empty or missing output');
            return { success: false, error: 'Combined file is empty or missing' };
          }

          // Verify output file exists and has expected size
          try {
            await storage.exists(outputPath).then(fileExists => {
              if (!fileExists) throw new Error('Combined file does not exist at reported path');
            });
          } catch (verifyError) {
            console.error('Combined file verification failed:', verifyError);
            return { success: false, error: `Output verification failed: ${verifyError.message}` };
          }

          return {
            success: true,
            outputPath,
            fileSize: result.fileSize,
            chunkCount: result.chunkCount,
            duration: result.duration ? Math.round(result.duration) : null,
            hadGaps: validation.gaps.length > 0 ? validation.gaps : undefined
          };
        }
        return { success: false, error: result.error || 'Native combine failed' };
      } catch (error) {
        console.error('Error combining chunks on mobile:', error);
        return { success: false, error: error.message };
      }
    },

    // DMOB-3: delete chunks for recordings that already have a combined output
    // file. The combined file is authoritative, so its source chunks are pure
    // redundancy — safe to reclaim even though the upload may not have succeeded
    // yet (the upload sends the combined file, not the chunks). Never touches
    // the active recording.
    async _gcRedundantChunks(recordIds) {
      if (!isCapacitor() || !Array.isArray(recordIds)) return;
      for (const recordId of recordIds) {
        if (recordId === this.recordId) continue;
        try {
          const hasCombined =
            (await storage.exists(`recordings/${recordId}/combined.m4a`)) ||
            (await storage.exists(`recordings/${recordId}/combined.webm`));
          if (!hasCombined) continue;
          const chunksDir = `recordings/${recordId}/chunks`;
          const chunksRes = await storage.listFiles(chunksDir);
          if (chunksRes.success && chunksRes.files && chunksRes.files.length > 0) {
            for (const f of chunksRes.files) {
              try { await storage.deleteFile(`${chunksDir}/${f}`); } catch (_) { /* best-effort */ }
            }
            console.log(`GC: removed ${chunksRes.files.length} redundant chunk(s) for ${recordId} (combined file exists)`);
          }
        } catch (e) {
          console.warn('Redundant-chunk GC failed for', recordId, e);
        }
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
      this.lockedFiles.set(recordId, Date.now()); // FIX 7: Store timestamp
      // Persist to disk so locks survive app restart
      if (isElectron() && window.electronAPI?.recording?.lockForUpload) {
        try {
          await window.electronAPI.recording.lockForUpload(recordId);
        } catch (e) {
          console.warn('Failed to persist lock to electron-store:', e);
        }
      } else if (isCapacitor() || !isElectron()) {
        try {
          localStorage.setItem('locked_recordings', JSON.stringify(Object.fromEntries(this.lockedFiles)));
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
          localStorage.setItem('locked_recordings', JSON.stringify(Object.fromEntries(this.lockedFiles)));
        } catch (e) {
          console.warn('Failed to update persistent locks:', e);
        }
      }
    },

    canDelete(recordId) {
      const lockTime = this.lockedFiles.get(recordId);
      if (!lockTime) return true;
      // FIX 7: Auto-expire locks older than 24 hours
      if (Date.now() - lockTime > 24 * 60 * 60 * 1000) {
        this.lockedFiles.delete(recordId);
        return true;
      }
      return false;
    },

    // Restore locks from persistent storage on initialization
    // FIX 7: Handles both old format (array of IDs) and new format ({id: timestamp})
    async _restoreLockedFiles() {
      try {
        if (isElectron() && window.electronAPI?.recording?.getLockedRecordings) {
          const locked = await window.electronAPI.recording.getLockedRecordings();
          if (Array.isArray(locked)) {
            // Old format: array of IDs — assign current timestamp
            locked.forEach(id => this.lockedFiles.set(id, Date.now()));
          }
        } else {
          const raw = localStorage.getItem('locked_recordings');
          if (raw) {
            const locked = JSON.parse(raw);
            if (Array.isArray(locked)) {
              // Old format: array of IDs — assign current timestamp
              locked.forEach(id => this.lockedFiles.set(id, Date.now()));
            } else if (locked && typeof locked === 'object') {
              // New format: {recordId: timestamp}
              Object.entries(locked).forEach(([id, ts]) => this.lockedFiles.set(id, ts));
            }
          }
        }
        if (this.lockedFiles.size > 0) {
          console.log('Restored persistent file locks:', [...this.lockedFiles.keys()]);
        }
      } catch (e) {
        console.warn('Failed to restore locked files:', e);
      }
    },

    // Shared recovery processing — used by both onForeground and cold-start
    async _processRecovery(source = 'unknown') {
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
                customVocabulary: [],
                // Recovery recs never carry prep - the merged history record does.
                ...(historyStore.recordings.find(r => r.id === rec.id)?.prep || rec.prep || {})
              });
            }
          }
          console.log(`Recovered ${recovery.recordings.length} recording(s) on ${source}`);
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

    updateUploadProgress(progress, bytesUploaded, bytesTotal) {
      this.uploadProgress = progress;
      this.bytesUploaded = bytesUploaded;
      this.bytesTotal = bytesTotal;
    },

    updateUploadRetry(attempt, maxRetries) {
      this.uploadRetryAttempt = attempt;
      this.uploadRetryMaxRetries = maxRetries;
      this.uploadProgress = 0;
      this.bytesUploaded = 0;
    },

    setUploading(metadata = {}) {
      this.phase ='uploading';
      this.uploadProgress = 0;
      this.uploadRetryAttempt = 0;
      this.uploadRetryMaxRetries = 0;
      if (metadata.createdAt) this.uploadMetadata.createdAt = metadata.createdAt;
      if (metadata.fileSize) this.uploadMetadata.fileSize = metadata.fileSize;
      if (metadata.finalDuration !== undefined) this.uploadMetadata.finalDuration = metadata.finalDuration;
    },

    setUploaded(audioFileId = null) {
      this.phase ='uploaded';
      this.uploadProgress = 100;
      if (audioFileId) {
        this.audioFileId = audioFileId;
      }
    },

    setFinalDuration(duration) {
      this.finalDuration = isFinite(duration) ? Math.round(duration) : 0;
    },

    setError(error) {
      this.error = error;
      this.phase ='error';
    },

    reset() {
      this.recordId = null;
      this.userId = null;
      this.phase ='idle';
      this.startTime = null;
      this.duration = 0;
      this.chunkIndex = 0;
      this.captureMode = null;
      this.audioFilePath = null;
      this.uploadProgress = 0;
      this.bytesUploaded = 0;
      this.bytesTotal = 0;
      this.uploadRetryAttempt = 0;
      this.uploadRetryMaxRetries = 0;
      this.error = null;
      this.uploadError = null;
      this.audioFileId = null;
      this.finalDuration = 0;
      this.currentFileSize = 0;
      this.uploadMetadata = {
        createdAt: null,
        fileSize: 0,
        finalDuration: 0
      };
      this.integrity = null;
      this.chunkSaveErrors = 0;
      this.chunkSaveErrorWarning = false;
      this._chunkSaveQueue = Promise.resolve(); // FIX 8: Reset mutex queue
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
