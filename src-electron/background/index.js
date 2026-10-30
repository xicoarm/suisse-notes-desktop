'use strict';

/**
 * Main's background work (review round 9, council 3): upload queue,
 * upload:start, direct and legacy upload, verification and polls, token
 * refresh, crash recovery, clean-up and the blob clean-up of a cancel.
 *
 * Everything here runs in a SessionScope (src-electron/session-scope.js),
 * opened by main at the entry, and reaches effects only through it. The
 * static rule (tests/unit/mainBackgroundStatic.test.js) forbids this folder
 * to require axios, electron, electron-store, fs, child_process or
 * ./durable-files, or to name main's stores, window or IPC.
 *
 * Factory keys (also checked there): `config` (constants), `read` (read-only
 * helpers of main), `pure` (no effects), `report` (telemetry), `hooks`
 * (`onBusyChange`: main's power-save blocker, in memory), `log`.
 */

const { createUploads } = require('./upload');
const { createPendingUploadProcessor } = require('./pending-uploads');
const { createRecovery } = require('./recovery');
const { abortDirectUpload } = require('./upload-direct');

function createBackground({ config, read, pure, report, hooks, log }) {
  const uploads = createUploads({ config, read, pure, report, log });
  const pending = createPendingUploadProcessor({ uploads, read, pure, hooks, log });
  const recovery = createRecovery({ read, pure, pending, report, config, log });
  return {
    uploads,
    pending,
    recovery,
    /** Upload queue run (startup, after sign-in, periodic, manual retry). No released session: nothing. */
    startQueue(registry) {
      const scope = registry.open();
      if (!scope) return Promise.resolve({ noSession: true });
      return pending.run(scope);
    },
    /**
     * R-S4: recovery and then clean-up, only with a released session (no
     * tombstone, not held). Main starts it at startup and after every
     * applied session (sign-in, SSO, release of a held start); once per
     * session.
     */
    startRecovery(registry, reason) {
      const scope = registry.open();
      if (!scope) {
        log.info(`Recovery (${reason}): no released session - it runs after the next sign-in`);
        return Promise.resolve({ noSession: true });
      }
      return recovery.runRecoveryAndCleanup(scope).catch((err) => {
        log.error('Error recovering orphaned recordings:', err);
        return { failed: true };
      });
    },
    /** Blob clean-up after a user cancel, in the scope of the cancelled upload. */
    abortDirectUpload: (scope, { recordId, audioFileId }) => abortDirectUpload(scope, { apiBaseUrl: config.apiBaseUrl, recordId, audioFileId, log }),
  };
}

module.exports = { createBackground };
