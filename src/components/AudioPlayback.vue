<template>
  <div
    v-if="audioUrl"
    class="audio-player"
  >
    <div class="player-controls">
      <q-btn
        round
        flat
        :icon="isPlaying ? 'pause' : 'play_arrow'"
        color="primary"
        size="md"
        @click="togglePlay"
      />

      <div class="time-display">
        {{ formatTime(currentTime) }}
      </div>

      <q-slider
        v-model="progress"
        :min="0"
        :max="100"
        color="primary"
        thumb-size="12px"
        track-size="4px"
        @update:model-value="onSeek"
      />

      <div class="time-display">
        {{ formatTime(duration) }}
      </div>

      <q-btn
        round
        flat
        icon="volume_up"
        color="grey-7"
        size="sm"
        @click="toggleMute"
      >
        <q-tooltip>{{ isMuted ? t('unmuteTooltip') : t('muteTooltip') }}</q-tooltip>
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

  <div
    v-else-if="error"
    class="audio-player-error"
  >
    <q-icon
      name="error_outline"
      color="negative"
      size="sm"
    />
    <span>{{ error }}</span>
  </div>

  <div
    v-else-if="loading"
    class="audio-player-loading"
  >
    <q-spinner-dots
      color="primary"
      size="sm"
    />
    <span>{{ t('loadingAudio') }}</span>
  </div>
</template>

<script>
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { isElectron, isCapacitor } from '../utils/platform';
import { readFile, getFileUri } from '../services/storage';

export default {
  name: 'AudioPlayback',

  props: {
    filePath: {
      type: String,
      default: ''
    },
    fallbackDuration: {
      type: Number,
      default: 0
    }
  },

  setup(props) {
    const { t } = useI18n();
    const audioElement = ref(null);
    const audioUrl = ref('');
    const isPlaying = ref(false);
    const isMuted = ref(false);
    const currentTime = ref(0);
    const duration = ref(0);
    const progress = ref(0);
    const loading = ref(false);
    const error = ref(null);
    const probedDuration = ref(false);

    const loadAudio = async () => {
      if (!props.filePath) {
        error.value = 'No audio file available';
        return;
      }

      loading.value = true;
      error.value = null;

      try {
        if (isElectron()) {
          const result = await window.electronAPI.recording.getFileUrl(props.filePath);
          if (result.success) {
            audioUrl.value = result.url;
          } else {
            error.value = result.error || 'Could not load audio file';
          }
        } else if (isCapacitor()) {
          // Use native file URI so WKWebView handles decoding natively
          const uriResult = await getFileUri(props.filePath);
          if (uriResult.success) {
            const { Capacitor } = await import('@capacitor/core');
            audioUrl.value = Capacitor.convertFileSrc(uriResult.uri);
          } else {
            // Fallback to blob URL
            const result = await readFile(props.filePath);
            if (result.success) {
              const mimeType = props.filePath.endsWith('.opus') ? 'audio/ogg' : 'audio/webm';
              const blob = new Blob([result.data], { type: mimeType });
              audioUrl.value = URL.createObjectURL(blob);
            } else {
              error.value = result.error || 'Could not load audio file';
            }
          }
        } else {
          error.value = 'Audio playback not supported on this platform';
        }
      } catch (e) {
        error.value = e.message || 'Error loading audio';
      } finally {
        loading.value = false;
      }
    };

    const togglePlay = async () => {
      if (!audioElement.value) return;

      if (isPlaying.value) {
        audioElement.value.pause();
        isPlaying.value = false;
      } else {
        try {
          await audioElement.value.play();
          isPlaying.value = true;
        } catch (e) {
          console.warn('Audio playback failed:', e.message);
          if (e.name === 'NotSupportedError') {
            error.value = 'This audio format is not supported on your device';
          } else if (e.name !== 'AbortError') {
            error.value = 'Could not play audio';
          }
          isPlaying.value = false;
        }
      }
    };

    const toggleMute = () => {
      if (!audioElement.value) return;
      audioElement.value.muted = !audioElement.value.muted;
      isMuted.value = audioElement.value.muted;
    };

    const onTimeUpdate = () => {
      if (!audioElement.value) return;
      currentTime.value = audioElement.value.currentTime;
      if (isFinite(duration.value) && duration.value > 0) {
        progress.value = (currentTime.value / duration.value) * 100;
      }
    };

    // MediaRecorder WebM/Opus has no duration in EBML header → audio.duration = Infinity until we seek past the end, which forces a durationchange event with the real value.
    const probeInfiniteDuration = () => {
      const el = audioElement.value;
      if (!el || probedDuration.value) return;
      probedDuration.value = true;
      const onDurationChange = () => {
        if (isFinite(el.duration) && el.duration > 0) {
          duration.value = el.duration;
          el.removeEventListener('durationchange', onDurationChange);
          try { el.currentTime = 0; } catch (_) { /* ignore */ }
        }
      };
      el.addEventListener('durationchange', onDurationChange);
      try { el.currentTime = 1e101; } catch (_) { /* ignore */ }
    };

    const onLoadedMetadata = () => {
      if (!audioElement.value) return;
      const d = audioElement.value.duration;
      if (isFinite(d) && d > 0) {
        duration.value = d;
      } else {
        // Fall back to the stored duration so the user sees a real number,
        // and probe the actual stream duration in the background.
        duration.value = props.fallbackDuration || 0;
        probeInfiniteDuration();
      }
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
      if (!audioElement.value || !isFinite(duration.value) || duration.value === 0) return;
      const seekTime = (value / 100) * duration.value;
      if (!isFinite(seekTime)) return;
      audioElement.value.currentTime = seekTime;
    };

    const formatTime = (seconds) => {
      if (!seconds || !isFinite(seconds)) return '0:00';

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
      duration.value = 0;
      currentTime.value = 0;
      progress.value = 0;
      probedDuration.value = false;
      loadAudio();
    });

    onMounted(() => {
      loadAudio();
    });

    onUnmounted(() => {
      if (audioElement.value) {
        audioElement.value.pause();
      }
      // Revoke blob URL to free memory
      if (audioUrl.value && audioUrl.value.startsWith('blob:')) {
        URL.revokeObjectURL(audioUrl.value);
      }
    });

    return {
      t,
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
