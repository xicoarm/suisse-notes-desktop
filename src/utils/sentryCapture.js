/**
 * Mobile error-capture policy — pure helpers used by the Sentry boot file.
 *
 * Goal: every distinct error, warning and failed request reaches Sentry,
 * including the ones raised while the phone is offline, before the SDK has
 * started, or in a previous session that ended in a native crash — without a
 * single looping failure on one phone flooding the project into spike
 * protection (in August 2026 that silently dropped 360 mobile events).
 */
import { redactSecrets } from './redact';

/**
 * HTTP answers captured as events by the HTTP-client integration. Everything
 * from 400 to 599 except the answers that are part of normal operation:
 * 401 (expired session, refreshed automatically), 402 (no transcription
 * minutes left, shown to the user) and 409 (upload already registered,
 * treated as success).
 */
export const HTTP_CAPTURE_STATUS_CODES = [400, [403, 408], [410, 599]];

/**
 * Per-session sampling burst by level: the first N occurrences of an event
 * are always sent; after that only the 2^k-th occurrence (8th, 16th, 32nd…)
 * with the running count. A distinct problem is therefore always reported
 * immediately and its frequency stays visible, while a loop that fires
 * thousands of times costs a handful of events.
 */
const BURST_BY_LEVEL = { fatal: 5, error: 5, warning: 3, log: 2, info: 2, debug: 1 };

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const DIGITS_RE = /\d+/g;

/** Stable key of an event for sampling: level + origin + message with ids/numbers masked. */
export function eventKey(event) {
  const ex = event?.exception?.values?.[0];
  const text = ex
    ? `${ex.type || ''}: ${ex.value || ''}`
    : (event?.logentry?.message || event?.message || '');
  const normalized = String(text)
    .replace(UUID_RE, '<id>')
    .replace(LONG_HEX_RE, '<hex>')
    .replace(DIGITS_RE, '#')
    .slice(0, 300);
  const origin = ex?.mechanism?.type || event?.logger || '';
  return `${event?.level || 'error'}|${origin}|${normalized}`;
}

const isPowerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0;

/**
 * Create the per-session occurrence sampler (beforeSend stage).
 * @returns {(event: object) => object|null}
 */
export function createOccurrenceSampler({ burst = BURST_BY_LEVEL, maxKeys = 500 } = {}) {
  const counts = new Map();
  return (event) => {
    if (!event) return event;
    const key = eventKey(event);
    const n = (counts.get(key) || 0) + 1;
    counts.delete(key);
    counts.set(key, n);
    if (counts.size > maxKeys) counts.delete(counts.keys().next().value);
    const limit = burst[event.level || 'error'] ?? 3;
    if (n > limit && !isPowerOfTwo(n)) return null;
    if (n > 1) event.extra = { ...(event.extra || {}), occurrences_this_session: n };
    return event;
  };
}

/** The HTTP-client integration marks failed responses as unhandled — they are not app crashes. */
export function treatHttpClientAsHandled(event) {
  for (const value of event?.exception?.values || []) {
    if (value?.mechanism?.type === 'http.client') value.mechanism.handled = true;
  }
  return event;
}

const DETAIL_FIELDS = ['code', 'status', 'statusCode', 'phase', 'canRetry', 'errorCode', 'reason', 'failureCount', 'totalCount', 'localFileMissing', 'insufficientMinutes'];

/**
 * Whitelisted diagnostic fields of an error object (our BLE/upload errors carry
 * `code`, `status`, `canRetry`…). A whitelist, not a dump: axios errors carry
 * the request config including the Authorization header.
 */
export function errorDetails(err) {
  if (!err || typeof err !== 'object') return null;
  const out = {};
  for (const key of DETAIL_FIELDS) {
    const v = err[key];
    if (typeof v === 'string') out[key] = redactSecrets(v).slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

const SECRET_KEY_RE = /authorization|token|password|secret|cookie|session|jwt/i;

function safeSerialize(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactSecrets(value).slice(0, 1000);
  if (value instanceof Error) {
    return { name: value.name, message: redactSecrets(String(value.message || '')).slice(0, 500), ...(errorDetails(value) || {}) };
  }
  if (typeof value !== 'object') return String(value).slice(0, 200);
  if (depth >= 2) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => safeSerialize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 30)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : safeSerialize(v, depth + 1);
  }
  return out;
}

/** Console-captured events carry the raw console arguments — redact before they leave the phone. */
export function sanitizeConsoleArguments(event) {
  if (Array.isArray(event?.extra?.arguments)) {
    event.extra = { ...event.extra, arguments: event.extra.arguments.slice(0, 10).map((a) => safeSerialize(a)) };
  }
  return event;
}

/**
 * Buffer window errors and unhandled rejections raised before Sentry is
 * initialized; `drain` detaches the listeners and hands the buffered items to
 * the capture function (called right after init, so nothing is captured twice).
 */
export function createEarlyErrorBuffer(target, { max = 20 } = {}) {
  const items = [];
  const onError = (e) => {
    if (items.length < max) items.push({ kind: 'error', error: e?.error || new Error(e?.message || 'Script error before Sentry init') });
  };
  const onRejection = (e) => {
    if (items.length < max) items.push({ kind: 'unhandledrejection', error: e?.reason });
  };
  target?.addEventListener?.('error', onError);
  target?.addEventListener?.('unhandledrejection', onRejection);
  return {
    items,
    drain(capture) {
      target?.removeEventListener?.('error', onError);
      target?.removeEventListener?.('unhandledrejection', onRejection);
      const list = items.splice(0);
      for (const item of list) {
        try { capture(item); } catch { /* never break the boot */ }
      }
      return list.length;
    }
  };
}

/**
 * Verdict about the previous app session from its persisted state: a session
 * still marked "foreground" never left the screen the normal way (home button,
 * app switcher, screen lock and calls all pass through "background" first), so
 * it ended in a native crash, a WebView termination, an out-of-memory kill or
 * a watchdog kill.
 * @returns {null|object} report payload
 */
export function evaluatePreviousSession(previous, nowMs = Date.now()) {
  if (!previous || typeof previous !== 'object' || previous.state !== 'foreground') return null;
  const lastSeenAt = Number(previous.lastSeenAt) || null;
  const startedAt = Number(previous.startedAt) || null;
  return {
    appVersion: previous.appVersion || 'unknown',
    platform: previous.platform || 'unknown',
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
    minutesSinceLastSeen: lastSeenAt ? Math.round((nowMs - lastSeenAt) / 60000) : null,
    sessionMinutes: startedAt && lastSeenAt ? Math.round((lastSeenAt - startedAt) / 60000) : null,
    route: previous.route || null,
    recording: !!previous.recording,
    bleSync: !!previous.bleSync
  };
}
