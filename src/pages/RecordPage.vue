<template>
  <q-page class="record-page">
    <div class="record-container">
      <!-- Mode Tab Switcher (hidden when recording/paused/processing/uploading) -->
      <ModeTabSwitcher :hidden="isRecordingActive" />

      <!-- IDLE STATE: Recording form -->
      <div
        v-if="recordingStore.phase === 'idle' && !isUploadedFromRecording"
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
              :start-busy="startBusy"
              @start="handleStartClick"
              @pause="handlePause"
              @resume="handleResume"
              @stop="handleStop"
              @cancel="handleCancel"
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
                <span class="mic-selected-text">{{ scope.opt?.label || $t('selectMicrophone') }}</span>
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
                  <q-tooltip>{{ $t('refreshMicrophones') }}</q-tooltip>
                </q-btn>
              </template>
            </q-select>
          </div>

          <!-- System Audio Toggle - macOS 14.2+ via AudioTee -->
          <div
            v-if="isElectron() && isSystemAudioSupported"
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
                :disable="recordingStore.isPaused"
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
        <!-- Recording Death Alert -->
        <div
          v-if="recordingStore.isRecordingDead"
          class="recording-dead-alert"
        >
          <div class="dead-alert-header">
            <q-icon
              name="error"
              size="28px"
              color="negative"
            />
            <div class="dead-alert-text">
              <h3>{{ $t('recordingStoppedUnexpectedly') }}</h3>
              <p>{{ $t('recordingStoppedDesc') }}</p>
            </div>
          </div>

          <div
            v-if="recordingStore.interruptionInfo?.chunkCount > 0"
            class="dead-chunks-info"
          >
            <q-icon
              name="save"
              size="16px"
              color="warning"
            />
            <span>{{ $t('chunksAvailable', { count: recordingStore.interruptionInfo.chunkCount }) }}</span>
          </div>

          <div class="dead-timer">
            <div class="timer-display dead">
              {{ recordingStore.formattedDuration }}
            </div>
            <span class="timer-stopped-label">{{ $t('timerStopped') }}</span>
          </div>

          <div class="dead-actions">
            <q-btn
              unelevated
              color="primary"
              :label="autoSaveCountdown > 0 ? $t('autoSavingIn', { seconds: autoSaveCountdown }) : $t('saveRecording')"
              icon="save"
              @click="handleSaveDeadRecordingManual"
            />
            <q-btn
              flat
              color="negative"
              :label="$t('discardRecording')"
              icon="delete"
              @click="handleDiscardDeadRecording"
            />
          </div>
        </div>

        <!-- Normal recording UI (hidden when recording is dead) -->
        <template v-if="!recordingStore.isRecordingDead">
          <!-- Header -->
          <div class="card-header text-center">
            <h2>{{ $t('meetingRecorder') }}</h2>
            <p
              class="status-text"
              :class="statusClass"
            >
              {{ statusText }}
            </p>
          </div>

          <!-- System Audio Toggle (macOS 14.2+ via AudioTee, interactive during recording) -->
          <div
            v-if="isElectron() && isSystemAudioSupported"
            class="system-audio-indicator"
          >
            <q-icon
              :name="systemAudioEnabled ? 'volume_up' : 'volume_off'"
              size="14px"
              :color="systemAudioEnabled ? 'positive' : 'grey-5'"
            />
            <span :class="['indicator-text', { 'active': systemAudioEnabled }]">
              {{ systemAudioEnabled ? $t('systemAudioEnabled') : $t('systemAudioOff') }}
            </span>
            <q-toggle
              v-model="systemAudioEnabled"
              color="primary"
              size="sm"
              dense
              :disable="recordingStore.isPaused"
              @update:model-value="toggleSystemAudio"
            />
          </div>

          <!-- Microphone Switcher (during recording) -->
          <div class="mic-switch-section">
            <div class="mic-switch-row">
              <q-icon
                name="mic"
                size="14px"
                :color="micHealthStatus === 'ok' ? 'grey-6' : micHealthBadgeColor"
              />
              <q-select
                :model-value="selectedMicrophoneId"
                :options="availableMicrophones"
                option-value="id"
                option-label="label"
                emit-value
                map-options
                outlined
                dense
                borderless
                :loading="switchingMic || loadingMicrophones"
                class="mic-switch-select"
                popup-content-class="mic-dropdown"
                @update:model-value="handleMicSwitch"
              >
                <template #selected-item="scope">
                  <span class="mic-switch-text">{{ scope.opt?.label || $t('noMicrophone') }}</span>
                </template>
              </q-select>
              <q-btn
                flat
                round
                dense
                icon="refresh"
                size="xs"
                color="grey-6"
                :loading="loadingMicrophones"
                @click.stop="loadMicrophones"
              >
                <q-tooltip>{{ $t('refreshMicrophones') }}</q-tooltip>
              </q-btn>
            </div>
          </div>

          <!-- Timer Display -->
          <div class="timer-section">
            <div :class="['timer-display', { 'recording': recordingStore.isRecording, 'paused': recordingStore.isPaused }]">
              {{ recordingStore.formattedDuration }}
            </div>
          </div>

          <!-- Mobile only: a discreet line reminding the user to keep the app in
               the foreground. The WebView recorder is suspended if the OS
               backgrounds the app, and the screen wake-lock can't prevent a
               manual app-switch. Fine, grey, unobtrusive. -->
          <div
            v-if="isCapacitor() && (recordingStore.isRecording || recordingStore.isPaused)"
            class="foreground-hint"
          >
            {{ $t('keepAppForeground') }}
          </div>

          <!-- Audio Level Meter -->
          <div class="level-section">
            <div class="mic-health-row">
              <div class="mic-health-label">
                <q-icon
                  name="mic"
                  size="16px"
                  :color="micHealthBadgeColor"
                />
                <span>{{ $t('micInputStatus') }}</span>
              </div>
              <q-badge :color="micHealthBadgeColor">
                {{ micHealthBadgeText }}
              </q-badge>
            </div>
            <div class="mic-health-message">
              {{ micHealthMessage }}
            </div>
            <AudioLevelMeter
              :level="audioLevel"
              :label="$t('recordedSignal')"
            />
          </div>

          <!-- Recording Controls -->
          <div class="controls-section">
            <RecordingControls
              :audio-level="audioLevel"
              :is-mic-muted="isMicMuted"
              :start-busy="startBusy"
              @start="handleStartClick"
              @pause="handlePause"
              @resume="handleResume"
              @stop="handleStop"
              @cancel="handleCancel"
              @toggle-mute="toggleMicMute"
            />
          </div>

          <!-- Mic health notice (subtle inline text, not a big banner) -->
          <div
            v-if="showMicCriticalBanner"
            class="health-notice health-notice--critical"
          >
            <q-icon
              name="error_outline"
              size="14px"
              color="negative"
            />
            <span>{{ micHealthMessage }}</span>
          </div>
          <div
            v-else-if="silenceWarning"
            class="health-notice health-notice--warning"
          >
            <q-icon
              name="info_outline"
              size="14px"
              color="warning"
            />
            <span>{{ silenceWarning }}</span>
          </div>

          <!-- System Audio Capture Error Warning -->
          <div
            v-if="systemAudioCaptureError"
            class="warning-section"
          >
            <q-banner
              class="warning-banner"
              rounded
            >
              <template #avatar>
                <q-icon
                  name="volume_off"
                  color="warning"
                />
              </template>
              {{ $t('systemAudioCaptureError') }}
            </q-banner>
          </div>

          <!-- Microphone Capture Error Warning (hidden when critical banner already shows the failure) -->
          <div
            v-if="micCaptureError && !showMicCriticalBanner"
            class="warning-section"
          >
            <q-banner
              class="warning-banner"
              rounded
            >
              <template #avatar>
                <q-icon
                  name="mic_off"
                  color="negative"
                />
              </template>
              {{ micCaptureError }}
            </q-banner>
          </div>

          <!-- P0 Data Loss Fix: Chunk Save Failure Warning (V1/V7) -->
          <div
            v-if="recordingStore.chunkSaveErrorWarning"
            class="warning-section"
          >
            <q-banner
              class="warning-banner"
              rounded
            >
              <template #avatar>
                <q-icon
                  name="warning"
                  color="negative"
                />
              </template>
              {{ $t('chunkSaveWarning', 'Audio chunks failing to save. Recording data may be lost. Check available storage.') }}
            </q-banner>
          </div>

          <!-- Capture-stall watchdog: no audio saved for a while while still "recording" -->
          <div
            v-if="captureStalled"
            class="warning-section"
          >
            <q-banner
              class="warning-banner"
              rounded
            >
              <template #avatar>
                <q-icon
                  name="warning"
                  color="negative"
                />
              </template>
              {{ $t('captureStalledWarning', 'Recording may have stalled — no audio has been saved for a while. Please verify; stop and save if it does not recover.') }}
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
                  :label="$t('dismiss')"
                  @click="recordingStore.error = null"
                />
              </template>
            </q-banner>
          </div>
        </template>
      </div>

      <!-- ERROR STATE: Recording failed -->
      <div
        v-if="recordingStore.phase === 'error' && !showUploadSection"
        class="error-card modern-card no-hover"
      >
        <div class="error-card-content">
          <q-icon
            name="error_outline"
            size="lg"
            color="negative"
          />
          <h3>{{ $t('recordingErrorTitle') }}</h3>
          <p>{{ $t('recordingErrorMessage') }}</p>
          <div class="error-card-actions">
            <q-btn
              v-if="recordingStore.chunkIndex > 0"
              color="primary"
              :label="$t('retrySaving')"
              icon="refresh"
              @click="retryChunkCombine"
            />
            <q-btn
              color="primary"
              :label="$t('newRecording')"
              icon="mic"
              :flat="recordingStore.chunkIndex > 0"
              @click="handleNewRecording"
            />
          </div>
        </div>
      </div>

      <!-- Full-screen blocking overlay during processing/uploading/complete/error -->
      <teleport to="body">
        <div
          v-if="showUploadSection"
          class="recording-pipeline-overlay"
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
                  {{ displayProgress >= 100 ? $t('processingOnServer') : (recordingStore.uploadRetryAttempt > 0 ? $t('uploadRetrying', { attempt: recordingStore.uploadRetryAttempt, max: recordingStore.uploadRetryMaxRetries }) : $t('uploading')) }}
                </span>
                <span
                  v-if="displayProgress > 0 && displayProgress < 100"
                  class="progress-percent"
                >{{ displayProgress }}%</span>
              </div>
              <q-linear-progress
                v-if="displayProgress > 0 && displayProgress < 100"
                :value="displayProgress / 100"
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
            <div class="upload-actions">
              <q-btn
                flat
                color="grey-7"
                :label="$t('cancelUpload') || 'Cancel Upload'"
                icon="close"
                :loading="isCancellingUpload"
                @click="cancelRecordingUpload"
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
                name="check_circle"
                size="xs"
                color="positive"
              />
              <span>{{ $t('recordingSavedLocally') }}</span>
            </div>
          </div>
        </div>
      </teleport>

      <!-- Upload Complete — shown inline (not blocking) so user can navigate freely -->
      <div
        v-if="recordingStore.isUploaded && isUploadedFromRecording"
        class="upload-success-card modern-card no-hover"
      >
        <div class="upload-success">
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
        v-if="recordingStore.phase === 'idle'"
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

    <!-- Contact Sales Dialog (minutes limit) -->
    <ContactSalesDialog
      v-model="showContactSalesDialog"
      :reason="contactSalesReason"
      @submitted="onSalesInquirySubmitted"
      @close="showContactSalesDialog = false"
    />
  </q-page>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import { useRecordingStore } from '../stores/recording';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import { useTranscriptionSettingsStore } from '../stores/transcription-settings';
import { useMinutesStore } from '../stores/minutes';
import { useRecorder } from '../composables/useRecorder';
import { isElectron, isCapacitor, isAndroid } from '../utils/platform';
import { humanizeStorageError } from '../utils/storageErrors';
import { uploadWithVerification } from '../services/upload';
import { getApiUrlSync } from '../services/api';
import { stopStorageMonitor } from '../services/storageMonitor';
import { setRecordingActive } from '../boot/lifecycle';
import { useAuthStore } from '../stores/auth';
import { useShareLink } from '../composables/useShareLink';
import ModeTabSwitcher from '../components/ModeTabSwitcher.vue';
import TranscriptionOptions from '../components/TranscriptionOptions.vue';
import RecordingControls from '../components/RecordingControls.vue';
import AudioLevelMeter from '../components/AudioLevelMeter.vue';
import StorageOptionDialog from '../components/StorageOptionDialog.vue';
import ContactSalesDialog from '../components/ContactSalesDialog.vue';

const router = useRouter();
const $q = useQuasar();
const { t } = useI18n();
const recordingStore = useRecordingStore();
const historyStore = useRecordingsHistoryStore();
const transcriptionStore = useTranscriptionSettingsStore();
const minutesStore = useMinutesStore();
const authStore = useAuthStore();
const { openInBrowser, copyLink } = useShareLink();

const {
  audioLevel,
  availableMicrophones,
  selectedMicrophoneId,
  loadingMicrophones,
  systemAudioEnabled,
  systemAudioPermissionStatus,
  isSystemAudioSupported,
  // P0 Data Loss Fix: Silence detection warning
  silenceWarning,
  // System audio capture error
  systemAudioCaptureError,
  // Microphone capture error (e.g., mic in use by another app)
  micCaptureError,
  recordingHealth,
  isMicHealthy,
  recordingHealthMessage,
  // Capture-stall watchdog (data-loss prevention)
  captureStalled,
  // INT-2: interruption auto-recovery succeeded — surface the gap
  captureRecoveredInfo,
  // Minutes limit tracking
  minutesLimitWarning,
  minutesLimitReached,
  isMicMuted,
  setSystemAudioEnabled,
  loadMicrophones,
  loadSystemAudioState,
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  cancelRecording,
  toggleSystemAudioDuringRecording,
  toggleMicMute,
  switchMicrophoneDuringRecording
} = useRecorder();

// Mid-recording microphone switching
const switchingMic = ref(false);
const handleMicSwitch = async (newDeviceId) => {
  if (switchingMic.value) return;
  switchingMic.value = true;
  try {
    const result = await switchMicrophoneDuringRecording(newDeviceId);
    if (!result.success) {
      console.error('Mic switch failed:', result.error);
    }
  } finally {
    switchingMic.value = false;
  }
};

// System audio toggle functionality.
// While paused, toggling ON desyncs the merged audio because AudioTee runs
// in wall-clock time and would write PCM during the pause window — see
// useRecorder.toggleSystemAudioDuringRecording (bug_005). UI should
// disable the switch while paused; this is the runtime safety net for the
// case where the disabled-prop binding hasn't propagated yet or is bypassed.
const toggleSystemAudio = async (enabled) => {
  if (recordingStore.isPaused) {
    // Defensive: useRecorder will also reject this, but a no-op here keeps
    // the UI tidy (no spinner / no error toast unless the user really tries).
    return;
  }
  if (recordingStore.isRecording) {
    await toggleSystemAudioDuringRecording(enabled);
  } else {
    await setSystemAudioEnabled(enabled);
  }
};

const isMac = computed(() => {
  return navigator.platform.toLowerCase().includes('mac');
});

const showMacPermissionNotice = computed(() => {
  // AudioTee handles permission prompts automatically — only show notice if explicitly denied
  return isMac.value && systemAudioPermissionStatus.value === 'denied' && systemAudioEnabled.value;
});

const micHealthStatus = computed(() => recordingHealth.value?.status || 'ok');

const micHealthBadgeColor = computed(() => {
  if (micHealthStatus.value === 'critical') return 'negative';
  if (micHealthStatus.value === 'degraded') return 'warning';
  return 'positive';
});

const micHealthBadgeText = computed(() => {
  if (micHealthStatus.value === 'critical') return t('micHealthCritical');
  if (micHealthStatus.value === 'degraded') return t('micHealthDegraded');
  return t('micHealthOk');
});

const micHealthMessage = computed(() => {
  const reasonCode = recordingHealth.value?.reasonCode || null;
  switch (reasonCode) {
    case 'no_audio_detected':
      return t('micHealthNoAudio');
    case 'no_voice_detected':
      return t('micHealthNoVoice');
    case 'mic_capture_failed':
      return t('micHealthCaptureFailed');
    case 'track_ended':
      return t('micHealthTrackEnded');
    case 'system_audio_only':
      return t('micHealthSystemOnly');
    case 'monitoring_error':
      return t('micHealthMonitoringError');
    default:
      return recordingHealthMessage.value || t('micHealthReady');
  }
});

const showMicCriticalBanner = computed(() => micHealthStatus.value === 'critical');

// Auto-save countdown for dead recordings
const autoSaveCountdown = ref(0);
const autoSaveTimer = ref(null);

const showStorageDialog = ref(false);
const showContactSalesDialog = ref(false);
const contactSalesReason = ref('limit_reached');
const currentStoragePreference = ref('keep');
// All recording/upload state lives in the store — no local refs for these.
// Computed aliases for template convenience:
const isProcessing = computed(() => recordingStore.isProcessing);
const isAutoUploading = computed(() => recordingStore.isUploading);
const uploadError = computed(() => recordingStore.uploadError);
const retryAttempt = computed(() => recordingStore.uploadRetryAttempt);
const currentFilePath = computed(() => recordingStore.audioFilePath);
const currentFileSize = computed(() => recordingStore.currentFileSize);
const isRetrying = ref(false); // Local UI state for retry button spinner
const isCancellingUpload = ref(false);

const cancelRecordingUpload = async () => {
  if (!recordingStore.isUploading) return;
  isCancellingUpload.value = true;
  try {
    if (isElectron() && window.electronAPI?.upload?.cancel) {
      await window.electronAPI.upload.cancel(recordingStore.recordId);
    }
    $q.notify({ type: 'info', message: t('uploadCancelled') || 'Upload cancelled' });
  } catch (error) {
    console.error('Error cancelling upload:', error);
    $q.notify({ type: 'negative', message: 'Error cancelling upload' });
  } finally {
    isCancellingUpload.value = false;
    recordingStore.reset();
  }
};

// Watch for minutes limit warning
watch(minutesLimitWarning, (minutesRemaining) => {
  if (minutesRemaining !== null && minutesRemaining > 0) {
    $q.notify({
      type: 'warning',
      message: t('minutesLimitWarning', { minutes: minutesRemaining }),
      icon: 'schedule',
      timeout: 5000
    });
  }
});

// Watch for minutes limit reached - auto-stop recording
// INT-2: interruption auto-recovery restored capture — tell the user how big
// the gap is, so they can repeat what was said instead of discovering the
// hole after the meeting.
watch(captureRecoveredInfo, (info) => {
  if (!info) return;
  const gapMin = Math.max(1, Math.round(info.gapSeconds / 60));
  $q.notify({
    type: 'warning',
    message: t('captureRecoveredGap', { minutes: gapMin }),
    icon: 'mic',
    timeout: 8000
  });
});

watch(minutesLimitReached, async (reached) => {
  if (reached && (recordingStore.isRecording || recordingStore.isPaused)) {
    // Show notification
    $q.notify({
      type: 'warning',
      message: t('minutesLimitReached'),
      icon: 'schedule',
      timeout: 3000
    });

    // Stop the recording
    await handleStop();

    // On mobile: simple notification (Apple Guideline 3.1.1)
    // On desktop: show contact sales dialog
    if (isCapacitor()) {
      $q.notify({
        type: 'warning',
        message: t('noMinutesRemaining'),
        icon: 'schedule',
        timeout: 5000
      });
    } else {
      contactSalesReason.value = 'limit_reached';
      showContactSalesDialog.value = true;
    }
  }
});

// Auto-save dead recordings after 5-second countdown
watch(() => recordingStore.isRecordingDead, (isDead) => {
  if (isDead && recordingStore.interruptionInfo?.chunkCount > 0) {
    autoSaveCountdown.value = 5;
    autoSaveTimer.value = setInterval(() => {
      autoSaveCountdown.value--;
      if (autoSaveCountdown.value <= 0) {
        clearInterval(autoSaveTimer.value);
        autoSaveTimer.value = null;
        handleSaveDeadRecording();
      }
    }, 1000);
  } else {
    // Clear timer if recording is no longer dead
    if (autoSaveTimer.value) {
      clearInterval(autoSaveTimer.value);
      autoSaveTimer.value = null;
      autoSaveCountdown.value = 0;
    }
  }
});

// Use computed to access store values (for reactivity and persistence across navigation)
const currentAudioFileId = computed(() => recordingStore.audioFileId);
const finalDuration = computed(() => recordingStore.finalDuration);

const statusText = computed(() => {
  if (isProcessing.value) return 'Processing...';
  if (isAutoUploading.value) return retryAttempt.value > 0 ? `Retrying upload (${retryAttempt.value})...` : 'Uploading...';
  if (uploadError.value) return 'Upload failed';
  if (recordingStore.isRecording && !isMicHealthy.value) return t('micHealthStatusIssue');

  switch (recordingStore.phase) {
    case 'idle': return 'Ready to record';
    case 'recording': return 'Recording in progress';
    case 'paused': return 'Recording paused';
    case 'stopping': return 'Stopping...';
    case 'processing': return 'Processing recording...';
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
  // Show blocking overlay during processing, uploading, and error only.
  // Once uploaded, overlay dismisses — success shown inline on the record page.
  return ['processing', 'uploading', 'error'].includes(recordingStore.phase);
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
  if (!seconds || !isFinite(seconds)) return '00:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
});

// Open Android app settings (for permission management)
const openAndroidAppSettings = async () => {
  try {
    const { registerPlugin } = await import('@capacitor/core');
    const BackgroundRecording = registerPlugin('BackgroundRecording');
    await BackgroundRecording.openAppSettings();
  } catch (e) {
    console.warn('Failed to open app settings:', e);
  }
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

// Load history store and set up listeners on mount
onMounted(async () => {
  // On Android, proactively trigger the microphone permission dialog
  // before enumerating devices so the user sees it immediately
  if (isAndroid() && navigator.mediaDevices) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
    } catch (e) {
      // Permission denied or no mic — will be handled after loadMicrophones below
      console.warn('Microphone permission request failed:', e);
    }
  }

  // Load available microphones on all platforms (desktop and mobile)
  // This enables selection of Bluetooth headsets, wired mics, etc. on mobile
  await loadMicrophones();

  // Warn if no microphone detected (and not already shown permission denied message)
  if (availableMicrophones.value.length === 0) {
    // On Android, show a more specific message about permissions
    if (isAndroid()) {
      $q.notify({
        type: 'warning',
        message: t('micPermissionRequired'),
        icon: 'mic_off',
        timeout: 0,
        actions: [
          { label: t('allowMicrophone'), color: 'yellow', handler: async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              stream.getTracks().forEach(track => track.stop());
              await loadMicrophones();
              if (availableMicrophones.value.length > 0) {
                $q.notify({ type: 'positive', message: t('microphoneReady'), icon: 'mic', timeout: 3000 });
              }
            } catch (err) {
              $q.notify({
                type: 'negative',
                message: t('micPermissionDenied'),
                icon: 'mic_off',
                timeout: 8000,
                actions: [
                  { label: t('openSettings'), color: 'white', handler: () => openAndroidAppSettings() }
                ]
              });
            }
          }},
          { label: t('dismiss'), color: 'white' }
        ]
      });
    } else {
      $q.notify({
        type: 'warning',
        message: t('noMicrophoneDetected'),
        icon: 'mic_off',
        timeout: 8000
      });
    }
  }

  // Load system audio state (desktop only - mobile doesn't support system audio capture)
  // Skip when recording is active — the service already holds the correct state
  // and useRecorder.onMounted restores it. Loading from config would overwrite it
  // because config:getSystemAudioEnabled defaults to false each session.
  if (isElectron() && !recordingStore.isRecording && !recordingStore.isPaused) {
    await loadSystemAudioState();
  }

  // Load transcription settings
  await transcriptionStore.loadGlobalSettings();

  if (!historyStore.loaded) {
    await historyStore.loadRecordings();
  }

  // Restore UI state from store (for navigation back during upload)
  // If state is from a file upload (UploadPage), always reset so RecordPage starts clean
  if (recordingStore.recordId && recordingStore.recordId.startsWith('file_')) {
    recordingStore.reset();
  } else if (recordingStore.phase === 'uploading') {
    // phase set to 'uploading' via setUploading()
    // phase transition handled by subsequent action (setUploading/setError/reset)
  } else if (recordingStore.phase === 'uploaded') {
    // Recording already finished — reset to idle so the user sees a fresh Record tab
    recordingStore.reset();
  }

});

onUnmounted(() => {
  // Clear auto-save timer
  if (autoSaveTimer.value) {
    clearInterval(autoSaveTimer.value);
    autoSaveTimer.value = null;
  }
  stopBackgroundUploadWatch();
});

// When startAutoUpload finds an upload for this recordId already in flight
// (persistent queue got there first), the queue holder owns completion. Poll
// the history entry it updates and converge the page's phase, so the record
// screen doesn't sit in 'uploading' forever with a locked file.
let backgroundUploadWatchTimer = null;

const stopBackgroundUploadWatch = () => {
  if (backgroundUploadWatchTimer) {
    clearInterval(backgroundUploadWatchTimer);
    backgroundUploadWatchTimer = null;
  }
};

const watchBackgroundUpload = (recordId) => {
  stopBackgroundUploadWatch();
  const startedAt = Date.now();
  const WATCH_TIMEOUT_MS = 30 * 60 * 1000; // give up after 30 min; queue keeps retrying on its own

  backgroundUploadWatchTimer = setInterval(async () => {
    // Session moved on (new recording started / page reset) — stop watching
    if (recordingStore.recordId !== recordId || !recordingStore.isUploading) {
      stopBackgroundUploadWatch();
      return;
    }

    const rec = historyStore.recordings.find(r => r.id === recordId);
    if (rec?.uploadStatus === 'uploaded') {
      stopBackgroundUploadWatch();
      recordingStore.setUploaded(rec.audioFileId || null);
      recordingStore.unlockFile(recordId);
      transcriptionStore.resetSession();
      $q.notify({ type: 'positive', message: t('uploadSuccessful') });
    } else if (rec?.uploadStatus === 'failed') {
      stopBackgroundUploadWatch();
      await handleUploadError(rec.uploadError || 'Upload failed');
    } else if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
      // Queue is still retrying in the background; free the page so the
      // user can keep working. The file stays locked (protects the retry).
      stopBackgroundUploadWatch();
      await handleUploadError(rec?.uploadError || 'Upload still pending — it will retry in the background');
    }
  }, 5000);
};

// Double-start protection (UI layer): the start flow spends multiple seconds
// in awaits (minutes sync, mic acquisition, session IPC) during which the
// Start button used to stay clickable — a second click spawned a SECOND
// MediaRecorder pipeline whose chunks interleaved with the first, doubling
// every sentence of the recording. The service has its own synchronous latch;
// these refs additionally cover the pre-start work and drive the button's
// loading/disabled state.
const startClickBusy = ref(false); // guards handleStartClick pre-work
const startInFlight = ref(false);  // guards doStartRecording (the actual start)
const startBusy = computed(() => startClickBusy.value || startInFlight.value);

const handleStartClick = async () => {
  if (startBusy.value) return;
  startClickBusy.value = true;
  try {
    await handleStartClickInternal();
  } finally {
    startClickBusy.value = false;
  }
};

const handleStartClickInternal = async () => {
  // Reset error state
  recordingStore.uploadError =null;
  recordingStore.uploadRetryAttempt = 0;

  // Sync minutes with server before checking (3s timeout, fallback to cached)
  await Promise.race([
    minutesStore.syncWithServer(authStore.token),
    new Promise((_, reject) => setTimeout(() => reject(), 3000))
  ]).catch(() => {});

  // Check if user has minutes remaining
  if (!minutesStore.hasMinutesRemaining) {
    if (isCapacitor()) {
      // Apple Guideline 3.1.1: simple notification on mobile
      $q.notify({
        type: 'warning',
        message: t('noMinutesRemaining'),
        icon: 'schedule',
        timeout: 5000
      });
    } else {
      contactSalesReason.value = 'no_minutes';
      showContactSalesDialog.value = true;
    }
    return;
  }

  // Show low minutes warning if less than 5 minutes
  if (minutesStore.remainingMinutes < 5) {
    $q.notify({
      type: 'warning',
      message: t('minutesLimitWarning', { minutes: Math.round(minutesStore.remainingMinutes) }),
      icon: 'schedule',
      timeout: 4000
    });
  }

  // On Android, check microphone permission and try to get it before proceeding
  if (isAndroid() && availableMicrophones.value.length === 0) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      await loadMicrophones();
    } catch (err) {
      $q.notify({
        type: 'negative',
        message: t('micPermissionDenied'),
        icon: 'mic_off',
        timeout: 0,
        actions: [
          { label: t('openSettings'), color: 'white', handler: () => openAndroidAppSettings() },
          { label: t('dismiss'), color: 'white' }
        ]
      });
      return;
    }
  }

  // Check if no microphone and no system audio — cannot record
  if (availableMicrophones.value.length === 0 && !systemAudioEnabled.value) {
    $q.notify({
      type: 'warning',
      message: t('noMicrophoneNoSystemAudio'),
      icon: 'mic_off',
      timeout: 8000
    });
    return;
  }

  // Check if we should show storage dialog
  const savedPreference = historyStore.defaultStoragePreference;

  if (savedPreference) {
    currentStoragePreference.value = savedPreference;
    await doStartRecording();
  } else {
    showStorageDialog.value = true;
  }
};

const onSalesInquirySubmitted = () => {
  // Inquiry submitted successfully - dialog will close automatically
  console.log('Sales inquiry submitted');
};

const onStorageOptionConfirm = async ({ storagePreference }) => {
  currentStoragePreference.value = storagePreference;
  await doStartRecording();
};

const onStorageOptionCancel = () => {
  // Do nothing
};

const doStartRecording = async () => {
  // Double-start protection: also reachable via the storage-preference dialog
  // confirm, so it carries its own latch (a double-confirm or a confirm racing
  // a direct start must not run two starts).
  if (startInFlight.value) return;
  startInFlight.value = true;
  try {
    await doStartRecordingInternal();
  } finally {
    startInFlight.value = false;
  }
};

const doStartRecordingInternal = async () => {
  // Block start if recovery is in progress (FIX H)
  if (recordingStore.recoveryInProgress) {
    $q.notify({
      type: 'warning',
      message: 'Please wait — recovering a previous recording...',
      timeout: 3000
    });
    return;
  }

  const result = await startRecording();
  if (result.success) {
    // Add to history immediately so recording survives app kill
    await historyStore.addRecording({
      id: recordingStore.recordId,
      userId: authStore.user?.id || null,
      createdAt: new Date().toISOString(),
      duration: 0,
      fileSize: 0,
      filePath: null,
      uploadStatus: 'recording',
      storagePreference: currentStoragePreference.value
    });
  } else {
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

// Stop latch: the minutes-limit watcher and a user stop click can fire
// handleStop concurrently. The service dedups the underlying stop, but the
// post-stop flow here (history update + auto-upload) must also run only once.
const stopBusy = ref(false);

const handleStop = async () => {
  if (stopBusy.value) return;
  stopBusy.value = true;
  try {
    await handleStopInternal();
  } finally {
    stopBusy.value = false;
  }
};

const handleStopInternal = async () => {
  // Save duration before stopping
  recordingStore.setFinalDuration(recordingStore.duration);

  // Start processing
  recordingStore.phase = 'processing';
  recordingStore.uploadError =null;
  recordingStore.uploadRetryAttempt = 0;

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

      // Always prefer actual audio duration (from ffprobe/native) over JS timer
      if (result.duration) {
        recordingStore.setFinalDuration(result.duration);
      }

      // Get file info - platform specific
      if (isElectron()) {
        const fileInfo = await window.electronAPI.recording.getFilePath(recordingStore.recordId, '.webm');
        if (fileInfo.success) {
          recordingStore.audioFilePath =fileInfo.filePath;
          recordingStore.currentFileSize =fileInfo.fileSize;
        }
      } else if (isCapacitor()) {
        // On mobile, the file path and size come from the stop result
        if (result.filePath) {
          recordingStore.audioFilePath =result.filePath;
          recordingStore.currentFileSize =result.fileSize || 0;
        }
      }

      // Update existing history entry (created at recording start) with final details
      await historyStore.updateRecording(recordingStore.recordId, {
        duration: finalDuration.value,
        fileSize: currentFileSize.value,
        filePath: currentFilePath.value,
        uploadStatus: 'pending'
      });

      // Processing done, start auto-upload
      // phase transition handled by subsequent action (setUploading/setError/reset)
      await startAutoUpload();
    } else {
      // phase transition handled by subsequent action (setUploading/setError/reset)

      // Update existing history entry (created at recording start) to 'failed' status
      // Do NOT call addRecording — the entry already exists with uploadStatus 'recording'
      // Try to resolve the file path even on failure — the audio file may still exist
      let failedFilePath = null;
      if (isElectron()) {
        try {
          const fileInfo = await window.electronAPI.recording.getFilePath(recordingStore.recordId, '.webm');
          if (fileInfo.success) {
            failedFilePath = fileInfo.filePath;
            recordingStore.audioFilePath =fileInfo.filePath;
            recordingStore.currentFileSize =fileInfo.fileSize || 0;
          }
        } catch (e) { /* file doesn't exist yet */ }
      } else if (isCapacitor()) {
        // On mobile, check if a combined file exists despite the error
        try {
          const { exists: fileExists } = await import('../services/storage');
          const m4aExists = await fileExists(`recordings/${recordingStore.recordId}/combined.m4a`);
          const webmExists = !m4aExists && await fileExists(`recordings/${recordingStore.recordId}/combined.webm`);
          if (m4aExists || webmExists) {
            failedFilePath = `recordings/${recordingStore.recordId}/combined.${m4aExists ? 'm4a' : 'webm'}`;
            recordingStore.audioFilePath =failedFilePath;
          }
        } catch (e) { /* file doesn't exist */ }
      }

      await historyStore.updateRecording(recordingStore.recordId, {
        duration: finalDuration.value,
        filePath: failedFilePath,
        fileSize: currentFileSize.value || 0,
        uploadStatus: 'failed',
        uploadError: result.error || 'Failed to process recording',
        chunkCount: result.chunkCount || 0
      });

      // Disk full at finalize: the audio is intact on disk as chunks. Offer an
      // in-place retry (re-runs the combine via the recovery path) instead of
      // a dead-end error toast. If the user dismisses, launch recovery
      // combines the chunks automatically once space is freed.
      if (result.diskFull) {
        const mb = result.shortfallMB || result.neededMB || 200;
        $q.dialog({
          title: t('diskFullFinalizeTitle'),
          message: t('diskFullFinalizeMessage', { mb }),
          cancel: { flat: true, label: t('cancel') },
          ok: { color: 'primary', label: t('retry') },
          persistent: true
        }).onOk(() => handleStop());
      } else if (result.partialRecovery) {
        // Show more detailed error for partial recovery
        $q.notify({
          type: 'warning',
          message: 'Recording was interrupted. Your audio chunks are saved locally but could not be combined. Please try again from History.',
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
    // phase transition handled by subsequent action (setUploading/setError/reset)
    $q.notify({
      type: 'negative',
      message: error.message || 'Error processing recording'
    });
  }
};

const handleCancel = async () => {
  try {
    // Stop recording service (cleanup streams, timers) without combining chunks
    await cancelRecording();

    // Stop storage monitoring and lifecycle tracking
    stopStorageMonitor();
    setRecordingActive(false);

    const recordId = recordingStore.recordId;

    // Delete recording chunks from disk
    if (isElectron() && recordId) {
      try {
        await window.electronAPI.recording.deleteRecording(recordId);
      } catch (e) {
        console.warn('Failed to delete recording files:', e);
      }
    } else if (isCapacitor() && recordId) {
      try {
        const storage = await import('../services/storage');
        await storage.deleteDirectory(`recordings/${recordId}`);
      } catch (e) {
        console.warn('Failed to delete recording files:', e);
      }
    }

    // Remove from history
    if (recordId) {
      try {
        await historyStore.deleteRecording(recordId, true);
      } catch (e) {
        // Entry may not exist yet, that's ok
      }
    }

    // Reset all state
    recordingStore.reset();
    // phase transition handled by subsequent action (setUploading/setError/reset)
    // phase reset handled by store actions
    recordingStore.uploadError =null;
    recordingStore.uploadRetryAttempt = 0;
    recordingStore.audioFilePath ='';
    recordingStore.currentFileSize =0;

    $q.notify({
      type: 'info',
      message: t('recordingCancelled'),
      timeout: 3000
    });
  } catch (error) {
    console.error('Error cancelling recording:', error);
    // Force reset even on error
    recordingStore.reset();
    // phase transition handled by subsequent action (setUploading/setError/reset)
    // phase reset handled by store actions
  }
};

const startAutoUpload = async () => {
  // phase set to 'uploading' via setUploading()
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
        onProgress: (p, bytesUploaded, bytesTotal) => recordingStore.updateUploadProgress(p, bytesUploaded || 0, bytesTotal || 0),
        getAuthStore: () => authStore // Enable token refresh
      });
    } else {
      throw new Error('Unsupported platform');
    }

    // phase reset handled by store actions
    recordingStore.uploadRetryAttempt = 0;

    if (result.inProgress) {
      // Another driver (the persistent mobile queue) is uploading this exact
      // recording. A bare return would strand the page in phase 'uploading'
      // forever (blocking new recordings) and leave the file locked with no
      // completion owner. Hand off: watch the history entry — the queue
      // holder writes 'uploaded' on success — and converge the page state.
      $q.notify({
        type: 'info',
        message: t('uploadAlreadyInProgress'),
        timeout: 2500
      });
      watchBackgroundUpload(recordingStore.recordId);
      return;
    }

    if (result.success) {
      recordingStore.setUploaded(result.audioFileId);

      // Update history entry (already added before upload started)
      await historyStore.updateRecording(recordingStore.recordId, {
        uploadStatus: 'uploaded',
        transcriptionId: result.transcriptionId,
        audioFileId: result.audioFileId
      });

      // P0 Data Loss Fix: Only delete if upload was verified AND canDelete returns true
      // Schedule deletion after a safety delay — gives server time to persist
      if (currentStoragePreference.value === 'delete_after_upload') {
        if (result.canDelete && recordingStore.canDelete(recordingStore.recordId)) {
          const deleteRecordId = recordingStore.recordId;
          // Delay deletion by 30s to allow server to fully persist
          setTimeout(async () => {
            try {
              if (isElectron()) {
                await window.electronAPI.recording.deleteRecording(deleteRecordId);
              }
              await historyStore.updateRecording(deleteRecordId, { filePath: null });
              recordingStore.unlockFile(deleteRecordId);
            } catch (e) {
              console.warn('Delayed file deletion failed:', e);
            }
          }, 30000);
        } else {
          console.warn('File not deleted: upload not verified or file is locked');
        }
      }

      // P0 Data Loss Fix: Unlock file after successful upload
      recordingStore.unlockFile(recordingStore.recordId);

      // Reset session after successful upload
      transcriptionStore.resetSession();

      // Refresh minutes balance (server will deduct after transcription)
      // Use a slight delay to allow server to process
      setTimeout(() => {
        minutesStore.fetchMinutes(authStore.token, true).catch(err => {
          console.warn('Failed to refresh minutes after upload:', err);
        });
      }, 5000);

      $q.notify({
        type: 'positive',
        message: 'Recording uploaded successfully'
      });
    } else {
      // P0 Data Loss Fix: Keep file locked on failure - will be unlocked on retry or explicit delete
      handleUploadError(result.error);
    }
  } catch (error) {
    // phase reset handled by store actions
    handleUploadError(error.message);
  }
};

const handleUploadError = async (errorMessage) => {
  // Make "Insufficient minutes" error more user-friendly
  if (errorMessage && errorMessage.includes('Insufficient minutes')) {
    recordingStore.uploadError ='No recording minutes remaining. Please upgrade your plan or purchase more minutes at app.suisse-notes.ch';
    // Refresh minutes display
    const authStore = (await import('../stores/auth')).useAuthStore();
    const { useMinutesStore } = await import('../stores/minutes');
    const minutesStore = useMinutesStore();
    minutesStore.fetchMinutes(authStore.token, true);
  } else {
    recordingStore.uploadError =errorMessage;
  }

  // Update history entry as failed (already added before upload started)
  await historyStore.updateRecording(recordingStore.recordId, {
    uploadStatus: 'failed',
    uploadError: errorMessage
  });

  // Detect insufficient minutes errors BEFORE queuing for retry (would never succeed)
  const isMinutesError = errorMessage &&
    /insufficient|minutes|credit|balance/i.test(errorMessage);

  if (isMinutesError) {
    // Refresh minutes to update the header badge
    minutesStore.syncWithServer(authStore.token).catch(() => {});
    recordingStore.uploadError =t('insufficientMinutesUpload');
    $q.notify({
      type: 'warning',
      message: t('insufficientMinutesUpload'),
      icon: 'schedule',
      timeout: 8000
    });
    return;
  }

  // On mobile, add to persistent upload queue for automatic retry
  if (isCapacitor() && currentFilePath.value) {
    try {
      const { addToMobileUploadQueue } = await import('../services/upload');
      const options = transcriptionStore.transcriptionOptions;
      addToMobileUploadQueue(recordingStore.recordId, currentFilePath.value, {
        duration: finalDuration.value?.toString(),
        title: options.title,
        customVocabulary: options.customVocabulary
      });
    } catch (e) {
      console.warn('Could not add to mobile upload queue:', e);
    }
  }

  // Detect network errors and show reassuring message
  const isNetworkError = !navigator.onLine ||
    (errorMessage && /network|timeout|fetch|ERR_INTERNET|ENOTFOUND/i.test(errorMessage));

  if (isNetworkError) {
    $q.notify({
      type: 'warning',
      message: t('uploadFailedNoInternet'),
      icon: 'wifi_off',
      timeout: 8000
    });
  } else {
    $q.notify({
      type: 'negative',
      message: t('uploadFailedServer'),
      timeout: 5000
    });
  }
};

const retryUpload = async () => {
  isRetrying.value = true;
  recordingStore.uploadError =null;
  recordingStore.uploadRetryAttempt = 0;

  try {
    // Remove from history (will re-add based on result)
    await historyStore.deleteRecording(recordingStore.recordId, false);

    isRetrying.value = false;
    await startAutoUpload();
  } catch (error) {
    isRetrying.value = false;
    recordingStore.uploadError =error.message;
  }
};

const retryChunkCombine = async () => {
  recordingStore.phase = 'processing';
  recordingStore.error = null;
  recordingStore.phase = 'stopped';

  let result;
  if (isElectron()) {
    result = await window.electronAPI.recording.combineChunks(recordingStore.recordId, '.webm');
  } else if (isCapacitor()) {
    result = await recordingStore.combineChunksNative();
  } else {
    result = { success: false, error: 'Unsupported platform' };
  }

  if (result.success) {
    recordingStore.audioFilePath =result.outputPath;
    recordingStore.currentFileSize =result.fileSize || 0;
    // phase transition handled by subsequent action (setUploading/setError/reset)
    await startAutoUpload();
  } else {
    // phase transition handled by subsequent action (setUploading/setError/reset)
    recordingStore.error = humanizeStorageError({ message: result.error, code: result.code }, t);
    recordingStore.phase = 'error';
  }
};

// Clear auto-save timer helper
const clearAutoSaveTimer = () => {
  if (autoSaveTimer.value) {
    clearInterval(autoSaveTimer.value);
    autoSaveTimer.value = null;
    autoSaveCountdown.value = 0;
  }
};

// Manual save click - clear timer then save
const handleSaveDeadRecordingManual = () => {
  clearAutoSaveTimer();
  handleSaveDeadRecording();
};

// Handle saving a dead recording (interrupted)
const handleSaveDeadRecording = async () => {
  // Save duration before stopping
  recordingStore.setFinalDuration(recordingStore.duration);

  recordingStore.phase = 'processing';
  recordingStore.uploadError =null;

  try {
    const result = await stopRecording();

    if (result.success) {
      // Show recovery notification
      $q.notify({
        type: 'warning',
        message: result.warning || 'Recording recovered after interruption. Some audio at the end may be missing.',
        timeout: 8000
      });

      // Always prefer actual audio duration (from ffprobe/native) over JS timer
      if (result.duration) {
        recordingStore.setFinalDuration(result.duration);
      }

      // Get file info
      if (isElectron()) {
        const fileInfo = await window.electronAPI.recording.getFilePath(recordingStore.recordId, '.webm');
        if (fileInfo.success) {
          recordingStore.audioFilePath =fileInfo.filePath;
          recordingStore.currentFileSize =fileInfo.fileSize;
        }
      } else if (isCapacitor()) {
        if (result.filePath) {
          recordingStore.audioFilePath =result.filePath;
          recordingStore.currentFileSize =result.fileSize || 0;
        }
      }

      // Update existing history entry (created at recording start) with final details
      await historyStore.updateRecording(recordingStore.recordId, {
        duration: finalDuration.value,
        fileSize: currentFileSize.value,
        filePath: currentFilePath.value,
        uploadStatus: 'pending'
      });

      // phase transition handled by subsequent action (setUploading/setError/reset)
      await startAutoUpload();
    } else {
      // phase transition handled by subsequent action (setUploading/setError/reset)
      $q.notify({
        type: 'negative',
        message: result.error || 'Failed to save recording'
      });
    }
  } catch (error) {
    // phase transition handled by subsequent action (setUploading/setError/reset)
    $q.notify({
      type: 'negative',
      message: error.message || 'Error processing recording'
    });
  }
};

// Handle discarding a dead recording
const handleDiscardDeadRecording = () => {
  clearAutoSaveTimer();
  $q.dialog({
    title: t('discardRecording'),
    message: t('discardRecordingConfirm'),
    cancel: { flat: true, label: t('cancel') },
    ok: { color: 'negative', label: t('discardRecording') },
    persistent: true
  }).onOk(() => {
    recordingStore.reset();
    // phase transition handled by subsequent action (setUploading/setError/reset)
    // phase reset handled by store actions
    recordingStore.uploadError =null;
  });
};

const handleNewRecording = () => {
  recordingStore.reset();
  // phase transition handled by subsequent action (setUploading/setError/reset)
  // phase reset handled by store actions
  recordingStore.uploadError =null;
  recordingStore.uploadRetryAttempt = 0;
  recordingStore.audioFilePath ='';
  recordingStore.currentFileSize =0;
};

// "Start new while uploading" removed — pipeline is now linear.
// User must wait for upload to complete before starting a new recording.

const openInSuisseNotes = () => {
  if (currentAudioFileId.value) {
    openInBrowser(currentAudioFileId.value);
  }
};

const copyTranscriptUrl = () => {
  if (currentAudioFileId.value) {
    copyLink(currentAudioFileId.value);
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

// Discreet mobile "keep the app open" hint — fine, grey, borderless, unobtrusive.
.foreground-hint {
  text-align: center;
  font-size: 12px;
  color: #9ca3af;
  margin-top: 6px;
  letter-spacing: 0.2px;
  opacity: 0.85;
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

.system-audio-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-bottom: 12px;
  padding: 4px 12px;

  .indicator-text {
    font-size: 11px;
    color: #94a3b8;

    &.active {
      color: #16a34a;
    }
  }
}

.mic-switch-section {
  padding: 0 24px;
  margin-bottom: 8px;

  .mic-switch-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .mic-switch-select {
    flex: 1;
    min-width: 0;

    :deep(.q-field__control) {
      min-height: 28px;
      padding: 0 4px;
    }
    :deep(.q-field__native) {
      padding: 0;
    }
  }

  .mic-switch-text {
    font-size: 11px;
    color: #94a3b8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.timer-section {
  text-align: center;
  margin-bottom: 24px;
}

.level-section {
  margin-bottom: 24px;
  padding: 0 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mic-health-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.mic-health-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #475569;
}

.mic-health-message {
  font-size: 11px;
  color: #64748b;
}

.controls-section {
  text-align: center;
}

.warning-section {
  margin-top: 12px;

  .warning-banner {
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.2);
    color: #92400e;
  }
}

.health-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 24px;
  font-size: 11px;
  line-height: 1.3;

  span {
    opacity: 0.85;
  }

  &--critical {
    color: #b91c1c;
  }

  &--warning {
    color: #92400e;
  }
}

.recording-dead-alert {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 8px 0;

  .dead-alert-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 16px;
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-radius: 10px;

    .dead-alert-text {
      h3 {
        font-size: 15px;
        font-weight: 600;
        color: #ef4444;
        margin: 0 0 4px 0;
      }

      p {
        font-size: 12px;
        color: #64748b;
        margin: 0;
        line-height: 1.4;
      }
    }
  }

  .dead-chunks-info {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: rgba(245, 158, 11, 0.1);
    border-radius: 8px;
    font-size: 12px;
    color: #92400e;
  }

  .dead-timer {
    text-align: center;

    .timer-display.dead {
      font-size: 48px;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
      color: #ef4444;
      opacity: 0.7;
      letter-spacing: 2px;
    }

    .timer-stopped-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: #ef4444;
      letter-spacing: 2px;
      margin-top: 4px;
    }
  }

  .dead-actions {
    display: flex;
    justify-content: center;
    gap: 12px;
  }
}

.error-section {
  margin-top: 24px;

  .error-banner {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
  }
}

.error-card {
  padding: 36px 40px;
  margin-bottom: 32px;
  border-radius: 16px;
  border: 1px solid rgba(239, 68, 68, 0.2);

  @media (max-width: 600px) {
    padding: 24px 16px;
  }

  .error-card-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 12px;

    h3 {
      font-size: 16px;
      font-weight: 600;
      color: #1e293b;
      margin: 0;
    }

    p {
      font-size: 13px;
      color: #64748b;
      margin: 0;
    }

    .chunks-info {
      font-size: 12px;
      color: #f59e0b;
      padding: 6px 12px;
      background: rgba(245, 158, 11, 0.1);
      border-radius: 6px;
    }

    .error-card-actions {
      display: flex;
      gap: 12px;
      margin-top: 8px;
    }
  }
}

// Full-screen blocking overlay — prevents any interaction during processing/upload
.recording-pipeline-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(255, 255, 255, 0.97);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;

  // Reuse the card styling inside the overlay
  .upload-header,
  .upload-content,
  .upload-success {
    max-width: 520px;
    width: 100%;
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

@media (max-width: 600px) {
  .mic-section .section-label {
    font-size: 13px;
  }

  .mic-selected-text {
    font-size: 15px;
    max-width: 100%;
  }

  .system-audio-section {
    .system-audio-text {
      .label {
        font-size: 15px;
      }

      .description {
        font-size: 13px;
      }
    }

    .system-audio-active,
    .permission-notice {
      font-size: 13px;
    }
  }

  .card-header .status-text {
    font-size: 13px;
  }

  .system-audio-indicator .indicator-text {
    font-size: 13px;
  }

  .mic-health-label {
    font-size: 13px;
  }

  .mic-health-message {
    font-size: 12px;
  }

  .upload-content {
    .upload-progress-section {
      .progress-info {
        .progress-text {
          font-size: 14px;
        }

        .progress-percent {
          font-size: 14px;
        }
      }

      .progress-meta {
        font-size: 13px;
      }
    }

    .upload-note,
    .error-note {
      font-size: 13px;
    }
  }

  .upload-success .transcript-cta {
    .cta-title {
      font-size: 17px;
    }

    .cta-subtitle {
      font-size: 13px;
    }

    .main-cta-button {
      .button-text .button-label {
        font-size: 14px;
      }

      .button-text .button-hint {
        font-size: 12px;
      }
    }
  }

  .tips-header {
    font-size: 14px;
  }

  .tips-list {
    font-size: 13px;
  }

  .tips-contact {
    font-size: 13px;
  }

  .mic-select {
    :deep(.q-field__control) {
      min-height: 48px;
    }

    :deep(.q-field--dense .q-field__control) {
      height: 48px;
    }

    :deep(.q-field__native) {
      font-size: 16px;
    }
  }
}
</style>
