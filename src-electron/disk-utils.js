'use strict';

const checkDiskSpace = require('check-disk-space').default;
const path = require('path');

// Disk space thresholds
const MIN_FREE_SPACE = 500 * 1024 * 1024; // 500MB - minimum to start recording
const CRITICAL_FREE_SPACE = 100 * 1024 * 1024; // 100MB - force stop recording

/**
 * Get available disk space for a given path
 * @param {string} dirPath - Directory path to check
 * @returns {Promise<number>} Free space in bytes
 */
async function getAvailableSpace(dirPath) {
  try {
    // On Windows, we need to get the drive letter
    const resolvedPath = path.resolve(dirPath);
    const { free } = await checkDiskSpace(resolvedPath);
    return free;
  } catch (error) {
    console.error('Error checking disk space:', error);
    // Return a safe value that allows recording if we can't check
    return MIN_FREE_SPACE + 1;
  }
}

/**
 * Check if there's enough disk space to start a new recording
 * @param {string} recordingsPath - Path to recordings directory
 * @returns {Promise<{canStart: boolean, freeSpace: number, freeSpaceMB: number, message: string}>}
 */
async function canStartRecording(recordingsPath) {
  const free = await getAvailableSpace(recordingsPath);
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
    message
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
  getAvailableSpace,
  canStartRecording,
  shouldForceStopRecording,
  formatBytes
};
