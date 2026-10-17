'use strict';

// Second factor in the desktop password sign-in (main process side).
//
// The password sign-in runs here (IPC auth:login). It now announces
// `twoFactor: "supported"`; for a 2FA account the backend answers
// { requiresTwoFactor, twoFactorMethod, tempToken } and the renderer asks for
// the code, which comes back through the IPC handlers auth:verifyTwoFactor /
// auth:resendTwoFactorEmail. Everything the renderer sends is validated here
// before a request is built, and request URLs are built from the configured
// API base only. The format rules match src/utils/twoFactor.js.

const TWO_FACTOR_METHODS = new Set(['AUTHENTICATOR', 'EMAIL']);
// The temp token is a JWT: base64url segments and dots. Bounded length.
const TEMP_TOKEN_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,4}$/;
const OTP_RE = /^\d{6}$/;
const BACKUP_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;

const VERIFY_PATH = '/api/auth/desktop/verify-2fa';
const RESEND_PATH = '/api/auth/resend-2fa-email';

function isValidTempToken(token) {
  return typeof token === 'string' && token.length >= 16 && token.length <= 4096 && TEMP_TOKEN_RE.test(token);
}

/** Six digits (spaces/dashes from a paste removed) or a backup code; null when malformed. */
function normalizeTwoFactorCode(code, isBackupCode) {
  if (typeof code !== 'string' || code.length > 64) return null;
  if (isBackupCode) {
    const compact = code.replace(/\s/g, '').toUpperCase();
    return BACKUP_RE.test(compact) ? compact : null;
  }
  const digits = code.replace(/[\s-]/g, '');
  return OTP_RE.test(digits) ? digits : null;
}

/** Body of POST /api/auth/desktop (the password sign-in). */
function buildLoginBody({ email, password, deviceId, platform, appVersion }) {
  return { email, password, deviceId, platform, appVersion, twoFactor: 'supported' };
}

/**
 * Validated request for POST /api/auth/desktop/verify-2fa.
 * @returns {{ ok: true, url: string, body: object } | { ok: false, failure: object }}
 */
function buildVerifyRequest(apiBaseUrl, tempToken, code, isBackupCode) {
  if (!isValidTempToken(tempToken)) {
    return { ok: false, failure: { success: false, code: 'session_expired' } };
  }
  const backup = isBackupCode === true;
  const normalized = normalizeTwoFactorCode(code, backup);
  if (!normalized) {
    return { ok: false, failure: { success: false, code: backup ? 'invalid_backup_code' : 'invalid_format' } };
  }
  return { ok: true, url: `${apiBaseUrl}${VERIFY_PATH}`, body: { tempToken, code: normalized, isBackupCode: backup } };
}

/** Validated request for POST /api/auth/resend-2fa-email. */
function buildResendRequest(apiBaseUrl, tempToken) {
  if (!isValidTempToken(tempToken)) {
    return { ok: false, failure: { success: false, code: 'session_expired' } };
  }
  return { ok: true, url: `${apiBaseUrl}${RESEND_PATH}`, body: { tempToken } };
}

/** The 2FA challenge in a 2xx sign-in answer, or null (old backend / no 2FA). */
function twoFactorChallengeFrom(data) {
  if (!data || typeof data !== 'object' || data.requiresTwoFactor !== true) return null;
  if (!isValidTempToken(data.tempToken)) return null;
  return {
    success: false,
    requiresTwoFactor: true,
    twoFactorMethod: TWO_FACTOR_METHODS.has(data.twoFactorMethod) ? data.twoFactorMethod : 'AUTHENTICATOR',
    tempToken: data.tempToken
  };
}

/** A sign-in success (password or verify-2fa), or null. */
function loginSuccessFrom(data) {
  if (!data || typeof data !== 'object' || !data.token || typeof data.token !== 'string') return null;
  if (data.success === false) return null;
  return { success: true, token: data.token, user: data.user, minutes: data.minutes || null };
}

module.exports = {
  VERIFY_PATH,
  RESEND_PATH,
  isValidTempToken,
  normalizeTwoFactorCode,
  buildLoginBody,
  buildVerifyRequest,
  buildResendRequest,
  twoFactorChallengeFrom,
  loginSuccessFrom
};
