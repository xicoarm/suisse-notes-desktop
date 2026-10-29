/**
 * Mobile session authority: the one place that decides whether the app is
 * signed in, and the only writer of token and user (iOS Keychain / Android
 * Keystore through secureStorage.js). Desktop has its own in the main process
 * (src-electron/session-authority.js); the renderer there only mirrors it.
 *
 * Rules (security review 10/2026, round 6):
 * - E1 One record {epoch, signedOut} in one localStorage entry. Unreadable
 *   (present, but a read or parse error) = signed out. The marker of the
 *   previous version (auth.signedOut=1) also counts as signed out.
 * - E1 addendum of the lead (review round 7): a MISSING record is the first
 *   start after the update. loadSession() takes a keystore session over ONCE
 *   when there is no marker auth.signedOut=1 and token and user carry the
 *   same, present userId: {epoch:0, signedOut:false} written and read back,
 *   then the one-time mark (in the keystore, so it outlives web storage),
 *   then released. Any error: RAM lock only, nothing deleted, the next start
 *   tries again. A record missing after the mark counts as unreadable. Only
 *   intermediate builds have a keystore session: the release kept it in
 *   plaintext Preferences, which stays discarded (T2) - those users sign in
 *   once after the update.
 * - Migration error matrix (review round 8, as on desktop): only a CONFIRMED
 *   missing (or invalid) pair is a decision (tombstone + mark + delete);
 *   every read or write error of record, mark, token or user is «held»: RAM
 *   lock, nothing deleted, nothing marked, the next start tries again. A
 *   signed-in record is released by loadSession() only with a confirmed mark
 *   and a readable session - until then the state is signed out.
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
/** One-time migration mark (keystore entry). */
export const MIGRATION_MARK_KEY = 'auth.sessionMigrated';

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

/**
 * The record as the RAM state. Signed in only through loadSession() (mark
 * confirmed, session readable): until then `release` waits. Web storage
 * missing or a read error: held (round 8) - signed out in RAM, nothing
 * deleted, loadSession() reads again.
 */
function readRecord() {
  const store = storage();
  if (!store) return { epoch: -1, signedOut: true, held: true };
  try {
    const legacyMarker = store.getItem(LEGACY_SIGNED_OUT_MARKER) === '1';
    const text = store.getItem(RECORD_KEY);
    // Missing: the first start after the update (loadSession decides);
    // with the previous version's marker it is a sign-out.
    if (text === null) return legacyMarker ? { epoch: 0, signedOut: true, missing: true, legacyMarker: true } : { epoch: 0, signedOut: true, missing: true };
    const rec = parseRecord(text);
    if (!rec) return { epoch: -1, signedOut: true, unreadable: true };
    if (legacyMarker || rec.signedOut) return { epoch: rec.epoch, signedOut: true };
    return { epoch: rec.epoch, signedOut: true, release: true };
  } catch {
    return { epoch: -1, signedOut: true, held: true };
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
      // A missing record is never the first start after the update any more;
      // without a confirmed mark the next start holds (round 8).
      if (persisted) await confirmMark();
      if (state().epoch !== epoch) return { applied: false, reason: 'session_changed' };
    } else {
      // E8: memory only, and nothing of an older session stays restorable.
      let removed = true;
      for (const key of AUTH_KEYS) {
        if (!(await removeSecureItem(key)).success) removed = false;
      }
      if (state().epoch !== epoch) return { applied: false, reason: 'session_changed' };
      // E9 (r6 low finding): the old keystore session could come back under
      // this one after a restart - RAM lock instead, nothing new.
      if (!removed) return { applied: false, reason: 'storage_unavailable' };
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
  if (state().signedOut) {
    // E9 (r6 low finding): not written - treated as unreadable from here on.
    ram = { epoch, signedOut: true, unreadable: !persist(epoch, true) };
  } else {
    ram = { ...state(), epoch };
  }
}

/** Copy of the RAM state (tests, diagnostics). */
export function sessionState() {
  const { epoch, signedOut, unreadable, held } = state();
  return { epoch, signedOut, unreadable: !!unreadable, migrationPending: !!held };
}

/** The one-time mark, confirmed: read, or written and read back. An unreadable mark is not written blindly. */
async function confirmMark() {
  const mark = await readSecureItem(MIGRATION_MARK_KEY);
  if (!mark.ok) return false;
  if (mark.value !== null) return true;
  return (await setSecureItem(MIGRATION_MARK_KEY, '1')).success === true;
}

const sameUserPair = (token, user) => {
  const uid = tokenUserId(token);
  // Strict: both ids present and the same (string or number, as elsewhere).
  return !!uid && !!user && typeof user === 'object' && !Array.isArray(user)
    && (typeof user.id === 'string' || typeof user.id === 'number') && String(user.id) === uid;
};

/**
 * E1 addendum: the one-time migration (see the header). Runs inside the
 * mutex, record missing.
 * @returns {Promise<{ outcome: 'migrated', token: string, user: object } | { outcome: 'none', tombstone: boolean } | { outcome: 'held' | 'unreadable' }>}
 */
async function migrate(current) {
  const mark = await readSecureItem(MIGRATION_MARK_KEY);
  if (!mark.ok) return { outcome: 'held' };
  if (mark.value !== null) return { outcome: 'unreadable' };
  let token = null;
  let user = null;
  if (!current.legacyMarker) {
    const tokenRead = await readSecureItem(STORAGE_KEYS.AUTH_TOKEN);
    const userRead = await readSecureItem(STORAGE_KEYS.USER_INFO);
    if (!tokenRead.ok || !userRead.ok) return { outcome: 'held' };
    token = tokenRead.value;
    try { user = userRead.value ? JSON.parse(userRead.value) : null; } catch { user = null; }
  }
  if (!token || !sameUserPair(token, user)) {
    // A confirmed missing or invalid pair: signed out as before; the
    // decision is kept (tombstone, then mark). Either write not confirmed:
    // held, nothing deleted (round 8).
    if (!persist(0, true)) return { outcome: 'held' };
    if (!(await setSecureItem(MIGRATION_MARK_KEY, '1')).success) return { outcome: 'held' };
    return { outcome: 'none', tombstone: true };
  }
  if (!persist(0, false)) return { outcome: 'held' };
  if (!(await setSecureItem(MIGRATION_MARK_KEY, '1')).success) return { outcome: 'held' };
  return { outcome: 'migrated', token, user };
}

/**
 * Start: the stored session, or signed out. Purges the legacy plaintext
 * copies (T2). While signed out the deletes run again (E5) and nothing is
 * restored (E6); a stored SSO flow survives only with the current epoch.
 * @returns {Promise<{ signedOut: true } | { signedOut: false, token: string, user: object, epoch: number }>}
 */
/** Token and user from the keystore, with the userId check. Nothing is deleted. */
async function readStoredSession() {
  const tokenRead = await readSecureItem(STORAGE_KEYS.AUTH_TOKEN);
  const userRead = await readSecureItem(STORAGE_KEYS.USER_INFO);
  if (!tokenRead.ok || !userRead.ok) return { held: true };
  if (!tokenRead.value || !userRead.value) return { signedOut: true };
  let user = null;
  try { user = JSON.parse(userRead.value); } catch { user = null; }
  if (!user || typeof user !== 'object' || Array.isArray(user)) return { signedOut: true };
  const uid = tokenUserId(tokenRead.value);
  if (uid && String(user.id ?? '') !== uid) return { signedOut: true, mismatch: true };
  return { token: tokenRead.value, user };
}

/**
 * R-S5 (review round 9): a session released in this run (sign-in, SSO,
 * refresh, migration, an earlier loadSession, also memory only) gives token
 * and user on every call, read and checked like at the release. A read
 * error holds (signed out in RAM, nothing deleted, the next call reads
 * again); a missing or mismatching keystore session returns to «release
 * pending» (signed out in RAM, nothing deleted). Invariant:
 * loadSession().signedOut === isSignedOut().
 */
async function loadReleased(current) {
  if (memorySession) return { signedOut: false, token: memorySession.token, user: memorySession.user, epoch: current.epoch };
  const read = await readStoredSession();
  // A sign-out meanwhile wins; invalidateTickets keeps the session (new epoch).
  const now = state();
  if (now.signedOut) return { signedOut: true };
  if (read.held) {
    ram = { epoch: now.epoch, signedOut: true, held: true };
    return { signedOut: true };
  }
  if (read.signedOut) {
    ram = { epoch: now.epoch, signedOut: true, release: true };
    return read;
  }
  return { signedOut: false, token: read.token, user: read.user, epoch: now.epoch };
}

export function loadSession() {
  return serialized(async () => {
    await purgeLegacyAuthPreferences();
    // Held before (a read or write failed): read again. An epoch this run
    // already moved past (invalidateTickets) never comes back.
    if (state().held) {
      const before = state().epoch;
      ram = readRecord();
      if (ram.release && ram.epoch < before) ram = { ...ram, epoch: before };
    }
    let current = state();
    if (current.held) return { signedOut: true };
    if (!current.signedOut) return loadReleased(current);
    if (current.missing) {
      const result = await migrate(current);
      // A sign-in or sign-out meanwhile wins.
      if (state() !== current) return { signedOut: true };
      if (result.outcome === 'migrated') {
        ram = { epoch: 0, signedOut: false };
        return { signedOut: false, token: result.token, user: result.user, epoch: 0 };
      }
      if (result.outcome === 'held') {
        // RAM lock only; nothing deleted, the next start tries again.
        ram = { epoch: 0, signedOut: true, missing: true, held: true };
        return { signedOut: true };
      }
      if (result.outcome === 'unreadable') ram = { epoch: -1, signedOut: true, unreadable: true };
      else if (result.tombstone) ram = { epoch: 0, signedOut: true };
      current = state();
    } else if (!current.unreadable) {
      // From now on a missing record is never the first start after the
      // update: the mark, confirmed. A signed-in record is released only
      // with it (round 8); a tombstone deletes in any case (E5).
      const marked = await confirmMark();
      if (state() !== current) return { signedOut: true };
      if (current.release) {
        if (!marked) {
          ram = { ...current, held: true };
          return { signedOut: true };
        }
        const read = await readStoredSession();
        if (state() !== current) return { signedOut: true };
        // A read error: held, nothing deleted, the next start reads again.
        if (read.held) {
          ram = { ...current, held: true };
          return { signedOut: true };
        }
        if (read.signedOut) return read;
        ram = { epoch: current.epoch, signedOut: false };
        return { signedOut: false, token: read.token, user: read.user, epoch: current.epoch };
      }
    }
    if (current.signedOut) {
      let deleted = true;
      for (const key of AUTH_KEYS) {
        if (!(await removeSecureItem(key)).success) deleted = false;
      }
      const flow = peekSsoFlow();
      if (flow && (current.unreadable || flow.epoch !== current.epoch)) clearSsoFlowConfirmed();
      // Not confirmed: the next start deletes again (E5).
      return deleted ? { signedOut: true } : { signedOut: true, deleteIncomplete: true };
    }
    return { signedOut: true };
  });
}
