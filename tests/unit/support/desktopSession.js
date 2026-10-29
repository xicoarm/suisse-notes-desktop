// Test rig for the desktop session authority (main process) without Electron:
// token vault, user store, SSO flow store, callback handler and the pending
// upload processor, all on one persistent fake disk. `boot(disk)` is one app
// start; calling it again on the same disk is a restart.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sessionAuthorityModule = require('../../../src-electron/session-authority.js');
const { createSessionAuthority, configUserStore } = sessionAuthorityModule;
const { createTokenVault } = require('../../../src-electron/token-vault.js');
const ssoFlow = require('../../../src-electron/sso-flow.js');
const { createPendingUploadProcessor } = require('../../../src-electron/pending-uploads.js');
const { tokenUserId, canUploadForUser } = require('../../../src-electron/upload-safety.js');

export { ssoFlow };

export const jwt = (userId, tag = '') => `h.${Buffer.from(JSON.stringify({ userId, tag })).toString('base64url')}.s`;
export const userB64 = (user) => Buffer.from(JSON.stringify(user)).toString('base64url');

/**
 * safeStorage stand-in: reversible, no '.' in the ciphertext. `ready()`
 * decides isEncryptionAvailable (Windows and Linux: false before app ready).
 */
export function fakeSafeStorage(ready = () => true, decryptFails = () => false) {
  return {
    isEncryptionAvailable: () => ready(),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s) => Buffer.from(`enc:${s.split('').reverse().join('')}`),
    decryptString: (buf) => {
      if (decryptFails()) throw new Error('keychain access denied');
      const s = buf.toString();
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
      return s.slice(4).split('').reverse().join('');
    }
  };
}

/** A token as the previous version stored it with a real OS keystore. */
export const encrypted = (token) => fakeSafeStorage().encryptString(token).toString('base64');

/**
 * The persistent state of one machine. Faults:
 * - failRecordRead / failRecordWrite: the record file
 * - failDelete: set of config keys whose delete throws
 * - failSet: set of config keys whose set throws
 * - failGet: set of config keys whose get throws (review round 8)
 * - dropSet: set of config keys whose set is silently lost (read-back differs)
 * - dropRecordWrite: the record write is silently lost
 * - failRecordReadAfterWrite: every record read throws once a record exists
 * - failDecrypt: the OS keystore refuses to decrypt
 */
export function createDisk() {
  return {
    config: {},
    record: null,
    queue: [],
    history: [],
    now: 1_000_000,
    // false: the OS keystore is not open yet (before app ready).
    encryptionReady: true,
    failRecordRead: false,
    failRecordWrite: false,
    failDelete: new Set(),
    failSet: new Set(),
    failGet: new Set(),
    dropSet: new Set(),
    dropRecordWrite: false,
    failRecordReadAfterWrite: false,
    failDecrypt: false,
    log: []
  };
}

function configStore(disk) {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    get: (k, d) => {
      if (disk.failGet && disk.failGet.has(k)) throw new Error(`EIO get ${k}`);
      return k in disk.config ? clone(disk.config[k]) : d;
    },
    set: (k, v) => {
      if (disk.failSet.has(k)) throw new Error(`EACCES set ${k}`);
      if (disk.dropSet && disk.dropSet.has(k)) { disk.log.push(`config.lost:${k}`); return; }
      disk.log.push(`config.set:${k}`);
      disk.config[k] = clone(v);
    },
    delete: (k) => {
      if (disk.failDelete.has(k)) throw new Error(`EACCES delete ${k}`);
      disk.log.push(`config.delete:${k}`);
      delete disk.config[k];
    }
  };
}

function recordStore(disk) {
  return {
    read: () => {
      if (disk.failRecordRead) throw new Error('EIO read');
      if (disk.failRecordReadAfterWrite && disk.record !== null) throw new Error('EIO read');
      return disk.record;
    },
    write: (text) => {
      if (disk.failRecordWrite) throw new Error('EROFS write');
      if (disk.dropRecordWrite) { disk.log.push(`record.lost:${text}`); return; }
      disk.log.push(`record.write:${text}`);
      disk.record = text;
    }
  };
}

/**
 * One app start on `disk`.
 * @param {object} disk
 * @param {object} [opts]
 * @param {(authCode: string, verifier: string, state: string) => Promise<object>} [opts.exchange]
 * @param {(item: object, ticket: object, token: string|null) => Promise<object>} [opts.upload]
 * @param {(ms: number) => Promise<void>} [opts.wait]
 * @param {() => void} [opts.onAbort] - also called at every abort (round 9: the scope registry)
 */
export function boot(disk, { exchange = async () => ({ error: 'invalid_callback' }), upload, wait, onAbort } = {}) {
  const config = configStore(disk);
  let authority;
  const vault = createTokenVault({
    safeStorage: fakeSafeStorage(() => disk.encryptionReady !== false, () => disk.failDecrypt === true),
    store: config,
    platform: 'darwin',
    isAllowed: () => !!authority && authority.tokenAllowed()
  });
  const flows = ssoFlow.createSsoFlowStore({ storage: config, now: () => disk.now });
  const counters = { aborted: 0, missingState: 0 };
  authority = createSessionAuthority({
    recordStore: recordStore(disk),
    vault,
    userStore: configUserStore(config),
    // Absent before the migration existed (fail-first run at a3c841fa).
    migrationMark: sessionAuthorityModule.configMarkStore ? sessionAuthorityModule.configMarkStore(config) : undefined,
    flows,
    abortRequests: () => { counters.aborted++; if (onAbort) onAbort(); },
    now: () => disk.now
  });
  authority.startup();

  const delivered = [];
  const handleCallback = ssoFlow.createSsoCallbackHandler({
    authority,
    flows,
    exchange,
    deliver: (payload) => { if (authority.setPending(payload)) delivered.push(payload); },
    countMissingState: () => { counters.missingState++; }
  });

  // Requests that left the app (upload processor).
  const requests = [];
  const inFlight = new Set();
  const processPendingUploads = createPendingUploadProcessor({
    authority,
    getQueue: () => JSON.parse(JSON.stringify(disk.queue)),
    removeFromQueue: (id) => { disk.log.push(`queue.remove:${id}`); disk.queue = disk.queue.filter((i) => i.recordId !== id); },
    bumpRetry: (id) => {
      disk.log.push(`queue.retry:${id}`);
      disk.queue = disk.queue.map((i) => (i.recordId === id ? { ...i, retryCount: (i.retryCount || 0) + 1 } : i));
    },
    inFlight,
    upload: async (recordId, filePath, metadata, maxRetries, ticket) => {
      // Like uploadWithRetry: the request carries the token of the ticket's session.
      const token = authority.isCurrent(ticket) ? authority.getToken() : null;
      if (!token) return { success: false, status: 401, canRetry: false, error: 'Not authenticated' };
      requests.push({ recordId, token });
      return upload ? upload({ recordId, filePath, metadata }, ticket, token) : { success: true, audioFileId: `f-${recordId}` };
    },
    mayUpload: (item, userId) => canUploadForUser(item.userId, userId),
    readReceipt: () => null,
    access: async () => {},
    updateHistory: (id, change) => { disk.log.push(`history:${id}`); disk.history.push({ id, ...change }); },
    saveOutcome: () => {},
    notify: () => {},
    tokenUserId,
    wait: wait || (async () => {}),
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  /** Password sign-in as main does it (auth:login): ticket at start, apply at the end. */
  const passwordSignIn = (userId, tag = 'pw') => {
    const ticket = authority.ticket();
    return { ticket, apply: () => authority.applySession(ticket, { token: jwt(userId, tag), user: { id: userId } }, { kind: 'login' }) };
  };

  /** auth:loginWithMicrosoft: a flow in the current epoch. */
  const beginSso = (provider = 'microsoft') => flows.begin(provider, authority.state().epoch);

  return { authority, vault, flows, config, counters, delivered, handleCallback, processPendingUploads, requests, passwordSignIn, beginSso };
}
