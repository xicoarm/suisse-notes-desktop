/**
 * Platform detection utilities for multi-platform support
 * Detects whether the app is running on Electron (desktop), Capacitor (mobile), or web
 */

/**
 * Check if running in Electron (desktop)
 * @returns {boolean}
 */
export const isElectron = () => {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
};

/**
 * Check if running in Capacitor (mobile)
 * @returns {boolean}
 */
export const isCapacitor = () => {
  return typeof window !== 'undefined' &&
    window.Capacitor !== undefined &&
    window.Capacitor.isNativePlatform !== undefined &&
    window.Capacitor.isNativePlatform();
};

/**
 * Check if running on iOS (via Capacitor)
 * @returns {boolean}
 */
export const isIOS = () => {
  return isCapacitor() && window.Capacitor.getPlatform() === 'ios';
};

/**
 * Check if running on Android (via Capacitor)
 * @returns {boolean}
 */
export const isAndroid = () => {
  return isCapacitor() && window.Capacitor.getPlatform() === 'android';
};

/**
 * Check if running in web browser (no native wrapper)
 * @returns {boolean}
 */
export const isWeb = () => {
  return !isElectron() && !isCapacitor();
};

/**
 * Check if running on any mobile platform
 * @returns {boolean}
 */
export const isMobile = () => {
  return isIOS() || isAndroid();
};

/**
 * Check if running on desktop (Electron)
 * @returns {boolean}
 */
export const isDesktop = () => {
  return isElectron();
};

/**
 * Get the current platform name
 * @returns {'electron' | 'ios' | 'android' | 'web'}
 */
export const getPlatform = () => {
  if (isElectron()) return 'electron';
  if (isIOS()) return 'ios';
  if (isAndroid()) return 'android';
  return 'web';
};

/**
 * Check if the platform supports background recording
 * @returns {boolean}
 */
export const supportsBackgroundRecording = () => {
  // Electron always supports background (app stays open)
  // iOS/Android support via native foreground services
  return isElectron() || isCapacitor();
};

/**
 * Check if the platform supports file system access
 * @returns {boolean}
 */
export const supportsFileSystem = () => {
  return isElectron() || isCapacitor();
};

/**
 * Check if native audio recording is available
 * @returns {boolean}
 */
export const hasNativeAudioRecording = () => {
  return isCapacitor();
};

/**
 * Platform-specific constants
 */
export const PlatformConstants = {
  // Recording chunk interval in milliseconds
  CHUNK_INTERVAL_MS: 5000,

  // Minimum storage required to start recording (MB)
  MIN_STORAGE_MB: 500,

  // Critical storage threshold - force stop (MB)
  CRITICAL_STORAGE_MB: 100,

  // Battery level thresholds
  LOW_BATTERY_PERCENT: 15,
  CRITICAL_BATTERY_PERCENT: 5,

  // Upload retry configuration - generous for large files (4-5 hour recordings)
  MAX_UPLOAD_RETRIES: 15,
  INITIAL_RETRY_DELAY_MS: 2000,
  MAX_RETRY_DELAY_MS: 120000, // 2 minutes max delay between retries

  // Upload chunk size for TUS protocol (bytes)
  UPLOAD_CHUNK_SIZE: 5 * 1024 * 1024, // 5MB

  // Maximum file size warning threshold (MB)
  LARGE_FILE_WARNING_MB: 200
};
