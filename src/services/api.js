/**
 * Shared API configuration service
 * Provides unified API URL configuration for all platforms:
 * - Desktop (Electron): Gets URL from electron config
 * - iOS/Android (Capacitor): Uses environment-based configuration
 * - Web: Uses development configuration
 */

import { isElectron, isCapacitor, getPlatform } from '../utils/platform';

// Environment types
const Environments = {
  PRODUCTION: 'production',
  STAGING: 'staging',
  DEVELOPMENT: 'development'
};

// Environment-specific API URLs (mirrors electron config)
const API_URLS = {
  [Environments.PRODUCTION]: 'https://app.suisse-notes.ch',
  [Environments.STAGING]: 'https://staging.suisse-notes.ch',
  [Environments.DEVELOPMENT]: 'http://localhost:3000'
};

// API endpoints
export const API_ENDPOINTS = {
  // Authentication
  login: '/api/auth/desktop',
  register: '/api/auth/register',
  refreshToken: '/api/auth/refresh',
  logout: '/api/auth/logout',

  // Upload
  upload: '/api/desktop/upload',
  uploadStatus: (audioFileId) => `/api/desktop/upload/${audioFileId}/status`,

  // Transcription
  transcribe: (audioFileId) => `/api/desktop/audio/${audioFileId}/transcribe`,
  transcriptionStatus: (audioFileId) => `/api/desktop/audio/${audioFileId}/transcription`,

  // History
  history: '/api/desktop/history',
  recording: (recordingId) => `/api/desktop/recording/${recordingId}`,

  // User
  userProfile: '/api/user/profile',
  userSettings: '/api/user/settings'
};

/**
 * Detect current environment
 * @returns {string} Environment name
 */
export const detectEnvironment = () => {
  // Check for explicit environment variable (build-time)
  // Vite uses import.meta.env, ensure fallback for compatibility
  const envVar = typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_ENV;
  if (envVar) {
    return envVar;
  }

  // On Electron, the main process handles environment detection
  if (isElectron()) {
    // We'll get the URL from electron, so environment detection isn't critical here
    return Environments.PRODUCTION;
  }

  // On Capacitor (mobile), use production for packaged apps
  if (isCapacitor()) {
    // In dev mode (quasar dev -m capacitor), use development
    // In production builds, use production
    const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
    // Note: In dev mode, mobile apps should use production API since localhost
    // doesn't work on emulators/devices. For local API testing, use ngrok or similar.
    return Environments.PRODUCTION;
  }

  // Web fallback to development
  return Environments.DEVELOPMENT;
};

/**
 * Get the API base URL for the current platform
 * @returns {Promise<string>} API base URL
 */
export const getApiUrl = async () => {
  // Check for explicit override (useful for testing)
  const override = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL;
  if (override) {
    return override;
  }

  if (isElectron()) {
    // Desktop: get URL from Electron main process via preload API
    try {
      if (window.electronAPI?.config?.getApiUrl) {
        return await window.electronAPI.config.getApiUrl();
      }
    } catch (error) {
      console.warn('Could not get API URL from Electron, using default:', error);
    }
    // Fallback to production URL
    return API_URLS[Environments.PRODUCTION];
  }

  if (isCapacitor()) {
    // Mobile: use environment-based URL
    const env = detectEnvironment();
    return API_URLS[env] || API_URLS[Environments.PRODUCTION];
  }

  // Web: use development URL
  return API_URLS[Environments.DEVELOPMENT];
};

/**
 * Get API URL synchronously (use cached value or default)
 * Use this only when async is not possible
 * @returns {string} API base URL
 */
let cachedApiUrl = null;

export const getApiUrlSync = () => {
  if (cachedApiUrl) {
    return cachedApiUrl;
  }

  // Return default based on environment
  const env = detectEnvironment();
  return API_URLS[env] || API_URLS[Environments.PRODUCTION];
};

/**
 * Initialize and cache API URL (call on app startup)
 * @returns {Promise<string>} API base URL
 */
export const initializeApiUrl = async () => {
  cachedApiUrl = await getApiUrl();
  console.log(`API initialized: ${cachedApiUrl} (${getPlatform()})`);
  return cachedApiUrl;
};

/**
 * Build full API endpoint URL
 * @param {string} endpoint - API endpoint path (e.g., '/api/auth/login')
 * @returns {Promise<string>} Full URL
 */
export const buildApiUrl = async (endpoint) => {
  const baseUrl = await getApiUrl();
  return `${baseUrl}${endpoint}`;
};

/**
 * Build full API endpoint URL synchronously
 * @param {string} endpoint - API endpoint path
 * @returns {string} Full URL
 */
export const buildApiUrlSync = (endpoint) => {
  const baseUrl = getApiUrlSync();
  return `${baseUrl}${endpoint}`;
};

/**
 * Get environment info for debugging
 * @returns {Object} Environment information
 */
export const getEnvironmentInfo = () => {
  return {
    environment: detectEnvironment(),
    platform: getPlatform(),
    apiUrl: cachedApiUrl || getApiUrlSync(),
    availableEnvironments: Object.keys(API_URLS)
  };
};

/**
 * Check if currently using production API
 * @returns {boolean}
 */
export const isProduction = () => {
  const env = detectEnvironment();
  return env === Environments.PRODUCTION;
};

/**
 * Check if currently using development API
 * @returns {boolean}
 */
export const isDevelopment = () => {
  const env = detectEnvironment();
  return env === Environments.DEVELOPMENT;
};

/**
 * HTTP request helper with automatic API URL resolution
 * @param {string} endpoint - API endpoint
 * @param {Object} options - Fetch options
 * @returns {Promise<Response>}
 */
export const apiRequest = async (endpoint, options = {}) => {
  const url = await buildApiUrl(endpoint);

  const defaultHeaders = {
    'Content-Type': 'application/json'
  };

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers
    }
  });
};

/**
 * HTTP request helper with authentication
 * @param {string} endpoint - API endpoint
 * @param {string} token - Authentication token
 * @param {Object} options - Fetch options
 * @returns {Promise<Response>}
 */
export const authenticatedRequest = async (endpoint, token, options = {}) => {
  if (!token) {
    throw new Error('Authentication token required');
  }

  return apiRequest(endpoint, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    }
  });
};

// Export environments for external use
export { Environments, API_URLS };
