/**
 * Second factor in the apps' password sign-in (Areg, 17.10.2026).
 *
 * Until 4.7.16 POST /api/auth/desktop skipped 2FA, so the desktop and mobile
 * password sign-in bypassed it. The app now announces `twoFactor:
 * "supported"`; for an account with 2FA the backend answers
 * { requiresTwoFactor, twoFactorMethod, tempToken } and the login screen asks
 * for the code (POST /api/auth/desktop/verify-2fa). An older backend never
 * sends requiresTwoFactor - the sign-in then works exactly as before.
 *
 * Pure helpers: code formats, the code-step state, and failure -> translated
 * text. The Electron main process has the same format rules in
 * src-electron/auth-two-factor.js (tests keep them in step).
 */

import { describeLoginFailure } from './authErrors';

export const TWO_FACTOR_METHODS = Object.freeze(['AUTHENTICATOR', 'EMAIL']);
export const RESEND_COOLDOWN_MS = 60 * 1000;

const OTP_RE = /^\d{6}$/;
const BACKUP_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;

/** "123 456", "123-456" -> "123456"; null when it is not six digits. */
export function normalizeOtp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/[\s-]/g, '');
  return OTP_RE.test(digits) ? digits : null;
}

/** "a1b2 c3d4", "A1B2-C3D4" -> "A1B2C3D4" / "A1B2-C3D4"; null when malformed. The server normalises further. */
export function normalizeBackupCode(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s/g, '').toUpperCase();
  return BACKUP_RE.test(compact) ? compact : null;
}

export const isValidOtp = (value) => normalizeOtp(value) !== null;
export const isValidBackupCode = (value) => normalizeBackupCode(value) !== null;

/** Telemetry field word for a refused click, or null when the format is right. */
export function codeFieldProblem(value, { backup = false } = {}) {
  if (backup) return isValidBackupCode(value) ? null : 'backupCode:invalidFormat';
  return isValidOtp(value) ? null : 'code:invalidFormat';
}

/**
 * The challenge in a sign-in answer, or null (old backend / no 2FA).
 * @param {object} data - parsed JSON of a 2xx answer
 */
export function twoFactorChallengeFrom(data) {
  if (!data || typeof data !== 'object' || data.requiresTwoFactor !== true) return null;
  if (typeof data.tempToken !== 'string' || !data.tempToken) return null;
  const method = TWO_FACTOR_METHODS.includes(data.twoFactorMethod) ? data.twoFactorMethod : 'AUTHENTICATOR';
  return { requiresTwoFactor: true, twoFactorMethod: method, tempToken: data.tempToken };
}

/** Code-step state after a challenge. E-mail: the first code was just sent, so resending waits. */
export function startTwoFactorStep({ twoFactorMethod, tempToken }, now = Date.now()) {
  const method = TWO_FACTOR_METHODS.includes(twoFactorMethod) ? twoFactorMethod : 'AUTHENTICATOR';
  return { method, tempToken, resendAvailableAt: method === 'EMAIL' ? now + RESEND_COOLDOWN_MS : 0 };
}

/** Whole seconds until "send again" works (0 = now). */
export function resendSecondsLeft(step, now = Date.now()) {
  if (!step || step.method !== 'EMAIL') return 0;
  return Math.max(0, Math.ceil((step.resendAvailableAt - now) / 1000));
}

/** i18n key of the hint above the code field. */
export function twoFactorHintKey(method, backup) {
  if (backup) return 'twoFactorHintBackup';
  return method === 'EMAIL' ? 'twoFactorHintEmail' : 'twoFactorHintAuthenticator';
}

const VERIFY_CODES = {
  invalid_code: { key: 'twoFactorInvalidCode', next: 'stay' },
  invalid_backup_code: { key: 'twoFactorInvalidBackupCode', next: 'stay' },
  invalid_format: { key: 'twoFactorInvalidCode', next: 'stay' },
  missing_fields: { key: 'twoFactorInvalidCode', next: 'stay' },
  code_expired: { key: 'twoFactorCodeExpired', next: 'stay' },
  session_expired: { key: 'twoFactorSessionExpired', next: 'password' },
  too_many_attempts: { key: 'twoFactorTooManyAttempts', next: 'password' },
  account_disabled: { key: 'accountDisabled', next: 'password' },
  app_update_required: { key: 'appUpdateRequired', next: 'password' },
  server_error: { key: 'authServiceUnavailable', next: 'stay' }
};

/**
 * verify-2fa failure -> { key, reason, next }. `next`: 'stay' on the code
 * step, or 'password' (step over: back to the password form with the text).
 * `reason` is "2fa_<code>" / "2fa_status_<n>" for telemetry.
 */
export function describeTwoFactorFailure(failure = {}, { backup = false } = {}) {
  // Network and service problems: the same texts as the password step.
  if (failure.network || failure.networkCode || failure.nonJson || Number(failure.status) >= 500) {
    const generic = describeLoginFailure(failure);
    return { key: generic.key, reason: `2fa_${generic.reason}`.slice(0, 40), next: 'stay' };
  }
  const known = VERIFY_CODES[failure.code];
  if (known) {
    const key = failure.code === 'missing_fields' && backup ? 'twoFactorInvalidBackupCode' : known.key;
    return { key, reason: `2fa_${failure.code}`, next: known.next };
  }
  const status = Number(failure.status) || 0;
  switch (status) {
    case 400: return { key: backup ? 'twoFactorInvalidBackupCode' : 'twoFactorInvalidCode', reason: '2fa_status_400', next: 'stay' };
    case 401: return { key: 'twoFactorSessionExpired', reason: '2fa_status_401', next: 'password' };
    case 403: return { key: 'accountDisabled', reason: '2fa_status_403', next: 'password' };
    case 410: return { key: 'twoFactorCodeExpired', reason: '2fa_status_410', next: 'stay' };
    case 429: return { key: 'twoFactorTooManyAttempts', reason: '2fa_status_429', next: 'password' };
    default: return { key: 'twoFactorFailedGeneric', reason: status ? `2fa_status_${status}` : '2fa_unknown', next: 'stay' };
  }
}

/** resend-2fa-email failure -> { key, reason, next }. */
export function describeResendFailure(failure = {}) {
  if (failure.network || failure.networkCode) {
    const generic = describeLoginFailure(failure);
    return { key: generic.key, reason: `2fa_resend_${generic.reason}`.slice(0, 40), next: 'stay' };
  }
  const status = Number(failure.status) || 0;
  if (failure.code === 'session_expired' || status === 401) return { key: 'twoFactorSessionExpired', reason: '2fa_resend_expired', next: 'password' };
  if (failure.code === 'too_many_attempts' || status === 429) return { key: 'twoFactorResendTooSoon', reason: '2fa_resend_429', next: 'stay' };
  return { key: 'twoFactorResendFailed', reason: status ? `2fa_resend_status_${status}` : '2fa_resend_failed', next: 'stay' };
}
