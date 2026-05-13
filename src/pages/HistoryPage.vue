<template>
  <q-page class="history-page">
    <div class="page-header">
      <h1>{{ $t('historyTitle') }}</h1>
      <p class="text-subtitle">
        {{ $t('historySubtitle') }}
      </p>
    </div>

    <!-- Upload Progress Banner -->
    <div
      v-if="uploadingRecordingId"
      class="upload-progress-banner"
    >
      <div class="progress-content">
        <q-spinner-dots
          color="white"
          size="20px"
        />
        <span>{{ uploadStatusText }}</span>
      </div>
      <div class="progress-bar-container">
        <q-linear-progress
          :value="uploadProgress / 100"
          color="white"
          size="4px"
          rounded
        />
      </div>
    </div>

    <!-- Stats summary -->
    <div
      v-if="historyStore.recordingCount > 0"
      class="stats-row"
    >
      <div class="stat-item">
        <span class="stat-value">{{ historyStore.recordingCount }}</span>
        <span class="stat-label">{{ $t('statsTotal') }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-value text-positive">{{ historyStore.uploadedRecordings.length }}</span>
        <span class="stat-label">{{ $t('statsUploaded') }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-value text-warning">{{ historyStore.pendingRecordings.length }}</span>
        <span class="stat-label">{{ $t('statsPending') }}</span>
      </div>
      <div
        v-if="historyStore.transferringRecordings.length > 0"
        class="stat-item"
      >
        <span
          class="stat-value"
          style="color: #6366f1;"
        >{{ historyStore.transferringRecordings.length }}</span>
        <span class="stat-label">{{ $t('statsTransferring') }}</span>
      </div>
      <div
        v-if="historyStore.skippedRecordings.length > 0"
        class="stat-item"
      >
        <span
          class="stat-value"
          style="color: #94a3b8;"
        >{{ historyStore.skippedRecordings.length }}</span>
        <span class="stat-label">{{ $t('statsSkipped') }}</span>
      </div>
      <div
        v-if="historyStore.failedRecordings.length > 0"
        class="stat-item"
      >
        <span class="stat-value text-negative">{{ historyStore.failedRecordings.length }}</span>
        <span class="stat-label">{{ $t('statsFailed') }}</span>
      </div>
    </div>

    <!-- Loading state -->
    <div
      v-if="historyStore.loading"
      class="loading-state"
    >
      <q-spinner-dots
        color="primary"
        size="40px"
      />
      <p>{{ $t('loadingRecordings') }}</p>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="historyStore.recordingCount === 0"
      class="empty-state"
    >
      <q-icon
        name="mic_none"
        class="empty-icon"
      />
      <div class="empty-title">
        {{ $t('noRecordings') }}
      </div>
      <div class="empty-subtitle">
        {{ $t('startRecording') }}
      </div>
      <q-btn
        unelevated
        class="gradient-btn q-mt-md"
        :label="$t('aboutStartRecording')"
        icon="mic"
        @click="goToRecord"
      />
    </div>

    <!-- Recordings list -->
    <div
      v-else
      class="recordings-list"
    >
      <!-- Active Upload Card (from current recording session) -->
      <div
        v-if="recordingStore.hasActiveUpload"
        class="uploading-card"
      >
        <div class="uploading-header">
          <div class="uploading-info">
            <q-spinner-dots
              size="16px"
              color="primary"
            />
            <span class="uploading-title">{{ $t('uploadingNewRecording') }}</span>
          </div>
          <div class="uploading-actions">
            <span class="uploading-progress">{{ Math.min(recordingStore.activeUploadProgress, 99) }}%</span>
            <q-btn
              flat
              round
              dense
              icon="close"
              color="negative"
              size="xs"
              @click="cancelActiveUpload"
            >
              <q-tooltip>{{ $t('cancelUpload') }}</q-tooltip>
            </q-btn>
          </div>
        </div>
        <q-linear-progress
          :value="Math.min(recordingStore.activeUploadProgress, 99) / 100"
          color="primary"
          size="4px"
          rounded
          class="uploading-bar"
        />
        <div class="uploading-meta">
          <span v-if="recordingStore.uploadMetadata.finalDuration">
            {{ formatDuration(recordingStore.uploadMetadata.finalDuration) }}
          </span>
        </div>
      </div>

      <!-- Mobile: group device vs app recordings -->
      <template v-if="isMobile && historyStore.hasDeviceRecordings">
        <div class="source-section">
          <div class="source-section-header">
            <q-icon
              name="bluetooth"
              size="16px"
              color="primary"
            />
            <span>{{ $t('deviceRecordingsSection') }}</span>
            <span class="section-count">{{ historyStore.deviceRecordings.length }}</span>
          </div>
          <RecordingHistoryCard
            v-for="recording in historyStore.deviceRecordings"
            :key="recording.id"
            :recording="recording"
            :uploading="uploadingRecordingId === recording.id"
            @upload="handleUpload"
            @retry="handleUpload"
            @reupload="handleReupload"
            @deleted="onRecordingDeleted"
            @cancel-transfer="handleCancelTransfer"
            @resync="handleResync"
          />
        </div>
        <div
          v-if="historyStore.appRecordings.length > 0"
          class="source-section"
        >
          <div class="source-section-header">
            <q-icon
              name="mic"
              size="16px"
              color="primary"
            />
            <span>{{ $t('appRecordingsSection') }}</span>
            <span class="section-count">{{ historyStore.appRecordings.length }}</span>
          </div>
          <RecordingHistoryCard
            v-for="recording in historyStore.appRecordings"
            :key="recording.id"
            :recording="recording"
            :uploading="uploadingRecordingId === recording.id"
            @upload="handleUpload"
            @retry="handleUpload"
            @reupload="handleReupload"
            @deleted="onRecordingDeleted"
            @cancel-transfer="handleCancelTransfer"
            @resync="handleResync"
          />
        </div>
      </template>

      <!-- Desktop or no device recordings: flat chronological list -->
      <template v-else>
        <RecordingHistoryCard
          v-for="recording in historyStore.allRecordings"
          :key="recording.id"
          :recording="recording"
          :uploading="uploadingRecordingId === recording.id"
          @upload="handleUpload"
          @retry="handleUpload"
          @reupload="handleReupload"
          @deleted="onRecordingDeleted"
          @cancel-transfer="handleCancelTransfer"
          @resync="handleResync"
        />
      </template>
    </div>
  </q-page>
</template>

<script>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import { useAuthStore } from '../stores/auth';
import { useRecordingStore } from '../stores/recording';
import { isElectron, isCapacitor, isMobile as isMobilePlatform } from '../utils/platform';
import { uploadWithVerification } from '../services/upload';
import { getApiUrlSync } from '../services/api';
import { pickAudioFile } from '../services/filePicker';
import { captureException } from '../boot/sentry';
import RecordingHistoryCard from '../components/RecordingHistoryCard.vue';

export default {
  name: 'HistoryPage',

  components: {
    RecordingHistoryCard
  },

  setup() {
    const router = useRouter();
    const $q = useQuasar();
    const { t } = useI18n();
    const historyStore = useRecordingsHistoryStore();
    const authStore = useAuthStore();
    const recordingStore = useRecordingStore();

    const isMobile = computed(() => isMobilePlatform());
    const uploadingRecordingId = ref(null);
    const uploadProgress = ref(0);
    const retryAttempt = ref(0);

    const uploadStatusText = computed(() => {
      if (retryAttempt.value > 0) {
        return `Retry attempt ${retryAttempt.value}... ${uploadProgress.value}%`;
      }
      return `Uploading... ${uploadProgress.value}%`;
    });

    const goToRecord = () => {
      router.push('/record');
    };

    const formatDuration = (seconds) => {
      if (!seconds || !isFinite(seconds)) return '00:00';
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      }
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    };

    const handleUpload = async (recording) => {
      if (!authStore.isAuthenticated) {
        $q.notify({
          type: 'warning',
          message: 'Please login to upload recordings'
        });
        return;
      }

      if (!recording.filePath) {
        $q.notify({
          type: 'negative',
          message: 'Recording file not found. It may have been deleted.'
        });
        return;
      }

      // Set uploading state
      uploadingRecordingId.value = recording.id;
      uploadProgress.value = 0;
      retryAttempt.value = 0;

      // P0 Data Loss Fix: Lock file before upload to prevent deletion during upload
      recordingStore.lockForUpload(recording.id);

      try {
        let result;

        if (isElectron()) {
          result = await window.electronAPI.upload.start({
            recordId: recording.id,
            filePath: recording.filePath,
            metadata: {
              duration: recording.duration?.toString()
            }
          });

          // Handle token expiration - attempt refresh and retry
          if (!result.success && result.status === 401) {
            console.log('Token expired, attempting refresh...');
            const refreshResult = await authStore.handleAuthError();
            if (refreshResult.success) {
              console.log('Token refreshed, retrying upload...');
              result = await window.electronAPI.upload.start({
                recordId: recording.id,
                filePath: recording.filePath,
                metadata: {
                  duration: recording.duration?.toString()
                }
              });
            } else if (refreshResult.shouldLogout) {
              result = { success: false, error: 'Session expired. Please log in again.' };
            }
          }
        } else if (isCapacitor()) {
          result = await uploadWithVerification({
            filePath: recording.filePath,
            file: recording.file, // File object for reupload via file picker
            recordId: recording.id,
            apiUrl: getApiUrlSync(),
            authToken: authStore.token,
            metadata: { duration: recording.duration?.toString() },
            onProgress: (p) => { uploadProgress.value = p; },
            getAuthStore: () => authStore
          });
        } else {
          result = { success: false, error: 'Unsupported platform' };
        }

        if (result.success) {
          // Update history entry
          await historyStore.updateRecording(recording.id, {
            uploadStatus: 'uploaded',
            transcriptionId: result.transcriptionId,
            audioFileId: result.audioFileId,
            uploadError: null
          });

          // P0 Data Loss Fix: Handle delete after upload with lock check
          if (recording.storagePreference === 'delete_after_upload') {
            if (result.canDelete && recordingStore.canDelete(recording.id)) {
              try {
                if (isElectron()) {
                  await window.electronAPI.recording.deleteRecording(recording.id);
                }
                // On mobile, skip file deletion for now (files managed by storage service)
                await historyStore.updateRecording(recording.id, { filePath: null });
                recordingStore.unlockFile(recording.id);
              } catch (e) {
                console.warn('Could not delete file after upload:', e);
              }
            } else {
              console.warn('File not deleted: upload not verified or file is locked');
            }
          }

          $q.notify({
            type: 'positive',
            message: 'Recording uploaded successfully'
          });
        } else {
          await historyStore.updateRecording(recording.id, {
            uploadStatus: 'failed',
            uploadError: result.error
          });

          captureException(new Error(`History upload failed: ${result.error || 'unknown'}`), {
            tags: { action: 'history_upload', upload_path: 'history_card' },
            extra: { recordingId: recording.id, status: result.status, source: recording.source }
          });

          $q.notify({
            type: 'negative',
            message: result.error || 'Upload failed',
            timeout: 5000
          });
        }
      } catch (error) {
        await historyStore.updateRecording(recording.id, {
          uploadStatus: 'failed',
          uploadError: error.message
        });

        captureException(error, {
          tags: { action: 'history_upload', upload_path: 'history_card' },
          extra: { recordingId: recording.id, source: recording.source }
        });

        $q.notify({
          type: 'negative',
          message: error.message || 'Upload error',
          timeout: 5000
        });
      } finally {
        uploadingRecordingId.value = null;
        uploadProgress.value = 0;
        retryAttempt.value = 0;
      }
    };

    const handleReupload = async (recording) => {
      const result = await pickAudioFile();
      if (!result.success || result.cancelled) return;

      // Update the recording with the new file path
      await historyStore.updateRecording(recording.id, {
        filePath: result.filePath,
        fileSize: result.fileSize || recording.fileSize
      });

      // Fetch updated recording and start upload
      const updated = historyStore.allRecordings.find(r => r.id === recording.id);
      if (updated) {
        handleUpload({ ...updated, file: result.file });
      }
    };

    const handleResync = async (recording) => {
      try {
        const { useDeviceStore } = await import('../stores/device');
        const deviceStore = useDeviceStore();

        if (!deviceStore.isConnected) {
          $q.notify({
            type: 'warning',
            message: t('connectDeviceFirst'),
            timeout: 3000
          });
          return;
        }

        // Remove from skipped files so sync can proceed
        const filename = recording.deviceFilename;
        if (filename) {
          await deviceStore._removeSkippedFile(filename);

          // Refresh file list from device before checking
          await deviceStore.fetchFileList();

          // Find the file on the device and sync it
          const deviceFile = deviceStore.deviceFiles.find(f => f.file === filename);
          if (deviceFile) {
            // Delete the cancelled history entry — a new one will be created during sync
            await historyStore.deleteRecording(recording.id, false);
            await deviceStore.syncFile(deviceFile);
          } else {
            $q.notify({
              type: 'warning',
              message: t('fileNotOnDevice'),
              timeout: 3000
            });
          }
        }
      } catch (e) {
        console.warn('Resync error:', e);
        captureException(e, {
          tags: { action: 'history_resync' },
          extra: { recordingId: recording.id, deviceFilename: recording.deviceFilename }
        });
      }
    };

    const handleCancelTransfer = async (recording) => {
      try {
        // Cancel BLE device sync if it's a device recording (aborts download phase)
        if (recording?.source === 'device') {
          const { useDeviceStore } = await import('../stores/device');
          const deviceStore = useDeviceStore();
          await deviceStore.cancelSync();
        }

        // Abort the active cloud upload XHR (mobile) or main-process upload (desktop).
        // Also removes the item from the persistent mobile queue so it won't
        // auto-retry after the user said cancel.
        if (recording?.id) {
          if (isElectron() && window.electronAPI?.upload?.cancel) {
            try { await window.electronAPI.upload.cancel(recording.id); } catch { /* best-effort */ }
          } else if (isCapacitor()) {
            try {
              const { cancelUpload } = await import('../services/upload');
              await cancelUpload(recording.id, { removeFromQueue: true });
            } catch (e) { console.warn('Cancel upload failed:', e); }
          }
        }

        // Mark as 'cancelled' so auto-queue-processing doesn't immediately
        // re-pick it up, and the UI distinguishes user-cancel from auto-failure.
        // Previous behavior set 'pending' which re-triggered the upload.
        if (recording?.id && (recording.uploadStatus === 'uploading' || recording.uploadStatus === 'pending')) {
          await historyStore.updateRecording(recording.id, { uploadStatus: 'cancelled' });
        }

        // Clear local uploading state
        if (uploadingRecordingId.value === recording?.id) {
          uploadingRecordingId.value = null;
        }
      } catch (e) {
        console.warn('Cancel transfer error:', e);
      }
    };

    const cancelActiveUpload = async () => {
      if (isElectron()) {
        await window.electronAPI.upload.cancel(recordingStore.recordId);
      } else if (isCapacitor()) {
        const { cancelUpload } = await import('../services/upload');
        await cancelUpload(recordingStore.recordId);
      }
      recordingStore.phase = 'idle';
      recordingStore.uploadProgress = 0;
    };

    const onRecordingDeleted = () => {
      $q.notify({
        type: 'info',
        message: 'Recording deleted'
      });
    };

    onMounted(async () => {
      if (!historyStore.loaded) {
        await historyStore.loadRecordings();
      }

      // Electron-only: Set up upload progress listeners
      if (isElectron() && window.electronAPI?.upload) {
        window.electronAPI.upload.onProgress((data) => {
          // Update local upload (re-uploading from history)
          if (data.recordId === uploadingRecordingId.value) {
            uploadProgress.value = data.progress;
          }
          // Update recording store for current/background uploads
          if (data.recordId === recordingStore.recordId) {
            recordingStore.updateUploadProgress(data.progress, data.bytesUploaded, data.bytesTotal);
          }
          // Background uploads removed — pipeline is now linear
        });

        window.electronAPI.upload.onRetry((data) => {
          if (data.recordId === uploadingRecordingId.value) {
            retryAttempt.value = data.attempt;
          }
        });
      }
    });

    onUnmounted(() => {
      if (isElectron() && window.electronAPI?.upload?.removeAllListeners) {
        window.electronAPI.upload.removeAllListeners();
      }
    });

    return {
      historyStore,
      recordingStore,
      isMobile,
      uploadingRecordingId,
      uploadProgress,
      retryAttempt,
      uploadStatusText,
      goToRecord,
      formatDuration,
      handleUpload,
      handleReupload,
      handleResync,
      handleCancelTransfer,
      cancelActiveUpload,
      onRecordingDeleted
    };
  }
};
</script>

<style lang="scss" scoped>
.history-page {
  padding: 32px;
  max-width: 1200px;
  margin: 0 auto;

  @media (max-width: 600px) {
    padding: 16px;
  }
}

.page-header {
  margin-bottom: 32px;

  h1 {
    font-size: 28px;
    font-weight: 600;
    margin: 0 0 8px 0;
    color: #1e293b;
  }

  .text-subtitle {
    color: #64748b;
    font-size: 15px;
    margin: 0;
  }

  @media (max-width: 600px) {
    margin-bottom: 20px;

    h1 {
      font-size: 22px;
    }
  }
}

.upload-progress-banner {
  background: linear-gradient(90deg, #6366F1 0%, #8B5CF6 100%);
  border-radius: 12px;
  padding: 16px 24px;
  margin-bottom: 24px;
  color: white;

  .progress-content {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
    font-weight: 500;
    font-size: 15px;
  }

  .progress-bar-container {
    opacity: 0.8;
  }
}

.stats-row {
  display: flex;
  gap: 32px;
  margin-bottom: 24px;
  padding: 20px 24px;
  background: white;
  border-radius: 12px;
  border: 1px solid #e2e8f0;

  @media (max-width: 600px) {
    gap: 12px;
    flex-wrap: wrap;
    justify-content: space-around;
    padding: 16px;
  }
}

.stat-item {
  display: flex;
  flex-direction: column;

  @media (max-width: 600px) {
    min-width: 80px;
    text-align: center;
  }

  .stat-value {
    font-size: 24px;
    font-weight: 600;
    color: #1e293b;

    &.text-positive { color: #22c55e; }
    &.text-warning { color: #f59e0b; }
    &.text-negative { color: #ef4444; }

    @media (max-width: 600px) {
      font-size: 20px;
    }
  }

  .stat-label {
    font-size: 13px;
    color: #64748b;
    margin-top: 4px;
  }
}

.loading-state {
  text-align: center;
  padding: 64px;
  color: #64748b;
  font-size: 15px;

  p {
    margin-top: 16px;
  }
}

.empty-state {
  text-align: center;
  padding: 64px 32px;
  background: white;
  border-radius: 12px;
  border: 1px solid #e2e8f0;

  .empty-icon {
    font-size: 64px;
    color: #94a3b8;
    margin-bottom: 20px;
  }

  .empty-title {
    font-size: 20px;
    font-weight: 600;
    color: #1e293b;
    margin-bottom: 8px;
  }

  .empty-subtitle {
    color: #64748b;
    font-size: 15px;
  }
}

.recordings-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.source-section {
  margin-bottom: 16px;
}

.source-section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  font-size: 13px;
  font-weight: 600;
  color: #475569;
  text-transform: uppercase;
  letter-spacing: 0.5px;

  .section-count {
    font-weight: 400;
    color: #94a3b8;
    font-size: 12px;
  }
}

.uploading-card {
  background: white;
  border: 1px solid #e2e8f0;
  border-left: 4px solid #6366F1;
  border-radius: 12px;
  padding: 20px 24px;

  .uploading-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .uploading-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .uploading-title {
    font-size: 16px;
    font-weight: 500;
    color: #1e293b;
  }

  .uploading-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .uploading-progress {
    font-size: 15px;
    font-weight: 600;
    color: #6366F1;
  }

  .uploading-bar {
    margin-bottom: 12px;
  }

  .uploading-meta {
    font-size: 13px;
    color: #64748b;
  }
}
</style>
