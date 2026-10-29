'use strict';

/**
 * Session scope of main's background work (security review 10/2026,
 * round 9, council 3).
 *
 * WHY: rounds 6 to 8 checked the session ticket at the CALLER of an effect
 * (after an await, before a request), and every round found a place where the
 * check was missing (a TUS upload outside the abort, recovery without any
 * check, a gateway retry with the old bearer). Now the check sits at the
 * EFFECT: background work (src-electron/background/) gets a SessionScope when
 * it starts and reaches every effect only through it.
 *
 * - R-S1 `open()` returns a scope only for a released session (not signed
 *   out, record readable, migration not held), else null and the entry ends
 *   silently. `alive()` = same epoch as at open and not signed out. The scope
 *   is bound at the entry and handed down unchanged; no sub path takes a new
 *   ticket.
 * - R-S2 Effects: `http` (signal + token, alive() right before sending; the
 *   gateway retry checks `config.scope.alive()` too), `commit(fn)` (fn runs
 *   synchronously right after alive(); a promise throws), `commitRename` and
 *   the writes of `fs` (alive() in the same synchronous continuation as every
 *   rename system call, also in each retry: durable-files publish gate),
 *   `update.history/queue/active` (read-modify-write inside commit),
 *   `notify` (dropped when ended), `timer`/`interval`/`sleep`, ports (main's
 *   mixed helpers: lock queue, finalization, child processes) and the
 *   in-flight claims and cancel handles.
 * - R-S3 The session authority calls `abortAll()` at every epoch change
 *   (sign-in, SSO, sign-out, invalidate; never at a refresh). Abort: the
 *   signal and every tracked object are aborted, timers cleared, sleepers
 *   rejected once with a SessionEndedError, late callbacks dropped. Queue,
 *   receipts and sources stay as they are. Clean-up in `finally` is keyed by
 *   (scope, recordId), never by recordId alone.
 *
 * What was handed to the operating system before the change counts as an
 * effect before the change (a request already on the wire, a rename already
 * issued).
 */

const realFs = require('fs');
const { createDurableFiles, publishGate, assertManagedRecordingDirectory } = require('./durable-files');

class SessionEndedError extends Error {
  constructor(cause) {
    super('Signed out');
    this.name = 'SessionEndedError';
    this.code = 'SESSION_ENDED';
    this.sessionEnded = true;
    if (cause) this.cause = cause;
  }
}

const isSessionEnded = (error) => !!error && (error instanceof SessionEndedError || error.code === 'SESSION_ENDED');

/** One signal that aborts when either input aborts (Electron 28 has no AbortSignal.any). */
function combineSignals(primary, extra) {
  if (!extra || extra === primary) return primary;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (primary.aborted || extra.aborted) abort();
  else {
    primary.addEventListener('abort', abort, { once: true });
    extra.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

// A class instance (not a plain object): axios keeps `config.scope` by
// reference when it merges request configs.
class SessionScope {}

/**
 * @param {object} deps
 * @param {object} deps.authority - session-authority.js instance
 * @param {object} deps.http - axios instance (interceptors installed)
 * @param {object} [deps.fs] - fs (tests: a counting fake)
 * @param {{ history: object, queue: object, active: object }} deps.stores - electron-store instances
 * @param {(channel: string, payload: any) => void} deps.send - to the main window
 * @param {object} [deps.timers]
 * @param {Object<string, Function>} [deps.ports] - main's mixed helpers, called only while alive
 * @param {object} [deps.log]
 */
function createScopeRegistry({ authority, http, fs = realFs, stores, send = () => {}, timers = globalThis, ports = {}, log = console }) {
  const durable = createDurableFiles(fs);
  const live = new Set();
  // In-flight uploads per recording: recordId -> owning scope.
  const claims = new Map();
  // Cancel handles of running uploads: recordId -> { scope, controller, audioFileId }.
  const cancels = new Map();
  let nextId = 1;

  function released() {
    const s = authority.state();
    return !s.signedOut && !s.unreadable && !s.migrationPending;
  }

  function open() {
    if (!released()) return null;
    const id = nextId++;
    const ticket = authority.ticket();
    const controller = new AbortController();
    let over = false;
    const timerSet = new Set();
    const intervalSet = new Set();
    const sleepers = new Set();
    const tracked = new Set();

    const scope = new SessionScope();
    const alive = () => !over && authority.isCurrent(ticket) && authority.tokenAllowed();
    const ended = (cause) => new SessionEndedError(cause);
    const assertAlive = () => { if (!alive()) throw ended(); };

    /** fn synchronously, right after alive(). */
    function commit(fn) {
      assertAlive();
      const result = fn();
      if (result && typeof result.then === 'function') throw new Error('scope.commit: the effect must be synchronous');
      return result;
    }

    /** Runs fn in the publish gate of this scope (durable-files checks alive() before every rename). */
    function gated(fn) {
      return publishGate.run({ assertAlive }, fn);
    }

    /** Settles only while alive: a late answer or error of an ended scope is a SessionEndedError. */
    function settle(promise) {
      return Promise.resolve(promise).then(
        (value) => { if (!alive()) throw ended(); return value; },
        (error) => { if (!alive()) throw ended(error); throw error; }
      );
    }

    function request(config) {
      assertAlive();
      const cfg = { ...config };
      if (cfg.auth) {
        const token = authority.getToken();
        if (!token) throw ended();
        cfg.headers = { ...(cfg.headers || {}), Authorization: `Bearer ${token}` };
      }
      delete cfg.auth;
      cfg.signal = combineSignals(controller.signal, config.signal);
      cfg.scope = scope;
      return settle(http.request(cfg));
    }

    function update(store, key, fallback) {
      return (mutate) => commit(() => {
        const current = store.get(key, fallback);
        const next = mutate(current);
        if (next && typeof next.then === 'function') throw new Error('scope.update: the mutation must be synchronous');
        if (next !== undefined) store.set(key, next);
        return next;
      });
    }

    function sleep(ms) {
      return new Promise((resolve, reject) => {
        if (!alive()) { reject(ended()); return; }
        const entry = { reject, handle: null };
        sleepers.add(entry);
        entry.handle = timers.setTimeout(() => {
          if (!sleepers.delete(entry)) return;
          if (alive()) resolve();
          else reject(ended());
        }, ms);
        // Ended while the timer was being set: end() already rejected it.
        if (!sleepers.has(entry)) timers.clearTimeout(entry.handle);
      });
    }

    function timer(ms, fn) {
      if (!alive()) return null;
      const handle = timers.setTimeout(() => {
        if (!timerSet.delete(handle)) return;
        if (alive()) fn();
      }, ms);
      timerSet.add(handle);
      return handle;
    }

    function interval(ms, fn) {
      if (!alive()) return () => {};
      const handle = timers.setInterval(() => { if (alive()) fn(); }, ms);
      intervalSet.add(handle);
      return () => { timers.clearInterval(handle); intervalSet.delete(handle); };
    }

    function track(cancelable) {
      if (!alive()) { cancel(cancelable); throw ended(); }
      tracked.add(cancelable);
      return () => tracked.delete(cancelable);
    }

    function cancel(cancelable) {
      try {
        if (typeof cancelable.abort === 'function') cancelable.abort();
        else if (typeof cancelable.cancel === 'function') cancelable.cancel();
      } catch { /* already over */ }
    }

    /** Ends this scope (abortAll): everything that waits ends once. */
    function end() {
      if (over) return;
      over = true;
      live.delete(scope);
      try { controller.abort(); } catch { /* already aborted */ }
      for (const handle of timerSet) timers.clearTimeout(handle);
      timerSet.clear();
      for (const handle of intervalSet) timers.clearInterval(handle);
      intervalSet.clear();
      const waiting = [...sleepers];
      sleepers.clear();
      for (const entry of waiting) {
        if (entry.handle !== null) timers.clearTimeout(entry.handle);
        entry.reject(ended());
      }
      for (const cancelable of tracked) cancel(cancelable);
      tracked.clear();
    }

    const portProxy = {};
    for (const [name, fn] of Object.entries(ports)) {
      portProxy[name] = (...args) => {
        assertAlive();
        const result = gated(() => fn(...args));
        if (result && typeof result.then === 'function') return settle(result);
        assertAlive();
        return result;
      };
    }

    Object.assign(scope, {
      id,
      ticket,
      signal: controller.signal,
      alive,
      ended: () => !alive(),
      assertAlive,
      /** The token of this session (null once it ended). */
      token: () => (alive() ? authority.getToken() : null),
      http: {
        request,
        get: (url, config = {}) => request({ ...config, method: 'get', url }),
        post: (url, data, config = {}) => request({ ...config, method: 'post', url, data }),
        put: (url, data, config = {}) => request({ ...config, method: 'put', url, data }),
      },
      commit,
      /** Rename (with retries), alive() right before every rename system call. */
      commitRename: (source, destination) => gated(() => durable.renameWithRetry(source, destination)),
      fs: {
        // Reads: no effect.
        existsSync: (p) => fs.existsSync(p),
        statSync: (p) => fs.statSync(p),
        readdirSync: (p, o) => fs.readdirSync(p, o),
        readFileSync: (p, o) => fs.readFileSync(p, o),
        createReadStream: (p, o) => fs.createReadStream(p, o),
        stat: (p) => settle(fs.promises.stat(p)),
        access: (p) => settle(fs.promises.access(p)),
        // Writes: alive() right before the system call.
        mkdirSync: (p, o) => commit(() => fs.mkdirSync(p, o)),
        writeFileAtomic: (p, data) => settle(gated(() => durable.writeFileAtomic(p, data))),
        /** Removes one managed recording directory (the recordings root comes from main). */
        rmRecordingDir: (root, dirPath) => {
          const target = assertManagedRecordingDirectory(root, dirPath);
          assertAlive();
          return settle(fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }));
        },
      },
      read: {
        history: () => stores.history.get('recordings', []),
        queue: () => stores.queue.get('pendingUploads', []),
        active: () => stores.active.get('activeSession', null),
      },
      update: {
        history: update(stores.history, 'recordings', []),
        queue: update(stores.queue, 'pendingUploads', []),
        active: update(stores.active, 'activeSession', null),
      },
      notify: (channel, payload) => { if (alive()) send(channel, payload); },
      sleep,
      timer,
      interval,
      track,
      port: portProxy,
      /** E3: a refresh result of this session (synchronous compare-and-set). */
      applyRefresh: (userId, result) => commit(() => authority.applySession(authority.ticket({ userId }), result, { kind: 'refresh' })),
      /** In-flight claim of a recording; a claim of an ended scope can be taken over. */
      claim: (recordId) => {
        assertAlive();
        const owner = claims.get(recordId);
        if (owner && owner !== scope && owner.alive()) return false;
        claims.set(recordId, scope);
        return true;
      },
      /** Releases only this scope's own claim (never the next session's). */
      release: (recordId) => { if (claims.get(recordId) === scope) claims.delete(recordId); },
      /** Cancel handle of an upload (user cancel, quit); released only by its own scope. */
      registerCancel: (recordId, uploadController) => {
        assertAlive();
        const entry = { scope, controller: uploadController, audioFileId: null };
        cancels.set(recordId, entry);
        return {
          stagedBlob: (audioFileId) => { if (cancels.get(recordId) === entry) entry.audioFileId = audioFileId; },
          release: () => { if (cancels.get(recordId) === entry) cancels.delete(recordId); },
        };
      },
      /** For the R-S3 test and diagnostics. */
      _end: end,
    });
    Object.freeze(scope);
    live.add(scope);
    return scope;
  }

  return {
    open,
    /** R-S3: every epoch change (not a refresh) ends every scope. */
    abortAll() {
      const ending = [...live];
      for (const scope of ending) scope._end();
      if (ending.length) log.info(`[session-scope] ${ending.length} background scope(s) ended by a session change`);
    },
    /** In-flight uploads (read side for main: deletes, power blocker, close guard). */
    inFlight: {
      has: (recordId) => claims.has(recordId),
      get size() { return claims.size; },
    },
    /** User cancel: aborts the upload's own controller. @returns {{ audioFileId: string|null, scope: object }|null} */
    cancelUpload(recordId) {
      const entry = cancels.get(recordId);
      if (!entry) return null;
      cancels.delete(recordId);
      try { entry.controller.abort(); } catch { /* already aborted */ }
      return { audioFileId: entry.audioFileId, scope: entry.scope };
    },
    /** Quit: abort every upload (they stay queued). @returns {number} */
    abortUploadsForQuit() {
      const n = cancels.size;
      for (const entry of cancels.values()) {
        try { entry.controller.abort(); } catch { /* already aborted */ }
      }
      return n;
    },
    /** Running uploads with a cancel handle (quit). */
    get uploadCount() { return cancels.size; },
    get size() { return live.size; },
  };
}

module.exports = { createScopeRegistry, SessionEndedError, isSessionEnded, combineSignals, SessionScope };
