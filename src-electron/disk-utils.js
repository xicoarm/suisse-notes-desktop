'use strict';

const fs = require('fs');
const path = require('path');

// Disk space thresholds
const MIN_FREE_SPACE = 500 * 1024 * 1024; // 500MB - minimum to start recording
const CRITICAL_FREE_SPACE = 100 * 1024 * 1024; // 100MB - force stop recording

// Finalizing a recording (chunks -> session -> ffmpeg output) briefly holds two
// copies of the audio on disk, so it needs ~2x the recorded bytes plus headroom.
const FINALIZE_HEADROOM = 64 * 1024 * 1024; // 64MB

// fs.statfs is a syscall, not a shell-out (the previous check-disk-space
// library ran `wmic`, which no longer exists on current Windows 11 builds, so
// every check silently fell back to "assume enough space"). Keep a bound
// anyway: userData can live on a network share where statfs may stall.
const CHECK_DISK_SPACE_TIMEOUT_MS = 3000;

/**
 * statfs the closest existing ancestor of dirPath — the recordings directory
 * is created on first recording, so it may not exist when we check.
 * @param {string} dirPath
 * @returns {Promise<number>} free bytes available to this process
 */
async function statfsFreeBytes(dirPath) {
  let target = path.resolve(dirPath);
  for (let i = 0; i < 30 && !fs.existsSync(target); i++) {
    const parent = path.dirname(target);
    if (parent === target) break; // reached filesystem root
    target = parent;
  }
  const stat = await fs.promises.statfs(target);
  return Number(stat.bavail) * Number(stat.bsize);
}

/**
 * Get available disk space for a given path.
 * Falls back to `MIN_FREE_SPACE + 1` (i.e. "assume enough") when the underlying
 * check times out or errors, so recording isn't blocked on a broken check.
 * The caller gets a `fallback` flag in the detailed result to reflect this.
 * @param {string} dirPath - Directory path to check
 * @returns {Promise<{free: number, fallback: boolean, error?: string, elapsedMs: number}>}
 */
async function getAvailableSpaceDetailed(dirPath) {
  const started = Date.now();
  let timeoutId;
  try {
    const free = await Promise.race([
      statfsFreeBytes(dirPath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`statfs timed out after ${CHECK_DISK_SPACE_TIMEOUT_MS}ms`)),
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
 * Sum the on-disk bytes of a recording's source audio (chunks, sessions,
 * captured system audio).
 * @param {string} recordPath - The recording's directory
 * @returns {number} total source bytes
 */
function getRecordingSourceBytes(recordPath) {
  let total = 0;
  const addDir = (dir) => {
    try {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        try {
          const st = fs.statSync(path.join(dir, f));
          if (st.isFile()) total += st.size;
          else if (st.isDirectory()) addDir(path.join(dir, f));
        } catch (e) { /* file vanished mid-scan */ }
      }
    } catch (e) { /* unreadable dir */ }
  };
  addDir(path.join(recordPath, 'chunks'));
  addDir(path.join(recordPath, 'source-chunks'));
  addDir(path.join(recordPath, 'sessions'));
  try {
    const sysAudio = path.join(recordPath, 'system_audio.raw');
    if (fs.existsSync(sysAudio)) total += fs.statSync(sysAudio).size;
  } catch (e) { /* ignore */ }
  return total;
}

/**
 * Check there is enough free space to combine a recording's chunks into the
 * final file. Fails open when the disk can't be measured — the combine itself
 * classifies ENOSPC as a recoverable disk-full failure.
 * @param {string} recordPath - The recording's directory
 * @returns {Promise<{canFinalize: boolean, freeBytes: number, freeMB: number, neededBytes: number, neededMB: number, shortfallMB: number, sourceBytes: number, fallback: boolean}>}
 */
async function canFinalizeRecording(recordPath) {
  const sourceBytes = getRecordingSourceBytes(recordPath);
  const neededBytes = sourceBytes * 2 + FINALIZE_HEADROOM;
  const { free, fallback } = await getAvailableSpaceDetailed(recordPath);
  const canFinalize = fallback ? true : free >= neededBytes;
  return {
    canFinalize,
    freeBytes: free,
    freeMB: Math.round(free / (1024 * 1024)),
    neededBytes,
    neededMB: Math.ceil(neededBytes / (1024 * 1024)),
    shortfallMB: canFinalize ? 0 : Math.ceil((neededBytes - free) / (1024 * 1024)),
    sourceBytes,
    fallback
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
  FINALIZE_HEADROOM,
  CHECK_DISK_SPACE_TIMEOUT_MS,
  getAvailableSpace,
  getAvailableSpaceDetailed,
  canStartRecording,
  shouldForceStopRecording,
  getRecordingSourceBytes,
  canFinalizeRecording,
  formatBytes
};
