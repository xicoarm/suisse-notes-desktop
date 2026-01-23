import { ref, onUnmounted, onMounted } from 'vue';
import { useRecordingStore } from '../stores/recording';
import { useSystemAudio } from './useSystemAudio';
import { isElectron, isCapacitor, isMobile } from '../utils/platform';

/**
 * Platform-aware recorder composable
 * Uses MediaRecorder on desktop (Electron) and native plugins on mobile (Capacitor)
 */
export function useRecorder() {
  // On mobile, delegate to native recorder
  if (isMobile()) {
    const { useNativeRecorder } = require('./useRecorder.native');
    return useNativeRecorder();
  }

  // Desktop implementation follows
  const recordingStore = useRecordingStore();

  // System audio composable
  const {
    systemAudioEnabled,
    permissionStatus,
    captureSystemAudio,
    stopCapture: stopSystemAudio,
    loadState: loadSystemAudioState,
    setEnabled: setSystemAudioEnabled
  } = useSystemAudio();

  const mediaRecorder = ref(null);
  const audioContext = ref(null);
  const analyser = ref(null);
  const audioLevel = ref(0);
  const stream = ref(null);
  const mixedStream = ref(null);  // Combined mic + system audio stream
  const mixingContext = ref(null);  // AudioContext for mixing
  const durationInterval = ref(null);
  const levelInterval = ref(null);

  // Auto-split configuration
  const MAX_DURATION_SECONDS = 4 * 60 * 60 + 55 * 60; // 4h 55m = 17,700 seconds
  const isAutoSplitting = ref(false); // Flag to prevent multiple splits

  // Microphone selection
  const availableMicrophones = ref([]);
  const selectedMicrophoneId = ref('');
  const loadingMicrophones = ref(false);

  // Load available microphones
  const loadMicrophones = async () => {
    loadingMicrophones.value = true;
    try {
      // Request permission first to get labeled devices
      await navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => stream.getTracks().forEach(track => track.stop()));

      const devices = await navigator.mediaDevices.enumerateDevices();
      availableMicrophones.value = devices
        .filter(device => device.kind === 'audioinput')
        .map(device => ({
          id: device.deviceId,
          label: device.label || `Microphone ${device.deviceId.slice(0, 8)}...`
        }));

      // Select first microphone if none selected
      if (availableMicrophones.value.length > 0 && !selectedMicrophoneId.value) {
        selectedMicrophoneId.value = availableMicrophones.value[0].id;
      }
    } catch (error) {
      console.error('Error loading microphones:', error);
    } finally {
      loadingMicrophones.value = false;
    }
  };

  // Refresh microphones when devices change
  const setupDeviceChangeListener = () => {
    navigator.mediaDevices.addEventListener('devicechange', loadMicrophones);
  };

  // Audio level monitoring
  const startLevelMonitoring = (mediaStream) => {
    try {
      audioContext.value = new (window.AudioContext || window.webkitAudioContext)();
      analyser.value = audioContext.value.createAnalyser();
      const source = audioContext.value.createMediaStreamSource(mediaStream);
      source.connect(analyser.value);

      analyser.value.fftSize = 256;
      const bufferLength = analyser.value.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      levelInterval.value = setInterval(() => {
        if (analyser.value && recordingStore.isRecording) {
          analyser.value.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
          audioLevel.value = Math.min(100, (average / 128) * 100);
        }
      }, 100);
    } catch (error) {
      console.warn('Could not start audio level monitoring:', error);
    }
  };

  const stopLevelMonitoring = () => {
    if (levelInterval.value) {
      clearInterval(levelInterval.value);
      levelInterval.value = null;
    }
    if (audioContext.value) {
      audioContext.value.close().catch(() => {});
      audioContext.value = null;
    }
    analyser.value = null;
    audioLevel.value = 0;
  };

  // Auto-split function - creates session file and resets for continued recording
  const performAutoSplit = async () => {
    if (isAutoSplitting.value) return;
    isAutoSplitting.value = true;

    console.log('Auto-split triggered at 4h 55m, creating session file...');

    try {
      // 1. Request final data from MediaRecorder to flush current chunk
      if (mediaRecorder.value && mediaRecorder.value.state === 'recording') {
        mediaRecorder.value.requestData();
      }

      // 2. Wait for chunk to be saved
      await new Promise(r => setTimeout(r, 1000));

      // 3. Create session file from current chunks
      const result = await recordingStore.createSessionFile();
      if (!result.success) {
        console.error('Auto-split: Failed to create session file:', result.error);
      } else {
        console.log('Auto-split: Session file created successfully');
      }

      // 4. Reset chunk index for new session
      recordingStore.resetChunkIndex();

      console.log('Auto-split complete, continuing recording...');
    } catch (error) {
      console.error('Error during auto-split:', error);
    } finally {
      isAutoSplitting.value = false;
    }
  };

  // Duration tracking
  const startDurationTracking = () => {
    const startTime = Date.now();

    durationInterval.value = setInterval(async () => {
      if (recordingStore.isRecording) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        recordingStore.updateDuration(elapsed);

        // Check for auto-split at 4h 55m
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

  // Mix microphone and system audio streams using Web Audio API
  const mixStreams = (micStream, systemStream) => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    });
    const dest = ctx.createMediaStreamDestination();

    // Connect microphone stream
    const micSource = ctx.createMediaStreamSource(micStream);
    micSource.connect(dest);

    // Connect system audio stream if available
    if (systemStream) {
      const systemSource = ctx.createMediaStreamSource(systemStream);
      systemSource.connect(dest);
    }

    mixingContext.value = ctx;
    return dest.stream;
  };

  // Start recording
  const startRecording = async (deviceId = null) => {
    try {
      // Build audio constraints with optional device selection
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000
      };

      // Use provided deviceId, or the selected one, or default
      const micId = deviceId || selectedMicrophoneId.value;
      if (micId) {
        audioConstraints.deviceId = { exact: micId };
      }

      // Request microphone access
      stream.value = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints
      });

      // Capture system audio if enabled
      let systemStream = null;
      if (systemAudioEnabled.value) {
        try {
          systemStream = await captureSystemAudio();
          if (systemStream) {
            console.log('System audio captured, will mix with microphone');
          }
        } catch (e) {
          console.warn('Could not capture system audio, continuing with mic only:', e);
          // Continue with mic-only recording
        }
      }

      // Determine recording stream (mixed or mic-only)
      let recordingStream;
      if (systemStream) {
        recordingStream = mixStreams(stream.value, systemStream);
        mixedStream.value = recordingStream;
        console.log('Using mixed audio stream (mic + system)');
      } else {
        recordingStream = stream.value;
        console.log('Using microphone only');
      }

      // Start the recording session in the store
      const sessionResult = await recordingStore.startRecording();
      if (!sessionResult.success) {
        throw new Error(sessionResult.error || 'Failed to create recording session');
      }

      // Determine supported mime type
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'audio/ogg;codecs=opus';
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = ''; // Let browser choose
          }
        }
      }

      // Create MediaRecorder with the appropriate stream (mixed or mic-only)
      const options = mimeType ? { mimeType } : {};
      mediaRecorder.value = new MediaRecorder(recordingStream, options);

      // Handle data available event - save chunks every 30 seconds
      mediaRecorder.value.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          try {
            const arrayBuffer = await event.data.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            await recordingStore.saveChunk(Array.from(uint8Array));
          } catch (error) {
            console.error('Error saving chunk:', error);
          }
        }
      };

      // Handle recording stop
      mediaRecorder.value.onstop = () => {
        console.log('MediaRecorder stopped');
      };

      // Handle errors
      mediaRecorder.value.onerror = (event) => {
        console.error('MediaRecorder error:', event.error);
        recordingStore.setError(event.error?.message || 'Recording error');
      };

      // Start recording with 5-second timeslice for more frequent chunk saves
      // This ensures we capture data even for short recordings
      mediaRecorder.value.start(5000);

      // Start monitoring
      startLevelMonitoring(stream.value);
      startDurationTracking();

      return { success: true };
    } catch (error) {
      console.error('Error starting recording:', error);

      let errorMessage = error.message;
      if (error.name === 'NotAllowedError') {
        errorMessage = 'Microphone access denied. Please allow microphone access and try again.';
      } else if (error.name === 'NotFoundError') {
        errorMessage = 'No microphone found. Please connect a microphone and try again.';
      }

      recordingStore.setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  // Pause recording
  const pauseRecording = () => {
    if (mediaRecorder.value && mediaRecorder.value.state === 'recording') {
      mediaRecorder.value.pause();
      recordingStore.pauseRecording();
      stopDurationTracking();
    }
  };

  // Resume recording
  const resumeRecording = () => {
    if (mediaRecorder.value && mediaRecorder.value.state === 'paused') {
      mediaRecorder.value.resume();
      recordingStore.resumeRecording();

      // Continue duration tracking from where we left off
      const currentDuration = recordingStore.duration;
      const resumeTime = Date.now();

      durationInterval.value = setInterval(() => {
        if (recordingStore.isRecording) {
          const elapsed = Math.floor((Date.now() - resumeTime) / 1000);
          recordingStore.updateDuration(currentDuration + elapsed);
        }
      }, 1000);
    }
  };

  // Stop recording
  const stopRecording = async () => {
    return new Promise((resolve) => {
      if (!mediaRecorder.value) {
        resolve({ success: false, error: 'No active recording' });
        return;
      }

      // Promise to track when final chunk is saved
      let finalChunkSavedResolve;
      const finalChunkSaved = new Promise(r => { finalChunkSavedResolve = r; });

      // Override ondataavailable to capture final chunk
      mediaRecorder.value.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          try {
            const arrayBuffer = await event.data.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            await recordingStore.saveChunk(Array.from(uint8Array));
            console.log('Final chunk saved, size:', event.data.size);
          } catch (error) {
            console.error('Error saving final chunk:', error);
          }
        }
        // Signal that final chunk processing is complete
        finalChunkSavedResolve();
      };

      // Set up handler for when recording actually stops
      mediaRecorder.value.onstop = async () => {
        // CRITICAL: Wait for the final chunk to be saved before combining
        // ondataavailable is async, so we must wait for it to complete
        await finalChunkSaved;

        // Small additional delay to ensure filesystem sync
        await new Promise(r => setTimeout(r, 100));

        // Stop monitoring
        stopLevelMonitoring();
        stopDurationTracking();

        // Stop all tracks
        if (stream.value) {
          stream.value.getTracks().forEach(track => track.stop());
          stream.value = null;
        }

        // Stop mixed stream if it exists
        if (mixedStream.value) {
          mixedStream.value.getTracks().forEach(track => track.stop());
          mixedStream.value = null;
        }

        // Close mixing context
        if (mixingContext.value) {
          mixingContext.value.close().catch(() => {});
          mixingContext.value = null;
        }

        // Stop system audio capture
        stopSystemAudio();

        // Combine chunks - now guaranteed all chunks are saved
        const result = await recordingStore.stopRecording();
        resolve(result);
      };

      // Request final data and stop
      if (mediaRecorder.value.state !== 'inactive') {
        mediaRecorder.value.requestData();
        mediaRecorder.value.stop();
      } else {
        // Already stopped, just finalize
        stopLevelMonitoring();
        stopDurationTracking();

        if (stream.value) {
          stream.value.getTracks().forEach(track => track.stop());
          stream.value = null;
        }

        recordingStore.stopRecording().then(resolve);
      }
    });
  };

  // Cleanup on unmount
  onUnmounted(() => {
    stopLevelMonitoring();
    stopDurationTracking();

    if (stream.value) {
      stream.value.getTracks().forEach(track => track.stop());
    }

    if (mixedStream.value) {
      mixedStream.value.getTracks().forEach(track => track.stop());
    }

    if (mixingContext.value) {
      mixingContext.value.close().catch(() => {});
    }

    stopSystemAudio();

    if (mediaRecorder.value && mediaRecorder.value.state !== 'inactive') {
      mediaRecorder.value.stop();
    }

    // Remove device change listener
    navigator.mediaDevices.removeEventListener('devicechange', loadMicrophones);
  });

  return {
    audioLevel,
    availableMicrophones,
    selectedMicrophoneId,
    loadingMicrophones,
    systemAudioEnabled,
    systemAudioPermissionStatus: permissionStatus,
    setSystemAudioEnabled,
    loadMicrophones,
    loadSystemAudioState,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording
  };
}
