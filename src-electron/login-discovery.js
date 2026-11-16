/**
 * Login recognition, main process side (identifier-first, 11/2026).
 *
 * The sign-in page asks the server which method an address uses
 * (POST /api/auth/discover) and which form the server switch allows
 * (GET /api/auth/login-mode). Both requests go through main like every other
 * auth request: the configured API base only, a short timeout, and only the
 * known fields of the answer reach the renderer.
 *
 * Microsoft/Google in the system browser get the address as login_hint, so
 * the provider opens that account directly. The address is checked strictly
 * here again (the renderer is not trusted with what goes into a URL).
 */

const DISCOVER_PATH = '/api/auth/discover';
const LOGIN_MODE_PATH = '/api/auth/login-mode';
const SSO_PROVIDERS = new Set(['microsoft', 'google']);
const NEXT_METHODS = new Set(['password', 'microsoft', 'google', 'apple']);
const LOGIN_MODES = new Set(['classic', 'identifier-first', 'test']);
const REQUEST_TIMEOUT_MS = 10000;

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** Trimmed, lower-case address when it is a plain e-mail address, otherwise null (same rule as the server). */
function normalizeLoginEmail(raw) {
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

/** Start URL of the system-browser sign-in; a valid login hint is added url-encoded, anything else is dropped. */
function buildSsoLoginUrl(apiBase, provider, loginHint) {
  if (!SSO_PROVIDERS.has(provider)) throw new Error('unknown provider');
  const url = `${apiBase}/api/auth/${provider}/login?client=desktop`;
  const hint = normalizeLoginEmail(loginHint);
  return hint ? `${url}&login_hint=${encodeURIComponent(hint)}` : url;
}

/** Only the contract fields of a discover answer; anything else becomes "unusable" (status 0). */
function pickDiscoverAnswer(status, data) {
  const body = data && typeof data === 'object' ? data : {};
  if (status === 200) {
    if (!NEXT_METHODS.has(body.next)) return { status: 0 };
    return { status, next: body.next };
  }
  if (status === 400 && body.error === 'invalid_email') return { status, error: 'invalid_email' };
  if (status === 429) {
    const retryAfter = Number(body.retryAfter);
    return { status, error: 'rate_limited', retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(Math.ceil(retryAfter), 3600) : 60 };
  }
  return { status: Number(status) || 0 };
}

/**
 * POST /api/auth/discover {email, client: "desktop"}. Never throws: a network
 * failure, timeout or unexpected answer is { status: 0 } and the page shows
 * the classic form.
 */
async function discover(axios, apiBase, rawEmail) {
  const email = normalizeLoginEmail(rawEmail);
  if (!email) return { status: 400, error: 'invalid_email' };
  try {
    const response = await axios.post(`${apiBase}${DISCOVER_PATH}`, { email, client: 'desktop' }, {
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
      headers: { 'Content-Type': 'application/json' }
    });
    return pickDiscoverAnswer(response.status, response.data);
  } catch {
    return { status: 0 };
  }
}

/** Test opt-in for the switch position "test": start argument --login-discovery or SUISSE_MEETS_LOGIN_DISCOVERY=1. */
function testOptIn(argv = process.argv, env = process.env) {
  return (Array.isArray(argv) && argv.includes('--login-discovery')) || env.SUISSE_MEETS_LOGIN_DISCOVERY === '1';
}

/**
 * GET /api/auth/login-mode -> { mode, testOptIn }. A server without the
 * endpoint (404), an error or an unknown value is "classic": the form as
 * before, so the switch keeps the new form dark.
 */
async function loginMode(axios, apiBase, { argv, env } = {}) {
  const optIn = testOptIn(argv, env);
  try {
    const response = await axios.get(`${apiBase}${LOGIN_MODE_PATH}`, {
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true
    });
    const mode = response.status === 200 && response.data && LOGIN_MODES.has(response.data.mode)
      ? response.data.mode
      : 'classic';
    return { mode, testOptIn: optIn };
  } catch {
    return { mode: 'classic', testOptIn: optIn };
  }
}

module.exports = {
  DISCOVER_PATH,
  LOGIN_MODE_PATH,
  normalizeLoginEmail,
  buildSsoLoginUrl,
  pickDiscoverAnswer,
  discover,
  loginMode,
  testOptIn
};
