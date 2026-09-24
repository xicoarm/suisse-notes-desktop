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
  [Environments.PRODUCTION]: 'https://app.suisse-meets.ch',
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

  // History
  history: '/api/desktop/history',
  recording: (recordingId) => `/api/desktop/recording/${recordingId}`,

  // User
  userProfile: '/api/user/profile',
  // NOTE: there is deliberately no `userSettings` here. /api/user/settings does
  // NOT exist on the backend (it serves /api/user/ai-settings and
  // /api/user/auto-send-settings). The old entry was unused, so it never 404'd
  // in production — it was a trap for whoever wired it up next. Verified
  // against the live route list 2026-08-15.

  // Minutes
  desktopMinutes: '/api/desktop/minutes',
  userMinutes: '/api/user/minutes',
  // NOTE: no `consumeMinutes` either — /api/user/minutes/consume does not exist
  // on the backend. See the comment above.

  // Sales
  salesInquiry: '/api/sales/inquiry',

  // Analytics
  authAnalytics: '/api/analytics/auth-event',

  // Custom Spelling
  customSpellingMerged: '/api/custom-spelling/merged',
  customSpellingUser: '/api/custom-spelling/user',

  // Account
  deleteAccount: '/api/user/delete-account'
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
  // Honor the explicit override exactly like the async getter — without this,
  // sync callers (minutes fetch, history sync, templates) silently targeted a
  // DIFFERENT backend than async callers whenever the override was set.
  const override = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL;
  if (override) {
    return override;
  }

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

// Default deadline for JSON API calls (login, refresh, minutes, history,
// spellings). Uploads use XHR/their own budgets and are not affected.
export const API_REQUEST_TIMEOUT_MS = 30000;

// Gateway answers: nginx returns an HTML 502/503/504 page while the backend
// restarts (a deploy, a crash restart). The request never reached app code,
// so an idempotent request is simply sent again. Production nginx logs
// (2026-09-21..24) show restart windows of 1-8 s several times a day and a
// few of 40-50 s. Retrying after 1+2+4+8 s rides out the common case; a
// longer outage reaches the caller as the gateway response.
// (ELECTRON-6E/6F: a 2 s deploy restart surfaced as two error issues.)
export const GATEWAY_RETRY_STATUSES = Object.freeze([502, 503, 504]);
export const GATEWAY_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000]);
const MAX_RETRY_AFTER_MS = 10000;
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isGatewayStatus = (status) => GATEWAY_RETRY_STATUSES.includes(status);

/** Statuses that mean "try again later", not "the request is wrong": 408, 429, 5xx. */
export const isTransientStatus = (status) =>
  status === 408 || status === 429 || (status >= 500 && status <= 599);

/** Delay before the next gateway retry: Retry-After in seconds (max 10 s), else the schedule. */
export const gatewayRetryDelay = (response, fallbackMs) => {
  const header = response?.headers?.get?.('retry-after');
  const value = header == null ? '' : String(header).trim();
  if (/^\d+$/.test(value) && Number(value) * 1000 <= MAX_RETRY_AFTER_MS) {
    return Math.max(Number(value) * 1000, 250);
  }
  return fallbackMs;
};

const sleepUnlessAborted = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  let timer = null;
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', done);
    resolve();
  };
  timer = setTimeout(done, ms);
  signal?.addEventListener?.('abort', done, { once: true });
});

const discardBody = (response) => {
  try {
    const cancelled = response?.body?.cancel?.();
    if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
  } catch { /* body already consumed or not cancellable */ }
};

// Path without query, id-like segments masked: one outage groups into one
// Sentry issue instead of one per recording id.
export const pathTemplate = (url) => {
  let path = String(url || '');
  try { path = new URL(path).pathname; } catch { path = path.split('?')[0]; }
  return path
    .split('/')
    .map((seg) => (/\d/.test(seg) && seg.length >= 8 ? ':id' : seg))
    .join('/');
};

const reportGatewayExhausted = (url, method, status, attempts) => {
  // Lazy import keeps api.js free of the Sentry boot file at module load.
  import('../boot/sentry')
    .then(({ captureMessage }) => captureMessage(
      `Backend unavailable: ${method} ${pathTemplate(url)} answered HTTP ${status} after ${attempts} attempts`,
      'warning',
      {
        fingerprint: ['backend-unavailable', String(status)],
        tags: { http_status: String(status), gateway_retry: 'exhausted' }
      }
    ))
    .catch(() => {});
};

/**
 * fetch() with a deadline and gateway retries. Resolves/rejects exactly like
 * fetch, except that:
 * - a request still pending after `timeoutMs` (per attempt) is aborted and
 *   rejects with an Error whose name is 'TimeoutError' (message mentions the
 *   timeout so the generic transient-network classifiers treat it as
 *   retryable);
 * - an idempotent request (GET/HEAD/OPTIONS, or any request passed
 *   `retryGateway: true`) answered 502/503/504 is sent again after each of
 *   GATEWAY_RETRY_DELAYS_MS; if the gateway error persists, that last
 *   response is returned. `retryGateway: false` disables the retries.
 * An `options.signal` from the caller is honoured alongside the deadline and
 * cuts a retry wait short.
 * @param {string} url
 * @param {Object} options - fetch options + optional timeoutMs, retryGateway, retryDelaysMs
 * @returns {Promise<Response>}
 */
export const fetchWithTimeout = async (url, options = {}) => {
  const {
    timeoutMs = API_REQUEST_TIMEOUT_MS,
    signal: callerSignal,
    retryGateway,
    retryDelaysMs = GATEWAY_RETRY_DELAYS_MS,
    ...fetchOptions
  } = options;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const retry = retryGateway ?? IDEMPOTENT_METHODS.has(method);

  let response = await fetchOnce(url, fetchOptions, timeoutMs, callerSignal);
  if (!retry || !isGatewayStatus(response?.status)) return response;

  let attempts = 1;
  for (const delay of retryDelaysMs) {
    if (!isGatewayStatus(response?.status)) break;
    discardBody(response);
    await sleepUnlessAborted(gatewayRetryDelay(response, delay), callerSignal);
    if (callerSignal?.aborted) {
      // Same outcome as aborting a plain fetch.
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      throw e;
    }
    response = await fetchOnce(url, fetchOptions, timeoutMs, callerSignal);
    attempts++;
  }
  if (isGatewayStatus(response?.status)) {
    reportGatewayExhausted(url, method, response.status, attempts);
  } else if (attempts > 1) {
    console.info(`[api] ${method} ${pathTemplate(url)} recovered after ${attempts} attempts (gateway error)`);
  }
  return response;
};

const fetchOnce = async (url, fetchOptions, timeoutMs, callerSignal) => {
  if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === 'undefined') {
    return fetch(url, { ...fetchOptions, signal: callerSignal });
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      const e = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s (network error)`);
      e.name = 'TimeoutError';
      e.code = 'ETIMEDOUT';
      throw e;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }
};

/**
 * HTTP request helper with automatic API URL resolution
 * @param {string} endpoint - API endpoint
 * @param {Object} options - Fetch options (+ optional timeoutMs, default 30s)
 * @returns {Promise<Response>}
 */
export const apiRequest = async (endpoint, options = {}) => {
  const url = await buildApiUrl(endpoint);

  const defaultHeaders = {
    'Content-Type': 'application/json'
  };

  return fetchWithTimeout(url, {
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

/**
 * Parse a JSON body defensively. A proxy error page or captive portal returns
 * HTML with any status; that must read as a server error, not crash the
 * caller with "JSON Parse error: Unrecognized token".
 * @param {Response} response
 * @returns {Promise<object>} parsed body, or { error } when it is not JSON
 */
export const parseJsonSafe = async (response) => {
  let text = '';
  try { text = await response.text(); } catch { text = ''; }
  if (!text) return {};
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return { error: `Unexpected server response (HTTP ${response.status})`, nonJson: true };
  }
};

/**
 * Error for an API answer the caller cannot use. `status` is the HTTP status,
 * `nonJson` marks an HTML/text body (gateway error page, captive portal), and
 * `transient` says the same request may well succeed later (non-JSON body,
 * 408/429, 5xx): callers keep their cached data and log a warning, not an
 * app error.
 */
export class ApiResponseError extends Error {
  constructor(message, { status, nonJson = false } = {}) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = status;
    this.nonJson = nonJson;
    this.transient = nonJson || isTransientStatus(status);
  }
}

/**
 * Read a JSON body or throw ApiResponseError. The sanctioned way to parse an
 * API response (eslint forbids a bare `response.json()` in src/): a gateway
 * or captive-portal HTML page must never surface as
 * "SyntaxError: Unexpected token '<'" (ELECTRON-6E).
 * @param {Response} response
 * @returns {Promise<any>} parsed body ({} for an empty body)
 */
export const readJson = async (response) => {
  const data = await parseJsonSafe(response);
  if (data && data.nonJson === true) {
    throw new ApiResponseError(data.error, { status: response.status, nonJson: true });
  }
  return data;
};

/**
 * ApiResponseError for a non-2xx response, carrying the server's `error`
 * message when the body has one.
 * @param {Response} response
 * @param {string} [fallbackMessage]
 * @returns {Promise<ApiResponseError>}
 */
export const apiErrorFromResponse = async (response, fallbackMessage) => {
  const data = await parseJsonSafe(response);
  const nonJson = data?.nonJson === true;
  return new ApiResponseError(
    data?.error || fallbackMessage || `HTTP ${response.status}`,
    { status: response.status, nonJson }
  );
};

/** True when an error means "the server or network is briefly unavailable". */
export const isTransientApiError = (error) => error?.transient === true;

/**
 * Get user's remaining minutes from the desktop-specific endpoint
 * @param {string} token - Authentication token
 * @returns {Promise<{remaining: number, unlimited: boolean, total: number, used: number}>}
 */
export const getUserMinutes = async (token) => {
  const response = await authenticatedRequest(API_ENDPOINTS.desktopMinutes, token);
  if (!response.ok) {
    throw await apiErrorFromResponse(response, 'Failed to fetch minutes');
  }
  return readJson(response);
};

/**
 * Submit a sales inquiry
 * @param {Object} inquiry - Inquiry data
 * @param {string} inquiry.email - User email
 * @param {string} inquiry.organizationName - Organization name
 * @param {number} inquiry.minutesNeeded - Minutes needed per month
 * @param {string} [inquiry.message] - Optional message
 * @param {string} [token] - Optional auth token
 * @returns {Promise<{success: boolean, inquiryId: string}>}
 */
export const submitSalesInquiry = async (inquiry, token = null) => {
  const options = {
    method: 'POST',
    body: JSON.stringify(inquiry)
  };

  const response = token
    ? await authenticatedRequest(API_ENDPOINTS.salesInquiry, token, options)
    : await apiRequest(API_ENDPOINTS.salesInquiry, options);

  if (!response.ok) {
    throw await apiErrorFromResponse(response, 'Failed to submit inquiry');
  }
  return readJson(response);
};

/**
 * Fetch merged custom spellings (org + user)
 * @param {string} token - Authentication token
 * @returns {Promise<{spellings: string[], orgSpellings: string[], userSpellings: string[]}>}
 */
export const getMergedSpellings = async (token) => {
  const response = await authenticatedRequest(API_ENDPOINTS.customSpellingMerged, token);
  if (!response.ok) {
    throw await apiErrorFromResponse(response, 'Failed to fetch spellings');
  }
  return readJson(response);
};

/**
 * Add custom spelling terms for the current user
 * @param {string} token - Authentication token
 * @param {string[]} terms - Terms to add
 * @returns {Promise<{spellings: string[], added: string[]}>}
 */
export const addUserSpellings = async (token, terms) => {
  const response = await authenticatedRequest(API_ENDPOINTS.customSpellingUser, token, {
    method: 'POST',
    body: JSON.stringify({ terms })
  });
  if (!response.ok) {
    throw await apiErrorFromResponse(response, 'Failed to add spellings');
  }
  return readJson(response);
};

/**
 * Remove a custom spelling term for the current user
 * @param {string} token - Authentication token
 * @param {string} term - Term to remove
 * @returns {Promise<{spellings: string[], removed: string}>}
 */
export const removeUserSpelling = async (token, term) => {
  const response = await authenticatedRequest(
    `${API_ENDPOINTS.customSpellingUser}?term=${encodeURIComponent(term)}`,
    token,
    { method: 'DELETE' }
  );
  if (!response.ok) {
    throw await apiErrorFromResponse(response, 'Failed to remove spelling');
  }
  return readJson(response);
};

// Export environments for external use
export { Environments, API_URLS };
