/**
 * Native mobile recorder composable
 * Uses Capacitor plugins for background recording on iOS and Android
 */

import { ref, onUnmounted, onMounted } from 'vue';
import { useRecordingStore } from '../stores/recording';
import { useAuthStore } from '../stores/auth';
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

    console.log('Native recording plugin initialized');
  } catch (error) {
    console.error('Failed to initialize native recording plugin:', error);
  }
};

export function useNativeRecorder() {
  const recordingStore = useRecordingStore();
  const authStore = useAuthStore();

  const audioLevel = ref(0);
  const durationInterval = ref(null);
  const isNativeRecording = ref(false);

  // Auto-split configuration (same as desktop)
  const MAX_DURATION_SECONDS = 4 * 60 * 60 + 55 * 60; // 4h 55m
  const isAutoSplitting = ref(false);

  // Health check state
  let healthCheckInterval = null;
  let interruptedTimeout = null;
  let recordingDeadHandled = false;
  let healthCheckTick = 0;
  let pluginListeners = [];

  // Duration tracking
  const startDurationTracking = () => {
    const startTime = Date.now();

    durationInterval.value = setInterval(async () => {
      if (recordingStore.isRecording && !recordingStore.recordingInterrupted) {
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

  // Health check polling
  const startHealthCheck = () => {
    stopHealthCheck();
    recordingDeadHandled = false;

    healthCheckTick = 0;
    healthCheckInterval = setInterval(async () => {
      if (!isNativeRecording.value || recordingDeadHandled) return;

      healthCheckTick++;

      try {
        const status = await BackgroundRecording.getStatus();

        // Fix 2: Sync native chunk count to store (native writes chunks directly, bypassing store)
        if (status.chunkIndex > recordingStore.chunkIndex) {
          recordingStore.chunkIndex = status.chunkIndex;
        }

        // Check if native recorder has stopped
        if (!status.isRecording && !status.isRecorderActive) {
          console.warn('Health check: native recording is dead');
          handleRecordingDeath({
            reason: 'health_check_native_dead',
            chunkCount: status.chunkIndex || recordingStore.chunkIndex,
            lastChunkTimestamp: status.lastChunkTimestampMs || null
          });
          return;
        }

        // Check for stale chunks (>15s since last chunk rotation)
        if (status.secondsSinceLastChunk > 15) {
          console.warn('Health check: chunks stale for', status.secondsSinceLastChunk, 'seconds');
          handleRecordingDeath({
            reason: 'chunks_stale',
            chunkCount: status.chunkIndex || recordingStore.chunkIndex,
            lastChunkTimestamp: status.lastChunkTimestampMs || null
          });
          return;
        }

        // Fix 3: Periodic metadata flush every ~30s (every 10th health check tick)
        if (healthCheckTick % 10 === 0 && recordingStore.phase === 'recording') {
          recordingStore.flushCurrentState().catch(e =>
            console.warn('Periodic metadata flush failed:', e)
          );
        }
      } catch (e) {
        console.error('Health check error:', e);
      }
    }, 3000);
  };

  const stopHealthCheck = () => {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
    if (interruptedTimeout) {
      clearTimeout(interruptedTimeout);
      interruptedTimeout = null;
    }
  };

  // Handle recording death
  const handleRecordingDeath = (data = {}) => {
    if (recordingDeadHandled) return; // Prevent duplicate handling
    recordingDeadHandled = true;

    console.warn('Recording death detected:', data.reason);

    // Stop timers
    stopDurationTracking();
    stopHealthCheck();

    // Update local state
    isNativeRecording.value = false;

    // Notify store
    recordingStore.handleRecordingDeath({
      reason: data.reason || 'unknown',
      chunkCount: data.chunkCount || recordingStore.chunkIndex,
      lastChunkTimestamp: data.lastChunkTimestampMs || data.lastChunkTimestamp || null
    });
  };

  // Set up native plugin event listeners
  const setupPluginListeners = () => {
    if (!BackgroundRecording || !BackgroundRecording.addListener) return;

    // Recording dead event from native
    const deadListener = BackgroundRecording.addListener('recordingDead', (data) => {
      console.log('Native recordingDead event:', data);
      handleRecordingDeath(data);
    });
    if (deadListener) pluginListeners.push(deadListener);

    // Chunk started
    const chunkListener = BackgroundRecording.addListener('chunkStarted', (data) => {
      console.log('Native chunk started:', data);
    });
    if (chunkListener) pluginListeners.push(chunkListener);

    // Interrupted - if not resumed within 5s, treat as death
    const interruptedListener = BackgroundRecording.addListener('interrupted', (data) => {
      console.log('Recording interrupted:', data);

      // Clear any existing timeout
      if (interruptedTimeout) clearTimeout(interruptedTimeout);

      // Give 5 seconds for the interruption to resolve (e.g., phone call ends)
      interruptedTimeout = setTimeout(() => {
        if (!isNativeRecording.value || recordingDeadHandled) return;

        // Check if recorder actually resumed
        BackgroundRecording.getStatus().then(status => {
          if (!status.isRecording && !status.isRecorderActive) {
            handleRecordingDeath({
              reason: 'interruption_not_resumed',
              chunkCount: status.chunkIndex || recordingStore.chunkIndex,
              lastChunkTimestamp: status.lastChunkTimestampMs || null
            });
          }
        }).catch(() => {
          // Can't check status - assume dead
          handleRecordingDeath({ reason: 'interruption_status_check_failed' });
        });
      }, 5000);
    });
    if (interruptedListener) pluginListeners.push(interruptedListener);

    // Resumed - clear the interrupted timeout
    const resumedListener = BackgroundRecording.addListener('resumed', () => {
      console.log('Recording resumed');
      if (interruptedTimeout) {
        clearTimeout(interruptedTimeout);
        interruptedTimeout = null;
      }
    });
    if (resumedListener) pluginListeners.push(resumedListener);

    // Error
    const errorListener = BackgroundRecording.addListener('error', (data) => {
      console.error('Native recording error:', data);
    });
    if (errorListener) pluginListeners.push(errorListener);
  };

  // Clean up plugin listeners
  const cleanupPluginListeners = () => {
    pluginListeners.forEach(listener => {
      if (listener && typeof listener.remove === 'function') {
        listener.remove();
      }
    });
    pluginListeners = [];
  };

  // Auto-split function
  const performAutoSplit = async () => {
    if (isAutoSplitting.value) return;
    isAutoSplitting.value = true;

    console.log('Auto-split triggered at 4h 55m, creating session file...');

    try {
      // P1 Fix: Pause native recording to prevent chunk writes during transition.
      // Without this, the native plugin continues writing chunks while we flush
      // metadata and reset indices, causing inconsistent state.
      if (BackgroundRecording) {
        try {
          await BackgroundRecording.pauseRecording();
        } catch (e) {
          console.warn('Auto-split: Could not pause native recording:', e);
        }

        // Sync latest chunk index from native before flushing
        try {
          const status = await BackgroundRecording.getStatus();
          if (status.chunkIndex > recordingStore.chunkIndex) {
            recordingStore.chunkIndex = status.chunkIndex;
          }
        } catch (e) {
          console.warn('Auto-split: Could not sync chunk index:', e);
        }
      }

      const result = await recordingStore.createSessionFile();
      if (!result.success) {
        console.error('Auto-split: Failed to create session file:', result.error);
      } else {
        console.log('Auto-split: Session file created successfully');
      }

      recordingStore.resetChunkIndex();
      console.log('Auto-split complete, resuming recording...');

      // Resume native recording after transition is complete
      if (BackgroundRecording) {
        try {
          await BackgroundRecording.resumeRecording();
        } catch (e) {
          console.error('Auto-split: Failed to resume native recording:', e);
        }
      }
    } catch (error) {
      console.error('Error during auto-split:', error);
      // Best-effort resume on error
      if (BackgroundRecording) {
        try { await BackgroundRecording.resumeRecording(); } catch (e) { /* ignore */ }
      }
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

      // On Android, request battery optimization exemption so the recording
      // keeps running in the background without being killed by the OS.
      if (isAndroid()) {
        try {
          const batteryStatus = await BackgroundRecording.isBatteryOptimized();
          if (batteryStatus.isOptimized) {
            await BackgroundRecording.requestBatteryOptimizationExemption();
          }
        } catch (e) {
          console.warn('Battery optimization check failed (non-critical):', e);
        }
      }

      // Set up event listeners before starting
      setupPluginListeners();

      // Get userId from authStore for multi-account handling
      const userId = authStore?.user?.id || null;

      // Start the recording session in the store (pass userId for multi-account handling)
      const sessionResult = await recordingStore.startRecording(userId);
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
      recordingDeadHandled = false;
      startDurationTracking();
      startHealthCheck();

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
      // Keep health check running during pause to detect death
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
        if (recordingStore.isRecording && !recordingStore.recordingInterrupted) {
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
    // P2 Fix: Refresh native state before stop to avoid relying on stale 3s health check
    if (isNativeRecording.value && BackgroundRecording) {
      try {
        const freshStatus = await BackgroundRecording.getStatus();
        if (!freshStatus.isRecording && !freshStatus.isRecorderActive) {
          console.warn('Stop: native recording already dead (detected on fresh check)');
          isNativeRecording.value = false;
        }
        // Sync latest chunk index
        if (freshStatus.chunkIndex > recordingStore.chunkIndex) {
          recordingStore.chunkIndex = freshStatus.chunkIndex;
        }
      } catch (e) {
        console.warn('Stop: could not query native status:', e);
      }
    }

    // P0 Data Loss Fix: Handle case where native recording state was lost but chunks exist on disk
    if (!isNativeRecording.value) {
      if (recordingStore.recordId) {
        // Native recording writes chunks directly to disk, bypassing store chunkIndex.
        // Always attempt combine via native plugin (it scans filesystem, not store).
        console.warn('Native recording state lost - attempting filesystem recovery');

        stopDurationTracking();
        stopHealthCheck();

        // Try to stop native recording anyway in case it's still running
        if (BackgroundRecording) {
          try {
            await BackgroundRecording.stopRecording();
          } catch (e) {
            console.log('Native recording already stopped or unavailable');
          }
        }

        // Attempt to combine chunks from disk (combineChunksNative scans filesystem)
        const result = await recordingStore.stopRecording();

        if (result.success) {
          console.log('Recovery successful - recording saved from disk chunks');
          return {
            success: true,
            filePath: result.filePath,
            warning: 'Recording recovered after interruption.',
            recovered: true
          };
        } else {
          console.error('Recovery failed:', result.error);
          return {
            success: false,
            error: 'Recording interrupted. ' + (result.error || 'Could not recover audio file.'),
            partialRecovery: true
          };
        }
      }

      return { success: false, error: 'No active recording' };
    }

    try {
      // Stop native recording (with timeout to prevent infinite hang)
      if (BackgroundRecording) {
        const nativeResult = await Promise.race([
          BackgroundRecording.stopRecording(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Native stopRecording timed out after 10s')), 10000)
          )
        ]);
        console.log('Native recording stopped:', nativeResult);
      }

      stopDurationTracking();
      stopHealthCheck();
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

          if (!status.isRecording && recordingStore.isRecording && !recordingStore.recordingInterrupted) {
            // Native recording stopped but store says recording - trigger death
            console.warn('Native recording stopped while app was in background');
            handleRecordingDeath({
              reason: 'died_in_background',
              chunkCount: status.chunkIndex || recordingStore.chunkIndex,
              lastChunkTimestamp: status.lastChunkTimestampMs || null
            });
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
    stopHealthCheck();
    cleanupPluginListeners();

    // Remove visibility listener
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler);
    }
  });

  // Initialize on mount
  onMounted(async () => {
    await initNativePlugin();

    // Set up plugin listeners if plugin available
    if (BackgroundRecording) {
      setupPluginListeners();
    }

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
