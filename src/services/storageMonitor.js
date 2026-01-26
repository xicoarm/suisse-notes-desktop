/**
 * Runtime storage monitoring service
 * Monitors disk space during recording and triggers warnings/stops when storage is low
 * Addresses vulnerability V1: No Storage Monitoring During Recording
 */

import { ref, readonly } from 'vue';
import { getFreeDiskSpace } from './storage';
import { PlatformConstants } from '../utils/platform';

// Storage status state
const currentStatus = ref('ok'); // 'ok' | 'low' | 'critical'
const currentFreeMB = ref(-1);
const isMonitoring = ref(false);

// Monitor interval handle
let monitorInterval = null;

// Callbacks
let onLowStorage = null;
let onCriticalStorage = null;
let onStorageRecovered = null;

// Check interval (30 seconds)
const CHECK_INTERVAL_MS = 30000;

/**
 * Check storage and update status
 * @returns {Promise<{status: string, freeMB: number, action: string | null}>}
 */
const checkStorage = async () => {
  const result = await getFreeDiskSpace();

  if (!result.success) {
    console.warn('Storage monitor: Could not check disk space:', result.error);
    return { status: 'unknown', freeMB: -1, action: null };
  }

  const freeMB = result.freeMB;
  const previousStatus = currentStatus.value;
  currentFreeMB.value = freeMB;

  let action = null;

  if (freeMB < PlatformConstants.CRITICAL_STORAGE_MB) {
    currentStatus.value = 'critical';
    action = 'force_stop';
  } else if (freeMB < PlatformConstants.MIN_STORAGE_MB) {
    currentStatus.value = 'low';
    action = 'warn';
  } else {
    currentStatus.value = 'ok';
    action = null;
  }

  // Trigger callbacks on status change
  if (currentStatus.value !== previousStatus) {
    if (currentStatus.value === 'critical' && onCriticalStorage) {
      console.warn(`Storage monitor: CRITICAL - Only ${freeMB}MB remaining`);
      onCriticalStorage(freeMB);
    } else if (currentStatus.value === 'low' && onLowStorage) {
      console.warn(`Storage monitor: LOW - Only ${freeMB}MB remaining`);
      onLowStorage(freeMB);
    } else if (currentStatus.value === 'ok' && previousStatus !== 'ok' && onStorageRecovered) {
      console.log(`Storage monitor: Recovered - ${freeMB}MB available`);
      onStorageRecovered(freeMB);
    }
  }

  return { status: currentStatus.value, freeMB, action };
};

/**
 * Start monitoring storage during recording
 * @param {Object} callbacks - Callback functions
 * @param {Function} callbacks.onLow - Called when storage is low (warn threshold)
 * @param {Function} callbacks.onCritical - Called when storage is critical (force stop)
 * @param {Function} callbacks.onRecovered - Called when storage recovers to normal
 * @returns {Promise<{status: string, freeMB: number}>} Initial status
 */
export const startStorageMonitor = async (callbacks = {}) => {
  if (isMonitoring.value) {
    console.warn('Storage monitor: Already monitoring');
    return { status: currentStatus.value, freeMB: currentFreeMB.value };
  }

  // Set callbacks
  onLowStorage = callbacks.onLow || null;
  onCriticalStorage = callbacks.onCritical || null;
  onStorageRecovered = callbacks.onRecovered || null;

  // Perform initial check
  const initialResult = await checkStorage();

  // Start periodic monitoring
  isMonitoring.value = true;
  monitorInterval = setInterval(async () => {
    if (isMonitoring.value) {
      await checkStorage();
    }
  }, CHECK_INTERVAL_MS);

  console.log(`Storage monitor: Started (${initialResult.freeMB}MB free)`);

  return { status: initialResult.status, freeMB: initialResult.freeMB };
};

/**
 * Stop storage monitoring
 */
export const stopStorageMonitor = () => {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }

  isMonitoring.value = false;
  currentStatus.value = 'ok';
  currentFreeMB.value = -1;

  // Clear callbacks
  onLowStorage = null;
  onCriticalStorage = null;
  onStorageRecovered = null;

  console.log('Storage monitor: Stopped');
};

/**
 * Get current storage status
 * @returns {{status: string, freeMB: number, isMonitoring: boolean}}
 */
export const getStorageStatus = () => {
  return {
    status: currentStatus.value,
    freeMB: currentFreeMB.value,
    isMonitoring: isMonitoring.value
  };
};

/**
 * Force an immediate storage check
 * @returns {Promise<{status: string, freeMB: number, action: string | null}>}
 */
export const forceStorageCheck = async () => {
  return checkStorage();
};

/**
 * Composable for reactive storage monitoring state
 */
export const useStorageMonitor = () => {
  return {
    status: readonly(currentStatus),
    freeMB: readonly(currentFreeMB),
    isMonitoring: readonly(isMonitoring),
    startMonitor: startStorageMonitor,
    stopMonitor: stopStorageMonitor,
    forceCheck: forceStorageCheck,
    getStatus: getStorageStatus
  };
};

/**
 * Pre-recording storage check
 * Returns whether recording should be allowed to start
 * @returns {Promise<{canStart: boolean, status: string, freeMB: number, message: string | null}>}
 */
export const checkStorageBeforeRecording = async () => {
  const result = await getFreeDiskSpace();

  if (!result.success) {
    console.warn('Storage check: Could not verify disk space');
    return {
      canStart: true, // Allow start but warn
      status: 'unknown',
      freeMB: -1,
      message: 'Could not verify available storage. Recording may fail if storage is full.'
    };
  }

  const freeMB = result.freeMB;

  if (freeMB < PlatformConstants.CRITICAL_STORAGE_MB) {
    return {
      canStart: false,
      status: 'critical',
      freeMB,
      message: `Cannot start recording. Only ${freeMB}MB of storage remaining. Please free up at least ${PlatformConstants.MIN_STORAGE_MB}MB to continue.`
    };
  }

  if (freeMB < PlatformConstants.MIN_STORAGE_MB) {
    return {
      canStart: true,
      status: 'low',
      freeMB,
      message: `Low storage warning: Only ${freeMB}MB remaining. Recording may be interrupted if storage runs out.`
    };
  }

  return {
    canStart: true,
    status: 'ok',
    freeMB,
    message: null
  };
};
