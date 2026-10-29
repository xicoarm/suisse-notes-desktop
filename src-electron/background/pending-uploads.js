'use strict';

/**
 * Main-process upload queue (recordings waiting for an upload; startup,
 * after sign-in, after recovery, periodic retry).
 *
 * Round 9 (council 3): one run per SessionScope. The scope is opened by the
 * entry (main) and handed down unchanged; every queue, history and renderer
 * effect and every wait goes through it. After a sign-out (or any session
 * change) the run stops at once: no further request, and neither the queue
 * nor the history is changed by this run. A run of an ended session no
 * longer counts as «already running», so the run after the next sign-in
 * starts at once. In-flight claims are released only by their own scope.
 */

const { isSessionEnded } = require('./ended');
const queueOps = require('./queue-ops');

/**
 * @param {object} d
 * @param {object} d.uploads - background/upload.js (uploadWithRetry)
 * @param {object} d.read - recordingOwner, readUploadReceipt, inFlight
 * @param {object} d.pure - tokenUserId, canUploadForUser
 * @param {{ onBusyChange?: () => void }} [d.hooks]
 * @param {{ info: Function, warn: Function, error: Function }} d.log
 */
function createPendingUploadProcessor({ uploads, read, pure, hooks = {}, log }) {
  // Scope of the run in progress (null: none).
  let running = null;
  const busy = () => { if (hooks.onBusyChange) hooks.onBusyChange(); };

  async function run(scope) {
    if (running && running.alive()) {
      log.info('Upload processing already in progress, skipping');
      return { skipped: true };
    }
    running = scope;
    try {
      const queue = scope.read.queue();
      if (queue.length === 0) return { completed: true };
      log.info(`Found ${queue.length} pending uploads, processing...`);
      if (!scope.token()) {
        log.info('No auth token, skipping pending uploads');
        return { completed: true };
      }

      for (const item of queue) {
        scope.assertAlive();
        const userId = pure.tokenUserId(scope.token());
        if (!userId || !pure.canUploadForUser(item.userId || read.recordingOwner(item.recordId), userId)) continue;
        // Don't double-upload: the renderer's upload:start path may already
        // have this recording in flight (duplicate meeting on the server).
        if (read.inFlight(item.recordId)) {
          log.info(`Pending processor: ${item.recordId} already in flight (renderer path), skipping`);
          continue;
        }
        if (item.retryCount >= 10 && !read.readUploadReceipt(item.recordId)?.audioFileId) {
          log.warn(`Upload ${item.recordId} exceeded max retries, removing from queue`);
          scope.update.queue((q) => queueOps.removeFromQueue(q, item.recordId));
          // A silent queue removal left the entry 'pending' forever.
          scope.update.history((h) => queueOps.changeHistory(h, item.recordId, { uploadStatus: 'failed', uploadError: 'Upload failed after 10 attempts', onlyIfNotUploaded: true }));
          continue;
        }

        let exists = true;
        try { await scope.fs.access(item.filePath); } catch (error) { if (isSessionEnded(error)) throw error; exists = false; }
        if (!exists) {
          log.warn(`File not found for ${item.recordId}, removing from queue`);
          scope.update.queue((q) => queueOps.removeFromQueue(q, item.recordId));
          continue;
        }

        log.info(`Retrying upload for ${item.recordId} (attempt ${item.retryCount + 1})`);
        scope.update.queue((q) => queueOps.bumpRetry(q, item.recordId));

        if (!scope.claim(item.recordId)) continue;
        busy();
        let result;
        try {
          result = await uploads.uploadWithRetry(scope, item.recordId, item.filePath, item.metadata, 2);
        } catch (error) {
          if (isSessionEnded(error) || !scope.alive()) throw error;
          log.error(`Failed to upload ${item.recordId}:`, error?.message);
          result = null;
        } finally {
          scope.release(item.recordId);
          busy();
        }
        // Signed out (or another session) while uploading: the upload was
        // aborted for that reason - the queue keeps the recording as it is.
        scope.assertAlive();
        if (result?.sessionEnded) return { sessionEnded: true };

        if (result) {
          if (!result.success && result.status === 401) {
            log.warn('Token expired - stopping pending uploads processing');
            scope.notify('auth:expired', {
              message: 'Your session has expired. Please log in again to continue uploading.',
              pendingUploads: queue.length
            });
            return { completed: true };
          }
          if (result.success) {
            scope.update.queue((q) => queueOps.removeFromQueue(q, item.recordId));
            scope.update.history((h) => queueOps.changeHistory(h, item.recordId, { uploadStatus: 'uploaded', transcriptionId: result.transcriptionId, audioFileId: result.audioFileId }));
            log.info(`Successfully uploaded pending recording: ${item.recordId}`);
            scope.notify('upload:complete', { recordId: item.recordId, success: true, audioFileId: result.audioFileId, background: true });
          } else if (result.pendingVerification) {
            uploads.saveUploadOutcome(scope, item.recordId, result);
          } else if (result.canRetry === false) {
            // Terminal failure (413, 402, 415, 400, ...): drop it so it is
            // not re-attempted on every launch.
            log.warn(`[upload] Terminal failure for pending ${item.recordId} (status=${result.status}): ${result.error} — removing from queue`);
            scope.update.queue((q) => queueOps.removeFromQueue(q, item.recordId));
            scope.update.history((h) => queueOps.changeHistory(h, item.recordId, { uploadStatus: 'failed', uploadError: result.error || 'Upload rejected by server' }));
            scope.notify('upload:complete', { recordId: item.recordId, success: false, error: result.error, terminal: true, background: true });
          }
        }

        // Pause between uploads to avoid overwhelming the server.
        await scope.sleep(5000);
      }
      return { completed: true };
    } catch (error) {
      if (isSessionEnded(error) || !scope.alive()) return { sessionEnded: true };
      throw error;
    } finally {
      if (running === scope) running = null;
    }
  }

  return { run };
}

module.exports = { createPendingUploadProcessor };
