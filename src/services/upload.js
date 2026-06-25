/**
 * Upload service with two-phase verification
 * Addresses vulnerabilities V3 and V4:
 * - V3: Race Condition - File Deleted Before Server Confirmation
 * - V4: No Server-Side Acknowledgment Verification
 *
 * Platform-specific implementations:
 * - Electron (Windows/Mac): Uses main process upload via IPC
 * - Capacitor (iOS/Android): Uses TUS protocol for resumable uploads
 */

import { isElectron, isCapacitor, isMobile, PlatformConstants } from '../utils/platform';
import { calculateUploadChecksum, verifyUploadChecksum } from './integrity';
import { readFile, deleteFile } from './storage';
import { sentryUploadStart, sentryUploadSuccess, sentryUploadFail } from './sentryHelpers';
import { captureMessage } from '../boot/sentry';
import { uploadViaPresignedSas, isTransientUploadError, readBlobFromCapacitorPath } from './upload-direct';

// --- Persistent Mobile Upload Queue (localStorage + Preferences backup) ---
const MOBILE_UPLOAD_QUEUE_KEY = 'mobile_upload_queue';
const MAX_QUEUE_RETRIES = 10;

// P0 Data Loss Fix: Write-ahead pattern for queue persistence (V12)
const MOBILE_UPLOAD_QUEUE_TMP_KEY = MOBILE_UPLOAD_QUEUE_KEY + '_tmp';

// Re-entry guard for processMobileUploadQueue
let isProcessingMobileQueue = false;

// Per-record in-flight guard for Capacitor uploads. This is deliberately
// in-memory only: if iOS kills the app mid-upload, the guard disappears while
// the persisted queue item remains and can retry on next launch.
const activeMobileUploadRecordIds = new Set();

function _isMobileUploadActive(recordId) {
  return !!recordId && activeMobileUploadRecordIds.has(recordId);
}

function _beginMobileUpload(recordId) {
  if (!isCapacitor() || !recordId) return true;
  if (activeMobileUploadRecordIds.has(recordId)) return false;
  activeMobileUploadRecordIds.add(recordId);
  return true;
}

function _endMobileUpload(recordId) {
  if (isCapacitor() && recordId) {
    activeMobileUploadRecordIds.delete(recordId);
  }
}

// Staleness threshold: 7 days
const QUEUE_ITEM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Safely write queue to localStorage using write-ahead pattern (V12)
 * P2 Fix: Also writes to @capacitor/preferences as durable backup (survives iOS storage purge)
 */
function _safeWriteQueue(queue) {
  const data = JSON.stringify(queue);
  localStorage.setItem(MOBILE_UPLOAD_QUEUE_TMP_KEY, data);
  localStorage.setItem(MOBILE_UPLOAD_QUEUE_KEY, data);

  // Fire-and-forget write to Preferences for durability
  if (isCapacitor()) {
    import('@capacitor/preferences').then(({ Preferences }) =>
      Preferences.set({ key: MOBILE_UPLOAD_QUEUE_KEY, value: data })
    ).catch(() => {}); // best-effort
  }
}

/**
 * P2 Fix: Recover upload queue from Preferences if localStorage was purged by iOS.
 * Call once at app startup before processing the queue.
 */
export async function recoverQueueFromPreferences() {
  if (!isCapacitor()) return;

  // DMOB-5: recover from the durable Preferences backup if localStorage is
  // either empty (iOS purge) OR present-but-corrupt (a truncated write). The
  // old check bailed whenever the key merely existed, so a corrupt main key
  // blocked recovery and the queued uploads were silently lost.
  const existing = localStorage.getItem(MOBILE_UPLOAD_QUEUE_KEY);
  if (existing) {
    try {
      if (Array.isArray(JSON.parse(existing))) return; // valid existing queue — keep it
    } catch {
      console.warn('Upload queue localStorage is corrupt — attempting Preferences recovery');
    }
  }

  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: MOBILE_UPLOAD_QUEUE_KEY });
    if (value) {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        localStorage.setItem(MOBILE_UPLOAD_QUEUE_KEY, value);
        console.warn(`Upload queue recovered from Preferences: ${parsed.length} item(s)`);
      }
    }
  } catch (e) {
    console.warn('Could not recover upload queue from Preferences:', e);
  }
}

/**
 * Get the persistent mobile upload queue from localStorage
 * With validation and recovery from _tmp key on corruption (V12)
 * @returns {Array<{recordId: string, filePath: string, metadata: Object, retries: number, addedAt: number}>}
 */
// Drop items older than QUEUE_ITEM_MAX_AGE_MS so an unprocessed queue
// can't grow unbounded. Returns the cleaned array AND, if anything was
// dropped, persists the cleaned version back to storage so the GC is a
// one-time pay on each load rather than recomputing every getQueue().
function _gcStaleItems(items, persistBackKey = null) {
  if (!Array.isArray(items) || items.length === 0) return items || [];
  const now = Date.now();
  const fresh = items.filter(item => {
    if (!item || typeof item.addedAt !== 'number') return true; // keep if no timestamp
    return (now - item.addedAt) <= QUEUE_ITEM_MAX_AGE_MS;
  });
  const dropped = items.length - fresh.length;
  if (dropped > 0) {
    console.warn(`Upload queue GC: dropped ${dropped} item(s) older than ${QUEUE_ITEM_MAX_AGE_MS / (24 * 3600 * 1000)} days`);
    if (persistBackKey) {
      try { localStorage.setItem(persistBackKey, JSON.stringify(fresh)); } catch { /* best-effort */ }
    }
  }
  return fresh;
}

export function getMobileUploadQueue() {
  let mainCorrupt = false;
  try {
    const raw = localStorage.getItem(MOBILE_UPLOAD_QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Validate: must be an array with valid entries
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(item =>
          item && typeof item.recordId === 'string' && typeof item.filePath === 'string'
        );
        return _gcStaleItems(valid, MOBILE_UPLOAD_QUEUE_KEY);
      }
    }
  } catch {
    // Main key corrupted - try recovery from _tmp
    mainCorrupt = true;
    console.warn('Upload queue corrupted, attempting recovery from _tmp key');
  }

  // Try recovery from _tmp key
  try {
    const tmpRaw = localStorage.getItem(MOBILE_UPLOAD_QUEUE_TMP_KEY);
    if (tmpRaw) {
      const parsed = JSON.parse(tmpRaw);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(item =>
          item && typeof item.recordId === 'string' && typeof item.filePath === 'string'
        );
        const fresh = _gcStaleItems(valid, MOBILE_UPLOAD_QUEUE_KEY);
        // Restore main key from _tmp (already done by _gcStaleItems if it
        // dropped anything; otherwise persist the recovered set explicitly).
        if (fresh.length === valid.length) {
          localStorage.setItem(MOBILE_UPLOAD_QUEUE_KEY, JSON.stringify(fresh));
        }
        console.log('Upload queue recovered from _tmp key');
        return fresh;
      }
    }
  } catch {
    console.warn('Upload queue _tmp recovery also failed');
  }

  // DMOB-5: if the main key existed but was unreadable and the _tmp fallback
  // also failed, surface it instead of silently returning [] (which reads as
  // "no pending uploads" and would drop the user's recordings). The durable
  // Preferences backup is restored asynchronously by recoverQueueFromPreferences
  // at startup.
  if (mainCorrupt) {
    try { captureMessage('upload queue: main+tmp keys unreadable — relying on Preferences backup', 'error'); } catch { /* sentry optional */ }
  }
  return [];
}

/**
 * Add a failed upload to the persistent mobile queue
 * @param {string} recordId
 * @param {string} filePath
 * @param {Object} metadata - Upload metadata (duration, title, customVocabulary, etc.)
 */
export function addToMobileUploadQueue(recordId, filePath, metadata) {
  try {
    const queue = getMobileUploadQueue();
    // Don't add duplicates
    if (queue.some(item => item.recordId === recordId)) return;
    queue.push({ recordId, filePath, metadata, retries: 0, addedAt: Date.now() });
    _safeWriteQueue(queue);
  } catch (e) {
    console.warn('Failed to add to mobile upload queue:', e);
  }
}

/**
 * Remove a successfully uploaded item from the queue
 * @param {string} recordId
 */
export function removeFromMobileUploadQueue(recordId) {
  try {
    const queue = getMobileUploadQueue().filter(item => item.recordId !== recordId);
    _safeWriteQueue(queue);
  } catch (e) {
    console.warn('Failed to remove from mobile upload queue:', e);
  }
}

/**
 * Update retry count for a specific queue item
 * @param {string} recordId
 * @param {number} retries
 */
function _updateQueueItemRetries(recordId, retries) {
  try {
    const queue = getMobileUploadQueue();
    const item = queue.find(i => i.recordId === recordId);
    if (item) {
      item.retries = retries;
      _safeWriteQueue(queue);
    }
  } catch (e) {
    console.warn('Failed to update queue item retries:', e);
  }
}

/**
 * Mark a queue item as "unrecoverable": its error class is non-retryable
 * (auth revoked, checksum mismatch, unsupported file) so the background
 * processor should skip it and the UI should surface it as failed-permanent
 * rather than burn the retry budget silently.
 * @param {string} recordId
 * @param {string} reason - short machine/human readable tag
 */
function _markQueueItemUnrecoverable(recordId, reason) {
  try {
    const queue = getMobileUploadQueue();
    const item = queue.find(i => i.recordId === recordId);
    if (item) {
      item.unrecoverable = true;
      item.unrecoverableReason = reason;
      _safeWriteQueue(queue);
    }
  } catch (e) {
    console.warn('Failed to mark queue item unrecoverable:', e);
  }
}

/**
 * Classify an upload error as retryable vs terminal. Mirrors the logic
 * used by `uploadWithRetry` so the background queue processor makes the
 * same call — avoids burning MAX_QUEUE_RETRIES on a 403/checksum-mismatch
 * that will never succeed.
 * @param {string} error - Error message
 * @returns {boolean}
 */
function _isRetryableError(error) {
  if (!error) return false;
  const nonRetryable = [
    'Checksum mismatch',
    'Invalid file format',
    'Unauthorized',
    'Forbidden',
    'File too large',
    'Insufficient minutes',
    'Recording too long',
    'DURATION_EXCEEDED',
    'FILE_TOO_LARGE',
    'BLOB_MISSING',
    'INSUFFICIENT_MINUTES',
  ];
  return !nonRetryable.some(msg => error.includes(msg));
}

/**
 * Process the persistent mobile upload queue — retries all pending uploads
 * @param {Object} authStore - Auth store for token
 * @param {Function} getApiUrl - Function returning the API URL
 * @returns {Promise<{processed: number, succeeded: number, failed: number}>}
 */
export async function processMobileUploadQueue(authStore, getApiUrl) {
  if (isProcessingMobileQueue) return { processed: 0, succeeded: 0, failed: 0, skipped: true, purged: [], unrecoverable: [] };
  isProcessingMobileQueue = true;

  try {
  const queue = getMobileUploadQueue();
  if (queue.length === 0) return { processed: 0, succeeded: 0, failed: 0, purged: [], unrecoverable: [] };

  const apiUrl = typeof getApiUrl === 'function' ? getApiUrl() : getApiUrl;
  let succeeded = 0;
  let failed = 0;
  const purgedRecordIds = [];        // Stale / over-budget items removed silently
  const unrecoverableRecordIds = []; // Items hit non-retryable errors this run
  let tokenRefreshAttempts = 0;
  const MAX_TOKEN_REFRESHES_PER_RUN = 2;

  // Proactively refresh token if expiring soon (e.g., after long offline period)
  if (authStore.isTokenExpiringSoon && authStore.isTokenExpiringSoon()) {
    try {
      const refreshResult = await authStore.handleAuthError();
      if (refreshResult.success) {
        console.log('Proactively refreshed expiring token before queue processing');
        tokenRefreshAttempts++;
      }
    } catch (e) {
      console.warn('Proactive token refresh failed:', e);
    }
  }

  // Purge stale items (older than 7 days) and items that exceeded max retries.
  // We track the IDs so the caller can update history records / notify the user
  // instead of silently losing recordings.
  for (let j = queue.length - 1; j >= 0; j--) {
    const item = queue[j];
    const isStale = item.addedAt && (Date.now() - item.addedAt > QUEUE_ITEM_MAX_AGE_MS);
    if (isStale || item.retries >= MAX_QUEUE_RETRIES) {
      console.warn(`Removing expired queue item ${item.recordId} (retries: ${item.retries}, age: ${item.addedAt ? Math.round((Date.now() - item.addedAt) / 86400000) + 'd' : 'unknown'})`);
      removeFromMobileUploadQueue(item.recordId);
      purgedRecordIds.push(item.recordId);
      failed++;
    }
  }

  // Re-read queue after purge, sort strict-FIFO by addedAt so the user's
  // recording order is preserved even if items were added out-of-order
  // (e.g. from different threads, or queue rehydration from Preferences
  // backup that doesn't guarantee insertion order).
  const activeQueue = getMobileUploadQueue()
    .slice()
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));

  let i = 0;
  while (i < activeQueue.length) {
    const item = activeQueue[i];

    // Skip items previously classified as unrecoverable — they won't succeed
    // on retry and would otherwise waste the retry budget / user's time.
    // UI surfaces them as 'failed' so the user can manually retry via the
    // history card if they want to.
    if (item.unrecoverable) {
      i++;
      continue;
    }

    if (_isMobileUploadActive(item.recordId)) {
      i++;
      continue;
    }

    try {
      const result = await uploadWithVerification({
        filePath: item.filePath,
        recordId: item.recordId,
        apiUrl,
        authToken: authStore.token,
        metadata: item.metadata || {},
        onProgress: () => {},
        getAuthStore: () => authStore
      });

      if (result.success) {
        removeFromMobileUploadQueue(item.recordId);
        succeeded++;

        // Update history if store is available
        try {
          const { useRecordingsHistoryStore } = await import('../stores/recordings-history');
          const historyStore = useRecordingsHistoryStore();
          await historyStore.updateRecording(item.recordId, {
            uploadStatus: 'uploaded',
            audioFileId: result.audioFileId
          });
        } catch (e) {
          console.warn('Could not update history after queued upload:', e);
        }
        i++;
      } else {
        // Token expired? Refresh in-place, retry same item without burning retry budget.
        if (isTokenExpiredError(result.error, result.status) && tokenRefreshAttempts < MAX_TOKEN_REFRESHES_PER_RUN) {
          try {
            const refreshResult = await authStore.handleAuthError();
            tokenRefreshAttempts++;
            if (refreshResult.success) {
              console.log('Token refreshed after 401, retrying upload for', item.recordId);
              continue; // Retry same item without incrementing retries
            }
          } catch (e) {
            console.warn('Token refresh failed during queue processing:', e);
          }
        }

        // Non-retryable (403, checksum mismatch, invalid format)? Mark as
        // unrecoverable and stop retrying automatically. Old behavior
        // incremented retries until hit MAX_QUEUE_RETRIES then silently
        // dropped — user lost the recording with no signal.
        if (!_isRetryableError(result.error)) {
          _markQueueItemUnrecoverable(item.recordId, result.error || 'unknown');
          unrecoverableRecordIds.push(item.recordId);
          failed++;
          i++;
          continue;
        }

        // Retryable error — increment retry count
        item.retries++;
        _updateQueueItemRetries(item.recordId, item.retries);
        failed++;
        i++;
      }
    } catch (e) {
      console.warn('Queued upload failed for', item.recordId, e);
      // Exception-level token error handling
      if (isTokenExpiredError(e.message) && tokenRefreshAttempts < MAX_TOKEN_REFRESHES_PER_RUN) {
        try {
          const refreshResult = await authStore.handleAuthError();
          tokenRefreshAttempts++;
          if (refreshResult.success) {
            console.log('Token refreshed after exception, retrying upload for', item.recordId);
            continue; // Retry same item
          }
        } catch (refreshErr) {
          console.warn('Token refresh failed:', refreshErr);
        }
      }
      // Exception-level non-retryable check
      if (!_isRetryableError(e.message)) {
        _markQueueItemUnrecoverable(item.recordId, e.message || 'unknown');
        unrecoverableRecordIds.push(item.recordId);
        failed++;
        i++;
        continue;
      }
      item.retries++;
      _updateQueueItemRetries(item.recordId, item.retries);
      failed++;
      i++;
    }
  }

  // Surface unrecoverable / purged items to history so the UI can show them
  // as failed instead of silently losing them. Wrapped in best-effort since
  // the history store may not be available in all call contexts.
  if (purgedRecordIds.length > 0 || unrecoverableRecordIds.length > 0) {
    try {
      const { useRecordingsHistoryStore } = await import('../stores/recordings-history');
      const historyStore = useRecordingsHistoryStore();
      for (const id of purgedRecordIds) {
        await historyStore.updateRecording(id, {
          uploadStatus: 'failed',
          uploadError: 'Upload abandoned after too many retries or 7 days offline'
        });
      }
      for (const id of unrecoverableRecordIds) {
        const queueItem = queue.find(q => q.recordId === id);
        await historyStore.updateRecording(id, {
          uploadStatus: 'failed',
          uploadError: queueItem?.unrecoverableReason || 'Upload cannot be retried automatically'
        });
      }
    } catch (e) {
      console.warn('Could not flag purged/unrecoverable items in history:', e);
    }
  }

  return { processed: activeQueue.length, succeeded, failed, purged: purgedRecordIds, unrecoverable: unrecoverableRecordIds };
  } finally {
    isProcessingMobileQueue = false;
  }
}

// Token refresh callback - set by calling code
let onTokenRefreshNeeded = null;

/**
 * Set the token refresh callback
 * @param {Function} callback - Async function that returns { success, token } or null
 */
export const setTokenRefreshCallback = (callback) => {
  onTokenRefreshNeeded = callback;
};

/**
 * Check if an error indicates token expiration
 * @param {string} error - Error message
 * @param {number} status - HTTP status code (if available)
 * @returns {boolean}
 */
const isTokenExpiredError = (error, status = 0) => {
  if (status === 401) return true;

  const tokenErrors = [
    'token expired',
    'jwt expired',
    'invalid token',
    'unauthorized',
    'authentication required',
    'not authenticated'
  ];

  const errorLower = (error || '').toLowerCase();
  return tokenErrors.some(te => errorLower.includes(te));
};

// Upload state
const uploadQueue = [];
let isProcessingQueue = false;

// Active XHR references for cancellation (mobile only)
const activeXhrUploads = new Map();

/**
 * Cancel an upload — both in-flight AND pending-in-queue.
 * Previous behavior only aborted the active XHR; if the item was already
 * in the persistent queue it would get picked up again on the next
 * processMobileUploadQueue run, which surprised users who tapped Cancel
 * and saw the upload re-attempt itself.
 *
 * @param {string} recordId - Recording ID
 * @param {Object} [opts]
 * @param {boolean} [opts.removeFromQueue=true] - Also drop the item from
 *   the persistent queue so it won't auto-retry. Set false only if you
 *   intend to keep it queued (e.g. pause semantics, not yet wired).
 * @returns {Promise<{success: boolean, cancelled?: boolean, error?: string}>}
 */
export const cancelUpload = async (recordId, opts = {}) => {
  const { removeFromQueue = true } = opts;
  let cancelledXhr = false;

  // Abort in-flight XHR if there is one
  const xhr = activeXhrUploads.get(recordId);
  if (xhr) {
    try {
      xhr.abort();
      activeXhrUploads.delete(recordId);
      cancelledXhr = true;
    } catch (e) {
      console.error('Error aborting XHR upload:', e);
      return { success: false, error: e.message };
    }
  }

  // Also remove from the persistent queue so the next queue-processing
  // pass doesn't resurrect the upload after the user said cancel.
  if (removeFromQueue) {
    try {
      removeFromMobileUploadQueue(recordId);
    } catch (e) {
      console.warn('cancelUpload: queue removal failed:', e);
    }
  }

  return { success: true, cancelled: cancelledXhr, removedFromQueue: removeFromQueue };
};

/**
 * Sleep utility
 * @param {number} ms - Milliseconds to sleep
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calculate exponential backoff delay
 * @param {number} attempt - Current attempt number (0-indexed)
 * @returns {number} Delay in milliseconds
 */
const getBackoffDelay = (attempt) => {
  const delay = PlatformConstants.INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, PlatformConstants.MAX_RETRY_DELAY_MS);
};

/**
 * Read file data for checksum calculation
 * Platform-aware file reading
 * @param {string} filePath - Path to the file
 * @returns {Promise<ArrayBuffer>}
 */
const readFileData = async (filePath) => {
  if (isElectron()) {
    // On Electron, use the preload API
    const result = await window.electronAPI.file.readBinary(filePath);
    if (result.success) {
      return new Uint8Array(result.data).buffer;
    }
    throw new Error(result.error || 'Failed to read file');
  }

  if (isCapacitor()) {
    const result = await readFile(filePath);
    if (result.success) {
      return result.data;
    }
    throw new Error(result.error || 'Failed to read file');
  }

  throw new Error('Unsupported platform');
};

/**
 * Poll server for upload status and verification
 * @param {string} apiUrl - Base API URL
 * @param {string} audioFileId - Server-assigned file ID
 * @param {string} localChecksum - Local file checksum for verification
 * @param {number} maxAttempts - Maximum polling attempts
 * @param {string} [authToken] - Bearer token. The status route requires auth
 *   (matches the contract in src/lib/api/desktop-contract.ts). Without this
 *   every poll returns 401, the client retries 15 times, then mistakenly
 *   raises "Server confirmation timeout" — even though the audio actually
 *   uploaded fine. Pure bug, see commit history.
 * @returns {Promise<{persisted: boolean, verified: boolean, error?: string}>}
 */
const pollServerStatus = async (apiUrl, audioFileId, localChecksum, maxAttempts = 15, authToken = null, getFreshToken = null) => {
  const pollInterval = 2000; // 2 seconds between polls
  let currentToken = authToken;
  // We only refresh-and-retry once per poll session — if the second attempt
  // also 401s, the token can't be saved and we accept trust-based fallback
  // (the audio bytes already landed via the authenticated POST).
  let didTokenRefresh = false;
  const buildHeaders = () => (currentToken ? { Authorization: `Bearer ${currentToken}` } : {});

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`${apiUrl}/api/desktop/upload/${audioFileId}/status`, { headers: buildHeaders() });

      if (!response.ok) {
        // Server doesn't support status endpoint yet, fall back to trust-based
        if (response.status === 404) {
          console.warn('Upload status endpoint not available, using trust-based confirmation');
          return { persisted: true, verified: false, fallback: true };
        }
        // 401: try one token refresh on the first occurrence, then retry the
        // same poll attempt. If that's also 401, fall back to trust-based —
        // the user shouldn't see "failed" because of a polling-side auth
        // problem after the audio bytes already landed via the authenticated
        // POST. Refresh is at most once per pollServerStatus call.
        if (response.status === 401) {
          if (!didTokenRefresh && typeof getFreshToken === 'function') {
            didTokenRefresh = true;
            try {
              const newToken = await getFreshToken();
              if (newToken && newToken !== currentToken) {
                currentToken = newToken;
                console.warn('Upload status endpoint returned 401; refreshed token and retrying once');
                attempt--; // retry the same attempt with the new token
                continue;
              }
            } catch (refreshErr) {
              console.warn('Upload status token refresh threw:', refreshErr.message);
            }
          }
          console.warn('Upload status endpoint returned 401; using trust-based confirmation');
          return { persisted: true, verified: false, fallback: true, authError: true };
        }
        throw new Error(`Status check failed: ${response.status}`);
      }

      const status = await response.json();

      // Map the server contract enum (src/lib/api/desktop-contract.ts →
      // UploadStatusResponse.status: RecordingStatus) onto the verification
      // semantics this function returns.
      //
      // The moment the server returns ANY status that's not RECORDING or
      // CANCELLED, the file IS persisted server-side (the upload POST
      // completed and a Meeting row + audioFileId exist). The remaining
      // states tell us about the downstream transcription pipeline, which
      // we don't need to wait for here — the client can mark the recording
      // uploaded and let transcription complete asynchronously.
      //
      // Legacy values 'persisted' / 'complete' kept for backward compat in
      // case any older endpoints still echo them.
      const s = status.status;
      const PERSISTED_STATES = new Set([
        'persisted', 'complete', 'processing',         // legacy (kept in lockstep with electron-main)
        'UPLOADING', 'PROCESSING', 'COMPLETED',        // contract
      ]);
      const FAILED_STATES = new Set([
        'failed',                                       // legacy
        'FAILED', 'CANCELLED',                          // contract
      ]);

      if (PERSISTED_STATES.has(s)) {
        if (status.checksum && localChecksum) {
          const checksumMatch = status.checksum === localChecksum;
          if (!checksumMatch) {
            console.error('Checksum mismatch!', { server: status.checksum, local: localChecksum });
            return { persisted: true, verified: false, error: 'Checksum mismatch' };
          }
          return { persisted: true, verified: true };
        }
        // No checksum on the response — for the contract endpoint this is
        // the normal case (checksum lives elsewhere). The bytes are on the
        // server, the audioFileId resolves to a Meeting row, treat as
        // verified.
        return { persisted: true, verified: true };
      }

      if (FAILED_STATES.has(s)) {
        return { persisted: false, verified: false, error: status.errorMessage || status.error || `Server reported status=${s}` };
      }

      // DUREC-1: RECORDING means the server is still ingesting — keep polling.
      // Any OTHER unrecognized status means the backend added a
      // post-persistence state the client doesn't know yet; the bytes already
      // landed via the authenticated upload, so treat as persisted
      // (trust-based) rather than polling to a false "confirmation timeout"
      // that triggers a duplicate re-upload and burns the user's minutes.
      if (s !== 'RECORDING' && s !== 'recording') {
        console.warn(`Upload status unrecognized "${s}" — treating as persisted (fail-safe)`);
        try { captureMessage(`upload: unknown status enum=${s}`, 'warning'); } catch { /* sentry optional */ }
        return { persisted: true, verified: false, fallback: true, unknownStatus: s };
      }
      // RECORDING — server hasn't confirmed persistence yet. Keep polling.
      await sleep(pollInterval);
    } catch (error) {
      console.warn(`Status poll attempt ${attempt + 1} failed:`, error.message);
      if (attempt < maxAttempts - 1) {
        await sleep(pollInterval);
      }
    }
  }

  // Timeout - server didn't confirm in time
  return { persisted: false, verified: false, error: 'Server confirmation timeout' };
};

/**
 * Upload recording with two-phase verification
 * Phase 1: Upload file
 * Phase 2: Verify server persistence before allowing deletion
 *
 * @param {Object} options - Upload options
 * @param {string} options.filePath - Path to the audio file (Capacitor) or File object (mobile file picker)
 * @param {File} options.file - File object for direct file upload (mobile)
 * @param {string} options.recordId - Recording ID
 * @param {string} options.apiUrl - API base URL
 * @param {string} options.authToken - Authentication token
 * @param {Object} options.metadata - Recording metadata
 * @param {Function} options.onProgress - Progress callback (0-100)
 * @param {Function} options.onStatusChange - Status change callback
 * @param {Function} options.getAuthStore - Function to get auth store for token refresh
 * @returns {Promise<{success: boolean, audioFileId?: string, canDelete: boolean, error?: string}>}
 */
export const uploadWithVerification = async (options) => {
  const {
    filePath,
    file, // File object for direct upload
    recordId,
    apiUrl,
    authToken,
    metadata = {},
    onProgress = () => {},
    onStatusChange = () => {},
    getAuthStore = null // For token refresh
  } = options;

  // Helper to get a fresh token
  const getFreshToken = async () => {
    if (getAuthStore) {
      const authStore = getAuthStore();
      const result = await authStore.handleAuthError();
      if (result.success) {
        return result.token;
      }
    }
    return null;
  };

  let audioFileId = null;
  let localChecksum = null;

  sentryUploadStart(recordId);

  // DMOB-6: enqueue the upload BEFORE any network work so an in-flight upload
  // the OS kills — iOS suspends the network when backgrounded mid-upload, then
  // may terminate the app — is not lost. processMobileUploadQueue resumes it on
  // next launch / network-online / foreground. Idempotent (dedupes by
  // recordId) and removed on confirmed success below. Only for Capacitor
  // file-path uploads; a picked File object has no resumable path.
  if (isCapacitor() && filePath && recordId) {
    addToMobileUploadQueue(recordId, filePath, metadata);
  }

  if (!_beginMobileUpload(recordId)) {
    captureMessage(`upload: skipped duplicate in-flight mobile upload recordId=${recordId}`, 'warning');
    return {
      success: false,
      canDelete: false,
      inProgress: true,
      error: 'Upload already in progress'
    };
  }

  try {
    // Phase 1a: Calculate local checksum before upload
    // Skip on mobile — reading the file for checksumming is expensive (base64 decode)
    // and the file will be read again for the actual upload, causing a long freeze.
    // TUS protocol has its own integrity checks on mobile.
    if (!isCapacitor()) {
      onStatusChange('calculating_checksum');
      try {
        let fileData;
        if (file) {
          fileData = await file.arrayBuffer();
        } else if (filePath) {
          fileData = await readFileData(filePath);
        }

        if (fileData) {
          localChecksum = await calculateUploadChecksum(fileData);
          console.log('Local checksum calculated:', localChecksum);
        }
      } catch (error) {
        console.warn('Could not calculate local checksum:', error.message);
      }
    }

    // Phase 1b: Upload the file
    onStatusChange('uploading');

    let currentToken = authToken;
    let uploadAttempts = 0;
    const maxTokenRefreshAttempts = 2;

    while (uploadAttempts < maxTokenRefreshAttempts) {
      uploadAttempts++;

      if (isElectron()) {
        // Use Electron's upload mechanism via IPC
        // The Electron main process handles the actual upload with retry logic
        const uploadResult = await window.electronAPI.upload.start({
          recordId,
          filePath,
          metadata
        });

        if (!uploadResult.success) {
          // Check for token expiration
          if (isTokenExpiredError(uploadResult.error, uploadResult.status)) {
            const newToken = await getFreshToken();
            if (newToken && uploadAttempts < maxTokenRefreshAttempts) {
              currentToken = newToken;
              console.log('Token refreshed, retrying upload...');
              continue;
            }
          }
          throw new Error(uploadResult.error || 'Upload failed');
        }

        audioFileId = uploadResult.audioFileId;
        break;
      } else if (isCapacitor() || file) {
        // Try direct-to-Azure-Blob via SAS URL (works on iOS, Android, browser
        // file picker). Falls through to simple POST when the server reports
        // mode: 'fallback' (i.e. running in local-storage mode).
        captureMessage(`upload: uploadWithVerification entering SAS path — recordId=${recordId} hasFile=${!!file} hasFilePath=${!!filePath}`, 'info');
        let uploadResult;
        try {
          uploadResult = await uploadViaPresignedSas({
            apiBaseUrl: apiUrl,
            authToken: currentToken,
            recordId,
            filePath,
            file,
            metadata,
            onProgress: ({ progress, bytesUploaded, bytesTotal }) => {
              onProgress(progress, bytesUploaded, bytesTotal);
            },
          });
          captureMessage(`upload: uploadViaPresignedSas returned mode=${uploadResult?.mode} success=${uploadResult?.success}`, 'info');
        } catch (transientErr) {
          // Bubbled-up transient error from upload-direct — only network
          // failures should land here. Surface to outer retry.
          captureMessage(`upload: uploadViaPresignedSas THREW — transient=${isTransientUploadError(transientErr)} name=${transientErr.name} msg=${transientErr.message}`, 'error');
          if (!isTransientUploadError(transientErr)) {
            throw transientErr;
          }
          throw new Error(transientErr.message || 'Upload failed (network)');
        }

        if (uploadResult.mode === 'fallback') {
          // Server is in local-storage mode — use the legacy POST.
          captureMessage(`upload: falling back to legacy POST /api/desktop/upload reason=${uploadResult.reason || '-'}`, 'info');
          uploadResult = await uploadFileMobileSimple(
            filePath,
            apiUrl,
            currentToken,
            metadata,
            onProgress,
            file,
            recordId
          );
          captureMessage(`upload: legacy POST returned success=${uploadResult?.success} status=${uploadResult?.status || '-'} error=${uploadResult?.error || '-'}`, uploadResult?.success ? 'info' : 'warning');
        }

        if (!uploadResult.success) {
          if (isTokenExpiredError(uploadResult.error, uploadResult.status)) {
            const newToken = await getFreshToken();
            if (newToken && uploadAttempts < maxTokenRefreshAttempts) {
              currentToken = newToken;
              console.log('Token refreshed, retrying upload...');
              continue;
            }
          }
          if (uploadResult.cancelled) {
            return {
              success: false,
              canDelete: false,
              error: 'Upload cancelled',
              cancelled: true,
            };
          }
          // Surface terminal failures with their original status so outer
          // retry can distinguish "give up" vs "try again".
          const err = new Error(uploadResult.error || 'Upload failed');
          err.status = uploadResult.status;
          err.canRetry = uploadResult.canRetry;
          err.insufficientMinutes = uploadResult.insufficientMinutes;
          throw err;
        }

        audioFileId = uploadResult.audioFileId;
        // Guard: if the server reported success=true but didn't echo back an
        // audioFileId (we've seen this with malformed response bodies or
        // legacy endpoints returning 200 with an unexpected schema), treat
        // the upload as failed. We CANNOT poll a null audioFileId for status
        // and we CANNOT later link a transcription to a missing id — the
        // recording would be effectively orphaned server-side. Better to
        // fail loudly and let the user retry than silently lose the link.
        if (!audioFileId) {
          throw new Error('Upload reported success but server returned no audioFileId');
        }
        // Direct flow already verified server-side; skip extra status poll.
        if (uploadResult.verified) {
          if (isCapacitor() && recordId) removeFromMobileUploadQueue(recordId); // DMOB-6
          onStatusChange('complete');
          sentryUploadSuccess(recordId, audioFileId);
          return {
            success: true,
            audioFileId,
            meetingId: uploadResult.meetingId,
            transcriptionId: uploadResult.transcriptionId,
            canDelete: true,
            verified: true,
            deduplicated: uploadResult.deduplicated,
            gatewayFailed: uploadResult.gatewayFailed,
          };
        }
        break;
      } else {
        throw new Error('Unsupported platform');
      }
    }

    // Phase 2: Verify server persistence
    onStatusChange('verifying');
    const verification = await pollServerStatus(apiUrl, audioFileId, localChecksum, 15, currentToken, getFreshToken);

    if (!verification.persisted) {
      console.error('Server did not confirm file persistence:', verification.error);
      return {
        success: false,
        audioFileId,
        canDelete: false,
        error: verification.error || 'Server did not confirm file persistence'
      };
    }

    if (verification.error === 'Checksum mismatch') {
      console.error('Checksum verification failed');
      return {
        success: false,
        audioFileId,
        canDelete: false,
        error: 'File verification failed - checksums do not match'
      };
    }

    // Upload successful and verified (or trust-based)
    if (isCapacitor() && recordId) removeFromMobileUploadQueue(recordId); // DMOB-6
    onStatusChange('complete');
    sentryUploadSuccess(recordId, audioFileId);
    return {
      success: true,
      audioFileId,
      canDelete: true,
      verified: verification.verified,
      fallback: verification.fallback
    };
  } catch (error) {
    console.error('Upload failed:', error);
    onStatusChange('error');
    sentryUploadFail(recordId, error);
    return {
      success: false,
      audioFileId,
      canDelete: false,
      error: error.message
    };
  } finally {
    _endMobileUpload(recordId);
  }
};

/**
 * Mobile-specific file upload using TUS protocol for resumable uploads
 * Supports large files (4-5+ hours of recording) with:
 * - Chunked uploads (5MB chunks)
 * - Resume capability if interrupted
 * - No full file memory loading
 *
 * @param {string} filePath - File path
 * @param {string} apiUrl - API URL
 * @param {string} authToken - Auth token
 * @param {Object} metadata - Metadata
 * @param {Function} onProgress - Progress callback
 * @param {string|null} recordId - Record ID for tracking cancellation
 * @returns {Promise<{success: boolean, audioFileId?: string, error?: string}>}
 */
const uploadFileMobile = async (filePath, apiUrl, authToken, metadata, onProgress, recordId = null) => {
  try {
    // Import TUS client dynamically
    const { Upload } = await import('tus-js-client');

    // Read file for upload - for very large files, consider streaming
    // Note: Capacitor Filesystem reads as base64, which we convert to ArrayBuffer
    const fileResult = await readFile(filePath);
    if (!fileResult.success) {
      throw new Error(fileResult.error || 'Failed to read file for upload');
    }

    const fileBlob = new Blob([fileResult.data], { type: 'audio/webm' });
    const fileSize = fileBlob.size;

    // Calculate appropriate chunk size based on file size
    // Smaller chunks for large files to handle memory better
    const getChunkSize = (size) => {
      if (size > 500 * 1024 * 1024) return 2 * 1024 * 1024;  // >500MB: 2MB chunks
      if (size > 100 * 1024 * 1024) return 5 * 1024 * 1024;  // >100MB: 5MB chunks
      return 10 * 1024 * 1024; // Default: 10MB chunks
    };

    return new Promise((resolve, reject) => {
      // Timeout: if no progress fires within 60 seconds, abort and fall back
      let progressTimeout = setTimeout(() => {
        console.warn('TUS upload: no progress within 60s, aborting');
        try { upload.abort(); } catch (e) { /* ignore */ }
        if (fileSize < 50 * 1024 * 1024) {
          uploadFileMobileSimple(filePath, apiUrl, authToken, metadata, onProgress, null, recordId)
            .then(resolve)
            .catch(reject);
        } else {
          reject(new Error('Upload stuck: no progress within 60 seconds'));
        }
      }, 60000);

      const resetProgressTimeout = () => {
        clearTimeout(progressTimeout);
        progressTimeout = setTimeout(() => {
          console.warn('TUS upload: no progress within 60s, aborting');
          try { upload.abort(); } catch (e) { /* ignore */ }
          if (fileSize < 50 * 1024 * 1024) {
            uploadFileMobileSimple(filePath, apiUrl, authToken, metadata, onProgress, null, recordId)
              .then(resolve)
              .catch(reject);
          } else {
            reject(new Error('Upload stuck: no progress within 60 seconds'));
          }
        }, 60000);
      };

      const upload = new Upload(fileBlob, {
        endpoint: `${apiUrl}/api/desktop/upload/tus`,
        retryDelays: [0, 1000, 3000, 5000, 10000, 30000], // Retry delays in ms
        chunkSize: getChunkSize(fileSize),
        metadata: {
          filename: 'recording.webm',
          filetype: 'audio/webm',
          ...metadata,
          recordMetadata: JSON.stringify(metadata)
        },
        headers: {
          'Authorization': `Bearer ${authToken}`
        },
        onError: (error) => {
          clearTimeout(progressTimeout);
          console.error('TUS upload error:', error);
          // Check if we can fall back to simple upload for smaller files
          if (fileSize < 50 * 1024 * 1024) {
            console.log('Falling back to simple upload for small file');
            uploadFileMobileSimple(filePath, apiUrl, authToken, metadata, onProgress, null, recordId)
              .then(resolve)
              .catch(reject);
          } else {
            reject(new Error(error.message || 'Upload failed'));
          }
        },
        onProgress: (bytesUploaded, bytesTotal) => {
          resetProgressTimeout();
          const percentage = Math.round((bytesUploaded / bytesTotal) * 100);
          onProgress(percentage, bytesUploaded, bytesTotal);
        },
        onSuccess: () => {
          clearTimeout(progressTimeout);
          // Extract audioFileId from the upload URL
          const uploadUrl = upload.url;
          const audioFileId = uploadUrl ? uploadUrl.split('/').pop() : null;
          resolve({
            success: true,
            audioFileId
          });
        }
      });

      // Check if there's a previous upload to resume
      upload.findPreviousUploads().then((previousUploads) => {
        if (previousUploads.length > 0) {
          console.log('Resuming previous upload');
          upload.resumeFromPreviousUpload(previousUploads[0]);
        }
        upload.start();
      }).catch(() => {
        // If fingerprinting fails, just start fresh
        upload.start();
      });
    });
  } catch (error) {
    console.error('TUS upload initialization failed:', error);
    // Fall back to simple upload if TUS fails to initialize
    return uploadFileMobileSimple(filePath, apiUrl, authToken, metadata, onProgress, null, recordId);
  }
};

/**
 * Simple mobile upload fallback (non-resumable)
 * Used as fallback when TUS is not available or for small files
 * Handles both filePath (Capacitor) and File object (file picker)
 *
 * @param {string|null} filePath - File path for Capacitor filesystem
 * @param {string} apiUrl - API base URL
 * @param {string} authToken - Auth token
 * @param {Object} metadata - Upload metadata
 * @param {Function} onProgress - Progress callback
 * @param {File|null} fileObj - Direct File object (optional)
 * @param {string|null} recordId - Record ID for tracking cancellation
 * @returns {Promise<{success: boolean, audioFileId?: string, error?: string, status?: number}>}
 */
const uploadFileMobileSimple = async (filePath, apiUrl, authToken, metadata, onProgress, fileObj = null, recordId = null) => {
  try {
    let fileBlob;

    if (fileObj) {
      // Use the File object directly (from file picker)
      fileBlob = fileObj;
    } else if (filePath) {
      // Read the file as a DISK-BACKED Blob (fetch over the capacitor file URI).
      //
      // Do NOT use storage.readFile() here. On Capacitor that returns the whole
      // file as a base64 string which is then decoded to an ArrayBuffer and
      // copied into a Blob — ~3-4x the file size resident in the JS heap at
      // once. On large recordings that OOM-kills the Android System WebView
      // renderer with no JS exception (the "crashes every upload" incident:
      // Android dies as low as ~48 MB while iOS survives ~250 MB on the same
      // path). readBlobFromCapacitorPath yields a disk-backed Blob whose bytes
      // the WebView streams from disk into the multipart body, keeping the heap
      // flat. It is the SAME reader the SAS path already calls successfully for
      // this exact file moments earlier (the `readBlob OK size=` breadcrumb),
      // so it cannot regress devices on which the legacy path works today.
      //
      // Note: the resulting Blob's content-type is whatever the capacitor file
      // server reports (e.g. "video/webm"), not the previous hard-coded
      // "audio/webm". This is safe: /api/desktop/upload derives the stored
      // extension from the filename (getSafeFileExtension), enforces no
      // content-type allowlist, and ffprobes the bytes regardless of MIME.
      fileBlob = await readBlobFromCapacitorPath(filePath);
    } else {
      throw new Error('No file provided for upload');
    }

    const formData = new FormData();
    // Use original filename from metadata if available, or derive from path
    const fileName = metadata?.filename || fileObj?.name || (filePath ? filePath.split('/').pop() : 'recording.webm');
    formData.append('audio', fileBlob, fileName);
    // Merge recordId into metadata so the backend's idempotency check
    // (POST /api/desktop/upload route.ts:108 → findFirst({botSessionId:
    // `desktop:${recordId}`})) actually fires. Without this, every retry
    // of the same logical recording creates a NEW Meeting + a NEW
    // audioFileId — server-side duplicates that burn the user's minute
    // quota and create orphans in the Meeting table. The contract's
    // UploadMetadata.recordId field already specifies this; we just
    // weren't populating it.
    const metadataWithId = recordId ? { ...metadata, recordId } : metadata;
    formData.append('metadata', JSON.stringify(metadataWithId));

    // Calculate timeout based on file size (1 minute per 10MB, minimum 10 minutes)
    const fileSizeMB = fileBlob.size / (1024 * 1024);
    const timeoutMinutes = Math.max(10, Math.ceil(fileSizeMB / 10));
    const timeoutMs = timeoutMinutes * 60 * 1000;

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      // Store XHR reference for cancellation
      if (recordId) {
        activeXhrUploads.set(recordId, xhr);
      }

      const cleanup = () => {
        if (recordId) {
          activeXhrUploads.delete(recordId);
        }
      };

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          const progress = Math.round((event.loaded / event.total) * 100);
          onProgress(progress, event.loaded, event.total);
        }
      });

      xhr.addEventListener('load', () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            const fileId = response.audioFileId || response.id;
            if (!fileId) {
              // 2xx response but no audioFileId in the body — the bytes may
              // have landed but we have no handle to verify or link the
              // transcription. Treat as a retryable failure so the user
              // doesn't end up with a recording orphaned on the server.
              resolve({
                success: false,
                error: 'Server returned success but no audioFileId',
                canRetry: true,
              });
            } else {
              resolve({ success: true, audioFileId: fileId });
            }
          } catch (e) {
            // 2xx but unparseable body — same reasoning as the no-id case.
            resolve({
              success: false,
              error: 'Server returned malformed response body',
              canRetry: true,
            });
          }
        } else if (xhr.status === 401) {
          // Token expired - signal for retry with refresh
          let errorMsg = 'Token expired';
          try {
            const errData = JSON.parse(xhr.responseText);
            errorMsg = errData.error || errData.message || 'Token expired';
          } catch (e) { /* ignore parse errors */ }
          resolve({ success: false, error: errorMsg, status: 401 });
        } else if (xhr.status === 413) {
          // DUREC-5: the recording exceeds the backend's 500MB cap (verified on
          // the deployed /api/desktop/upload route). Retrying can never succeed,
          // so mark it terminal (canRetry:false) and surface the server's clear
          // "File too large. Maximum size is 500MB" message instead of looping.
          let errorMsg = 'File too large. Maximum size is 500MB.';
          try {
            const errData = JSON.parse(xhr.responseText);
            errorMsg = errData.error || errData.message || errorMsg;
          } catch (e) { /* ignore parse errors */ }
          resolve({ success: false, error: errorMsg, status: 413, canRetry: false });
        } else {
          let errorMsg = `Upload failed with status ${xhr.status}`;
          try {
            const errData = JSON.parse(xhr.responseText);
            errorMsg = errData.error || errData.message || errorMsg;
          } catch (e) { /* ignore parse errors */ }
          reject(new Error(errorMsg));
        }
      });

      xhr.addEventListener('error', () => {
        cleanup();
        reject(new Error('Network error during upload'));
      });

      xhr.addEventListener('timeout', () => {
        cleanup();
        reject(new Error('Upload timeout - file may be too large. Try with a better connection.'));
      });

      xhr.addEventListener('abort', () => {
        cleanup();
        resolve({ success: false, error: 'Upload cancelled', cancelled: true });
      });

      xhr.open('POST', `${apiUrl}/api/desktop/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
      xhr.timeout = timeoutMs;
      // Telemetry: confirms the legacy POST is sending a disk-backed Blob.
      // If the renderer is OOM-killed mid-upload there is no JS exception, so a
      // missing "legacy POST returned" after this breadcrumb pinpoints send().
      captureMessage(`upload: legacy POST sending blob size=${fileBlob.size} type=${fileBlob.type || '-'}`, 'info');
      xhr.send(formData);
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Upload with automatic retry and exponential backoff
 * @param {Object} options - Same options as uploadWithVerification
 * @returns {Promise<{success: boolean, audioFileId?: string, canDelete: boolean, error?: string}>}
 */
export const uploadWithRetry = async (options) => {
  const maxRetries = PlatformConstants.MAX_UPLOAD_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await uploadWithVerification(options);

    if (result.success) {
      return result;
    }

    if (result.inProgress) {
      return result;
    }

    // Check if error is retryable
    const retryable = isRetryableError(result.error);
    if (!retryable || attempt >= maxRetries) {
      return result;
    }

    const delay = getBackoffDelay(attempt);
    console.log(`Upload attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
    await sleep(delay);
  }

  return {
    success: false,
    canDelete: false,
    error: 'Max retries exceeded'
  };
};

/**
 * Check if an error is retryable
 * @param {string} error - Error message
 * @returns {boolean}
 */
const isRetryableError = (error) => {
  if (!error) return false;

  // DUREC-5: keep this terminal-error list aligned with _isRetryableError (used
  // by the background queue) so the immediate uploadWithRetry doesn't burn
  // retries on a 413 "File too large"/duration/minutes rejection that will fail
  // identically every time.
  const nonRetryable = [
    'Checksum mismatch',
    'Invalid file format',
    'Unauthorized',
    'Forbidden',
    'File too large',
    'too large',
    'Insufficient minutes',
    'Recording too long',
    'DURATION_EXCEEDED',
    'FILE_TOO_LARGE',
    'INSUFFICIENT_MINUTES',
  ];

  return !nonRetryable.some(msg => error.includes(msg));
};

/**
 * Safe file deletion after successful upload
 * Only deletes if file is not locked and upload was verified
 * @param {string} filePath - File path
 * @param {string} recordId - Recording ID
 * @param {Object} recordingStore - Recording store instance for lock checking
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const safeDeleteAfterUpload = async (filePath, recordId, recordingStore) => {
  // Check if file is locked
  if (recordingStore && !recordingStore.canDelete(recordId)) {
    console.warn('Cannot delete file - still locked for upload');
    return { success: false, error: 'File is locked' };
  }

  try {
    if (isElectron()) {
      return await window.electronAPI.file.delete(filePath);
    } else if (isCapacitor()) {
      return await deleteFile(filePath);
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error deleting file:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Add upload to queue for background processing
 * @param {Object} uploadOptions - Upload options
 */
export const queueUpload = (uploadOptions) => {
  // P1 Fix: Prevent duplicate uploads for the same recording
  if (uploadQueue.some(item => item.id === uploadOptions.recordId)) {
    console.warn('Upload already queued for', uploadOptions.recordId);
    return;
  }

  uploadQueue.push({
    ...uploadOptions,
    id: uploadOptions.recordId,
    addedAt: Date.now(),
    attempts: 0,
    status: 'pending'
  });

  // Start processing queue if not already running
  if (!isProcessingQueue) {
    processUploadQueue();
  }
};

/**
 * Process upload queue in background
 */
const processUploadQueue = async () => {
  if (isProcessingQueue || uploadQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (uploadQueue.length > 0) {
    const upload = uploadQueue.find(u => u.status === 'pending');
    if (!upload) break;

    upload.status = 'uploading';
    upload.attempts++;

    const result = await uploadWithVerification(upload);

    if (result.inProgress) {
      upload.status = 'pending';
      upload.attempts = Math.max(0, upload.attempts - 1);
      break;
    }

    if (result.success) {
      upload.status = 'complete';
      upload.audioFileId = result.audioFileId;
      // Remove from queue
      const index = uploadQueue.indexOf(upload);
      if (index > -1) {
        uploadQueue.splice(index, 1);
      }
    } else {
      if (upload.attempts >= PlatformConstants.MAX_UPLOAD_RETRIES) {
        upload.status = 'failed';
        upload.error = result.error;
      } else {
        upload.status = 'pending';
        // Wait before retrying
        await sleep(getBackoffDelay(upload.attempts - 1));
      }
    }
  }

  isProcessingQueue = false;
};

/**
 * Get upload queue status
 * @returns {Array} Queue items with status
 */
export const getUploadQueueStatus = () => {
  return uploadQueue.map(item => ({
    id: item.id,
    status: item.status,
    attempts: item.attempts,
    addedAt: item.addedAt,
    error: item.error
  }));
};

/**
 * Clear completed or failed uploads from queue
 */
export const clearCompletedUploads = () => {
  const remaining = uploadQueue.filter(u => u.status === 'pending' || u.status === 'uploading');
  uploadQueue.length = 0;
  uploadQueue.push(...remaining);
};
