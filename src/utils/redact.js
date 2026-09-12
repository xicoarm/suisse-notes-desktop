/**
 * Redaction helpers for anything that may reach logs or Sentry.
 *
 * The SSO callback URL carries the freshly issued JWT and the user object as
 * query parameters (suissenotes://auth/callback?token=<jwt>&user=<base64>).
 * Diagnostic messages used to send the first 200 characters of that URL to
 * Sentry — most of a session token, for every SSO login. Redact secret-bearing
 * query values before a URL or free-text message leaves the device.
 */

const SECRET_QUERY_KEYS = ['token', 'access_token', 'refresh_token', 'id_token', 'session', 'user', 'auth', 'code', 'password'];

const SECRET_QUERY_RE = new RegExp(`([?&#]|^)(${SECRET_QUERY_KEYS.join('|')})=([^&#\\s'"]+)`, 'gi');
// Bare JWTs (three base64url segments) — they are recognizable without a key.
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;

/**
 * Redact secret query values and bare JWTs inside an arbitrary string.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(SECRET_QUERY_RE, (m, sep, key) => `${sep}${key}=[REDACTED]`)
    .replace(JWT_RE, '[REDACTED_JWT]');
}

/**
 * Redact a URL for logging: keeps scheme/host/path, hides secret query values.
 * Never throws — falls back to redacting the raw string.
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  try {
    const parsed = new URL(url);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SECRET_QUERY_KEYS.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return redactSecrets(parsed.toString());
  } catch {
    return redactSecrets(url);
  }
}
