/**
 * Audio export / download — surfaced per History item.
 *
 * Scope (v1): exports a recording that still has a LOCAL file on the device
 * (recording.filePath present). Cloud-only recordings are out of scope here —
 * the caller gates the button on recording.filePath.
 *
 * Per-platform mechanism:
 *  - Electron (Windows/macOS): native Save-As dialog, user picks the location;
 *    the main process copies the file (no bytes through the renderer).
 *  - Capacitor (iOS/Android): native share sheet. The file is first copied into
 *    the Cache dir (a native FS copy — no JS-heap buffering, so multi-hour
 *    recordings can't OOM the WebView), then shared. Cache is covered by the
 *    app FileProvider's file_paths (cache-path), so Android can hand a content
 *    URI to the receiving app; on iOS the cache file:// URI shares directly.
 *
 * The file is exported in its original format (.webm/.m4a/.opus) — no transcode.
 * Note: WebM audio is poorly supported by many iOS share targets; "Save to
 * Files" still works, but in-app playback elsewhere may not. A future option is
 * a server-side transcoded (.m4a) download.
 */

import { isElectron, isCapacitor } from '../utils/platform';
import { captureMessage } from '../boot/sentry';

// Characters illegal in filenames on Windows / most filesystems.
const ILLEGAL_FILENAME_CHARS = '/\\?%*:|"<>';

/**
 * Reduce an arbitrary meeting title to a safe filename stem: drop control
 * characters and filesystem-illegal characters, collapse whitespace, cap the
 * length, and fall back to "recording" when nothing usable remains.
 * @param {string} raw
 * @returns {string}
 */
function sanitizeTitle(raw) {
  let out = '';
  for (const ch of String(raw)) {
    if (ch.charCodeAt(0) < 0x20) continue; // control characters
    if (ILLEGAL_FILENAME_CHARS.includes(ch)) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 80) || 'recording';
}

/**
 * Build a human-friendly, filesystem-safe export filename:
 *   "<title>_<YYYY-MM-DD>.<ext>"
 * Falls back to "recording" when there is no usable title, and to "webm" when
 * the source path has no recognizable extension.
 * @param {{ title?: string, createdAt?: string|number|Date, filePath?: string }} recording
 * @returns {string}
 */
export function buildExportFilename(recording) {
  const safeTitle = sanitizeTitle(recording && recording.title ? recording.title : '');

  let datePart = '';
  if (recording && recording.createdAt != null) {
    const d = new Date(recording.createdAt);
    if (!Number.isNaN(d.getTime())) {
      datePart = d.toISOString().slice(0, 10); // YYYY-MM-DD
    }
  }

  const fp = (recording && recording.filePath) || '';
  const extMatch = fp.match(/\.([a-zA-Z0-9]{1,5})(?:[?#].*)?$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'webm';

  const base = datePart ? `${safeTitle}_${datePart}` : safeTitle;
  return `${base}.${ext}`;
}

/**
 * Export the recording's local audio file.
 * @param {Object} recording - history item; must have a local filePath
 * @returns {Promise<{success: boolean, cancelled?: boolean, error?: string, savedPath?: string, shared?: boolean}>}
 */
export async function exportAudio(recording) {
  if (!recording || !recording.filePath) {
    return { success: false, error: 'no_local_file' };
  }

  const filename = buildExportFilename(recording);

  if (isElectron()) {
    // recording.filePath is an absolute path inside userData/recordings; the
    // main process re-validates that before copying.
    return window.electronAPI.dialog.saveFile(recording.filePath, filename);
  }

  if (isCapacitor()) {
    return shareViaSheet(recording.filePath, filename);
  }

  return { success: false, error: 'unsupported_platform' };
}

/**
 * Copy the local recording into the Cache dir under a friendly name, then open
 * the native share sheet. The copy is a native filesystem operation, so no file
 * bytes pass through JS memory.
 * @param {string} filePath - Capacitor-relative path under Directory.Documents
 * @param {string} filename - friendly destination filename
 */
async function shareViaSheet(filePath, filename) {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');

  captureMessage(`export: start filePath=${filePath} filename=${filename}`, 'info');

  // 1. Verify the source actually exists. A History item can carry a filePath
  //    whose underlying file was already cleaned up after upload — that would
  //    otherwise surface as an opaque copy failure.
  try {
    const st = await Filesystem.stat({ path: filePath, directory: Directory.Documents });
    captureMessage(`export: source ok size=${st?.size}`, 'info');
  } catch (e) {
    captureMessage(`export: source MISSING — ${e?.message}`, 'error');
    return { success: false, error: 'source_missing' };
  }

  // 2. Stage the file in Cache under the friendly name (native copy — no JS-heap
  //    buffering). Overwrite any stale same-named copy first. Do NOT delete it
  //    afterwards: the receiving app may still be reading the URI after the
  //    sheet dismisses; the OS reclaims Cache under pressure.
  try {
    await Filesystem.deleteFile({ path: filename, directory: Directory.Cache });
  } catch (_) {
    // no stale copy — fine
  }

  let cacheUri;
  try {
    const res = await Filesystem.copy({
      from: filePath,
      directory: Directory.Documents,
      to: filename,
      toDirectory: Directory.Cache,
    });
    cacheUri = res?.uri;
  } catch (e) {
    captureMessage(`export: copy FAILED — ${e?.name}: ${e?.message}`, 'error');
    return { success: false, error: `copy: ${e?.message || 'failed'}` };
  }

  // copy() returns the destination uri on success; fall back to getUri.
  if (!cacheUri) {
    try {
      const u = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
      cacheUri = u?.uri;
    } catch (e) {
      captureMessage(`export: getUri FAILED — ${e?.message}`, 'error');
      return { success: false, error: `getUri: ${e?.message || 'failed'}` };
    }
  }
  captureMessage(`export: staged uri=${cacheUri}`, 'info');

  // 3. Open the native share sheet.
  try {
    await Share.share({ title: filename, files: [cacheUri] });
    captureMessage('export: share completed', 'info');
    return { success: true, shared: true };
  } catch (e) {
    const msg = (e && e.message) || '';
    // Capacitor Share throws "Share canceled" when the user dismisses the sheet.
    if (/cancel/i.test(msg)) {
      captureMessage('export: share cancelled by user', 'info');
      return { success: false, cancelled: true };
    }
    captureMessage(`export: share FAILED — ${e?.name}: ${msg}`, 'error');
    return { success: false, error: `share: ${msg || 'failed'}` };
  }
}
