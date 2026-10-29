'use strict';

// Pure mutations of the upload queue and the history list (round 9). The
// background writes them only through `scope.update.queue/history`, the
// foreground IPC handlers (user cancel, remove) with the store directly.

/** Add or refresh a queue entry; a known recording keeps its retryCount (ELECTRON-27 class). */
function addToQueue(queue, { recordId, filePath, metadata, userId, now = new Date().toISOString() }) {
  const existing = queue.find((u) => u.recordId === recordId);
  if (existing) {
    // Re-enqueue of a known recording (e.g. manual retry): refresh the file
    // path/metadata but KEEP the accumulated retryCount - resetting it made
    // the max-retries cap unreachable for a doomed upload that kept getting
    // re-added, so it retried forever.
    existing.userId = existing.userId || userId;
    existing.filePath = filePath;
    existing.metadata = metadata;
    return queue;
  }
  queue.push({ recordId, filePath, metadata, userId, addedAt: now, retryCount: 0 });
  return queue;
}

function removeFromQueue(queue, recordId) {
  return queue.filter((u) => u.recordId !== recordId);
}

/** @returns {Array|undefined} undefined: nothing to write */
function bumpRetry(queue, recordId, now = new Date().toISOString()) {
  const item = queue.find((u) => u.recordId === recordId);
  if (!item) return undefined;
  item.retryCount = (item.retryCount || 0) + 1;
  item.lastRetry = now;
  return queue;
}

/** A history change of one recording. @returns {Array|undefined} */
function changeHistory(recordings, recordId, change) {
  const recording = recordings.find((r) => r.id === recordId);
  if (!recording) return undefined;
  const { onlyIfNotUploaded, ...fields } = change;
  if (onlyIfNotUploaded && recording.uploadStatus === 'uploaded') return undefined;
  Object.assign(recording, fields);
  return recordings;
}

/** The upload outcome in history (success or pending verification). @returns {Array|undefined} */
function uploadOutcome(recordings, recordId, result) {
  const recording = recordings.find((r) => r.id === recordId);
  if (!recording || !(result.success || result.pendingVerification)) return undefined;
  Object.assign(recording, {
    uploadStatus: result.success ? 'uploaded' : 'pending_verification',
    audioFileId: result.audioFileId, transcriptionId: result.transcriptionId || null,
    uploadVerified: result.verified === true, uploadError: result.error || null,
  });
  return recordings;
}

module.exports = { addToQueue, removeFromQueue, bumpRetry, changeHistory, uploadOutcome };
