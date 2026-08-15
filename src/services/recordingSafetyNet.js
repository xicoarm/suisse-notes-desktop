/**
 * Recording safety net — app-lifetime guardian for an active recording.
 *
 * Audit finding (2026-07-26): every emergency reaction to a failing recording
 * (disk-full auto-stop, repeated chunk-save-failure stop, wedged-recorder
 * stop, minutes-limit stop, system suspend flush) lived in useRecorder(),
 * which is instantiated ONLY by RecordPage. The recording itself deliberately
 * survives navigation — so the moment the user opened History or Settings
 * mid-recording, all of those events fired into the void: a full disk kept
 * "recording" nothing, the minutes limit never stopped anything, and a
 * suspend got no renderer flush.
 *
 * This module subscribes ONCE at app start (App.vue) and never unsubscribes.
 * While RecordPage is mounted its useRecorder handlers own the UX (richer
 * banners/dialogs) and this net stands down for the events they handle;
 * recordingService.stopRecording() is re-entrancy-guarded, so even a race
 * between both layers cannot double-stop.
 */
import { Notify } from 'quasar';
import { i18n } from '../boot/i18n';
import * as recordingService from './recordingService';
import { useRecordingStore } from '../stores/recording';
import { useRecordingsHistoryStore } from '../stores/recordings-history';
import { isElectron } from '../utils/platform';
import { captureMessage } from '../boot/sentry';

let initialized = false;
let recordPageActive = false;
let emergencyStopInFlight = false;

const t = (key, params) => i18n.global.t(key, params || {});

/** RecordPage registers/deregisters so the net can stand down while the
 *  page's own (richer) handlers are alive. */
export function setRecordPageActive(active) {
  recordPageActive = !!active;
}

/** Desktop: stop main-process system-audio capture + detach from the mix.
 *  Mirrors what useSystemAudio.stopCapture does, without needing the
 *  page-scoped composable instance. */
async function stopSystemAudioStandalone() {
  try {
    recordingService.removeSystemAudioStream();
    recordingService.setSystemAudioActive(false);
    if (isElectron() && window.electronAPI?.systemAudio?.stop) {
      await window.electronAPI.systemAudio.stop();
    }
  } catch (e) {
    console.warn('SafetyNet: stopping system audio failed:', e);
  }
}

/**
 * Emergency stop-with-save + hand the file to the upload pipeline.
 * The saved file is filed into the existing history entry as 'pending';
 * the app-level auto-retry (retryFailedUploads, runs every 60s) uploads it.
 */
async function emergencyStop(reasonKey, notifyType = 'negative') {
  if (emergencyStopInFlight) return;
  emergencyStopInFlight = true;
  const recordingStore = useRecordingStore();
  const recordId = recordingStore.recordId;
  try {
    captureMessage(`safety-net: emergency stop (${reasonKey}) with RecordPage inactive (recordId=${recordId})`, 'error');
    Notify.create({
      type: notifyType,
      message: t(reasonKey),
      icon: 'mic_off',
      timeout: 0,
      actions: [{ label: t('ok', 'OK'), color: 'white' }]
    });

    recordingStore.setFinalDuration(recordingStore.duration);
    const result = await recordingService.stopRecording(recordingStore, stopSystemAudioStandalone);

    if (result?.success && recordId) {
      let filePath = result.filePath || null;
      let fileSize = 0;
      if (isElectron() && window.electronAPI?.recording?.getFilePath) {
        try {
          const info = await window.electronAPI.recording.getFilePath(recordId, '.webm');
          if (info?.success) {
            filePath = info.filePath;
            fileSize = info.fileSize || 0;
          }
        } catch (e) { /* keep result.filePath */ }
      }
      const historyStore = useRecordingsHistoryStore();
      await historyStore.updateRecording(recordId, {
        duration: recordingStore.finalDuration || recordingStore.duration,
        ...(filePath ? { filePath } : {}),
        ...(fileSize ? { fileSize } : {}),
        uploadStatus: 'pending'
      });
      // Kick the uploader now instead of waiting for the next 60s tick.
      historyStore.retryFailedUploads().catch(() => {});
      captureMessage(`safety-net: emergency stop saved recording ${recordId} (${filePath || 'no path'})`, 'warning');
    } else if (recordId) {
      captureMessage(`safety-net: emergency stop could NOT finalize ${recordId}: ${result?.error || 'unknown'} — chunks remain on disk for recovery`, 'error');
    }
  } catch (e) {
    console.error('SafetyNet: emergency stop failed:', e);
    captureMessage(`safety-net: emergency stop threw: ${e?.message}`, 'error');
  } finally {
    emergencyStopInFlight = false;
  }
}

function handleChunkSaveFailure(data) {
  if (!data) return;
  if (recordPageActive) return; // RecordPage's handler owns this
  const recordingStore = useRecordingStore();
  if (!recordingStore.isRecording && !recordingStore.isPaused) return;
  if (data.diskFull) {
    emergencyStop('safetyNetDiskFullStop');
  } else if ((data.consecutiveErrors || 0) >= 3) {
    emergencyStop('safetyNetChunkFailStop');
  }
}

function handleCaptureRecoveryFailed() {
  if (recordPageActive) return;
  emergencyStop('captureRecoveryFailedMsg');
}

function handleLimitReached() {
  if (recordPageActive) return;
  const recordingStore = useRecordingStore();
  if (!recordingStore.isRecording && !recordingStore.isPaused) return;
  emergencyStop('minutesLimitReached', 'warning');
}

/** Main-process capture-quality warnings (ffmpeg missing, merge degraded).
 *  Registered here — NOT in useRecorder — so they survive page navigation
 *  (and are exempt from system.removeAllListeners, see preload). */
function handleCaptureWarning(data) {
  if (!data?.kind) return;
  if (data.kind === 'ffmpeg-missing') {
    Notify.create({
      type: 'warning',
      message: t('captureWarningFfmpegMissing'),
      icon: 'warning',
      timeout: 0,
      actions: [{ label: t('ok', 'OK'), color: 'white' }]
    });
  } else if (data.kind === 'merge-degraded') {
    Notify.create({
      type: 'warning',
      message: t('captureWarningMergeDegraded'),
      icon: 'volume_off',
      timeout: 15000
    });
  } else if (data.kind === 'recording-truncated') {
    // The combined file is materially shorter than the session recorded. The
    // audio that exists is still saved and uploaded — but the user must be told
    // rather than discovering the gap after the meeting.
    Notify.create({
      type: 'warning',
      message: t('recordingTruncatedWarning', {
        missing: data.missingSeconds ?? 0,
        produced: data.producedSeconds ?? 0,
        expected: data.expectedSeconds ?? 0
      }),
      icon: 'content_cut',
      timeout: 0,
      actions: [{ label: t('ok', 'OK'), color: 'white' }]
    });
  } else if (data.kind === 'system-audio-silent') {
    // macOS: AudioTee is running but delivering digital silence — almost always
    // because the meeting app renders to a device that is not the default
    // output. Persistent (timeout 0): the whole point is that this failure was
    // previously invisible for an entire meeting.
    recordingService.setSystemAudioActive(false);
    Notify.create({
      type: 'warning',
      message: t('captureWarningSystemAudioSilent', { seconds: data.silentSeconds ?? 90 }),
      icon: 'volume_off',
      timeout: 0,
      group: 'system-audio-silent',
      actions: [{ label: t('ok', 'OK'), color: 'white' }]
    });
  } else if (data.kind === 'system-audio-restored') {
    recordingService.setSystemAudioActive(true);
    Notify.create({
      type: 'positive',
      message: t('captureWarningSystemAudioRestored'),
      icon: 'volume_up',
      timeout: 6000,
      group: 'system-audio-silent'
    });
  }
}

/** System suspend: flush the in-flight chunk while the OS still lets us. */
async function handleSystemSuspend() {
  const recordingStore = useRecordingStore();
  try {
    if (recordingStore.isRecording) {
      await recordingService.flushRecordingData();
    }
  } catch (e) {
    console.warn('SafetyNet: suspend flush failed:', e);
  } finally {
    try { window.electronAPI.system.sendSuspendAck(); } catch (e) { /* main times out gracefully */ }
  }
}

/** System resume: reset watchdog baselines, revive audio contexts, and
 *  reflect a suspend-stopped system-audio capture in UI + state. */
async function handleSystemResume(data) {
  const recordingStore = useRecordingStore();
  if (data?.needsRecovery && recordingStore.isRecording) {
    recordingService.notifyForegrounded();
    await recordingService.resumeAudioContexts().catch(() => {});
  }
  if (data?.systemAudioStopped) {
    // Main stopped AudioTee at suspend to prevent wall-clock PCM desync.
    recordingService.setSystemAudioActive(false);
    Notify.create({
      type: 'warning',
      message: t('systemAudioStoppedAfterSleep'),
      icon: 'volume_off',
      timeout: 0,
      actions: [{ label: t('ok', 'OK'), color: 'white' }]
    });
  }
}

/** Main-process crash/power-loss recovery finished. The old behavior was
 *  SILENT on desktop: a recovered meeting just appeared in history with no
 *  toast, no badge — a user who didn't scroll never knew their audio survived
 *  (reliability audit GAP-1). Tell them clearly, and refresh the in-memory
 *  history (the main process rewrote the store file, so pinia is stale). */
async function handleRecordingRecovered(data) {
  const count = data?.count || 0;
  if (count <= 0) return;
  try {
    const historyStore = useRecordingsHistoryStore();
    if (typeof historyStore.loadRecordings === 'function') {
      await historyStore.loadRecordings();
    }
  } catch (e) {
    console.warn('SafetyNet: reload history after recovery failed:', e);
  }
  Notify.create({
    type: 'positive',
    message: t('recordingRecoveredMsg', { count }),
    caption: t('recordingRecoveredCaption'),
    icon: 'restore',
    timeout: 0,
    actions: [{ label: t('ok', 'OK'), color: 'white' }]
  });
  captureMessage(`safety-net: notified user of ${count} recovered recording(s)`, 'info');
}

export function initRecordingSafetyNet() {
  if (initialized) return;
  initialized = true;

  recordingService.addEventListener('chunkSaveFailure', handleChunkSaveFailure);
  recordingService.addEventListener('captureRecoveryFailed', handleCaptureRecoveryFailed);
  recordingService.addEventListener('limitReached', handleLimitReached);

  if (isElectron() && window.electronAPI?.system) {
    if (window.electronAPI.system.onCaptureWarning) {
      window.electronAPI.system.onCaptureWarning(handleCaptureWarning);
    }
    if (window.electronAPI.system.onRecordingRecovered) {
      window.electronAPI.system.onRecordingRecovered(handleRecordingRecovered);
    }
    // App-lifetime suspend/resume handling. useRecorder registers its own
    // page-scoped copies; both running is safe (flush + ack are idempotent,
    // main resolves on the first ack), and this one keeps working after
    // RecordPage unmounts — previously a suspend during "user is on the
    // History page" got no renderer flush at all.
    window.electronAPI.system.onSuspend(handleSystemSuspend);
    window.electronAPI.system.onResume(handleSystemResume);
  }

  console.log('Recording safety net initialized');
}
