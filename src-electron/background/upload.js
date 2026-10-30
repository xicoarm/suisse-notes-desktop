'use strict';

/**
 * Upload of one recording in main (direct-to-blob with legacy fallback),
 * verification of the accepted upload, status polls and the token refresh
 * they need. Moved out of electron-main.js in review round 9 (council 3).
 *
 * Every function takes the SessionScope of the work that started it (queue
 * run, upload:start, poll) and reaches requests, receipts, history, queue,
 * renderer events, timers and the duration probe only through it. The scope
 * checks the session right before each effect; after a session change the
 * work ends with `sessionEnded` (canRetry: true) and changes neither the
 * queue nor a receipt nor the history.
 *
 * Factory keys (static rule, mainBackgroundStatic.test.js): `config`
 * (constants), `read` (read-only helpers of main), `pure`, `report`
 * (telemetry), `log`.
 */

const path = require('path');
const { isSessionEnded, sessionEndedResult } = require('./ended');
const { uploadViaPresignedSas, FATAL_HTTP_STATUSES } = require('./upload-direct');
const queueOps = require('./queue-ops');

// Status semantics - keep in lockstep with the renderer copy in
// src/services/upload.js and the server contract in
// src/lib/api/desktop-contract.ts (RecordingStatus). The moment the server
// returns any persisted state, the audioFileId resolves to a Meeting row.
// This does not verify blob contents or authorize local deletion. We do not
// need to wait for downstream transcription. Legacy lowercase values are kept for any
// older endpoint that still echoes them.
const PERSISTED_STATES = new Set([
  'persisted', 'complete', 'processing',         // legacy
  'PROCESSING', 'COMPLETED',                     // stored by the verified backend contract
]);
const FAILED_STATES = new Set([
  'failed',                                       // legacy
  'FAILED', 'CANCELLED',                          // contract
]);

const MIME_TYPES = {
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
  '.amr': 'audio/amr',
  '.3gp': 'video/3gpp'
};

/**
 * Runs `work` and turns the end of the session into `ended()`: a
 * SESSION_ENDED error, any error after the change, and a result that
 * arrives after the change.
 */
async function guard(scope, ended, work) {
  try {
    const result = await work();
    return scope.alive() ? result : ended();
  } catch (error) {
    if (isSessionEnded(error) || !scope.alive()) return ended();
    throw error;
  }
}

function createUploads({ config, read, pure, report, log }) {
  const { apiBaseUrl } = config;

  // An upload result of a session that ended writes nothing - no receipt, no
  // history - and sends no request. The server deduplicates the recording
  // when its owner uploads it again.
  const sessionEndedVerification = (accepted) => ({ ...accepted, ...sessionEndedResult(), pendingVerification: true });

  function saveUploadOutcome(scope, recordId, result) {
    scope.update.history((recordings) => queueOps.uploadOutcome(recordings, recordId, result));
  }

  /**
   * Refresh the token of this scope's session (a 401 during a long upload).
   * E3: applied only in the same session and for the same user.
   */
  async function refreshMainAuthToken(scope) {
    const changed = { success: false, ignored: true, sessionEnded: true, error: 'Session changed' };
    try {
      const authToken = scope.token();
      if (!authToken) return { success: false, error: 'Not authenticated' };
      const userId = pure.sessionTokenUserId(authToken);
      const response = await scope.http.post(`${apiBaseUrl}/api/auth/refresh`, {}, { auth: true, timeout: 15000 });
      if (response.data?.token) {
        const applied = scope.applyRefresh(userId, { token: response.data.token, user: response.data.user });
        if (!applied.applied) {
          log.info(`Token refresh result dropped (${applied.reason})`);
          return { success: false, ignored: true, error: 'Session changed' };
        }
        log.info('Token refreshed successfully (main process)');
        return { success: true, token: response.data.token, user: read.getUser(), epoch: applied.epoch };
      }
      return { success: false, error: 'No token in refresh response' };
    } catch (error) {
      if (isSessionEnded(error) || !scope.alive()) return changed;
      log.warn('Token refresh failed:', error.response?.status, error.message);
      return {
        success: false,
        // status lets the renderer distinguish a definitive auth rejection
        // (401/403 → re-login required) from a transient network failure
        // (no status → keep the session, retry later).
        status: error.response?.status,
        error: error.response?.data?.error || error.message || 'Token refresh failed'
      };
    }
  }

  /**
   * Poll the server to verify the upload was persisted (P0 data loss fix).
   * @returns {Promise<{persisted: boolean, verified: boolean, error?: string, sessionEnded?: boolean}>}
   */
  function pollServerStatus(scope, audioFileId, maxAttempts, ownerId) {
    const pollInterval = 2000;
    const ended = () => ({ persisted: false, verified: false, sessionEnded: true, error: 'Signed out' });
    return guard(scope, ended, async () => {
      // Parity with the renderer poller: a token that expired during a long
      // transfer gets ONE refresh before we give up on real verification.
      let authRefreshAttempted = false;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          if (ownerId && !pure.canUploadForUser(ownerId, pure.tokenUserId(scope.token()))) {
            return { persisted: false, verified: false, authError: true, error: 'Sign in to the recording account to verify this upload' };
          }
          const response = await scope.http.get(`${apiBaseUrl}/api/desktop/upload/${audioFileId}/status`, {
            auth: true,
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
          });
          if (response.data) {
            const status = response.data.status;
            if (PERSISTED_STATES.has(status)) {
              log.info(`Upload verification successful for ${audioFileId}: status=${status}`);
              return { persisted: true, verified: true };
            }
            if (FAILED_STATES.has(status)) {
              const errMsg = response.data.errorMessage || response.data.error || `Server reported status=${status}`;
              log.error(`Server reported upload failed for ${audioFileId}:`, errMsg);
              return { persisted: false, verified: false, error: errMsg };
            }
            // RECORDING means the server is still ingesting — keep polling.
            if (status === 'RECORDING' || status === 'recording') {
              log.info(`Upload status for ${audioFileId}: ${status}, waiting...`);
            } else {
              // Unknown status cannot confirm storage. Retain local audio and the receipt.
              log.warn(`Upload status for ${audioFileId}: unrecognized status "${status}" — retaining local audio until confirmation`);
              report.captureMessage(`Upload status unknown enum: ${status}`, {
                level: 'warning',
                tags: { operation: 'upload_verification' },
                extra: { audioFileId, status },
              });
              return { persisted: false, verified: false, error: 'Unrecognized server recording status: ' + status };
            }
          }
          await scope.sleep(pollInterval);
        } catch (error) {
          // An answer (also a 401) that arrives after a session change
          // decides nothing and refreshes nothing.
          if (isSessionEnded(error) || !scope.alive()) return ended();
          // A 404 may mean this recording is absent, even when the route exists.
          if (error.response && error.response.status === 404) {
            log.warn('Server has not confirmed the recording (404); retaining local audio');
            return { persisted: false, verified: false, error: 'Server has not confirmed this recording (404)' };
          }
          // 401 on the status endpoint after the authenticated POST already
          // landed the bytes — the token likely expired DURING the long transfer.
          // Try one refresh, then retain the local audio with verification pending.
          if (error.response && error.response.status === 401) {
            if (!authRefreshAttempted) {
              authRefreshAttempted = true;
              const refresh = await refreshMainAuthToken(scope);
              if (refresh.sessionEnded) return ended();
              if (refresh.success && refresh.token) {
                log.info('Upload status 401 — token refreshed, retrying verification');
                attempt--; // rewind: this attempt didn't count
                continue;
              }
            }
            log.warn('Upload status unauthorized; retaining local audio');
            return { persisted: false, verified: false, authError: true, error: 'Sign in to confirm the uploaded recording' };
          }
          log.warn(`Status poll attempt ${attempt + 1} failed:`, error.message);
          if (attempt < maxAttempts - 1) await scope.sleep(pollInterval);
        }
      }
      // Timeout - server didn't confirm in time
      log.error(`Upload verification timeout for ${audioFileId} after ${maxAttempts} attempts`);
      report.captureMessage(`Upload verification timeout: ${audioFileId}`, {
        level: 'error',
        tags: { operation: 'upload_verification' },
        extra: { audioFileId, maxAttempts },
      });
      return { persisted: false, verified: false, error: 'Server confirmation timeout' };
    });
  }

  /**
   * Poll meeting transcription status after gateway failure (the renderer
   * asks, the poll runs on). Every 30 s for up to 15 minutes.
   */
  function pollMeetingTranscriptionStatus(scope, meetingId, maxAttempts = 30) {
    const pollInterval = 30000;
    const expired = () => ({ status: 'AUTH_EXPIRED', resolved: false });
    return guard(scope, expired, async () => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          if (!scope.token()) {
            log.warn(`[MeetingPoll] No auth token available for meeting ${meetingId}`);
            return expired();
          }
          const response = await scope.http.get(`${apiBaseUrl}/api/desktop/meeting/${meetingId}/status`, {
            auth: true,
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
          });
          if (response.data) {
            const status = response.data.status;
            if (status === 'COMPLETED') {
              log.info(`[MeetingPoll] Meeting ${meetingId} transcription completed`);
              return { status: 'COMPLETED', resolved: true };
            }
            if (status === 'FAILED') {
              log.warn(`[MeetingPoll] Meeting ${meetingId} transcription failed`);
              return { status: 'FAILED', resolved: true };
            }
            // Still PROCESSING — continue polling
            log.info(`[MeetingPoll] Meeting ${meetingId} still ${status} (attempt ${attempt + 1}/${maxAttempts})`);
          }
          if (attempt < maxAttempts - 1) await scope.sleep(pollInterval);
        } catch (error) {
          if (isSessionEnded(error) || !scope.alive()) return expired();
          if (error.response && error.response.status === 404) {
            log.warn(`[MeetingPoll] Status endpoint not available for meeting ${meetingId}`);
            return { status: 'UNKNOWN', resolved: false };
          }
          log.warn(`[MeetingPoll] Poll attempt ${attempt + 1} failed:`, error.message);
          if (attempt < maxAttempts - 1) await scope.sleep(pollInterval);
        }
      }
      log.warn(`[MeetingPoll] Timeout for meeting ${meetingId} after ${maxAttempts} attempts`);
      return { status: 'TIMEOUT', resolved: false };
    });
  }

  function verifyAcceptedUpload(scope, recordId, filePath, accepted, ownerId, remember, sourceSnapshot) {
    return guard(scope, () => sessionEndedVerification(accepted), async () => {
      const stats = scope.fs.statSync(filePath);
      const receiptPath = path.join(read.getRecordingPath(recordId), 'upload-receipt.json');
      const receipt = { ...accepted, verified: false, contentVerified: false, canDelete: false, ownerId, filePath, fileSize: sourceSnapshot?.size ?? stats.size, fileMtimeMs: sourceSnapshot?.mtimeMs ?? stats.mtimeMs };
      if (remember) {
        scope.fs.mkdirSync(read.getRecordingPath(recordId), { recursive: true });
        await scope.fs.writeFileAtomic(receiptPath, JSON.stringify(receipt));
      }
      if (stats.size !== receipt.fileSize || stats.mtimeMs !== receipt.fileMtimeMs) {
        const result = { ...accepted, success: false, verified: false, contentVerified: false, canDelete: false, canRetry: false, pendingVerification: true, error: 'Local audio changed during upload. Both copies are retained for review.' };
        saveUploadOutcome(scope, recordId, result);
        return result;
      }
      const verification = accepted.audioFileId
        ? await pollServerStatus(scope, accepted.audioFileId, 15, ownerId)
        : { persisted: false, verified: false, error: 'Server returned no recording identifier' };
      // Signed out while verifying - the receipt stays as it is (verified
      // later, in the owner's session).
      if (verification.sessionEnded) return sessionEndedVerification(accepted);
      const result = pure.verifiedUploadResult(accepted, verification);
      await scope.fs.writeFileAtomic(receiptPath, JSON.stringify({ ...receipt, verified: result.verified, contentVerified: result.contentVerified, canDelete: result.canDelete }));
      saveUploadOutcome(scope, recordId, result);
      return result;
    });
  }

  /**
   * Upload with retry. Direct-to-blob first (POST /api/uploads/init, blocks
   * to the SAS URL, block list, POST /api/uploads/complete); the legacy
   * formData POST when the server asks for it (local-storage mode), when init
   * answers 404 (older backend) or when init needs the duration the client
   * could not probe.
   */
  function uploadWithRetry(scope, recordId, filePath, metadata, maxRetries) {
    return guard(scope, sessionEndedResult, async () => {
      const state = read.recordingState(recordId);
      if (state.unsaved) return { success: false, canDelete: false, canRetry: true, error: 'Finish saving the recording before uploading it' };
      if (state.locked || state.live) return { success: false, canDelete: false, canRetry: true, error: 'The recording is still being saved' };
      const eligibility = await read.assessRecordingUpload({ recordId, filePath, recordingsRoot: read.getRecordingsPath() });
      scope.assertAlive();
      if (!eligibility.allowed) return { success: false, canDelete: false, canRetry: true, requiresFinalization: true, error: eligibility.error };
      const ownerId = read.recordingOwner(recordId);
      if (!pure.canUploadForUser(ownerId, pure.tokenUserId(scope.token()))) {
        return { success: false, status: 401, canDelete: false, canRetry: true, error: 'Sign in to the account that owns this recording' };
      }
      const receipt = read.readUploadReceipt(recordId);
      if (receipt?.audioFileId) {
        const stats = scope.fs.statSync(filePath);
        if (receipt.ownerId !== ownerId || receipt.fileSize !== stats.size || receipt.fileMtimeMs !== stats.mtimeMs) {
          return { success: false, canDelete: false, canRetry: false, error: 'The local audio changed after upload. Both copies are retained; review the recording before uploading again.' };
        }
        return verifyAcceptedUpload(scope, recordId, filePath, receipt, ownerId, false, null);
      }
      const sourceSnapshot = scope.fs.statSync(filePath);
      const abortController = new AbortController();
      const handle = scope.registerCancel(recordId, abortController);
      try {
        const directResult = await tryDirectUpload(scope, { recordId, filePath, metadata, abortController, maxRetries, ownerId, handle });
        if (directResult.handled) {
          // Direct flow either succeeded or failed terminally — do not run legacy.
          if (directResult.result.success) return verifyAcceptedUpload(scope, recordId, filePath, directResult.result, ownerId, true, sourceSnapshot);
          return directResult.result;
        }
        log.info(`[upload] Direct flow not available for ${recordId} (${directResult.reason}); falling back to legacy POST`);
        return await uploadWithRetryLegacy(scope, recordId, filePath, metadata, maxRetries, abortController, ownerId, sourceSnapshot);
      } finally {
        handle.release();
      }
    });
  }

  /**
   * Try the direct-to-blob upload. Returns:
   *   { handled: true, result } — finished (success or terminal failure)
   *   { handled: false, reason } — caller should run the legacy fallback
   * A session change throws SESSION_ENDED (uploadWithRetry ends the work).
   */
  async function tryDirectUpload(scope, { recordId, filePath, metadata, abortController, maxRetries, ownerId, handle }) {
    if (!scope.token()) {
      // status 401 so the renderer's token-refresh/re-login recovery path
      // treats this exactly like a server-side auth rejection.
      return { handled: true, result: { success: false, error: 'Not authenticated. Please login first.', status: 401, canRetry: false } };
    }
    // Notify renderer that upload started so the UI shows progress immediately
    scope.notify('upload:started', { recordId });
    const onProgress = ({ progress, bytesUploaded, bytesTotal }) => {
      scope.notify('upload:progress', { recordId, progress, bytesUploaded, bytesTotal });
    };

    let lastTransientError;
    // Outer retry handles transient init/complete failures. Per-block retry
    // is handled inside upload-direct.js — we don't double-retry blocks.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(15_000, 2000 * Math.pow(2, attempt - 1));
        log.info(`[upload] Direct retry attempt ${attempt}/${maxRetries} after ${delay}ms`);
        scope.notify('upload:retry', { recordId, attempt, maxRetries });
        await scope.sleep(delay);
      }
      if (abortController.signal.aborted) {
        return { handled: true, result: { success: false, error: 'Upload cancelled', cancelled: true, canRetry: false } };
      }

      let result;
      try {
        if (!pure.canUploadForUser(ownerId, pure.tokenUserId(scope.token()))) return { handled: true, result: { success: false, status: 401, canRetry: true, error: 'Sign in as the recording owner to upload it' } };
        result = await uploadViaPresignedSas(scope, {
          apiBaseUrl,
          recordId,
          filePath,
          metadata,
          abortController,
          onProgress,
          // Track for upload:cancel cleanup. Cleared when this upload returns.
          onSession: ({ audioFileId }) => { if (audioFileId) handle.stagedBlob(audioFileId); },
          log,
        });
      } catch (err) {
        // A failure of an ended session is no retry (no further request).
        if (isSessionEnded(err) || !scope.alive()) throw err;
        // Defense-in-depth (ELECTRON-27 class): a thrown error carrying a FATAL
        // HTTP status must terminate — it will fail identically on every retry,
        // every 5-minute queue pass, and every app launch.
        const fatalStatus = err?.response?.status && FATAL_HTTP_STATUSES.has(err.response.status);
        if (fatalStatus) {
          report.captureUploadFailureOnce(recordId, err, 'upload-direct', { attempt: attempt + 1, maxRetries, classified: 'fatal-thrown' });
          return { handled: true, result: { success: false, status: err.response.status, error: err.response.data?.error || err.message, canRetry: false } };
        }
        // Bubbled-up transient error from upload-direct → retry.
        lastTransientError = err;
        log.warn(`[upload] Direct upload transient error attempt ${attempt + 1}: ${err.message}`);
        if (attempt >= maxRetries) {
          report.captureUploadFailureOnce(recordId, err, 'upload-direct', { attempt: attempt + 1, maxRetries });
          return { handled: true, result: { success: false, error: err.message || 'Upload failed after all retry attempts', canRetry: true } };
        }
        continue;
      }

      if (result.mode === 'fallback') return { handled: false, reason: 'server requested local-storage fallback' };
      if (result.success) return { handled: true, result };
      if (result.cancelled) return { handled: true, result };

      // Direct flow returned a terminal failure — do not retry, do not fall back…
      // …unless the backend simply doesn't speak the SAS protocol or rejects
      // our (sometimes-zero) client-probed duration: the legacy multipart POST
      // can still succeed (the server probes duration itself).
      if (result.canRetry === false) {
        if (result.status === 404) {
          log.info(`[upload] /api/uploads/init returned 404 for ${recordId} — backend lacks SAS routes; falling back to legacy POST`);
          return { handled: false, reason: 'init returned 404 (legacy backend)' };
        }
        if (result.status === 400 && /durationSeconds.*required/i.test(result.error || '')) {
          log.warn(`[upload] /api/uploads/init rejected ${recordId} for missing durationSeconds (likely ffprobe spawn failure on client); falling back to legacy POST so the server can probe`);
          return { handled: false, reason: 'init rejected missing durationSeconds' };
        }
        report.captureMessage(`Upload terminal failure: ${result.error}`, {
          level: 'warning',
          tags: { operation: 'upload-direct', recordId, status: String(result.status || 0) },
        });
        return { handled: true, result };
      }

      // Retryable failure — go around the loop.
      log.warn(`[upload] Direct upload retryable failure attempt ${attempt + 1}: ${result.error}`);
    }

    // Exhausted retries on a retryable error
    return { handled: true, result: { success: false, error: lastTransientError?.message || 'Upload failed after all retry attempts', canRetry: true } };
  }

  // Legacy formData POST upload path — only when the backend reports
  // local-storage mode or lacks the SAS routes.
  async function uploadWithRetryLegacy(scope, recordId, filePath, metadata, maxRetries, abortController, ownerId, sourceSnapshot) {
    const retryDelays = [0, 2000, 5000, 10000]; // Exponential backoff

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let stopProgressUpdates = () => {};
      try {
        // Wait before retry (except first attempt)
        if (attempt > 0) {
          const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
          log.info(`Upload retry attempt ${attempt}/${maxRetries} after ${delay}ms`);
          scope.notify('upload:retry', { recordId, attempt, maxRetries });
          await scope.sleep(delay);
        }

        const authToken = scope.token();
        if (authToken && !pure.canUploadForUser(ownerId, pure.tokenUserId(authToken))) {
          return { success: false, status: 401, canDelete: false, canRetry: true, error: 'The recording belongs to a different account' };
        }
        if (!authToken) {
          // status 401: route this through the renderer's auth-recovery path
          // (refresh + retry / persistent queue) instead of a generic failure.
          return { success: false, error: 'Not authenticated. Please login first.', status: 401, canRetry: false };
        }

        const fileStats = await scope.fs.stat(filePath);
        const formData = new pure.FormData();
        const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        // Use stream instead of buffer for efficient memory usage
        formData.append('audio', scope.fs.createReadStream(filePath), {
          filename: path.basename(filePath),
          contentType,
          knownLength: fileStats.size
        });
        formData.append('metadata', JSON.stringify({
          recordId,
          duration: metadata?.duration || 0,
          timestamp: new Date().toISOString(),
          ...metadata
        }));

        // Time-based progress estimation for more realistic UX:
        // assume ~1.5 MB/s upload + 10 sec server processing.
        const uploadStartTime = Date.now();
        const fileSizeBytes = fileStats.size;
        const estimatedUploadMs = (fileSizeBytes / (1.5 * 1024 * 1024)) * 1000 + 10000;
        let lastProgress = 0;
        stopProgressUpdates = scope.interval(500, () => {
          const elapsed = Date.now() - uploadStartTime;
          // Calculate progress based on time, cap at 95% until complete
          const timeProgress = Math.min(95, Math.round((elapsed / estimatedUploadMs) * 100));
          if (timeProgress !== lastProgress) {
            lastProgress = timeProgress;
            scope.notify('upload:progress', {
              recordId,
              progress: timeProgress,
              bytesUploaded: Math.round((timeProgress / 100) * fileSizeBytes),
              bytesTotal: fileSizeBytes,
              attempt: attempt + 1,
              maxRetries: maxRetries + 1
            });
          }
        });

        const uploadUrl = `${apiBaseUrl}/api/desktop/upload`;
        const uploadTimeout = pure.calculateUploadTimeout(fileStats.size);
        log.info('Uploading to:', uploadUrl);
        log.info('Upload config:', {
          fileSize: fileStats.size,
          fileSizeMB: (fileStats.size / (1024 * 1024)).toFixed(2),
          timeout: uploadTimeout,
          timeoutMinutes: (uploadTimeout / 60000).toFixed(1),
          hasAuthToken: true
        });
        const response = await scope.http.post(uploadUrl, formData, {
          auth: true,
          headers: {
            ...formData.getHeaders(),
            'X-Desktop-App-Version': config.appVersion
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: uploadTimeout,  // Dynamic timeout based on file size
          signal: abortController.signal
        });
        stopProgressUpdates();
        log.info('Upload response received:', response.status);

        if (response.data && response.data.success) {
          return await verifyAcceptedUpload(scope, recordId, filePath, response.data, ownerId, true, sourceSnapshot);
        }
        throw new Error(response.data?.error || 'Upload failed');
      } catch (error) {
        stopProgressUpdates();
        // Aborted by the session change, or failed after it - no retry.
        if (isSessionEnded(error) || !scope.alive()) throw error;

        // If the upload was cancelled via AbortController, exit immediately
        if (abortController.signal.aborted) {
          log.info(`Upload cancelled for ${recordId}`);
          return { success: false, error: 'Upload cancelled', cancelled: true, canRetry: false };
        }

        log.error(`Upload attempt ${attempt + 1} failed:`, {
          message: error.message,
          code: error.code,
          status: error.response?.status,
          statusText: error.response?.statusText,
          responseData: error.response?.data,
          isTimeout: error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED'
        });

        // Check for authentication errors (401) - don't retry these
        if (error.response && error.response.status === 401) {
          const errorMessage = error.response.data?.error || error.response.data?.message || 'Token expired';
          log.warn('Upload failed due to authentication error:', errorMessage);
          return { success: false, error: errorMessage, status: 401, canRetry: false };
        }

        // Check for insufficient minutes (402/403 with minutes error) - don't retry these
        if (error.response && (error.response.status === 402 ||
            (error.response.data?.error && /insufficient|minutes|credit|balance/i.test(error.response.data.error)))) {
          const errorMessage = error.response.data?.error || 'Insufficient minutes';
          log.warn('Upload failed due to insufficient minutes:', errorMessage);
          return { success: false, error: errorMessage, status: error.response.status, canRetry: false, insufficientMinutes: true };
        }

        const isRetryable = error.code === 'ECONNREFUSED' ||
                            error.code === 'ETIMEDOUT' ||
                            error.code === 'ECONNABORTED' ||
                            error.code === 'ENOTFOUND' ||
                            error.code === 'ENETUNREACH' ||
                            error.code === 'EAI_AGAIN' ||
                            error.code === 'ECONNRESET' ||
                            error.code === 'EPIPE' ||
                            (error.message && error.message.includes('socket hang up')) ||
                            error.transient === true || // api-resilience: HTML instead of JSON, exhausted gateway retry
                            (error.response && error.response.status >= 500);

        // If we've exhausted retries or error is not retryable
        if (attempt >= maxRetries || !isRetryable) {
          let errorMessage = 'Upload failed';
          let status = 0;
          if (error.nonJson) {
            errorMessage = error.message;
            status = error.status || 0;
          } else if (error.response) {
            errorMessage = error.response.data?.error || `Server error: ${error.response.status}`;
            status = error.response.status;
          } else if (error.code === 'ECONNREFUSED') {
            errorMessage = 'Could not connect to server. Please check your internet connection.';
          } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
            errorMessage = 'Upload timed out. Please try again.';
          } else if (error.code === 'ENOTFOUND' || error.code === 'ENETUNREACH') {
            errorMessage = 'No internet connection. Please check your network.';
          } else if (error.code === 'ECONNRESET' || error.code === 'EPIPE' || (error.message && error.message.includes('socket hang up'))) {
            errorMessage = 'Connection was interrupted. Please try again.';
          } else {
            errorMessage = error.message || 'Unknown error';
          }
          // Throttled to once per recordId/session so automatic retry passes
          // of the same doomed upload cannot storm Sentry (ELECTRON-27).
          report.captureUploadFailureOnce(recordId, error, 'upload', {
            attempt: attempt + 1,
            maxRetries,
            errorCode: error.code,
            httpStatus: status,
            isRetryable,
            isTimeout: error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED',
          });
          return { success: false, error: errorMessage, status, canRetry: isRetryable };
        }
        // Otherwise continue to next retry attempt
      }
    }

    return { success: false, error: 'Upload failed after all retry attempts', canRetry: true };
  }

  /**
   * upload:start after main's guards (claim, power blocker): queue first,
   * then the upload, then queue and renderer. `cancelled()`/`quitting()`
   * read main's user-cancel and quit state.
   */
  function runUploadStart(scope, { recordId, filePath, metadata }, { cancelled, quitting }) {
    return guard(scope, sessionEndedResult, async () => {
      // Persist before any network request.
      const owner = read.recordingOwner(recordId) || pure.tokenUserId(scope.token());
      scope.update.queue((queue) => queueOps.addToQueue(queue, { recordId, filePath, metadata, userId: owner }));
      log.info('Added to upload queue:', recordId);
      scope.notify('upload:started', { recordId });

      const result = await uploadWithRetry(scope, recordId, filePath, metadata, 3);
      // Signed out during the upload - the queue keeps the recording.
      if (result.sessionEnded) return result;

      // Remove from queue on success OR on terminal failure (canRetry === false).
      // A quit-time abort ({ cancelled, canRetry: false } without a user cancel)
      // stays queued and resumes on the next launch. 401 is NOT terminal for
      // the recording: it becomes uploadable when its owner signs in again.
      const authFailure = result.status === 401;
      const abortedByQuit = result.cancelled && quitting() && !cancelled();
      if ((result.success || (result.canRetry === false && !authFailure)) && !abortedByQuit) {
        scope.update.queue((queue) => queueOps.removeFromQueue(queue, recordId));
        log.info('Removed from upload queue:', recordId);
        if (!result.success) log.warn(`[upload] Removing terminal-failure ${recordId} from queue (status=${result.status}, error=${result.error})`);
      }

      // Suppress completion event if the upload was cancelled by the user
      if (cancelled()) return result;
      scope.notify('upload:complete', {
        recordId,
        success: result.success,
        error: result.error,
        pendingVerification: result.pendingVerification,
        audioFileId: result.audioFileId,
        verified: result.verified,
        contentVerified: result.contentVerified === true,
        canDelete: result.canDelete,
      });
      return result;
    });
  }

  return {
    uploadWithRetry, tryDirectUpload, uploadWithRetryLegacy, verifyAcceptedUpload, saveUploadOutcome,
    pollServerStatus, pollMeetingTranscriptionStatus, refreshMainAuthToken, runUploadStart,
  };
}

module.exports = { createUploads, guard, PERSISTED_STATES, FAILED_STATES };
