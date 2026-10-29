'use strict';

/**
 * Desktop: bind the suissenotes://auth/callback result to a sign-in this app
 * started (main process only).
 *
 * WHY: suissenotes:// is a custom scheme; any web page or message can open
 * suissenotes://auth/callback?token=<someone's token>. Before this, such a
 * callback signed the app into that account. Now main creates a random state
 * and a PKCE verifier before it opens the browser and accepts only a callback
 * that carries the same state, once, within FLOW_TTL_MS. Results that pass are
 * marked `bound: true`; the renderer applies nothing else.
 *
 * Server contract (same as mobile, see src/services/ssoFlow.js):
 *   start:    /api/auth/<provider>/login?client=desktop&app_state=<state>
 *             &code_challenge=<S256>&code_challenge_method=S256
 *   callback: suissenotes://auth/callback?state=<state>&auth_code=<code>
 *             (legacy: &token=…&user=…, still with the echoed state)
 *   exchange: POST /api/auth/sso/exchange { authCode, codeVerifier, state }
 */

const crypto = require('crypto');

const FLOW_TTL_MS = 15 * 60 * 1000;

function base64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkceChallenge(verifier) {
  return base64Url(crypto.createHash('sha256').update(verifier).digest());
}

function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Parse a callback URL into { state, authCode } | { state, token, user } |
 * { state, error, code? } | null (not a callback).
 */
function parseCallbackUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'suissenotes:' || parsed.host !== 'auth'
    || parsed.pathname.replace(/\/$/, '') !== '/callback') return null;
  const q = parsed.searchParams;
  const state = q.get('state') || '';
  const error = q.get('error');
  const code = q.get('code');
  if (error || code) return code ? { state, error: error || code, code } : { state, error };
  const authCode = q.get('auth_code');
  if (authCode) return { state, authCode };
  const token = q.get('token');
  const userB64 = q.get('user');
  if (token && userB64) {
    try {
      const user = JSON.parse(Buffer.from(userB64, 'base64url').toString('utf8'));
      if (user && typeof user === 'object' && !Array.isArray(user)) return { state, token, user };
    } catch { /* fall through */ }
  }
  return { state, error: 'invalid_callback' };
}

const FLOW_STORE_KEY = 'ssoPendingFlow';

/** In-memory storage with the electron-store interface (tests, fallback). */
function memoryStorage() {
  const data = new Map();
  return {
    get: (k) => data.get(k),
    set: (k, v) => { data.set(k, v); },
    delete: (k) => { data.delete(k); }
  };
}

/**
 * The pending flow is kept in `storage` (configStore in main): the browser
 * sign-in may come back to a cold start of the app, which must still accept
 * the echo of its own state (S2). One flow at a time; a new one replaces it.
 * Each flow carries the session epoch it was started in (E4): it is valid only
 * while that epoch is current.
 * @param {object} [opts]
 * @param {{ get: Function, set: Function, delete: Function }} [opts.storage]
 */
function createSsoFlowStore({ now = () => Date.now(), randomBytes = crypto.randomBytes, storage = memoryStorage() } = {}) {
  const read = () => {
    try {
      const flow = storage.get(FLOW_STORE_KEY);
      if (!flow || typeof flow !== 'object' || typeof flow.state !== 'string' || !flow.state
        || typeof flow.verifier !== 'string' || typeof flow.createdAt !== 'number'
        || !Number.isSafeInteger(flow.epoch)) return null;
      return flow;
    } catch {
      return null;
    }
  };
  /** Delete and read back. @returns {boolean} confirmed gone */
  const drop = () => {
    try {
      storage.delete(FLOW_STORE_KEY);
      return storage.get(FLOW_STORE_KEY) === undefined;
    } catch {
      return false;
    }
  };
  const live = (flow) => !!flow && now() - flow.createdAt >= 0 && now() - flow.createdAt <= FLOW_TTL_MS;

  return {
    /** Start a flow in session epoch `epoch` (replaces an older one). */
    begin(provider, epoch) {
      const state = base64Url(randomBytes(32));
      const verifier = base64Url(randomBytes(48));
      storage.set(FLOW_STORE_KEY, { state, verifier, provider, epoch, createdAt: now() });
      return { state, codeChallenge: pkceChallenge(verifier) };
    },

    hasPending(epoch) {
      const flow = read();
      return live(flow) && flow.epoch === epoch;
    },

    /** The stored flow as it is (startup clean-up), or null. */
    peek() {
      return read();
    },

    /** @returns {boolean} true when no flow is left on disk */
    clear() { return drop(); },

    /**
     * Decide about a parsed callback: success and error need the pending
     * state (server «SSO state echo») and the flow's epoch must be the
     * current one. Anything else is ignored and the flow keeps waiting, so a
     * crafted link can neither sign in nor abort. A match is consumed
     * synchronously, before anything else runs (once); only a confirmed
     * delete counts.
     * @returns {{ ok: true, verifier: string, provider: string, epoch: number } | { ok: false, reason: string }}
     */
    consume(result, epoch) {
      const pending = read();
      if (!live(pending) || pending.epoch !== epoch) {
        if (pending) drop();
        return { ok: false, reason: pending ? 'stale_flow' : 'no_pending_flow' };
      }
      const state = result && typeof result.state === 'string' ? result.state : '';
      if (!state) return { ok: false, reason: 'missing_state' };
      if (!sameString(state, pending.state)) return { ok: false, reason: 'state_mismatch' };
      if (!drop()) return { ok: false, reason: 'flow_not_cleared' };
      return { ok: true, verifier: pending.verifier, provider: pending.provider, epoch: pending.epoch };
    }
  };
}

const SSO_USER_FIELDS = ['id', 'email', 'name', 'role', 'organizationId', 'organizationName', 'image', 'language', 'locale'];

function jwtUserId(token) {
  try {
    const json = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof json.userId === 'string' && json.userId ? json.userId : null;
  } catch {
    return null;
  }
}

/**
 * The user of an SSO result comes from a URL or the exchange: plain fields
 * only, and its id must be the token's own userId (same rule as the
 * renderer's sanitizeSsoUser in src/stores/auth.js).
 */
function sanitizeSsoUser(user, token) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
  const uid = jwtUserId(token);
  if (!uid || String(user.id ?? '') !== uid) return null;
  const clean = {};
  for (const key of SSO_USER_FIELDS) {
    const value = user[key];
    if (typeof value === 'string') clean[key] = value.slice(0, 320);
    else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
  }
  clean.id = uid;
  return clean;
}

/**
 * suissenotes://auth/callback -> session (desktop). Every path (legacy
 * token+user, code exchange, error) needs the flow's state; the session is
 * written only by authority.applySession with the ticket of the flow.
 * @param {object} deps
 * @param {object} deps.authority - session-authority.js
 * @param {object} deps.flows - createSsoFlowStore()
 * @param {(authCode: string, verifier: string, state: string) => Promise<object>} deps.exchange
 * @param {(payload: object) => void} deps.deliver - buffer + push to the renderer
 * @param {() => void} [deps.countMissingState] - telemetry counter, no data
 * @param {(msg: string) => void} [deps.log]
 * @returns {(url: string) => Promise<{ ignored?: string, delivered?: object }>}
 */
function createSsoCallbackHandler({ authority, flows, exchange, deliver, countMissingState = () => {}, log = () => {} }) {
  const ignored = (reason) => {
    log(`SSO: callback ignored (${reason})`);
    return { ignored: reason };
  };
  return async function handleCallback(url) {
    const parsed = parseCallbackUrl(url);
    if (!parsed) return ignored('not_a_callback');
    // E3: never switch or touch a signed-in session.
    if (!authority.state().signedOut) return ignored('already_signed_in');
    const binding = flows.consume(parsed, authority.state().epoch);
    if (!binding.ok) {
      // Only while a flow is open; codes only, no URL, no user data.
      if (binding.reason === 'missing_state') countMissingState();
      // The state was consumed but the delete is unconfirmed: no ticket or
      // stored flow of this epoch may be used again, also after a restart.
      if (binding.reason === 'flow_not_cleared') authority.invalidate();
      return ignored(binding.reason);
    }
    const ticket = { epoch: binding.epoch };
    let result;
    if (parsed.authCode) {
      result = await exchange(parsed.authCode, binding.verifier, parsed.state);
    } else if (parsed.token) {
      result = { token: parsed.token, user: parsed.user };
    } else {
      result = parsed.code ? { error: parsed.error, code: parsed.code } : { error: parsed.error };
    }
    if (!authority.isCurrent(ticket)) return ignored('session_changed');
    if (!result || result.error || !result.token) {
      const payload = { bound: true, epoch: ticket.epoch, error: (result && result.error) || 'invalid_callback' };
      if (result && result.code) payload.code = result.code;
      deliver(payload);
      return { delivered: payload };
    }
    const user = sanitizeSsoUser(result.user, result.token);
    if (!user) {
      const payload = { bound: true, epoch: ticket.epoch, error: 'invalid_callback' };
      deliver(payload);
      return { delivered: payload };
    }
    const applied = authority.applySession(ticket, { token: result.token, user }, { kind: 'sso' });
    if (!applied.applied) return ignored(applied.reason);
    const payload = { bound: true, applied: true, epoch: applied.epoch, persisted: applied.persisted, provider: binding.provider };
    deliver(payload);
    return { delivered: payload };
  };
}

function withFlowParams(loginUrl, { state, codeChallenge }) {
  const url = new URL(loginUrl);
  url.searchParams.set('app_state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Web hand-off (create-web-session): the session token only when the server
 * confirms the PKCE binding (`bound: true`, backend 10/2026). An older
 * server's 200 carries an unbound, reusable token: null (open the plain URL).
 */
function boundHandoffToken(data) {
  if (!data || data.success !== true || data.bound !== true) return null;
  return typeof data.sessionToken === 'string' && data.sessionToken ? data.sessionToken : null;
}

module.exports = { boundHandoffToken, createSsoFlowStore, createSsoCallbackHandler, sanitizeSsoUser, parseCallbackUrl, withFlowParams, pkceChallenge, FLOW_TTL_MS };
