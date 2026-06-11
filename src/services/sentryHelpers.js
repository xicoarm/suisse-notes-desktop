/**
 * Sentry breadcrumb helpers for key app events
 * All functions are no-ops when Sentry is not initialized (desktop, dev)
 */
import { addBreadcrumb, captureException, setUser, setContext } from '../boot/sentry';

// --- Recording ---
export const sentryRecordingStart = (recordId) => {
  addBreadcrumb({ category: 'recording', message: 'Recording started', data: { recordId }, level: 'info' });
  // P1 Fix: Attach recording state to crash reports so crashes during recording are identifiable
  setContext('recording', { recordId, status: 'recording', startedAt: new Date().toISOString() });
};

export const sentryRecordingStop = (recordId, durationSeconds) => {
  addBreadcrumb({ category: 'recording', message: 'Recording stopped', data: { recordId, durationSeconds }, level: 'info' });
  // Clear recording context — no longer recording
  setContext('recording', null);
};

// Reported when the recorder drops a duplicate chunk (MediaRecorder delivering the
// same timeslice blob twice → recording-doubling bug). Captured as an EVENT, not a
// breadcrumb, so it is actually queryable in Sentry — the original incident produced
// no events and was a telemetry black hole.
export const sentryRecordingDuplicateChunk = (recordId, info) => {
  addBreadcrumb({ category: 'recording', message: 'Duplicate chunk dropped', data: { recordId, ...info }, level: 'warning' });
  captureException(new Error('Recorder: duplicate chunk dropped (MediaRecorder double-emit)'), {
    level: 'warning',
    tags: { operation: 'saveChunk-dedup' },
    extra: { recordId, ...info },
  });
};

export const sentryRecordingPause = (recordId) => {
  addBreadcrumb({ category: 'recording', message: 'Recording paused', data: { recordId }, level: 'info' });
};

export const sentryRecordingResume = (recordId) => {
  addBreadcrumb({ category: 'recording', message: 'Recording resumed', data: { recordId }, level: 'info' });
};

export const sentryRecordingError = (recordId, error) => {
  captureException(error, { tags: { recordId }, contexts: { recording: { recordId } } });
};

// --- Upload ---
export const sentryUploadStart = (recordId) => {
  addBreadcrumb({ category: 'upload', message: 'Upload started', data: { recordId }, level: 'info' });
};

export const sentryUploadSuccess = (recordId, audioFileId) => {
  addBreadcrumb({ category: 'upload', message: 'Upload succeeded', data: { recordId, audioFileId }, level: 'info' });
};

export const sentryUploadFail = (recordId, error) => {
  addBreadcrumb({ category: 'upload', message: 'Upload failed', data: { recordId, error: typeof error === 'string' ? error : error?.message }, level: 'error' });
};

// --- Auth ---
export const sentryLoginSuccess = (userId) => {
  addBreadcrumb({ category: 'auth', message: 'Login successful', data: { userId }, level: 'info' });
};

export const sentryLoginFail = (reason) => {
  addBreadcrumb({ category: 'auth', message: 'Login failed', data: { reason }, level: 'warning' });
};

export const sentryLogout = () => {
  addBreadcrumb({ category: 'auth', message: 'User logged out', level: 'info' });
  setUser(null);
};

export const sentrySetUser = (user) => {
  setUser(user);
};

// --- Lifecycle ---
export const sentryAppBackground = () => {
  addBreadcrumb({ category: 'lifecycle', message: 'App went to background', level: 'info' });
};

export const sentryAppForeground = () => {
  addBreadcrumb({ category: 'lifecycle', message: 'App came to foreground', level: 'info' });
};

export const sentryNetworkChange = (connected, connectionType) => {
  addBreadcrumb({ category: 'lifecycle', message: connected ? 'Network connected' : 'Network disconnected', data: { connectionType }, level: 'info' });
};

export const sentryLowBattery = (percent) => {
  addBreadcrumb({ category: 'lifecycle', message: `Low battery: ${percent}%`, data: { batteryPercent: percent }, level: 'warning' });
};
