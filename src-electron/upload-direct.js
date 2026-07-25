/**
 * Direct-to-Azure-Blob upload via presigned SAS URLs.
 *
 * Replaces the old single-POST `/api/desktop/upload` flow which was
 * bottlenecked on app-server memory and capped at the smallest layer
 * (nginx, Next.js, Cloudflare). With this module:
 *
 *   1. POST /api/uploads/init  — server returns a write-permitted SAS URL
 *      and a recommended block size (e.g. 4–32 MB depending on file size).
 *   2. The client streams the file in blocks directly to Azure Blob
 *      Storage using "Put Block" (each block retries independently).
 *   3. The client commits the blocks with "Put Block List".
 *   4. POST /api/uploads/complete — server verifies the blob exists,
 *      reserves minutes, creates the meeting, and dispatches transcription.
 *
 * Bytes never transit the app server. 5h recordings (1–3 GB) work
 * regardless of any proxy body-size limits.
 *
 * If the backend reports `mode: 'fallback'` (e.g. local-storage mode),
 * the caller is expected to fall back to the legacy formData POST flow.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const log = require('electron-log');

// HTTP status codes that should NEVER be retried — the request will
// fail identically next time. These come back from /api/uploads/init,
// /api/uploads/complete, or Azure block PUTs.
const FATAL_HTTP_STATUSES = new Set([
  400, // Bad request — client error (e.g. file too small, wrong content-type)
  401, // Unauthorized — token issue, handled separately by caller
  402, // Payment required — insufficient minutes
  403, // Forbidden — auth issue or non-recoverable permission denial
  404, // Not found — endpoint missing (server too old?)
  409, // Conflict — meeting already linked
  410, // Gone
  413, // Payload too large — file exceeds server cap
  415, // Unsupported media type
  422, // Unprocessable entity
]);

// Network-level errors that ARE retryable — transient connectivity.
const RETRYABLE_AXIOS_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ECONNRESET',
  'EPIPE',
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
  '.opus': 'audio/opus',
};

function detectContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function isAbortError(err) {
  return (
    err?.name === 'CanceledError' ||
    err?.name === 'AbortError' ||
    err?.code === 'ERR_CANCELED' ||
    err?.message === 'canceled'
  );
}

function isFatalAxiosError(err) {
  if (!err?.response) return false;
  return FATAL_HTTP_STATUSES.has(err.response.status);
}

function isRetryableAxiosError(err) {
  if (isFatalAxiosError(err)) return false;
  if (err?.response?.status >= 500) return true;
  if (RETRYABLE_AXIOS_CODES.has(err?.code)) return true;
  if (err?.message && err.message.includes('socket hang up')) return true;
  // Azure returns 503 occasionally and 408 (timeout) — both retryable.
  if (err?.response?.status === 408 || err?.response?.status === 429) return true;
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Generate a stable, sortable, base64-encoded block ID.
 * Azure requires all block IDs in a single blob to be the same length.
 * Using a fixed-width zero-padded counter ensures that.
 */
function makeBlockId(index) {
  // 16 chars → padded → guaranteed unique within one upload
  const raw = `block-${String(index).padStart(10, '0')}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

/**
 * PUT a single block to Azure with retry. Returns the blockId used.
 *
 * Per-block retry is independent of overall upload retry — a single
 * flaky chunk shouldn't kill an otherwise-good 1-hour upload.
 */
async function uploadBlockWithRetry({
  filePath,
  start,
  end, // exclusive
  sasUrl,
  blockId,
  abortSignal,
  maxAttempts = 4,
}) {
  const blockSize = end - start;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (abortSignal?.aborted) {
      const e = new Error('Upload cancelled');
      e.cancelled = true;
      throw e;
    }

    try {
      const url = `${sasUrl}&comp=block&blockid=${encodeURIComponent(blockId)}`;
      const stream = fs.createReadStream(filePath, { start, end: end - 1 });
      // Per-block timeout scales with block size at ~200 KB/s floor,
      // capped at 5 min. This is per-attempt; total time across retries
      // is bounded by maxAttempts.
      const timeoutMs = Math.min(
        300_000,
        Math.max(60_000, Math.ceil(blockSize / (200 * 1024)) * 1000 + 30_000)
      );

      await axios.put(url, stream, {
        headers: {
          'Content-Length': blockSize,
          'Content-Type': 'application/octet-stream',
          'x-ms-blob-type': 'BlockBlob',
        },
        maxBodyLength: blockSize + 1024,
        maxContentLength: blockSize + 1024,
        timeout: timeoutMs,
        signal: abortSignal,
      });
      return blockId;
    } catch (err) {
      lastErr = err;

      if (isAbortError(err) || abortSignal?.aborted) {
        const e = new Error('Upload cancelled');
        e.cancelled = true;
        throw e;
      }

      // 403 from Azure typically means the SAS expired or signature mismatch.
      // Surface this so the caller can re-init and resume. It is NOT one of
      // the local fatal codes for the app server, but for Azure it is.
      if (err?.response?.status === 403) {
        const e = new Error('Azure SAS URL expired or invalid');
        e.sasExpired = true;
        e.cause = err;
        throw e;
      }

      if (!isRetryableAxiosError(err)) {
        // Fatal at the Azure level — surface immediately.
        const e = new Error(`Block upload failed: ${err.message}`);
        e.cause = err;
        e.status = err.response?.status;
        e.fatal = true;
        throw e;
      }

      if (attempt < maxAttempts - 1) {
        const delay = Math.min(15_000, 500 * Math.pow(2, attempt));
        log.warn(
          `[uploadBlock] block=${blockId} attempt=${attempt + 1}/${maxAttempts} failed ` +
            `(${err.response?.status || err.code}), retrying in ${delay}ms`
        );
        await sleep(delay);
      }
    }
  }

  throw lastErr || new Error('Block upload failed after retries');
}

/**
 * Commit the staged blocks via Put Block List.
 */
async function commitBlockList({ sasUrl, blockIds, contentType, abortSignal }) {
  const blocksXml = blockIds
    .map((id) => `<Latest>${escapeXml(id)}</Latest>`)
    .join('');
  const body = `<?xml version="1.0" encoding="utf-8"?><BlockList>${blocksXml}</BlockList>`;

  const url = `${sasUrl}&comp=blocklist`;

  await axios.put(url, body, {
    headers: {
      'Content-Type': 'application/xml',
      'x-ms-blob-content-type': contentType,
    },
    timeout: 120_000,
    signal: abortSignal,
  });
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Probe duration via ffprobe. Optional but strongly preferred so the
 * server can reserve minutes accurately.
 *
 * @param {object} ffmpeg - fluent-ffmpeg instance (already configured by caller)
 */
function probeDurationSeconds(ffmpeg, filePath) {
  return new Promise((resolve) => {
    try {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err || !metadata) return resolve(0);
        const d = Number(metadata?.format?.duration);
        if (!Number.isFinite(d) || d <= 0) return resolve(0);
        resolve(d);
      });
    } catch {
      resolve(0);
    }
  });
}

/**
 * Main entry point.
 *
 * @param {object} opts
 * @param {string} opts.apiBaseUrl - e.g. https://app.suisse-notes.ch
 * @param {string} opts.authToken
 * @param {string} opts.recordId
 * @param {string} opts.filePath
 * @param {object} opts.metadata
 * @param {AbortController} opts.abortController
 * @param {object} opts.ffmpeg - fluent-ffmpeg with ffprobe configured
 * @param {function} opts.onProgress - ({progress, bytesUploaded, bytesTotal, phase}) => void
 * @param {function} [opts.onSession] - ({audioFileId, blobName}) => void
 *   Fires once init succeeds, before any blocks are staged. Lets the caller
 *   track the audioFileId so upload:cancel can abort the staged blob.
 *
 * @returns {Promise<{
 *   mode: 'azure' | 'fallback',
 *   success: boolean,
 *   audioFileId?: string,
 *   meetingId?: string,
 *   transcriptionId?: string,
 *   message?: string,
 *   gatewayFailed?: boolean,
 *   error?: string,
 *   status?: number,
 *   canRetry?: boolean,
 *   insufficientMinutes?: boolean,
 *   deduplicated?: boolean,
 * }>}
 */
async function uploadViaPresignedSas(opts) {
  const {
    apiBaseUrl,
    authToken,
    recordId,
    filePath,
    metadata = {},
    abortController,
    ffmpeg,
    onProgress = () => {},
    onSession = () => {},
  } = opts;

  const stats = await fs.promises.stat(filePath);
  const fileSize = stats.size;
  const fileName = path.basename(filePath);
  const contentType = detectContentType(filePath);

  // Probe duration up-front. If ffprobe fails we still proceed but
  // pass `0` and let the server reject if it cannot estimate.
  let durationSeconds = Number(metadata?.duration) || 0;
  if (durationSeconds <= 0 && ffmpeg) {
    durationSeconds = await probeDurationSeconds(ffmpeg, filePath);
  }
  if (durationSeconds <= 0) {
    log.warn(`[uploadDirect] No duration available for ${recordId}; will let server decide`);
  }

  // === Step 1: Init ===
  let initResp;
  try {
    initResp = await axios.post(
      `${apiBaseUrl}/api/uploads/init`,
      {
        recordId,
        fileName,
        fileSize,
        contentType,
        durationSeconds,
      },
      {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 30_000,
        signal: abortController?.signal,
      }
    );
  } catch (err) {
    if (isAbortError(err)) {
      return { mode: 'azure', success: false, cancelled: true, canRetry: false };
    }
    if (err?.response?.status === 401) {
      return {
        mode: 'azure',
        success: false,
        status: 401,
        error: err.response.data?.error || 'Token expired',
        canRetry: false,
      };
    }
    if (err?.response?.status === 402) {
      return {
        mode: 'azure',
        success: false,
        status: 402,
        error: err.response.data?.error || 'Insufficient minutes',
        insufficientMinutes: true,
        canRetry: false,
      };
    }
    if (err?.response?.status === 413) {
      return {
        mode: 'azure',
        success: false,
        status: 413,
        error: err.response.data?.error || 'File too large',
        canRetry: false,
      };
    }
    if (isFatalAxiosError(err)) {
      return {
        mode: 'azure',
        success: false,
        status: err.response.status,
        error: err.response.data?.error || `Init failed: ${err.message}`,
        canRetry: false,
      };
    }
    // Transient — caller can retry
    throw err;
  }

  const init = initResp.data || {};

  // Server told us to use the legacy POST path (e.g. local-storage mode).
  if (init.mode === 'fallback') {
    log.info(`[uploadDirect] Server requested fallback mode for ${recordId}`);
    return { mode: 'fallback' };
  }

  // Server says this recording is already fully processed — fast path.
  if (init.completed && init.deduplicated) {
    log.info(`[uploadDirect] Server reports recording already completed: ${recordId}`);
    return {
      mode: 'azure',
      success: true,
      audioFileId: init.audioFileId,
      meetingId: init.meetingId,
      transcriptionId: init.audioFileId,
      message: init.message || 'Already uploaded',
      deduplicated: true,
      canDelete: true,
    };
  }

  if (init.mode !== 'azure' || !init.sasUrl || !init.audioFileId || !init.blockSize) {
    return {
      mode: 'azure',
      success: false,
      error: 'Server returned an invalid init response',
      canRetry: false,
    };
  }

  let { sasUrl, audioFileId, blockSize, blobName } = init;
  const totalBlocks = Math.ceil(fileSize / blockSize);

  log.info(
    `[uploadDirect] Initialized upload recordId=${recordId} audioFileId=${audioFileId} ` +
      `size=${fileSize} blockSize=${blockSize} blocks=${totalBlocks}`
  );

  try {
    onSession({ audioFileId, blobName });
  } catch (e) {
    log.warn('[uploadDirect] onSession callback threw:', e?.message);
  }

  // === Step 2: Stage blocks ===
  const blockIds = [];
  let bytesUploaded = 0;
  onProgress({ progress: 0, bytesUploaded: 0, bytesTotal: fileSize, phase: 'uploading' });

  for (let i = 0; i < totalBlocks; i++) {
    if (abortController?.signal?.aborted) {
      return { mode: 'azure', success: false, cancelled: true, canRetry: false };
    }

    const start = i * blockSize;
    const end = Math.min(fileSize, start + blockSize);
    const blockId = makeBlockId(i);

    try {
      await uploadBlockWithRetry({
        filePath,
        start,
        end,
        sasUrl,
        blockId,
        abortSignal: abortController?.signal,
      });
    } catch (err) {
      if (err?.cancelled) {
        return { mode: 'azure', success: false, cancelled: true, canRetry: false };
      }
      if (err?.sasExpired) {
        // Re-init to get a fresh SAS, then resume from current block.
        log.warn(`[uploadDirect] SAS expired mid-upload at block ${i}; re-initializing`);
        try {
          const reinitResp = await axios.post(
            `${apiBaseUrl}/api/uploads/init`,
            { recordId, fileName, fileSize, contentType, durationSeconds },
            {
              headers: { Authorization: `Bearer ${authToken}` },
              timeout: 30_000,
              signal: abortController?.signal,
            }
          );
          const reinit = reinitResp.data || {};
          if (reinit.mode === 'azure' && reinit.sasUrl && reinit.audioFileId) {
            if (reinit.audioFileId === audioFileId) {
              // Same session — fresh SAS, previously staged blocks remain valid.
              // Retry this same block.
              sasUrl = reinit.sasUrl;
              i--;
              continue;
            }
            // DUREC-3: the server handed us a DIFFERENT audioFileId. The blocks
            // staged so far belong to the OLD blob and can never be committed
            // into the new one — committing a partial/mixed block list would
            // silently truncate the recording. Best-effort abort the old
            // session, then restart cleanly from block 0 onto the new session.
            // NB: keep the original blockSize so totalBlocks stays consistent.
            log.warn(
              `[uploadDirect] Re-init returned a new audioFileId ` +
                `(${audioFileId} -> ${reinit.audioFileId}); restarting upload from block 0`
            );
            try {
              await abortDirectUpload({ apiBaseUrl, authToken, recordId, audioFileId });
            } catch (e) {
              log.warn('[uploadDirect] Abort of stale session failed (non-fatal):', e?.message);
            }
            audioFileId = reinit.audioFileId;
            sasUrl = reinit.sasUrl;
            blobName = reinit.blobName || blobName;
            blockIds.length = 0;
            bytesUploaded = 0;
            try { onSession({ audioFileId, blobName }); } catch (_) { /* best-effort */ }
            i = -1; // for-loop ++ resumes at block 0
            continue;
          }
        } catch (e) {
          log.error(`[uploadDirect] Re-init after SAS expiry failed:`, e.message);
          // A FATAL status from re-init (400/402/413/…) will fail identically
          // on every future attempt — returning canRetry:true here fed the
          // permanent-retry loop (ELECTRON-27 class). Classify it.
          if (isFatalAxiosError(e)) {
            return {
              mode: 'azure',
              success: false,
              status: e.response.status,
              error: e.response.data?.error || `Re-init failed: ${e.message}`,
              canRetry: false,
            };
          }
        }
        return {
          mode: 'azure',
          success: false,
          error: 'Upload session expired and could not be refreshed',
          canRetry: true,
        };
      }
      if (err?.fatal) {
        return {
          mode: 'azure',
          success: false,
          status: err.status,
          error: err.message,
          canRetry: false,
        };
      }
      // Bubble up — caller's outer retry handles it.
      throw err;
    }

    blockIds.push(blockId);
    bytesUploaded = end;
    // Cap visible progress at 95 — the last 5 % is reserved for
    // commit + complete + verification phases.
    const progress = Math.min(95, Math.round((bytesUploaded / fileSize) * 95));
    onProgress({ progress, bytesUploaded, bytesTotal: fileSize, phase: 'uploading' });
  }

  // === Step 3: Commit block list ===
  onProgress({ progress: 96, bytesUploaded: fileSize, bytesTotal: fileSize, phase: 'committing' });
  try {
    await commitBlockList({
      sasUrl,
      blockIds,
      contentType,
      abortSignal: abortController?.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      return { mode: 'azure', success: false, cancelled: true, canRetry: false };
    }
    log.error(`[uploadDirect] Commit block list failed:`, err.message);
    return {
      mode: 'azure',
      success: false,
      error: `Could not finalize blob: ${err.response?.status || err.message}`,
      canRetry: !isFatalAxiosError(err),
    };
  }

  // === Step 4: Complete ===
  onProgress({ progress: 98, bytesUploaded: fileSize, bytesTotal: fileSize, phase: 'finalizing' });

  let completeResp;
  try {
    completeResp = await axios.post(
      `${apiBaseUrl}/api/uploads/complete`,
      {
        recordId,
        audioFileId,
        blobName,
        fileName,
        fileSize,
        contentType,
        durationSeconds,
        metadata,
      },
      {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 120_000,
        signal: abortController?.signal,
      }
    );
  } catch (err) {
    if (isAbortError(err)) {
      return { mode: 'azure', success: false, cancelled: true, canRetry: false };
    }
    if (err?.response?.status === 401) {
      return {
        mode: 'azure',
        success: false,
        status: 401,
        error: err.response.data?.error || 'Token expired',
        canRetry: false,
      };
    }
    if (err?.response?.status === 402) {
      return {
        mode: 'azure',
        success: false,
        status: 402,
        error: err.response.data?.error || 'Insufficient minutes',
        insufficientMinutes: true,
        canRetry: false,
      };
    }
    if (isFatalAxiosError(err)) {
      return {
        mode: 'azure',
        success: false,
        status: err.response.status,
        error: err.response.data?.error || `Complete failed: ${err.message}`,
        canRetry: false,
      };
    }
    // Transient — bubble up to outer retry. Important: the bytes are
    // already in Azure, so retrying complete is cheap (server dedups).
    throw err;
  }

  onProgress({ progress: 100, bytesUploaded: fileSize, bytesTotal: fileSize, phase: 'complete' });

  const data = completeResp.data || {};
  return {
    mode: 'azure',
    success: !!data.success,
    audioFileId: data.audioFileId || audioFileId,
    meetingId: data.meetingId,
    transcriptionId: data.transcriptionId || data.audioFileId || audioFileId,
    message: data.message,
    gatewayFailed: !!data.gatewayFailed,
    deduplicated: !!data.deduplicated,
    canDelete: true,
    verified: true,
  };
}

/**
 * Best-effort abort: deletes the staged blob server-side so it doesn't
 * accumulate orphans. Safe to call when the blob doesn't exist.
 */
async function abortDirectUpload({ apiBaseUrl, authToken, recordId, audioFileId }) {
  if (!audioFileId) return { success: true };
  try {
    await axios.post(
      `${apiBaseUrl}/api/uploads/abort`,
      { recordId, audioFileId },
      {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 15_000,
      }
    );
    return { success: true };
  } catch (err) {
    log.warn(`[uploadDirect] Abort cleanup failed for ${audioFileId}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  uploadViaPresignedSas,
  abortDirectUpload,
  FATAL_HTTP_STATUSES,
};
