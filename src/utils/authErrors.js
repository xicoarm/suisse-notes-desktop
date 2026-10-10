/**
 * Sign-in, registration and SSO failures -> the translated text the user sees.
 *
 * WHY: until 4.7.15 the app showed whatever the server or the transport
 * produced: "Invalid credentials", "Server error: 502", raw Microsoft
 * "AADSTS65001: The user or administrator has not consented ..." text, an
 * English 409 line that dropped the server's forgot-password hint. A prospect
 * cannot act on any of that (08.10.2026: 15 minutes stuck on registration).
 *
 * The backend answers with a machine `code` (contract 10/2026). Older backends
 * send only an HTTP status and an English sentence, so every mapping falls
 * back to the status, then to the known legacy sentences, and finally to a
 * generic translated text. A raw server or IdP string is never displayed.
 *
 * Every result carries a `reason` made only of [A-Za-z0-9_] (a known code,
 * `status_<n>`, an AADSTS number or `unknown`) - safe for telemetry and Sentry
 * tags because it can never contain user input.
 */

const REASON_RE = /^[A-Za-z0-9_]{1,40}$/;

/** Network failure codes (Node/axios in the Electron main process, fetch names in the renderer). */
const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'offline']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ECONNABORTED', 'ESOCKETTIMEDOUT', 'TimeoutError', 'timeout']);
const SERVER_DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE']);

const safeReason = (value, fallback = 'unknown') =>
  (typeof value === 'string' && REASON_RE.test(value) ? value : fallback);

/**
 * A failure without an HTTP answer. Returns null when the failure did get an
 * answer from the server.
 * @param {{ network?: string|boolean, networkCode?: string }} failure
 */
function networkProblem(failure) {
  const raw = failure?.networkCode || (typeof failure?.network === 'string' ? failure.network : null) ||
    (failure?.network === true ? 'offline' : null);
  if (!raw) return null;
  if (OFFLINE_CODES.has(raw)) return { key: 'networkUnavailable', reason: 'network_offline' };
  if (TIMEOUT_CODES.has(raw)) return { key: 'authConnectionTimedOut', reason: 'network_timeout' };
  if (SERVER_DOWN_CODES.has(raw)) return { key: 'authServiceUnavailable', reason: 'network_refused' };
  // Proxy, TLS interception, certificate problems and the like.
  return { key: 'authConnectionFailed', reason: `network_${safeReason(String(raw).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30), 'other')}` };
}

/** 5xx, gateway pages and HTML bodies: the backend is restarting or failing. */
function serviceProblem(failure) {
  const status = Number(failure?.status) || 0;
  if (failure?.code === 'server_error') return { key: 'authServiceUnavailable', reason: 'server_error' };
  if (status >= 500) return { key: 'authServiceUnavailable', reason: `status_${status}` };
  if (failure?.nonJson) return { key: 'authServiceUnavailable', reason: status ? `non_json_${status}` : 'non_json' };
  return null;
}

/**
 * Password sign-in (POST /api/auth/desktop) failure -> i18n key.
 * @param {{ status?: number, code?: string, provider?: string, nonJson?: boolean,
 *           network?: string|boolean, networkCode?: string }} failure
 * @returns {{ key: string, reason: string }}
 */
export function describeLoginFailure(failure = {}) {
  const network = networkProblem(failure);
  if (network) return network;
  const service = serviceProblem(failure);
  if (service) return service;

  switch (failure.code) {
    case 'invalid_credentials': return { key: 'loginInvalidCredentials', reason: 'invalid_credentials' };
    case 'use_sso':
      if (failure.provider === 'google') return { key: 'loginUseSsoGoogle', reason: 'use_sso' };
      if (failure.provider === 'microsoft') return { key: 'loginUseSsoMicrosoft', reason: 'use_sso' };
      return { key: 'loginUseSso', reason: 'use_sso' };
    case 'no_password': return { key: 'loginNoPassword', reason: 'no_password' };
    case 'account_disabled': return { key: 'accountDisabled', reason: 'account_disabled' };
    case 'too_many_attempts': return { key: 'authTooManyAttempts', reason: 'too_many_attempts' };
    case 'missing_fields': return { key: 'loginMissingFields', reason: 'missing_fields' };
    default: break;
  }

  // Older backend: status only.
  const status = Number(failure.status) || 0;
  if (status === 401) return { key: 'loginInvalidCredentials', reason: 'status_401' };
  if (status === 403) return { key: 'accountDisabled', reason: 'status_403' };
  if (status === 429) return { key: 'authTooManyAttempts', reason: 'status_429' };
  if (status === 400) return { key: 'loginMissingFields', reason: 'status_400' };
  return { key: 'loginFailedGeneric', reason: status ? `status_${status}` : safeReason(failure.code) };
}

/**
 * Registration (POST /api/auth/register) failure -> i18n key.
 * @param {{ status?: number, code?: string, nonJson?: boolean, network?: string|boolean,
 *           networkCode?: string, serverError?: string }} failure
 * @returns {{ key: string, reason: string }}
 */
export function describeRegisterFailure(failure = {}) {
  const network = networkProblem(failure);
  if (network) return network;
  const service = serviceProblem(failure);
  if (service) return service;

  const status = Number(failure.status) || 0;
  if (failure.code === 'account_exists' || failure.code === 'email_exists' || status === 409) {
    return { key: 'registerAccountExists', reason: status === 409 ? 'status_409' : failure.code };
  }
  if (failure.code === 'too_many_attempts' || status === 429) {
    return { key: 'authTooManyAttempts', reason: status === 429 ? 'status_429' : 'too_many_attempts' };
  }
  if (status === 400) {
    // The legacy backend's 400 sentences (src/app/api/auth/register/route.ts).
    const text = String(failure.serverError || '');
    if (/email format|valid e-?mail/i.test(text)) return { key: 'registerEmailInvalid', reason: 'invalid_email' };
    if (/at least 8|password.*(short|length)/i.test(text)) return { key: 'registerPasswordTooShort', reason: 'password_too_short' };
    if (/required/i.test(text)) return { key: 'registerMissingFields', reason: 'missing_fields' };
    return { key: 'registerFailedGeneric', reason: 'status_400' };
  }
  return { key: 'registerFailedGeneric', reason: status ? `status_${status}` : safeReason(failure.code) };
}

/** SSO callback codes of the backend contract (10/2026). */
const SSO_CODE_KEYS = {
  sso_failed: 'ssoFailed',
  sso_account_exists: 'ssoAccountExists',
  sso_email_unverified: 'ssoEmailUnverified',
  sso_admin_consent: 'ssoAdminConsent',
  account_disabled: 'accountDisabled'
};
const SSO_CANCEL_VALUES = new Set([
  'sso_cancelled', 'sso_canceled', 'canceled', 'cancelled', 'access_denied', 'user_canceled', 'user_cancelled'
]);
// Microsoft errors that only the organisation's administrator can resolve:
// consent required (65001, 90094, 90095, 900941) and user not assigned to the
// app (50105). 65004 is the user declining consent - a cancel.
const ADMIN_CONSENT_AADSTS = new Set(['65001', '90094', '90095', '900941', '50105']);

/**
 * SSO callback result -> cancel or translated failure.
 * Prefers the contract `code`; with an older backend falls back to the
 * `error` value (a code or an English sentence), never displaying it.
 * @param {{ error?: string, code?: string }|string} payload
 * @returns {{ cancelled: boolean, key: string|null, reason: string }}
 */
export function classifySsoError(payload) {
  const code = typeof payload === 'object' && payload ? payload.code : null;
  const error = typeof payload === 'string' ? payload : (payload?.error ?? '');

  if (code) {
    if (SSO_CANCEL_VALUES.has(code)) return { cancelled: true, key: null, reason: 'sso_cancelled' };
    if (SSO_CODE_KEYS[code]) return { cancelled: false, key: SSO_CODE_KEYS[code], reason: code };
    return { cancelled: false, key: 'ssoFailed', reason: safeReason(code) };
  }

  const text = String(error || '').trim();
  if (!text) return { cancelled: false, key: 'ssoFailed', reason: 'empty' };
  const lower = text.toLowerCase();
  if (SSO_CANCEL_VALUES.has(lower) || /AADSTS65004\b/.test(text) || /cancel/.test(lower)) {
    return { cancelled: true, key: null, reason: 'sso_cancelled' };
  }
  if (SSO_CODE_KEYS[lower]) return { cancelled: false, key: SSO_CODE_KEYS[lower], reason: lower };
  if (lower === 'invalid_callback') return { cancelled: false, key: 'ssoFailed', reason: 'invalid_callback' };

  const aadsts = /AADSTS(\d{4,7})/.exec(text);
  if (aadsts) {
    const reason = `AADSTS${aadsts[1]}`;
    if (ADMIN_CONSENT_AADSTS.has(aadsts[1])) return { cancelled: false, key: 'ssoAdminConsent', reason };
    return { cancelled: false, key: 'ssoFailed', reason };
  }
  if (/admin(istrator)? consent|consent_required|need admin approval/i.test(text)) {
    return { cancelled: false, key: 'ssoAdminConsent', reason: 'admin_consent_text' };
  }
  // Sentences the backend sent to native clients before the code param existed.
  if (/already exists/i.test(text)) return { cancelled: false, key: 'ssoAccountExists', reason: 'sso_account_exists' };
  if (/account is disabled/i.test(text)) return { cancelled: false, key: 'accountDisabled', reason: 'account_disabled' };
  if (/not verified|unverified/i.test(text)) return { cancelled: false, key: 'ssoEmailUnverified', reason: 'sso_email_unverified' };
  return { cancelled: false, key: 'ssoFailed', reason: REASON_RE.test(text) ? text : 'legacy_text' };
}
