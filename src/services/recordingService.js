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
let audioContext = null;
let analyser = null;
let stream = null;
let mixedStream = null;
let mixingContext = null;
let mixingDest = null;
let micSourceNode = null;
let systemSourceNode = null;
let systemStream = null;
let durationInterval = null;
let levelInterval = null;
let stateVerificationInterval = null;

// System audio state (persists across navigation)
let systemAudioActive = false;

// Mic mute state
let micMuted = false;

// Flush synchronization: resolved when ondataavailable saves the chunk after a flush request
let flushResolvers = [];

// Silence detection state
let silenceCounter = 0;
let silenceWarningShown = false;
let silenceError = null;

// Configuration
const SILENCE_THRESHOLD = 1;
const SILENCE_WARNING_SECONDS = 10;
const MAX_DURATION_SECONDS = 4 * 60 * 60 + 55 * 60; // 4h 55m
const AUTH_KEEP_ALIVE_INTERVAL = 30 * 60 * 1000; // Refresh auth every 30 min during recording

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
    micMuted
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

  micSourceNode = ctx.createMediaStreamSource(micStream);
  micSourceNode.connect(dest);

  if (sysStream) {
    systemSourceNode = ctx.createMediaStreamSource(sysStream);
    systemSourceNode.connect(dest);
    systemStream = sysStream;
    systemAudioActive = true;
  }

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
    console.log('System audio removed from recording mix');
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

  // Reset silence detection when intentionally muted to avoid false warnings
  if (micMuted) {
    silenceCounter = 0;
    silenceWarningShown = false;
    if (silenceError) {
      silenceError = null;
      emit('silenceWarning', null);
    }
  }

  console.log('Mic mute:', micMuted);
  return micMuted;
}

/**
 * Start audio level monitoring with silence detection
 */
function startLevelMonitoring(mediaStream, recordingStore) {
  // Defensively clean up any existing monitoring
  stopLevelMonitoring();

  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(analyser);

    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    silenceCounter = 0;
    silenceWarningShown = false;
    silenceError = null;

    levelInterval = setInterval(async () => {
      if (analyser && recordingStore.isRecording) {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
        currentAudioLevel = Math.min(100, (average / 128) * 100);

        // Emit level update
        emit('levelChange', currentAudioLevel);

        // Silence detection (suppress when mic is intentionally muted)
        if (currentAudioLevel < SILENCE_THRESHOLD && !micMuted) {
          silenceCounter++;
          const silenceSeconds = silenceCounter / 10;

          if (silenceSeconds >= SILENCE_WARNING_SECONDS && !silenceWarningShown) {
            silenceWarningShown = true;
            silenceError = 'No audio detected - check if your microphone is connected and not muted';
            emit('silenceWarning', silenceError);
          }
        } else {
          if (silenceCounter > 0) {
            silenceCounter = 0;
            silenceWarningShown = false;
            silenceError = null;
            emit('silenceWarning', null);
          }
        }
      }
    }, 100);
  } catch (error) {
    console.warn('Could not start audio level monitoring:', error);
  }
}

/**
 * Stop audio level monitoring
 */
function stopLevelMonitoring() {
  if (levelInterval) {
    clearInterval(levelInterval);
    levelInterval = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  analyser = null;
  currentAudioLevel = 0;
  silenceCounter = 0;
  silenceWarningShown = false;
  silenceError = null;
  emit('levelChange', 0);
  emit('silenceWarning', null);
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

  try {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.requestData();
    }

    await new Promise(r => setTimeout(r, 1000));
    const result = await recordingStore.createSessionFile();
    if (!result.success) {
      console.error('Auto-split: Failed to create session file:', result.error);
    }
    recordingStore.resetChunkIndex();
  } catch (error) {
    console.error('Error during auto-split:', error);
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
  const {
    recordingStore,
    authStore,
    deviceId,
    systemAudioEnabled,
    captureSystemAudio,
    isAutoSplitting,
    maxRecordingSeconds = null
  } = options;

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access is not available.');
    }

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 48000
    };

    if (deviceId) {
      audioConstraints.deviceId = { exact: deviceId };
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints
    });

    // Start recording session in store (pass userId for multi-account handling)
    const userId = authStore?.user?.id || null;
    const sessionResult = await recordingStore.startRecording(userId);
    if (!sessionResult.success) {
      throw new Error(sessionResult.error || 'Failed to create recording session');
    }

    // Reset mute state for new recording
    micMuted = false;

    // Capture system audio if enabled
    let sysStream = null;
    if (systemAudioEnabled && captureSystemAudio) {
      try {
        sysStream = await captureSystemAudio();
      } catch (e) {
        console.warn('Could not capture system audio:', e);
      }
    }

    // Always use mixing pipeline so system audio can be added/removed dynamically
    const recordingStream = createMixingPipeline(stream, sysStream);
    mixedStream = recordingStream;

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
          await recordingStore.saveChunk(Array.from(uint8Array));
        } catch (error) {
          console.error('Error saving chunk:', error);
        }
      }
      // Signal flush completion to all pending flush callers
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

    mediaRecorder.start(5000);

    // Start monitoring
    startLevelMonitoring(stream, recordingStore);
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
    if (stream) {
      for (const track of stream.getTracks()) {
        track.onended = () => {
          console.warn('Mic track ended unexpectedly:', track.kind);
          verifyRecordingState(recordingStore);
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

    let errorMessage = error.message;
    if (error.name === 'NotAllowedError') {
      errorMessage = 'Microphone access denied.';
    } else if (error.name === 'NotFoundError') {
      errorMessage = 'No microphone found.';
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
      resolve({ success: false, error: 'No active recording' });
      return;
    }

    let finalChunkSavedResolve;
    const finalChunkSaved = new Promise(r => { finalChunkSavedResolve = r; });

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        try {
          const arrayBuffer = await event.data.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          await recordingStore.saveChunk(Array.from(uint8Array));
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
      if (stopSystemAudio) stopSystemAudio();

      mediaRecorder = null;
      emit('stateChange', { isRecording: false, isPaused: false });

      // Hide notification on Android
      await hideRecordingNotification();

      const result = await recordingStore.stopRecording();
      resolve(result);
    };

    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.requestData();
      mediaRecorder.stop();
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
      emit('stateChange', { isRecording: false, isPaused: false });

      // Hide notification on Android
      await hideRecordingNotification();

      recordingStore.stopRecording().then(resolve);
    }
  });
}

/**
 * Flush recording data (for visibility changes / suspend)
 * Returns a Promise that resolves when the flushed chunk has been saved,
 * with a 2-second timeout fallback.
 */
export async function flushRecordingData() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try {
      const chunkSaved = new Promise((resolve) => {
        flushResolvers.push(resolve);
        // Timeout fallback: resolve after 2s even if ondataavailable hasn't fired
        setTimeout(() => {
          const idx = flushResolvers.indexOf(resolve);
          if (idx !== -1) {
            flushResolvers.splice(idx, 1);
            resolve();
          }
        }, 2000);
      });
      mediaRecorder.requestData();
      await chunkSaved;
    } catch (e) {
      console.warn('Could not flush recording data:', e);
    }
  }
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
  if (stopSystemAudio) stopSystemAudio();

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  emit('stateChange', { isRecording: false, isPaused: false });
}
