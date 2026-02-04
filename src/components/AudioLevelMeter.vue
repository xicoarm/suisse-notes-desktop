<template>
  <div class="audio-level-container">
    <div class="audio-level-label text-caption text-grey q-mb-xs">
      {{ label }}
    </div>
    <div class="audio-level-meter">
      <div
        class="level-bar"
        :style="{ width: `${level}%` }"
        :class="levelClass"
      />
    </div>
    <div class="level-indicators">
      <span class="text-caption">Low</span>
      <span class="text-caption">Good</span>
      <span class="text-caption">High</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  level: {
    type: Number,
    default: 0
  },
  label: {
    type: String,
    default: 'Audio Level'
  }
});

const levelClass = computed(() => {
  if (props.level < 20) return 'level-low';
  if (props.level < 70) return 'level-good';
  return 'level-high';
});
</script>

<style scoped>
.audio-level-container {
  width: 100%;
  max-width: 400px;
  margin: 0 auto;
}

.audio-level-meter {
  height: 12px;
  background: #e0e0e0;
  border-radius: 6px;
  overflow: hidden;
}

.level-bar {
  height: 100%;
  border-radius: 6px;
  transition: width 0.1s ease-out, background-color 0.2s ease;
}

.level-low {
  background: linear-gradient(90deg, #9e9e9e, #bdbdbd);
}

.level-good {
  background: linear-gradient(90deg, #4caf50, #8bc34a);
}

.level-high {
  background: linear-gradient(90deg, #ff9800, #f44336);
}

.level-indicators {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  color: #9e9e9e;
}
</style>
