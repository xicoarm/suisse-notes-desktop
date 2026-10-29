'use strict';

/**
 * Desktop session authority (main process): the one place that decides
 * whether this app is signed in, and the only writer of token and user.
 *
 * WHY (security review 10/2026, round 6): sign-in results (password, 2FA,
 * registration, refresh, SSO legacy callback, SSO code exchange) arrive
 * asynchronously in renderer AND main. Each round closed single cases, and the
 * same class came back elsewhere: a late result revived a session after a
 * sign-out, a failed delete counted as success, main kept uploading for a user
 * the UI had signed out. Now:
 *
 * - E1 One record {epoch, signedOut} in its own file in userData, written
 *   atomically (tmp + rename) and read back. Unreadable (present, but a read
 *   or parse error) = signed out.
 * - E1 addendum of the lead (review round 7; the council verdict says
 *   «unreadable», not «missing»): a MISSING record is the first start after
 *   the update. startup() alone, in main, before any renderer, takes the
 *   previous version's session over ONCE: an encrypted token (never
 *   plaintext) and a user with the same, present userId become
 *   {epoch:0, signedOut:false}, written atomically and read back, then the
 *   one-time mark is set, and only then the session is released. Any error
 *   on that way: RAM lock only (signed out in memory, getToken null, no
 *   background work), nothing of the previous session is deleted, the next
 *   start tries again. Without such a pair: signed out as before. A record
 *   missing AFTER the mark counts as unreadable (never a second migration).
 * - E2 Every asynchronous sign-in takes a ticket (the epoch) when it starts.
 *   Token and user are written only by applySession(ticket, result).
 * - E3 applySession is compare-and-set and runs synchronously in main, so it
 *   is serialized against signOut. A stale ticket, or an SSO result while a
 *   session exists, is dropped without any side effect. A refresh applies only
 *   with the same epoch and the same userId.
 * - E4 Every session change increments the epoch and drops the pending SSO
 *   flow and the buffered SSO result. A persisted flow is valid only with the
 *   current epoch.
 * - E5 Sign-out: 1. record {epoch+1, signedOut} written and read back, RAM
 *   lock; 2. requests aborted; 3. token, user, flow, buffer deleted. Success
 *   only when 1 and 3 are confirmed; otherwise the RAM lock stays and every
 *   start deletes again. (4. BLE clean-up runs in the renderer afterwards.)
 * - E6 The tombstone wins: while signed out (or the record is unreadable)
 *   getToken is null on every main path, even if a token is still on disk.
 * - E8 A failed or impossible write never counts as success. When the record
 *   cannot be written at sign-in, the session lives in memory only.
 * - E9 Sign-in: tombstone with the new epoch, then token and user, then the
 *   record {epoch, signedOut:false}. Sign-out: record first, then delete. A
 *   crash before or after any storage operation ends in the last confirmed
 *   state or signed out.
 *
 * All storage is injected so the authority can be tested (and crashed at
 * every storage operation) without Electron.
 */

const fs = require('fs');

const RECORD_FILE = 'session-authority.json';
const MIGRATION_MARK_KEY = 'sessionAuthorityMigrated';

/** userId claim of a JWT (no signature check: only used to pair token and user). */
function tokenUserId(token) {
  try {
    const part = String(token).split('.')[1];
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
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
 * The record file: read() -> text | null (missing), throws on any other
 * failure; write(text) writes a temp file, flushes it and renames it over the
 * record (atomic on every desktop OS).
 */
function fileRecordStore(filePath, fsImpl = fs) {
  return {
    read() {
      try {
        return fsImpl.readFileSync(filePath, 'utf8');
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    write(text) {
      const tmp = `${filePath}.tmp`;
      const fd = fsImpl.openSync(tmp, 'w');
      try {
        fsImpl.writeSync(fd, text);
        fsImpl.fsyncSync(fd);
      } finally {
        fsImpl.closeSync(fd);
      }
      fsImpl.renameSync(tmp, filePath);
    }
  };
}

/** User info in configStore ('userInfo'); every write and delete is read back. */
function configUserStore(store, key = 'userInfo') {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    get() {
      try { return store.get(key) || null; } catch { return null; }
    },
    set(user) {
      try {
        store.set(key, user);
        return same(store.get(key), user);
      } catch {
        return false;
      }
    },
    delete() {
      try {
        store.delete(key);
        const left = store.get(key);
        return left === undefined || left === null;
      } catch {
        return false;
      }
    }
  };
}

/**
 * The one-time migration mark in configStore: get() throws when it cannot be
 * read; set() is read back.
 */
function configMarkStore(store, key = MIGRATION_MARK_KEY) {
  return {
    get() {
      return store.get(key) === true;
    },
    set() {
      try {
        store.set(key, true);
        return store.get(key) === true;
      } catch {
        return false;
      }
    }
  };
}

/** In-memory mark (tests that do not care about the migration). */
function memoryMarkStore() {
  let marked = false;
  return { get: () => marked, set: () => { marked = true; return true; } };
}

/**
 * @param {object} deps
 * @param {{ read: () => string|null, write: (text: string) => void }} deps.recordStore
 * @param {object} deps.vault - token-vault.js instance (created with isAllowed: () => authority.tokenAllowed())
 * @param {{ get: Function, set: Function, delete: Function }} deps.userStore
 * @param {object} deps.flows - sso-flow.js createSsoFlowStore() instance
 * @param {{ get: () => boolean, set: () => boolean }} [deps.migrationMark] - one-time migration mark (configMarkStore)
 * @param {() => void} [deps.abortRequests] - aborts main's in-flight requests (sign-out step 2)
 * @param {(msg: string) => void} [deps.warn]
 * @param {() => number} [deps.now]
 */
function createSessionAuthority({ recordStore, vault, userStore, flows, migrationMark = memoryMarkStore(), abortRequests = () => {}, warn = () => {}, now = Date.now }) {
  // epoch -1: the record could not be read; nothing persisted can match it.
  let ram = load();
  // User of a session that lives in memory only (record not writable).
  let memoryUser = null;
  // SSO result waiting for the renderer (auth:takePendingSSO).
  let pending = null;

  function load() {
    let text;
    try {
      text = recordStore.read();
    } catch (error) {
      warn(`session-authority: record unreadable (${error?.message || error}); signed out`);
      return { epoch: -1, signedOut: true, unreadable: true };
    }
    if (text === null || text === undefined) {
      let marked;
      try {
        marked = migrationMark.get();
      } catch (error) {
        warn(`session-authority: migration mark unreadable (${error?.message || error}); signed out`);
        return { epoch: -1, signedOut: true, unreadable: true };
      }
      if (marked) {
        warn('session-authority: record missing after the migration; signed out');
        return { epoch: -1, signedOut: true, unreadable: true };
      }
      // First start after the update: startup() decides (migration).
      return { epoch: 0, signedOut: true, missing: true };
    }
    const rec = parseRecord(text);
    if (!rec) {
      warn('session-authority: record invalid; signed out');
      return { epoch: -1, signedOut: true, unreadable: true };
    }
    return rec;
  }

  // After an unreadable record the old epoch is unknown: continue far above it.
  const nextEpoch = () => (ram.epoch < 0 ? Math.max(1, Math.floor(now())) : ram.epoch + 1);

  /** Write the record and read it back. @returns {boolean} confirmed */
  function persist(epoch, signedOut) {
    try {
      recordStore.write(JSON.stringify({ epoch, signedOut }));
      const back = parseRecord(recordStore.read());
      return !!back && back.epoch === epoch && back.signedOut === signedOut;
    } catch (error) {
      warn(`session-authority: record not written (${error?.message || error})`);
      return false;
    }
  }

  /** E4: a session change ends the SSO flow and the buffered result. */
  function dropFlowAndPending() {
    pending = null;
    return flows.clear();
  }

  const refuse = (reason) => ({ applied: false, reason });

  /**
   * E1 addendum: the previous version's session, once (see the header).
   * @returns {'migrated'|'held'|'none'}
   */
  function migrate() {
    const stored = vault.readStoredToken();
    if (stored.status === 'unavailable' || stored.status === 'error') {
      // The OS keystore is not open (yet): Windows and Linux open it at app
      // ready; nothing is decided and nothing is deleted.
      return 'held';
    }
    const user = userStore.get();
    const uid = stored.status === 'ok' ? tokenUserId(stored.token) : null;
    // Strict: both ids present and the same (string or number, as elsewhere).
    const paired = !!uid && !!user && typeof user === 'object' && !Array.isArray(user)
      && (typeof user.id === 'string' || typeof user.id === 'number') && String(user.id) === uid;
    if (!paired) {
      // Signed out as before (startup deletes). The decision is kept: a
      // tombstone and the mark, so no later start adopts anything.
      if (persist(0, true)) ram = { epoch: 0, signedOut: true };
      migrationMark.set();
      return 'none';
    }
    if (!persist(0, false)) {
      warn('session-authority: migration not written; RAM lock, retried at the next start');
      return 'held';
    }
    if (!migrationMark.set()) {
      // The record {0,false} is confirmed: the next start reads it.
      warn('session-authority: migration mark not set; RAM lock, retried at the next start');
      return 'held';
    }
    ram = { epoch: 0, signedOut: false };
    warn('session-authority: session of the previous version taken over (one-time migration)');
    return 'migrated';
  }

  const authority = {
    /** E2: the ticket an asynchronous sign-in takes when it starts. */
    ticket(extra = {}) {
      return Object.freeze({ ...extra, epoch: ram.epoch });
    },

    isCurrent(ticket) {
      return !!ticket && ticket.epoch === ram.epoch;
    },

    /** E6: may any main path use the token right now? */
    tokenAllowed() {
      return !ram.signedOut;
    },

    state() {
      return { epoch: ram.epoch, signedOut: ram.signedOut, unreadable: !!ram.unreadable, migrationPending: !!ram.migrationPending };
    },

    /** E6: the token for main's requests (null while signed out). */
    getToken() {
      return ram.signedOut ? null : vault.getToken();
    },

    getUser() {
      if (ram.signedOut) return null;
      return memoryUser || userStore.get();
    },

    /**
     * E2/E3/E9: apply a sign-in result. Synchronous: nothing else in main
     * runs between the comparison and the writes.
     * @param {{ epoch: number, userId?: string }} ticket
     * @param {{ token: string, user?: object }} result
     * @param {{ kind: 'login'|'sso'|'refresh' }} opts
     * @returns {{ applied: true, epoch: number, persisted: boolean } | { applied: false, reason: string }}
     */
    applySession(ticket, result, { kind } = {}) {
      if (!authority.isCurrent(ticket)) return refuse('session_changed');
      const token = result && typeof result.token === 'string' ? result.token : '';
      if (!token) return refuse('invalid_result');
      const user = result.user && typeof result.user === 'object' && !Array.isArray(result.user) ? result.user : null;

      if (kind === 'refresh') {
        if (ram.signedOut) return refuse('signed_out');
        const uid = tokenUserId(token);
        if (!uid || uid !== ticket.userId) return refuse('user_mismatch');
        if (memoryUser) {
          // In-memory session: stays in memory.
          vault.saveToken(token, { persist: false });
          if (user && String(user.id ?? '') === uid) memoryUser = user;
          return { applied: true, epoch: ram.epoch, persisted: false };
        }
        const saved = vault.saveToken(token);
        if (user && String(user.id ?? '') === uid) userStore.set(user);
        return { applied: true, epoch: ram.epoch, persisted: saved.persisted !== false };
      }

      if (kind !== 'login' && kind !== 'sso') return refuse('invalid_kind');
      if (!user) return refuse('invalid_result');
      if (kind === 'sso' && !ram.signedOut) return refuse('already_signed_in');

      const epoch = nextEpoch();
      // Tombstone with the new epoch first: a crash until the commit below
      // ends signed out, never in a mix of the old and the new session.
      const pre = persist(epoch, true);
      ram = { epoch, signedOut: true };
      memoryUser = null;
      dropFlowAndPending();

      let persisted = false;
      if (pre) {
        const saved = vault.saveToken(token);
        const userSaved = userStore.set(user);
        if (saved.success && saved.persisted !== false && userSaved) persisted = persist(epoch, false);
        if (!persisted) memoryUser = user;
      } else {
        // E8: the record cannot be written - this session lives in memory
        // only and nothing of it (or of an older one) stays on disk.
        const saved = vault.saveToken(token, { persist: false });
        const userGone = userStore.delete();
        if (saved.deleted !== true || !userGone) {
          // E9 (r6 low finding): the disk may still say {old epoch,
          // signedOut:false} with the old token - a restart would bring that
          // session back under the new one. RAM lock instead; nothing new.
          vault.clearToken();
          warn('session-authority: sign-in refused - record not writable and the previous session not deletable');
          return refuse('storage_unavailable');
        }
        memoryUser = user;
      }
      ram = { epoch, signedOut: false };
      return { applied: true, epoch, persisted };
    },

    /**
     * E5: sign out. The RAM lock holds from the first line on, also when a
     * write fails.
     * @returns {{ success: boolean, epoch: number, error?: string }}
     */
    signOut() {
      const epoch = nextEpoch();
      ram = { epoch, signedOut: true };
      memoryUser = null;
      const recordOk = persist(epoch, true);
      try { abortRequests(); } catch { /* best effort */ }
      const tokenOk = vault.clearToken().success === true;
      const userOk = userStore.delete();
      const flowOk = dropFlowAndPending() !== false;
      const success = recordOk && tokenOk && userOk && flowOk;
      if (!success) warn(`session-authority: sign-out incomplete (record=${recordOk} token=${tokenOk} user=${userOk} flow=${flowOk}); retried at every start`);
      return success ? { success: true, epoch } : { success: false, epoch, error: 'sign_out_incomplete' };
    },

    /**
     * Invalidate every ticket and persisted flow without a session change
     * (a consumed flow whose delete could not be confirmed).
     */
    invalidate() {
      const epoch = nextEpoch();
      if (ram.signedOut) {
        const written = persist(epoch, true);
        // E9 (r6 low finding): not written - the disk keeps the flow's epoch.
        // Treated as unreadable from here on (no ticket of the disk's epoch
        // matches again in this run; the restart behaviour is documented in
        // the PR: only a double storage fault leaves it).
        ram = { epoch, signedOut: true, unreadable: !written };
      } else {
        ram = { ...ram, epoch };
      }
      pending = null;
    },

    /**
     * Start: a missing record runs the one-time migration (E1 addendum).
     * While signed out (tombstone or unreadable record) the deletes run
     * again (E5) and nothing is restored (E6). A flow survives only with the
     * current epoch (SSO cold start). While the migration is held (keystore
     * not open, a write failed) nothing is deleted; main calls startup()
     * again at app ready.
     */
    startup() {
      if (ram.missing) {
        const outcome = migrate();
        if (outcome === 'migrated') return { signedOut: false, migrated: true };
        if (outcome === 'held') {
          ram = { epoch: 0, signedOut: true, missing: true, migrationPending: true };
          return { signedOut: true, migrationPending: true };
        }
        if (ram.missing) ram = { epoch: 0, signedOut: true, missing: true };
      } else if (!ram.unreadable) {
        // A record of an earlier build without the mark: from now on a
        // missing record is never the first start after the update.
        try { if (!migrationMark.get()) migrationMark.set(); } catch { /* next start */ }
      }
      if (!ram.signedOut) return { signedOut: false };
      vault.clearToken();
      userStore.delete();
      const flow = flows.peek();
      if (flow && (ram.unreadable || flow.epoch !== ram.epoch)) flows.clear();
      return { signedOut: true };
    },

    /** The stored session for the renderer, or signed out. */
    restore() {
      if (ram.signedOut) return { signedOut: true, epoch: ram.epoch };
      const token = vault.getToken();
      const user = authority.getUser();
      if (!token || !user) return { signedOut: true, epoch: ram.epoch };
      const uid = tokenUserId(token);
      if (uid && String(user.id ?? '') !== uid) {
        // Token and user of different accounts: never restore either.
        authority.signOut();
        return { signedOut: true, epoch: ram.epoch };
      }
      return { signedOut: false, epoch: ram.epoch, token, user };
    },

    /** Buffer an SSO result for the renderer (only for the current epoch). */
    setPending(payload) {
      pending = payload && payload.epoch === ram.epoch ? payload : null;
      return pending;
    },

    takePending() {
      const payload = pending && pending.epoch === ram.epoch ? pending : null;
      pending = null;
      return payload;
    }
  };

  return authority;
}

module.exports = { createSessionAuthority, fileRecordStore, configUserStore, configMarkStore, parseRecord, tokenUserId, RECORD_FILE, MIGRATION_MARK_KEY };
