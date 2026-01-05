import { ref, onUnmounted } from 'vue';

export function useSystemAudio() {
  const systemAudioEnabled = ref(false);
  const permissionStatus = ref('unknown');
  const systemAudioStream = ref(null);
  const error = ref(null);
  const isLoading = ref(false);

  // Load initial state from config
  const loadState = async () => {
    try {
      systemAudioEnabled.value = await window.electronAPI.systemAudio.getEnabled();
      permissionStatus.value = await window.electronAPI.systemAudio.checkPermission();
    } catch (e) {
      console.error('Error loading system audio state:', e);
    }
  };

  // Set enabled state and persist to config
  const setEnabled = async (enabled) => {
    try {
      await window.electronAPI.systemAudio.setEnabled(enabled);
      systemAudioEnabled.value = enabled;
      return true;
    } catch (e) {
      error.value = e.message;
      return false;
    }
  };

  // Capture system audio stream using desktopCapturer
  const captureSystemAudio = async () => {
    if (!systemAudioEnabled.value) return null;

    isLoading.value = true;
    error.value = null;

    try {
      // Get available sources from main process
      const sources = await window.electronAPI.systemAudio.getSources();

      if (!sources || sources.length === 0) {
        throw new Error('No audio sources available');
      }

      // Find a screen source (captures all system audio)
      const screenSource = sources.find(s =>
        s.id.startsWith('screen:') ||
        s.name === 'Entire Screen' ||
        s.name.includes('Screen')
      ) || sources[0];

      console.log('Using audio source:', screenSource.name, screenSource.id);

      // Request system audio via getUserMedia with chromeMediaSource
      // Note: desktopCapturer requires video constraints even for audio-only
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screenSource.id
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screenSource.id,
            maxWidth: 1,
            maxHeight: 1,
            maxFrameRate: 1
          }
        }
      });

      // Stop video tracks immediately - we only need audio
      stream.getVideoTracks().forEach(track => track.stop());

      // Check if we actually got audio tracks
      if (stream.getAudioTracks().length === 0) {
        throw new Error('No audio tracks in system audio stream');
      }

      // Create a new stream with only audio tracks
      systemAudioStream.value = new MediaStream(stream.getAudioTracks());
      console.log('System audio captured successfully');

      return systemAudioStream.value;

    } catch (e) {
      console.error('Error capturing system audio:', e);
      error.value = e.message;

      // Handle specific errors
      if (e.name === 'NotAllowedError') {
        permissionStatus.value = 'denied';
        error.value = 'Screen recording permission denied. Please enable in System Preferences.';
      }

      return null;
    } finally {
      isLoading.value = false;
    }
  };

  // Stop system audio capture and clean up
  const stopCapture = () => {
    if (systemAudioStream.value) {
      systemAudioStream.value.getTracks().forEach(track => track.stop());
      systemAudioStream.value = null;
    }
  };

  // Cleanup on component unmount
  onUnmounted(() => {
    stopCapture();
  });

  return {
    systemAudioEnabled,
    permissionStatus,
    systemAudioStream,
    error,
    isLoading,
    loadState,
    setEnabled,
    captureSystemAudio,
    stopCapture
  };
}
