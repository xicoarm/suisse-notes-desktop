'use strict';

const checkDiskSpace = require('check-disk-space').default;
const path = require('path');

// Disk space thresholds
const MIN_FREE_SPACE = 500 * 1024 * 1024; // 500MB - minimum to start recording
const CRITICAL_FREE_SPACE = 100 * 1024 * 1024; // 100MB - force stop recording

// check-disk-space shells out to wmic on Windows, which can hang indefinitely
// when WMI is in a degraded state or on Windows 11 builds where wmic is
// deprecated. Bound every call so the handler doesn't block the renderer.
const CHECK_DISK_SPACE_TIMEOUT_MS = 3000;

/**
 * Get available disk space for a given path.
 * Falls back to `MIN_FREE_SPACE + 1` (i.e. "assume enough") when the underlying
 * check times out or errors, so recording isn't blocked on a broken wmic.
 * The caller gets a `fallback` flag in the detailed result to reflect this.
 * @param {string} dirPath - Directory path to check
 * @returns {Promise<{free: number, fallback: boolean, error?: string, elapsedMs: number}>}
 */
async function getAvailableSpaceDetailed(dirPath) {
  const started = Date.now();
  let timeoutId;
  try {
    const resolvedPath = path.resolve(dirPath);
    const free = await Promise.race([
      checkDiskSpace(resolvedPath).then(r => r.free),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`check-disk-space timed out after ${CHECK_DISK_SPACE_TIMEOUT_MS}ms`)),
          CHECK_DISK_SPACE_TIMEOUT_MS
        );
      })
    ]);
    return { free, fallback: false, elapsedMs: Date.now() - started };
  } catch (error) {
    console.warn('Disk space check failed, using fallback:', error.message);
    return {
      free: MIN_FREE_SPACE + 1,
      fallback: true,
      error: error.message,
      elapsedMs: Date.now() - started
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Backwards-compatible wrapper returning just the `free` bytes.
 * Prefer `getAvailableSpaceDetailed` in new code so callers can see the
 * fallback flag + elapsed time for observability.
 * @param {string} dirPath
 * @returns {Promise<number>}
 */
async function getAvailableSpace(dirPath) {
  const { free } = await getAvailableSpaceDetailed(dirPath);
  return free;
}

/**
 * Check if there's enough disk space to start a new recording
 * @param {string} recordingsPath - Path to recordings directory
 * @returns {Promise<{canStart: boolean, freeSpace: number, freeSpaceMB: number, message: string, fallback: boolean, checkElapsedMs: number}>}
 */
async function canStartRecording(recordingsPath) {
  const { free, fallback, elapsedMs, error } = await getAvailableSpaceDetailed(recordingsPath);
  const freeSpaceMB = Math.round(free / (1024 * 1024));
  const canStart = free >= MIN_FREE_SPACE;

  let message = '';
  if (!canStart) {
    message = `Insufficient disk space. You need at least 500MB free to start recording. Currently available: ${freeSpaceMB}MB`;
  }

  return {
    canStart,
    freeSpace: free,
    freeSpaceMB,
    message,
    fallback,
    checkElapsedMs: elapsedMs,
    checkError: error
  };
}

/**
 * Check if disk space is critically low and recording should be force-stopped
 * @param {string} recordingsPath - Path to recordings directory
 * @returns {Promise<{shouldStop: boolean, freeSpace: number, freeSpaceMB: number}>}
 */
async function shouldForceStopRecording(recordingsPath) {
  const free = await getAvailableSpace(recordingsPath);
  const freeSpaceMB = Math.round(free / (1024 * 1024));
  const shouldStop = free < CRITICAL_FREE_SPACE;

  return {
    shouldStop,
    freeSpace: free,
    freeSpaceMB
  };
}

/**
 * Format bytes to human readable string
 * @param {number} bytes - Bytes to format
 * @returns {string} Human readable string (e.g., "1.5 GB")
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
  MIN_FREE_SPACE,
  CRITICAL_FREE_SPACE,
  CHECK_DISK_SPACE_TIMEOUT_MS,
  getAvailableSpace,
  getAvailableSpaceDetailed,
  canStartRecording,
  shouldForceStopRecording,
  formatBytes
};
