<template>
  <div class="audio-player" v-if="audioUrl">
    <div class="player-controls">
      <q-btn
        round
        flat
        :icon="isPlaying ? 'pause' : 'play_arrow'"
        color="primary"
        size="md"
        @click="togglePlay"
      />

      <div class="time-display">{{ formatTime(currentTime) }}</div>

      <q-slider
        v-model="progress"
        :min="0"
        :max="100"
        color="primary"
        thumb-size="12px"
        track-size="4px"
        @update:model-value="onSeek"
      />

      <div class="time-display">{{ formatTime(duration) }}</div>

      <q-btn
        round
        flat
        icon="volume_up"
        color="grey-7"
        size="sm"
        @click="toggleMute"
      >
        <q-tooltip>{{ isMuted ? 'Unmute' : 'Mute' }}</q-tooltip>
      </q-btn>
    </div>

    <audio
      ref="audioElement"
      :src="audioUrl"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onLoadedMetadata"
      @ended="onEnded"
      @error="onError"
    />
  </div>

  <div class="audio-player-error" v-else-if="error">
    <q-icon name="error_outline" color="negative" size="sm" />
    <span>{{ error }}</span>
  </div>

  <div class="audio-player-loading" v-else-if="loading">
    <q-spinner-dots color="primary" size="sm" />
    <span>Loading audio...</span>
  </div>
</template>

<script>
import { ref, watch, onMounted, onUnmounted } from 'vue';

export default {
  name: 'AudioPlayback',

  props: {
    filePath: {
      type: String,
      default: ''
    }
  },

  setup(props) {
    const audioElement = ref(null);
    const audioUrl = ref('');
    const isPlaying = ref(false);
    const isMuted = ref(false);
    const currentTime = ref(0);
    const duration = ref(0);
    const progress = ref(0);
    const loading = ref(false);
    const error = ref(null);

    const loadAudio = async () => {
      if (!props.filePath) {
        error.value = 'No audio file available';
        return;
      }

      loading.value = true;
      error.value = null;

      try {
        const result = await window.electronAPI.recording.getFileUrl(props.filePath);

        if (result.success) {
          audioUrl.value = result.url;
        } else {
          error.value = result.error || 'Could not load audio file';
        }
      } catch (e) {
        error.value = e.message || 'Error loading audio';
      } finally {
        loading.value = false;
      }
    };

    const togglePlay = () => {
      if (!audioElement.value) return;

      if (isPlaying.value) {
        audioElement.value.pause();
      } else {
        audioElement.value.play();
      }
      isPlaying.value = !isPlaying.value;
    };

    const toggleMute = () => {
      if (!audioElement.value) return;
      audioElement.value.muted = !audioElement.value.muted;
      isMuted.value = audioElement.value.muted;
    };

    const onTimeUpdate = () => {
      if (!audioElement.value) return;
      currentTime.value = audioElement.value.currentTime;
      if (duration.value > 0) {
        progress.value = (currentTime.value / duration.value) * 100;
      }
    };

    const onLoadedMetadata = () => {
      if (!audioElement.value) return;
      duration.value = audioElement.value.duration;
    };

    const onEnded = () => {
      isPlaying.value = false;
      progress.value = 0;
      currentTime.value = 0;
    };

    const onError = (e) => {
      console.error('Audio playback error:', e);
      error.value = 'Error playing audio file';
      isPlaying.value = false;
    };

    const onSeek = (value) => {
      if (!audioElement.value || duration.value === 0) return;
      const seekTime = (value / 100) * duration.value;
      audioElement.value.currentTime = seekTime;
    };

    const formatTime = (seconds) => {
      if (!seconds || isNaN(seconds)) return '0:00';

      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    // Watch for file path changes
    watch(() => props.filePath, () => {
      if (audioElement.value) {
        audioElement.value.pause();
        isPlaying.value = false;
      }
      loadAudio();
    });

    onMounted(() => {
      loadAudio();
    });

    onUnmounted(() => {
      if (audioElement.value) {
        audioElement.value.pause();
      }
    });

    return {
      audioElement,
      audioUrl,
      isPlaying,
      isMuted,
      currentTime,
      duration,
      progress,
      loading,
      error,
      togglePlay,
      toggleMute,
      onTimeUpdate,
      onLoadedMetadata,
      onEnded,
      onError,
      onSeek,
      formatTime
    };
  }
};
</script>

<style lang="scss" scoped>
.audio-player {
  background: #f8fafc;
  border-radius: 8px;
  padding: 12px 16px;

  .player-controls {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .time-display {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #64748b;
    min-width: 40px;
  }

  .q-slider {
    flex: 1;
  }

  audio {
    display: none;
  }
}

.audio-player-error,
.audio-player-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: #f8fafc;
  border-radius: 8px;
  font-size: 13px;
  color: #64748b;
}

.audio-player-error {
  color: #ef4444;
}
</style>
