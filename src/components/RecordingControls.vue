<template>
  <div class="recording-controls">
    <!-- Idle State - Start Button -->
    <q-btn
      v-if="recordingStore.status === 'idle'"
      round
      size="lg"
      color="negative"
      icon="mic"
      @click="$emit('start')"
    >
      <q-tooltip>Start Recording</q-tooltip>
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
        <q-tooltip>{{ props.isMicMuted ? 'Unmute Microphone' : 'Mute Microphone' }}</q-tooltip>
      </q-btn>

      <q-btn
        round
        size="md"
        color="warning"
        icon="pause"
        class="recording-active"
        @click="$emit('pause')"
      >
        <q-tooltip>Pause</q-tooltip>
      </q-btn>

      <q-btn
        round
        size="md"
        color="dark"
        icon="stop"
        @click="showStopDialog = true"
      >
        <q-tooltip>Stop Recording</q-tooltip>
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
        <q-tooltip>{{ props.isMicMuted ? 'Unmute Microphone' : 'Mute Microphone' }}</q-tooltip>
      </q-btn>

      <q-btn
        round
        size="md"
        color="positive"
        icon="play_arrow"
        @click="$emit('resume')"
      >
        <q-tooltip>Resume</q-tooltip>
      </q-btn>

      <q-btn
        round
        size="md"
        color="dark"
        icon="stop"
        @click="showStopDialog = true"
      >
        <q-tooltip>Stop Recording</q-tooltip>
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
        Recording
      </q-chip>
      <q-chip
        v-else-if="recordingStore.isPaused"
        color="warning"
        text-color="dark"
        icon="pause"
        size="sm"
      >
        Paused
      </q-chip>
    </div>

    <!-- Stop Recording Dialog -->
    <q-dialog
      v-model="showStopDialog"
      persistent
    >
      <q-card style="min-width: 320px">
        <q-card-section>
          <div class="text-h6">
            {{ t('stopRecordingTitle') }}
          </div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          {{ t('stopRecordingMessage') }}
        </q-card-section>

        <q-card-actions
          align="right"
          class="q-px-md q-pb-md"
        >
          <q-btn
            flat
            :label="t('continueRecording')"
            color="primary"
            @click="showStopDialog = false"
          />
          <q-btn
            unelevated
            :label="t('endRecording')"
            color="primary"
            @click="handleEndRecording"
          />
          <q-btn
            flat
            :label="t('cancelAndDelete')"
            color="negative"
            icon="delete_forever"
            @click="handleCancelClick"
          />
        </q-card-actions>
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
  isMicMuted: { type: Boolean, default: false }
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

<style scoped>
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
</style>
