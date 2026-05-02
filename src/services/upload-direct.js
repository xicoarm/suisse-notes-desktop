/**
 * Direct-to-Azure-Blob upload via presigned SAS URLs (mobile + browser).
 *
 * Mirrors the Electron-side implementation in src-electron/upload-direct.js
 * but uses Web APIs (fetch / Blob / File) so it works in:
 *   - Capacitor iOS
 *   - Capacitor Android
 *   - Browser (file picker uploads, web fallback)
 *
 * Architecture:
 *   1. POST /api/uploads/init → server returns SAS URL + block size
 *   2. Read the file as a Blob (via fetch(file://) on Capacitor, or directly
 *      from a File object in the browser).
 *   3. Slice the Blob and PUT each block directly to Azure Blob Storage.
 *   4. PUT block list to commit.
 *   5. POST /api/uploads/complete → server verifies + dispatches transcription.
 *
 * Bytes never transit the app server.
 */

import { getFileUri } from "./storage";
import { isCapacitor } from "../utils/platform";

// HTTP status codes that should never be retried — the request will fail
// identically next time. Mirrors the desktop side.
const FATAL_HTTP_STATUSES = new Set([
  400, 401, 402, 403, 404, 409, 410, 413, 415, 422,
]);

const MIME_BY_EXT = {
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".mov": "video/quicktime",
};

function detectContentType(filePathOrName) {
  const lower = (filePathOrName || "").toLowerCase();
  for (const [ext, mime] of Object.entries(MIME_BY_EXT)) {
    if (lower.endsWith(ext)) return mime;
  }
  return "application/octet-stream";
}

function makeBlockId(index) {
  // Fixed-width zero-padded so all block IDs in one upload share length —
  // an Azure requirement for Put Block List.
  const raw = `block-${String(index).padStart(10, "0")}`;
  // btoa is available in both Capacitor WebView and modern browsers.
  return btoa(raw);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read a Capacitor file path into a Blob without loading into JS as base64.
 * Uses fetch() on the file:// URI which streams the bytes natively.
 */
async function readBlobFromCapacitorPath(filePath) {
  const uriResult = await getFileUri(filePath);
  if (!uriResult.success) {
    throw new Error(uriResult.error || "Could not resolve file URI");
  }
  let uri = uriResult.uri;
  // On Android, Capacitor returns a real `file://` URL. On iOS the format
  // is similar. Both are accepted by WebView fetch().
  if (uri && !/^file:|^https?:/.test(uri)) {
    uri = `file://${uri}`;
  }
  const resp = await fetch(uri);
  if (!resp.ok) {
    throw new Error(`Could not read file (status ${resp.status})`);
  }
  return await resp.blob();
}

/**
 * PUT a single block to Azure with retry. Returns the blockId used.
 *
 * Per-block retries are independent of overall upload retry — a single
 * flaky chunk shouldn't kill an otherwise-good 1-hour upload.
 */
async function uploadBlockWithRetry({
  blob,
  start,
  end,
  sasUrl,
  blockId,
  abortSignal,
  onAttempt,
  maxAttempts = 4,
}) {
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (abortSignal?.aborted) {
      const e = new Error("Upload cancelled");
      e.cancelled = true;
      throw e;
    }

    try {
      const url = `${sasUrl}&comp=block&blockid=${encodeURIComponent(blockId)}`;
      const slice = blob.slice(start, end);

      const resp = await fetch(url, {
        method: "PUT",
        body: slice,
        headers: {
          "Content-Type": "application/octet-stream",
          "x-ms-blob-type": "BlockBlob",
        },
        signal: abortSignal,
      });

      if (resp.ok) return blockId;

      // 403 from Azure typically means SAS expired or signature mismatch.
      if (resp.status === 403) {
        const e = new Error("Azure SAS URL expired or invalid");
        e.sasExpired = true;
        throw e;
      }

      // Treat 4xx as fatal for this block.
      if (resp.status >= 400 && resp.status < 500) {
        const text = await resp.text().catch(() => "");
        const e = new Error(`Block upload failed: ${resp.status} ${text}`);
        e.fatal = true;
        e.status = resp.status;
        throw e;
      }

      // 5xx — fall through to retry
      lastErr = new Error(`Block upload returned ${resp.status}`);
    } catch (err) {
      // AbortError from fetch
      if (err?.name === "AbortError" || abortSignal?.aborted) {
        const e = new Error("Upload cancelled");
        e.cancelled = true;
        throw e;
      }
      if (err?.sasExpired || err?.fatal) throw err;
      lastErr = err;
    }

    onAttempt?.({ attempt: attempt + 1, error: lastErr });

    if (attempt < maxAttempts - 1) {
      const delay = Math.min(15_000, 500 * Math.pow(2, attempt));
      await sleep(delay);
    }
  }

  throw lastErr || new Error("Block upload failed after retries");
}

async function commitBlockList({ sasUrl, blockIds, contentType, abortSignal }) {
  const blocksXml = blockIds.map((id) => `<Latest>${escapeXml(id)}</Latest>`).join("");
  const body = `<?xml version="1.0" encoding="utf-8"?><BlockList>${blocksXml}</BlockList>`;
  const url = `${sasUrl}&comp=blocklist`;

  const resp = await fetch(url, {
    method: "PUT",
    body,
    headers: {
      "Content-Type": "application/xml",
      "x-ms-blob-content-type": contentType,
    },
    signal: abortSignal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Commit block list failed: ${resp.status} ${text}`);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.apiBaseUrl
 * @param {string} opts.authToken
 * @param {string} opts.recordId
 * @param {string} [opts.filePath] - Capacitor relative path
 * @param {File}   [opts.file]      - Browser File from input
 * @param {object} opts.metadata
 * @param {AbortSignal} [opts.abortSignal]
 * @param {function} [opts.onProgress] - ({progress, bytesUploaded, bytesTotal, phase}) => void
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
export async function uploadViaPresignedSas(opts) {
  const {
    apiBaseUrl,
    authToken,
    recordId,
    filePath,
    file,
    metadata = {},
    abortSignal,
    onProgress = () => {},
  } = opts;

  // 1. Resolve the file as a Blob.
  let blob;
  let fileName;
  if (file) {
    blob = file;
    fileName = file.name || "recording";
  } else if (filePath) {
    blob = await readBlobFromCapacitorPath(filePath);
    fileName = filePath.split(/[\\/]/).pop() || "recording";
  } else {
    return { mode: "azure", success: false, error: "No file or filePath provided", canRetry: false };
  }

  const fileSize = blob.size;
  const contentType = detectContentType(fileName) || blob.type || "application/octet-stream";
  const durationSeconds = Number(metadata?.duration) || 0;

  // 2. Init.
  let initResp, initData;
  try {
    initResp = await fetch(`${apiBaseUrl}/api/uploads/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        recordId,
        fileName,
        fileSize,
        contentType,
        durationSeconds,
      }),
      signal: abortSignal,
    });
    initData = await initResp.json().catch(() => ({}));
  } catch (err) {
    if (err?.name === "AbortError") {
      return { mode: "azure", success: false, cancelled: true, canRetry: false };
    }
    // Network-level failure → caller can retry
    throw err;
  }

  if (!initResp.ok) {
    if (initResp.status === 404) {
      // Backend doesn't have the new routes yet — fall back to legacy.
      return { mode: "fallback", reason: "backend_no_uploads_route" };
    }
    const status = initResp.status;
    const error = initData.error || `Init failed: ${status}`;
    if (status === 401) {
      return { mode: "azure", success: false, status: 401, error, canRetry: false };
    }
    if (status === 402) {
      return {
        mode: "azure",
        success: false,
        status: 402,
        error,
        insufficientMinutes: true,
        canRetry: false,
      };
    }
    if (FATAL_HTTP_STATUSES.has(status)) {
      return { mode: "azure", success: false, status, error, canRetry: false };
    }
    // Transient → throw so caller's outer retry kicks in
    const e = new Error(error);
    e.status = status;
    throw e;
  }

  if (initData.mode === "fallback") {
    return { mode: "fallback", reason: initData.reason || "server_local_storage" };
  }

  if (initData.completed && initData.deduplicated) {
    return {
      mode: "azure",
      success: true,
      audioFileId: initData.audioFileId,
      meetingId: initData.meetingId,
      transcriptionId: initData.audioFileId,
      message: initData.message || "Already uploaded",
      deduplicated: true,
      canDelete: true,
    };
  }

  if (initData.mode !== "azure" || !initData.sasUrl || !initData.audioFileId || !initData.blockSize) {
    return { mode: "azure", success: false, error: "Server returned an invalid init response", canRetry: false };
  }

  let { sasUrl, audioFileId, blockSize, blobName } = initData;
  const totalBlocks = Math.ceil(fileSize / blockSize);

  // 3. Stage blocks.
  const blockIds = [];
  let bytesUploaded = 0;
  onProgress({ progress: 0, bytesUploaded: 0, bytesTotal: fileSize, phase: "uploading" });

  for (let i = 0; i < totalBlocks; i++) {
    if (abortSignal?.aborted) {
      return { mode: "azure", success: false, cancelled: true, canRetry: false };
    }

    const start = i * blockSize;
    const end = Math.min(fileSize, start + blockSize);
    const blockId = makeBlockId(i);

    try {
      await uploadBlockWithRetry({
        blob,
        start,
        end,
        sasUrl,
        blockId,
        abortSignal,
      });
    } catch (err) {
      if (err?.cancelled) {
        return { mode: "azure", success: false, cancelled: true, canRetry: false };
      }
      if (err?.sasExpired) {
        // Re-init to get a fresh SAS, then resume from current block.
        try {
          const reinit = await fetch(`${apiBaseUrl}/api/uploads/init`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              recordId,
              fileName,
              fileSize,
              contentType,
              durationSeconds,
            }),
            signal: abortSignal,
          });
          const reinitData = await reinit.json().catch(() => ({}));
          if (reinit.ok && reinitData.mode === "azure" && reinitData.sasUrl) {
            sasUrl = reinitData.sasUrl;
            i--; // retry this same block with the new SAS
            continue;
          }
        } catch {
          /* fall through */
        }
        return {
          mode: "azure",
          success: false,
          error: "Upload session expired and could not be refreshed",
          canRetry: true,
        };
      }
      if (err?.fatal) {
        return {
          mode: "azure",
          success: false,
          status: err.status,
          error: err.message,
          canRetry: false,
        };
      }
      throw err; // bubble to outer retry
    }

    blockIds.push(blockId);
    bytesUploaded = end;
    const progress = Math.min(95, Math.round((bytesUploaded / fileSize) * 95));
    onProgress({ progress, bytesUploaded, bytesTotal: fileSize, phase: "uploading" });
  }

  // 4. Commit.
  onProgress({ progress: 96, bytesUploaded: fileSize, bytesTotal: fileSize, phase: "committing" });
  try {
    await commitBlockList({ sasUrl, blockIds, contentType, abortSignal });
  } catch (err) {
    if (err?.name === "AbortError") {
      return { mode: "azure", success: false, cancelled: true, canRetry: false };
    }
    return {
      mode: "azure",
      success: false,
      error: `Could not finalize blob: ${err.message}`,
      canRetry: true,
    };
  }

  // 5. Complete.
  onProgress({ progress: 98, bytesUploaded: fileSize, bytesTotal: fileSize, phase: "finalizing" });

  let completeResp, completeData;
  try {
    completeResp = await fetch(`${apiBaseUrl}/api/uploads/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        recordId,
        audioFileId,
        blobName,
        fileName,
        fileSize,
        contentType,
        durationSeconds,
        metadata,
      }),
      signal: abortSignal,
    });
    completeData = await completeResp.json().catch(() => ({}));
  } catch (err) {
    if (err?.name === "AbortError") {
      return { mode: "azure", success: false, cancelled: true, canRetry: false };
    }
    throw err; // bubble to outer retry — bytes are in Azure, retry is cheap (server dedups)
  }

  if (!completeResp.ok) {
    const status = completeResp.status;
    const error = completeData.error || `Complete failed: ${status}`;
    if (status === 402) {
      return {
        mode: "azure",
        success: false,
        status: 402,
        error,
        insufficientMinutes: true,
        canRetry: false,
      };
    }
    if (FATAL_HTTP_STATUSES.has(status)) {
      return { mode: "azure", success: false, status, error, canRetry: false };
    }
    const e = new Error(error);
    e.status = status;
    throw e;
  }

  onProgress({ progress: 100, bytesUploaded: fileSize, bytesTotal: fileSize, phase: "complete" });

  return {
    mode: "azure",
    success: !!completeData.success,
    audioFileId: completeData.audioFileId || audioFileId,
    meetingId: completeData.meetingId,
    transcriptionId:
      completeData.transcriptionId || completeData.audioFileId || audioFileId,
    message: completeData.message,
    gatewayFailed: !!completeData.gatewayFailed,
    deduplicated: !!completeData.deduplicated,
    canDelete: true,
    verified: true,
  };
}

/**
 * Best-effort blob cleanup for an upload the user cancelled.
 */
export async function abortDirectUpload({ apiBaseUrl, authToken, recordId, audioFileId }) {
  if (!audioFileId) return { success: true };
  try {
    await fetch(`${apiBaseUrl}/api/uploads/abort`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ recordId, audioFileId }),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Tell apart network-transient errors from terminal ones, used by the
 * outer retry wrapper in upload.js.
 */
export function isTransientUploadError(err) {
  if (!err) return false;
  if (err.cancelled) return false;
  // fetch() throws TypeError on offline/network failures
  if (err.name === "TypeError") return true;
  if (err.name === "AbortError") return false;
  if (typeof err.status === "number" && FATAL_HTTP_STATUSES.has(err.status)) return false;
  if (typeof err.status === "number" && err.status >= 500) return true;
  return true;
}

// Mark the platform sentinel for reference
export const __platformSupported = isCapacitor() || typeof window !== "undefined";
