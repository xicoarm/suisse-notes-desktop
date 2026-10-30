// The upload queue run of main (src-electron/background/pending-uploads.js)
// on a real session authority, as main wires it since review round 9: a
// SessionScope per run (session-scope.js), queue and history only through
// the scope. The upload itself is a stand-in that, like uploadWithRetry,
// sends with the scope's token. `wait(ms)` replaces the timer of scope.sleep.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createScopeRegistry } = require('../../../src-electron/session-scope.js');
const { createPendingUploadProcessor } = require('../../../src-electron/background/pending-uploads.js');
const { tokenUserId, canUploadForUser } = require('../../../src-electron/upload-safety.js');

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** Timers whose delay is `wait(ms)` (a promise the test controls). */
export function waitTimers(wait) {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, true);
      Promise.resolve(wait ? wait(ms) : undefined).then(() => { if (pending.delete(id)) fn(); });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    setInterval() { return next++; },
    clearInterval() {}
  };
}

/**
 * @param {object} o
 * @param {object} o.authority
 * @param {{ get: Function, set: Function }} o.queue - store with key 'pendingUploads'
 * @param {{ get: Function, set: Function }} o.history - store with key 'recordings'
 * @param {(item: object, scope: object, token: string) => Promise<object>} [o.upload]
 * @param {(ms: number) => Promise<void>} [o.wait]
 * @param {object} [o.fallback] - result of the stand-in upload without `upload`
 */
export function createQueueRun({ authority, queue, history, upload, wait, fallback = null }) {
  const requests = [];
  const scopes = createScopeRegistry({
    authority,
    http: {},
    // The recordings exist (no file system in these rigs).
    fs: { promises: { access: async () => {}, stat: async () => ({}) } },
    stores: { history, queue, active: { get: (k, d) => d, set: () => {} } },
    timers: waitTimers(wait),
    log: quiet
  });
  const uploads = {
    uploadWithRetry: async (scope, recordId, filePath, metadata) => {
      const token = scope.token();
      if (!token) return { success: false, status: 401, canRetry: false, error: 'Not authenticated' };
      requests.push({ recordId, token });
      if (upload) return upload({ recordId, filePath, metadata }, scope, token);
      return fallback || { success: true, audioFileId: `f-${recordId}` };
    },
    saveUploadOutcome: () => {}
  };
  const processor = createPendingUploadProcessor({
    uploads,
    read: { recordingOwner: () => null, readUploadReceipt: () => null, inFlight: (id) => scopes.inFlight.has(id) },
    pure: { tokenUserId, canUploadForUser },
    log: quiet
  });
  // As main: a run only with a released session.
  const processPendingUploads = async () => {
    const scope = scopes.open();
    return scope ? processor.run(scope) : { noSession: true };
  };
  return { processPendingUploads, requests, scopes };
}
