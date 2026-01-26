<template>
  <q-page class="record-page">
    <div class="record-container">
      <!-- Mode Tab Switcher (hidden when recording/paused/processing/uploading) -->
      <ModeTabSwitcher :hidden="isRecordingActive" />

      <!-- IDLE STATE: Recording form -->
      <div
        v-if="recordingStore.status === 'idle' && !isUploadedFromRecording"
        class="idle-layout"
      >
        <!-- Record Card -->
        <div class="record-card modern-card no-hover">
          <div class="column-header">
            <q-icon
              name="mic"
              size="sm"
              color="primary"
            />
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
              <q-icon
                name="settings_voice"
                size="xs"
                color="grey-6"
              />
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
                  :loading="loadingMicrophones"
                  @click.stop="loadMicrophones"
                >
                  <q-tooltip>Refresh microphones</q-tooltip>
                </q-btn>
              </template>
            </q-select>
          </div>

          <!-- System Audio Toggle - Desktop Only -->
          <div
            v-if="isElectron()"
            class="system-audio-section"
          >
            <div class="system-audio-row">
              <div class="system-audio-info">
                <q-icon
                  name="volume_up"
                  size="xs"
                  color="grey-6"
                />
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
            <div
              v-if="systemAudioEnabled"
              class="system-audio-active"
            >
              <q-icon
                name="check_circle"
                size="xs"
                color="positive"
              />
              <span>{{ $t('systemAudioEnabled') }}</span>
            </div>
            <div
              v-if="showMacPermissionNotice"
              class="permission-notice"
            >
              <q-icon
                name="warning"
                size="xs"
                color="warning"
              />
              <span>{{ $t('macPermissionNotice') }}</span>
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

      <!-- RECORDING/PAUSED STATE: Full-width recording card -->
      <div
        v-if="(recordingStore.isRecording || recordingStore.isPaused) && !isUploadedFromRecording"
        class="recording-card modern-card no-hover"
      >
        <!-- Header -->
        <div class="card-header text-center">
          <h2>Meeting Recorder</h2>
          <p
            class="status-text"
            :class="statusClass"
          >
            {{ statusText }}
          </p>
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

        <!-- P0 Data Loss Fix: Silence Warning Display -->
        <div
          v-if="silenceWarning"
          class="warning-section"
        >
          <q-banner
            class="warning-banner"
            rounded
          >
            <template #avatar>
              <q-icon
                name="mic_off"
                color="warning"
              />
            </template>
            {{ silenceWarning }}
          </q-banner>
        </div>

        <!-- Error Display -->
        <div
          v-if="recordingStore.error && !isAutoUploading"
          class="error-section"
        >
          <q-banner
            class="error-banner"
            rounded
          >
            <template #avatar>
              <q-icon
                name="error_outline"
                color="negative"
              />
            </template>
            {{ recordingStore.error }}
            <template #action>
              <q-btn
                flat
                color="negative"
                label="Dismiss"
                @click="recordingStore.error = null"
              />
            </template>
          </q-banner>
        </div>
      </div>

      <!-- Auto-Upload Progress Section -->
      <div
        v-if="showUploadSection"
        class="upload-card modern-card no-hover"
      >
        <!-- Only show header during processing/uploading/error, not when complete -->
        <div
          v-if="!recordingStore.isUploaded"
          class="upload-header"
        >
          <q-icon
            :name="uploadIcon"
            size="sm"
            :color="uploadIconColor"
          />
          <span>{{ uploadHeaderText }}</span>
        </div>

        <!-- Processing state -->
        <div
          v-if="isProcessing"
          class="upload-content"
        >
          <div class="processing-state">
            <q-spinner-dots
              color="primary"
              size="40px"
            />
            <span>Processing recording...</span>
          </div>
        </div>

        <!-- Uploading state -->
        <div
          v-else-if="isAutoUploading || recordingStore.isUploading"
          class="upload-content"
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
          <div class="upload-note">
            <q-icon
              name="info"
              size="xs"
              color="grey-6"
            />
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
            <q-btn
              flat
              color="negative"
              label="Cancel Upload"
              icon="close"
              size="sm"
              @click="cancelUpload"
            />
          </div>
        </div>

        <!-- Upload Error state -->
        <div
          v-else-if="uploadError"
          class="upload-content"
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
              label="View History"
              icon="history"
              @click="goToHistory"
            />
          </div>

          <div class="error-note">
            <q-icon
              name="save"
              size="xs"
              color="grey-6"
            />
            <span>Your recording is saved locally and can be uploaded later from History</span>
          </div>
        </div>

        <!-- Upload Complete state -->
        <div
          v-else-if="recordingStore.isUploaded"
          class="upload-success"
        >
          <!-- Top Section: New Recording Button + Duration (prominent) -->
          <div class="success-top-actions">
            <q-btn
              unelevated
              color="primary"
              :label="$t('newRecording')"
              icon="mic"
              class="new-recording-btn"
              @click="handleNewRecording"
            />
            <div
              v-if="finalDuration > 0"
              class="duration-badge"
            >
              <q-icon
                name="schedule"
                size="18px"
              />
              <span>{{ formattedFinalDuration }}</span>
            </div>
          </div>

          <!-- Main CTA: View Transcript -->
          <div
            v-if="currentAudioFileId"
            class="transcript-cta"
          >
            <div class="cta-icon">
              <q-icon
                name="check_circle"
                size="64px"
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

            <!-- URL Display with Copy -->
            <div class="url-compact">
              <code>https://app.suisse-notes.ch/meeting/audio/{{ currentAudioFileId }}</code>
              <q-btn
                flat
                dense
                icon="content_copy"
                size="sm"
                color="primary"
                @click="copyTranscriptUrl"
              >
                <q-tooltip>{{ $t('copyLink') }}</q-tooltip>
              </q-btn>
            </div>
          </div>

          <!-- Bottom: View History link -->
          <div class="success-bottom">
            <q-btn
              flat
              color="grey-7"
              :label="$t('viewHistory')"
              icon="history"
              size="sm"
              @click="goToHistory"
            />
          </div>
        </div>
      </div>

      <!-- Tips Section (only when idle) -->
      <div
        v-if="recordingStore.status === 'idle'"
        class="tips-card modern-card no-hover"
      >
        <div class="tips-header">
          <q-icon
            name="tips_and_updates"
            size="sm"
            color="primary"
          />
          <span>{{ $t('tipsTitle') }}</span>
        </div>
        <ul class="tips-list">
          <li>{{ $t('tip1') }}</li>
          <li>{{ $t('tip2') }}</li>
          <li>{{ $t('tip3') }}</li>
        </ul>
        <div class="tips-contact">
          <q-icon
            name="headset_mic"
            size="xs"
            color="grey-6"
          />
          <span>{{ $t('tipsContact') }} <a href="mailto:info@suisse-notes.ch">info@suisse-notes.ch</a></span>
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
import { useTranscriptionSettingsStore } from '../stores/transcription-settings';
import { useRecorder } from '../composables/useRecorder';
import { isElectron, isCapacitor } from '../utils/platform';
import { uploadWithVerification } from '../services/upload';
import { getApiUrlSync } from '../services/api';
import { useAuthStore } from '../stores/auth';
import ModeTabSwitcher from '../components/ModeTabSwitcher.vue';
import TranscriptionOptions from '../components/TranscriptionOptions.vue';
import RecordingControls from '../components/RecordingControls.vue';
import AudioLevelMeter from '../components/AudioLevelMeter.vue';
import StorageOptionDialog from '../components/StorageOptionDialog.vue';

const router = useRouter();
const $q = useQuasar();
const recordingStore = useRecordingStore();
const historyStore = useRecordingsHistoryStore();
const transcriptionStore = useTranscriptionSettingsStore();
const authStore = useAuthStore();

const {
  audioLevel,
  availableMicrophones,
  selectedMicrophoneId,
  loadingMicrophones,
  systemAudioEnabled,
  systemAudioPermissionStatus,
  // P0 Data Loss Fix: Silence detection warning
  silenceWarning,
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
const transcriptUrl = ref('');

// Use computed to access store values (for reactivity and persistence across navigation)
const currentAudioFileId = computed(() => recordingStore.audioFileId);
const finalDuration = computed(() => recordingStore.finalDuration);

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

// Check if current upload state is from a file upload (UploadPage), not a recording
const isFromFileUpload = computed(() => {
  return recordingStore.recordId && recordingStore.recordId.startsWith('file_');
});

// Only true if uploaded AND it was from a recording (not a file upload)
const isUploadedFromRecording = computed(() => {
  return recordingStore.isUploaded && !isFromFileUpload.value;
});

const showUploadSection = computed(() => {
  // Don't show upload section if the uploaded state is from a file upload (UploadPage)
  return isProcessing.value ||
         isAutoUploading.value ||
         recordingStore.isUploading ||
         uploadError.value ||
         isUploadedFromRecording.value;
});

// Hide tab switcher when recording is in progress
const isRecordingActive = computed(() => {
  return recordingStore.isRecording ||
         recordingStore.isPaused ||
         isProcessing.value ||
         isAutoUploading.value ||
         recordingStore.isUploading;
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

const displayProgress = computed(() => {
  return recordingStore.uploadProgress;
});

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
  // Load available microphones on all platforms (desktop and mobile)
  // This enables selection of Bluetooth headsets, wired mics, etc. on mobile
  await loadMicrophones();

  // Load system audio state (desktop only - mobile doesn't support system audio capture)
  if (isElectron()) {
    await loadSystemAudioState();
  }

  // Load transcription settings
  await transcriptionStore.loadGlobalSettings();

  if (isElectron() && !historyStore.loaded) {
    await historyStore.loadRecordings();
  }

  // Restore UI state from store (for navigation back during upload)
  if (recordingStore.status === 'uploading') {
    isAutoUploading.value = true;
    isProcessing.value = false;
  } else if (recordingStore.status === 'uploaded') {
    // Check if this was a file upload from UploadPage (recordId starts with 'file_')
    // If so, reset the store - we don't want to show UploadPage's success here
    if (recordingStore.recordId && recordingStore.recordId.startsWith('file_')) {
      recordingStore.reset();
    } else {
      // This was a recording upload - restore the UI state
      isAutoUploading.value = false;
      isProcessing.value = false;
    }
  }

  // Set up upload listeners (Electron only)
  if (isElectron() && window.electronAPI?.upload) {
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
  }
});

onUnmounted(() => {
  if (isElectron() && window.electronAPI?.upload?.removeAllListeners) {
    window.electronAPI.upload.removeAllListeners();
  }
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
  // Save duration before stopping
  recordingStore.setFinalDuration(recordingStore.duration);

  // Start processing
  isProcessing.value = true;
  uploadError.value = null;
  retryAttempt.value = 0;

  try {
    const result = await stopRecording();

    if (result.success) {
      // Show recovery notification if recording was recovered after interruption
      if (result.recovered) {
        $q.notify({
          type: 'warning',
          message: result.warning || 'Recording recovered after interruption. Some audio at the end may be missing.',
          timeout: 8000
        });
      }

      // Get file info - platform specific
      if (isElectron()) {
        const fileInfo = await window.electronAPI.recording.getFilePath(recordingStore.recordId, '.webm');
        if (fileInfo.success) {
          currentFilePath.value = fileInfo.filePath;
          currentFileSize.value = fileInfo.fileSize;
        }
      } else if (isCapacitor()) {
        // On mobile, the file path and size come from the stop result
        if (result.filePath) {
          currentFilePath.value = result.filePath;
          currentFileSize.value = result.fileSize || 0;
        }
      }

      // Processing done, start auto-upload
      isProcessing.value = false;
      await startAutoUpload();
    } else {
      isProcessing.value = false;

      // Show more detailed error for partial recovery
      if (result.partialRecovery) {
        $q.notify({
          type: 'warning',
          message: 'Recording was interrupted. Your audio chunks are saved locally but could not be combined. Please contact support.',
          timeout: 10000
        });
      } else {
        $q.notify({
          type: 'negative',
          message: result.error || 'Failed to save recording'
        });
      }
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

  // P0 Data Loss Fix: Lock file before upload to prevent deletion during upload
  recordingStore.lockForUpload(recordingStore.recordId);

  // Get transcription options
  const options = transcriptionStore.transcriptionOptions;

  try {
    let result;

    if (isElectron()) {
      // Desktop: Use Electron's upload mechanism
      result = await window.electronAPI.upload.start({
        recordId: recordingStore.recordId,
        filePath: currentFilePath.value,
        metadata: {
          duration: finalDuration.value.toString(),
          title: options.title,
          customVocabulary: options.customVocabulary
        }
      });

      // Handle token expiration - attempt refresh and retry
      if (!result.success && result.status === 401) {
        console.log('Token expired, attempting refresh...');
        const refreshResult = await authStore.handleAuthError();
        if (refreshResult.success) {
          console.log('Token refreshed, retrying upload...');
          result = await window.electronAPI.upload.start({
            recordId: recordingStore.recordId,
            filePath: currentFilePath.value,
            metadata: {
              duration: finalDuration.value.toString(),
              title: options.title,
              customVocabulary: options.customVocabulary
            }
          });
        } else if (refreshResult.shouldLogout) {
          result = { success: false, error: 'Session expired. Please log in again.' };
        }
      }
    } else if (isCapacitor()) {
      // Mobile: Use uploadWithVerification from services/upload.js
      result = await uploadWithVerification({
        filePath: currentFilePath.value,
        recordId: recordingStore.recordId,
        apiUrl: getApiUrlSync(),
        authToken: authStore.token,
        metadata: {
          duration: finalDuration.value.toString(),
          title: options.title,
          customVocabulary: options.customVocabulary
        },
        onProgress: (p) => recordingStore.updateUploadProgress(p, 0, 0),
        getAuthStore: () => authStore // Enable token refresh
      });
    } else {
      throw new Error('Unsupported platform');
    }

    isAutoUploading.value = false;
    retryAttempt.value = 0;

    if (result.success) {
      recordingStore.setUploaded(result.audioFileId);

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

      // P0 Data Loss Fix: Only delete if upload was verified AND canDelete returns true
      // Check result.canDelete which comes from two-phase verification
      if (currentStoragePreference.value === 'delete_after_upload') {
        if (result.canDelete && recordingStore.canDelete(recordingStore.recordId)) {
          if (isElectron()) {
            await window.electronAPI.recording.deleteRecording(recordingStore.recordId);
          }
          // On mobile, file deletion is handled by the storage service
          await historyStore.updateRecording(recordingStore.recordId, { filePath: null });
        } else {
          console.warn('File not deleted: upload not verified or file is locked');
          $q.notify({
            type: 'warning',
            message: 'Recording uploaded but file kept locally for safety',
            timeout: 5000
          });
        }
      }

      // P0 Data Loss Fix: Unlock file after successful upload
      recordingStore.unlockFile(recordingStore.recordId);

      // Reset session after successful upload
      transcriptionStore.resetSession();

      $q.notify({
        type: 'positive',
        message: 'Recording uploaded successfully'
      });
    } else {
      // P0 Data Loss Fix: Keep file locked on failure - will be unlocked on retry or explicit delete
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
    filePath: currentFilePath.value,
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
  recordingStore.audioFileId = null;
  recordingStore.finalDuration = 0;
};

// Cancel the current upload
const cancelUpload = async () => {
  try {
    if (recordingStore.recordId && isElectron()) {
      await window.electronAPI.upload.cancel(recordingStore.recordId);
    }
    // On mobile, upload cancellation is handled by aborting the XHR request
    // For now, we just reset the UI state

    // Reset UI state
    isProcessing.value = false;
    isAutoUploading.value = false;
    uploadError.value = null;
    retryAttempt.value = 0;

    // Reset store
    recordingStore.status = 'idle';
    recordingStore.uploadProgress = 0;
    recordingStore.bytesUploaded = 0;
    recordingStore.bytesTotal = 0;
    recordingStore.error = null;

    $q.notify({
      type: 'info',
      message: 'Upload cancelled'
    });
  } catch (error) {
    console.error('Error cancelling upload:', error);
  }
};

const generateTranscriptUrl = async () => {
  if (!currentAudioFileId.value) return '';

  let url = `https://app.suisse-notes.ch/meeting/audio/${currentAudioFileId.value}`;

  // Try to get a web session token for seamless login (Electron only)
  if (isElectron()) {
    try {
      const result = await window.electronAPI.auth.createWebSession();
      if (result.success && result.sessionToken) {
        url += `?session=${encodeURIComponent(result.sessionToken)}`;
        console.log('Web session created successfully');
      } else {
        console.warn('Failed to create web session:', result.error);
      }
    } catch (error) {
      console.warn('Could not create web session:', error);
    }
  }
  // On mobile, user will need to log in manually in the browser

  return url;
};

const openInSuisseNotes = async () => {
  if (currentAudioFileId.value) {
    // Generate fresh URL (session tokens are one-time use)
    const url = await generateTranscriptUrl();

    if (isElectron()) {
      if (!url.includes('session=')) {
        $q.notify({
          type: 'warning',
          message: 'Could not create session. You may need to log in on the web.',
          timeout: 3000
        });
      }
      window.electronAPI.shell.openExternal(url);
    } else if (isCapacitor()) {
      // On mobile, open in system browser using Capacitor Browser plugin
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
    }
  }
};

const copyTranscriptUrl = async () => {
  if (currentAudioFileId.value) {
    // Generate fresh URL for copying
    const url = await generateTranscriptUrl();
    transcriptUrl.value = url;

    try {
      await navigator.clipboard.writeText(url);
      $q.notify({
        type: 'positive',
        message: 'Link copied to clipboard',
        timeout: 2000
      });
    } catch (error) {
      console.error('Failed to copy URL:', error);
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
</script>

<style lang="scss" scoped>
.record-page {
  padding: 40px 48px;

  @media (max-width: 600px) {
    padding: 16px;
  }
}

.record-container {
  max-width: 600px;
  margin: 0 auto;
}

.idle-layout {
  display: flex;
  flex-direction: column;
}

.record-card {
  padding: 40px 36px;
  display: flex;
  flex-direction: column;
  border-radius: 16px;

  @media (max-width: 600px) {
    padding: 24px 16px;
  }
}

.column-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 28px;

  h3 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    color: #1e293b;
  }
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
    font-size: 12px;
    color: #64748b;
    margin-bottom: 10px;
  }
}

.mic-selected-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
  display: inline-block;
  font-size: 13px;
}

.system-audio-section {
  min-height: 70px;
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

  @media (max-width: 600px) {
    padding: 24px 16px;
  }
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

.warning-section {
  margin-top: 24px;

  .warning-banner {
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.2);
    color: #92400e;
  }
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

  @media (max-width: 600px) {
    padding: 20px 16px;
  }
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

  .success-top-actions {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 16px;
    margin-bottom: 24px;
    padding-bottom: 20px;
    border-bottom: 1px solid #e2e8f0;

    .new-recording-btn {
      height: 44px;
      padding: 0 24px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 22px;
    }

    .duration-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 16px;
      background: #f1f5f9;
      border-radius: 20px;
      font-size: 14px;
      color: #475569;
      font-weight: 500;
    }
  }

  .url-compact {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 16px;
    padding: 8px 12px;
    background: #f8fafc;
    border-radius: 8px;
    font-size: 12px;

    code {
      color: #64748b;
      font-family: 'JetBrains Mono', monospace;
      word-break: break-all;
    }
  }

  .success-bottom {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid #e2e8f0;
    text-align: center;
  }
}

.mic-select {
  :deep(.q-field__control) {
    border-radius: 8px;
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
    font-size: 13px;
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
  margin-top: 20px;
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
