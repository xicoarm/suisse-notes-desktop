/**
 * Main process environment configuration
 *
 * This module provides environment-specific configuration for the Electron main process.
 * In production, it uses hardcoded values for security.
 * In development, it can use local servers or staging environments.
 */

const { app } = require('electron');

// Environment types
const Environments = {
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
function detectEnvironment() {
  // Check for explicit environment variable
  if (process.env.APP_ENV) {
    return process.env.APP_ENV;
  }

  // In production builds (packaged app), always use production
  if (app.isPackaged) {
    return Environments.PRODUCTION;
  }

  // In development, default to development
  return Environments.DEVELOPMENT;
}

// Get API URL for current environment
function getApiUrl() {
  const env = detectEnvironment();

  // Allow override via environment variable (useful for testing)
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL;
  }

  return API_URLS[env] || API_URLS[Environments.PRODUCTION];
}

// Environment info for debugging
function getEnvironmentInfo() {
  return {
    environment: detectEnvironment(),
    apiUrl: getApiUrl(),
    isPackaged: app.isPackaged,
    version: app.getVersion()
  };
}

module.exports = {
  Environments,
  detectEnvironment,
  getApiUrl,
  getEnvironmentInfo
};
