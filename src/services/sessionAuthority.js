/**
 * Mobile session authority: the one place that decides whether the app is
 * signed in, and the only writer of token and user (iOS Keychain / Android
 * Keystore through secureStorage.js). Desktop has its own in the main process
 * (src-electron/session-authority.js); the renderer there only mirrors it.
 *
 * Rules (security review 10/2026, round 6):
 * - E1 One record {epoch, signedOut} in one localStorage entry. Missing or
 *   unreadable = signed out. The marker of the previous version
 *   (auth.signedOut=1) also counts as signed out.
 * - E2 Every asynchronous sign-in takes a ticket (the epoch) when it starts;
 *   token and user are written only by applySession(ticket, result).
 * - E3 applySession and signOut run one after the other (mutex). A stale
 *   ticket, or an SSO result while a session exists, is dropped without any
 *   side effect. A refresh applies only with the same epoch and userId.
 * - E4 Every session change increments the epoch and ends the pending SSO
 *   flow; a stored flow is valid only with the current epoch (ssoFlow.js).
 * - E5 Sign-out: 1. record {epoch+1, signedOut} written and read back, RAM
 *   lock (immediately, before waiting for the mutex); 3. token, user, legacy
 *   copies, flow deleted. Success only when 1 and 3 are confirmed; otherwise
 *   every start deletes again. (BLE clean-up: the auth store, afterwards.)
 * - E6 While signed out nothing reads the token (getToken in secureStorage.js
 *   is null) and a start restores nothing.
 * - E8 A failed or impossible write never counts as success. When the record
 *   cannot be written at sign-in, the session lives in memory only.
 * - E9 Sign-in: tombstone with the new epoch, then token and user, then the
 *   record {epoch, signedOut:false}. Sign-out: record first, then delete.
 */

import {
  AUTH_KEYS, STORAGE_KEYS, LEGACY_SIGNED_OUT_MARKER, setSecureItem, readSecureItem, removeSecureItem,
  purgeLegacyAuthPreferences
} from './secureStorage';
import { clearSsoFlowConfirmed, peekSsoFlow } from './ssoFlow';

export const RECORD_KEY = 'auth.session.v1';

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function tokenUserId(token) {
  try {
    const std = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(std + '='.repeat((4 - (std.length % 4)) % 4)));
    return typeof json.userId === 'string' && json.userId ? json.userId : null;
  } catch {
    return null;
  }
}

function parseRecord(text) {
  if (typeof text !== 'string') return null;
  try {
    const rec = JSON.parse(text);
    if (!rec || typeof rec !== 'object' || !Number.isSafeInteger(rec.epoch) || typeof rec.signedOut !== 'boolean') return null;
    return { epoch: rec.epoch, signedOut: rec.signedOut };
  } catch {
    return null;
  }
}

function readRecord() {
  const store = storage();
  if (!store) return { epoch: -1, signedOut: true, unreadable: true };
  try {
    const legacyMarker = store.getItem(LEGACY_SIGNED_OUT_MARKER) === '1';
    const text = store.getItem(RECORD_KEY);
    if (text === null) return { epoch: 0, signedOut: true, missing: true };
    const rec = parseRecord(text);
    if (!rec) return { epoch: -1, signedOut: true, unreadable: true };
    return legacyMarker ? { epoch: rec.epoch, signedOut: true } : rec;
  } catch {
    return { epoch: -1, signedOut: true, unreadable: true };
  }
}

/** Write the record and read it back. @returns {boolean} confirmed */
function persist(epoch, signedOut) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(RECORD_KEY, JSON.stringify({ epoch, signedOut }));
    const back = parseRecord(store.getItem(RECORD_KEY));
    if (!back || back.epoch !== epoch || back.signedOut !== signedOut) return false;
    if (!signedOut) {
      // The previous version's marker would keep the next start signed out.
      store.removeItem(LEGACY_SIGNED_OUT_MARKER);
      if (store.getItem(LEGACY_SIGNED_OUT_MARKER) !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}

let ram = null;
let memorySession = null; // { token, user } of a session that lives in memory only
let chain = Promise.resolve();

const state = () => {
  if (!ram) ram = readRecord();
  return ram;
};

const nextEpoch = () => (state().epoch < 0 ? Math.max(1, Date.now()) : state().epoch + 1);

/** Serialize applySession and the persistent part of signOut (E3). */
function serialized(task) {
  const run = chain.then(task, task);
  chain = run.then(() => {}, () => {});
  return run;
}

/** E2: the ticket an asynchronous sign-in takes when it starts. */
export function sessionTicket(extra = {}) {
  return Object.freeze({ ...extra, epoch: state().epoch });
}

export function isCurrentTicket(ticket) {
  return !!ticket && ticket.epoch === state().epoch;
}

export function currentEpoch() {
  return state().epoch;
}

/** E6: true while signed out (also: record missing or unreadable). */
export function isSignedOut() {
  return state().signedOut;
}

/** The in-memory session (record not writable at sign-in), or null. */
export function memoryOnlySession() {
  return state().signedOut ? null : memorySession;
}

/**
 * Apply a sign-in result.
 * @param {{ epoch: number, userId?: string }} ticket
 * @param {{ token: string, user?: object }} result
 * @param {{ kind: 'login'|'sso'|'refresh' }} opts
 * @returns {Promise<{ applied: true, epoch: number, persisted: boolean } | { applied: false, reason: string }>}
 */
export function applySession(ticket, result, { kind } = {}) {
  return serialized(async () => {
    if (!isCurrentTicket(ticket)) return { applied: false, reason: 'session_changed' };
    const token = result && typeof result.token === 'string' ? result.token : '';
    if (!token) return { applied: false, reason: 'invalid_result' };
    const user = result.user && typeof result.user === 'object' && !Array.isArray(result.user) ? result.user : null;

    if (kind === 'refresh') {
      if (state().signedOut) return { applied: false, reason: 'signed_out' };
      const uid = tokenUserId(token);
      if (!uid || uid !== ticket.userId) return { applied: false, reason: 'user_mismatch' };
      const sameUser = !!user && String(user.id ?? '') === uid;
      if (memorySession) {
        memorySession = { token, user: sameUser ? user : memorySession.user };
        return { applied: true, epoch: state().epoch, persisted: false };
      }
      const saved = await setSecureItem(STORAGE_KEYS.AUTH_TOKEN, token);
      if (sameUser) await setSecureItem(STORAGE_KEYS.USER_INFO, JSON.stringify(user));
      // A sign-out while the keystore was written wins (it deletes after us).
      if (!isCurrentTicket(ticket)) return { applied: false, reason: 'session_changed' };
      return { applied: true, epoch: state().epoch, persisted: !!saved.success };
    }

    if (kind !== 'login' && kind !== 'sso') return { applied: false, reason: 'invalid_kind' };
    if (!user) return { applied: false, reason: 'invalid_result' };
    if (kind === 'sso' && !state().signedOut) return { applied: false, reason: 'already_signed_in' };

    const epoch = nextEpoch();
    // Tombstone with the new epoch first: a crash until the commit below ends
    // signed out, never in a mix of the old and the new session.
    const pre = persist(epoch, true);
    ram = { epoch, signedOut: true };
    memorySession = null;
    clearSsoFlowConfirmed();

    let persisted = false;
    if (pre) {
      const saved = await setSecureItem(STORAGE_KEYS.AUTH_TOKEN, token);
      const info = saved.success ? await setSecureItem(STORAGE_KEYS.USER_INFO, JSON.stringify(user)) : { success: false };
      // A sign-out while the keystore was written wins (E3).
      if (state().epoch !== epoch) return { applied: false, reason: 'session_changed' };
      if (saved.success && info.success) persisted = persist(epoch, false);
    } else {
      // E8: memory only, and nothing of an older session stays restorable.
      for (const key of AUTH_KEYS) await removeSecureItem(key);
      if (state().epoch !== epoch) return { applied: false, reason: 'session_changed' };
    }
    if (!persisted) memorySession = { token, user };
    ram = { epoch, signedOut: false };
    return { applied: true, epoch, persisted };
  });
}

/**
 * E5: sign out. The RAM lock holds from the first line on (before waiting
 * for a running applySession), also when a write fails.
 * @returns {Promise<{ success: boolean, epoch: number, error?: string }>}
 */
export function signOut() {
  const epoch = nextEpoch();
  ram = { epoch, signedOut: true };
  memorySession = null;
  return serialized(async () => {
    // A later session change (sign-in after this sign-out) is not undone.
    const latest = state().epoch === epoch;
    const recordOk = latest ? persist(epoch, true) : true;
    let deleted = true;
    if (latest) {
      for (const key of AUTH_KEYS) {
        const result = await removeSecureItem(key);
        if (!result.success) deleted = false;
      }
      if (!(await purgeLegacyAuthPreferences())) deleted = false;
      if (!clearSsoFlowConfirmed()) deleted = false;
    }
    const success = recordOk && deleted;
    return success ? { success: true, epoch } : { success: false, epoch, error: 'sign_out_incomplete' };
  });
}

/**
 * Invalidate every ticket and stored flow without a session change (a
 * consumed flow whose delete could not be confirmed).
 */
export function invalidateTickets() {
  const epoch = nextEpoch();
  const written = state().signedOut ? persist(epoch, true) : false;
  ram = { ...state(), epoch, unreadable: !!state().unreadable && !written };
}

/**
 * Start: the stored session, or signed out. Purges the legacy plaintext
 * copies (T2). While signed out the deletes run again (E5) and nothing is
 * restored (E6); a stored SSO flow survives only with the current epoch.
 * @returns {Promise<{ signedOut: true } | { signedOut: false, token: string, user: object, epoch: number }>}
 */
export function loadSession() {
  return serialized(async () => {
    await purgeLegacyAuthPreferences();
    const current = state();
    if (current.signedOut) {
      for (const key of AUTH_KEYS) await removeSecureItem(key);
      const flow = peekSsoFlow();
      if (flow && (current.unreadable || flow.epoch !== current.epoch)) clearSsoFlowConfirmed();
      return { signedOut: true };
    }
    const tokenRead = await readSecureItem(STORAGE_KEYS.AUTH_TOKEN);
    const userRead = await readSecureItem(STORAGE_KEYS.USER_INFO);
    if (state() !== current) return { signedOut: true };
    if (!tokenRead.ok || !userRead.ok || !tokenRead.value || !userRead.value) return { signedOut: true };
    let user = null;
    try { user = JSON.parse(userRead.value); } catch { user = null; }
    if (!user || typeof user !== 'object' || Array.isArray(user)) return { signedOut: true };
    const uid = tokenUserId(tokenRead.value);
    if (uid && String(user.id ?? '') !== uid) return { signedOut: true, mismatch: true };
    return { signedOut: false, token: tokenRead.value, user, epoch: current.epoch };
  });
}
