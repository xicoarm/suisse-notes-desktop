<template>
  <div class="recording-controls">
    <!-- Idle State - Start Button -->
    <q-btn
      v-if="recordingStore.phase === 'idle'"
      round
      size="lg"
      color="negative"
      icon="mic"
      :loading="props.startBusy"
      :disable="props.startBusy"
      @click="$emit('start')"
    >
      <q-tooltip>{{ t('aboutStartRecording') }}</q-tooltip>
    </q-btn>

    <!-- Recording State - Mute, Pause and Stop -->
    <div
      v-else-if="recordingStore.isRecording"
      class="q-gutter-sm"
    >
      <q-btn
        round
        size="md"
        :color="props.isMicMuted ? 'negative' : 'grey-6'"
        :icon="props.isMicMuted ? 'mic_off' : 'mic'"
        @click="$emit('toggleMute')"
      >
        <q-tooltip>{{ props.isMicMuted ? t('unmuteMicrophone') : t('muteMicrophone') }}</q-tooltip>
      </q-btn>

      <q-btn
        round
        size="md"
        color="warning"
        icon="pause"
        class="recording-active"
        @click="$emit('pause')"
      >
        <q-tooltip>{{ t('pauseTooltip') }}</q-tooltip>
      </q-btn>

      <q-btn
        round
        size="md"
        color="dark"
        icon="stop"
        @click="showStopDialog = true"
      >
        <q-tooltip>{{ t('stopRecordingTooltip') }}</q-tooltip>
      </q-btn>
    </div>

    <!-- Paused State - Mute, Resume and Stop -->
    <div
      v-else-if="recordingStore.isPaused"
      class="q-gutter-sm"
    >
      <q-btn
        round
        size="md"
        :color="props.isMicMuted ? 'negative' : 'grey-6'"
        :icon="props.isMicMuted ? 'mic_off' : 'mic'"
        @click="$emit('toggleMute')"
      >
        <q-tooltip>{{ props.isMicMuted ? t('unmuteMicrophone') : t('muteMicrophone') }}</q-tooltip>
      </q-btn>

      <q-btn
        round
        size="md"
        color="positive"
        icon="play_arrow"
        @click="$emit('resume')"
      >
        <q-tooltip>{{ t('resumeTooltip') }}</q-tooltip>
      </q-btn>

      <q-btn
        round
        size="md"
        color="dark"
        icon="stop"
        @click="showStopDialog = true"
      >
        <q-tooltip>{{ t('stopRecordingTooltip') }}</q-tooltip>
      </q-btn>
    </div>

    <!-- Status indicator -->
    <div class="q-mt-sm text-center">
      <q-chip
        v-if="recordingStore.isRecording"
        color="negative"
        text-color="white"
        icon="fiber_manual_record"
        size="sm"
      >
        {{ t('statusRecording') }}
      </q-chip>
      <q-chip
        v-else-if="recordingStore.isPaused"
        color="warning"
        text-color="dark"
        icon="pause"
        size="sm"
      >
        {{ t('statusPaused') }}
      </q-chip>
    </div>

    <!-- Stop Recording Dialog -->
    <q-dialog
      v-model="showStopDialog"
      persistent
      position="bottom"
    >
      <q-card class="stop-dialog-card">
        <div class="stop-dialog-handle" />

        <div class="stop-dialog-title">
          {{ t('stopRecordingTitle') }}
        </div>

        <div class="stop-dialog-actions">
          <div
            class="stop-action-item action-primary"
            @click="handleEndRecording"
          >
            <div class="action-icon-wrap primary-bg">
              <q-icon
                name="cloud_upload"
                size="20px"
                color="white"
              />
            </div>
            <div class="action-content">
              <div class="action-label">
                {{ t('endRecording') }}
              </div>
              <div class="action-desc">
                {{ t('stopRecordingMessage') }}
              </div>
            </div>
            <q-icon
              name="chevron_right"
              size="20px"
              color="grey-5"
            />
          </div>

          <div
            class="stop-action-item"
            @click="showStopDialog = false"
          >
            <div class="action-icon-wrap continue-bg">
              <q-icon
                name="play_arrow"
                size="20px"
                color="white"
              />
            </div>
            <div class="action-content">
              <div class="action-label">
                {{ t('continueRecording') }}
              </div>
            </div>
          </div>

          <div class="stop-action-divider" />

          <div
            class="stop-action-item action-danger"
            @click="handleCancelClick"
          >
            <div class="action-icon-wrap danger-bg">
              <q-icon
                name="delete_outline"
                size="20px"
                color="white"
              />
            </div>
            <div class="action-content">
              <div class="action-label">
                {{ t('cancelAndDelete') }}
              </div>
            </div>
          </div>
        </div>
      </q-card>
    </q-dialog>

    <!-- Cancel Confirmation Dialog -->
    <q-dialog
      v-model="showCancelConfirm"
      persistent
    >
      <q-card style="min-width: 320px">
        <q-card-section>
          <div class="text-h6">
            {{ t('cancelRecordingTitle') }}
          </div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          {{ t('cancelRecordingMessage') }}
        </q-card-section>

        <q-card-actions
          align="right"
          class="q-px-md q-pb-md"
        >
          <q-btn
            flat
            :label="t('cancel')"
            color="primary"
            @click="showCancelConfirm = false"
          />
          <q-btn
            unelevated
            :label="t('confirmCancelAndDelete')"
            color="negative"
            icon="delete_forever"
            @click="handleConfirmCancel"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRecordingStore } from '../stores/recording';

const { t } = useI18n();
const recordingStore = useRecordingStore();

const showStopDialog = ref(false);
const showCancelConfirm = ref(false);

const props = defineProps({
  audioLevel: { type: Number, default: 0 },
  isMicMuted: { type: Boolean, default: false },
  // True while a start is in flight — the multi-second async window during
  // which a second click used to spawn a second recorder (double-audio bug).
  startBusy: { type: Boolean, default: false }
});

const emit = defineEmits(['start', 'pause', 'resume', 'stop', 'cancel', 'toggleMute']);

const handleEndRecording = () => {
  showStopDialog.value = false;
  emit('stop');
};

const handleCancelClick = () => {
  showStopDialog.value = false;
  showCancelConfirm.value = true;
};

const handleConfirmCancel = () => {
  showCancelConfirm.value = false;
  emit('cancel');
};
</script>

<style lang="scss" scoped>
.recording-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.recording-active {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(255, 152, 0, 0.4);
  }
  70% {
    box-shadow: 0 0 0 15px rgba(255, 152, 0, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255, 152, 0, 0);
  }
}

// Stop Recording Dialog — modern bottom sheet style
.stop-dialog-card {
  border-radius: 16px 16px 0 0;
  padding: 8px 0 16px;
  // Clear the Android nav bar / iOS home indicator so the last action
  // ("Cancel & Delete") isn't hidden behind the system bar. This bottom-sheet's
  // inner padding-bottom is locked to 0 by Quasar, and this scoped rule
  // out-specifies the generic app.scss fallback, so add the inset to the card's
  // own 16px here. --app-safe-area-bottom (app.scss :root) = env() on iOS,
  // --android-nav-bar-height on Android, 0 on desktop → no desktop change.
  padding-bottom: calc(16px + var(--app-safe-area-bottom, 0px));
  width: 100%;
  max-width: 480px;
}

.stop-dialog-handle {
  width: 36px;
  height: 4px;
  background: #d1d5db;
  border-radius: 2px;
  margin: 4px auto 12px;
}

.stop-dialog-title {
  font-size: 16px;
  font-weight: 600;
  color: #1e293b;
  padding: 0 20px 12px;
}

.stop-dialog-actions {
  padding: 0 12px;
}

.stop-action-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px;
  border-radius: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:hover {
    background: #f8fafc;
  }

  &:active {
    background: #f1f5f9;
  }

  &.action-primary {
    .action-label {
      font-weight: 600;
    }
  }

  &.action-danger {
    .action-label {
      color: #ef4444;
    }
  }
}

.action-icon-wrap {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;

  &.primary-bg {
    background: #6366f1;
  }

  &.continue-bg {
    background: #22c55e;
  }

  &.danger-bg {
    background: #ef4444;
  }
}

.action-content {
  flex: 1;
  min-width: 0;
}

.action-label {
  font-size: 14px;
  font-weight: 500;
  color: #1e293b;
}

.action-desc {
  font-size: 12px;
  color: #64748b;
  margin-top: 2px;
}

.stop-action-divider {
  height: 1px;
  background: #f1f5f9;
  margin: 4px 12px;
}
</style>
