import { defineStore } from 'pinia';
import { v4 as uuidv4 } from 'uuid';

export const useRecordingStore = defineStore('recording', {
  state: () => ({
    recordId: null,
    status: 'idle', // idle | recording | paused | stopped | uploading | uploaded | error
    startTime: null,
    duration: 0, // in seconds
    chunkIndex: 0,
    audioFilePath: null,
    uploadProgress: 0,
    bytesUploaded: 0,
    bytesTotal: 0,
    error: null,
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
    }
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
    }
  },

  actions: {
    async startRecording() {
      try {
        this.recordId = uuidv4();
        this.status = 'recording';
        this.startTime = Date.now();
        this.duration = 0;
        this.chunkIndex = 0;
        this.error = null;

        // Notify main process that recording is starting (for window close protection)
        await window.electronAPI.recording.setInProgress(true);

        // Create session directory
        const result = await window.electronAPI.recording.createSession(this.recordId, '.webm');

        if (!result.success) {
          // Clear recording state on failure
          await window.electronAPI.recording.setInProgress(false);
          throw new Error(result.error || 'Failed to create recording session');
        }

        return { success: true, recordId: this.recordId };
      } catch (error) {
        this.error = error.message;
        this.status = 'error';
        // Ensure main process knows recording failed
        await window.electronAPI.recording.setInProgress(false);
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

        // Notify main process that recording stopped, now processing
        await window.electronAPI.recording.setInProgress(false);
        await window.electronAPI.recording.setProcessing(true);

        // Combine all chunks
        const result = await window.electronAPI.recording.combineChunks(this.recordId, '.webm');

        // Clear processing state
        await window.electronAPI.recording.setProcessing(false);

        if (result.success) {
          this.audioFilePath = result.outputPath;
          return { success: true, filePath: result.outputPath, warning: result.warning };
        } else {
          throw new Error(result.error || 'Failed to combine recording chunks');
        }
      } catch (error) {
        this.error = error.message;
        this.status = 'error';
        // Ensure states are cleared on error
        await window.electronAPI.recording.setInProgress(false);
        await window.electronAPI.recording.setProcessing(false);
        return { success: false, error: error.message };
      }
    },

    async saveChunk(chunkData) {
      const maxRetries = 3;
      const retryDelays = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await window.electronAPI.recording.saveChunk(
            this.recordId,
            chunkData,
            this.chunkIndex,
            '.webm'
          );

          if (result.success) {
            this.chunkIndex++;
            return { success: true };
          } else {
            throw new Error(result.error || 'Failed to save chunk');
          }
        } catch (error) {
          console.error(`Error saving chunk (attempt ${attempt + 1}/${maxRetries + 1}):`, error);

          // If we have retries left, wait and try again
          if (attempt < maxRetries) {
            const delay = retryDelays[attempt];
            console.log(`Retrying chunk save in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            // All retries exhausted
            console.error('All chunk save retries exhausted, chunk may be lost');
            return { success: false, error: error.message, retriesExhausted: true };
          }
        }
      }

      return { success: false, error: 'Unexpected error in saveChunk' };
    },

    updateDuration(seconds) {
      this.duration = seconds;
    },

    // Create session file from current chunks (for auto-split)
    async createSessionFile() {
      try {
        const result = await window.electronAPI.recording.createSessionFile(this.recordId, '.webm');
        if (result.success) {
          console.log('Session file created successfully');
          return { success: true };
        } else {
          throw new Error(result.error || 'Failed to create session file');
        }
      } catch (error) {
        console.error('Error creating session file:', error);
        return { success: false, error: error.message };
      }
    },

    // Reset chunk index after auto-split
    resetChunkIndex() {
      this.chunkIndex = 0;
      console.log('Chunk index reset for new session');
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

    setUploaded() {
      this.status = 'uploaded';
      this.uploadProgress = 100;
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
      this.status = 'idle';
      this.startTime = null;
      this.duration = 0;
      this.chunkIndex = 0;
      this.audioFilePath = null;
      this.uploadProgress = 0;
      this.bytesUploaded = 0;
      this.bytesTotal = 0;
      this.error = null;
      this.uploadMetadata = {
        createdAt: null,
        fileSize: 0,
        finalDuration: 0
      };
    }
  }
});
