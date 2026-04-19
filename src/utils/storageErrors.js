/**
 * Classify raw file-system errors into user-facing keys.
 *
 * Node/libuv throws messages like "EPERM: operation not permitted, fsync" that
 * mean nothing to end users. When those reach `recordingStore.error` they get
 * rendered verbatim in the UI. This helper turns them into translatable keys
 * with actionable guidance (check antivirus, free up disk, etc.).
 */

const CODE_MESSAGES = {
  EPERM: 'storageErrorLocked',
  EACCES: 'storageErrorLocked',
  EBUSY: 'storageErrorLocked',
  EMFILE: 'storageErrorLocked',
  ENFILE: 'storageErrorLocked',
  ENOSPC: 'storageErrorDiskFull',
  EROFS: 'storageErrorReadOnly',
  ENOENT: 'storageErrorMissing'
};

const FALLBACKS = {
  storageErrorLocked:
    'Could not save audio — the file appears to be locked by antivirus, backup software, or cloud sync. Pause those tools and try again.',
  storageErrorDiskFull: 'Not enough disk space to save the recording. Free up some space and try again.',
  storageErrorReadOnly: 'The recordings folder is read-only. Check folder permissions.',
  storageErrorMissing: 'The recordings folder is missing. Try reopening the app.',
  storageErrorGeneric: 'Could not save audio to disk. Please try again.'
};

/**
 * Infer a Node-style error code from a message string. Library functions sometimes
 * strip the `.code` field while forwarding the message, so we also regex-match the
 * typical libuv prefix "CODE: ..." or the word "fsync"/"no space".
 */
function codeFromError(error) {
  if (!error) return null;
  if (error.code) return error.code;
  const msg = typeof error === 'string' ? error : error.message || '';
  const prefix = /^([A-Z]{2,10}):/.exec(msg);
  if (prefix) return prefix[1];
  if (/no space left/i.test(msg)) return 'ENOSPC';
  if (/read[- ]?only/i.test(msg)) return 'EROFS';
  if (/operation not permitted|access is denied|permission denied/i.test(msg)) return 'EPERM';
  if (/resource busy|being used by another process/i.test(msg)) return 'EBUSY';
  return null;
}

/**
 * Pick the i18n key for a given error.
 */
export function storageErrorKey(error) {
  const code = codeFromError(error);
  return CODE_MESSAGES[code] || 'storageErrorGeneric';
}

/**
 * Humanize an error into a user-facing string. If a translator (`$t` / t)
 * is provided, uses i18n; otherwise falls back to English defaults.
 */
export function humanizeStorageError(error, t) {
  const key = storageErrorKey(error);
  if (typeof t === 'function') {
    try { return t(key); } catch { /* fall through to English */ }
  }
  return FALLBACKS[key] || FALLBACKS.storageErrorGeneric;
}

export const STORAGE_ERROR_KEYS = Object.keys(FALLBACKS);
