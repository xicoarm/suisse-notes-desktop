/**
 * Native mobile recorder composable
 * Uses Capacitor plugins for background recording on iOS and Android
 */

import { ref, onUnmounted, onMounted } from 'vue';
import { useRecordingStore } from '../stores/recording';
import { isIOS, isAndroid, isCapacitor } from '../utils/platform';

// Lazy load Capacitor plugins
let BackgroundRecording = null;

/**
 * Initialize native recording plugin
 */
const initNativePlugin = async () => {
  if (!isCapacitor() || BackgroundRecording) return;

  try {
    // Import the plugin - it should be registered in the native code
    const { registerPlugin } = await import('@capacitor/core');
    BackgroundRecording = registerPlugin('BackgroundRecording');

    // Add event listeners
    if (BackgroundRecording.addListener) {
      BackgroundRecording.addListener('chunkStarted', (data) => {
        console.log('Native chunk started:', data);
      });

      BackgroundRecording.addListener('interrupted', (data) => {
        console.log('Recording interrupted:', data);
      });

      BackgroundRecording.addListener('resumed', () => {
        console.log('Recording resumed');
      });

      BackgroundRecording.addListener('error', (data) => {
        console.error('Native recording error:', data);
      });
    }

    console.log('Native recording plugin initialized');
  } catch (error) {
    console.error('Failed to initialize native recording plugin:', error);
  }
};

export function useNativeRecorder() {
  const recordingStore = useRecordingStore();

  const audioLevel = ref(0);
  const durationInterval = ref(null);
  const isNativeRecording = ref(false);

  // Auto-split configuration (same as desktop)
  const MAX_DURATION_SECONDS = 4 * 60 * 60 + 55 * 60; // 4h 55m
  const isAutoSplitting = ref(false);

  // Duration tracking
  const startDurationTracking = () => {
    const startTime = Date.now();

    durationInterval.value = setInterval(async () => {
      if (recordingStore.isRecording) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        recordingStore.updateDuration(elapsed);

        // Check for auto-split
        if (elapsed >= MAX_DURATION_SECONDS && !isAutoSplitting.value) {
          await performAutoSplit();
        }
      }
    }, 1000);
  };

  const stopDurationTracking = () => {
    if (durationInterval.value) {
      clearInterval(durationInterval.value);
      durationInterval.value = null;
    }
  };

  // Auto-split function
  const performAutoSplit = async () => {
    if (isAutoSplitting.value) return;
    isAutoSplitting.value = true;

    console.log('Auto-split triggered at 4h 55m, creating session file...');

    try {
      const result = await recordingStore.createSessionFile();
      if (!result.success) {
        console.error('Auto-split: Failed to create session file:', result.error);
      } else {
        console.log('Auto-split: Session file created successfully');
      }

      recordingStore.resetChunkIndex();
      console.log('Auto-split complete, continuing recording...');
    } catch (error) {
      console.error('Error during auto-split:', error);
    } finally {
      isAutoSplitting.value = false;
    }
  };

  // Start native recording
  const startRecording = async () => {
    try {
      await initNativePlugin();

      if (!BackgroundRecording) {
        throw new Error('Native recording plugin not available');
      }

      // Start the recording session in the store
      const sessionResult = await recordingStore.startRecording();
      if (!sessionResult.success) {
        throw new Error(sessionResult.error || 'Failed to create recording session');
      }

      // Start native recording
      const result = await BackgroundRecording.startRecording({
        recordId: recordingStore.recordId
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to start native recording');
      }

      isNativeRecording.value = true;
      startDurationTracking();

      return { success: true };
    } catch (error) {
      console.error('Error starting native recording:', error);
      recordingStore.setError(error.message);
      return { success: false, error: error.message };
    }
  };

  // Pause recording
  const pauseRecording = async () => {
    if (!isNativeRecording.value) return;

    try {
      if (BackgroundRecording) {
        await BackgroundRecording.pauseRecording();
      }
      recordingStore.pauseRecording();
      stopDurationTracking();
    } catch (error) {
      console.error('Error pausing recording:', error);
    }
  };

  // Resume recording
  const resumeRecording = async () => {
    if (!isNativeRecording.value) return;

    try {
      if (BackgroundRecording) {
        await BackgroundRecording.resumeRecording();
      }
      recordingStore.resumeRecording();

      // Continue duration tracking
      const currentDuration = recordingStore.duration;
      const resumeTime = Date.now();

      durationInterval.value = setInterval(() => {
        if (recordingStore.isRecording) {
          const elapsed = Math.floor((Date.now() - resumeTime) / 1000);
          recordingStore.updateDuration(currentDuration + elapsed);
        }
      }, 1000);
    } catch (error) {
      console.error('Error resuming recording:', error);
    }
  };

  // Stop recording
  const stopRecording = async () => {
    // P0 Data Loss Fix: Handle case where native recording state was lost but chunks exist
    if (!isNativeRecording.value) {
      // Check if we have a recording session with saved chunks
      if (recordingStore.recordId && recordingStore.chunkIndex > 0) {
        console.warn('Native recording state lost but chunks exist - attempting recovery');

        stopDurationTracking();

        // Try to stop native recording anyway in case it's still running
        if (BackgroundRecording) {
          try {
            await BackgroundRecording.stopRecording();
          } catch (e) {
            console.log('Native recording already stopped or unavailable');
          }
        }

        // Attempt to combine existing chunks
        console.log('Attempting to combine', recordingStore.chunkIndex, 'saved chunks...');
        const result = await recordingStore.stopRecording();

        if (result.success) {
          console.log('Recovery successful - recording saved');
          return {
            success: true,
            filePath: result.filePath,
            warning: 'Recording recovered after interruption. Some audio may be missing.',
            recovered: true
          };
        } else {
          console.error('Recovery failed:', result.error);
          return {
            success: false,
            error: 'Recording interrupted. ' + (result.error || 'Could not recover audio file.'),
            partialRecovery: recordingStore.chunkIndex > 0
          };
        }
      }

      return { success: false, error: 'No active recording' };
    }

    try {
      // Stop native recording
      if (BackgroundRecording) {
        const nativeResult = await BackgroundRecording.stopRecording();
        console.log('Native recording stopped:', nativeResult);
      }

      stopDurationTracking();
      isNativeRecording.value = false;

      // Stop in store (will combine chunks)
      const result = await recordingStore.stopRecording();
      return result;
    } catch (error) {
      console.error('Error stopping native recording:', error);
      return { success: false, error: error.message };
    }
  };

  // Get recording status from native
  const getStatus = async () => {
    if (!BackgroundRecording) {
      return { isRecording: false, chunkIndex: 0 };
    }

    try {
      return await BackgroundRecording.getStatus();
    } catch (error) {
      console.error('Error getting native status:', error);
      return { isRecording: false, chunkIndex: 0 };
    }
  };

  // === P0 Data Loss Prevention: Visibility and App State Handling ===

  // Track app visibility state for recovery
  const wasRecordingBeforeHidden = ref(false);
  let visibilityHandler = null;

  // Handle page visibility changes (app going to background/foreground)
  const handleVisibilityChange = async () => {
    const isHidden = document.hidden || document.visibilityState === 'hidden';

    if (isHidden) {
      console.log('App visibility: hidden');

      if (isNativeRecording.value || recordingStore.isRecording) {
        wasRecordingBeforeHidden.value = true;
        console.log('Recording active when app went to background');
      }
    } else {
      console.log('App visibility: visible');

      if (wasRecordingBeforeHidden.value) {
        // Check if native recording is still active
        try {
          const status = await getStatus();
          console.log('Native recording status after resume:', status);

          if (!status.isRecording && recordingStore.isRecording) {
            // Native recording stopped but store says recording
            console.warn('Native recording stopped while app was in background');

            // Check if we have chunks
            const chunkCount = recordingStore.chunkIndex;
            if (chunkCount > 0) {
              console.log('Have', chunkCount, 'chunks saved - recovery possible');
            }
          }
        } catch (e) {
          console.error('Error checking recording status after resume:', e);
        }

        wasRecordingBeforeHidden.value = false;
      }
    }
  };

  // Cleanup on unmount
  onUnmounted(() => {
    stopDurationTracking();

    // Remove visibility listener
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler);
    }
  });

  // Initialize on mount
  onMounted(async () => {
    await initNativePlugin();

    // Set up visibility handler
    visibilityHandler = handleVisibilityChange;
    document.addEventListener('visibilitychange', visibilityHandler);
  });

  return {
    audioLevel, // Placeholder - native doesn't expose audio levels easily
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    getStatus,
    isNativeRecording
  };
}

/**
 * Factory function to get the appropriate recorder for the platform
 */
export function getNativeRecorderForPlatform() {
  if (isIOS()) {
    return {
      type: 'ios',
      recorder: useNativeRecorder
    };
  }

  if (isAndroid()) {
    return {
      type: 'android',
      recorder: useNativeRecorder
    };
  }

  return null;
}
