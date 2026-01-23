<template>
  <q-page class="upload-page">
    <div class="upload-container">
      <!-- Mode Tab Switcher -->
      <ModeTabSwitcher />

      <!-- IDLE STATE: Upload form -->
      <div
        v-if="!isProcessing && !isUploading && !isUploaded && !uploadError"
        class="idle-layout"
      >
        <!-- Upload Card -->
        <div
          class="upload-card modern-card no-hover clickable"
          :class="{ 'drag-over': isDragOver }"
          @click="selectFileForUpload"
          @dragover.prevent="onDragOver"
          @dragleave.prevent="onDragLeave"
          @drop.prevent="onDrop"
        >
          <div class="upload-content">
            <div
              class="upload-icon-wrapper"
              :class="{ 'drag-active': isDragOver }"
            >
              <q-icon
                :name="isDragOver ? 'file_download' : 'cloud_upload'"
                :size="isDragOver ? '48px' : '40px'"
                :color="isDragOver ? 'primary' : 'grey-6'"
              />
            </div>
            <h2>{{ isDragOver ? $t('dropHere') : $t('uploadFile') }}</h2>
            <p class="upload-desc">
              {{ $t('uploadDesc') }}
            </p>
            <q-btn
              unelevated
              color="primary"
              :label="$t('selectFile')"
              icon="folder_open"
              :loading="isFileLoading"
              class="upload-btn"
              @click.stop="selectFileForUpload"
            />
            <div class="drag-drop-hint">
              <q-icon
                name="mouse"
                size="14px"
              />
              <span>{{ $t('dragDropHint') }}</span>
            </div>
            <div class="supported-formats">
              MP3, MP4, WAV, M4A, WEBM, OGG, FLAC, AAC, MOV
            </div>
          </div>
        </div>

        <!-- Transcription Options -->
        <TranscriptionOptions
          :title="transcriptionStore.sessionTitle"
          :session-vocabulary="transcriptionStore.sessionVocabulary"
          :global-vocabulary="transcriptionStore.globalVocabulary"
          @update:title="updateTitle"
          @add-word="addSessionWord"
          @remove-word="removeSessionWord"
        />
      </div>

      <!-- Processing/Upload Progress Section -->
      <div
        v-if="showUploadSection"
        class="upload-progress-card modern-card no-hover"
      >
        <!-- Only show header during processing/uploading/error, not when complete -->
        <div
          v-if="!isUploaded"
          class="progress-header"
        >
          <q-icon
            :name="progressIcon"
            size="sm"
            :color="progressIconColor"
          />
          <span>{{ progressHeaderText }}</span>
        </div>

        <!-- Processing state -->
        <div
          v-if="isProcessing"
          class="progress-content"
        >
          <div class="processing-state">
            <q-spinner-dots
              color="primary"
              size="40px"
            />
            <span>Processing file...</span>
          </div>
        </div>

        <!-- Uploading state -->
        <div
          v-else-if="isUploading"
          class="progress-content"
        >
          <div class="upload-progress-section">
            <div class="progress-info">
              <span class="progress-text">
                {{ displayProgress >= 100 ? 'Processing on server...' : (retryAttempt > 0 ? `Retry attempt ${retryAttempt}...` : 'Uploading...') }}
              </span>
              <span class="progress-percent">{{ Math.min(displayProgress, 99) }}%</span>
            </div>
            <q-linear-progress
              v-if="displayProgress < 100"
              :value="Math.min(displayProgress, 99) / 100"
              color="primary"
              size="8px"
              rounded
            />
            <q-linear-progress
              v-else
              indeterminate
              color="primary"
              size="8px"
              rounded
            />
            <div
              v-if="displayProgress < 100"
              class="progress-meta"
            >
              <span>{{ formatBytes(recordingStore.bytesUploaded) }} / {{ formatBytes(recordingStore.bytesTotal) }}</span>
            </div>
            <div
              v-else
              class="progress-meta"
            >
              <span>Upload complete, waiting for server response...</span>
            </div>
          </div>
        </div>

        <!-- Upload Error state -->
        <div
          v-else-if="uploadError"
          class="progress-content"
        >
          <div class="error-state">
            <q-icon
              name="cloud_off"
              size="lg"
              color="negative"
            />
            <div class="error-info">
              <span class="error-title">Upload Failed</span>
              <span class="error-message">{{ uploadError }}</span>
            </div>
          </div>

          <div class="error-actions">
            <q-btn
              unelevated
              class="gradient-btn"
              label="Retry Upload"
              icon="refresh"
              :loading="isRetrying"
              @click="retryUpload"
            />
            <q-btn
              flat
              color="grey-7"
              :label="$t('newRecording')"
              icon="cloud_upload"
              @click="handleReset"
            />
          </div>
        </div>

        <!-- Upload Complete state -->
        <div
          v-else-if="isUploaded"
          class="upload-success"
        >
          <!-- Main CTA: View Transcript -->
          <div
            v-if="currentAudioFileId"
            class="transcript-cta"
          >
            <div class="cta-icon">
              <q-icon
                name="check_circle"
                size="80px"
                color="positive"
              />
            </div>
            <h3 class="cta-title">
              {{ $t('transcriptReady') }}
            </h3>
            <p class="cta-subtitle">
              {{ $t('transcriptCta') }}
            </p>

            <!-- Prominent clickable button with animation -->
            <div class="cta-button-wrapper">
              <q-btn
                unelevated
                class="main-cta-button pulse-attention"
                @click="openInSuisseNotes"
              >
                <div class="button-content">
                  <q-icon
                    name="open_in_new"
                    size="28px"
                    class="q-mr-md"
                  />
                  <div class="button-text">
                    <span class="button-label">{{ $t('openInSuisseNotes') }}</span>
                    <span class="button-hint">{{ $t('clickHereToView') }}</span>
                  </div>
                  <q-icon
                    name="arrow_forward"
                    size="24px"
                    class="q-ml-md arrow-icon"
                  />
                </div>
              </q-btn>
            </div>

            <!-- Copy Link Button -->
            <div class="copy-link-section">
              <q-btn
                flat
                color="primary"
                :label="$t('copyLink')"
                icon="content_copy"
                size="sm"
                class="copy-link-btn"
                @click="copyTranscriptUrl"
              />
              <span class="copy-hint">{{ $t('copyLinkHint') }}</span>
            </div>
          </div>

          <!-- URL Display -->
          <div
            v-if="currentAudioFileId"
            class="url-display-section"
          >
            <div class="url-label">
              <q-icon
                name="link"
                size="xs"
                color="grey-6"
              />
              <span>{{ $t('transcriptUrlLabel') }}</span>
            </div>
            <div class="url-value">
              <code>https://app.suisse-notes.ch/meeting/audio/{{ currentAudioFileId }}</code>
              <q-btn
                flat
                round
                dense
                icon="content_copy"
                size="xs"
                color="primary"
                @click="copyTranscriptUrl"
              >
                <q-tooltip>{{ $t('copyLink') }}</q-tooltip>
              </q-btn>
            </div>
          </div>

          <!-- Secondary info -->
          <div class="success-secondary">
            <div class="success-badge">
              <q-icon
                name="check_circle"
                size="sm"
                color="positive"
              />
              <span>{{ $t('uploadComplete') }}</span>
            </div>
          </div>

          <div class="success-actions">
            <q-btn
              outline
              color="primary"
              label="Upload Another"
              icon="cloud_upload"
              class="secondary-action-btn"
              @click="handleReset"
            />
            <q-btn
              flat
              color="grey-7"
              :label="$t('viewHistory')"
              icon="history"
              class="secondary-action-btn"
              @click="goToHistory"
            />
          </div>
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { useRecordingStore } from '../stores/recording';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import { useTranscriptionSettingsStore } from '../stores/transcription-settings';
import ModeTabSwitcher from '../components/ModeTabSwitcher.vue';
import TranscriptionOptions from '../components/TranscriptionOptions.vue';

const router = useRouter();
const $q = useQuasar();
const recordingStore = useRecordingStore();
const historyStore = useRecordingsHistoryStore();
const transcriptionStore = useTranscriptionSettingsStore();

// State
const isDragOver = ref(false);
const isFileLoading = ref(false);
const isProcessing = ref(false);
const isUploading = ref(false);
const isUploaded = ref(false);
const isRetrying = ref(false);
const uploadError = ref(null);
const retryAttempt = ref(0);
const currentFilePath = ref('');
const currentFileSize = ref(0);
const currentFilename = ref('');
const currentDuration = ref(0);

const currentAudioFileId = computed(() => recordingStore.audioFileId);
const displayProgress = computed(() => recordingStore.uploadProgress);

const showUploadSection = computed(() => {
  return isProcessing.value || isUploading.value || uploadError.value || isUploaded.value;
});

const progressIcon = computed(() => {
  if (isProcessing.value) return 'hourglass_top';
  if (isUploading.value) return 'cloud_upload';
  if (uploadError.value) return 'cloud_off';
  if (isUploaded.value) return 'cloud_done';
  return 'cloud_upload';
});

const progressIconColor = computed(() => {
  if (uploadError.value) return 'negative';
  if (isUploaded.value) return 'positive';
  return 'primary';
});

const progressHeaderText = computed(() => {
  if (isProcessing.value) return 'Processing File';
  if (isUploading.value) return 'Uploading File';
  if (uploadError.value) return 'Upload Failed';
  if (isUploaded.value) return 'Upload Complete';
  return 'Upload';
});

// Drag and drop handlers
const onDragOver = () => {
  isDragOver.value = true;
};

const onDragLeave = () => {
  isDragOver.value = false;
};

const onDrop = async (event) => {
  isDragOver.value = false;

  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  const validExtensions = ['mp3', 'mp4', 'wav', 'm4a', 'webm', 'ogg', 'flac', 'aac', 'mov', 'm4v', 'mpeg', 'mpga', 'opus', 'oga', 'wma', 'amr', '3gp', 'avi', 'mkv'];
  const ext = file.name.split('.').pop()?.toLowerCase();

  if (!ext || !validExtensions.includes(ext)) {
    $q.notify({
      type: 'negative',
      message: 'Unsupported file format'
    });
    return;
  }

  await handleDroppedFile(file);
};

const handleDroppedFile = async (file) => {
  try {
    const filePath = file.path;
    if (!filePath) {
      $q.notify({
        type: 'negative',
        message: 'Could not get file path'
      });
      return;
    }

    const result = await window.electronAPI.dialog.getDroppedFilePath(filePath);

    if (!result.success) {
      $q.notify({
        type: 'negative',
        message: result.error || 'Could not process file'
      });
      return;
    }

    await startUpload(result.filePath, result.fileSize, result.filename, result.duration);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error.message || 'Error processing file'
    });
  }
};

const selectFileForUpload = async () => {
  try {
    const result = await window.electronAPI.dialog.openFile({
      filters: [
        {
          name: 'Audio/Video Files',
          extensions: ['mp3', 'mp4', 'wav', 'm4a', 'webm', 'ogg', 'flac', 'aac', 'mov', 'm4v', 'mpeg', 'mpga', 'opus', 'oga', 'wma', 'amr', '3gp', 'avi', 'mkv']
        }
      ]
    });

    if (!result.success || !result.filePath) {
      return; // User cancelled
    }

    await startUpload(result.filePath, result.fileSize, result.filename, result.duration);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error.message || 'Error selecting file'
    });
  }
};

const startUpload = async (filePath, fileSize, filename, duration) => {
  isFileLoading.value = true;
  isProcessing.value = true;
  uploadError.value = null;
  retryAttempt.value = 0;

  const recordId = `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  recordingStore.recordId = recordId;

  currentFilePath.value = filePath;
  currentFileSize.value = fileSize;
  currentFilename.value = filename;
  currentDuration.value = duration || 0;
  recordingStore.setFinalDuration(duration || 0);

  // Get transcription options
  const options = transcriptionStore.transcriptionOptions;

  isProcessing.value = false;
  isUploading.value = true;
  recordingStore.setUploading();

  try {
    const uploadResult = await window.electronAPI.upload.start({
      recordId: recordId,
      filePath: filePath,
      metadata: {
        duration: duration ? duration.toString() : '0',
        originalFilename: filename,
        title: options.title,
        customVocabulary: options.customVocabulary
      }
    });

    isUploading.value = false;
    isFileLoading.value = false;
    retryAttempt.value = 0;

    if (uploadResult.success) {
      isUploaded.value = true;
      recordingStore.setUploaded(uploadResult.audioFileId);

      await historyStore.addRecording({
        id: recordId,
        createdAt: new Date().toISOString(),
        duration: duration || 0,
        fileSize: fileSize,
        filePath: null,
        uploadStatus: 'uploaded',
        storagePreference: null,
        transcriptionId: uploadResult.transcriptionId,
        audioFileId: uploadResult.audioFileId
      });

      // Reset session after successful upload
      transcriptionStore.resetSession();

      $q.notify({
        type: 'positive',
        message: 'File uploaded successfully'
      });
    } else {
      uploadError.value = uploadResult.error;
      $q.notify({
        type: 'negative',
        message: uploadResult.error || 'Upload failed'
      });
    }
  } catch (error) {
    isUploading.value = false;
    isFileLoading.value = false;
    uploadError.value = error.message;
    $q.notify({
      type: 'negative',
      message: error.message || 'Error uploading file'
    });
  }
};

const retryUpload = async () => {
  if (!currentFilePath.value) return;

  isRetrying.value = true;
  uploadError.value = null;

  try {
    await startUpload(currentFilePath.value, currentFileSize.value, currentFilename.value, currentDuration.value);
  } finally {
    isRetrying.value = false;
  }
};

const handleReset = () => {
  recordingStore.reset();
  isProcessing.value = false;
  isUploading.value = false;
  isUploaded.value = false;
  uploadError.value = null;
  retryAttempt.value = 0;
  currentFilePath.value = '';
  currentFileSize.value = 0;
  currentFilename.value = '';
  currentDuration.value = 0;
};

const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let size = bytes;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
};

const generateTranscriptUrl = async () => {
  if (!currentAudioFileId.value) return '';

  let url = `https://app.suisse-notes.ch/meeting/audio/${currentAudioFileId.value}`;

  try {
    const result = await window.electronAPI.auth.createWebSession();
    if (result.success && result.sessionToken) {
      url += `?session=${encodeURIComponent(result.sessionToken)}`;
    }
  } catch (error) {
    console.warn('Could not create web session:', error);
  }

  return url;
};

const openInSuisseNotes = async () => {
  if (currentAudioFileId.value) {
    const url = await generateTranscriptUrl();
    window.electronAPI.shell.openExternal(url);
  }
};

const copyTranscriptUrl = async () => {
  if (currentAudioFileId.value) {
    const url = await generateTranscriptUrl();

    try {
      await navigator.clipboard.writeText(url);
      $q.notify({
        type: 'positive',
        message: 'Link copied to clipboard',
        timeout: 2000
      });
    } catch (error) {
      $q.notify({
        type: 'negative',
        message: 'Failed to copy link',
        timeout: 2000
      });
    }
  }
};

const goToHistory = () => {
  router.push('/history');
};

// Transcription options handlers
const updateTitle = (value) => {
  transcriptionStore.setSessionOptions({ title: value });
};

const addSessionWord = (word) => {
  transcriptionStore.addSessionWord(word);
};

const removeSessionWord = (word) => {
  transcriptionStore.removeSessionWord(word);
};

// Load settings on mount
onMounted(async () => {
  await transcriptionStore.loadGlobalSettings();

  if (!historyStore.loaded) {
    await historyStore.loadRecordings();
  }

  // Set up upload listeners
  window.electronAPI.upload.onProgress((data) => {
    if (data.recordId === recordingStore.recordId) {
      recordingStore.updateUploadProgress(data.progress, data.bytesUploaded, data.bytesTotal);
    }
  });

  window.electronAPI.upload.onRetry((data) => {
    if (data.recordId === recordingStore.recordId) {
      retryAttempt.value = data.attempt;
    }
  });
});

onUnmounted(() => {
  window.electronAPI.upload.removeAllListeners();
});
</script>

<style lang="scss" scoped>
.upload-page {
  padding: 40px 48px;
}

.upload-container {
  max-width: 600px;
  margin: 0 auto;
}

.idle-layout {
  display: flex;
  flex-direction: column;
}

.upload-card {
  padding: 48px 40px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  transition: all 0.2s ease;
  border: 2.5px dashed #94a3b8;
  border-radius: 16px;
  cursor: pointer;
  background: linear-gradient(135deg, rgba(241, 245, 249, 0.5) 0%, rgba(248, 250, 252, 0.8) 100%);

  &:hover {
    border-color: #64748b;
    background: linear-gradient(135deg, rgba(241, 245, 249, 0.8) 0%, rgba(248, 250, 252, 1) 100%);
  }

  &.drag-over {
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.12) 0%, rgba(139, 92, 246, 0.06) 100%);
    border: 3px dashed #6366F1;
    animation: border-pulse 0.8s ease-in-out infinite;
  }
}

@keyframes border-pulse {
  0%, 100% {
    border-color: #6366F1;
  }
  50% {
    border-color: #818cf8;
  }
}

.upload-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;

  h2 {
    font-size: 18px;
    font-weight: 600;
    margin: 20px 0 12px 0;
    color: #1e293b;
  }
}

.upload-icon-wrapper {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  background: #f1f5f9;
  border: 2px dashed #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;

  &.drag-active {
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(139, 92, 246, 0.1) 100%);
    border-color: #6366F1;
    transform: scale(1.1);
    animation: bounce-down 0.6s ease-in-out infinite;
  }
}

@keyframes bounce-down {
  0%, 100% {
    transform: scale(1.1) translateY(0);
  }
  50% {
    transform: scale(1.1) translateY(4px);
  }
}

.upload-desc {
  font-size: 13px;
  color: #64748b;
  margin: 0 0 20px 0;
  max-width: 320px;
  line-height: 1.5;
}

.upload-btn {
  margin-bottom: 16px;
  height: 40px;
  padding: 0 28px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 8px;
}

.drag-drop-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 12px;
  padding: 6px 14px;
  background: rgba(148, 163, 184, 0.1);
  border-radius: 12px;
}

.supported-formats {
  font-size: 11px;
  color: #94a3b8;
  text-align: center;
}

.upload-progress-card {
  padding: 36px 40px;
  margin-top: 24px;
  border-radius: 16px;
}

.progress-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 20px;
  color: #1e293b;
}

.progress-content {
  .processing-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 24px;
    color: #64748b;
    font-size: 13px;
  }

  .upload-progress-section {
    margin-bottom: 16px;

    .progress-info {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;

      .progress-text {
        color: #64748b;
        font-size: 12px;
      }

      .progress-percent {
        font-weight: 600;
        font-size: 12px;
        color: #6366F1;
      }
    }

    .progress-meta {
      margin-top: 8px;
      font-size: 11px;
      color: #94a3b8;
    }
  }

  .error-state {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    background: rgba(239, 68, 68, 0.1);
    border-radius: 6px;
    margin-bottom: 16px;

    .error-info {
      display: flex;
      flex-direction: column;

      .error-title {
        font-weight: 600;
        font-size: 14px;
        color: #ef4444;
      }

      .error-message {
        font-size: 12px;
        color: #64748b;
        margin-top: 3px;
      }
    }
  }

  .error-actions {
    display: flex;
    gap: 10px;
  }
}

.gradient-btn {
  background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%) !important;
  color: white !important;
}

.upload-success {
  .transcript-cta {
    text-align: center;
    padding: 48px 40px;
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.08) 0%, rgba(34, 197, 94, 0.04) 100%);
    border: 2px solid rgba(34, 197, 94, 0.2);
    border-radius: 16px;
    margin-bottom: 32px;

    .cta-icon {
      margin-bottom: 16px;

      :deep(.q-icon) {
        font-size: 48px;
      }
    }

    .cta-title {
      font-size: 15px;
      font-weight: 700;
      color: #16a34a;
      margin: 0 0 8px 0;
    }

    .cta-subtitle {
      font-size: 11px;
      color: #64748b;
      margin: 0 0 20px 0;
      max-width: 340px;
      margin-left: auto;
      margin-right: auto;
      line-height: 1.5;
    }

    .cta-button-wrapper {
      margin-top: 20px;
    }

    .main-cta-button {
      background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%) !important;
      color: white !important;
      border-radius: 10px;
      padding: 12px 24px;
      min-height: 48px;
      font-size: 12px;
      font-weight: 600;
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4);
      transition: all 0.3s ease;

      &:hover {
        transform: translateY(-2px);
        box-shadow: 0 10px 28px rgba(99, 102, 241, 0.5);
      }

      .button-content {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .button-text {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        text-align: left;

        .button-label {
          font-size: 12px;
          font-weight: 600;
        }

        .button-hint {
          font-size: 10px;
          opacity: 0.9;
          font-weight: 400;
          margin-top: 2px;
        }
      }

      .arrow-icon {
        animation: bounce-right 1s ease-in-out infinite;
      }
    }

    .pulse-attention {
      animation: pulse-glow 2s ease-in-out infinite;
    }

    @keyframes pulse-glow {
      0%, 100% {
        box-shadow: 0 8px 24px rgba(99, 102, 241, 0.4);
      }
      50% {
        box-shadow: 0 8px 40px rgba(99, 102, 241, 0.6), 0 0 0 8px rgba(99, 102, 241, 0.1);
      }
    }

    @keyframes bounce-right {
      0%, 100% {
        transform: translateX(0);
      }
      50% {
        transform: translateX(6px);
      }
    }

    .copy-link-section {
      margin-top: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;

      .copy-link-btn {
        font-size: 12px;
      }

      .copy-hint {
        font-size: 10px;
        color: #94a3b8;
      }
    }
  }

  .url-display-section {
    margin-bottom: 24px;
    padding: 16px 20px;
    background: #f8fafc;
    border-radius: 10px;
    border: 1px solid #e2e8f0;

    .url-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: #64748b;
      margin-bottom: 8px;
    }

    .url-value {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: space-between;

      code {
        flex: 1;
        font-size: 11px;
        color: #6366F1;
        background: white;
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid #e2e8f0;
        word-break: break-all;
        font-family: 'JetBrains Mono', monospace;
      }
    }
  }

  .success-secondary {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;

    .success-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: rgba(34, 197, 94, 0.1);
      border-radius: 16px;
      font-size: 13px;
      color: #16a34a;
      font-weight: 500;
    }
  }

  .success-actions {
    display: flex;
    justify-content: center;
    gap: 12px;

    .secondary-action-btn {
      height: 36px;
      font-size: 13px;
    }
  }
}
</style>
