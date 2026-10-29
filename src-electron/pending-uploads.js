'use strict';

/**
 * Main-process upload queue (recordings waiting for an upload; startup,
 * after sign-in, after recovery, periodic retry).
 *
 * E7 (security review 10/2026, round 6): the run takes a session ticket when
 * it starts and checks it before every request and after every await or
 * sleep. After a sign-out (or any session change) it stops at once: no further
 * request, and neither the queue nor the history is changed by this run.
 * One run per ticket (review round 7): a run of an ended session no longer
 * counts as «already running», so the run after the next sign-in starts at
 * once instead of waiting for the periodic timer.
 *
 * Dependencies are injected so the loop can be tested without Electron.
 */

/**
 * @param {object} d
 * @param {object} d.authority - session-authority.js
 * @param {() => Array} d.getQueue
 * @param {(recordId: string) => void} d.removeFromQueue
 * @param {(recordId: string) => void} d.bumpRetry
 * @param {Set<string>} d.inFlight
 * @param {(recordId: string, filePath: string, metadata: object, maxRetries: number, ticket: object) => Promise<object>} d.upload
 * @param {(item: object, userId: string|null) => boolean} d.mayUpload - owner check
 * @param {(recordId: string) => object|null} d.readReceipt
 * @param {(filePath: string) => Promise<void>} d.access - rejects when the file is gone
 * @param {(recordId: string, change: object) => void} d.updateHistory
 * @param {(recordId: string, result: object) => void} d.saveOutcome
 * @param {(channel: string, payload: object) => void} d.notify
 * @param {(token: string|null) => string|null} d.tokenUserId
 * @param {(ms: number) => Promise<void>} d.wait
 * @param {() => void} [d.onBusyChange]
 * @param {{ info: Function, warn: Function, error: Function }} d.log
 */
function createPendingUploadProcessor(d) {
  // Ticket of the run in progress (null: none).
  let running = null;

  return async function processPendingUploads() {
    if (running && d.authority.isCurrent(running)) {
      d.log.info('Upload processing already in progress, skipping');
      return;
    }
    const ticket = d.authority.ticket();
    running = ticket;
    try {
      const current = () => d.authority.isCurrent(ticket);
      const token = () => (current() ? d.authority.getToken() : null);

      const queue = d.getQueue();
      if (queue.length === 0) return;
      d.log.info(`Found ${queue.length} pending uploads, processing...`);
      if (!token()) {
        d.log.info('No auth token, skipping pending uploads');
        return;
      }

      for (const item of queue) {
        if (!current()) return;
        const userId = d.tokenUserId(token());
        if (!userId || !d.mayUpload(item, userId)) continue;
        // Don't double-upload: the renderer's upload:start path may already
        // have this recording in flight (duplicate meeting on the server).
        if (d.inFlight.has(item.recordId)) {
          d.log.info(`Pending processor: ${item.recordId} already in flight (renderer path), skipping`);
          continue;
        }
        if (item.retryCount >= 10 && !d.readReceipt(item.recordId)?.audioFileId) {
          d.log.warn(`Upload ${item.recordId} exceeded max retries, removing from queue`);
          d.removeFromQueue(item.recordId);
          // A silent queue removal left the entry 'pending' forever.
          d.updateHistory(item.recordId, { uploadStatus: 'failed', uploadError: 'Upload failed after 10 attempts', onlyIfNotUploaded: true });
          continue;
        }

        let exists = true;
        try { await d.access(item.filePath); } catch { exists = false; }
        if (!current()) return;
        if (!exists) {
          d.log.warn(`File not found for ${item.recordId}, removing from queue`);
          d.removeFromQueue(item.recordId);
          continue;
        }

        d.log.info(`Retrying upload for ${item.recordId} (attempt ${item.retryCount + 1})`);
        d.bumpRetry(item.recordId);

        d.inFlight.add(item.recordId);
        if (d.onBusyChange) d.onBusyChange();
        let result;
        try {
          result = await d.upload(item.recordId, item.filePath, item.metadata, 2, ticket);
        } catch (e) {
          d.log.error(`Failed to upload ${item.recordId}:`, e?.message);
          result = null;
        } finally {
          d.inFlight.delete(item.recordId);
          if (d.onBusyChange) d.onBusyChange();
        }
        // Signed out (or another session) while uploading: the upload was
        // aborted for that reason - the queue keeps the recording as it is.
        if (!current()) return;

        if (result) {
          if (!result.success && result.status === 401) {
            d.log.warn('Token expired - stopping pending uploads processing');
            d.notify('auth:expired', {
              message: 'Your session has expired. Please log in again to continue uploading.',
              pendingUploads: queue.length
            });
            return;
          }
          if (result.success) {
            d.removeFromQueue(item.recordId);
            d.updateHistory(item.recordId, { uploadStatus: 'uploaded', transcriptionId: result.transcriptionId, audioFileId: result.audioFileId });
            d.log.info(`Successfully uploaded pending recording: ${item.recordId}`);
            d.notify('upload:complete', { recordId: item.recordId, success: true, audioFileId: result.audioFileId, background: true });
          } else if (result.pendingVerification) {
            d.saveOutcome(item.recordId, result);
          } else if (result.canRetry === false && !result.sessionEnded) {
            // Terminal failure (413, 402, 415, 400, ...): drop it so it is
            // not re-attempted on every launch.
            d.log.warn(`[upload] Terminal failure for pending ${item.recordId} (status=${result.status}): ${result.error} — removing from queue`);
            d.removeFromQueue(item.recordId);
            d.updateHistory(item.recordId, { uploadStatus: 'failed', uploadError: result.error || 'Upload rejected by server' });
            d.notify('upload:complete', { recordId: item.recordId, success: false, error: result.error, terminal: true, background: true });
          }
        }

        // Pause between uploads to avoid overwhelming the server.
        await d.wait(5000);
        if (!current()) return;
      }
    } finally {
      if (running === ticket) running = null;
    }
  };
}

module.exports = { createPendingUploadProcessor };
