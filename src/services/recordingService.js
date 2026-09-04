/**
 * Recording Service - Singleton that manages MediaRecorder outside of component lifecycle
 * This allows recording to persist across navigation
 */

import { isAndroid, isElectron } from '../utils/platform';
import { captureMessage } from '../boot/sentry';
import { createRecordingChunkWriter } from './recordingChunkWriter';

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

// SASIG — system-audio signal watchdog (Windows loopback silent-capture, 2026-08-14).
// The loopback track can be `live`, unmuted and completely silent for an entire
// meeting: WASAPI loopback binds to the default MULTIMEDIA output endpoint, while
// conferencing apps render to the default COMMUNICATION endpoint, and a Bluetooth
// profile flip or an endpoint going idle produces the same result. The mic has had
// full health monitoring since MSIG; the system-audio track had none, so a 68-minute
// recording of pure silence raised zero warnings. Measure the loopback the same way
// the mic is measured and tell the user while the meeting is still running.
const SYS_AUDIO_SILENCE_DBFS = -80;            // below this is digital silence, not "quiet"
const SYS_AUDIO_SILENCE_WARN_MS = 90 * 1000;   // long enough to survive genuinely quiet passages
let systemAudioAnalyser = null;
let systemAudioSilenceInterval = null;
let systemAudioSilentSince = null;
let systemAudioSilenceWarned = false;
let systemAudioSilenceReported = false;
let systemAudioFloatBuf = null;

// Mic mute state
let micMuted = false;

// Recording store reference (set during startRecording, used by switchMicrophoneStream)
let recordingStoreRef = null;

// DREC-3: mic device-disconnect auto-recovery. When a mic track ends mid-
// recording (USB unplug, Bluetooth drop/codec switch, battery death) we schedule
// a grace timeout that escalates the health state to CRITICAL. We track those
// timeouts so a reconnect can cancel the pending escalation, remember the
// originally-requested deviceId so we can re-acquire it, and listen for
// devicechange to auto-switch back onto a live input instead of stranding the
// recording on a dead device showing a permanent "microphone disconnected".
const micGraceTimeouts = new Set();
let lastRequestedDeviceId = null;
let micDeviceChangeHandler = null;
let micAutoRecovering = false;
let micSwitchGeneration = 0;

// INT-2: audio-session interruption auto-recovery (Nyberg incident 2026-06-25).
// On iOS an incoming call interrupts the audio session even with the app in
// the FOREGROUND: the WKWebView AudioContext freezes ('interrupted'), the mic
// track mutes, and the MediaRecorder — which records the mixing-pipeline
// output — stops emitting chunks while still reporting state 'recording'.
// A single immediate ctx.resume() (the old behavior) always fails because the
// call still owns the audio device. This loop retries until the session is
// free again: resume contexts → re-acquire mic → verify chunks flow.
const CAPTURE_RECOVERY_RETRY_MS = 5000;
const CAPTURE_RECOVERY_GIVE_UP_MS = 30 * 60 * 1000; // keep trying for 30 min (long calls)
// Ticks with a fully healthy pipeline (context running + live mic) but still
// no chunk → the MediaRecorder itself is wedged beyond in-place recovery
// (documented WKWebView behavior after interruptions). 6 ticks ≈ 30s.
const CAPTURE_RECOVERY_WEDGED_TICKS = 6;
let captureRecoveryTimer = null;
let captureRecoveryStartedAt = null;
let captureRecoveryReason = null;
let captureRecoveryBusy = false;
let captureRecoveryHealthyTicks = 0;

// Flush synchronization: resolved when ondataavailable saves the chunk after a flush request
let flushResolvers = [];

// Double-start protection (doubled-audio incident, 2026-06-11): startRecording
// has a multi-second async window (system-audio probe, getUserMedia ladder,
// session-creation IPC) before `mediaRecorder` is assigned, so the
// `state !== 'inactive'` guard alone cannot stop a second overlapping
// invocation. Two concurrent MediaRecorders then interleave their timeslice
// blobs into ONE chunk sequence and every block of the meeting ends up in the
// final file twice. Three independent layers now prevent that:
//   1. startInProgress — synchronous re-entrancy latch on startRecording().
//   2. recorderGeneration — every pipeline gets a generation id; blobs from any
//      recorder that is not the current generation are dropped at the save gate
//      and the orphan is stopped (self-healing even if a rogue pipeline appears
//      through a path nobody anticipated).
//   3. teardownLeakedPipeline() — a new start defensively destroys any leftover
//      pipeline objects before building new ones, and reports to Sentry.
let startInProgress = false;
let recorderGeneration = 0;
let orphanRecorderWarned = false;
// Stop-side re-entrancy: concurrent stop callers (manual stop + emergency stop
// on chunk-save failure) share one in-flight promise instead of running the
// teardown/combine sequence twice (the stop-side twin of the start race; the
// full guard was deferred in 3a7415b).
let stopInFlightPromise = null;
let chunkWriter = null;
let splitInFlightPromise = null;
let recorderStopObserved = false;
// Auto-split ref captured at start so verifyRecordingState can tell an
// intentional split-pause from a stuck recorder (see verifyRecordingState).
let isAutoSplittingRef = null;

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

// MSIG: mic signal forensics (Insel incident 2026-07-22 — dead Bluetooth
// speakerphone kept an enumerated "phantom" endpoint whose track stayed
// readyState==='live' while delivering pure digital zeros; 6 minutes of
// warned-but-unrecovered silence, then a manual switch onto another silent
// BT profile that the health monitor blessed as OK because its thresholds
// sit at the analyser noise floor).
//
// A healthy OPEN microphone never delivers sustained exact-digital-silence:
// even a silent room leaves AGC/ADC noise far above -90 dBFS. Sustained
// peaks below ZERO_PEAK_DBFS therefore mean a dead/hardware-muted device,
// which we can flag much faster than generic low-audio, and which justifies
// one automatic same-device re-acquire (safe: it never switches the user
// onto a device they did not choose — a hardware-muted headset must NOT be
// silently replaced by the laptop mic).
const ZERO_PEAK_DBFS = -90;
const ZERO_DEGRADED_MS = 15000;
const ZERO_CRITICAL_MS = 45000;
const ZERO_DEGRADED_SYSAUDIO_MS = 120000;  // parity with the relaxed NO_AUDIO thresholds
const ZERO_CRITICAL_SYSAUDIO_MS = 300000;
// Post-switch verification: after ANY mic swap (manual, auto-recovery,
// re-acquire) the new stream must prove it delivers signal before health may
// report OK — "getUserMedia succeeded" is not proof (phantom endpoints
// happily hand out silent streams).
const SWITCH_VERIFY_MS = 5000;
const SWITCH_VERIFY_SIGNAL_DBFS = -80;   // any tick above this = device delivers signal
// LOW_LEVEL: input carries speech-like modulation but ~30dB too quiet for
// STT (broken BT gain, wrong endpoint). Modulation-gated so meeting pauses
// (steady noise floor, no syllable dynamics) can never false-positive.
const LOW_LEVEL_EVAL_INTERVAL_MS = 5000;
const LOW_LEVEL_WINDOW_MS = 180000;
const LOW_LEVEL_MIN_ACTIVE_MS = 30000;
const LOW_LEVEL_ACTIVITY_ABOVE_FLOOR_DB = 12;
const LOW_LEVEL_P90_DBFS = -45;
const LOW_LEVEL_CLEAR_P90_DBFS = -40;    // hysteresis so the hint doesn't flap
// Post-switch loudness comparison: the new device is "verified" (has signal)
// but dramatically quieter than what this session's speech measured before —
// exactly Angela's phase 2. Compared against a slow EMA of active-tick RMS.
const SWITCH_BASELINE_DROP_DB = 20;
const SWITCH_BASELINE_MIN_ACTIVE_MS = 30000;
const LEVEL_BASELINE_ALPHA = 0.005;      // EMA time constant ≈ 20s of active ticks
const LEVEL_ACTIVITY_FLOOR_DBFS = -60;   // ticks quieter than this don't teach the baseline

let zeroSignalSince = null;        // wall-clock start of the current all-zeros run
let zeroEpisodeReported = false;   // one Sentry breadcrumb per episode
let zeroEpisodeReacquired = false; // one automatic same-device re-acquire per episode
let zeroReacquireInFlight = false;
// micVerify: pending post-switch verification, resolved by the health loop.
// { context: 'manual-switch'|'auto-recovery'|'reacquire', label, deviceId,
//   since, deadline, generation, baselineBefore, resolvers: [fn] }
let micVerify = null;
// Post-switch loudness watch: after a verified switch, compare 30s of active
// audio against the pre-switch baseline. { since, baselineBefore, activeMs, levels: [] }
let switchLevelWatch = null;
let levelBaselineDb = null;        // slow EMA of active-tick RMS (session speech reference)
let micTickHistory = [];           // ring buffer {t, rmsDb, voiceEnergy} for LOW_LEVEL (3 min)
let lowLevelActive = false;
let lowLevelReported = false;
let lastLowLevelEvalAt = 0;
let lowLevelMeasuredDb = null;     // active-speech P90 that triggered LOW_LEVEL
let micSignalFloatBuf = null;

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
  MONITORING_ERROR: 'monitoring_error',
  // MSIG: track is live but delivers sustained digital silence — dead BT
  // endpoint, hardware mute switch, wedged capture stream.
  ZERO_SIGNAL: 'zero_signal',
  // MSIG: speech-like modulation present but far too quiet to transcribe.
  LOW_LEVEL: 'low_level'
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
  // MSIG fields — let the UI say precisely WHAT is wrong and for HOW LONG:
  silenceSince: null,   // wall-clock ms when the current zero-signal run began
  measuredDb: null,     // active-speech level (dBFS) that triggered LOW_LEVEL
  verifying: false,     // a just-switched mic is being probed for real signal
  afterSwitch: false,   // reason was established right after a device switch
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
    case MIC_HEALTH_REASON.ZERO_SIGNAL:
      return hasSysAudio
        ? 'Microphone delivers no signal — system audio is still being recorded. The device may be off or muted.'
        : 'Microphone is connected but delivers no signal. The device may be switched off or hardware-muted. Please switch to a different microphone.';
    case MIC_HEALTH_REASON.LOW_LEVEL:
      return 'Microphone signal is very quiet — the recording may be hard to understand. Check the device volume/position or switch microphones.';
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
  // MSIG: a healthy state carries no stale forensics (verifying is managed
  // independently — a probe can be pending while the status is still OK).
  if (status === MIC_HEALTH_STATUS.OK) {
    nextState.silenceSince = null;
    nextState.measuredDb = null;
    nextState.afterSwitch = false;
  }

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
    'channelCount',
    'silenceSince',
    'measuredDb',
    'verifying',
    'afterSwitch'
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
  resetMicSignalState();
  levelBaselineDb = null; // session speech reference — per recording
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
    silenceSince: null,
    measuredDb: null,
    verifying: false,
    afterSwitch: false,
    changedAt: Date.now()
  };
  emit('healthChange', { ...micHealthState });
}

/**
 * MSIG: clear the transient signal-forensics episode state. Called on fresh
 * start, teardown, pause (measurement is gated while paused, so a stale
 * wall-clock episode must not "age" through the pause), and on wake from
 * system sleep (same reason).
 * Deliberately does NOT touch levelBaselineDb — the session speech reference
 * survives episodes so a post-switch loudness drop can still be compared.
 */
function resetMicSignalState() {
  zeroSignalSince = null;
  zeroEpisodeReported = false;
  zeroEpisodeReacquired = false;
  lowLevelActive = false;
  lowLevelReported = false;
  lowLevelMeasuredDb = null;
  micTickHistory = [];
  lastLowLevelEvalAt = 0;
  switchLevelWatch = null;
  resolveMicVerification(null);
}

/**
 * MSIG: resolve and clear a pending post-switch verification. verdict is
 * 'signal' | 'silent' | null (null = aborted: teardown/pause/superseded —
 * no health verdict is derived, but awaiting callers are unblocked).
 */
function resolveMicVerification(verdict) {
  const v = micVerify;
  if (!v) return;
  micVerify = null;
  if (verdict === null && micHealthState.verifying) {
    // Aborted probe (pause/teardown/superseded): the UI must not stay stuck
    // on "checking…". The 'signal'/'silent' paths set their own state.
    updateMicHealthState(micHealthState.status, micHealthState.reasonCode, micHealthState.message, {
      verifying: false
    });
  }
  for (const fn of v.resolvers) {
    try { fn(verdict); } catch (e) { /* consumer error must not break the loop */ }
  }
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
  // system resume from sleep, another app claiming audio focus).
  // INT-2: the immediate resume() below ALWAYS fails while an iOS call
  // interruption is active (the call owns the audio device) — so additionally
  // start the recovery loop, which keeps retrying until the session is free
  // and also re-acquires the (by then muted/dead) mic track.
  ctx.addEventListener('statechange', () => {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      console.warn(`AudioContext state changed to "${ctx.state}" — attempting resume`);
      ctx.resume().catch(e => console.warn('AudioContext auto-resume failed:', e));
      scheduleCaptureRecovery(`audiocontext-${ctx.state}`);
    }
  });

  mixingContext = ctx;
  mixingDest = dest;
  // NOTE: the SASIG watchdog is armed by startLevelMonitoring, not here —
  // startLevelMonitoring begins with a full monitor teardown.
  return dest.stream;
}

/**
 * SASIG: watch the loopback/system-audio source for digital silence.
 *
 * Taps `systemSourceNode` (already connected to the mixing destination, so the
 * graph is being pulled) with an analyser and samples its peak level. If the
 * source stays below SYS_AUDIO_SILENCE_DBFS for SYS_AUDIO_SILENCE_WARN_MS of
 * *recording* time, the capture is silent for a structural reason — wrong output
 * endpoint, suspended Bluetooth endpoint, an app rendering elsewhere — and the
 * user is told while they can still act. Cleared as soon as signal returns.
 */
function startSystemAudioSilenceMonitor() {
  stopSystemAudioSilenceMonitor();
  if (!mixingContext || !systemSourceNode) return;

  try {
    systemAudioAnalyser = mixingContext.createAnalyser();
    systemAudioAnalyser.fftSize = 256;
    // Same reasoning as MSIG: dBFS thresholds are meaningless on the 8-bit
    // fallback API, so without the float probe we simply don't judge.
    if (typeof systemAudioAnalyser.getFloatTimeDomainData !== 'function') {
      systemAudioAnalyser = null;
      return;
    }
    systemSourceNode.connect(systemAudioAnalyser);
    systemAudioFloatBuf = new Float32Array(systemAudioAnalyser.fftSize);

    systemAudioSilenceInterval = setInterval(() => {
      if (!systemAudioAnalyser || !systemAudioFloatBuf) return;
      // Only count time while actually recording — a long pause must not age
      // the episode into a false warning.
      if (!recordingStoreRef?.isRecording) {
        systemAudioSilentSince = null;
        return;
      }

      systemAudioAnalyser.getFloatTimeDomainData(systemAudioFloatBuf);
      let peak = 0;
      for (let i = 0; i < systemAudioFloatBuf.length; i++) {
        const a = Math.abs(systemAudioFloatBuf[i]);
        if (a > peak) peak = a;
      }

      if (toDbfs(peak) > SYS_AUDIO_SILENCE_DBFS) {
        systemAudioSilentSince = null;
        if (systemAudioSilenceWarned) {
          systemAudioSilenceWarned = false;
          emit('systemAudioSilent', null);
        }
        return;
      }

      if (!systemAudioSilentSince) {
        systemAudioSilentSince = Date.now();
        return;
      }
      const silentMs = Date.now() - systemAudioSilentSince;
      if (silentMs < SYS_AUDIO_SILENCE_WARN_MS || systemAudioSilenceWarned) return;

      systemAudioSilenceWarned = true;
      const silentSeconds = Math.round(silentMs / 1000);
      emit('systemAudioSilent', { silentSeconds });
      if (!systemAudioSilenceReported) {
        systemAudioSilenceReported = true;
        captureMessage(
          `system-audio: loopback delivered digital silence for ${silentSeconds}s while recording ` +
          '(likely wrong Windows output endpoint — loopback binds to the default MULTIMEDIA device, ' +
          'call audio goes to the default COMMUNICATION device)',
          'warning'
        );
      }
    }, 1000);
  } catch (e) {
    console.warn('Could not start system-audio silence monitoring:', e);
    systemAudioAnalyser = null;
  }
}

function stopSystemAudioSilenceMonitor() {
  if (systemAudioSilenceInterval) {
    clearInterval(systemAudioSilenceInterval);
    systemAudioSilenceInterval = null;
  }
  if (systemAudioAnalyser) {
    try { systemAudioAnalyser.disconnect(); } catch (e) { /* already disconnected */ }
    systemAudioAnalyser = null;
  }
  systemAudioFloatBuf = null;
  systemAudioSilentSince = null;
  if (systemAudioSilenceWarned) {
    systemAudioSilenceWarned = false;
    emit('systemAudioSilent', null);
  }
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
    // SASIG: re-arm on every (re)attach — mid-recording enable and BT rebind
    // both land here, and a rebind is exactly when silence tends to start.
    startSystemAudioSilenceMonitor();
    console.log('System audio added to recording mix');
    return true;
  } catch (e) {
    console.error('Error adding system audio:', e);
    return false;
  }
}

/**
 * Mark system audio capture as active (or inactive) without wiring a
 * MediaStream into the Web Audio mixing pipeline. Used by the macOS
 * AudioTee path, which captures system audio in the main process and
 * writes PCM directly to disk — there is no MediaStream to attach.
 *
 * Without this, recordingService.systemAudioActive stayed false during
 * AudioTee capture, so `getMicHealthMessage` showed the strict
 * "no microphone input" wording instead of the gentler "mic is silent —
 * system audio is still being recorded" copy, and the relaxed silence
 * thresholds (120 s / 300 s) never kicked in. See ultrareview bug_002.
 */
export function setSystemAudioActive(active) {
  const next = !!active;
  if (systemAudioActive === next) return;
  systemAudioActive = next;
  emit('systemAudioChange', next);
  updateMicHealthState(
    micHealthState.status,
    micHealthState.reasonCode,
    micHealthState.message,
    { systemAudioActive: next }
  );
}

/**
 * Remove system audio from the active recording mix
 */
export function removeSystemAudioStream() {
  stopSystemAudioSilenceMonitor();
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
 *
 * MSIG: "getUserMedia succeeded" is NOT proof the device works — Windows
 * happily opens phantom endpoints of dead Bluetooth devices and hands out
 * streams of pure silence (Insel incident: the UI showed "In Ordnung" for
 * 20 minutes of unusable audio). So unless opts.skipVerify is set, health
 * does NOT flip to OK here; a 5s signal probe in the health loop delivers
 * the verdict, exposed via the returned `verified` promise
 * ('signal' | 'silent' | null=aborted).
 *
 * @param {string|null} newDeviceId - Device ID to switch to (null = OS default)
 * @param {Object} opts
 * @param {string}  opts.verifyContext - 'manual-switch' (default) | 'auto-recovery' | 'reacquire'
 * @param {boolean} opts.skipVerify - legacy behavior for INT-2 (its own success
 *   metric is chunk flow, and probing during an OS audio-session interruption
 *   would false-positive "silent")
 * @returns {Promise<{success: boolean, error?: string, label?: string, verified?: Promise}>}
 */
async function acquireReplacementMicrophone(constraints) {
  let expired = false;
  let timeout;
  const acquired = navigator.mediaDevices.getUserMedia(constraints).then(candidate => {
    if (expired) {
      candidate.getTracks().forEach(track => track.stop());
      throw new Error('Microphone request expired');
    }
    return candidate;
  });
  try {
    return await Promise.race([
      acquired,
      new Promise((_, reject) => {
        timeout = setTimeout(() => { expired = true; reject(new Error('Microphone did not respond within 8 seconds')); }, 8000);
      })
    ]);
  } finally { clearTimeout(timeout); }
}

export async function switchMicrophoneStream(newDeviceId, opts = {}) {
  const verifyContext = opts.verifyContext || 'manual-switch';
  if (!mixingContext || !mixingDest) {
    return { success: false, error: 'No active recording to switch microphone in' };
  }

  const switchId = ++micSwitchGeneration;
  const generation = recorderGeneration;
  const targetContext = mixingContext;
  let newStream = null;
  let replacementNode = null;
  try {
    // Relax processing constraints, never the selected device. In particular,
    // same-device recovery must not open a different microphone behind a mute.
    // Step 1: Acquire new mic stream with fallback constraints
    const constraintLadder = newDeviceId
      ? [
        { deviceId: { exact: newDeviceId }, echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
        { deviceId: { exact: newDeviceId }, noiseSuppression: true },
        { deviceId: { exact: newDeviceId } }
      ]
      : [
        { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
        { noiseSuppression: true },
        true
      ];

    for (const constraints of constraintLadder) {
      try {
        newStream = await acquireReplacementMicrophone({ audio: constraints });
        break;
      } catch (e) {
        console.warn('Mic switch constraint attempt failed:', e.name);
      }
    }

    if (!newStream) {
      return { success: false, error: 'Could not access the selected microphone' };
    }

    if (generation !== recorderGeneration || switchId !== micSwitchGeneration || mixingContext !== targetContext || !mixingDest) {
      newStream.getTracks().forEach(track => track.stop());
      return { success: false, error: 'Microphone switch superseded or recording stopped' };
    }
    const liveTrack = newStream.getAudioTracks()[0];
    if (!liveTrack || liveTrack.readyState === 'ended') throw new Error('The selected microphone disconnected while opening');
    // Connect the replacement before touching the working input. Graph setup
    // can throw after getUserMedia succeeds (driver/context failures).
    liveTrack.enabled = !micMuted;
    replacementNode = targetContext.createMediaStreamSource(newStream);
    replacementNode.connect(mixingDest);

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
    micSourceNode = replacementNode;
    stream = newStream;
    lastRequestedDeviceId = newDeviceId || null;

    // Step 5: Set up track.onended listener for new stream
    for (const track of newStream.getTracks()) {
      track.onended = () => {
        console.warn('Switched mic track ended unexpectedly — waiting 3s before declaring critical');
        updateMicHealthState(MIC_HEALTH_STATUS.DEGRADED, MIC_HEALTH_REASON.TRACK_ENDED, null, {
          micActive: false, systemAudioActive
        });
        handleMicDeviceChange();
        registerMicGraceTimeout(() => {
          if (!recordingStoreRef?.isRecording) return;
          if (micHealthState.status === MIC_HEALTH_STATUS.OK) return;
          updateMicHealthState(MIC_HEALTH_STATUS.CRITICAL, MIC_HEALTH_REASON.TRACK_ENDED, null, {
            micActive: false, systemAudioActive
          });
          setSilenceWarning(micHealthState.message);
          if (recordingStoreRef) verifyRecordingState(recordingStoreRef);
        }, 3000);
      };
      // INT-2: keep interruption detection armed on the replacement track —
      // a second incoming call must be caught exactly like the first.
      track.onmute = () => {
        console.warn('Switched mic track muted (audio-session interruption?) — starting capture recovery');
        scheduleCaptureRecovery('mic-track-muted');
      };
      track.onunmute = () => {
        console.warn('Switched mic track unmuted — verifying capture recovery');
        scheduleCaptureRecovery('mic-track-unmuted');
      };
    }

    // Step 6: Restart health monitoring with new stream
    if (recordingStoreRef) {
      startMicHealthMonitoring(newStream, recordingStoreRef);
    }

    // Step 7 (MSIG): defer the health verdict to the signal probe. The state
    // keeps its previous status/warnings (honest: a still-silent recording
    // must not flash "healthy" for 5 seconds), gains the new track details,
    // and is flagged `verifying` so the UI can show "checking…".
    const newTrack = newStream.getAudioTracks()[0];
    const settings = newTrack?.getSettings ? newTrack.getSettings() : {};
    const trackLabel = newTrack?.label || newDeviceId || 'System default';

    if (opts.skipVerify) {
      updateMicHealthTrackDetails(newStream, newDeviceId);
      clearSilenceWarning();
      micAnomalyCounter = 0;
      micRecoveryCounter = 0;
      console.log('Microphone switched successfully to:', trackLabel);
      emit('microphoneChange', { deviceId: newDeviceId, label: trackLabel });
      return { success: true, label: trackLabel };
    }

    resolveMicVerification(null); // supersede any older pending probe
    micVerify = {
      context: verifyContext,
      label: trackLabel,
      deviceId: newDeviceId || settings.deviceId || null,
      since: Date.now(),
      deadline: Date.now() + SWITCH_VERIFY_MS,
      baselineBefore: levelBaselineDb,
      resolvers: []
    };
    // Fresh stream, fresh episode clock (a silent verdict re-anchors it) —
    // and a fresh low-level history: the old device's levels must not be
    // held against the new one.
    zeroSignalSince = null;
    switchLevelWatch = null;
    micTickHistory = [];
    lowLevelActive = false;
    lastLowLevelEvalAt = 0;
    updateMicHealthState(micHealthState.status, micHealthState.reasonCode, micHealthState.message, {
      verifying: true,
      micActive: true,
      inputDeviceId: newDeviceId || null,
      actualDeviceId: settings.deviceId || null,
      trackLabel,
      sampleRate: settings.sampleRate || null,
      channelCount: settings.channelCount || null
    });

    const verified = new Promise((res) => {
      if (micVerify) micVerify.resolvers.push(res);
      else res(null);
    });

    console.log('Microphone switched to:', trackLabel, '— verifying signal');
    emit('microphoneChange', { deviceId: newDeviceId, label: trackLabel });
    return { success: true, label: trackLabel, verified };
  } catch (e) {
    if (stream !== newStream) {
      try { replacementNode?.disconnect(); } catch (_) { /* setup failed */ }
      newStream?.getTracks().forEach(track => track.stop());
    }
    console.error('Error switching microphone:', e);
    return { success: false, error: e.message };
  }
}

/**
 * DREC-3: clear any pending mic-disconnect grace timeouts. Called when the mic
 * recovers, when a fresh recording starts, and on teardown. The grace callbacks
 * also self-guard on isRecording, so a missed clear is harmless — this just
 * prevents a stale CRITICAL escalation from firing after the device came back.
 */
function clearMicGraceTimeouts() {
  for (const id of micGraceTimeouts) clearTimeout(id);
  micGraceTimeouts.clear();
}

/**
 * DREC-3: schedule a mic-disconnect grace timeout that is tracked so it can be
 * cancelled on reconnect. Mirrors a plain setTimeout but auto-deregisters.
 */
function registerMicGraceTimeout(fn, delayMs) {
  const id = setTimeout(() => {
    micGraceTimeouts.delete(id);
    fn();
  }, delayMs);
  micGraceTimeouts.add(id);
  return id;
}

/**
 * DREC-3: on an OS device-list change while recording with a dropped mic, try to
 * re-acquire a live input (preferring the originally-requested device) and
 * seamlessly switch the recording onto it, cancelling the pending CRITICAL
 * escalation. Reentrancy-locked and guarded so it cannot disturb a healthy
 * recording — it only acts when the mic health reason is TRACK_ENDED.
 */
async function handleMicDeviceChange() {
  if (!recordingStoreRef?.isRecording) return;

  // MSIG: a device-set change during a zero-signal episode is a fresh chance —
  // the wedged endpoint may have been re-registered by the OS (e.g. the BT
  // device was power-cycled). Re-arm the one-per-episode same-device
  // re-acquire; the health loop performs it on its next escalated tick.
  // Still same-device only: sustained zeros can mean a hardware-muted mic,
  // and a muted user must never be silently moved onto another microphone.
  if (micHealthState.reasonCode === MIC_HEALTH_REASON.ZERO_SIGNAL && zeroSignalSince && !zeroReacquireInFlight) {
    zeroEpisodeReacquired = false;
    return;
  }

  if (micHealthState.reasonCode !== MIC_HEALTH_REASON.TRACK_ENDED) return;
  if (micAutoRecovering) return;
  if (!navigator.mediaDevices?.enumerateDevices) return;
  micAutoRecovering = true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // 'communications' is a Windows pseudo-device that duplicates 'default'
    // semantics — skip it so it cannot burn a candidate slot.
    const inputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications');
    if (inputs.length === 0) return;
    // Prefer the originally-requested device if it reappeared, then walk the
    // remaining inputs. Every candidate must PROVE it delivers signal (a
    // still-enumerated phantom endpoint opens fine and records silence) —
    // up to 3 candidates, ~5s probe each.
    const preferred = inputs.find(d => d.deviceId === lastRequestedDeviceId);
    const candidates = [
      ...(preferred ? [preferred] : []),
      ...inputs.filter(d => d !== preferred)
    ].slice(0, 3);
    const fromLabel = micHealthState.trackLabel || '';
    for (const candidate of candidates) {
      const result = await switchMicrophoneStream(candidate.deviceId, { verifyContext: 'auto-recovery' });
      if (!result.success) continue;
      const verdict = await result.verified;
      if (verdict === 'signal') {
        clearMicGraceTimeouts(); // device is live again — do not escalate to CRITICAL
        emit('micRecovered', { deviceId: candidate.deviceId });
        emit('micAutoSwitched', {
          fromLabel,
          toLabel: result.label || candidate.label || '',
          deviceId: candidate.deviceId
        });
        captureMessage(`mic-health: auto-recovered onto "${result.label || candidate.deviceId}" after device loss (signal verified)`, 'warning');
        return;
      }
      if (verdict === null) return; // probe aborted (stop/pause/teardown) — stand down
      captureMessage(`mic-health: auto-recovery candidate "${result.label || candidate.deviceId}" delivered no signal — trying next`, 'warning');
    }
    // Every candidate was silent: the last one stays active and the health
    // state already shows the precise ZERO_SIGNAL after-switch message.
  } catch (e) {
    console.warn('Mic auto-recovery on devicechange failed:', e);
  } finally {
    micAutoRecovering = false;
  }
}

/** DREC-3: start the recovery devicechange listener (single instance). */
function startMicRecoveryListener() {
  if (!navigator.mediaDevices?.addEventListener) return;
  if (micDeviceChangeHandler) {
    navigator.mediaDevices.removeEventListener('devicechange', micDeviceChangeHandler);
  }
  micDeviceChangeHandler = handleMicDeviceChange;
  navigator.mediaDevices.addEventListener('devicechange', micDeviceChangeHandler);
}

/** DREC-3: stop the recovery devicechange listener and clear pending grace timers. */
function stopMicRecoveryListener() {
  if (micDeviceChangeHandler && navigator.mediaDevices?.removeEventListener) {
    navigator.mediaDevices.removeEventListener('devicechange', micDeviceChangeHandler);
  }
  micDeviceChangeHandler = null;
  clearMicGraceTimeouts();
  stopCaptureRecovery();
}

/**
 * INT-2: start the interruption-recovery loop (idempotent — one loop per
 * episode). Triggered by: AudioContext 'interrupted'/'suspended', mic track
 * onmute/onunmute, the chunk-progress watchdog, and the post-resume check.
 * The loop self-terminates on success, stop, pause, or after the give-up
 * window. Everything captured before the interruption is already persisted
 * (3s chunk fsync) — this loop's job is to stop the bleeding AFTER it.
 */
function scheduleCaptureRecovery(reason) {
  if (!recordingStoreRef?.isRecording || recordingStoreRef.isPaused) return;
  if (captureRecoveryTimer) return; // episode already running
  captureRecoveryStartedAt = Date.now();
  captureRecoveryReason = reason;
  captureRecoveryHealthyTicks = 0;
  captureMessage(`recording: capture recovery started (reason=${reason}, savedChunks=${savedChunkCount})`, 'warning');
  captureRecoveryTimer = setInterval(() => {
    attemptCaptureRecovery().catch(e => console.warn('Capture recovery attempt failed:', e));
  }, CAPTURE_RECOVERY_RETRY_MS);
  // Kick immediately — a declined call frees the session within seconds.
  attemptCaptureRecovery().catch(e => console.warn('Capture recovery attempt failed:', e));
}

/** INT-2: stop the recovery loop (success, give-up, or recording teardown). */
function stopCaptureRecovery() {
  if (captureRecoveryTimer) {
    clearInterval(captureRecoveryTimer);
    captureRecoveryTimer = null;
  }
  captureRecoveryBusy = false;
}

/**
 * INT-2: one recovery attempt. Ordered so each tick is safe to repeat:
 * 1. Success check — a chunk persisted AFTER the episode began means capture
 *    is flowing again; clear the stall state and stop.
 * 2. Resume the audio contexts (fails while a call holds the session; succeeds
 *    the moment it is released — THE fix for the one-shot resume that failed
 *    44ms into the Nyberg interruption).
 * 3. If the mic track is dead/muted, re-acquire and swap it into the mixing
 *    graph via the existing switchMicrophoneStream machinery (the recorder
 *    records the graph output, so it keeps running across the swap).
 * 4. Nudge the recorder (requestData) so the next tick can observe flow.
 */
async function attemptCaptureRecovery() {
  if (captureRecoveryBusy) return;
  captureRecoveryBusy = true;
  try {
    // Self-terminate: session over or paused (post-resume check re-arms us).
    if (!recordingStoreRef?.isRecording || recordingStoreRef.isPaused) {
      stopCaptureRecovery();
      return;
    }

    // Stand down while an auto-split holds the recorder paused — its own
    // finally-block resets the watchdog baseline; interfering mid-split could
    // swap the mic during the segment handoff.
    if (isAutoSplittingRef?.value) return;

    // 1. Success: a chunk landed after the episode started → capture is back.
    if (lastSuccessfulChunkAt && captureRecoveryStartedAt && lastSuccessfulChunkAt >= captureRecoveryStartedAt) {
      const gapSec = Math.round((Date.now() - captureRecoveryStartedAt) / 1000);
      captureMessage(`recording: capture RECOVERED after ${gapSec}s (reason=${captureRecoveryReason}, savedChunks=${savedChunkCount})`, 'warning');
      stallWarned = false; // re-arm the watchdog for a possible next episode
      clearSilenceWarning();
      emit('captureRecovered', { gapSeconds: gapSec, reason: captureRecoveryReason });
      stopCaptureRecovery();
      return;
    }

    // Give up after the window — but NOT quietly. Escalate to captureRecoveryFailed
    // so the app does an emergency stop-with-save and tells the user (persistent
    // toast), instead of sitting "recording" nothing with a stall banner that may
    // no longer be mounted if the user navigated away (reliability audit GAP-3).
    // Every chunk before the interruption is safely persisted either way.
    if (Date.now() - captureRecoveryStartedAt > CAPTURE_RECOVERY_GIVE_UP_MS) {
      const stalledForSeconds = Math.round((Date.now() - captureRecoveryStartedAt) / 1000);
      captureMessage(`recording: capture recovery GAVE UP after ${Math.round(CAPTURE_RECOVERY_GIVE_UP_MS / 60000)}min (reason=${captureRecoveryReason})`, 'error');
      emit('captureRecoveryFailed', { stalledForSeconds, reason: captureRecoveryReason, gaveUp: true });
      stopCaptureRecovery();
      return;
    }

    // 2. Resume frozen audio contexts. While the interruption is active
    //    (ongoing call) resume() rejects/stays non-running — retry next tick.
    for (const ctx of [mixingContext, mixedAudioContext, micHealthAudioContext]) {
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
        try { await ctx.resume(); } catch (e) { /* session still held */ }
      }
    }
    if (mixingContext && mixingContext.state !== 'running') {
      captureRecoveryHealthyTicks = 0;
      return;
    }

    // 3. Mic track dead or muted (iOS mutes it for the interruption's
    //    lifetime and often does NOT unmute it afterwards) → full re-acquire.
    const micTrack = stream?.getAudioTracks?.()[0];
    const micDead = !micTrack || micTrack.readyState !== 'live' || micTrack.muted;
    if (micDead) {
      let targetDeviceId = lastRequestedDeviceId;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId);
        if (inputs.length > 0) {
          targetDeviceId = (inputs.find(d => d.deviceId === lastRequestedDeviceId) || inputs[0]).deviceId;
        }
      } catch (e) { /* fall through with lastRequestedDeviceId */ }
      // MSIG: skipVerify — INT-2's success metric is chunk flow (checked at
      // the top of every tick), and running a signal probe during an OS
      // audio-session interruption would false-positive "silent".
      const result = await switchMicrophoneStream(targetDeviceId || 'default', { skipVerify: true });
      if (!result.success) {
        captureRecoveryHealthyTicks = 0;
        return; // mic still unavailable — next tick
      }
      clearMicGraceTimeouts();
    }

    // 4. Ask for a data flush so the success check above can observe flow on
    //    the next tick instead of waiting a full timeslice.
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try { mediaRecorder.requestData(); } catch (e) { /* buffer not ready */ }
    }

    // 5. Escalation: the pipeline is demonstrably healthy (context running,
    //    live mic) yet chunks still don't flow — the MediaRecorder itself is
    //    wedged, a documented WKWebView failure mode after interruptions that
    //    no in-place fix reaches. Rebuilding the recorder inline would write a
    //    second EBML header into the chunk sequence (under-probed combine →
    //    silent partial transcription), so the safe path is the proven
    //    emergency stop-with-save: everything captured so far is finalized,
    //    and the user immediately gets a working fresh session.
    captureRecoveryHealthyTicks++;
    if (captureRecoveryHealthyTicks >= CAPTURE_RECOVERY_WEDGED_TICKS) {
      captureMessage(`recording: capture recovery FAILED — recorder wedged with healthy pipeline for ${captureRecoveryHealthyTicks} ticks (reason=${captureRecoveryReason}, savedChunks=${savedChunkCount})`, 'error');
      emit('captureRecoveryFailed', {
        reason: captureRecoveryReason,
        savedChunks: savedChunkCount,
        stalledForSeconds: Math.round((Date.now() - captureRecoveryStartedAt) / 1000)
      });
      stopCaptureRecovery();
    }
  } finally {
    captureRecoveryBusy = false;
  }
}

/**
 * INT-2: user-gesture recovery entry point (the stall banner's "recover now"
 * button). iOS may refuse AudioContext.resume() from a timer but allow it
 * inside a user gesture — so run one attempt synchronously in the gesture's
 * call stack, and make sure the background loop is armed either way.
 */
export async function forceCaptureRecovery() {
  scheduleCaptureRecovery('user-gesture');
  try {
    await attemptCaptureRecovery();
  } catch (e) {
    console.warn('User-gesture capture recovery attempt failed:', e);
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

  // SASIG: arm the loopback watchdog HERE, not in createMixingPipeline — this
  // function opens with stopLevelMonitoring(), which tears every monitor down,
  // so anything armed earlier in the start sequence would be silently disarmed
  // again before the recording ever began. (Caught by the SASIG unit tests.)
  if (systemSourceNode) startSystemAudioSilenceMonitor();
}

/** MSIG: p-quantile (0..1) of a numeric array. Returns null on empty input. */
function percentileDb(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

/** MSIG: linear amplitude → dBFS (exact zeros map to -Infinity). */
function toDbfs(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

/**
 * MSIG: one automatic re-acquire of the SAME device during a zero-signal
 * episode. Fixes wedged capture streams (Windows audio-engine / BT profile
 * flips) without ever moving the user onto a device they did not choose —
 * a hardware-muted headset must not be silently replaced by the room mic.
 * The post-switch verification decides whether it actually helped.
 */
async function attemptSameDeviceReacquire() {
  if (zeroReacquireInFlight) return;
  zeroReacquireInFlight = true;
  try {
    const sinceSec = zeroSignalSince ? Math.round((Date.now() - zeroSignalSince) / 1000) : 0;
    captureMessage(`mic-health: zero-signal for ${sinceSec}s on "${micHealthState.trackLabel || 'unknown mic'}" — re-acquiring the same device`, 'warning');
    const result = await switchMicrophoneStream(lastRequestedDeviceId || null, { verifyContext: 'reacquire' });
    if (!result.success) {
      captureMessage(`mic-health: same-device re-acquire could not open a stream (${result.error})`, 'warning');
      return;
    }
    const verdict = await result.verified;
    captureMessage(`mic-health: same-device re-acquire verdict: ${verdict || 'aborted'}`, verdict === 'signal' ? 'warning' : 'error');
  } catch (e) {
    console.warn('Same-device re-acquire failed:', e);
  } finally {
    zeroReacquireInFlight = false;
  }
}

/**
 * MSIG: evaluate the continuous quiet-input detector over the rolling tick
 * history. Modulation-gated: a tick only counts as "speech-like activity"
 * when it rises ≥12dB above the window's own floor — steady room tone or a
 * silent meeting pause produces no active ticks and therefore NO verdict
 * either way (we refuse to judge quietness without evidence of speech).
 */
function evaluateLowLevel() {
  const finite = micTickHistory.filter(h => Number.isFinite(h.rmsDb));
  if (finite.length < 100) return; // need ≥10s of measurable signal
  const rmsValues = finite.map(h => h.rmsDb);
  const floor = percentileDb(rmsValues, 0.10);
  const active = rmsValues.filter(v => v > floor + LOW_LEVEL_ACTIVITY_ABOVE_FLOOR_DB);
  const activeMs = active.length * HEALTH_SAMPLE_INTERVAL_MS;
  if (activeMs < LOW_LEVEL_MIN_ACTIVE_MS) return;
  const p90 = percentileDb(active, 0.90);
  if (!lowLevelActive && p90 <= LOW_LEVEL_P90_DBFS) {
    lowLevelActive = true;
    lowLevelMeasuredDb = Math.round(p90);
    if (!lowLevelReported) {
      lowLevelReported = true;
      captureMessage(`mic-health: LOW LEVEL — active-speech P90 ${Math.round(p90)}dBFS over ${Math.round(activeMs / 1000)}s (device "${micHealthState.trackLabel || 'unknown'}")`, 'warning');
    }
  } else if (lowLevelActive) {
    if (p90 > LOW_LEVEL_CLEAR_P90_DBFS) {
      lowLevelActive = false;
      lowLevelMeasuredDb = null;
    } else {
      lowLevelMeasuredDb = Math.round(p90); // keep the displayed value current
    }
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
    // MSIG: float time-domain probe. dBFS thresholds are meaningless on the
    // 8-bit fallback API (its quantization floor is ≈-42dBFS), so the
    // zero-signal / low-level detectors are simply disabled where the float
    // API is missing — never guessed. Every current platform (Electron 28,
    // iOS ≥14.5 WKWebView, Android Chrome) has it.
    const hasFloatProbe = typeof micHealthAnalyser.getFloatTimeDomainData === 'function';
    micSignalFloatBuf = hasFloatProbe ? new Float32Array(micHealthAnalyser.fftSize) : null;
    micAnomalyCounter = 0;
    micRecoveryCounter = 0;

    micHealthInterval = setInterval(() => {
      if (!micHealthAnalyser) return;
      if (!recordingStore.isRecording) {
        // Paused/stopped: measurement is gated, so wall-clock episode state
        // must not keep aging (a 10-min pause would otherwise resume straight
        // into CRITICAL). A pending switch probe cannot be measured either —
        // abort it without a verdict.
        if (zeroSignalSince || micVerify || micTickHistory.length) {
          resetMicSignalState();
        }
        return;
      }

      const micTrack = micStream.getAudioTracks()[0];
      if (!micTrack || micTrack.readyState !== 'live') {
        // MSIG: if this stream was mid-verification, deliver the verdict —
        // a dead track certainly has no signal, and an unresolved probe
        // would hang its awaiting caller (auto-recovery) forever.
        if (micVerify) {
          const v = micVerify;
          resolveMicVerification('silent');
          emit('micSwitchVerified', { ok: false, context: v.context, label: v.label, deviceId: v.deviceId });
        }
        updateMicHealthState(
          MIC_HEALTH_STATUS.CRITICAL,
          MIC_HEALTH_REASON.TRACK_ENDED,
          null,
          {
            micActive: false,
            systemAudioActive,
            verifying: false
          }
        );
        setSilenceWarning(micHealthState.message);
        return;
      }

      if (micMuted) {
        micAnomalyCounter = 0;
        micRecoveryCounter = 0;
        // Intentional mute: no zero-signal forensics either.
        zeroSignalSince = null;
        zeroEpisodeReported = false;
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

      // ── MSIG: float time-domain measurement (rms/peak in dBFS) ──
      let rmsDb = null;
      let peakDb = null;
      if (micSignalFloatBuf) {
        micHealthAnalyser.getFloatTimeDomainData(micSignalFloatBuf);
        let sumSq = 0;
        let peak = 0;
        for (let i = 0; i < micSignalFloatBuf.length; i++) {
          const v = micSignalFloatBuf[i];
          sumSq += v * v;
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
        rmsDb = toDbfs(Math.sqrt(sumSq / micSignalFloatBuf.length));
        peakDb = toDbfs(peak);
      }

      // ── MSIG: pending post-switch verification owns the verdict ──
      if (micVerify) {
        if (micSignalFloatBuf == null) {
          // No float probe → cannot verify; behave like the legacy path.
          const v = micVerify;
          resolveMicVerification('signal');
          updateMicHealthState(MIC_HEALTH_STATUS.OK, null, null, {
            micActive: true, systemAudioActive, verifying: false
          });
          clearSilenceWarning();
          emit('micSwitchVerified', { ok: true, unverified: true, context: v.context, label: v.label, deviceId: v.deviceId });
        } else if (micHealthAudioContext?.state !== 'running') {
          // Measurement context suspended (autoplay policy / interruption):
          // nothing truthful can be read — postpone the verdict rather than
          // judging a healthy device on synthesized silence.
          micVerify.deadline = Date.now() + SWITCH_VERIFY_MS;
        } else if (peakDb > SWITCH_VERIFY_SIGNAL_DBFS) {
          // The new device demonstrably delivers signal.
          const v = micVerify;
          resolveMicVerification('signal');
          zeroSignalSince = null;
          zeroEpisodeReported = false;
          zeroEpisodeReacquired = false;
          micAnomalyCounter = 0;
          micRecoveryCounter = 0;
          updateMicHealthState(MIC_HEALTH_STATUS.OK, null, null, {
            micActive: true, systemAudioActive, verifying: false
          });
          clearSilenceWarning();
          captureMessage(`mic-health: switch to "${v.label || v.deviceId || 'default'}" verified — signal present (${v.context})`, 'info');
          emit('micSwitchVerified', { ok: true, context: v.context, label: v.label, deviceId: v.deviceId });
          // Watch the first 30s of active audio on the new device against the
          // pre-switch speech baseline (catches "works but 30dB too quiet").
          if (v.baselineBefore != null) {
            switchLevelWatch = { baselineBefore: v.baselineBefore, activeMs: 0, levels: [] };
          }
        } else if (Date.now() >= micVerify.deadline) {
          // Probe window elapsed with pure silence: the chosen device is
          // connected but delivers nothing. Say so IMMEDIATELY — this is the
          // moment the user is watching the screen after switching.
          const v = micVerify;
          resolveMicVerification('silent');
          zeroSignalSince = v.since; // keep the episode clock running
          const status = v.context === 'reacquire'
            ? MIC_HEALTH_STATUS.CRITICAL // we already tried the only safe fix
            : MIC_HEALTH_STATUS.DEGRADED;
          updateMicHealthState(status, MIC_HEALTH_REASON.ZERO_SIGNAL, null, {
            micActive: true, systemAudioActive, verifying: false,
            afterSwitch: true, silenceSince: v.since
          });
          setSilenceWarning(micHealthState.message);
          captureMessage(`mic-health: switch to "${v.label || v.deviceId || 'default'}" delivered NO signal within ${SWITCH_VERIFY_MS / 1000}s (${v.context})`, 'error');
          emit('micSwitchVerified', { ok: false, context: v.context, label: v.label, deviceId: v.deviceId });
        }
        return; // while verifying, the regular detectors stand down
      }

      // ── MSIG: zero-signal episode tracking (wall-clock, sleep-safe) ──
      // Gated to contexts where zeros are meaningful: measurement context
      // running, no INT-2 interruption episode (that machinery owns muted/
      // frozen sessions), no auto-split, track not OS-muted.
      let zeroEscalated = false;
      if (micSignalFloatBuf) {
        const zeroGatesOpen =
          micHealthAudioContext?.state === 'running' &&
          !captureRecoveryTimer &&
          !(isAutoSplittingRef?.value) &&
          micTrack.muted !== true;
        const isZero = peakDb <= ZERO_PEAK_DBFS;
        if (isZero && zeroGatesOpen) {
          if (!zeroSignalSince) zeroSignalSince = Date.now();
          const zeroMs = Date.now() - zeroSignalSince;
          const degMs = systemAudioActive ? ZERO_DEGRADED_SYSAUDIO_MS : ZERO_DEGRADED_MS;
          const critMs = systemAudioActive ? ZERO_CRITICAL_SYSAUDIO_MS : ZERO_CRITICAL_MS;
          if (zeroMs >= degMs) {
            zeroEscalated = true;
            if (!zeroEpisodeReported) {
              zeroEpisodeReported = true;
              captureMessage(`mic-health: ZERO SIGNAL episode — "${micHealthState.trackLabel || 'unknown mic'}" live but delivering digital silence for ${Math.round(zeroMs / 1000)}s`, 'error');
            }
            const status = zeroMs >= critMs ? MIC_HEALTH_STATUS.CRITICAL : MIC_HEALTH_STATUS.DEGRADED;
            updateMicHealthState(status, MIC_HEALTH_REASON.ZERO_SIGNAL, null, {
              micActive: true, systemAudioActive, silenceSince: zeroSignalSince
            });
            setSilenceWarning(micHealthState.message);
            micAnomalyCounter++;
            micRecoveryCounter = 0;
            if (!zeroEpisodeReacquired && !zeroReacquireInFlight) {
              zeroEpisodeReacquired = true;
              attemptSameDeviceReacquire();
            }
          }
        } else if (zeroSignalSince) {
          // Signal returned (or a gate closed — INT-2 / split owns the state
          // now). End the episode; the recovery counters below produce the OK.
          if (!isZero && micHealthState.reasonCode === MIC_HEALTH_REASON.ZERO_SIGNAL) {
            captureMessage(`mic-health: zero-signal episode ended after ${Math.round((Date.now() - zeroSignalSince) / 1000)}s — signal returned`, 'warning');
          }
          zeroSignalSince = null;
          zeroEpisodeReported = false;
          if (!isZero) zeroEpisodeReacquired = false;
        }

        // ── MSIG: rolling history, session baseline, post-switch watch ──
        const now = Date.now();
        micTickHistory.push({ t: now, rmsDb });
        while (micTickHistory.length && now - micTickHistory[0].t > LOW_LEVEL_WINDOW_MS) {
          micTickHistory.shift();
        }
        if (Number.isFinite(rmsDb) && rmsDb > LEVEL_ACTIVITY_FLOOR_DBFS) {
          levelBaselineDb = levelBaselineDb == null
            ? rmsDb
            : levelBaselineDb + LEVEL_BASELINE_ALPHA * (rmsDb - levelBaselineDb);
          if (switchLevelWatch) {
            switchLevelWatch.activeMs += HEALTH_SAMPLE_INTERVAL_MS;
            switchLevelWatch.levels.push(rmsDb);
            if (switchLevelWatch.activeMs >= SWITCH_BASELINE_MIN_ACTIVE_MS) {
              const p90 = percentileDb(switchLevelWatch.levels, 0.90);
              const base = switchLevelWatch.baselineBefore;
              switchLevelWatch = null;
              if (p90 != null && p90 <= base - SWITCH_BASELINE_DROP_DB && p90 <= LOW_LEVEL_CLEAR_P90_DBFS) {
                lowLevelActive = true;
                lowLevelMeasuredDb = Math.round(p90);
                captureMessage(`mic-health: post-switch level drop — active P90 ${Math.round(p90)}dBFS vs session baseline ${Math.round(base)}dBFS`, 'warning');
              }
            }
          }
        }
        if (!zeroEscalated && !systemAudioActive && !zeroSignalSince &&
            now - lastLowLevelEvalAt >= LOW_LEVEL_EVAL_INTERVAL_MS) {
          lastLowLevelEvalAt = now;
          evaluateLowLevel();
        }
      }

      if (zeroEscalated) return; // zero machinery already set the state this tick

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
      } else if (lowLevelActive) {
        // MSIG: audible speech-like input, but far too quiet to transcribe.
        // Informational yellow only — never critical, never an auto-action.
        micAnomalyCounter = 0;
        micRecoveryCounter = 0;
        updateMicHealthState(MIC_HEALTH_STATUS.DEGRADED, MIC_HEALTH_REASON.LOW_LEVEL, null, {
          micActive: true,
          systemAudioActive,
          measuredDb: lowLevelMeasuredDb
        });
        setSilenceWarning(micHealthState.message);
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

  stopSystemAudioSilenceMonitor();
  systemAudioSilenceReported = false;

  mixedAnalyser = null;
  micHealthAnalyser = null;
  micSignalFloatBuf = null;
  micAnomalyCounter = 0;
  micRecoveryCounter = 0;
  currentAudioLevel = 0;
  resetMicSignalState();
  clearSilenceWarning();
  emit('levelChange', 0);
}

// Minutes limit tracking state
let minutesLimitSeconds = null;
let limitWarningShown = false;
const LIMIT_WARNING_SECONDS = 300; // 5 minutes warning before limit

// Auto-split scheduling (Bug D fix). The auto-split predicate is gated on an
// absolute, advancing threshold rather than the raw `elapsed >= MAX_DURATION`
// check. Previously the predicate stayed permanently true once elapsed crossed
// MAX_DURATION (the baseline was never advanced), so the split re-fired every
// 1s tick and shredded the chunk set (createSessionFile churn + chunkIndex
// resets racing in-flight saveChunks). Module-level so it survives pause/resume
// (resumeRecording creates a fresh interval). Reset on start/stop.
let nextAutoSplitAtSeconds = MAX_DURATION_SECONDS;
// On a FAILED split we don't want to retry every tick (the Bug D runaway), nor
// give up forever — back off and retry after this many seconds.
const AUTOSPLIT_RETRY_SECONDS = 300;

// Chunk-progress watchdog + honest-duration state.
// - lastSuccessfulChunkAt: ms timestamp of the last chunk persisted to disk.
// - savedChunkCount: cumulative persisted chunks across auto-split segments —
//   drives the displayed/stored "captured" duration so a capture stall shows
//   up as a frozen timer instead of a wall-clock number that keeps climbing.
// - lastWallClockSec: monotonic wall-clock total; drives the minutes-limit and
//   auto-split predicates (must NOT be derived from the clamped display value).
// - stallWarned: latch so a stall warns once per episode, not every 5s tick.
let lastSuccessfulChunkAt = 0;
let savedChunkCount = 0;
let lastWallClockSec = 0;
let durationRunStartedAt = null;
let durationBaseSec = 0;
let stallWarned = false;
// C3: latch the disk-full emergency-stop event. The recorder keeps emitting a
// blob every timeslice, so without a latch the diskFull chunkSaveFailure re-fires
// every ~3s and launches concurrent stopRecording() calls (double-combine/thrash).
const STALL_WARN_MS = 30000; // ~10 timeslices with no persisted chunk while 'recording'

/**
 * Displayed/stored duration that reflects audio actually captured to disk, not
 * the wall clock. Clamped to (captured chunks + one in-flight timeslice) so a
 * healthy recording reads ~wall-clock while a stalled one freezes — making the
 * stall visible instead of silently masked.
 */
function capturedDisplaySeconds(wallClockSec) {
  const tsSec = MEDIA_RECORDER_TIMESLICE_MS / 1000;
  return Math.min(wallClockSec, savedChunkCount * tsSec + tsSec);
}

/**
 * Chunk-progress watchdog. WARN-ONLY (no auto-stop): if the recorder is
 * 'recording' but no chunk has persisted for STALL_WARN_MS, surface it once.
 * Gated against the legitimate auto-split pause (the merge can hold the
 * recorder paused for minutes) and against pause/interrupt so it cannot
 * false-positive and itself harm a healthy recording.
 */
function checkChunkProgress(recordingStore, isAutoSplitting) {
  if (!recordingStore.isRecording || recordingStore.isPaused || recordingStore.recordingInterrupted) return;
  if (isAutoSplitting?.value) return;
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return; // 'inactive' is handled by verifyRecordingState
  if (!lastSuccessfulChunkAt) return;
  const gapMs = Date.now() - lastSuccessfulChunkAt;
  if (gapMs > STALL_WARN_MS && !stallWarned) {
    stallWarned = true;
    const secs = Math.round(gapMs / 1000);
    captureMessage(`recording: capture STALLED — no chunk persisted for ${secs}s (savedChunks=${savedChunkCount}, mediaState=${mediaRecorder.state})`, 'error');
    emit('captureStalled', { secondsSinceLastChunk: secs, savedChunks: savedChunkCount });
    // INT-2: a stall is never acceptable while 'recording' — attempt automatic
    // recovery regardless of what caused it (interruption, focus loss, or an
    // undetected platform quirk). This is the trigger-agnostic safety net;
    // the mute/statechange triggers above just get there faster.
    scheduleCaptureRecovery('chunk-stall');
  }
}

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

  const startTime = performance.now();
  durationBaseSec = 0;
  durationRunStartedAt = startTime;
  minutesLimitSeconds = maxSeconds;
  limitWarningShown = false;
  nextAutoSplitAtSeconds = MAX_DURATION_SECONDS; // fresh recording → first split at MAX_DURATION
  // Reset chunk-progress / honest-duration counters for the fresh recording.
  lastSuccessfulChunkAt = Date.now();
  savedChunkCount = 0;
  stallWarned = false;
  lastWallClockSec = 0;

  durationInterval = setInterval(async () => {
    if (recordingStore.isRecording) {
      const elapsed = Math.floor((performance.now() - startTime) / 1000);
      lastWallClockSec = elapsed;
      // Honest duration: persist/show captured-audio seconds, not wall-clock,
      // so a capture stall is visible. Limit + auto-split below intentionally
      // keep using wall-clock `elapsed`.
      const shown = capturedDisplaySeconds(elapsed);
      recordingStore.updateDuration(shown);
      emit('durationChange', shown);

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

      // Auto-split at the advancing threshold (edge-triggered — see Bug D note).
      if (elapsed >= nextAutoSplitAtSeconds && !isAutoSplitting.value) {
        await performAutoSplit(recordingStore, isAutoSplitting);
      }
    }
  }, 1000);
}

/**
 * Stop duration tracking
 */
function stopDurationTracking() {
  lastWallClockSec = getWallClockSeconds();
  durationRunStartedAt = null;
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }
  // Reset limit state
  minutesLimitSeconds = null;
  limitWarningShown = false;
  // A4: do NOT reset nextAutoSplitAtSeconds here. pauseRecording() calls
  // stopDurationTracking(), and the auto-split threshold (and savedChunkCount /
  // lastWallClockSec) must survive pause→resume — resetting the threshold caused
  // a spurious re-split on resume after a recording had already auto-split. It is
  // reset for a fresh recording in startDurationTracking(). Watchdog-episode
  // state IS safe to clear (resume re-inits it, and clearing it lets a stall
  // warning clear on stop/pause — B3):
  lastSuccessfulChunkAt = 0;
  stallWarned = false;
}

/**
 * Get the current minutes limit in seconds
 * @returns {number|null} The limit in seconds, or null if no limit
 */
export function getMinutesLimitSeconds() {
  return minutesLimitSeconds;
}

/**
 * Monotonic wall-clock seconds of the current recording (survives pause/resume).
 * Use this — NOT recordingStore.duration, which now holds the clamped
 * captured-audio value — wherever true elapsed time is needed (e.g. the macOS
 * system-audio alignment offset (A5) and the final-duration fallback when
 * ffprobe can't read the file (A6)).
 */
export function getWallClockSeconds() {
  return durationRunStartedAt === null
    ? lastWallClockSec
    : durationBaseSec + Math.max(0, performance.now() - durationRunStartedAt) / 1000;
}

/**
 * MOBR-1/INT-1: cumulative count of chunks actually persisted to disk this
 * recording (across auto-split segments). Used by the visibility handler to
 * detect a background capture gap on mobile — if the wall clock advanced while
 * backgrounded but this counter barely moved, the WebView recorder was
 * suspended and audio was silently lost for that window.
 */
export function getSavedChunkCount() {
  return savedChunkCount;
}

/**
 * Call when the app/tab returns to the foreground, or the OS resumes from sleep.
 * Refreshes the chunk-progress watchdog baseline so the JS-timer gap that
 * accrued while suspended is NOT misread as a capture stall (B2). No-op unless a
 * recording interval is active (durationInterval is null while paused/stopped).
 */
export function notifyForegrounded() {
  if (durationInterval) {
    lastSuccessfulChunkAt = Date.now();
    stallWarned = false;
    // MSIG: JS timers were frozen while suspended — wall-clock zero-signal /
    // low-level episode state would otherwise "age" through the sleep and
    // fire spuriously on the first post-wake ticks.
    resetMicSignalState();
  }
}

/**
 * Perform auto-split
 */
async function performAutoSplit(recordingStore, isAutoSplitting) {
  if (isAutoSplitting.value || splitInFlightPromise) return;
  isAutoSplitting.value = true;
  splitInFlightPromise = (async () => {
    try {
      await flushRecordingData();
      const result = await recordingStore.createSessionFile();
      nextAutoSplitAtSeconds = lastWallClockSec + (result.success ? MAX_DURATION_SECONDS : AUTOSPLIT_RETRY_SECONDS);
      if (!result.success) console.error('Source rotation failed; audio retained:', result.error);
    } catch (error) {
      nextAutoSplitAtSeconds = lastWallClockSec + AUTOSPLIT_RETRY_SECONDS;
      console.error('Source rotation failed:', error);
    } finally { isAutoSplitting.value = false; }
  })();
  try { await splitInFlightPromise; } finally { splitInFlightPromise = null; }
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
    // performAutoSplit intentionally holds the recorder paused (store phase
    // stays 'recording') while the finished segment is rolled into a session
    // file — resuming it here would emit a chunk that races createSessionFile /
    // resetChunkIndex. The split's own final step resumes when it is safe.
    if (isAutoSplittingRef?.value) return;
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
 * Tear down any pipeline objects left over from a previous session before a
 * new one is built. In healthy flows every reference is already null when
 * startRecording runs — anything found here is a leak. A recorder that is
 * still LIVE is the double-audio bug in progress (it would interleave its
 * blobs into the new session's chunk sequence), so it is reported at error
 * level; inactive leftovers (e.g. after a MediaRecorder onerror stop, whose
 * teardown path does not close the mixing context) are reported as warnings.
 */
function teardownLeakedPipeline(reason) {
  const recorderState = mediaRecorder?.state || 'none';
  const liveRecorder = recorderState === 'recording' || recorderState === 'paused';
  captureMessage(
    `recording: ${liveRecorder ? 'LIVE leaked pipeline' : 'stale pipeline objects'} torn down before start (${reason}; recorder=${recorderState})`,
    liveRecorder ? 'error' : 'warning'
  );

  if (mediaRecorder) {
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    mediaRecorder.onerror = null;
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch (e) { /* already stopped */ }
    mediaRecorder = null;
  }

  stopLevelMonitoring();
  stopDurationTracking();
  stopAuthKeepAlive();
  if (stateVerificationInterval) {
    clearInterval(stateVerificationInterval);
    stateVerificationInterval = null;
  }

  if (stream) {
    try { stream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
    stream = null;
  }
  if (mixedStream) {
    try { mixedStream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
    mixedStream = null;
  }
  if (systemStream) {
    try { systemStream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
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
}

/**
 * A blob arrived from a recorder that is not the current pipeline generation.
 * This must never happen — it is the exact mechanism that doubled every
 * sentence of a recording (two live recorders interleaving into one chunk
 * sequence). Drop the blob, kill the orphan, release its tracks, report once.
 */
function handleOrphanRecorderBlob(event) {
  if (!orphanRecorderWarned) {
    orphanRecorderWarned = true;
    captureMessage('recording: orphaned MediaRecorder emitted data — blob dropped, orphan stopped (double-start protection)', 'error');
  }
  try {
    const orphan = event?.target;
    if (orphan && orphan !== mediaRecorder) {
      orphan.ondataavailable = null;
      orphan.onstop = null;
      orphan.onerror = null;
      if (orphan.state !== 'inactive') orphan.stop();
      orphan.stream?.getTracks?.().forEach(track => track.stop());
    }
  } catch (e) {
    console.warn('Error stopping orphaned recorder:', e);
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
  // Layer 1 — synchronous re-entrancy latch, set before the FIRST await. The
  // `state !== 'inactive'` guard below cannot stop overlapping invocations on
  // its own because mediaRecorder is only assigned at the end of the async
  // start sequence.
  if (startInProgress) {
    captureMessage('recording: double-start blocked by in-flight latch', 'warning');
    return { success: false, error: 'Recording start already in progress' };
  }
  // Guard: prevent starting a new recording while one is already active
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    return { success: false, error: 'Recording already in progress' };
  }
  if (stopInFlightPromise || chunkWriter?.pendingCount) {
    return { success: false, error: 'The previous recording still has unsaved audio. Retry saving it before starting another recording.' };
  }
  startInProgress = true;
  try {
    return await startRecordingInternal(options);
  } finally {
    startInProgress = false;
  }
}

async function startRecordingInternal(options) {
  // Layer 2 — invalidate every previous pipeline generation BEFORE touching
  // hardware: blobs from older generations are dropped at the save gate even
  // if an orphaned recorder is somehow still running.
  const myGeneration = ++recorderGeneration;
  orphanRecorderWarned = false;

  // Layer 3 — belt-and-braces: nothing from a previous pipeline may survive
  // into a new session.
  if (mediaRecorder || stream || mixedStream || mixingContext) {
    teardownLeakedPipeline('stale objects at start');
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

  // Store references for mid-recording operations (mic switching, state
  // verification during auto-split, etc.)
  recordingStoreRef = recordingStore;
  isAutoSplittingRef = isAutoSplitting || null;
  // DREC-3: remember the requested device and start fresh recovery state.
  lastRequestedDeviceId = deviceId || null;
  clearMicGraceTimeouts();

  let sysStream = null;
  let audioTeeActive = false;
  try {
    resetMicHealthState();
    clearSilenceWarning();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access is not available.');
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

    // Establish the new ID and durable directory BEFORE AudioTee starts.
    // Start recording session in store (pass userId for multi-account handling)
    const userId = authStore?.user?.id || authStore?.user?.userId || null;
    const sessionResult = await recordingStore.startRecording(userId, { deferCaptureStart: true });
    if (!sessionResult.success) {
      throw new Error(sessionResult.error || 'Failed to create recording session');
    }

    // Start system audio capture — AFTER the mic is acquired, never before.
    // Opening a Bluetooth headset's microphone forces the headset from A2DP
    // into HFP, which suspends the A2DP output endpoint and re-routes all
    // system audio to the HFP endpoint. Windows loopback capture binds to
    // the default output device ONCE at start; capturing before the mic
    // meant our own mic acquisition flipped the profile out from under the
    // loopback, which then recorded pure silence for the whole session.
    // - macOS: AudioTee writes PCM to file, merged via FFmpeg in combineChunks (returns true)
    // - Windows: desktopCapturer returns a MediaStream for real-time mixing
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

    // Reset mute state for new recording
    micMuted = false;

    // Always use mixing pipeline so system audio can be added/removed dynamically
    // If no mic and no sysStream (macOS AudioTee-only), the pipeline creates a silent
    // placeholder — AudioTee output is merged via FFmpeg in combineChunks
    const recordingStream = createMixingPipeline(stream, sysStream);
    mixedStream = recordingStream;
    if (audioTeeActive) setSystemAudioActive(true);

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

    const thisRecorder = mediaRecorder;
    recorderStopObserved = false;
    const thisRecordId = recordingStore.recordId;
    const writer = createRecordingChunkWriter({
      save: bytes => {
        if (recordingStore.recordId !== thisRecordId) return { success: false, error: 'Recording identity changed before audio was saved' };
        return recordingStore.saveChunk(Array.from(bytes));
      },
      onSaved: () => {
        lastSuccessfulChunkAt = Date.now();
        savedChunkCount++;
        if (stallWarned) { stallWarned = false; emit('captureRecovered', { savedChunks: savedChunkCount }); }
        recordingStore.chunkSaveErrors = 0;
        if (recordingStore.chunkSaveErrorWarning) {
          recordingStore.chunkSaveErrorWarning = false;
          emit('chunkSaveFailure', null);
        }
      },
      onFailure: failure => {
        recordingStore.chunkSaveErrors++;
        recordingStore.chunkSaveErrorWarning = true;
        // Store retries already exhausted. Preserve this blob and stop capture;
        // a later blob must never reuse its index and silently replace it.
        emit('chunkSaveFailure', { ...failure, retriesExhausted: true, consecutiveErrors: recordingStore.chunkSaveErrors });
      },
    });
    chunkWriter = writer;
    mediaRecorder.ondataavailable = event => {
      if (myGeneration !== recorderGeneration || (event.target && event.target !== thisRecorder)) {
        handleOrphanRecorderBlob(event);
        return;
      }
      // Capture flush waiters synchronously; an older in-flight save cannot
      // acknowledge a newer requestData() call.
      const waiters = flushResolvers;
      flushResolvers = [];
      const saved = writer.enqueue(event.data);
      saved.then(result => waiters.forEach(resolve => resolve(result)));
    };
    mediaRecorder.onstop = () => { recorderStopObserved = true; };

    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
      const message = event.error?.message || 'Recording error';
      recordingStore.setError(message);
      // DREC-10: a MediaRecorder error leaves the recorder in an undefined
      // state. If we don't stop it, ondataavailable keeps firing and persists
      // increasingly-corrupt chunks, AND the next startRecording() is blocked
      // by the `state !== 'inactive'` guard above — trapping the user in a dead
      // session with no way to start a new recording short of restarting the
      // app. Best-effort flush the in-buffer chunk (the normal ondataavailable
      // handler persists it), then stop so the recorder goes 'inactive': the
      // already-fsynced chunks remain recoverable and a fresh recording can
      // start. Emit a distinct event so the UI can show an error-specific
      // message rather than a generic stop.
      emit('recordingError', { message });
      try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          try { mediaRecorder.requestData(); } catch (e) { /* buffer may be unusable after an error */ }
          mediaRecorder.stop();
        }
      } catch (e) {
        console.error('Failed to stop MediaRecorder after error:', e);
      }
    };

    // P0 Data Loss Fix: Reduced from 5s to 3s to minimize crash data loss (V8).
    // Timeslice is overridable in dev/test via VITE_SUISSE_MEDIA_RECORDER_TIMESLICE_MS.
    mediaRecorder.start(MEDIA_RECORDER_TIMESLICE_MS);
    recordingStore.confirmCaptureStarted?.();

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
          handleMicDeviceChange();
          // Grace period: check after 3s if a replacement device appeared
          registerMicGraceTimeout(() => {
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
        // INT-2: iOS mutes (not ends) the mic track for an audio-session
        // interruption — an incoming call, Siri, an alarm — even in the
        // foreground. onended never fires, so without these the entire
        // mic-health machinery is blind to the most common interruption.
        track.onmute = () => {
          console.warn('Mic track muted (audio-session interruption?) — starting capture recovery');
          scheduleCaptureRecovery('mic-track-muted');
        };
        track.onunmute = () => {
          // Interruption over — make sure a recovery loop is running to
          // resume the frozen contexts and verify chunks flow again.
          console.warn('Mic track unmuted — verifying capture recovery');
          scheduleCaptureRecovery('mic-track-unmuted');
        };
      }
    }

    // Start state verification (every 5s)
    stateVerificationInterval = setInterval(() => {
      verifyRecordingState(recordingStore);
      checkChunkProgress(recordingStore, isAutoSplitting);
    }, 5000);

    // Start auth keep-alive to prevent session expiry during long recordings
    if (authStore) {
      startAuthKeepAlive(authStore);
    }

    // DREC-3: listen for device-list changes so a dropped mic that reconnects
    // is auto-switched back onto the live recording instead of stranding it.
    startMicRecoveryListener();

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

    if (audioTeeActive) await window.electronAPI?.systemAudio?.stop?.().catch(() => {});
    if (isElectron()) {
      await window.electronAPI?.recording?.setInProgress(false);
      await window.electronAPI?.recording?.setProcessing(false);
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
    window.electronAPI?.systemAudio?.setPaused?.(true).catch(() => {});
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
    window.electronAPI?.systemAudio?.setPaused?.(false).catch(() => {});
    recordingStore.resumeRecording();

    // Resume from the wall-clock accumulator, NOT recordingStore.duration — the
    // latter now holds the clamped captured-audio value, which would make the
    // minutes-limit / auto-split predicates under-count after a stall.
    const currentDuration = lastWallClockSec;
    const resumeTime = performance.now();
    durationBaseSec = currentDuration;
    durationRunStartedAt = resumeTime;
    // A fresh chunk hasn't arrived yet; don't let the pause gap read as a stall
    // on the first post-resume watchdog tick.
    lastSuccessfulChunkAt = Date.now();
    stallWarned = false;

    // INT-2: mediaRecorder.resume() resumes a WEDGED recorder just as happily
    // as a healthy one (the Nyberg incident: the user's pause→resume "worked"
    // at the store level while capture stayed dead for another hour). Verify
    // chunks actually flow within ~3 timeslices of resuming; if not, start
    // the recovery loop (resume contexts, re-acquire mic). Identity compare:
    // lastSuccessfulChunkAt was just reset above, so only a REAL chunk save
    // (which stamps a fresh Date.now()) changes it.
    const chunkMarkAtResume = lastSuccessfulChunkAt;
    setTimeout(() => {
      if (!recordingStoreRef?.isRecording) return;
      if (lastSuccessfulChunkAt !== chunkMarkAtResume) return; // a chunk landed — healthy
      console.warn('No chunk persisted within 10s of resume — starting capture recovery');
      scheduleCaptureRecovery('post-resume-stall');
    }, 10000);

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
        const elapsed = Math.floor((performance.now() - resumeTime) / 1000);
        const newDuration = currentDuration + elapsed;
        lastWallClockSec = newDuration;
        const shown = capturedDisplaySeconds(newDuration);
        recordingStore.updateDuration(shown);
        emit('durationChange', shown);

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

        // Auto-split at the advancing threshold (edge-triggered — see Bug D note).
        if (newDuration >= nextAutoSplitAtSeconds && !isAutoSplitting.value) {
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
  // Concurrent stop callers (manual stop click + emergency stop on chunk-save
  // failure + minutes-limit auto-stop) share ONE in-flight promise: running
  // the teardown/combine sequence twice caused double-combine / phase-thrash
  // (observed in production; full guard deferred in 3a7415b).
  if (stopInFlightPromise) return stopInFlightPromise;
  stopInFlightPromise = stopRecordingInternal(recordingStore, stopSystemAudio).finally(() => {
    stopInFlightPromise = null;
  });
  return stopInFlightPromise;
}

async function stopRecordingInternal(recordingStore, stopSystemAudio) {
  // Compare decoded audio with independent active time. The display is
  // clamped by saved chunks, which can conceal the very loss we must detect.
  const expectedDurationSec = getWallClockSeconds();
  stopDurationTracking();
  const recorder = mediaRecorder;
  const writer = chunkWriter;
  const retryingSave = !recorder;
  let stopError = null;
  if (splitInFlightPromise) await splitInFlightPromise;

  if (recorder && !recorderStopObserved) {
    // stop queues its FINAL dataavailable before stop. Keep the same ordered
    // handler for the entire recording, including every final blob.
    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        stopError = 'The recorder did not confirm its final audio. Saved chunks are preserved for recovery.';
        resolve();
      }, 10000);
      recorder.onstop = () => { recorderStopObserved = true; clearTimeout(timeout); resolve(); };
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); }
        catch (error) { stopError = error.message; clearTimeout(timeout); resolve(); }
      } else {
        // An error may already have stopped the recorder; queued final events
        // still get the opportunity to run before teardown.
        setTimeout(() => { clearTimeout(timeout); resolve(); }, 0);
      }
    });
  }

  // Releasing capture resources must not clear the unsaved-blob queue.
  cleanup();
  if (stopSystemAudio) {
    try { await stopSystemAudio(); } catch (error) { stopError = error.message; }
  }
  await hideRecordingNotification();
  const saved = writer ? await writer.drain({ retry: retryingSave }) : { success: true };
  if (!saved.success || stopError) {
    const error = saved.error || stopError;
    recordingStore.setError(error);
    if (isElectron()) {
      await window.electronAPI?.recording?.setUnsavedAudio?.(!saved.success ? recordingStore.recordId : null);
      await window.electronAPI?.recording?.setInProgress(false);
      await window.electronAPI?.recording?.setProcessing(false);
    }
    return { success: false, error, diskFull: saved.diskFull, unsavedAudio: !saved.success, partialRecovery: true, recordId: recordingStore.recordId };
  }
  if (!recordingStore.recordId) return { success: false, error: 'No active recording' };
  await window.electronAPI?.recording?.setUnsavedAudio?.(null);
  return recordingStore.stopRecording(expectedDurationSec);
}

/**
 * Cancel recording - stops MediaRecorder and cleans up without combining chunks
 * Used when user wants to discard the recording entirely
 */
export async function cancelRecording(recordingStore, stopSystemAudio) {
  // This is the explicit discard path. Drain any active write before the caller
  // deletes the recording directory so a late write cannot resurrect it.
  // Stop level monitoring, duration tracking, auth keepalive
  stopLevelMonitoring();
  stopDurationTracking();
  stopAuthKeepAlive();
  stopMicRecoveryListener(); // DREC-3

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
  if (chunkWriter) await chunkWriter.drain();
  chunkWriter = null;
  await window.electronAPI?.recording?.setUnsavedAudio?.(null);

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

  if (stopSystemAudio) await stopSystemAudio();

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
 * with a 6-second timeout fallback.
 * @returns {Promise<{flushed: boolean, timedOut: boolean}>}
 */
export async function flushRecordingData() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try {
      let didTimeout = false;
      const chunkSaved = new Promise((resolve) => {
        flushResolvers.push(resolve);
        // DREC-2: resolve after 6s (was 2s) even if ondataavailable hasn't
        // fired. The previous 2s budget could expire before the requested blob
        // arrived and its async saveChunk() completed (worst case ~timeslice +
        // IPC + disk I/O), so callers that await this — the visibility/suspend/
        // beforeunload flush paths — believed the final chunk was persisted
        // when it was still in flight, dropping it if the process then died.
        setTimeout(() => {
          const idx = flushResolvers.indexOf(resolve);
          if (idx !== -1) {
            flushResolvers.splice(idx, 1);
            didTimeout = true;
            resolve();
          }
        }, 6000);
      });
      mediaRecorder.requestData();
      const saved = await chunkSaved;
      // P2 Fix: Report whether flush actually produced data or timed out
      if (didTimeout) {
        console.warn('Flush timed out after 6s without ondataavailable');
      }
      return { flushed: !didTimeout && saved?.success === true, timedOut: didTimeout };
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
  stopMicRecoveryListener(); // DREC-3

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
