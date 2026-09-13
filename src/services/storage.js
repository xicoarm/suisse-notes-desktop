/**
 * Platform-aware storage service
 * Abstracts file system operations for Electron and Capacitor
 *
 * WHERE MOBILE RECORDINGS LIVE (2026-09 audit):
 *
 *  - iOS: Directory.Documents — the app's own sandboxed Documents folder.
 *    Private to the app, not exposed in the Files app.
 *
 *  - Android: Directory.External — the app-specific external files dir
 *    (<storage>/Android/data/<pkg>/files). App-private on Android 11+, no
 *    storage permission needed on ANY API level, removed on uninstall.
 *
 *    Until 3.9.36 Android used Directory.Documents, i.e. the PUBLIC shared
 *    Documents folder. On Android 11+ that folder is served through the
 *    MediaProvider FUSE layer: directory listings there are computed from the
 *    MediaStore database, not from the disk, and the tmp-write + rename +
 *    async media-scan dance for every 3-second chunk left chunk files on disk
 *    that never showed up in `readdir`. The stop-time chunk validation then
 *    saw "gaps" (Sentry CAPACITOR-N0: 65 events / 29 users, 100% Android, all
 *    vendors) and refused to combine — the meeting only reappeared later as a
 *    gappy "recovered" recording. Public Documents also meant the user's
 *    meeting audio was readable by file managers and survived an uninstall.
 *
 *    Recordings written by older versions stay readable: every read resolves
 *    the path in the primary directory first and falls back to the legacy
 *    public location. A best-effort one-time migration moves legacy data into
 *    the app-private directory at startup (see ensureAndroidStorageMigrated).
 */

import { isElectron, isCapacitor, isAndroid, PlatformConstants } from '../utils/platform';

// Capacitor filesystem imports (lazy loaded)
let Filesystem = null;
let Directory = null;

// Paths that are stored relative to the recordings root. Both live under the
// same base directory so one resolver covers them.
const RECORDINGS_ROOT = 'recordings';
const DEVICE_FILES_ROOT = 'suissenotes_recordings';

// Per-recording directory cache: which base directory (primary/legacy) holds
// `recordings/<id>` — avoids a stat round-trip on every 3-second chunk save.
const recordingDirCache = new Map();

/**
 * Initialize Capacitor filesystem module if on mobile
 */
const initCapacitorFilesystem = async () => {
  if (isCapacitor() && !Filesystem) {
    const module = await import('@capacitor/filesystem');
    Filesystem = module.Filesystem;
    Directory = module.Directory;
  }
};

/** Primary base directory for the current platform (see header). */
const primaryDirectory = () => (isAndroid() ? Directory.External : Directory.Documents);

/** Legacy base directory whose contents must stay readable (Android only). */
const legacyDirectory = () => (isAndroid() ? Directory.Documents : null);

/**
 * Human-readable name of the recordings base directory (diagnostics/tests).
 * @returns {Promise<string>}
 */
export const getRecordingsDirectory = async () => {
  if (!isCapacitor()) return 'n/a';
  await initCapacitorFilesystem();
  return primaryDirectory();
};

/**
 * stat() that returns null instead of throwing.
 */
const statIn = async (directory, path) => {
  try {
    return await Filesystem.stat({ path, directory });
  } catch {
    return null;
  }
};

/**
 * Resolve which base directory holds `path`. Primary wins; the legacy public
 * directory is consulted only on Android and only when the primary has no
 * such entry. Unknown paths resolve to the primary directory (for writes).
 * @param {string} path
 * @returns {Promise<{ directory: string, found: boolean, stat: object|null }>}
 */
export const resolvePath = async (path) => {
  await initCapacitorFilesystem();
  const primary = primaryDirectory();
  const primaryStat = await statIn(primary, path);
  if (primaryStat) return { directory: primary, found: true, stat: primaryStat };
  const legacy = legacyDirectory();
  if (legacy) {
    const legacyStat = await statIn(legacy, path);
    if (legacyStat) return { directory: legacy, found: true, stat: legacyStat };
  }
  return { directory: primary, found: false, stat: null };
};

/**
 * Base directory for a recording's folder, cached per recordId.
 */
const directoryForRecording = async (recordId) => {
  const cached = recordingDirCache.get(recordId);
  if (cached) return cached;
  const resolved = await resolvePath(`${RECORDINGS_ROOT}/${recordId}`);
  if (resolved.found) recordingDirCache.set(recordId, resolved.directory);
  return resolved.directory;
};

/**
 * Directory for an arbitrary path: recording-scoped paths use the per-record
 * cache; everything else is resolved directly.
 */
const directoryForPath = async (path) => {
  const match = /^recordings\/([^/]+)(?:\/|$)/.exec(path || '');
  if (match) return directoryForRecording(match[1]);
  return (await resolvePath(path)).directory;
};

/**
 * Verify a write completed successfully by checking the file exists and has expected minimum size.
 * Serves as a durability check since Capacitor doesn't expose fsync().
 * @param {string} directory - Base directory
 * @param {string} path - File path to verify
 * @param {number} expectedMinSize - Minimum expected file size in bytes (default 1)
 * @returns {Promise<void>} Throws if verification fails
 */
const verifyWrite = async (directory, path, expectedMinSize = 1) => {
  const stat = await Filesystem.stat({ path, directory });
  if (!stat || stat.size < expectedMinSize) {
    throw new Error(
      `Write verification failed for ${path}: expected >=${expectedMinSize} bytes, got ${stat?.size || 0}`
    );
  }
};

/**
 * Convert ArrayBuffer to Base64 string (for Capacitor)
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked String.fromCharCode keeps the call-stack/argument list bounded and
  // is ~10x faster than per-byte concatenation on multi-MB device files.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength)));
  }
  return btoa(binary);
};

/**
 * Convert Base64 string to ArrayBuffer
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
const base64ToArrayBuffer = (base64) => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
};

/**
 * Convert Uint8Array or number array to Base64
 * @param {Uint8Array | number[]} data
 * @returns {string}
 */
const dataToBase64 = (data) => {
  const uint8Array = data instanceof Uint8Array ? data : new Uint8Array(data);
  return arrayBufferToBase64(uint8Array.buffer);
};

/**
 * Save a chunk file
 * @param {string} recordId - Recording session ID
 * @param {Uint8Array | number[]} data - Chunk data
 * @param {number} chunkIndex - Chunk index number
 * @param {string} extension - File extension (e.g., '.webm', '.m4a')
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
export const saveChunk = async (recordId, data, chunkIndex, extension = '.webm') => {
  if (isElectron()) {
    // Electron: use preload API
    return window.electronAPI.recording.saveChunk(recordId, Array.from(data), chunkIndex, extension);
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    try {
      const directory = await directoryForRecording(recordId);
      const fileName = `chunk_${String(chunkIndex).padStart(6, '0')}${extension}`;
      const path = `${RECORDINGS_ROOT}/${recordId}/chunks/${fileName}`;
      // MOBR-7: Capacitor's writeFile is NOT atomic and has no fsync, so a
      // process kill (OS OOM, force-quit, battery death) mid-write would leave
      // a truncated chunk_N file that the native combiner reads as corrupt
      // audio. Write to a temp name the combiner + sequence validator never
      // scan (they require a leading "chunk_"), verify its size, then
      // atomically rename into place — so the final chunk_N is either absent or
      // complete. Mirrors the durable tmp+rename pattern used by saveMetadata.
      const tmpName = `.tmp_${String(chunkIndex).padStart(6, '0')}${extension}`;
      const tmpPath = `${RECORDINGS_ROOT}/${recordId}/chunks/${tmpName}`;

      const base64Data = dataToBase64(data);
      await Filesystem.writeFile({
        path: tmpPath,
        data: base64Data,
        directory,
        recursive: true
      });

      // Verify the temp write reached disk before promoting it — fsync substitute.
      await verifyWrite(directory, tmpPath, data.length || 1);

      // Atomic promote: rename is atomic within the same filesystem on both
      // Android (File.renameTo) and iOS (FileManager.moveItem).
      await Filesystem.rename({
        from: tmpPath,
        to: path,
        directory,
        toDirectory: directory
      });

      return { success: true, path };
    } catch (error) {
      console.error('Error saving chunk on Capacitor:', error);
      // Check if this is a disk-full situation (Capacitor doesn't return ENOSPC codes)
      try {
        const space = await getFreeDiskSpace();
        if (space.success && space.freeMB < 50) {
          return { success: false, error: 'Disk full', diskFull: true };
        }
      } catch (e) { /* ignore space check failure */ }
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Read a file as ArrayBuffer
 * @param {string} path - File path
 * @returns {Promise<{success: boolean, data?: ArrayBuffer, error?: string}>}
 */
export const readFile = async (path) => {
  if (isElectron()) {
    // Electron: use preload API
    const result = await window.electronAPI.file.read(path);
    if (result.success && result.data) {
      return { success: true, data: new Uint8Array(result.data).buffer };
    }
    return result;
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    try {
      const directory = await directoryForPath(path);
      const contents = await Filesystem.readFile({ path, directory });

      const data = base64ToArrayBuffer(contents.data);
      return { success: true, data };
    } catch (error) {
      console.error('Error reading file on Capacitor:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Stat a file (size, mtime) without reading it.
 * @param {string} path
 * @returns {Promise<{success: boolean, size?: number, directory?: string, error?: string}>}
 */
export const statFile = async (path) => {
  if (isElectron()) {
    return { success: false, error: 'Not supported on Electron' };
  }
  if (isCapacitor()) {
    const resolved = await resolvePath(path);
    if (!resolved.found) return { success: false, error: 'File does not exist' };
    return { success: true, size: resolved.stat?.size, mtime: resolved.stat?.mtime, directory: resolved.directory };
  }
  return { success: false, error: 'Unsupported platform' };
};

/**
 * Write an ArrayBuffer to a file (primary directory)
 * @param {string} path - File path
 * @param {ArrayBuffer} data - Data to write
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const writeFile = async (path, data) => {
  if (isElectron()) {
    return window.electronAPI.file.writeBinary(path, Array.from(new Uint8Array(data)));
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    try {
      const directory = primaryDirectory();
      await Filesystem.writeFile({
        path,
        data: arrayBufferToBase64(data),
        directory,
        recursive: true
      });

      // Verify write reached disk — fsync substitute
      await verifyWrite(directory, path, data.byteLength || 1);

      return { success: true };
    } catch (error) {
      console.error('Error writing file on Capacitor:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Delete a file
 * @param {string} path - File path
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const deleteFile = async (path) => {
  if (isElectron()) {
    return window.electronAPI.file.delete(path);
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    try {
      const directory = await directoryForPath(path);
      await Filesystem.deleteFile({ path, directory });
      return { success: true };
    } catch (error) {
      console.error('Error deleting file on Capacitor:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Delete a directory recursively (in every base directory that holds it)
 * @param {string} path - Directory path
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const deleteDirectory = async (path) => {
  if (isElectron()) {
    return window.electronAPI.file.deleteDirectory(path);
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    const candidates = [primaryDirectory(), legacyDirectory()].filter(Boolean);
    let deleted = 0;
    let lastError = null;
    for (const directory of candidates) {
      if (!(await statIn(directory, path))) continue;
      try {
        await Filesystem.rmdir({ path, directory, recursive: true });
        deleted++;
      } catch (error) {
        console.error('Error deleting directory on Capacitor:', error);
        lastError = error;
      }
    }
    const match = /^recordings\/([^/]+)$/.exec(path || '');
    if (match) recordingDirCache.delete(match[1]);
    if (lastError && deleted === 0) return { success: false, error: lastError.message };
    return { success: true };
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * List files in a directory. The recordings root and the device-files root
 * return the union of the primary and legacy locations (Android).
 * A missing directory yields an empty list (not an error) — it is the normal
 * state of a fresh install.
 * @param {string} path - Directory path
 * @returns {Promise<{success: boolean, files?: string[], error?: string}>}
 */
export const listFiles = async (path) => {
  if (isElectron()) {
    return window.electronAPI.file.list(path);
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    const isRoot = path === RECORDINGS_ROOT || path === DEVICE_FILES_ROOT;
    const candidates = isRoot
      ? [primaryDirectory(), legacyDirectory()].filter(Boolean)
      : [await directoryForPath(path)];

    const names = [];
    const seen = new Set();
    let anyFound = false;
    let lastError = null;
    for (const directory of candidates) {
      if (!(await statIn(directory, path))) continue; // absent here — not an error
      anyFound = true;
      try {
        const result = await Filesystem.readdir({ path, directory });
        for (const f of result.files) {
          if (!seen.has(f.name)) {
            seen.add(f.name);
            names.push(f.name);
          }
        }
      } catch (error) {
        console.error('Error listing files on Capacitor:', error);
        lastError = error;
      }
    }
    if (lastError && !anyFound) return { success: false, error: lastError.message };
    if (lastError && names.length === 0) return { success: false, error: lastError.message };
    return { success: true, files: names };
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Check if a file or directory exists (any base directory)
 * @param {string} path - File or directory path
 * @returns {Promise<boolean>}
 */
export const exists = async (path) => {
  if (isElectron()) {
    const result = await window.electronAPI.file.exists(path);
    return result.exists;
  }

  if (isCapacitor()) {
    const resolved = await resolvePath(path);
    return resolved.found;
  }

  return false;
};

/**
 * Create a directory (primary directory — new data always goes there)
 * @param {string} path - Directory path
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const createDirectory = async (path) => {
  if (isElectron()) {
    return window.electronAPI.file.createDirectory(path);
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    try {
      const directory = primaryDirectory();
      await Filesystem.mkdir({ path, directory, recursive: true });
      const match = /^recordings\/([^/]+)(?:\/|$)/.exec(path || '');
      if (match) recordingDirCache.set(match[1], directory);
      return { success: true };
    } catch (error) {
      // Directory might already exist
      if (error.message?.includes('exists')) {
        return { success: true };
      }
      console.error('Error creating directory on Capacitor:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Copy a stored file into the Cache directory under a friendly name (for the
 * native share sheet). Returns the destination URI.
 * @param {string} path - stored file path (relative)
 * @param {string} filename - destination filename in Cache
 * @returns {Promise<{success: boolean, uri?: string, error?: string}>}
 */
export const copyToCache = async (path, filename) => {
  if (!isCapacitor()) return { success: false, error: 'Unsupported platform' };
  await initCapacitorFilesystem();
  try {
    const directory = await directoryForPath(path);
    try {
      await Filesystem.deleteFile({ path: filename, directory: Directory.Cache });
    } catch (_) {
      // no stale copy — fine
    }
    const res = await Filesystem.copy({ from: path, directory, to: filename, toDirectory: Directory.Cache });
    const uri = res?.uri || (await Filesystem.getUri({ path: filename, directory: Directory.Cache })).uri;
    return { success: true, uri };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Get free disk space.
 *
 * Capacitor: @capacitor/filesystem has NO getFreeDiskSpace — the old code
 * called it anyway, logged "not implemented" every 30 seconds during every
 * recording and reported the space as unknown, so the pre-recording check and
 * the disk-full emergency stop never worked on any phone. @capacitor/device
 * (already a dependency) reports the real figure: `realDiskFree` is Apple's
 * volumeAvailableCapacityForImportantUsage / Android's StatFs on the data
 * partition. Only a positive number is trusted; anything else is "unknown"
 * (callers treat unknown as warn-only, never block).
 * @returns {Promise<{success: boolean, freeBytes?: number, freeMB?: number, error?: string}>}
 */
export const getFreeDiskSpace = async () => {
  if (isElectron()) {
    try {
      const result = await window.electronAPI.recording.checkDiskSpace();
      // The handler returns { canStart, freeSpace, freeSpaceMB, message, fallback }
      // Convert to the expected format. A fallback reading is a made-up number
      // ("assume enough"), not a measurement — report it as unknown instead of
      // letting the storage monitor believe it.
      if (result && !result.fallback && (result.canStart !== undefined || result.freeSpaceMB !== undefined)) {
        return {
          success: true,
          freeBytes: result.freeSpace || (result.freeSpaceMB * 1024 * 1024),
          freeMB: result.freeSpaceMB || Math.floor((result.freeSpace || 0) / (1024 * 1024))
        };
      }
      return { success: false, error: result?.checkError || 'Disk space unknown' };
    } catch (error) {
      console.error('Error checking disk space on Electron:', error);
      // Report the failure honestly: pretending 10GB free here kept the
      // storage monitor permanently "ok" on machines where the check broke,
      // until the disk actually filled mid-recording. Callers treat
      // success:false as "unknown" (warn-only, never block or force-stop).
      return { success: false, error: error.message };
    }
  }

  if (isCapacitor()) {
    try {
      const { Device } = await import('@capacitor/device');
      const info = await Device.getInfo();
      const candidates = [info?.realDiskFree, info?.diskFree];
      const freeBytes = candidates.find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
      if (freeBytes === undefined) {
        return { success: false, error: 'Disk space unknown' };
      }
      return {
        success: true,
        freeBytes,
        freeMB: Math.floor(freeBytes / (1024 * 1024))
      };
    } catch (error) {
      console.warn('Could not read disk space on Capacitor:', error?.message || error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Check if there's enough storage to start/continue recording
 * @returns {Promise<{canRecord: boolean, status: 'ok' | 'low' | 'critical', freeMB: number}>}
 */
export const checkStorageForRecording = async () => {
  const result = await getFreeDiskSpace();

  if (!result.success) {
    // If we can't check, assume it's okay but warn
    console.warn('Could not check disk space:', result.error);
    return { canRecord: true, status: 'ok', freeMB: -1 };
  }

  const freeMB = result.freeMB;

  if (freeMB < PlatformConstants.CRITICAL_STORAGE_MB) {
    return { canRecord: false, status: 'critical', freeMB };
  }

  if (freeMB < PlatformConstants.MIN_STORAGE_MB) {
    return { canRecord: true, status: 'low', freeMB };
  }

  return { canRecord: true, status: 'ok', freeMB };
};

/**
 * Get the recordings directory path
 * @returns {Promise<string>}
 */
export const getRecordingsPath = async () => {
  if (isElectron()) {
    const result = await window.electronAPI.system.getRecordingsPath();
    return result.path;
  }

  if (isCapacitor()) {
    // On mobile, recordings are stored in the app's documents directory
    return RECORDINGS_ROOT;
  }

  return '';
};

/**
 * Save recording metadata (JSON)
 * @param {string} recordId - Recording session ID
 * @param {object} metadata - Metadata object
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const saveMetadata = async (recordId, metadata) => {
  if (isElectron()) {
    return window.electronAPI.recording.saveMetadata(recordId, metadata);
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    const basePath = `${RECORDINGS_ROOT}/${recordId}`;
    const primaryPath = `${basePath}/metadata.json`;
    const tmpPath = `${basePath}/metadata.json.tmp`;
    const bakPath = `${basePath}/metadata.json.bak`;
    const jsonData = JSON.stringify(metadata, null, 2);

    try {
      const directory = await directoryForRecording(recordId);

      // Step 1: Write to tmp file
      await Filesystem.writeFile({
        path: tmpPath,
        data: jsonData,
        directory,
        recursive: true,
        encoding: 'utf8'
      });

      // Step 2: Verify tmp file
      await verifyWrite(directory, tmpPath, jsonData.length);

      // Step 3: Backup current metadata (best-effort — missing file is fine)
      try {
        await Filesystem.copy({
          from: primaryPath,
          to: bakPath,
          directory,
          toDirectory: directory
        });
      } catch {
        // No existing metadata to back up — expected on first save
      }

      // Step 4: Atomic rename tmp → primary
      await Filesystem.rename({
        from: tmpPath,
        to: primaryPath,
        directory,
        toDirectory: directory
      });

      return { success: true };
    } catch (error) {
      console.error('Error saving metadata on Capacitor:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Load recording metadata
 * @param {string} recordId - Recording session ID
 * @returns {Promise<{success: boolean, metadata?: object, error?: string}>}
 */
export const loadMetadata = async (recordId) => {
  if (isElectron()) {
    return window.electronAPI.recording.loadMetadata(recordId);
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    const basePath = `${RECORDINGS_ROOT}/${recordId}`;
    const primaryPath = `${basePath}/metadata.json`;
    const bakPath = `${basePath}/metadata.json.bak`;
    const directory = await directoryForRecording(recordId);

    // Try primary file first, fall back to backup on corruption
    for (const path of [primaryPath, bakPath]) {
      try {
        const contents = await Filesystem.readFile({
          path,
          directory,
          encoding: 'utf8'
        });
        const metadata = JSON.parse(contents.data);
        if (path === bakPath) {
          console.warn(`Primary metadata corrupt for ${recordId}, recovered from backup`);
        }
        return { success: true, metadata };
      } catch (error) {
        if (path === primaryPath) {
          console.warn(`Failed to load primary metadata for ${recordId}, trying backup:`, error.message);
        } else {
          console.error('Error loading metadata on Capacitor (both primary and backup failed):', error);
        }
      }
    }

    return { success: false, error: 'Both primary and backup metadata are missing or corrupt' };
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Get the file URI for upload (platform-specific)
 * @param {string} path - Relative file path
 * @returns {Promise<{success: boolean, uri?: string, error?: string}>}
 */
export const getFileUri = async (path) => {
  if (isElectron()) {
    // On Electron, return the full path
    const recordingsPath = await getRecordingsPath();
    return { success: true, uri: `${recordingsPath}/${path}` };
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    try {
      const directory = await directoryForPath(path);
      const result = await Filesystem.getUri({ path, directory });
      return { success: true, uri: result.uri };
    } catch (error) {
      console.error('Error getting file URI on Capacitor:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

// ---------------------------------------------------------------------------
// Android: one-time migration of legacy data from the public Documents folder
// into the app-private external files directory.
// ---------------------------------------------------------------------------

let migrationPromise = null;

/**
 * Move one legacy entry (a recording folder or a device file) into the
 * primary directory. Tries an atomic rename first (both locations are on the
 * same emulated volume); falls back to a copy + verified delete per file.
 * Never deletes a source that was not confirmed copied.
 * @returns {Promise<'moved'|'skipped'|'failed'>}
 */
const migrateLegacyEntry = async (relativePath, isDirectory) => {
  const from = legacyDirectory();
  const to = primaryDirectory();

  if (await statIn(to, relativePath)) {
    // Already present in the new location (partial earlier run). Leave the
    // legacy copy alone if it is a directory (it may hold chunks the primary
    // copy lacks); for a plain file, the primary copy wins.
    if (!isDirectory) {
      try { await Filesystem.deleteFile({ path: relativePath, directory: from }); } catch { /* ignore */ }
      return 'moved';
    }
    return 'skipped';
  }

  // 1. Atomic rename (fast, no data copy).
  try {
    const parent = relativePath.split('/').slice(0, -1).join('/');
    if (parent) {
      try { await Filesystem.mkdir({ path: parent, directory: to, recursive: true }); } catch { /* exists */ }
    }
    await Filesystem.rename({ from: relativePath, to: relativePath, directory: from, toDirectory: to });
    if (await statIn(to, relativePath)) return 'moved';
  } catch (e) {
    console.warn(`Storage migration: rename failed for ${relativePath} (${e?.message}) — trying copy`);
  }

  // 2. Copy + verified delete.
  try {
    if (isDirectory) {
      await Filesystem.copy({ from: relativePath, to: relativePath, directory: from, toDirectory: to });
    } else {
      const parent = relativePath.split('/').slice(0, -1).join('/');
      if (parent) {
        try { await Filesystem.mkdir({ path: parent, directory: to, recursive: true }); } catch { /* exists */ }
      }
      await Filesystem.copy({ from: relativePath, to: relativePath, directory: from, toDirectory: to });
    }
    const copied = await statIn(to, relativePath);
    if (!copied) return 'failed';
    if (!isDirectory) {
      const original = await statIn(from, relativePath);
      if (original && copied.size !== original.size) return 'failed';
      try { await Filesystem.deleteFile({ path: relativePath, directory: from }); } catch { /* keep the copy */ }
    } else {
      try { await Filesystem.rmdir({ path: relativePath, directory: from, recursive: true }); } catch { /* keep the copy */ }
    }
    return 'moved';
  } catch (e) {
    console.warn(`Storage migration: copy failed for ${relativePath}: ${e?.message}`);
    return 'failed';
  }
};

/**
 * Best-effort, idempotent migration of legacy Android data. Safe to call on
 * every launch (cheap when there is nothing left to move). Memoized so
 * concurrent callers (startup recovery, foreground recovery) share one run.
 * @returns {Promise<{moved: number, failed: number, skipped: number}>}
 */
export const ensureAndroidStorageMigrated = () => {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    const result = { moved: 0, failed: 0, skipped: 0 };
    if (!isCapacitor() || !isAndroid()) return result;
    try {
      await initCapacitorFilesystem();
      const from = legacyDirectory();
      for (const root of [RECORDINGS_ROOT, DEVICE_FILES_ROOT]) {
        if (!(await statIn(from, root))) continue;
        let entries = [];
        try {
          entries = (await Filesystem.readdir({ path: root, directory: from })).files || [];
        } catch (e) {
          console.warn(`Storage migration: cannot list legacy ${root}: ${e?.message}`);
          continue;
        }
        for (const entry of entries) {
          const outcome = await migrateLegacyEntry(`${root}/${entry.name}`, entry.type === 'directory');
          result[outcome === 'moved' ? 'moved' : outcome === 'skipped' ? 'skipped' : 'failed']++;
          if (root === RECORDINGS_ROOT) recordingDirCache.delete(entry.name);
        }
      }
      if (result.moved || result.failed) {
        console.log(`Storage migration: moved=${result.moved} failed=${result.failed} skipped=${result.skipped}`);
      }
    } catch (e) {
      console.warn('Storage migration failed:', e?.message || e);
    } finally {
      // Allow a later run to pick up anything that failed this time.
      if (result.failed > 0) migrationPromise = null;
    }
    return result;
  })();
  return migrationPromise;
};

/** Test hook — clear internal caches between test cases. */
export const __resetStorageCaches = () => {
  recordingDirCache.clear();
  migrationPromise = null;
};
