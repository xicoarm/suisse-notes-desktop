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
 * to the redirect). It carries the session epoch it was started in
 * (sessionAuthority.js, E4) and is valid only while that epoch is current.
 * There is no path that accepts a result without the state (E10).
 */

import { currentEpoch, invalidateTickets } from './sessionAuthority';

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

const validFlow = (flow) => !!flow && typeof flow === 'object' && typeof flow.state === 'string' && !!flow.state
  && typeof flow.verifier === 'string' && typeof flow.createdAt === 'number' && Number.isSafeInteger(flow.epoch);

// Copy of this run's flow; `persisted` says whether storage holds it too.
let memoryFlow = null;

function readFlow() {
  const store = storage();
  if (!store) return memoryFlow;
  try {
    const raw = store.getItem(STORAGE_KEY);
    const flow = raw ? JSON.parse(raw) : null;
    return validFlow(flow) ? flow : null;
  } catch { return null; }
}

function writeFlow(flow) {
  const store = storage();
  let persisted = false;
  if (store) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(flow));
      persisted = true;
    } catch { /* memory copy still holds it */ }
  }
  memoryFlow = { ...flow, persisted };
}

/**
 * Delete the stored flow and read back. Only a confirmed delete counts (S1:
 * once): without storage access a flow that was stored cannot be confirmed
 * gone, so it is not.
 * @returns {boolean}
 */
export function clearSsoFlowConfirmed() {
  const wasPersisted = !memoryFlow || memoryFlow.persisted !== false;
  memoryFlow = null;
  const store = storage();
  if (!store) return !wasPersisted;
  try {
    store.removeItem(STORAGE_KEY);
    return store.getItem(STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

/** The stored flow as it is (start clean-up), or null. */
export function peekSsoFlow() {
  return readFlow();
}

/**
 * Start a flow in the current session epoch. Replaces any older pending one
 * (only the newest sign-in may complete).
 * @returns {Promise<{ state: string, codeChallenge: string }>}
 */
export async function beginSsoFlow(provider, now = Date.now()) {
  const state = randomToken(32);
  const verifier = randomToken(48);
  const codeChallenge = await pkceChallenge(verifier);
  writeFlow({ state, verifier, provider, epoch: currentEpoch(), createdAt: now });
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

const live = (flow, now) => !!flow && now - flow.createdAt <= FLOW_TTL_MS && now >= flow.createdAt - 60000
  && flow.epoch === currentEpoch();

/** True while a flow the user started is waiting for its callback. */
export function hasPendingSsoFlow(now = Date.now()) {
  return live(readFlow(), now);
}

export function clearSsoFlow() {
  clearSsoFlowConfirmed();
}

/**
 * The in-app browser this app opened ended without a callback URL (user
 * closed it, the native session failed). Not a result: it can never sign in.
 * @returns {boolean} true when a pending flow was ended
 */
export function endSsoFlowLocally(now = Date.now()) {
  const pending = hasPendingSsoFlow(now);
  if (pending) clearSsoFlowConfirmed();
  return pending;
}

function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Decide whether a callback payload belongs to the pending flow, and consume
 * the flow if it does. Success and error alike need the pending flow's state
 * and the flow's epoch must be current (E4). Anything else (no state,
 * foreign state) is ignored and the flow keeps waiting: a crafted link can
 * neither sign the app in nor abort a sign-in. The flow is read from storage,
 * so this also works after an Android process restart.
 * Requires the server to echo `state` (backend «SSO state echo»).
 * @returns {{ ok: true, verifier: string, provider: string, epoch: number } | { ok: false, reason: string }}
 */
export function consumeSsoFlow(payload, now = Date.now()) {
  const flow = readFlow();
  if (!live(flow, now)) {
    if (flow) clearSsoFlowConfirmed();
    return { ok: false, reason: flow ? 'stale_flow' : 'no_pending_flow' };
  }
  const state = payload && typeof payload.state === 'string' ? payload.state : '';
  if (!state) return { ok: false, reason: 'missing_state' };
  if (!sameString(state, flow.state)) return { ok: false, reason: 'state_mismatch' };
  if (!clearSsoFlowConfirmed()) {
    // Consumed but not confirmed gone: no stored flow or ticket of this
    // epoch may be used again, also after a restart (E8).
    invalidateTickets();
    return { ok: false, reason: 'flow_not_cleared' };
  }
  return { ok: true, verifier: flow.verifier, provider: flow.provider, epoch: flow.epoch };
}
