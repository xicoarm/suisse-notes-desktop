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

/**
 * @param {object} [opts]
 * @param {{ seen: () => boolean, markSeen: () => void }} [opts.echo] - persistent
 *   flag "the server has echoed state at least once on this device". After the
 *   first echo a callback without state is never accepted again (no downgrade).
 */
function createSsoFlowStore({ now = () => Date.now(), randomBytes = crypto.randomBytes, echo = null } = {}) {
  let pending = null;
  let echoSeenMemory = false;
  const echoSeen = () => {
    if (echoSeenMemory) return true;
    try { return !!(echo && echo.seen()); } catch { return false; }
  };
  const markEchoSeen = () => {
    echoSeenMemory = true;
    try { if (echo) echo.markSeen(); } catch { /* memory flag still holds */ }
  };

  return {
    /** Start a flow (replaces an older one) and return the URL parameters. */
    begin(provider) {
      const state = base64Url(randomBytes(32));
      const verifier = base64Url(randomBytes(48));
      pending = { state, verifier, provider, createdAt: now() };
      return { state, codeChallenge: pkceChallenge(verifier) };
    },

    hasPending() {
      return !!pending && now() - pending.createdAt <= FLOW_TTL_MS;
    },

    clear() { pending = null; },

    /**
     * Decide about a parsed callback.
     * - state present: must equal the pending state (success and error);
     * - no state (server without the echo, before backend «SSO state echo»):
     *   accepted only while no echo was ever seen on this device - legacy
     *   fallback, still bound to the in-memory flow this process started,
     *   reported as `legacy: true`. Otherwise ignored and the flow keeps
     *   waiting, so a foreign `error=canceled` link cannot abort the sign-in.
     * @returns {{ ok: true, verifier: string, provider: string, legacy?: boolean } | { ok: false, reason: string }}
     */
    consume(result) {
      if (!pending || now() - pending.createdAt > FLOW_TTL_MS) {
        pending = null;
        return { ok: false, reason: 'no_pending_flow' };
      }
      const state = result && typeof result.state === 'string' ? result.state : '';
      const { verifier, provider } = pending;
      if (state) {
        if (!sameString(state, pending.state)) return { ok: false, reason: 'state_mismatch' };
        markEchoSeen();
        pending = null;
        return { ok: true, verifier, provider };
      }
      if (echoSeen()) return { ok: false, reason: 'missing_state' };
      pending = null;
      return { ok: true, verifier, provider, legacy: true };
    }
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

module.exports = { boundHandoffToken, createSsoFlowStore, parseCallbackUrl, withFlowParams, pkceChallenge, FLOW_TTL_MS };
