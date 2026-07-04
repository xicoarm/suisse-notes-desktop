import { ref, computed, onUnmounted, onMounted } from 'vue';
import { useRecordingStore } from '../stores/recording';
import { useAuthStore } from '../stores/auth';
import { useMinutesStore } from '../stores/minutes';
import { useSystemAudio } from './useSystemAudio';
import { isElectron, isCapacitor } from '../utils/platform';
import * as recordingService from '../services/recordingService';
import { captureMessage } from '../boot/sentry';

/**
 * Platform-aware recorder composable
 * Delegates to recordingService for persistence across navigation
 */
export function useRecorder() {
  const recordingStore = useRecordingStore();
  const authStore = useAuthStore();
  const minutesStore = useMinutesStore();

  // System audio composable (desktop only)
  // Initialize with null; will be populated from useSystemAudio on desktop
  const _systemAudioRef = isElectron() ? useSystemAudio() : null;

  const systemAudioEnabled = _systemAudioRef
    ? _systemAudioRef.systemAudioEnabled
    : ref(false);
  const permissionStatus = _systemAudioRef
    ? _systemAudioRef.permissionStatus
    : ref('unknown');
  let captureSystemAudio = _systemAudioRef
    ? _systemAudioRef.captureSystemAudio
    : async () => null;
  let stopSystemAudio = _systemAudioRef
    ? _systemAudioRef.stopCapture
    : () => {};
  let loadSystemAudioState = _systemAudioRef
    ? _systemAudioRef.loadState
    : async () => {};
  let setSystemAudioEnabled = _systemAudioRef
    ? _systemAudioRef.setEnabled
    : async () => {};

  // Reactive refs for UI binding (synced with service)
  const audioLevel = ref(0);
  const silenceWarning = ref(null);
  const systemAudioCaptureError = ref(null);
  const micCaptureError = ref(null);
  const isAutoSplitting = ref(false);
  const isMicMuted = ref(false);
  const recordingHealth = ref(recordingService.getMicHealthState());
  // Capture-reliability surfacing (data-loss work): a stalled recorder and
  // chunk-save failures must be visible to the user, not silently swallowed.
  const captureStalled = ref(null); // null | { secondsSinceLastChunk, savedChunks }
  const chunkSaveError = ref(null); // null | { consecutiveErrors, error, diskFull }
  // INT-2: set when the interruption-recovery loop restores capture after a
  // stall (e.g. incoming-call audio-session interruption). The page shows a
  // transient "recording resumed — gap of X" notice so the user knows there
  // is a hole in the audio instead of discovering it after the meeting.
  const captureRecoveredInfo = ref(null); // null | { gapSeconds, reason }
  // MOBR-1/INT-1: snapshot of persisted-chunk count + timestamp taken when the
  // app/tab is hidden during a mobile recording, so we can detect on return
  // whether the WebView was suspended (capture gap) while backgrounded.
  let hiddenSnapshot = null;

  // Screen Wake Lock — keep the screen on during a mobile recording so it does
  // not auto-lock (which suspends the WebView recorder). Pure JS, best-effort
  // (Android WebView + iOS 16.4+); the lock auto-releases when the page is
  // hidden, so we re-acquire on foreground. This is the invisible half of the
  // long-recording mitigation; the discreet on-screen hint is the visible half.
  let wakeLockSentinel = null;
  const requestWakeLock = async () => {
    if (!isCapacitor() || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    if (wakeLockSentinel) return;
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
    } catch (e) {
      // Denied / unsupported / page not visible — best effort; the hint covers it.
      wakeLockSentinel = null;
    }
  };
  const releaseWakeLock = async () => {
    try { await wakeLockSentinel?.release(); } catch (_) { /* ignore */ }
    wakeLockSentinel = null;
  };
  const isMicHealthy = computed(() => recordingHealth.value?.status === 'ok');
  const recordingHealthMessage = computed(() => recordingHealth.value?.message || null);

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
    // B3: clear the transient capture-stall banner once recording is no longer
    // active, so a terminal stall doesn't keep the warning up through stop /
    // processing and into the next session.
    if (state && !state.isRecording) {
      captureStalled.value = null;
    }
  };

  const handleMicMuteChange = (muted) => {
    isMicMuted.value = muted;
  };

  const handleSystemAudioChange = (active) => {
    systemAudioEnabled.value = active;
  };

  const handleSystemAudioError = (message) => {
    systemAudioCaptureError.value = message;
  };

  const handleMicError = (message) => {
    micCaptureError.value = message;
  };

  const handleHealthChange = (health) => {
    recordingHealth.value = health;
  };

  // Recording death handler (desktop) - recording service detected MediaRecorder death
  const handleRecordingDead = (data) => {
    console.warn('Recording dead event from service:', data);
    // The store is already updated by recordingService.verifyRecordingState()
    // The UI will react to recordingStore.isRecordingDead
  };

  // Chunk-save failure (incl. disk-full / retries-exhausted). data===null clears.
  // Previously this event had NO listener, so disk-full and permanently-failed
  // chunk saves were 100% invisible and the recording kept accumulating holes.
  const handleChunkSaveFailure = async (data) => {
    if (!data) { chunkSaveError.value = null; return; }
    console.error('Chunk save failure from service:', data);
    chunkSaveError.value = data;
    // Disk full, or repeated permanent failures → stop now and preserve what is
    // already on disk rather than continuing to "record" into a gapped session.
    if (data.diskFull || (data.consecutiveErrors && data.consecutiveErrors >= 3)) {
      console.error('Emergency stop-with-save triggered by chunk-save failure');
      try {
        await recordingService.stopRecording(recordingStore, stopSystemAudio);
      } catch (e) {
        console.error('Emergency stop-with-save failed:', e);
      }
    }
  };

  // Chunk-progress watchdog: capture appears stalled while still 'recording'.
  const handleCaptureStalled = (data) => {
    console.warn('Capture stalled (watchdog):', data);
    captureStalled.value = data;
  };
  const handleCaptureRecovered = (data) => {
    captureStalled.value = null;
    // Only surface real gaps — sub-15s recoveries (transient suspends) would
    // just be noise.
    if (data?.gapSeconds >= 15) {
      captureRecoveredInfo.value = data;
    }
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
      // MOBR-1/INT-1: snapshot persisted-chunk progress so we can tell on
      // return whether capture actually continued while backgrounded.
      if (isCapacitor()) {
        hiddenSnapshot = { savedChunks: recordingService.getSavedChunkCount(), atMs: Date.now() };
      }
      await recordingService.flushRecordingData();
    } else if (!isHidden) {
      // B2: returning to the foreground (desktop tab visible OR mobile app
      // resumed). JS timers were frozen while hidden, so refresh the watchdog
      // baseline — otherwise the first post-resume tick reads the whole hidden
      // gap as a capture stall and fires a false warning.
      recordingService.notifyForegrounded();
      // The screen wake lock auto-releases when hidden — re-acquire it.
      if (recordingStore.isRecording) requestWakeLock();

      // MOBR-1/INT-1: on mobile the OS can suspend the WebView (and its
      // MediaRecorder) in the background — screen lock, app switch, or an
      // incoming call — so capture silently stops while the wall clock keeps
      // climbing. If the wall clock advanced meaningfully while hidden but
      // barely any chunks were persisted, surface a capture-gap warning instead
      // of letting the timer imply the whole meeting was captured. (This is the
      // visible half of the safety net; true background capture is the planned
      // native follow-up.)
      if (isCapacitor() && hiddenSnapshot && recordingStore.isRecording) {
        const hiddenSec = Math.round((Date.now() - hiddenSnapshot.atMs) / 1000);
        const savedDuring = recordingService.getSavedChunkCount() - hiddenSnapshot.savedChunks;
        const expectedChunks = hiddenSec / 3; // ~3s MediaRecorder timeslice
        if (hiddenSec >= 15 && savedDuring < Math.max(1, expectedChunks * 0.5)) {
          captureStalled.value = {
            secondsSinceLastChunk: hiddenSec,
            savedChunks: recordingService.getSavedChunkCount(),
            backgroundGap: true,
          };
          // Telemetry: log the background capture gap so we can measure how
          // often the WebView is actually suspended mid-recording (incoming
          // call / lock screen / app switch). This incidence drives the
          // decision on whether the native background-capture follow-up is
          // worth its risk/effort. Platform tag lets us split iOS vs Android.
          captureMessage(
            `recording: background capture gap — hidden ${hiddenSec}s, only ${savedDuring} chunk(s) persisted (~${Math.round(expectedChunks)} expected)`,
            'warning'
          );
        }
      }
      hiddenSnapshot = null;
    }
  };

  // Beforeunload handler
  const handleBeforeUnload = (event) => {
    if (recordingStore.isRecording || recordingStore.isPaused) {
      // DREC-2: set preventDefault/returnValue FIRST so the page is kept alive
      // (the browser shows the "leave?" prompt; in packaged Electron the main
      // process also guards window-close + before-quit while recording). Only
      // then fire the flush, so the requested final chunk has a live event loop
      // in which to arrive and persist (with the widened 6s flush budget)
      // instead of racing renderer teardown and being dropped.
      event.preventDefault();
      event.returnValue = 'You have an active recording. Are you sure you want to leave?';
      recordingService.flushRecordingData();
      return event.returnValue;
    }
  };

  // Start recording
  const startRecording = async (deviceId = null, maxRecordingSeconds = null) => {
    const micId = deviceId || selectedMicrophoneId.value;

    // Reset limit tracking state
    minutesLimitWarning.value = null;
    minutesLimitReached.value = false;
    systemAudioCaptureError.value = null;
    micCaptureError.value = null;
    captureStalled.value = null;
    captureRecoveredInfo.value = null;
    chunkSaveError.value = null;

    // Use user's remaining minutes as max duration if not specified
    const maxSeconds = maxRecordingSeconds ?? minutesStore.remainingSeconds;

    const startResult = await recordingService.startRecording({
      recordingStore,
      authStore,
      deviceId: micId,
      systemAudioEnabled: systemAudioEnabled.value,
      captureSystemAudio,
      isAutoSplitting,
      maxRecordingSeconds: maxSeconds > 0 ? maxSeconds : null
    });
    if (startResult && startResult.success) {
      requestWakeLock(); // keep the screen awake while recording (mobile)
    }
    return startResult;
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
    releaseWakeLock();
    return await recordingService.stopRecording(recordingStore, stopSystemAudio);
  };

  // Cancel recording (discard without processing)
  const cancelRecording = async () => {
    releaseWakeLock();
    await recordingService.cancelRecording(recordingStore, stopSystemAudio);
  };

  // Toggle system audio during an active recording.
  //
  // Three failure modes the ultrareview surfaced (all desktop-only, all
  // shipped in v4.0.11):
  //
  //   bug_001 — On Windows, `addSystemAudioStream` returns false if the
  //   mixing pipeline was torn down or createMediaStreamSource threw.
  //   The previous code ignored that and proceeded to mark the toggle ON,
  //   leaving the UI lying that capture was active. Now we check it.
  //
  //   bug_002 — On macOS, `captureSystemAudio` resolves to literal `true`
  //   (AudioTee writes PCM to disk directly, no MediaStream). The
  //   `instanceof MediaStream` check fell through silently, so
  //   recordingService.systemAudioActive stayed false even during active
  //   capture — wrong silence-warning copy and aggressive thresholds. Now
  //   we call setSystemAudioActive(true) for the AudioTee path.
  //
  //   bug_005 — If invoked while recording is paused, the offsetMs is
  //   frozen at pause-time but AudioTee spawns immediately and writes
  //   wall-clock PCM through the pause window — silent ~30 s desync on
  //   resume. Refusing the toggle while paused is the smallest correct
  //   fix; UI should also disable the toggle while isPaused, but the
  //   guard here prevents the corruption regardless of UI state.
  const toggleSystemAudioDuringRecording = async (enabled) => {
    if (enabled) {
      // bug_005 guard: refuse the toggle if we're not actively recording.
      // AudioTee runs in wall-clock time and would desync from the mic
      // timeline by pause_duration if started during a pause window.
      if (recordingStore.isPaused) {
        console.warn('Refusing system-audio toggle while recording is paused (would desync merge)');
        return { success: false, error: 'Cannot toggle system audio while paused. Resume recording first.' };
      }
      if (!recordingStore.isRecording) {
        console.warn('Refusing system-audio toggle while not actively recording');
        return { success: false, error: 'No active recording to attach system audio to.' };
      }

      // Pass current recording offset so macOS AudioTee can pad with silence
      // and align the captured PCM with the mic timeline at merge time.
      // A5: align system audio to the TRUE elapsed time, not the clamped
      // captured-duration in recordingStore.duration (which under-counts after a
      // stall or at start-latency) — using the clamp would mis-pad the
      // system-audio PCM against the mic timeline.
      const offsetMs = Math.max(0, Math.round((recordingService.getWallClockSeconds() || 0) * 1000));
      const result = await captureSystemAudio(recordingStore.recordId, offsetMs);
      if (!result) {
        return { success: false, error: 'Failed to start system audio capture' };
      }

      if (result instanceof MediaStream) {
        // Windows: desktopCapturer returns a MediaStream that must be wired
        // into the active mixing pipeline.
        const attached = recordingService.addSystemAudioStream(result);
        if (!attached) {
          // bug_001: mixing pipeline torn down OR createMediaStreamSource
          // threw. Tear down the captured stream and the OS-level capture
          // so the recording indicator and OS resources are released,
          // and DO NOT flip the toggle ON — the user would otherwise see
          // "system audio recording" in the UI while nothing was in the mix.
          try { result.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
          await stopSystemAudio();
          return { success: false, error: 'Could not attach system audio to the active recording' };
        }
      } else {
        // macOS: AudioTee. No MediaStream to attach; tell recordingService
        // capture is active so silence warnings use the gentler messages
        // and the relaxed thresholds (120s / 300s).
        recordingService.setSystemAudioActive(true);
      }

      await setSystemAudioEnabled(true);
      return { success: true };
    } else {
      // Detach from the live mix (Windows) or just clear the flag (macOS,
      // since there was no MediaStream attached), then stop the underlying
      // capture source. removeSystemAudioStream is a no-op if no Windows
      // stream was attached; the explicit setSystemAudioActive(false) covers
      // the macOS path where systemStream is null.
      recordingService.removeSystemAudioStream();
      recordingService.setSystemAudioActive(false);
      await stopSystemAudio();
      await setSystemAudioEnabled(false);
      return { success: true };
    }
  };

  // Switch microphone during active recording
  const switchMicrophoneDuringRecording = async (newDeviceId) => {
    const result = await recordingService.switchMicrophoneStream(newDeviceId);
    if (result.success) {
      selectedMicrophoneId.value = newDeviceId;
    }
    return result;
  };

  // Toggle microphone mute
  const toggleMicMute = () => {
    recordingService.toggleMicMute();
  };

  // Setup on mount
  onMounted(() => {
    // Subscribe to service events
    recordingService.addEventListener('levelChange', handleLevelChange);
    recordingService.addEventListener('silenceWarning', handleSilenceWarning);
    recordingService.addEventListener('stateChange', handleStateChange);
    recordingService.addEventListener('limitWarning', handleLimitWarning);
    recordingService.addEventListener('limitReached', handleLimitReached);
    recordingService.addEventListener('micMuteChange', handleMicMuteChange);
    recordingService.addEventListener('systemAudioChange', handleSystemAudioChange);
    recordingService.addEventListener('systemAudioError', handleSystemAudioError);
    recordingService.addEventListener('micError', handleMicError);
    recordingService.addEventListener('recordingDead', handleRecordingDead);
    recordingService.addEventListener('healthChange', handleHealthChange);
    recordingService.addEventListener('criticalWarning', handleHealthChange);
    recordingService.addEventListener('healthRecovered', handleHealthChange);
    recordingService.addEventListener('chunkSaveFailure', handleChunkSaveFailure);
    recordingService.addEventListener('captureStalled', handleCaptureStalled);
    recordingService.addEventListener('captureRecovered', handleCaptureRecovered);

    // Set up visibility and beforeunload handlers
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Sync with current service state (for navigation back to page)
    const state = recordingService.getState();
    audioLevel.value = state.audioLevel;
    silenceWarning.value = state.silenceWarning;
    isMicMuted.value = state.micMuted;
    recordingHealth.value = state.recordingHealth || recordingService.getMicHealthState();

    // Restore system audio toggle state from recording service when recording is active
    if (state.isActive || state.isRecording || state.isPaused) {
      systemAudioEnabled.value = state.systemAudioActive;
    }

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
        // Acknowledge to main process that flush is complete
        window.electronAPI.system.sendSuspendAck();
      });

      window.electronAPI.system.onResume(async (data) => {
        if (data.needsRecovery && recordingStore.isRecording) {
          // B2: OS resumed from sleep — refresh the watchdog baseline so the
          // frozen-timer gap during sleep is not read as a capture stall.
          recordingService.notifyForegrounded();
          // Explicitly resume AudioContext — it may be suspended after system sleep
          await recordingService.resumeAudioContexts();

          silenceWarning.value = 'Recording resumed after system sleep - please check audio is working';
          setTimeout(() => {
            if (audioLevel.value > 1) {
              silenceWarning.value = null;
            }
          }, 5000);
        }
      });

      // AudioTee runs as a standalone process — Audio Service crashes don't affect it.
      // Keep the listener for logging but no recovery needed.
      window.electronAPI.system.onAudioServiceCrashed(async () => {
        console.warn('Audio Service crashed — AudioTee capture is independent and should continue');
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
    recordingService.removeEventListener('micMuteChange', handleMicMuteChange);
    recordingService.removeEventListener('systemAudioChange', handleSystemAudioChange);
    recordingService.removeEventListener('systemAudioError', handleSystemAudioError);
    recordingService.removeEventListener('micError', handleMicError);
    recordingService.removeEventListener('recordingDead', handleRecordingDead);
    recordingService.removeEventListener('healthChange', handleHealthChange);
    recordingService.removeEventListener('criticalWarning', handleHealthChange);
    recordingService.removeEventListener('healthRecovered', handleHealthChange);
    recordingService.removeEventListener('chunkSaveFailure', handleChunkSaveFailure);
    recordingService.removeEventListener('captureStalled', handleCaptureStalled);
    recordingService.removeEventListener('captureRecovered', handleCaptureRecovered);

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
    isSystemAudioSupported: _systemAudioRef ? _systemAudioRef.isSupported : ref(false),
    silenceWarning,
    systemAudioCaptureError,
    micCaptureError,
    recordingHealth,
    isMicHealthy,
    recordingHealthMessage,
    captureStalled,
    captureRecoveredInfo,
    chunkSaveError,
    minutesLimitWarning,
    minutesLimitReached,
    minutesStore,
    isMicMuted,
    setSystemAudioEnabled,
    loadMicrophones,
    loadSystemAudioState,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    cancelRecording,
    toggleSystemAudioDuringRecording,
    toggleMicMute,
    switchMicrophoneDuringRecording
  };
}
