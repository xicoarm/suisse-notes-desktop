import { ref } from 'vue';
import { isElectron } from '../utils/platform';

export function useSystemAudio() {
  const systemAudioEnabled = ref(false);
  const permissionStatus = ref('unknown'); // 'unknown' | 'granted' | 'denied' | 'unsupported'
  const systemAudioStream = ref(null); // kept for API compat — not used with AudioTee
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
      // AudioTee uses "System Audio Recording" permission — can't pre-check, assume granted
      permissionStatus.value = 'granted';
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

  // Start system audio capture (called when recording starts)
  const startCapture = async (recordId) => {
    if (!systemAudioEnabled.value || !isSupported.value || !isElectron()) return null;

    isLoading.value = true;
    error.value = null;

    try {
      const result = await window.electronAPI.systemAudio.start(recordId);
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

  // Stop system audio capture (called when recording stops)
  const stopCapture = async () => {
    if (!isElectron()) return;
    try {
      await window.electronAPI.systemAudio.stop();
    } catch (e) {
      console.warn('Error stopping system audio capture:', e);
    }
  };

  // Legacy API compat — captureSystemAudio now delegates to startCapture
  const captureSystemAudio = async (recordId) => {
    return startCapture(recordId);
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
