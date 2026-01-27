import { ref, onUnmounted, onMounted } from 'vue';
import { useRecordingStore } from '../stores/recording';
import { useAuthStore } from '../stores/auth';
import { useMinutesStore } from '../stores/minutes';
import { useSystemAudio } from './useSystemAudio';
import { isElectron } from '../utils/platform';
import * as recordingService from '../services/recordingService';

/**
 * Platform-aware recorder composable
 * Delegates to recordingService for persistence across navigation
 */
export function useRecorder() {
  const recordingStore = useRecordingStore();
  const authStore = useAuthStore();
  const minutesStore = useMinutesStore();

  // System audio composable (desktop only)
  let systemAudioEnabled = ref(false);
  let permissionStatus = ref('unknown');
  let captureSystemAudio = async () => null;
  let stopSystemAudio = () => {};
  let loadSystemAudioState = async () => {};
  let setSystemAudioEnabled = async () => {};

  if (isElectron()) {
    const systemAudio = useSystemAudio();
    systemAudioEnabled.value = systemAudio.systemAudioEnabled;
    permissionStatus.value = systemAudio.permissionStatus;
    captureSystemAudio = systemAudio.captureSystemAudio;
    stopSystemAudio = systemAudio.stopCapture;
    loadSystemAudioState = systemAudio.loadState;
    setSystemAudioEnabled = systemAudio.setEnabled;
  }

  // Reactive refs for UI binding (synced with service)
  const audioLevel = ref(0);
  const silenceWarning = ref(null);
  const isAutoSplitting = ref(false);

  // Minutes limit tracking
  const minutesLimitWarning = ref(null); // Number of minutes remaining when warning triggered
  const minutesLimitReached = ref(false); // True when limit reached during recording

  // Microphone selection
  const availableMicrophones = ref([]);
  const selectedMicrophoneId = ref('');
  const loadingMicrophones = ref(false);

  // Load available microphones
  const loadMicrophones = async () => {
    if (!navigator.mediaDevices) {
      console.warn('navigator.mediaDevices not available');
      return;
    }

    loadingMicrophones.value = true;
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => stream.getTracks().forEach(track => track.stop()));

      const devices = await navigator.mediaDevices.enumerateDevices();
      availableMicrophones.value = devices
        .filter(device => device.kind === 'audioinput')
        .map(device => ({
          id: device.deviceId,
          label: device.label || `Microphone ${device.deviceId.slice(0, 8)}...`
        }));

      if (availableMicrophones.value.length > 0 && !selectedMicrophoneId.value) {
        selectedMicrophoneId.value = availableMicrophones.value[0].id;
      }
    } catch (error) {
      console.error('Error loading microphones:', error);
    } finally {
      loadingMicrophones.value = false;
    }
  };

  // Event handlers for service events
  const handleLevelChange = (level) => {
    audioLevel.value = level;
  };

  const handleSilenceWarning = (warning) => {
    silenceWarning.value = warning;
  };

  const handleStateChange = (state) => {
    // State changes are handled by the store, just log for debugging
    console.log('Recording state changed:', state);
  };

  // Minutes limit event handlers
  const handleLimitWarning = (minutesRemaining) => {
    console.log(`Minutes limit warning: ${minutesRemaining} minutes remaining`);
    minutesLimitWarning.value = minutesRemaining;
  };

  const handleLimitReached = async () => {
    console.log('Minutes limit reached, stopping recording');
    minutesLimitReached.value = true;
    // Don't auto-stop here - let the UI component handle it
    // This allows for proper cleanup and showing the contact sales dialog
  };

  // Visibility change handler
  const handleVisibilityChange = async () => {
    const isHidden = document.hidden || document.visibilityState === 'hidden';

    if (isHidden && recordingStore.isRecording) {
      await recordingService.flushRecordingData();
    }
  };

  // Beforeunload handler
  const handleBeforeUnload = (event) => {
    if (recordingStore.isRecording || recordingStore.isPaused) {
      recordingService.flushRecordingData();
      event.preventDefault();
      event.returnValue = 'You have an active recording. Are you sure you want to leave?';
      return event.returnValue;
    }
  };

  // Start recording
  const startRecording = async (deviceId = null, maxRecordingSeconds = null) => {
    const micId = deviceId || selectedMicrophoneId.value;

    // Reset limit tracking state
    minutesLimitWarning.value = null;
    minutesLimitReached.value = false;

    // Use user's remaining minutes as max duration if not specified
    const maxSeconds = maxRecordingSeconds ?? minutesStore.remainingSeconds;

    return await recordingService.startRecording({
      recordingStore,
      authStore,
      deviceId: micId,
      systemAudioEnabled: systemAudioEnabled.value,
      captureSystemAudio,
      stopSystemAudio,
      isAutoSplitting,
      maxRecordingSeconds: maxSeconds > 0 ? maxSeconds : null
    });
  };

  // Pause recording
  const pauseRecording = () => {
    recordingService.pauseRecording(recordingStore);
  };

  // Resume recording
  const resumeRecording = () => {
    // Reset limit warning on resume (in case they paused after warning)
    minutesLimitWarning.value = null;
    minutesLimitReached.value = false;

    // Calculate remaining seconds based on already recorded duration
    const remainingMinutesSeconds = minutesStore.remainingSeconds;
    const alreadyRecorded = recordingStore.duration;
    const maxSeconds = remainingMinutesSeconds > 0 ? remainingMinutesSeconds + alreadyRecorded : null;

    recordingService.resumeRecording(recordingStore, isAutoSplitting, maxSeconds);
  };

  // Stop recording
  const stopRecording = async () => {
    return await recordingService.stopRecording(recordingStore, stopSystemAudio);
  };

  // Setup on mount
  onMounted(() => {
    // Subscribe to service events
    recordingService.addEventListener('levelChange', handleLevelChange);
    recordingService.addEventListener('silenceWarning', handleSilenceWarning);
    recordingService.addEventListener('stateChange', handleStateChange);
    recordingService.addEventListener('limitWarning', handleLimitWarning);
    recordingService.addEventListener('limitReached', handleLimitReached);

    // Set up visibility and beforeunload handlers
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Sync with current service state (for navigation back to page)
    const state = recordingService.getState();
    audioLevel.value = state.audioLevel;
    silenceWarning.value = state.silenceWarning;

    // Set up device change listener
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', loadMicrophones);
    }

    // Set up suspend/resume handlers (Electron only)
    if (window.electronAPI && window.electronAPI.system) {
      window.electronAPI.system.onSuspend(async () => {
        if (recordingStore.isRecording) {
          await recordingService.flushRecordingData();
        }
      });

      window.electronAPI.system.onResume(async (data) => {
        if (data.needsRecovery && recordingStore.isRecording) {
          silenceWarning.value = 'Recording resumed after system sleep - please check audio is working';
          setTimeout(() => {
            if (audioLevel.value > 1) {
              silenceWarning.value = null;
            }
          }, 5000);
        }
      });
    }
  });

  // Cleanup on unmount - DO NOT stop recording, only remove listeners
  onUnmounted(() => {
    // Remove event listeners from service
    recordingService.removeEventListener('levelChange', handleLevelChange);
    recordingService.removeEventListener('silenceWarning', handleSilenceWarning);
    recordingService.removeEventListener('stateChange', handleStateChange);
    recordingService.removeEventListener('limitWarning', handleLimitWarning);
    recordingService.removeEventListener('limitReached', handleLimitReached);

    // Remove visibility and beforeunload handlers
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('beforeunload', handleBeforeUnload);

    // Remove device change listener
    if (navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener('devicechange', loadMicrophones);
    }

    // Remove system event listeners (but don't stop recording!)
    if (window.electronAPI && window.electronAPI.system) {
      window.electronAPI.system.removeAllListeners();
    }

    // NOTE: We intentionally do NOT stop the recording here
    // The recording service persists across navigation
  });

  return {
    audioLevel,
    availableMicrophones,
    selectedMicrophoneId,
    loadingMicrophones,
    systemAudioEnabled,
    systemAudioPermissionStatus: permissionStatus,
    silenceWarning,
    minutesLimitWarning,
    minutesLimitReached,
    minutesStore,
    setSystemAudioEnabled,
    loadMicrophones,
    loadSystemAudioState,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording
  };
}
