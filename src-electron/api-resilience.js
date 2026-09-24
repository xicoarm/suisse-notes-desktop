// Main-process counterpart of the renderer's API hardening (src/services/api.js).
//
// WHY: nginx answers with an HTML 502/503/504 page while the backend restarts
// (deploys, crash restarts: 1-8 s windows several times a day, a few of
// 40-50 s — production nginx log 2026-09-21..24). The renderer surfaced one
// such 2-second restart as two Sentry error issues (ELECTRON-6E/6F). The main
// process has the same exposure through axios, plus a quieter one: axios hands
// back an HTML body as a string, so `response.data.status` or
// `response.data.token` is silently `undefined` instead of an error.
//
// HOW: two interceptors on the shared axios instance, scoped to requests for
// the app backend (never Azure blob storage or other hosts):
// - a 2xx whose body is an HTML page rejects with code ENONJSON (transient),
//   so every caller takes its existing error path;
// - an idempotent request (GET/HEAD/OPTIONS, or `retryGateway: true` in the
//   request config) answered 502/503/504 is sent again after 1, 2, 4 and 8 s
//   (or Retry-After up to 10 s). A gateway error that persists reaches the
//   caller marked `transient`, and is logged once as a warning.
// Defensive by design: any failure inside the interceptors leaves the
// original response/error untouched.

const GATEWAY_STATUSES = new Set([502, 503, 504]);
const GATEWAY_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const MAX_RETRY_AFTER_MS = 10000;
const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    if (v != null) return v;
  }
  return headers[name] ?? headers[name.toLowerCase()];
}

function looksLikeHtml(response) {
  const contentType = String(headerValue(response?.headers, 'content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) return false;
  if (contentType.includes('text/html')) return true;
  const data = response?.data;
  return typeof data === 'string' && /^\s*</.test(data);
}

function retryDelay(response, fallbackMs) {
  const value = String(headerValue(response?.headers, 'retry-after') ?? '').trim();
  if (/^\d+$/.test(value) && Number(value) * 1000 <= MAX_RETRY_AFTER_MS) {
    return Math.max(Number(value) * 1000, 250);
  }
  return fallbackMs;
}

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return String(url || '').split('?')[0]; }
}

/**
 * @param {object} deps
 * @param {import('axios').AxiosStatic|import('axios').AxiosInstance} deps.axios
 * @param {{info: Function, warn: Function}} deps.log
 * @param {() => string} deps.getApiBaseUrl - backend origin, e.g. https://app.suisse-meets.ch
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number[]} [deps.delaysMs]
 */
function installApiResilience({ axios, log, getApiBaseUrl, sleep = defaultSleep, delaysMs = GATEWAY_RETRY_DELAYS_MS }) {
  const requestUrl = (config) => {
    try { return axios.getUri(config); } catch { return config?.url || ''; }
  };
  const isApiRequest = (config) => {
    try {
      const base = getApiBaseUrl();
      return !!base && new URL(requestUrl(config)).origin === new URL(base).origin;
    } catch {
      return false;
    }
  };

  axios.interceptors.response.use(
    (response) => {
      try {
        const config = response?.config;
        if (!config || !isApiRequest(config)) return response;
        if (config.__gatewayAttempt) {
          log.info(`[api] ${String(config.method || 'get').toUpperCase()} ${pathOf(requestUrl(config))} recovered after ${config.__gatewayAttempt + 1} attempts (gateway error)`);
        }
        if (config.responseType && config.responseType !== 'json') return response;
        if (!looksLikeHtml(response)) return response;
        const err = new Error(`Unexpected server response (HTTP ${response.status}, HTML instead of JSON)`);
        err.name = 'ApiResponseError';
        err.code = 'ENONJSON';
        err.status = response.status;
        err.nonJson = true;
        err.transient = true;
        err.config = config;
        err.response = response;
        err.isAxiosError = true;
        return Promise.reject(err);
      } catch {
        return response;
      }
    },
    async (error) => {
      let retryConfig = null;
      let wait = 0;
      try {
        const config = error?.config;
        const status = error?.response?.status;
        if (config && GATEWAY_STATUSES.has(status) && isApiRequest(config)) {
          error.transient = true;
          const method = String(config.method || 'get').toLowerCase();
          const allowed = config.retryGateway ?? IDEMPOTENT_METHODS.has(method);
          const attempt = config.__gatewayAttempt || 0;
          if (allowed && attempt < delaysMs.length && !config.signal?.aborted) {
            config.__gatewayAttempt = attempt + 1;
            wait = retryDelay(error.response, delaysMs[attempt]);
            retryConfig = config;
          } else if (allowed) {
            log.warn(`[api] Backend unavailable: ${method.toUpperCase()} ${pathOf(requestUrl(config))} answered HTTP ${status} after ${attempt + 1} attempts`);
          }
        }
      } catch {
        retryConfig = null;
      }
      if (!retryConfig) return Promise.reject(error);
      await sleep(wait);
      if (retryConfig.signal?.aborted) return Promise.reject(error);
      return axios.request(retryConfig);
    }
  );
  log.info('[api] Gateway-retry and HTML-response guard installed for main-process axios');
}

module.exports = {
  installApiResilience,
  GATEWAY_STATUSES,
  GATEWAY_RETRY_DELAYS_MS,
  looksLikeHtml,
};
