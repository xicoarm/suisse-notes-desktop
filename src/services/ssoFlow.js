/**
 * Binds an SSO callback to a sign-in the app itself started (mobile).
 *
 * WHY: suissenotes://auth/callback is a custom scheme. Any web page, message,
 * QR code or (on Android) another app can open it. Before this, a callback
 * nobody asked for signed the app into whatever account the link carried, and
 * the queued recordings of the previous user then uploaded there.
 *
 * Before the browser opens, the app creates
 *   - a random `state` (sent as `app_state`, echoed back as `state`), and
 *   - a PKCE verifier; its S256 challenge goes to the server.
 * A callback is accepted only when its `state` equals a pending flow; the flow
 * is single-use and expires after FLOW_TTL_MS.
 *
 * Server contract (see the PR description):
 *   start:    /api/auth/<provider>/login?client=ios|android|desktop
 *             &app_state=<state>&code_challenge=<S256>&code_challenge_method=S256
 *   callback: suissenotes://auth/callback?state=<state>&auth_code=<one-time code>
 *             (until the server has the code exchange: &token=…&user=…, still
 *             with the echoed state)
 *   exchange: POST /api/auth/sso/exchange { authCode, codeVerifier, state }
 *             -> { success, token, user }
 *
 * The server must echo `state` (backend «SSO state echo»); without it no SSO
 * result is accepted. The app release ships only after that server change.
 *
 * The pending flow is kept in localStorage so an Android process death while
 * the browser is in front does not lose it; it holds no credential (the
 * verifier is useless without the one-time code that only the server issues
 * to the redirect).
 */

export const FLOW_TTL_MS = 15 * 60 * 1000;
const STORAGE_KEY = 'sso.pendingFlow.v1';

function base64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function pkceChallenge(verifier) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function readFlow() {
  const store = storage();
  if (!store) return memoryFlow;
  try {
    const raw = store.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

let memoryFlow = null;
function writeFlow(flow) {
  memoryFlow = flow;
  const store = storage();
  if (!store) return;
  try {
    if (flow) store.setItem(STORAGE_KEY, JSON.stringify(flow));
    else store.removeItem(STORAGE_KEY);
  } catch { /* memory copy still holds it */ }
}

/**
 * Consume the pending flow: delete it from storage and read back. Only a
 * confirmed delete counts (S1: once) - otherwise the same state could be
 * accepted again later.
 * @returns {boolean}
 */
function deleteFlowConfirmed() {
  memoryFlow = null;
  const store = storage();
  if (!store) return true;
  try {
    store.removeItem(STORAGE_KEY);
    return store.getItem(STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

/**
 * Start a flow. Replaces any older pending one (only the newest sign-in may
 * complete).
 * @returns {Promise<{ state: string, codeChallenge: string }>}
 */
export async function beginSsoFlow(provider, now = Date.now()) {
  const state = randomToken(32);
  const verifier = randomToken(48);
  const codeChallenge = await pkceChallenge(verifier);
  writeFlow({ state, verifier, provider, createdAt: now });
  return { state, codeChallenge };
}

/** Add the binding parameters to the server's login start URL. */
export function withFlowParams(loginUrl, { state, codeChallenge }) {
  const url = new URL(loginUrl);
  url.searchParams.set('app_state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** True while a flow the user started is waiting for its callback. */
export function hasPendingSsoFlow(now = Date.now()) {
  const flow = readFlow();
  return !!flow && now - flow.createdAt <= FLOW_TTL_MS && now >= flow.createdAt - 60000;
}

export function clearSsoFlow() {
  writeFlow(null);
}

function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Decide whether a callback payload belongs to the pending flow, and consume
 * the flow if it does.
 * - state present: must equal the pending flow's state (success and error).
 *   The flow is read from storage, so this also works after an Android
 *   process restart while the browser was in front;
 * - local abort (`local: true`, set only by this app's own code for a browser
 *   the user closed, never by a URL): ends the pending flow;
 * - anything else (no state, foreign state) is ignored and the flow keeps
 *   waiting: a crafted link can neither sign the app in nor abort a sign-in.
 * Requires the server to echo `state` (backend «SSO state echo»).
 * @returns {{ ok: true, verifier: string, provider: string } | { ok: false, reason: string }}
 */
export function consumeSsoFlow(payload, now = Date.now()) {
  const flow = readFlow();
  if (!flow || !hasPendingSsoFlow(now)) {
    if (flow) writeFlow(null);
    return { ok: false, reason: 'no_pending_flow' };
  }
  const isSuccess = !!(payload && (payload.token || payload.authCode));
  const state = payload && typeof payload.state === 'string' ? payload.state : '';
  if (state) {
    if (!sameString(state, flow.state)) return { ok: false, reason: 'state_mismatch' };
    if (!deleteFlowConfirmed()) return { ok: false, reason: 'flow_not_cleared' };
    return { ok: true, verifier: flow.verifier, provider: flow.provider };
  }
  if (!isSuccess && payload && payload.local === true) {
    if (!deleteFlowConfirmed()) return { ok: false, reason: 'flow_not_cleared' };
    return { ok: true, verifier: flow.verifier, provider: flow.provider };
  }
  return { ok: false, reason: 'missing_state' };
}
