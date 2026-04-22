/**
 * Recording Service - Singleton that manages MediaRecorder outside of component lifecycle
 * This allows recording to persist across navigation
 */

import { isAndroid } from '../utils/platform';

let BackgroundRecording = null;

async function showRecordingNotification() {
  if (!isAndroid()) return;

  try {
    // Load plugin if not loaded
    if (!BackgroundRecording) {
      const { registerPlugin } = await import('@capacitor/core');
      BackgroundRecording = registerPlugin('BackgroundRecording');
    }

    await BackgroundRecording.startForegroundService();
  } catch (e) {
    console.warn('Could not start foreground service:', e);
  }
}

async function hideRecordingNotification() {
  if (!isAndroid()) return;

  try {
    await BackgroundRecording.stopForegroundService();
  } catch (e) {
    console.warn('Could not stop foreground service:', e);
  }
}

// Module-level state (persists across navigation)
let mediaRecorder = null;
let mixedAudioContext = null;
let mixedAnalyser = null;
let mixedSourceNode = null;
let micHealthAudioContext = null;
let micHealthAnalyser = null;
let micHealthSourceNode = null;
let stream = null;
let mixedStream = null;
let mixingContext = null;
let mixingDest = null;
let micSourceNode = null;
let systemSourceNode = null;
let systemStream = null;
let durationInterval = null;
let levelInterval = null;
let micHealthInterval = null;
let stateVerificationInterval = null;

// System audio state (persists across navigation)
let systemAudioActive = false;

// Mic mute state
let micMuted = false;

// Recording store reference (set during startRecording, used by switchMicrophoneStream)
let recordingStoreRef = null;

// Flush synchronization: resolved when ondataavailable saves the chunk after a flush request
let flushResolvers = [];

let silenceError = null;

const VOICE_FREQ_LOW_BIN = 3;    // ~563Hz (bin * 48000/256) — above mains hum harmonics
const VOICE_FREQ_HIGH_BIN = 40;  // ~7500Hz — covers voice formants F1-F3
const VOICE_ENERGY_THRESHOLD = 5;

// Configuration
const SILENCE_THRESHOLD = 1;
const HEALTH_SAMPLE_INTERVAL_MS = 100;
const MIC_HEALTH_DEGRADED_SECONDS = 30;  // Show subtle hint after 30s of silence
const MIC_HEALTH_CRITICAL_SECONDS = 60;  // Escalate to critical after 60s
const MIC_HEALTH_RECOVERY_SECONDS = 3;

// Dev/test-only env-var override helper. Honored ONLY in non-production builds
// (Vite sets import.meta.env.PROD=true at production build time). Production
// bundles always use the hard-coded fallback regardless of any VITE_* var —
// this prevents a stray .env.local from shortening auto-split intervals for
// real users.
//
// Supported overrides (set in .env.local — Vite only exposes VITE_ prefixed vars):
//   VITE_SUISSE_MAX_DURATION_SECONDS            — auto-split interval (default 17700 = 4h55m)
//   VITE_SUISSE_MEDIA_RECORDER_TIMESLICE_MS     — MediaRecorder chunk size (default 3000)
function envNumDev(key, fallback) {
  if (import.meta.env?.PROD) return fallback;
  const raw = import.meta.env?.[key];
  const n = typeof raw === 'string' ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_DURATION_SECONDS = envNumDev('VITE_SUISSE_MAX_DURATION_SECONDS', 4 * 60 * 60 + 55 * 60); // 4h 55m
const MEDIA_RECORDER_TIMESLICE_MS = envNumDev('VITE_SUISSE_MEDIA_RECORDER_TIMESLICE_MS', 3000);
const AUTH_KEEP_ALIVE_INTERVAL = 30 * 60 * 1000; // Refresh auth every 30 min during recording

export const MIC_HEALTH_STATUS = Object.freeze({
  OK: 'ok',
  DEGRADED: 'degraded',
  CRITICAL: 'critical'
});

export const MIC_HEALTH_REASON = Object.freeze({
  NO_AUDIO_DETECTED: 'no_audio_detected',
  NO_VOICE_DETECTED: 'no_voice_detected',
  MIC_CAPTURE_FAILED: 'mic_capture_failed',
  TRACK_ENDED: 'track_ended',
  SYSTEM_AUDIO_ONLY: 'system_audio_only',
  MONITORING_ERROR: 'monitoring_error'
});

let micHealthState = {
  status: MIC_HEALTH_STATUS.OK,
  reasonCode: null,
  message: null,
  micActive: false,
  systemAudioActive: false,
  inputDeviceId: null,
  actualDeviceId: null,
  trackLabel: '',
  sampleRate: null,
  channelCount: null,
  changedAt: Date.now()
};
let micAnomalyCounter = 0;
let micRecoveryCounter = 0;

// Auth keep-alive interval
let authKeepAliveInterval = null;

// Event listeners
const listeners = new Map();

// Audio level (for UI updates)
let currentAudioLevel = 0;

/**
 * Add event listener
 */
export function addEventListener(event, callback) {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event).add(callback);
}

/**
 * Remove event listener
 */
export function removeEventListener(event, callback) {
  if (listeners.has(event)) {
    listeners.get(event).delete(callback);
  }
}

/**
 * Emit event to listeners
 */
function emit(event, data) {
  if (listeners.has(event)) {
    listeners.get(event).forEach(callback => {
      try {
        callback(data);
      } catch (e) {
        console.error('Error in event listener:', e);
      }
    });
  }
}

function getMicHealthMessage(reasonCode) {
  // When system audio is active, use gentler messages — the recording is still useful
  const hasSysAudio = systemAudioActive;

  switch (reasonCode) {
    case MIC_HEALTH_REASON.NO_AUDIO_DETECTED:
      return hasSysAudio
        ? 'Microphone is silent — system audio is still being recorded.'
        : 'No microphone input detected. Check your microphone or try switching devices above.';
    case MIC_HEALTH_REASON.NO_VOICE_DETECTED:
      return hasSysAudio
        ? 'No voice from microphone — system audio is still being recorded.'
        : 'No voice detected from microphone. You may want to check your input device.';
    case MIC_HEALTH_REASON.MIC_CAPTURE_FAILED:
      return 'Microphone capture failed. Recording continues with system audio.';
    case MIC_HEALTH_REASON.TRACK_ENDED:
      return hasSysAudio
        ? 'Microphone disconnected — system audio is still being recorded. You can switch devices above.'
        : 'Microphone disconnected. You can switch to a different device above.';
    case MIC_HEALTH_REASON.SYSTEM_AUDIO_ONLY:
      return 'Recording system audio only — microphone is not active.';
    case MIC_HEALTH_REASON.MONITORING_ERROR:
      return 'Microphone monitoring issue. Recording continues normally.';
    default:
      return null;
  }
}

function clearSilenceWarning() {
  if (silenceError) {
    silenceError = null;
    emit('silenceWarning', null);
  }
}

function setSilenceWarning(message) {
  if (silenceError !== message) {
    silenceError = message;
    emit('silenceWarning', silenceError);
  }
}

function updateMicHealthState(status, reasonCode = null, message = null, updates = {}) {
  const previous = micHealthState;
  const resolvedReason = status === MIC_HEALTH_STATUS.OK ? null : reasonCode;
  const resolvedMessage = status === MIC_HEALTH_STATUS.OK
    ? null
    : (message || getMicHealthMessage(resolvedReason));

  const nextState = {
    ...previous,
    ...updates,
    status,
    reasonCode: resolvedReason,
    message: resolvedMessage,
    changedAt: Date.now()
  };

  const changed = [
    'status',
    'reasonCode',
    'message',
    'micActive',
    'systemAudioActive',
    'inputDeviceId',
    'actualDeviceId',
    'trackLabel',
    'sampleRate',
    'channelCount'
  ].some((key) => nextState[key] !== previous[key]);

  micHealthState = nextState;
  if (!changed) {
    return;
  }

  emit('healthChange', { ...micHealthState });
  if (nextState.status === MIC_HEALTH_STATUS.CRITICAL && previous.status !== MIC_HEALTH_STATUS.CRITICAL) {
    emit('criticalWarning', { ...micHealthState });
  }
}

function resetMicHealthState() {
  micAnomalyCounter = 0;
  micRecoveryCounter = 0;
  micHealthState = {
    status: MIC_HEALTH_STATUS.OK,
    reasonCode: null,
    message: null,
    micActive: false,
    systemAudioActive: false,
    inputDeviceId: null,
    actualDeviceId: null,
    trackLabel: '',
    sampleRate: null,
    channelCount: null,
    changedAt: Date.now()
  };
  emit('healthChange', { ...micHealthState });
}

function updateMicHealthTrackDetails(micStream, requestedDeviceId) {
  const track = micStream?.getAudioTracks?.()[0];
  const settings = track?.getSettings ? track.getSettings() : {};
  updateMicHealthState(MIC_HEALTH_STATUS.OK, null, null, {
    micActive: Boolean(track),
    systemAudioActive,
    inputDeviceId: requestedDeviceId || null,
    actualDeviceId: settings.deviceId || null,
    trackLabel: track?.label || '',
    sampleRate: settings.sampleRate || null,
    channelCount: settings.channelCount || null
  });
}

/**
 * Get current service state
 */
export function getState() {
  return {
    isActive: mediaRecorder !== null && mediaRecorder.state !== 'inactive',
    isRecording: mediaRecorder?.state === 'recording',
    isPaused: mediaRecorder?.state === 'paused',
    audioLevel: currentAudioLevel,
    silenceWarning: silenceError,
    hasStream: stream !== null,
    systemAudioActive,
    micMuted,
    recordingHealth: {
      ...micHealthState,
      systemAudioActive
    }
  };
}

export function getMicHealthState() {
  return {
    ...micHealthState,
    systemAudioActive
  };
}

/**
 * Get current audio level
 */
export function getAudioLevel() {
  return currentAudioLevel;
}

/**
 * Get silence warning
 */
export function getSilenceWarning() {
  return silenceError;
}

/**
 * Create mixing pipeline via AudioContext.
 * Always creates the pipeline so system audio can be added/removed dynamically.
 */
function createMixingPipeline(micStream, sysStream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 48000
  });
  const dest = ctx.createMediaStreamDestination();

  if (micStream) {
    micSourceNode = ctx.createMediaStreamSource(micStream);
    micSourceNode.connect(dest);
  }

  if (sysStream) {
    systemSourceNode = ctx.createMediaStreamSource(sysStream);
    systemSourceNode.connect(dest);
    systemStream = sysStream;
    systemAudioActive = true;
  }

  // Auto-resume AudioContext if it gets suspended (macOS audio session interruption,
  // system resume from sleep, another app claiming audio focus)
  ctx.addEventListener('statechange', () => {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      console.warn(`AudioContext state changed to "${ctx.state}" — attempting resume`);
      ctx.resume().catch(e => console.warn('AudioContext auto-resume failed:', e));
    }
  });

  mixingContext = ctx;
  mixingDest = dest;
  return dest.stream;
}

/**
 * Add system audio to the active recording mix
 */
export function addSystemAudioStream(sysStream) {
  if (!mixingContext || !mixingDest) {
    console.warn('No active mixing pipeline to add system audio to');
    return false;
  }

  // Remove existing system audio first
  removeSystemAudioStream();

  try {
    systemSourceNode = mixingContext.createMediaStreamSource(sysStream);
    systemSourceNode.connect(mixingDest);
    systemStream = sysStream;
    systemAudioActive = true;
    emit('systemAudioChange', true);
    updateMicHealthState(
      micHealthState.status,
      micHealthState.reasonCode,
      micHealthState.message,
      { systemAudioActive: true }
    );
    console.log('System audio added to recording mix');
    return true;
  } catch (e) {
    console.error('Error adding system audio:', e);
    return false;
  }
}

/**
 * Remove system audio from the active recording mix
 */
export function removeSystemAudioStream() {
  if (systemSourceNode) {
    try {
      systemSourceNode.disconnect();
    } catch (e) {
      // Already disconnected
    }
    systemSourceNode = null;
  }
  if (systemStream) {
    systemStream.getTracks().forEach(track => track.stop());
    systemStream = null;
  }
  if (systemAudioActive) {
    systemAudioActive = false;
    emit('systemAudioChange', false);
    updateMicHealthState(
      micHealthState.status,
      micHealthState.reasonCode,
      micHealthState.message,
      { systemAudioActive: false }
    );
    console.log('System audio removed from recording mix');
  }
}

/**
 * Resume AudioContexts after system sleep/interruption.
 * Called from the resume handler to ensure audio pipeline is active.
 */
export async function resumeAudioContexts() {
  const contexts = [mixingContext, micHealthAudioContext].filter(Boolean);
  for (const ctx of contexts) {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      try {
        await ctx.resume();
        console.log(`Resumed AudioContext (was "${ctx.state}")`);
      } catch (e) {
        console.warn('Failed to resume AudioContext:', e);
      }
    }
  }
}

/**
 * Switch microphone source mid-recording without stopping the MediaRecorder.
 * Follows the same pattern as addSystemAudioStream/removeSystemAudioStream.
 * @param {string} newDeviceId - The device ID to switch to
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function switchMicrophoneStream(newDeviceId) {
  if (!mixingContext || !mixingDest) {
    return { success: false, error: 'No active recording to switch microphone in' };
  }

  try {
    // Step 1: Acquire new mic stream with fallback constraints
    let newStream = null;
    const constraintLadder = [
      { deviceId: { exact: newDeviceId }, echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
      { deviceId: { ideal: newDeviceId }, noiseSuppression: true },
      { noiseSuppression: true },
      true
    ];

    for (const constraints of constraintLadder) {
      try {
        newStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        break;
      } catch (e) {
        console.warn('Mic switch constraint attempt failed:', e.name);
      }
    }

    if (!newStream) {
      return { success: false, error: 'Could not access the selected microphone' };
    }

    // Step 2: Stop old health monitoring (uses the old mic stream)
    if (micHealthInterval) {
      clearInterval(micHealthInterval);
      micHealthInterval = null;
    }
    if (micHealthSourceNode) {
      try { micHealthSourceNode.disconnect(); } catch (e) { /* already disconnected */ }
      micHealthSourceNode = null;
    }
    if (micHealthAudioContext) {
      micHealthAudioContext.close().catch(() => {});
      micHealthAudioContext = null;
    }
    micHealthAnalyser = null;

    // Step 3: Disconnect old mic from mixing pipeline
    if (micSourceNode) {
      try { micSourceNode.disconnect(); } catch (e) { /* already disconnected */ }
      micSourceNode = null;
    }
    if (stream) {
      stream.getTracks().forEach(track => {
        track.onended = null; // Remove old listener
        track.stop();
      });
    }

    // Step 4: Connect new mic to mixing pipeline
    micSourceNode = mixingContext.createMediaStreamSource(newStream);
    micSourceNode.connect(mixingDest);
    stream = newStream;
    micMuted = false;

    // Step 5: Set up track.onended listener for new stream
    for (const track of newStream.getTracks()) {
      track.onended = () => {
        console.warn('Switched mic track ended unexpectedly — waiting 3s before declaring critical');
        updateMicHealthState(MIC_HEALTH_STATUS.DEGRADED, MIC_HEALTH_REASON.TRACK_ENDED, null, {
          micActive: false, systemAudioActive
        });
        setTimeout(() => {
          if (!recordingStoreRef?.isRecording) return;
          if (micHealthState.status === MIC_HEALTH_STATUS.OK) return;
          updateMicHealthState(MIC_HEALTH_STATUS.CRITICAL, MIC_HEALTH_REASON.TRACK_ENDED, null, {
            micActive: false, systemAudioActive
          });
          setSilenceWarning(micHealthState.message);
          if (recordingStoreRef) verifyRecordingState(recordingStoreRef);
        }, 3000);
      };
    }

    // Step 6: Restart health monitoring with new stream
    if (recordingStoreRef) {
      startMicHealthMonitoring(newStream, recordingStoreRef);
    }

    // Step 7: Update health state to OK
    updateMicHealthTrackDetails(newStream, newDeviceId);
    clearSilenceWarning();
    micAnomalyCounter = 0;
    micRecoveryCounter = 0;

    const trackLabel = newStream.getAudioTracks()[0]?.label || newDeviceId;
    console.log('Microphone switched successfully to:', trackLabel);
    emit('microphoneChange', { deviceId: newDeviceId, label: trackLabel });
    return { success: true };
  } catch (e) {
    console.error('Error switching microphone:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Toggle microphone mute state
 */
export function toggleMicMute() {
  if (!stream) return false;

  micMuted = !micMuted;
  stream.getAudioTracks().forEach(track => {
    track.enabled = !micMuted;
  });

  emit('micMuteChange', micMuted);

  // Reset anomaly counters when intentionally muted to avoid false health warnings.
  if (micMuted) {
    micAnomalyCounter = 0;
    micRecoveryCounter = 0;
    clearSilenceWarning();
  }

  console.log('Mic mute:', micMuted);
  return micMuted;
}

/**
 * Start mixed-stream level monitoring for display and separate mic-only health monitoring.
 */
function startLevelMonitoring(mediaStream, micStream, recordingStore) {
  stopLevelMonitoring();

  try {
    mixedAudioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });
    mixedAnalyser = mixedAudioContext.createAnalyser();
    mixedSourceNode = mixedAudioContext.createMediaStreamSource(mediaStream);
    mixedSourceNode.connect(mixedAnalyser);

    mixedAnalyser.fftSize = 256;
    const bufferLength = mixedAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    levelInterval = setInterval(() => {
      if (!mixedAnalyser || !recordingStore.isRecording) {
        return;
      }

      mixedAnalyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
      currentAudioLevel = Math.min(100, (average / 128) * 100);
      emit('levelChange', currentAudioLevel);
    }, HEALTH_SAMPLE_INTERVAL_MS);
  } catch (error) {
    console.warn('Could not start mixed audio level monitoring:', error);
  }

  if (micStream) {
    startMicHealthMonitoring(micStream, recordingStore);
  } else if (systemAudioActive) {
    if (micHealthState.reasonCode !== MIC_HEALTH_REASON.MIC_CAPTURE_FAILED) {
      updateMicHealthState(
        MIC_HEALTH_STATUS.CRITICAL,
        MIC_HEALTH_REASON.SYSTEM_AUDIO_ONLY,
        null,
        {
          micActive: false,
          systemAudioActive: true
        }
      );
    }
    setSilenceWarning(micHealthState.message);
  }
}

function startMicHealthMonitoring(micStream, recordingStore) {
  try {
    micHealthAudioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });
    micHealthAnalyser = micHealthAudioContext.createAnalyser();
    micHealthSourceNode = micHealthAudioContext.createMediaStreamSource(micStream);
    micHealthSourceNode.connect(micHealthAnalyser);

    micHealthAnalyser.fftSize = 256;
    const bufferLength = micHealthAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    micAnomalyCounter = 0;
    micRecoveryCounter = 0;

    micHealthInterval = setInterval(() => {
      if (!recordingStore.isRecording || !micHealthAnalyser) {
        return;
      }

      const micTrack = micStream.getAudioTracks()[0];
      if (!micTrack || micTrack.readyState !== 'live') {
        updateMicHealthState(
          MIC_HEALTH_STATUS.CRITICAL,
          MIC_HEALTH_REASON.TRACK_ENDED,
          null,
          {
            micActive: false,
            systemAudioActive
          }
        );
        setSilenceWarning(micHealthState.message);
        return;
      }

      if (micMuted) {
        micAnomalyCounter = 0;
        micRecoveryCounter = 0;
        clearSilenceWarning();
        return;
      }

      micHealthAnalyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
      const highBin = Math.min(VOICE_FREQ_HIGH_BIN, bufferLength);
      let voiceEnergy = 0;
      for (let i = VOICE_FREQ_LOW_BIN; i < highBin; i++) {
        voiceEnergy += dataArray[i];
      }
      voiceEnergy /= Math.max(1, (highBin - VOICE_FREQ_LOW_BIN));

      let reasonCode = null;
      if (average < SILENCE_THRESHOLD) {
        reasonCode = MIC_HEALTH_REASON.NO_AUDIO_DETECTED;
      } else if (voiceEnergy < VOICE_ENERGY_THRESHOLD) {
        reasonCode = MIC_HEALTH_REASON.NO_VOICE_DETECTED;
      }

      // When system audio is active and carrying the recording, mic silence
      // is normal (user may just be listening to a call). Suppress NO_VOICE
      // entirely and use much longer thresholds for NO_AUDIO.
      if (reasonCode && systemAudioActive) {
        if (reasonCode === MIC_HEALTH_REASON.NO_VOICE_DETECTED) {
          // Completely normal — user is listening, system audio captures the call
          reasonCode = null;
        }
        // For NO_AUDIO_DETECTED with system audio: only flag after 2 minutes
        // (mic might genuinely be disconnected, but recording is still useful)
      }

      if (reasonCode) {
        micAnomalyCounter++;
        micRecoveryCounter = 0;

        const anomalySeconds = (micAnomalyCounter * HEALTH_SAMPLE_INTERVAL_MS) / 1000;
        // When system audio is active, use much longer thresholds — the recording is still useful
        const degradedThreshold = systemAudioActive ? 120 : MIC_HEALTH_DEGRADED_SECONDS;
        const criticalThreshold = systemAudioActive ? 300 : MIC_HEALTH_CRITICAL_SECONDS;
        const nextStatus = anomalySeconds >= criticalThreshold
          ? MIC_HEALTH_STATUS.CRITICAL
          : (anomalySeconds >= degradedThreshold ? MIC_HEALTH_STATUS.DEGRADED : MIC_HEALTH_STATUS.OK);

        if (nextStatus !== MIC_HEALTH_STATUS.OK) {
          updateMicHealthState(nextStatus, reasonCode, null, {
            micActive: true,
            systemAudioActive
          });
          setSilenceWarning(micHealthState.message);
        }
      } else {
        micAnomalyCounter = 0;
        micRecoveryCounter++;
        const recoverySeconds = (micRecoveryCounter * HEALTH_SAMPLE_INTERVAL_MS) / 1000;

        if (micHealthState.status !== MIC_HEALTH_STATUS.OK && recoverySeconds >= MIC_HEALTH_RECOVERY_SECONDS) {
          updateMicHealthState(MIC_HEALTH_STATUS.OK, null, null, {
            micActive: true,
            systemAudioActive
          });
          clearSilenceWarning();
        } else if (micHealthState.status === MIC_HEALTH_STATUS.OK) {
          clearSilenceWarning();
        }
      }
    }, HEALTH_SAMPLE_INTERVAL_MS);
  } catch (error) {
    console.warn('Could not start mic health monitoring:', error);
    updateMicHealthState(
      MIC_HEALTH_STATUS.CRITICAL,
      MIC_HEALTH_REASON.MONITORING_ERROR,
      null,
      {
        micActive: Boolean(micStream?.getAudioTracks?.().length),
        systemAudioActive
      }
    );
    setSilenceWarning(micHealthState.message);
  }
}

/**
 * Stop mixed-level and mic-health monitoring.
 */
function stopLevelMonitoring() {
  if (levelInterval) {
    clearInterval(levelInterval);
    levelInterval = null;
  }
  if (micHealthInterval) {
    clearInterval(micHealthInterval);
    micHealthInterval = null;
  }

  if (mixedSourceNode) {
    try {
      mixedSourceNode.disconnect();
    } catch (e) {
      // Already disconnected
    }
    mixedSourceNode = null;
  }
  if (micHealthSourceNode) {
    try {
      micHealthSourceNode.disconnect();
    } catch (e) {
      // Already disconnected
    }
    micHealthSourceNode = null;
  }

  if (mixedAudioContext) {
    mixedAudioContext.close().catch(() => {});
    mixedAudioContext = null;
  }
  if (micHealthAudioContext) {
    micHealthAudioContext.close().catch(() => {});
    micHealthAudioContext = null;
  }

  mixedAnalyser = null;
  micHealthAnalyser = null;
  micAnomalyCounter = 0;
  micRecoveryCounter = 0;
  currentAudioLevel = 0;
  clearSilenceWarning();
  emit('levelChange', 0);
}

// Minutes limit tracking state
let minutesLimitSeconds = null;
let limitWarningShown = false;
const LIMIT_WARNING_SECONDS = 300; // 5 minutes warning before limit

/**
 * Start duration tracking with optional minutes limit
 * @param {Object} recordingStore - Recording store instance
 * @param {Object} isAutoSplitting - Auto-splitting ref
 * @param {number|null} maxSeconds - Maximum recording seconds (from user's minutes balance)
 */
function startDurationTracking(recordingStore, isAutoSplitting, maxSeconds = null) {
  // Defensively clear any existing interval to prevent dual timers
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }

  const startTime = Date.now();
  minutesLimitSeconds = maxSeconds;
  limitWarningShown = false;

  durationInterval = setInterval(async () => {
    if (recordingStore.isRecording) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      recordingStore.updateDuration(elapsed);
      emit('durationChange', elapsed);

      // Check minutes limit (if set)
      if (minutesLimitSeconds !== null && minutesLimitSeconds > 0) {
        const remaining = minutesLimitSeconds - elapsed;

        // Warning at 5 minutes (or less) before limit
        if (remaining <= LIMIT_WARNING_SECONDS && remaining > 0 && !limitWarningShown) {
          limitWarningShown = true;
          const minutesRemaining = Math.ceil(remaining / 60);
          emit('limitWarning', minutesRemaining);
        }

        // Auto-stop when limit reached
        if (remaining <= 0) {
          console.log('Minutes limit reached, auto-stopping recording');
          emit('limitReached');
          return; // Stop the interval, let the caller handle stopping
        }
      }

      // Original auto-split logic for max file duration
      if (elapsed >= MAX_DURATION_SECONDS && !isAutoSplitting.value) {
        await performAutoSplit(recordingStore, isAutoSplitting);
      }
    }
  }, 1000);
}

/**
 * Stop duration tracking
 */
function stopDurationTracking() {
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }
  // Reset limit state
  minutesLimitSeconds = null;
  limitWarningShown = false;
}

/**
 * Get the current minutes limit in seconds
 * @returns {number|null} The limit in seconds, or null if no limit
 */
export function getMinutesLimitSeconds() {
  return minutesLimitSeconds;
}

/**
 * Perform auto-split
 */
async function performAutoSplit(recordingStore, isAutoSplitting) {
  if (isAutoSplitting.value) return;
  isAutoSplitting.value = true;

  // Wait for the store's saveChunk mutex to drain.
  // _chunkSaveQueue is reassigned on each saveChunk, so we snapshot → await → recheck
  // to cover the case where a new saveChunk was queued while we were awaiting.
  const drainChunkQueue = async () => {
    for (let i = 0; i < 3; i++) {
      const q = recordingStore._chunkSaveQueue;
      if (!q) return;
      try { await q; } catch (_) { /* ignore */ }
      if (recordingStore._chunkSaveQueue === q) return; // nothing new queued while awaiting
    }
  };

  try {
    // 1. Drain any in-flight saveChunk from BEFORE we touch the recorder.
    await drainChunkQueue();

    // 2. Flush buffered data while the recorder is still 'recording'.
    //    flushRecordingData early-returns if state !== 'recording', so calling it
    //    AFTER pause() silently does nothing, and any buffered audio would instead
    //    be emitted later as a stale chunk that races with createSessionFile.
    await flushRecordingData();

    // 3. Wait for the flushed chunk to be persisted before pausing.
    await drainChunkQueue();

    // 4. Pause to stop new data being gathered into the blob.
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
    }

    // 5. Final drain in case pause() itself queued a dataavailable
    //    (implementation-defined across browsers).
    await drainChunkQueue();

    // 6. Create the session. Main process serializes createSessionFile with
    //    saveChunk via withRecordingLock, so no late chunk can slip through.
    const result = await recordingStore.createSessionFile();
    if (!result.success) {
      console.error('Auto-split: Failed to create session file:', result.error);
    }

    // 7. Reset chunkIndex AFTER the session was finalized.
    //    Resetting earlier would allow a late saveChunk to overwrite chunk_0
    //    with pre-split audio.
    recordingStore.resetChunkIndex();

    // 8. Resume.
    if (mediaRecorder && mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
    }
  } catch (error) {
    console.error('Error during auto-split:', error);
    // Ensure recording resumes even on error
    if (mediaRecorder && mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
    }
  } finally {
    isAutoSplitting.value = false;
  }
}

/**
 * Verify MediaRecorder state - detects dead recordings
 */
function verifyRecordingState(recordingStore) {
  if (!recordingStore.isRecording && !recordingStore.isPaused) {
    return;
  }

  // Skip if already detected as dead
  if (recordingStore.recordingInterrupted) {
    return;
  }

  const mediaState = mediaRecorder?.state || 'inactive';
  const storeIsRecording = recordingStore.isRecording;

  if (storeIsRecording && mediaState === 'inactive') {
    console.error('CRITICAL: Store says recording but MediaRecorder is inactive!');

    // Stop the duration timer
    stopDurationTracking();

    // Stop verification interval
    if (stateVerificationInterval) {
      clearInterval(stateVerificationInterval);
      stateVerificationInterval = null;
    }

    // Notify store about the death
    recordingStore.handleRecordingDeath({
      reason: 'media_recorder_inactive',
      chunkCount: recordingStore.chunkIndex,
      lastChunkTimestamp: Date.now()
    });

    // Emit event for UI
    emit('recordingDead', {
      reason: 'media_recorder_inactive',
      chunkCount: recordingStore.chunkIndex
    });
  } else if (storeIsRecording && mediaState === 'paused') {
    try {
      mediaRecorder.resume();
    } catch (e) {
      console.error('Could not resume MediaRecorder:', e);
    }
  }
}

/**
 * Start auth keep-alive during recording
 * Ensures session doesn't expire during long recordings
 */
function startAuthKeepAlive(authStore) {
  stopAuthKeepAlive();

  if (authStore && typeof authStore.keepAliveForRecording === 'function') {
    // Initial keep-alive
    authStore.keepAliveForRecording();

    // Periodic keep-alive every 30 minutes
    authKeepAliveInterval = setInterval(() => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        console.log('Auth keep-alive during recording');
        authStore.keepAliveForRecording();
      }
    }, AUTH_KEEP_ALIVE_INTERVAL);

    console.log('Auth keep-alive started for recording');
  }
}

/**
 * Stop auth keep-alive
 */
function stopAuthKeepAlive() {
  if (authKeepAliveInterval) {
    clearInterval(authKeepAliveInterval);
    authKeepAliveInterval = null;
    console.log('Auth keep-alive stopped');
  }
}

/**
 * Start recording
 * @param {Object} options - Recording options
 * @param {Object} options.recordingStore - Recording store instance
 * @param {Object} options.authStore - Auth store instance
 * @param {string} options.deviceId - Microphone device ID
 * @param {boolean} options.systemAudioEnabled - Whether system audio is enabled
 * @param {Function} options.captureSystemAudio - Function to capture system audio
 * @param {Object} options.isAutoSplitting - Ref for auto-splitting state
 * @param {number|null} options.maxRecordingSeconds - Maximum recording duration in seconds (minutes limit)
 */
export async function startRecording(options = {}) {
  // Guard: prevent starting a new recording while one is already active
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    return { success: false, error: 'Recording already in progress' };
  }

  const {
    recordingStore,
    authStore,
    deviceId,
    systemAudioEnabled,
    captureSystemAudio,
    isAutoSplitting,
    maxRecordingSeconds = null
  } = options;

  // Store reference for mid-recording operations (mic switching, etc.)
  recordingStoreRef = recordingStore;

  let sysStream = null;
  try {
    resetMicHealthState();
    clearSilenceWarning();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access is not available.');
    }

    // Start system audio capture:
    // - macOS: AudioTee writes PCM to file, merged via FFmpeg in combineChunks (returns true)
    // - Windows: desktopCapturer returns a MediaStream for real-time mixing
    let audioTeeActive = false;
    if (systemAudioEnabled && captureSystemAudio) {
      try {
        const result = await captureSystemAudio(recordingStore.recordId);
        if (!result) {
          emit('systemAudioError', 'System audio capture could not start');
        } else if (result instanceof MediaStream) {
          // Windows: desktopCapturer returns a stream to mix in renderer
          sysStream = result;
        } else {
          // macOS: result is true, AudioTee handles file-based capture
          audioTeeActive = true;
        }
      } catch (e) {
        console.warn('Could not start system audio capture:', e);
        emit('systemAudioError', e.message || 'System audio capture failed');
      }
    }

    // Capture microphone with a strict -> relaxed -> generic fallback ladder.
    const strictConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 48000
    };
    if (deviceId) {
      strictConstraints.deviceId = { exact: deviceId };
    }

    const fallbackConstraints = [];
    if (deviceId) {
      fallbackConstraints.push({
        noiseSuppression: true,
        deviceId: { ideal: deviceId }
      });
    }
    fallbackConstraints.push({
      noiseSuppression: true
    });
    fallbackConstraints.push(true);

    let micCaptureError = null;
    const captureAttempts = [strictConstraints, ...fallbackConstraints];
    for (const candidate of captureAttempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: candidate
        });
        break;
      } catch (candidateError) {
        micCaptureError = candidateError;
        console.warn('Microphone capture attempt failed:', candidateError.name, candidateError.message);
      }
    }

    if (!stream) {
      if (sysStream || audioTeeActive) {
        let micErrorMsg = micCaptureError?.message || 'No microphone available';
        if (micCaptureError?.name === 'NotReadableError') {
          micErrorMsg = 'Microphone is in use by another application. Recording with system audio only.';
        } else if (micCaptureError?.name === 'OverconstrainedError') {
          micErrorMsg = 'Microphone does not support required settings. Recording with system audio only.';
        } else {
          micErrorMsg = 'No microphone detected. Recording with system audio only.';
        }

        emit('micError', micErrorMsg);
        updateMicHealthState(
          MIC_HEALTH_STATUS.CRITICAL,
          MIC_HEALTH_REASON.MIC_CAPTURE_FAILED,
          micErrorMsg,
          {
            micActive: false,
            systemAudioActive: true,
            inputDeviceId: deviceId || null
          }
        );
        setSilenceWarning(micHealthState.message);
      } else if (micCaptureError) {
        throw micCaptureError;
      } else {
        throw new Error('No microphone stream available.');
      }
    } else {
      updateMicHealthTrackDetails(stream, deviceId);
      if (sysStream) {
        updateMicHealthState(
          micHealthState.status,
          micHealthState.reasonCode,
          micHealthState.message,
          { systemAudioActive: true }
        );
      }
    }

    // Start recording session in store (pass userId for multi-account handling)
    const userId = authStore?.user?.id || null;
    const sessionResult = await recordingStore.startRecording(userId);
    if (!sessionResult.success) {
      throw new Error(sessionResult.error || 'Failed to create recording session');
    }

    // Reset mute state for new recording
    micMuted = false;

    // Always use mixing pipeline so system audio can be added/removed dynamically
    // If no mic and no sysStream (macOS AudioTee-only), the pipeline creates a silent
    // placeholder — AudioTee output is merged via FFmpeg in combineChunks
    const recordingStream = createMixingPipeline(stream, sysStream);
    mixedStream = recordingStream;

    // Resume AudioContext if suspended (suspended contexts produce silence)
    if (mixingContext && mixingContext.state === 'suspended') {
      await mixingContext.resume();
    }

    // Determine supported mime type
    const codecPreference = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/aac',
      'audio/3gpp',
      ''
    ];

    let mimeType = '';
    for (const codec of codecPreference) {
      if (codec === '' || MediaRecorder.isTypeSupported(codec)) {
        mimeType = codec;
        break;
      }
    }

    const recorderOptions = mimeType ? { mimeType } : {};
    mediaRecorder = new MediaRecorder(recordingStream, recorderOptions);

    // Handle data available
    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        try {
          const arrayBuffer = await event.data.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          const result = await recordingStore.saveChunk(Array.from(uint8Array));

          // P0 Data Loss Fix: Check saveChunk return value (V1/V7)
          if (result && !result.success) {
            recordingStore.chunkSaveErrors++;
            console.error('Chunk save failed:', result.error, `(${recordingStore.chunkSaveErrors} consecutive failures)`);

            // Disk full: emergency stop immediately
            if (result.diskFull) {
              emit('chunkSaveFailure', {
                consecutiveErrors: recordingStore.chunkSaveErrors,
                error: 'Disk full — recording stopped to preserve saved data',
                diskFull: true
              });
            } else if (!recordingStore.chunkSaveErrorWarning) {
              // Emit warning on first failure so user knows immediately
              recordingStore.chunkSaveErrorWarning = true;
              emit('chunkSaveFailure', {
                consecutiveErrors: recordingStore.chunkSaveErrors,
                error: result.error
              });
            }

            // Still resolve pending flushes so pause/close don't hang
            if (flushResolvers.length > 0) {
              const resolvers = flushResolvers;
              flushResolvers = [];
              resolvers.forEach(resolve => resolve());
            }
            return;
          } else {
            // Reset consecutive error counter on success
            if (recordingStore.chunkSaveErrors > 0) {
              recordingStore.chunkSaveErrors = 0;
              if (recordingStore.chunkSaveErrorWarning) {
                recordingStore.chunkSaveErrorWarning = false;
                emit('chunkSaveFailure', null); // Clear warning
              }
            }
          }
        } catch (error) {
          console.error('Error saving chunk:', error);
          recordingStore.chunkSaveErrors++;
          if (!recordingStore.chunkSaveErrorWarning) {
            recordingStore.chunkSaveErrorWarning = true;
            emit('chunkSaveFailure', {
              consecutiveErrors: recordingStore.chunkSaveErrors,
              error: error.message
            });
          }
          // Still resolve pending flushes so pause/close don't hang
          if (flushResolvers.length > 0) {
            const resolvers = flushResolvers;
            flushResolvers = [];
            resolvers.forEach(resolve => resolve());
          }
          return;
        }
      }
      // Signal flush completion to all pending flush callers (only on success)
      if (flushResolvers.length > 0) {
        const resolvers = flushResolvers;
        flushResolvers = [];
        resolvers.forEach(resolve => resolve());
      }
    };

    mediaRecorder.onstop = () => {
      console.log('MediaRecorder stopped');
    };

    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
      recordingStore.setError(event.error?.message || 'Recording error');
    };

    // P0 Data Loss Fix: Reduced from 5s to 3s to minimize crash data loss (V8).
    // Timeslice is overridable in dev/test via VITE_SUISSE_MEDIA_RECORDER_TIMESLICE_MS.
    mediaRecorder.start(MEDIA_RECORDER_TIMESLICE_MS);

    // Start monitoring the mixed recording stream (what actually gets recorded)
    if (stream || sysStream) {
      startLevelMonitoring(recordingStream, stream, recordingStore);
    }
    startDurationTracking(recordingStore, isAutoSplitting, maxRecordingSeconds);

    // Show notification on Android
    await showRecordingNotification();

    // Add track.onended listeners for faster death detection
    const recordingTracks = recordingStream.getTracks();
    for (const track of recordingTracks) {
      track.onended = () => {
        console.warn('Recording track ended unexpectedly:', track.kind);
        verifyRecordingState(recordingStore);
      };
    }
    // Also monitor mic stream tracks
    // Grace period before declaring death — Bluetooth codec switches (A2DP→SCO)
    // can briefly end the track before a new one becomes available
    if (stream) {
      for (const track of stream.getTracks()) {
        track.onended = () => {
          console.warn('Mic track ended unexpectedly:', track.kind, '— waiting 3s before declaring critical');
          updateMicHealthState(
            MIC_HEALTH_STATUS.DEGRADED,
            MIC_HEALTH_REASON.TRACK_ENDED,
            null,
            {
              micActive: false,
              systemAudioActive
            }
          );
          // Grace period: check after 3s if a replacement device appeared
          setTimeout(() => {
            // If recording was stopped during the grace period, skip
            if (!recordingStore.isRecording) return;
            // If health recovered (e.g., statechange listener resumed context), skip
            if (micHealthState.status === MIC_HEALTH_STATUS.OK) return;

            console.warn('Mic track still dead after grace period — declaring critical');
            updateMicHealthState(
              MIC_HEALTH_STATUS.CRITICAL,
              MIC_HEALTH_REASON.TRACK_ENDED,
              null,
              {
                micActive: false,
                systemAudioActive
              }
            );
            setSilenceWarning(micHealthState.message);
            verifyRecordingState(recordingStore);
          }, 3000);
        };
      }
    }

    // Start state verification (every 5s)
    stateVerificationInterval = setInterval(() => {
      verifyRecordingState(recordingStore);
    }, 5000);

    // Start auth keep-alive to prevent session expiry during long recordings
    if (authStore) {
      startAuthKeepAlive(authStore);
    }

    emit('stateChange', { isRecording: true, isPaused: false });

    return { success: true };
  } catch (error) {
    console.error('Error starting recording:', error);

    stopLevelMonitoring();

    stopDurationTracking();

    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
    if (mixedStream) {
      mixedStream.getTracks().forEach(track => track.stop());
      mixedStream = null;
    }
    if (mixingContext) {
      mixingContext.close().catch(() => {});
      mixingContext = null;
    }
    mixingDest = null;
    micSourceNode = null;
    systemSourceNode = null;
    systemStream = null;
    systemAudioActive = false;
    micMuted = false;
    resetMicHealthState();
    clearSilenceWarning();

    // Clean up system audio if it was captured before the error
    if (sysStream) {
      sysStream.getTracks().forEach(track => track.stop());
    }

    let errorMessage = error.message;
    if (error.name === 'NotAllowedError') {
      const isWindows = navigator.userAgent.includes('Windows');
      errorMessage = isWindows
        ? 'Microphone access denied. Check Windows Settings > Privacy & Security > Microphone and ensure "Let desktop apps access your microphone" is enabled.'
        : 'Microphone access denied.';
    } else if (error.name === 'NotFoundError') {
      errorMessage = 'No microphone found.';
    } else if (error.name === 'NotReadableError') {
      errorMessage = 'Microphone is in use by another application. Try closing Teams/Zoom or selecting a different microphone.';
    } else if (error.name === 'OverconstrainedError') {
      errorMessage = 'Selected microphone does not support required settings. Try a different microphone.';
    }

    recordingStore.reset();
    return { success: false, error: errorMessage };
  }
}

/**
 * Pause recording
 */
export function pauseRecording(recordingStore) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    recordingStore.pauseRecording();
    stopDurationTracking();
    emit('stateChange', { isRecording: false, isPaused: true });
  }
}

/**
 * Resume recording
 * @param {Object} recordingStore - Recording store instance
 * @param {Object} isAutoSplitting - Ref for auto-splitting state
 * @param {number|null} maxRecordingSeconds - Maximum recording duration in seconds (minutes limit)
 */
export function resumeRecording(recordingStore, isAutoSplitting, maxRecordingSeconds = null) {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    recordingStore.resumeRecording();

    const currentDuration = recordingStore.duration;
    const resumeTime = Date.now();

    // Update limit if provided, otherwise keep existing
    if (maxRecordingSeconds !== null) {
      minutesLimitSeconds = maxRecordingSeconds;
    }
    // Reset warning flag on resume in case we paused after warning
    limitWarningShown = false;

    // Defensively clear any existing interval to prevent dual timers
    if (durationInterval) {
      clearInterval(durationInterval);
      durationInterval = null;
    }

    durationInterval = setInterval(async () => {
      if (recordingStore.isRecording) {
        const elapsed = Math.floor((Date.now() - resumeTime) / 1000);
        const newDuration = currentDuration + elapsed;
        recordingStore.updateDuration(newDuration);
        emit('durationChange', newDuration);

        // Check minutes limit (if set)
        if (minutesLimitSeconds !== null && minutesLimitSeconds > 0) {
          const remaining = minutesLimitSeconds - newDuration;

          // Warning at 5 minutes (or less) before limit
          if (remaining <= LIMIT_WARNING_SECONDS && remaining > 0 && !limitWarningShown) {
            limitWarningShown = true;
            const minutesRemaining = Math.ceil(remaining / 60);
            emit('limitWarning', minutesRemaining);
          }

          // Auto-stop when limit reached
          if (remaining <= 0) {
            console.log('Minutes limit reached, auto-stopping recording');
            emit('limitReached');
            return;
          }
        }

        // Original auto-split logic
        if (newDuration >= MAX_DURATION_SECONDS && !isAutoSplitting.value) {
          await performAutoSplit(recordingStore, isAutoSplitting);
        }
      }
    }, 1000);

    emit('stateChange', { isRecording: true, isPaused: false });
  }
}

/**
 * Stop recording
 */
export async function stopRecording(recordingStore, stopSystemAudio) {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve) => {
    // Handle case where MediaRecorder was lost
    if (!mediaRecorder) {
      if (recordingStore.recordId && recordingStore.chunkIndex > 0) {
        console.warn('MediaRecorder lost but chunks exist - attempting recovery');
        silenceError = null;
        stopLevelMonitoring();
    
        stopDurationTracking();
        stopAuthKeepAlive();

        if (stateVerificationInterval) {
          clearInterval(stateVerificationInterval);
          stateVerificationInterval = null;
        }

        if (stream) {
          stream.getTracks().forEach(track => track.stop());
          stream = null;
        }
        if (mixedStream) {
          mixedStream.getTracks().forEach(track => track.stop());
          mixedStream = null;
        }
        if (systemStream) {
          systemStream.getTracks().forEach(track => track.stop());
          systemStream = null;
        }
        if (mixingContext) {
          mixingContext.close().catch(() => {});
          mixingContext = null;
        }
        mixingDest = null;
        micSourceNode = null;
        systemSourceNode = null;
        systemAudioActive = false;
        micMuted = false;
        resetMicHealthState();
        clearSilenceWarning();
        if (stopSystemAudio) stopSystemAudio();

        // Hide notification on Android
        await hideRecordingNotification();

        const result = await recordingStore.stopRecording();
        emit('stateChange', { isRecording: false, isPaused: false });

        if (result.success) {
          resolve({
            success: true,
            filePath: result.filePath,
            warning: 'Recording recovered after interruption.',
            recovered: true
          });
        } else {
          resolve({
            success: false,
            error: 'Recording interrupted. ' + (result.error || ''),
            partialRecovery: recordingStore.chunkIndex > 0
          });
        }
        return;
      }

      // Hide notification on Android
      await hideRecordingNotification();
      resetMicHealthState();
      clearSilenceWarning();
      resolve({ success: false, error: 'No active recording' });
      return;
    }

    let finalChunkSavedResolve;
    const finalChunkSaved = new Promise(r => {
      finalChunkSavedResolve = r;
      // Timeout: if ondataavailable never fires after stop(), don't hang forever
      setTimeout(() => {
        console.warn('Final chunk save timed out after 5s — proceeding with available data');
        r();
      }, 5000);
    });

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        try {
          const arrayBuffer = await event.data.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          const result = await recordingStore.saveChunk(Array.from(uint8Array));
          if (result && !result.success) {
            console.error('Final chunk save failed:', result.error);
          }
        } catch (error) {
          console.error('Error saving final chunk:', error);
        }
      }
      finalChunkSavedResolve();
    };

    mediaRecorder.onstop = async () => {
      await finalChunkSaved;
      await new Promise(r => setTimeout(r, 100));

      stopLevelMonitoring();
  
      stopDurationTracking();
      stopAuthKeepAlive();

      if (stateVerificationInterval) {
        clearInterval(stateVerificationInterval);
        stateVerificationInterval = null;
      }

      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }
      if (mixedStream) {
        mixedStream.getTracks().forEach(track => track.stop());
        mixedStream = null;
      }
      if (systemStream) {
        systemStream.getTracks().forEach(track => track.stop());
        systemStream = null;
      }
      if (mixingContext) {
        mixingContext.close().catch(() => {});
        mixingContext = null;
      }
      mixingDest = null;
      micSourceNode = null;
      systemSourceNode = null;
      systemAudioActive = false;
      micMuted = false;
      resetMicHealthState();
      clearSilenceWarning();
      if (stopSystemAudio) stopSystemAudio();

      mediaRecorder = null;
      resetMicHealthState();
      clearSilenceWarning();
      emit('stateChange', { isRecording: false, isPaused: false });

      // Hide notification on Android
      await hideRecordingNotification();

      const result = await recordingStore.stopRecording();
      resolve(result);
    };

    if (mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.requestData();
        mediaRecorder.stop();
      } catch (stopError) {
        console.error('MediaRecorder stop/requestData failed:', stopError);
        // Force cleanup and resolve — don't let the promise hang
        finalChunkSavedResolve();
        cleanup();
        mediaRecorder = null;
        const result = await recordingStore.stopRecording();
        resolve(result);
        return;
      }
    } else {
      stopLevelMonitoring();
  
      stopDurationTracking();
      stopAuthKeepAlive();

      if (stateVerificationInterval) {
        clearInterval(stateVerificationInterval);
        stateVerificationInterval = null;
      }

      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }

      mediaRecorder = null;
      resetMicHealthState();
      clearSilenceWarning();
      emit('stateChange', { isRecording: false, isPaused: false });

      // Hide notification on Android
      await hideRecordingNotification();

      recordingStore.stopRecording().then(resolve);
    }
  });
}

/**
 * Cancel recording - stops MediaRecorder and cleans up without combining chunks
 * Used when user wants to discard the recording entirely
 */
export async function cancelRecording(recordingStore, stopSystemAudio) {
  // Stop level monitoring, duration tracking, auth keepalive
  stopLevelMonitoring();
  stopDurationTracking();
  stopAuthKeepAlive();

  if (stateVerificationInterval) {
    clearInterval(stateVerificationInterval);
    stateVerificationInterval = null;
  }

  // Stop MediaRecorder without waiting for final chunk
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    // Remove handlers to avoid processing the final chunk
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    try {
      mediaRecorder.stop();
    } catch (e) {
      // Ignore errors from stopping
    }
  }
  mediaRecorder = null;

  // Clean up all audio streams and contexts
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  if (mixedStream) {
    mixedStream.getTracks().forEach(track => track.stop());
    mixedStream = null;
  }
  if (systemStream) {
    systemStream.getTracks().forEach(track => track.stop());
    systemStream = null;
  }
  if (mixingContext) {
    mixingContext.close().catch(() => {});
    mixingContext = null;
  }
  mixingDest = null;
  micSourceNode = null;
  systemSourceNode = null;
  systemAudioActive = false;
  micMuted = false;
  resetMicHealthState();
  clearSilenceWarning();

  if (stopSystemAudio) stopSystemAudio();

  emit('stateChange', { isRecording: false, isPaused: false });

  // Hide notification on Android
  await hideRecordingNotification();

  // Mark recording as no longer in progress (Electron)
  if (recordingStore && window.electronAPI?.recording) {
    try {
      await window.electronAPI.recording.setInProgress(false);
      await window.electronAPI.recording.setProcessing(false);
    } catch (e) {
      // Ignore
    }
  }
}

/**
 * Flush recording data (for visibility changes / suspend)
 * Returns a Promise that resolves when the flushed chunk has been saved,
 * with a 2-second timeout fallback.
 * @returns {Promise<{flushed: boolean, timedOut: boolean}>}
 */
export async function flushRecordingData() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try {
      let didTimeout = false;
      const chunkSaved = new Promise((resolve) => {
        flushResolvers.push(resolve);
        // Timeout fallback: resolve after 2s even if ondataavailable hasn't fired
        setTimeout(() => {
          const idx = flushResolvers.indexOf(resolve);
          if (idx !== -1) {
            flushResolvers.splice(idx, 1);
            didTimeout = true;
            resolve();
          }
        }, 2000);
      });
      mediaRecorder.requestData();
      await chunkSaved;
      // P2 Fix: Report whether flush actually produced data or timed out
      if (didTimeout) {
        console.warn('Flush timed out after 2s without ondataavailable');
      }
      return { flushed: !didTimeout, timedOut: didTimeout };
    } catch (e) {
      console.warn('Could not flush recording data:', e);
      return { flushed: false, timedOut: false };
    }
  }
  return { flushed: false, timedOut: false };
}

/**
 * Check if recording is active
 */
export function isActive() {
  return mediaRecorder !== null && mediaRecorder.state !== 'inactive';
}

/**
 * Clean up all resources (only call when intentionally stopping)
 */
export function cleanup(stopSystemAudio) {
  stopLevelMonitoring();
  stopDurationTracking();
  stopAuthKeepAlive();

  if (stateVerificationInterval) {
    clearInterval(stateVerificationInterval);
    stateVerificationInterval = null;
  }

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  if (mixedStream) {
    mixedStream.getTracks().forEach(track => track.stop());
    mixedStream = null;
  }
  if (systemStream) {
    systemStream.getTracks().forEach(track => track.stop());
    systemStream = null;
  }
  if (mixingContext) {
    mixingContext.close().catch(() => {});
    mixingContext = null;
  }
  mixingDest = null;
  micSourceNode = null;
  systemSourceNode = null;
  systemAudioActive = false;
  micMuted = false;
  resetMicHealthState();
  clearSilenceWarning();
  if (stopSystemAudio) stopSystemAudio();

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  emit('stateChange', { isRecording: false, isPaused: false });
}

