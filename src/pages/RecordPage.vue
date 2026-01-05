<template>
  <q-page class="record-page">
    <div class="record-container">
      <!-- IDLE STATE: Two-column layout -->
      <div class="idle-layout" v-if="recordingStore.status === 'idle' && !recordingStore.isUploaded">
        <!-- Left Column: Upload File -->
        <div
          class="upload-column modern-card no-hover"
          :class="{ 'drag-over': isDragOver }"
          @dragover.prevent="onDragOver"
          @dragleave.prevent="onDragLeave"
          @drop.prevent="onDrop"
        >
          <div class="upload-content">
            <div class="upload-icon-wrapper" :class="{ 'drag-active': isDragOver }">
              <q-icon :name="isDragOver ? 'file_download' : 'cloud_upload'" :size="isDragOver ? '40px' : '36px'" :color="isDragOver ? 'primary' : 'grey-6'" />
            </div>
            <h3>{{ isDragOver ? $t('dropHere') : $t('uploadFile') }}</h3>
            <p class="column-desc">{{ $t('uploadDesc') }}</p>
            <q-btn
              unelevated
              color="secondary"
              :label="$t('selectFile')"
              icon="folder_open"
              @click="selectFileForUpload"
              :loading="isFileUploading"
              class="upload-btn"
            />
            <div class="drag-drop-hint">
              <q-icon name="mouse" size="12px" />
              <span>{{ $t('dragDropHint') }}</span>
            </div>
            <div class="supported-formats">
              MP3, MP4, WAV, M4A, WEBM, OGG, FLAC
            </div>
          </div>
        </div>

        <!-- Divider -->
        <div class="columns-divider">
          <span>or</span>
        </div>

        <!-- Right Column: Start Recording -->
        <div class="record-column modern-card no-hover">
          <div class="column-header">
            <q-icon name="mic" size="sm" color="primary" />
            <h3>{{ $t('recordNew') }}</h3>
          </div>

          <!-- Recording Button -->
          <div class="record-button-section">
            <RecordingControls
              :audio-level="audioLevel"
              @start="handleStartClick"
              @pause="handlePause"
              @resume="handleResume"
              @stop="handleStop"
            />
          </div>

          <!-- Microphone Selection -->
          <div class="mic-section">
            <div class="section-label">
              <q-icon name="settings_voice" size="xs" color="grey-6" />
              <span>{{ $t('microphone') }}</span>
            </div>
            <q-select
              v-model="selectedMicrophoneId"
              :options="availableMicrophones"
              option-value="id"
              option-label="label"
              emit-value
              map-options
              outlined
              dense
              :loading="loadingMicrophones"
              class="mic-select"
              popup-content-class="mic-dropdown"
            >
              <template #selected-item="scope">
                <span class="mic-selected-text">{{ scope.opt?.label || 'Select microphone' }}</span>
              </template>
              <template #append>
                <q-btn
                  flat
                  round
                  dense
                  icon="refresh"
                  size="sm"
                  color="grey-6"
                  @click.stop="loadMicrophones"
                  :loading="loadingMicrophones"
                >
                  <q-tooltip>Refresh microphones</q-tooltip>
                </q-btn>
              </template>
            </q-select>
          </div>

          <!-- System Audio Toggle -->
          <div class="system-audio-section">
            <div class="system-audio-row">
              <div class="system-audio-info">
                <q-icon name="volume_up" size="xs" color="grey-6" />
                <div class="system-audio-text">
                  <span class="label">{{ $t('systemAudio') }}</span>
                  <span class="description">{{ $t('systemAudioDesc') }}</span>
                </div>
              </div>
              <q-toggle
                v-model="systemAudioEnabled"
                color="primary"
                size="sm"
                @update:model-value="toggleSystemAudio"
              />
            </div>
            <div v-if="systemAudioEnabled" class="system-audio-active">
              <q-icon name="check_circle" size="xs" color="positive" />
              <span>{{ $t('systemAudioEnabled') }}</span>
            </div>
            <div v-if="showMacPermissionNotice" class="permission-notice">
              <q-icon name="warning" size="xs" color="warning" />
              <span>{{ $t('macPermissionNotice') }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- RECORDING/PAUSED STATE: Full-width recording card -->
      <div class="recording-card modern-card no-hover" v-if="(recordingStore.isRecording || recordingStore.isPaused) && !recordingStore.isUploaded">
        <!-- Header -->
        <div class="card-header text-center">
          <h2>Meeting Recorder</h2>
          <p class="status-text" :class="statusClass">{{ statusText }}</p>
        </div>

        <!-- Timer Display -->
        <div class="timer-section">
          <div :class="['timer-display', { 'recording': recordingStore.isRecording, 'paused': recordingStore.isPaused }]">
            {{ recordingStore.formattedDuration }}
          </div>
        </div>

        <!-- Audio Level Meter -->
        <div class="level-section">
          <AudioLevelMeter :level="audioLevel" />
        </div>

        <!-- Recording Controls -->
        <div class="controls-section">
          <RecordingControls
            :audio-level="audioLevel"
            @start="handleStartClick"
            @pause="handlePause"
            @resume="handleResume"
            @stop="handleStop"
          />
        </div>

        <!-- Error Display -->
        <div class="error-section" v-if="recordingStore.error && !isAutoUploading">
          <q-banner class="error-banner" rounded>
            <template #avatar>
              <q-icon name="error_outline" color="negative" />
            </template>
            {{ recordingStore.error }}
            <template #action>
              <q-btn flat color="negative" label="Dismiss" @click="recordingStore.error = null" />
            </template>
          </q-banner>
        </div>
      </div>

      <!-- Auto-Upload Progress Section -->
      <div class="upload-card modern-card no-hover" v-if="showUploadSection">
        <!-- Only show header during processing/uploading/error, not when complete -->
        <div class="upload-header" v-if="!recordingStore.isUploaded">
          <q-icon :name="uploadIcon" size="sm" :color="uploadIconColor" />
          <span>{{ uploadHeaderText }}</span>
        </div>

        <!-- Processing state -->
        <div class="upload-content" v-if="isProcessing">
          <div class="processing-state">
            <q-spinner-dots color="primary" size="40px" />
            <span>Processing recording...</span>
          </div>
        </div>

        <!-- Uploading state -->
        <div class="upload-content" v-else-if="isAutoUploading">
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
            <div class="progress-meta" v-if="displayProgress < 100">
              <span>{{ formatBytes(recordingStore.bytesUploaded) }} / {{ formatBytes(recordingStore.bytesTotal) }}</span>
            </div>
            <div class="progress-meta" v-else>
              <span>Upload complete, waiting for server response...</span>
            </div>
          </div>
          <div class="upload-note">
            <q-icon name="info" size="xs" color="grey-6" />
            <span>Upload continues in background - you can start a new recording</span>
          </div>
          <div class="upload-actions">
            <q-btn
              outline
              color="primary"
              label="New Recording"
              icon="mic"
              size="sm"
              @click="startNewWhileUploading"
            />
          </div>
        </div>

        <!-- Upload Error state -->
        <div class="upload-content" v-else-if="uploadError">
          <div class="error-state">
            <q-icon name="cloud_off" size="lg" color="negative" />
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
              @click="retryUpload"
              :loading="isRetrying"
            />
            <q-btn
              flat
              color="grey-7"
              label="View History"
              icon="history"
              @click="goToHistory"
            />
          </div>

          <div class="error-note">
            <q-icon name="save" size="xs" color="grey-6" />
            <span>Your recording is saved locally and can be uploaded later from History</span>
          </div>
        </div>

        <!-- Upload Complete state -->
        <div class="upload-success" v-else-if="recordingStore.isUploaded">
          <!-- Main CTA: View Transcript (the primary focus) -->
          <div class="transcript-cta" v-if="currentAudioFileId">
            <div class="cta-icon">
              <q-icon name="check_circle" size="80px" color="positive" />
            </div>
            <h3 class="cta-title">{{ $t('transcriptReady') }}</h3>
            <p class="cta-subtitle">{{ $t('transcriptCta') }}</p>

            <!-- Prominent clickable button with animation -->
            <div class="cta-button-wrapper">
              <q-btn
                unelevated
                class="main-cta-button pulse-attention"
                @click="openInSuisseNotes"
              >
                <div class="button-content">
                  <q-icon name="open_in_new" size="28px" class="q-mr-md" />
                  <div class="button-text">
                    <span class="button-label">{{ $t('openInSuisseNotes') }}</span>
                    <span class="button-hint">{{ $t('clickHereToView') }}</span>
                  </div>
                  <q-icon name="arrow_forward" size="24px" class="q-ml-md arrow-icon" />
                </div>
              </q-btn>
            </div>
          </div>

          <!-- Secondary info -->
          <div class="success-secondary">
            <div class="success-badge">
              <q-icon name="check_circle" size="sm" color="positive" />
              <span>{{ $t('uploadComplete') }}</span>
            </div>
            <div class="success-meta">
              <q-icon name="schedule" size="sm" color="grey-6" />
              <span>{{ formattedFinalDuration }}</span>
            </div>
          </div>

          <div class="success-actions">
            <q-btn
              outline
              color="primary"
              :label="$t('newRecording')"
              icon="mic"
              @click="handleNewRecording"
              class="secondary-action-btn"
            />
            <q-btn
              flat
              color="grey-7"
              :label="$t('viewHistory')"
              icon="history"
              @click="goToHistory"
              class="secondary-action-btn"
            />
          </div>
        </div>
      </div>

      <!-- Tips Section (only when idle) -->
      <div class="tips-card modern-card no-hover" v-if="recordingStore.status === 'idle'">
        <div class="tips-header">
          <q-icon name="tips_and_updates" size="sm" color="primary" />
          <span>Tips for better recordings</span>
        </div>
        <ul class="tips-list">
          <li>Use a proper external microphone for best audio quality and speaker differentiation</li>
          <li>Position the microphone close to the speakers</li>
          <li>Recording will be automatically uploaded when you stop</li>
        </ul>
        <div class="tips-contact">
          <q-icon name="headset_mic" size="xs" color="grey-6" />
          <span>Need help choosing a microphone? Contact us at <a href="mailto:info@suisse-voice.ch">info@suisse-voice.ch</a></span>
        </div>
      </div>
    </div>

    <!-- Storage Option Dialog -->
    <StorageOptionDialog
      v-model="showStorageDialog"
      @confirm="onStorageOptionConfirm"
      @cancel="onStorageOptionCancel"
    />
  </q-page>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { useRecordingStore } from '../stores/recording';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import { useRecorder } from '../composables/useRecorder';
import RecordingControls from '../components/RecordingControls.vue';
import AudioLevelMeter from '../components/AudioLevelMeter.vue';
import StorageOptionDialog from '../components/StorageOptionDialog.vue';

const router = useRouter();
const $q = useQuasar();
const recordingStore = useRecordingStore();
const historyStore = useRecordingsHistoryStore();

const {
  audioLevel,
  availableMicrophones,
  selectedMicrophoneId,
  loadingMicrophones,
  systemAudioEnabled,
  systemAudioPermissionStatus,
  setSystemAudioEnabled,
  loadMicrophones,
  loadSystemAudioState,
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording
} = useRecorder();

// System audio toggle functionality
const toggleSystemAudio = async (enabled) => {
  await setSystemAudioEnabled(enabled);
};

const isMac = computed(() => {
  return navigator.platform.toLowerCase().includes('mac');
});

const showMacPermissionNotice = computed(() => {
  return isMac.value && systemAudioPermissionStatus.value !== 'granted' && systemAudioEnabled.value;
});

const showStorageDialog = ref(false);
const currentStoragePreference = ref('keep');
const isProcessing = ref(false);
const isAutoUploading = ref(false);
const isRetrying = ref(false);
const uploadError = ref(null);
const retryAttempt = ref(0);
const currentFilePath = ref('');
const currentFileSize = ref(0);
const currentAudioFileId = ref(null);
const isFileUploading = ref(false);
const finalDuration = ref(0);  // Store duration before it gets reset

// Drag and drop state
const isDragOver = ref(false);

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

  // Use the file path from the dropped file
  await handleDroppedFile(file);
};

const statusText = computed(() => {
  if (isProcessing.value) return 'Processing...';
  if (isAutoUploading.value) return retryAttempt.value > 0 ? `Retrying upload (${retryAttempt.value})...` : 'Uploading...';
  if (uploadError.value) return 'Upload failed';

  switch (recordingStore.status) {
    case 'idle': return 'Ready to record';
    case 'recording': return 'Recording in progress';
    case 'paused': return 'Recording paused';
    case 'stopped': return 'Recording stopped';
    case 'uploading': return 'Uploading...';
    case 'uploaded': return 'Upload complete';
    case 'error': return 'Error occurred';
    default: return '';
  }
});

const statusClass = computed(() => {
  if (isAutoUploading.value) return 'text-primary';
  if (uploadError.value) return 'text-negative';
  if (recordingStore.isRecording) return 'text-negative';
  if (recordingStore.isPaused) return 'text-warning';
  if (recordingStore.isUploaded) return 'text-positive';
  return '';
});

const showUploadSection = computed(() => {
  return isProcessing.value ||
         isAutoUploading.value ||
         uploadError.value ||
         recordingStore.isUploaded;
});

const uploadIcon = computed(() => {
  if (isProcessing.value) return 'hourglass_top';
  if (isAutoUploading.value) return 'cloud_upload';
  if (uploadError.value) return 'cloud_off';
  if (recordingStore.isUploaded) return 'cloud_done';
  return 'cloud_upload';
});

const uploadIconColor = computed(() => {
  if (uploadError.value) return 'negative';
  if (recordingStore.isUploaded) return 'positive';
  return 'primary';
});

const uploadHeaderText = computed(() => {
  if (isProcessing.value) return 'Processing Recording';
  if (isAutoUploading.value) return 'Uploading Recording';
  if (uploadError.value) return 'Upload Failed';
  if (recordingStore.isUploaded) return 'Upload Complete';
  return 'Upload';
});

// Show actual upload progress
const displayProgress = computed(() => {
  return recordingStore.uploadProgress;
});

// Format final duration for display
const formattedFinalDuration = computed(() => {
  const seconds = finalDuration.value;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
});

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

// Load history store and set up listeners on mount
onMounted(async () => {
  // Load available microphones and system audio state
  await loadMicrophones();
  await loadSystemAudioState();

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

const handleStartClick = async () => {
  // Reset error state
  uploadError.value = null;
  retryAttempt.value = 0;

  // Check if we should show storage dialog
  const savedPreference = historyStore.defaultStoragePreference;

  if (savedPreference) {
    currentStoragePreference.value = savedPreference;
    await doStartRecording();
  } else {
    showStorageDialog.value = true;
  }
};

const onStorageOptionConfirm = async ({ storagePreference }) => {
  currentStoragePreference.value = storagePreference;
  await doStartRecording();
};

const onStorageOptionCancel = () => {
  // Do nothing
};

const doStartRecording = async () => {
  const result = await startRecording();
  if (!result.success) {
    $q.notify({
      type: 'negative',
      message: result.error || 'Failed to start recording'
    });
  }
};

const handlePause = () => {
  pauseRecording();
};

const handleResume = () => {
  resumeRecording();
};

const handleStop = async () => {
  // Save duration before stopping (it might get affected during stop process)
  finalDuration.value = recordingStore.duration;

  // Start processing
  isProcessing.value = true;
  uploadError.value = null;
  retryAttempt.value = 0;

  try {
    const result = await stopRecording();

    if (result.success) {
      // Get file info
      const fileInfo = await window.electronAPI.recording.getFilePath(recordingStore.recordId, '.webm');
      if (fileInfo.success) {
        currentFilePath.value = fileInfo.filePath;
        currentFileSize.value = fileInfo.fileSize;
      }

      // Processing done, start auto-upload
      isProcessing.value = false;
      await startAutoUpload();
    } else {
      isProcessing.value = false;
      $q.notify({
        type: 'negative',
        message: result.error || 'Failed to save recording'
      });
    }
  } catch (error) {
    isProcessing.value = false;
    $q.notify({
      type: 'negative',
      message: error.message || 'Error processing recording'
    });
  }
};

const startAutoUpload = async () => {
  isAutoUploading.value = true;
  recordingStore.setUploading({
    createdAt: new Date().toISOString(),
    fileSize: currentFileSize.value,
    finalDuration: finalDuration.value
  });

  try {
    const result = await window.electronAPI.upload.start({
      recordId: recordingStore.recordId,
      filePath: currentFilePath.value,
      metadata: {
        duration: finalDuration.value.toString()
      }
    });

    isAutoUploading.value = false;
    retryAttempt.value = 0;

    if (result.success) {
      recordingStore.setUploaded();
      currentAudioFileId.value = result.audioFileId;

      // Add to history
      await historyStore.addRecording({
        id: recordingStore.recordId,
        createdAt: new Date().toISOString(),
        duration: finalDuration.value,
        fileSize: currentFileSize.value,
        filePath: currentFilePath.value,
        uploadStatus: 'uploaded',
        storagePreference: currentStoragePreference.value,
        transcriptionId: result.transcriptionId,
        audioFileId: result.audioFileId
      });

      // ONLY delete file after SUCCESSFUL upload if user chose "delete after upload"
      if (currentStoragePreference.value === 'delete_after_upload') {
        await window.electronAPI.recording.deleteRecording(recordingStore.recordId);
        await historyStore.updateRecording(recordingStore.recordId, { filePath: null });
      }

      $q.notify({
        type: 'positive',
        message: 'Recording uploaded successfully'
      });
    } else {
      handleUploadError(result.error);
    }
  } catch (error) {
    isAutoUploading.value = false;
    handleUploadError(error.message);
  }
};

const handleUploadError = async (errorMessage) => {
  uploadError.value = errorMessage;

  // Save to history as failed - KEEP the file regardless of preference
  await historyStore.addRecording({
    id: recordingStore.recordId,
    createdAt: new Date().toISOString(),
    duration: finalDuration.value,
    fileSize: currentFileSize.value,
    filePath: currentFilePath.value, // Always keep file path for retry
    uploadStatus: 'failed',
    storagePreference: currentStoragePreference.value,
    uploadError: errorMessage
  });

  $q.notify({
    type: 'negative',
    message: 'Upload failed. Your recording is saved locally.',
    timeout: 5000
  });
};

const retryUpload = async () => {
  isRetrying.value = true;
  uploadError.value = null;
  retryAttempt.value = 0;

  try {
    // Remove from history (will re-add based on result)
    await historyStore.deleteRecording(recordingStore.recordId, false);

    isRetrying.value = false;
    await startAutoUpload();
  } catch (error) {
    isRetrying.value = false;
    uploadError.value = error.message;
  }
};

const handleNewRecording = () => {
  recordingStore.reset();
  isProcessing.value = false;
  isAutoUploading.value = false;
  uploadError.value = null;
  retryAttempt.value = 0;
  currentFilePath.value = '';
  currentFileSize.value = 0;
  currentAudioFileId.value = null;
  finalDuration.value = 0;
};

// Start new recording while upload continues in background
const startNewWhileUploading = () => {
  // Move current upload to background tracking
  recordingStore.moveToBackgroundUpload();

  // Reset local UI state
  isProcessing.value = false;
  isAutoUploading.value = false;
  uploadError.value = null;
  retryAttempt.value = 0;
  currentFilePath.value = '';
  currentFileSize.value = 0;
  currentAudioFileId.value = null;
  finalDuration.value = 0;

  // Reset store for new recording (background upload continues)
  recordingStore.recordId = null;
  recordingStore.status = 'idle';
  recordingStore.duration = 0;
  recordingStore.chunkIndex = 0;
  recordingStore.audioFilePath = null;
  recordingStore.uploadProgress = 0;
  recordingStore.bytesUploaded = 0;
  recordingStore.bytesTotal = 0;
  recordingStore.error = null;
};

const openInSuisseNotes = async () => {
  if (currentAudioFileId.value) {
    let url = `https://app.suisse-notes.ch/meeting/audio/${currentAudioFileId.value}`;

    // Try to get a web session token for seamless login
    try {
      const result = await window.electronAPI.auth.createWebSession();
      if (result.success && result.sessionToken) {
        url += `?session=${encodeURIComponent(result.sessionToken)}`;
        console.log('Web session created successfully');
      } else {
        console.warn('Failed to create web session:', result.error);
        $q.notify({
          type: 'warning',
          message: 'Could not create session. You may need to log in on the web.',
          timeout: 3000
        });
      }
    } catch (error) {
      console.warn('Could not create web session:', error);
      $q.notify({
        type: 'warning',
        message: 'Session error. You may need to log in on the web.',
        timeout: 3000
      });
    }

    window.electronAPI.shell.openExternal(url);
  }
};

const goToHistory = () => {
  router.push('/history');
};

// Handle dropped file
const handleDroppedFile = async (file) => {
  try {
    // In Electron, dropped files have a path property
    const filePath = file.path;
    if (!filePath) {
      $q.notify({
        type: 'negative',
        message: 'Could not get file path'
      });
      return;
    }

    // Get file info from main process
    const result = await window.electronAPI.dialog.getDroppedFilePath(filePath);

    if (!result.success) {
      $q.notify({
        type: 'negative',
        message: result.error || 'Could not process file'
      });
      return;
    }

    // Start upload process (same as selectFileForUpload)
    isFileUploading.value = true;
    isProcessing.value = true;
    uploadError.value = null;
    retryAttempt.value = 0;

    const recordId = `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    recordingStore.recordId = recordId;

    currentFilePath.value = result.filePath;
    currentFileSize.value = result.fileSize;
    finalDuration.value = result.duration || 0;

    isProcessing.value = false;
    isAutoUploading.value = true;
    recordingStore.setUploading();

    const uploadResult = await window.electronAPI.upload.start({
      recordId: recordId,
      filePath: result.filePath,
      metadata: {
        duration: result.duration ? result.duration.toString() : '0',
        originalFilename: result.filename
      }
    });

    isAutoUploading.value = false;
    isFileUploading.value = false;
    retryAttempt.value = 0;

    if (uploadResult.success) {
      recordingStore.setUploaded();
      currentAudioFileId.value = uploadResult.audioFileId;

      await historyStore.addRecording({
        id: recordId,
        createdAt: new Date().toISOString(),
        duration: result.duration || 0,
        fileSize: result.fileSize,
        filePath: null,
        uploadStatus: 'uploaded',
        storagePreference: null,
        transcriptionId: uploadResult.transcriptionId,
        audioFileId: uploadResult.audioFileId
      });

      $q.notify({
        type: 'positive',
        message: 'File uploaded successfully'
      });
    } else {
      isFileUploading.value = false;
      uploadError.value = uploadResult.error;

      $q.notify({
        type: 'negative',
        message: uploadResult.error || 'Upload failed'
      });
    }
  } catch (error) {
    isProcessing.value = false;
    isAutoUploading.value = false;
    isFileUploading.value = false;
    uploadError.value = error.message;

    $q.notify({
      type: 'negative',
      message: error.message || 'Error uploading file'
    });
  }
};

const selectFileForUpload = async () => {
  try {
    // Open file dialog
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

    isFileUploading.value = true;
    isProcessing.value = true;
    uploadError.value = null;
    retryAttempt.value = 0;

    // Generate a record ID for this upload
    const recordId = `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    recordingStore.recordId = recordId;

    currentFilePath.value = result.filePath;
    currentFileSize.value = result.fileSize;
    finalDuration.value = result.duration || 0;

    // Processing done, start upload
    isProcessing.value = false;
    isAutoUploading.value = true;
    recordingStore.setUploading();

    const uploadResult = await window.electronAPI.upload.start({
      recordId: recordId,
      filePath: result.filePath,
      metadata: {
        duration: result.duration ? result.duration.toString() : '0',
        originalFilename: result.filename
      }
    });

    isAutoUploading.value = false;
    isFileUploading.value = false;
    retryAttempt.value = 0;

    if (uploadResult.success) {
      recordingStore.setUploaded();
      currentAudioFileId.value = uploadResult.audioFileId;

      // Add to history (file uploads don't get stored locally, so no filePath)
      await historyStore.addRecording({
        id: recordId,
        createdAt: new Date().toISOString(),
        duration: result.duration || 0,
        fileSize: result.fileSize,
        filePath: null, // Not stored locally
        uploadStatus: 'uploaded',
        storagePreference: null, // N/A for file uploads - no local file to manage
        transcriptionId: uploadResult.transcriptionId,
        audioFileId: uploadResult.audioFileId
      });

      $q.notify({
        type: 'positive',
        message: 'File uploaded successfully'
      });
    } else {
      isFileUploading.value = false;
      uploadError.value = uploadResult.error;

      $q.notify({
        type: 'negative',
        message: uploadResult.error || 'Upload failed'
      });
    }
  } catch (error) {
    isProcessing.value = false;
    isAutoUploading.value = false;
    isFileUploading.value = false;
    uploadError.value = error.message;

    $q.notify({
      type: 'negative',
      message: error.message || 'Error uploading file'
    });
  }
};
</script>

<style lang="scss" scoped>
.record-page {
  padding: 40px 48px;
}

.record-container {
  max-width: 100%;
  margin: 0 auto;
}

// Two-column idle layout
.idle-layout {
  display: flex;
  gap: 24px;
  align-items: flex-start;
  margin-bottom: 36px;

  // Responsive: stack vertically on small screens
  @media (max-width: 900px) {
    flex-direction: column;
    gap: 20px;
  }
}

.upload-column {
  flex: 1;
  padding: 40px 36px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  min-height: 300px;
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

  @media (max-width: 900px) {
    min-height: 240px;
    padding: 32px 28px;
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

.record-column {
  flex: 1;
  padding: 40px 36px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 300px;

  @media (max-width: 900px) {
    min-height: auto;
    padding: 32px 28px;
  }
}

.upload-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;

  h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 16px 0 10px 0;
    color: #1e293b;

    @media (max-width: 900px) {
      font-size: 13px;
      margin: 12px 0 8px 0;
    }
  }
}

.upload-icon-wrapper {
  width: 72px;
  height: 72px;
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

  @media (max-width: 900px) {
    width: 64px;
    height: 64px;
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

.upload-btn {
  margin-top: 16px;
  margin-bottom: 12px;
  height: 34px;
  padding: 0 20px;
  font-size: 12px;
}

.drag-drop-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 10px;
  color: #94a3b8;
  margin-bottom: 14px;
  padding: 6px 12px;
  background: rgba(148, 163, 184, 0.1);
  border-radius: 12px;
}

.column-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 28px;

  h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
    color: #1e293b;

    @media (max-width: 900px) {
      font-size: 13px;
    }
  }
}

.column-desc {
  font-size: 11px;
  color: #64748b;
  margin: 0 0 16px 0;
  line-height: 1.5;

  @media (max-width: 900px) {
    font-size: 11px;
    margin: 0 0 14px 0;
  }
}

.supported-formats {
  font-size: 10px;
  color: #94a3b8;
  text-align: center;
}

.columns-divider {
  display: flex;
  align-items: center;
  padding: 0 8px;
  color: #94a3b8;
  font-size: 14px;
  font-weight: 500;
}

.record-button-section {
  text-align: center;
  margin-bottom: 32px;
}

.mic-section {
  margin-bottom: 20px;

  .section-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: #64748b;
    margin-bottom: 10px;
  }
}

.mic-selected-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
  display: inline-block;
  font-size: 12px;
}

.system-audio-section {
  min-height: 70px; // Reserve space to prevent layout shift
  padding: 16px 18px;
  background: #f8fafc;
  border-radius: 10px;

  .system-audio-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .system-audio-info {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .system-audio-text {
    display: flex;
    flex-direction: column;

    .label {
      font-size: 13px;
      font-weight: 500;
      color: #1e293b;
    }

    .description {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 2px;
    }
  }

  .system-audio-active {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 10px;
    padding: 6px 10px;
    background: rgba(34, 197, 94, 0.1);
    border-radius: 5px;
    font-size: 11px;
    color: #16a34a;
  }

  .permission-notice {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 10px;
    padding: 6px 10px;
    background: rgba(245, 158, 11, 0.1);
    border-radius: 5px;
    font-size: 11px;
    color: #d97706;
  }
}

.recording-card {
  padding: 40px;
  margin-bottom: 32px;
  border-radius: 16px;
}

.card-header {
  margin-bottom: 24px;

  h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 6px 0;
    color: #1e293b;
  }

  .status-text {
    font-size: 11px;
    color: #64748b;
    margin: 0;

    &.text-primary { color: #6366F1; }
    &.text-negative { color: #ef4444; }
    &.text-warning { color: #f59e0b; }
    &.text-positive { color: #22c55e; }
  }
}

.timer-section {
  text-align: center;
  margin-bottom: 24px;
}

.level-section {
  margin-bottom: 24px;
  padding: 0 24px;
}

.controls-section {
  text-align: center;
}

.error-section {
  margin-top: 24px;

  .error-banner {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
  }
}

.upload-card {
  padding: 36px 40px;
  margin-bottom: 32px;
  border-radius: 16px;
}

.upload-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 20px;
  color: #1e293b;
}

.upload-content {
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

  .upload-note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: #f8fafc;
    border-radius: 6px;
    font-size: 11px;
    color: #64748b;
  }

  .upload-actions {
    margin-top: 16px;
    text-align: center;
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
    margin-bottom: 16px;
  }

  .error-note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: #f8fafc;
    border-radius: 6px;
    font-size: 11px;
    color: #64748b;
  }
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

    .success-meta {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: #f1f5f9;
      border-radius: 16px;
      font-size: 13px;
      color: #64748b;
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

.mic-select {
  :deep(.q-field__control) {
    border-radius: 6px;
    min-height: 36px;
  }

  :deep(.q-field--outlined.q-field--focused .q-field__control:before) {
    border-color: #6366F1;
  }

  :deep(.q-field--dense .q-field__control) {
    height: 36px;
  }

  :deep(.q-field__native) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
}

// Global style for mic dropdown (not scoped)
:global(.mic-dropdown) {
  .q-item__label {
    white-space: normal;
    word-break: break-word;
    font-size: 12px;
  }
}

.tips-card {
  padding: 28px 32px;
  margin-bottom: 0;
  background: #f8fafc;
  border: none;
  border-radius: 16px;
}

.tips-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 14px;
  color: #1e293b;
}

.tips-list {
  margin: 0;
  padding-left: 20px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.7;

  li {
    margin-bottom: 4px;
  }
}

.tips-contact {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 18px;
  padding: 12px 16px;
  background: white;
  border-radius: 6px;
  font-size: 11px;
  color: #64748b;
  line-height: 1.5;

  a {
    color: #6366F1;
    text-decoration: none;
    font-weight: 500;

    &:hover {
      text-decoration: underline;
    }
  }
}

</style>
