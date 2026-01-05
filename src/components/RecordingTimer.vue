<template>
  <div class="recording-timer">
    <div class="timer-display" :class="{ 'text-negative': recordingStore.isRecording }">
      {{ recordingStore.formattedDuration }}
    </div>
    <div class="text-caption text-grey q-mt-sm" v-if="recordingStore.isRecording || recordingStore.isPaused">
      {{ formatDurationText }}
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRecordingStore } from '../stores/recording';

const recordingStore = useRecordingStore();

const formatDurationText = computed(() => {
  const duration = recordingStore.duration;
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);

  if (hours > 0) {
    return `${hours} hour${hours > 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
  } else if (minutes > 0) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  } else {
    return `${duration} second${duration !== 1 ? 's' : ''}`;
  }
});
</script>

<style scoped>
.recording-timer {
  text-align: center;
}

.timer-display {
  font-size: 56px;
  font-weight: 300;
  font-family: 'Roboto Mono', 'Courier New', monospace;
  letter-spacing: 4px;
  line-height: 1;
}

.text-negative {
  color: #c10015;
}
</style>
