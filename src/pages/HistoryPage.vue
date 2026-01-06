<template>
  <q-page class="history-page">
    <div class="page-header">
      <h1>Recording History</h1>
      <p class="text-subtitle">View and manage your past recordings</p>
    </div>

    <!-- Upload Progress Banner -->
    <div class="upload-progress-banner" v-if="uploadingRecordingId">
      <div class="progress-content">
        <q-spinner-dots color="white" size="20px" />
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
    <div class="stats-row" v-if="historyStore.recordingCount > 0">
      <div class="stat-item">
        <span class="stat-value">{{ historyStore.recordingCount }}</span>
        <span class="stat-label">Total</span>
      </div>
      <div class="stat-item">
        <span class="stat-value text-positive">{{ historyStore.uploadedRecordings.length }}</span>
        <span class="stat-label">Uploaded</span>
      </div>
      <div class="stat-item">
        <span class="stat-value text-warning">{{ historyStore.pendingRecordings.length }}</span>
        <span class="stat-label">Pending</span>
      </div>
      <div class="stat-item" v-if="historyStore.failedRecordings.length > 0">
        <span class="stat-value text-negative">{{ historyStore.failedRecordings.length }}</span>
        <span class="stat-label">Failed</span>
      </div>
    </div>

    <!-- Loading state -->
    <div class="loading-state" v-if="historyStore.loading">
      <q-spinner-dots color="primary" size="40px" />
      <p>Loading recordings...</p>
    </div>

    <!-- Empty state -->
    <div class="empty-state" v-else-if="historyStore.recordingCount === 0">
      <q-icon name="mic_none" class="empty-icon" />
      <div class="empty-title">No recordings yet</div>
      <div class="empty-subtitle">
        Start recording to see your history here
      </div>
      <q-btn
        unelevated
        class="gradient-btn q-mt-md"
        label="Start Recording"
        icon="mic"
        @click="goToRecord"
      />
    </div>

    <!-- Recordings list -->
    <div class="recordings-list" v-else>
      <!-- Active Upload Card (from current recording session) -->
      <div class="uploading-card" v-if="recordingStore.hasActiveUpload">
        <div class="uploading-header">
          <div class="uploading-info">
            <q-spinner-dots size="16px" color="primary" />
            <span class="uploading-title">Uploading new recording...</span>
          </div>
          <span class="uploading-progress">{{ Math.min(recordingStore.activeUploadProgress, 99) }}%</span>
        </div>
        <q-linear-progress
          :value="Math.min(recordingStore.activeUploadProgress, 99) / 100"
          color="primary"
          size="4px"
          rounded
          class="uploading-bar"
        />
        <div class="uploading-meta">
          <span v-if="recordingStore.backgroundUpload.active && recordingStore.backgroundUpload.metadata">
            Duration: {{ formatDuration(recordingStore.backgroundUpload.metadata.finalDuration) }}
          </span>
          <span v-else-if="recordingStore.uploadMetadata.finalDuration">
            Duration: {{ formatDuration(recordingStore.uploadMetadata.finalDuration) }}
          </span>
        </div>
      </div>

      <RecordingHistoryCard
        v-for="recording in historyStore.allRecordings"
        :key="recording.id"
        :recording="recording"
        :uploading="uploadingRecordingId === recording.id"
        @upload="handleUpload"
        @retry="handleUpload"
        @deleted="onRecordingDeleted"
      />
    </div>
  </q-page>
</template>

<script>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import { useAuthStore } from '../stores/auth';
import { useRecordingStore } from '../stores/recording';
import RecordingHistoryCard from '../components/RecordingHistoryCard.vue';

export default {
  name: 'HistoryPage',

  components: {
    RecordingHistoryCard
  },

  setup() {
    const router = useRouter();
    const $q = useQuasar();
    const historyStore = useRecordingsHistoryStore();
    const authStore = useAuthStore();
    const recordingStore = useRecordingStore();

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
      if (!seconds) return '00:00';
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

      try {
        const result = await window.electronAPI.upload.start({
          recordId: recording.id,
          filePath: recording.filePath,
          metadata: {
            duration: recording.duration
          }
        });

        if (result.success) {
          // Update history entry
          await historyStore.updateRecording(recording.id, {
            uploadStatus: 'uploaded',
            transcriptionId: result.transcriptionId,
            audioFileId: result.audioFileId,
            uploadError: null
          });

          // Handle delete after upload preference
          if (recording.storagePreference === 'delete_after_upload') {
            try {
              await window.electronAPI.recording.deleteRecording(recording.id);
              await historyStore.updateRecording(recording.id, { filePath: null });
            } catch (e) {
              console.warn('Could not delete file after upload:', e);
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

      // Set up upload progress listeners
      window.electronAPI.upload.onProgress((data) => {
        // Update local upload (re-uploading from history)
        if (data.recordId === uploadingRecordingId.value) {
          uploadProgress.value = data.progress;
        }
        // Update recording store for current/background uploads
        if (data.recordId === recordingStore.recordId) {
          recordingStore.updateUploadProgress(data.progress, data.bytesUploaded, data.bytesTotal);
        }
        if (recordingStore.backgroundUpload.active && data.recordId === recordingStore.backgroundUpload.recordId) {
          recordingStore.updateBackgroundUploadProgress(data.recordId, data.progress, data.bytesUploaded, data.bytesTotal);
        }
      });

      window.electronAPI.upload.onRetry((data) => {
        if (data.recordId === uploadingRecordingId.value) {
          retryAttempt.value = data.attempt;
        }
      });
    });

    onUnmounted(() => {
      window.electronAPI.upload.removeAllListeners();
    });

    return {
      historyStore,
      recordingStore,
      uploadingRecordingId,
      uploadProgress,
      retryAttempt,
      uploadStatusText,
      goToRecord,
      formatDuration,
      handleUpload,
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
}

.stat-item {
  display: flex;
  flex-direction: column;

  .stat-value {
    font-size: 24px;
    font-weight: 600;
    color: #1e293b;

    &.text-positive { color: #22c55e; }
    &.text-warning { color: #f59e0b; }
    &.text-negative { color: #ef4444; }
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
