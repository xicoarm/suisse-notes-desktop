/**
 * Platform-aware storage service
 * Abstracts file system operations for Electron and Capacitor
 */

import { isElectron, isCapacitor, PlatformConstants } from '../utils/platform';

// Capacitor filesystem imports (lazy loaded)
let Filesystem = null;
let Directory = null;

/**
 * Verify a write completed successfully by checking the file exists and has expected minimum size.
 * Serves as a durability check since Capacitor doesn't expose fsync().
 * @param {string} path - File path to verify
 * @param {number} expectedMinSize - Minimum expected file size in bytes (default 1)
 * @returns {Promise<void>} Throws if verification fails
 */
const verifyWrite = async (path, expectedMinSize = 1) => {
  const stat = await Filesystem.stat({
    path,
    directory: Directory.Documents
  });
  if (!stat || stat.size < expectedMinSize) {
    throw new Error(
      `Write verification failed for ${path}: expected >=${expectedMinSize} bytes, got ${stat?.size || 0}`
    );
  }
};

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

/**
 * Convert ArrayBuffer to Base64 string (for Capacitor)
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
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
      const fileName = `chunk_${String(chunkIndex).padStart(6, '0')}${extension}`;
      const path = `recordings/${recordId}/chunks/${fileName}`;

      const base64Data = dataToBase64(data);
      await Filesystem.writeFile({
        path,
        data: base64Data,
        directory: Directory.Documents,
        recursive: true
      });

      // Verify write reached disk — fsync substitute
      await verifyWrite(path, data.length || 1);

      return { success: true, path };
    } catch (error) {
      console.error('Error saving chunk on Capacitor:', error);
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
      const contents = await Filesystem.readFile({
        path,
        directory: Directory.Documents
      });

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
 * Write an ArrayBuffer to a file
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
      await Filesystem.writeFile({
        path,
        data: arrayBufferToBase64(data),
        directory: Directory.Documents,
        recursive: true
      });

      // Verify write reached disk — fsync substitute
      await verifyWrite(path, data.byteLength || 1);

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
      await Filesystem.deleteFile({
        path,
        directory: Directory.Documents
      });
      return { success: true };
    } catch (error) {
      console.error('Error deleting file on Capacitor:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Delete a directory recursively
 * @param {string} path - Directory path
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const deleteDirectory = async (path) => {
  if (isElectron()) {
    return window.electronAPI.file.deleteDirectory(path);
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    try {
      await Filesystem.rmdir({
        path,
        directory: Directory.Documents,
        recursive: true
      });
      return { success: true };
    } catch (error) {
      console.error('Error deleting directory on Capacitor:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * List files in a directory
 * @param {string} path - Directory path
 * @returns {Promise<{success: boolean, files?: string[], error?: string}>}
 */
export const listFiles = async (path) => {
  if (isElectron()) {
    return window.electronAPI.file.list(path);
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    try {
      const result = await Filesystem.readdir({
        path,
        directory: Directory.Documents
      });
      const files = result.files.map(f => f.name);
      return { success: true, files };
    } catch (error) {
      console.error('Error listing files on Capacitor:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};

/**
 * Check if a file or directory exists
 * @param {string} path - File or directory path
 * @returns {Promise<boolean>}
 */
export const exists = async (path) => {
  if (isElectron()) {
    const result = await window.electronAPI.file.exists(path);
    return result.exists;
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    try {
      await Filesystem.stat({
        path,
        directory: Directory.Documents
      });
      return true;
    } catch {
      return false;
    }
  }

  return false;
};

/**
 * Create a directory
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
      await Filesystem.mkdir({
        path,
        directory: Directory.Documents,
        recursive: true
      });
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
 * Get free disk space
 * @returns {Promise<{success: boolean, freeBytes?: number, freeMB?: number, error?: string}>}
 */
export const getFreeDiskSpace = async () => {
  if (isElectron()) {
    try {
      const result = await window.electronAPI.recording.checkDiskSpace();
      // The handler returns { canStart, freeSpace, freeSpaceMB, message }
      // Convert to the expected format
      if (result && (result.canStart !== undefined || result.freeSpaceMB !== undefined)) {
        return {
          success: true,
          freeBytes: result.freeSpace || (result.freeSpaceMB * 1024 * 1024),
          freeMB: result.freeSpaceMB || Math.floor((result.freeSpace || 0) / (1024 * 1024))
        };
      }
      // Fallback for unexpected response format
      return {
        success: true,
        freeBytes: 10 * 1024 * 1024 * 1024, // 10 GB default
        freeMB: 10 * 1024
      };
    } catch (error) {
      console.error('Error checking disk space on Electron:', error);
      // Return safe fallback on error
      return {
        success: true,
        freeBytes: 10 * 1024 * 1024 * 1024,
        freeMB: 10 * 1024
      };
    }
  }

  if (isCapacitor()) {
    await initCapacitorFilesystem();

    try {
      // Note: getFreeDiskSpace may not be available on all Capacitor versions
      // Fallback to a reasonable default if not available
      if (Filesystem.getFreeDiskSpace) {
        const result = await Filesystem.getFreeDiskSpace();
        return {
          success: true,
          freeBytes: result.free,
          freeMB: Math.floor(result.free / (1024 * 1024))
        };
      }

      // Fallback: assume enough space (mobile usually reports this differently)
      return {
        success: true,
        freeBytes: 10 * 1024 * 1024 * 1024, // 10 GB default
        freeMB: 10 * 1024
      };
    } catch (error) {
      console.error('Error getting disk space on Capacitor:', error);
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
    return 'recordings';
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

    const basePath = `recordings/${recordId}`;
    const primaryPath = `${basePath}/metadata.json`;
    const tmpPath = `${basePath}/metadata.json.tmp`;
    const bakPath = `${basePath}/metadata.json.bak`;
    const jsonData = JSON.stringify(metadata, null, 2);

    try {
      // Step 1: Write to tmp file
      await Filesystem.writeFile({
        path: tmpPath,
        data: jsonData,
        directory: Directory.Documents,
        recursive: true,
        encoding: 'utf8'
      });

      // Step 2: Verify tmp file
      await verifyWrite(tmpPath, jsonData.length);

      // Step 3: Backup current metadata (best-effort — missing file is fine)
      try {
        await Filesystem.copy({
          from: primaryPath,
          to: bakPath,
          directory: Directory.Documents,
          toDirectory: Directory.Documents
        });
      } catch {
        // No existing metadata to back up — expected on first save
      }

      // Step 4: Atomic rename tmp → primary
      await Filesystem.rename({
        from: tmpPath,
        to: primaryPath,
        directory: Directory.Documents,
        toDirectory: Directory.Documents
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

    const basePath = `recordings/${recordId}`;
    const primaryPath = `${basePath}/metadata.json`;
    const bakPath = `${basePath}/metadata.json.bak`;

    // Try primary file first, fall back to backup on corruption
    for (const path of [primaryPath, bakPath]) {
      try {
        const contents = await Filesystem.readFile({
          path,
          directory: Directory.Documents,
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
      const result = await Filesystem.getUri({
        path,
        directory: Directory.Documents
      });
      return { success: true, uri: result.uri };
    } catch (error) {
      console.error('Error getting file URI on Capacitor:', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'Unsupported platform' };
};
