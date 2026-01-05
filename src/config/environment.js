/**
 * Environment configuration
 *
 * This module provides environment-specific configuration for the app.
 * In production, it uses hardcoded values for security.
 * In development, it can use local servers or staging environments.
 *
 * Environment detection:
 * - Production: app is packaged (app.isPackaged in main process)
 * - Development: running via `npm run dev`
 */

// Environment types
export const Environments = {
  PRODUCTION: 'production',
  STAGING: 'staging',
  DEVELOPMENT: 'development'
};

// Environment-specific API URLs
const API_URLS = {
  [Environments.PRODUCTION]: 'https://app.suisse-notes.ch',
  [Environments.STAGING]: 'https://staging.suisse-notes.ch',
  [Environments.DEVELOPMENT]: 'http://localhost:3000'
};

// Detect current environment
// In renderer process, we check process.env values set by Quasar
export function detectEnvironment() {
  // Check for explicit environment variable
  if (process.env.APP_ENV) {
    return process.env.APP_ENV;
  }

  // In production builds, always use production
  if (process.env.NODE_ENV === 'production') {
    return Environments.PRODUCTION;
  }

  // In development, default to development
  return Environments.DEVELOPMENT;
}

// Get API URL for current environment
export function getApiUrl() {
  const env = detectEnvironment();

  // Allow override via environment variable
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL;
  }

  return API_URLS[env] || API_URLS[Environments.PRODUCTION];
}

// Environment info for debugging
export function getEnvironmentInfo() {
  return {
    environment: detectEnvironment(),
    apiUrl: getApiUrl(),
    nodeEnv: process.env.NODE_ENV,
    isDev: process.env.DEV === 'true' || process.env.NODE_ENV === 'development'
  };
}

// Export default config
export default {
  Environments,
  detectEnvironment,
  getApiUrl,
  getEnvironmentInfo
};
