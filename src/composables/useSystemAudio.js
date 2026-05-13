import { ref } from 'vue';
import { isElectron } from '../utils/platform';

export function useSystemAudio() {
  const systemAudioEnabled = ref(false);
  const permissionStatus = ref('unknown'); // 'unknown' | 'granted' | 'denied' | 'unsupported'
  const systemAudioStream = ref(null);
  const error = ref(null);
  const isLoading = ref(false);
  const isSupported = ref(false);

  // Load initial state and check platform support
  const loadState = async () => {
    try {
      if (!isElectron()) {
        permissionStatus.value = 'unsupported';
        return;
      }

      const support = await window.electronAPI.systemAudio.isSupported();
      isSupported.value = support.supported;

      if (!support.supported) {
        permissionStatus.value = 'unsupported';
        return;
      }

      systemAudioEnabled.value = await window.electronAPI.systemAudio.getEnabled();

      if (support.platform === 'darwin') {
        // AudioTee uses "System Audio Recording" permission — can't pre-check, assume granted
        permissionStatus.value = 'granted';
      } else {
        // Windows: desktopCapturer — permission always granted
        permissionStatus.value = 'granted';
      }
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

  // Start system audio capture — platform-specific
  // offsetMs: recording-timeline offset at which capture begins (for mid-recording
  //           toggles on macOS, AudioTee pads the file with silence to align with
  //           the mic track at merge time). 0 when starting at recording start.
  const startCapture = async (recordId, offsetMs = 0) => {
    if (!systemAudioEnabled.value || !isSupported.value || !isElectron()) return null;

    isLoading.value = true;
    error.value = null;

    try {
      const support = await window.electronAPI.systemAudio.isSupported();

      if (support.platform === 'win32') {
        // Windows: use desktopCapturer via renderer-side getUserMedia
        return await startDesktopCapture();
      }

      // macOS: use AudioTee via main process
      const result = await window.electronAPI.systemAudio.start(recordId, offsetMs);
      if (!result.success) {
        error.value = result.error;
        if (result.error?.includes('permission') || result.error?.includes('denied')) {
          permissionStatus.value = 'denied';
        }
        return null;
      }
      console.log('System audio capture started via AudioTee');
      return true;
    } catch (e) {
      console.error('Error starting system audio capture:', e);
      error.value = e.message;
      return null;
    } finally {
      isLoading.value = false;
    }
  };

  // Windows: capture system audio via desktopCapturer + getUserMedia
  const startDesktopCapture = async () => {
    try {
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

      // Request system audio via getUserMedia with chromeMediaSource
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

      // Stop video tracks immediately — we only need audio
      stream.getVideoTracks().forEach(track => track.stop());

      if (stream.getAudioTracks().length === 0) {
        throw new Error('No audio tracks in system audio stream');
      }

      systemAudioStream.value = new MediaStream(stream.getAudioTracks());
      console.log('System audio captured via desktopCapturer');
      return systemAudioStream.value;
    } catch (e) {
      console.error('Error capturing system audio via desktopCapturer:', e);
      if (e.name === 'NotAllowedError') {
        permissionStatus.value = 'denied';
      }
      error.value = e.message;
      return null;
    }
  };

  // Stop system audio capture (called when recording stops)
  const stopCapture = async () => {
    // Stop desktopCapturer stream (Windows)
    if (systemAudioStream.value) {
      systemAudioStream.value.getTracks().forEach(track => track.stop());
      systemAudioStream.value = null;
    }
    // Stop AudioTee (macOS)
    if (isElectron()) {
      try {
        await window.electronAPI.systemAudio.stop();
      } catch (e) {
        console.warn('Error stopping system audio capture:', e);
      }
    }
  };

  // Legacy API compat — captureSystemAudio now delegates to startCapture
  const captureSystemAudio = async (recordId, offsetMs = 0) => {
    return startCapture(recordId, offsetMs);
  };

  return {
    systemAudioEnabled,
    permissionStatus,
    systemAudioStream,
    error,
    isLoading,
    isSupported,
    loadState,
    setEnabled,
    startCapture,
    stopCapture,
    captureSystemAudio
  };
}
