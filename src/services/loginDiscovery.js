/**
 * Login recognition (identifier-first, 11/2026), renderer side.
 *
 * The sign-in page asks for the e-mail first; «Continue» asks the server
 * which method the address uses and goes straight there: the password field,
 * or Microsoft/Google in the system browser (desktop) or the in-app browser
 * session (phones) with the address as login hint.
 *
 * Rules (kept as plain functions with the storage passed in, so they are
 * unit-tested without a page):
 * - The new form shows only when the server switch allows it
 *   (GET /api/auth/login-mode); otherwise, and whenever the server has no
 *   answer, the form stays as before.
 * - At most ONE automatic redirect per sign-in attempt (kept in session
 *   storage, expires after 10 minutes); never when the page opens.
 * - The device remembers only the e-mail address (removable with «Not me»),
 *   never the method.
 * - Discover unreachable, 404 or any other surprise: the classic form.
 */

import { isElectron, isCapacitor, getPlatform } from '../utils/platform';

export const REMEMBERED_EMAIL_KEY = 'suisse-meets-login-email';
export const AUTO_REDIRECT_KEY = 'suisse-meets-login-auto-redirect';
export const LOGIN_MODE_CACHE_KEY = 'suisse-meets-login-mode';
export const AUTO_REDIRECT_TTL_MS = 10 * 60 * 1000;
const DISCOVER_TIMEOUT_MS = 10000;

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** Trimmed, lower-case address when it is a plain e-mail address, otherwise null (same rule as the server). */
export function normalizeLoginEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at !== email.indexOf('@')) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local) || !DOMAIN.test(domain)) return null;
  return email;
}

function safeGet(storage, key) {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function safeSet(storage, key, value) {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch { /* blocked storage: the page works without it */ }
}

export function browserStorage(kind) {
  try { return typeof window !== 'undefined' ? window[kind] : null; } catch { return null; }
}

export function readRememberedEmail(storage) {
  const value = safeGet(storage, REMEMBERED_EMAIL_KEY);
  return value && normalizeLoginEmail(value) ? value : null;
}

export function rememberEmail(storage, email) {
  const value = email ? normalizeLoginEmail(email) : null;
  safeSet(storage, REMEMBERED_EMAIL_KEY, value);
}

/** Whether this address may still be sent on automatically in this attempt. */
export function mayAutoRedirect(session, email, now = Date.now()) {
  const address = normalizeLoginEmail(email);
  if (!address) return false;
  const raw = safeGet(session, AUTO_REDIRECT_KEY);
  if (!raw) return true;
  try {
    const mark = JSON.parse(raw);
    if (!mark || mark.email !== address) return true;
    return !(typeof mark.at === 'number' && now - mark.at < AUTO_REDIRECT_TTL_MS && now >= mark.at);
  } catch {
    return true;
  }
}

export function markAutoRedirect(session, email, now = Date.now()) {
  const address = normalizeLoginEmail(email);
  if (address) safeSet(session, AUTO_REDIRECT_KEY, JSON.stringify({ email: address, at: now }));
}

export function clearAutoRedirect(session) {
  safeSet(session, AUTO_REDIRECT_KEY, null);
}

/** Last known switch position, so the page opens in the right form before the server answers. */
export function readCachedLoginMode(storage) {
  const value = safeGet(storage, LOGIN_MODE_CACHE_KEY);
  return value === 'identifier-first' || value === 'test' ? value : 'classic';
}

export function cacheLoginMode(storage, mode) {
  safeSet(storage, LOGIN_MODE_CACHE_KEY, mode === 'identifier-first' || mode === 'test' ? mode : null);
}

/** identifier-first for everyone, test only with the tester's opt-in, otherwise the classic form. */
export function identifierFirstEnabled(mode, testOptIn) {
  return mode === 'identifier-first' || (mode === 'test' && testOptIn === true);
}

/** The client name the server expects. */
export function discoverClient() {
  if (isElectron()) return 'desktop';
  if (isCapacitor()) return getPlatform() === 'ios' ? 'ios' : 'android';
  return 'web';
}

/**
 * Discover answer -> what the page does. Anything unexpected (404, 5xx, a
 * network failure, an unknown method) is { kind: 'unavailable' }: the
 * classic form, never a dead end.
 */
export function interpretDiscover(status, body) {
  const data = body && typeof body === 'object' ? body : {};
  if (status === 400 && data.error === 'invalid_email') return { kind: 'invalid_email' };
  if (status === 429) {
    const retryAfter = Number(data.retryAfter);
    return { kind: 'rate_limited', retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(Math.ceil(retryAfter), 3600) : 60 };
  }
  if (status !== 200) return { kind: 'unavailable' };
  if (data.next === 'microsoft' || data.next === 'google') return { kind: 'sso', provider: data.next };
  if (data.next === 'apple') return { kind: 'apple' };
  if (data.next === 'password') return { kind: 'password' };
  return { kind: 'unavailable' };
}

async function requestJson(endpoint, options) {
  const { apiRequest, parseJsonSafe } = await import('./api');
  const response = await apiRequest(endpoint, { ...options, timeoutMs: DISCOVER_TIMEOUT_MS });
  const body = await parseJsonSafe(response);
  return { status: response.status, body: body?.nonJson ? null : body };
}

/** POST /api/auth/discover. Never throws. */
export async function discoverSignIn(email) {
  try {
    if (isElectron()) {
      const auth = window.electronAPI?.auth;
      if (typeof auth?.discover !== 'function') return { kind: 'unavailable' };
      const answer = await auth.discover(email);
      return interpretDiscover(answer?.status, answer);
    }
    const address = normalizeLoginEmail(email);
    if (!address) return { kind: 'invalid_email' };
    const { status, body } = await requestJson('/api/auth/discover', {
      method: 'POST',
      body: JSON.stringify({ email: address, client: discoverClient() }),
      // No waiting on a restarting server: the classic form is the answer then.
      retryGateway: false
    });
    return interpretDiscover(status, body);
  } catch {
    return { kind: 'unavailable' };
  }
}

/** GET /api/auth/login-mode -> { mode, testOptIn }. Never throws; anything unusable is classic. */
export async function fetchLoginMode() {
  try {
    if (isElectron()) {
      const auth = window.electronAPI?.auth;
      if (typeof auth?.loginMode !== 'function') return { mode: 'classic', testOptIn: false };
      const answer = await auth.loginMode();
      const mode = answer?.mode === 'identifier-first' || answer?.mode === 'test' ? answer.mode : 'classic';
      return { mode, testOptIn: answer?.testOptIn === true };
    }
    const { status, body } = await requestJson('/api/auth/login-mode', { method: 'GET', retryGateway: false });
    const mode = status === 200 && (body?.mode === 'identifier-first' || body?.mode === 'test') ? body.mode : 'classic';
    return { mode, testOptIn: false };
  } catch {
    return { mode: 'classic', testOptIn: false };
  }
}

/** Phone start URL of Microsoft/Google with the url-encoded login hint (a bad address is dropped). */
export function mobileSsoUrl(apiBase, provider, platform, loginHint) {
  const url = `${apiBase}/api/auth/${provider}/login?client=${platform}`;
  const hint = normalizeLoginEmail(loginHint);
  return hint ? `${url}&login_hint=${encodeURIComponent(hint)}` : url;
}
