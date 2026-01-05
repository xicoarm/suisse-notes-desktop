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

    <!-- Recording State - Pause and Stop -->
    <div v-else-if="recordingStore.isRecording" class="q-gutter-sm">
      <q-btn
        round
        size="md"
        color="warning"
        icon="pause"
        @click="$emit('pause')"
        class="recording-active"
      >
        <q-tooltip>Pause</q-tooltip>
      </q-btn>

      <q-btn
        round
        size="md"
        color="dark"
        icon="stop"
        @click="confirmStop"
      >
        <q-tooltip>Stop Recording</q-tooltip>
      </q-btn>
    </div>

    <!-- Paused State - Resume and Stop -->
    <div v-else-if="recordingStore.isPaused" class="q-gutter-sm">
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
        @click="confirmStop"
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
  </div>
</template>

<script setup>
import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import { useRecordingStore } from '../stores/recording';

const $q = useQuasar();
const { t } = useI18n();
const recordingStore = useRecordingStore();

const emit = defineEmits(['start', 'pause', 'resume', 'stop']);

const confirmStop = () => {
  $q.dialog({
    title: t('stopRecordingTitle'),
    message: t('stopRecordingMessage'),
    ok: {
      label: t('endRecording'),
      color: 'negative',
      flat: false,
      unelevated: true
    },
    cancel: {
      label: t('continueRecording'),
      color: 'primary',
      flat: true
    },
    persistent: true
  }).onOk(() => {
    emit('stop');
  });
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
