// Test rig for main's background work (review round 9, council 3): the REAL
// session authority (desktopSession boot), the REAL scope registry and the
// REAL background modules (src-electron/background/). Stand-ins only at the
// edges, and every edge counts globally:
// - HTTP: a real axios instance (api-resilience installed) whose transport
//   is a router; every request is logged with `after` (sent after the
//   session change).
// - Files: real files in a temp recordings root behind a counting fs; every
//   write, rename, open-for-write, mkdir, unlink and rm is an effect.
// - Stores (history, queue, active): every set is an effect.
// - Renderer events, child processes (ports) and timers: logged.
// `change()` marks the moment of the session change; `effectsAfter()` and
// `requestsAfter()` are what the rules forbid after it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDisk, boot, jwt } from './desktopSession.js';

const require = createRequire(import.meta.url);
const axios = require('axios');
const FormData = require('form-data');
const { createScopeRegistry } = require('../../../src-electron/session-scope.js');
const { createDurableFiles, assertPublishAllowed } = require('../../../src-electron/durable-files.js');
const { installApiResilience } = require('../../../src-electron/api-resilience.js');
const { createBackground } = require('../../../src-electron/background/index.js');
const { tokenUserId, canUploadForUser, verifiedUploadResult } = require('../../../src-electron/upload-safety.js');
const { tokenUserId: sessionTokenUserId } = require('../../../src-electron/session-authority.js');
const { withCaptureWarnings } = require('../../../src-electron/recording-history-warnings.js');
const { repairRecoveredHistoryRecord } = require('../../../src-electron/recording-export.js');

export { jwt };
export const API = 'http://api.test';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

export function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
export async function until(predicate, rounds = 200) {
  for (let i = 0; i < rounds && !predicate(); i++) await flush();
  if (!predicate()) throw new Error('until: condition not reached');
}

/** Default server: direct upload accepted, status COMPLETED, refresh ok. */
function defaultAnswer(config) {
  const url = String(config.url);
  const method = String(config.method).toLowerCase();
  if (method === 'post' && url.endsWith('/api/uploads/init')) {
    return { status: 200, data: { mode: 'azure', sasUrl: 'https://blob.test/c/r?sig=1', audioFileId: 'audio-1', blockSize: 4 * 1024 * 1024, blobName: 'b' } };
  }
  if (method === 'put' && url.startsWith('https://blob.test/')) return { status: 201, data: '' };
  if (method === 'post' && url.endsWith('/api/uploads/complete')) return { status: 200, data: { success: true, audioFileId: 'audio-1' } };
  if (method === 'post' && url.endsWith('/api/uploads/abort')) return { status: 200, data: { success: true } };
  if (method === 'post' && url.endsWith('/api/desktop/upload')) return { status: 200, data: { success: true, audioFileId: 'audio-1' } };
  if (method === 'get' && /\/api\/desktop\/upload\/[^/]+\/status$/.test(url)) return { status: 200, data: { status: 'COMPLETED' } };
  if (method === 'get' && /\/api\/desktop\/meeting\/[^/]+\/status$/.test(url)) return { status: 200, data: { status: 'COMPLETED' } };
  if (method === 'post' && url.endsWith('/api/auth/refresh')) return { status: 200, data: { token: jwt('a', 'refreshed'), user: { id: 'a' } } };
  return { status: 404, data: { error: 'not found' } };
}

/**
 * @param {object} opts
 * @param {string[]} [opts.recordings] recording ids with an audio file (owner a)
 * @param {boolean} [opts.lateAnswers] the transport ignores the abort signal
 *   (the answer was already on the wire): tests the late-result path
 * @param {object} [opts.read] overrides of main's read helpers
 * @param {object} [opts.ports] overrides of the ports
 * @param {string} [opts.session] see below
 */
export function createBackgroundRig({
  session = 'signedIn', recordings = ['r1'], lateAnswers = false, read: readOverrides = {}, ports: portOverrides = {},
  history, queue, active, renameBusy = 0, registryFactory = createScopeRegistry,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-rig-'));
  for (const id of recordings) {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'audio.webm'), Buffer.alloc(10, 1));
  }
  const mark = { changed: false };
  const effects = [];
  const requests = [];
  const sent = [];
  const sleeps = [];
  const spawns = [];
  const streams = [];
  const openStreams = [];
  const hooks = { onTimer: null, onEffect: null, hold: null };
  // Suspension points (sweep): every asynchronous edge counts once, right
  // before the waiting code continues - HTTP answers, timers, fs promises
  // (also file handles: write, sync, close), ports, async read helpers and
  // the recording-lock queue. `sweep.at = N` fires `sweep.action` at the
  // N-th point.
  const points = [];
  const sweep = { at: 0, action: null, fired: false, queueAtChange: null };
  const hit = (label) => {
    points.push(label);
    if (!sweep.fired && sweep.at === points.length && sweep.action) { sweep.fired = true; sweep.action(label); }
  };
  // `hooks.hold(label)` may return a promise: the edge then waits for it
  // (a delayed system call) before the waiting code continues.
  const held = async (label) => { const h = hooks.hold && hooks.hold(label); if (h) await h; };
  const after = (label, promise) => Promise.resolve(promise).then(
    async (value) => { await held(label); hit(label); return value; },
    async (error) => { await held(label); hit(label); throw error; }
  );
  const effect = (kind, target) => {
    effects.push({ kind, target: String(target), after: mark.changed });
    if (hooks.onEffect) hooks.onEffect(kind, String(target));
  };

  // Counting fs over the real one (durable-files and the scope use it).
  const p = fs.promises;
  let busy = renameBusy;
  const wrapHandle = (handle) => new Proxy(handle, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (['write', 'writeFile', 'sync', 'datasync', 'close', 'read', 'stat', 'truncate'].includes(prop)) {
        return (...args) => after(`handle.${prop}`, value.apply(target, args));
      }
      return value.bind(target);
    },
  });
  const promised = {};
  for (const [name, fn] of Object.entries(p)) if (typeof fn === 'function') promised[name] = (...args) => after(`fs.${name}`, fn.apply(p, args));
  const writeFlag = (flags) => /[wa+]/.test(String(flags || 'r'));
  const countingFs = {
    ...fs,
    renameSync: (a, b) => { effect('rename', b); return fs.renameSync(a, b); },
    openSync: (f, flags, ...rest) => { if (writeFlag(flags)) effect('open', f); return fs.openSync(f, flags, ...rest); },
    mkdirSync: (d, o) => { effect('mkdir', d); return fs.mkdirSync(d, o); },
    writeFileSync: (f, ...rest) => { effect('write', f); return fs.writeFileSync(f, ...rest); },
    unlinkSync: (f) => { effect('unlink', f); return fs.unlinkSync(f); },
    rmSync: (f, o) => { effect('rm', f); return fs.rmSync(f, o); },
    createWriteStream: (f, o) => { effect('open', f); return fs.createWriteStream(f, o); },
    createReadStream: (f, o) => { streams.push(String(f)); const st = fs.createReadStream(f, o); openStreams.push(st); return st; },
    promises: {
      ...p,
      ...promised,
      rename: (a, b) => {
        if (busy > 0) { busy--; return after('fs.rename', Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }))); }
        effect('rename', b);
        return after('fs.rename', p.rename(a, b));
      },
      open: (f, flags, ...rest) => { if (writeFlag(flags)) effect('open', f); return after('fs.open', p.open(f, flags, ...rest).then(wrapHandle)); },
      mkdir: (d, o) => { effect('mkdir', d); return after('fs.mkdir', p.mkdir(d, o)); },
      writeFile: (f, ...rest) => { effect('write', f); return after('fs.writeFile', p.writeFile(f, ...rest)); },
      unlink: (f) => { effect('unlink', f); return after('fs.unlink', p.unlink(f)); },
      rm: (f, o) => { effect('rm', f); return after('fs.rm', p.rm(f, o)); },
    },
  };

  function memoryStore(name, key, initial) {
    const data = { [key]: JSON.parse(JSON.stringify(initial)) };
    return {
      data,
      get: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d),
      set: (k, v) => { effect(name, k); data[k] = JSON.parse(JSON.stringify(v)); },
    };
  }
  const durable = createDurableFiles(countingFs);
  const stores = {
    history: memoryStore('history', 'recordings', history ?? recordings.map((id) => ({ id, userId: 'a', uploadStatus: 'pending' }))),
    queue: memoryStore('queue', 'pendingUploads', queue ?? []),
    active: memoryStore('active', 'activeSession', active ?? null),
  };

  // HTTP: real axios + api-resilience, routed transport.
  const overrides = [];
  const http = axios.create({
    adapter: (config) => {
      const entry = { method: String(config.method).toLowerCase(), url: String(config.url), auth: config.headers?.Authorization || null, body: config.data, after: mark.changed };
      // A real transport consumes the body; this one never reads it - a
      // stream body must not raise an unhandled error (file gone later).
      if (config.data && typeof config.data.on === 'function') config.data.on('error', () => {});
      requests.push(entry);
      if (config.signal?.aborted && !lateAnswers) return Promise.reject(new axios.CanceledError('canceled', null, config));
      const i = overrides.findIndex((o) => o.match(entry, config));
      const next = i >= 0 ? overrides.splice(i, 1)[0].answer : defaultAnswer;
      const pending = Promise.resolve(typeof next === 'function' ? next(config) : next);
      const settled = after('http', pending).then((a) => {
        if (a instanceof Error) throw a;
        const response = { data: a.data, status: a.status, statusText: String(a.status), headers: { 'content-type': 'application/json' }, config, request: {} };
        if (a.status >= 400) throw new axios.AxiosError(`HTTP ${a.status}`, a.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config, {}, response);
        return response;
      });
      if (lateAnswers || !config.signal) return settled;
      return new Promise((resolve, reject) => {
        config.signal.addEventListener('abort', () => reject(new axios.CanceledError('canceled', null, config)), { once: true });
        settled.then(resolve, reject);
      });
    },
  });
  // The gateway-retry sleep is a timer of its own (a suspension point).
  installApiResilience({ axios: http, log: quiet, getApiBaseUrl: () => API, sleep: (ms) => new Promise((res) => timers.setTimeout(res, ms)) });
  /** One answer for the next request that matches (method, url suffix or RegExp). */
  function answer(method, url, value) {
    const match = (e) => e.method === method && (url instanceof RegExp ? url.test(e.url) : e.url.endsWith(url));
    overrides.push({ match, answer: value });
  }

  const timers = {
    setTimeout: (fn, ms) => {
      sleeps.push({ ms, after: mark.changed });
      const handle = setTimeout(() => { hit(`timer:${ms}`); fn(); }, 0);
      if (hooks.onTimer) { const h = hooks.onTimer; h(ms); }
      return handle;
    },
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
  };

  // The session at start: 'signedIn' (a), 'signedOut' (fresh install),
  // 'tombstone' (a signed in, then out, restart), 'held' (a signed in, the
  // record is not readable at this start), 'unreadable' (broken record).
  let scopes;
  const disk = createDisk();
  if (session === 'tombstone' || session === 'held') {
    const before = boot(disk);
    before.passwordSignIn('a').apply();
    if (session === 'tombstone') before.authority.signOut();
  }
  if (session === 'held') disk.failRecordRead = true;
  if (session === 'unreadable') disk.record = '{broken';
  const s = boot(disk, { onAbort: () => scopes && scopes.abortAll() });
  // The recording-lock queue of main (withRecordingLock): one more wait.
  const lock = () => after('lock', null);
  if (session === 'signedIn') s.passwordSignIn('a').apply();

  const ports = {
    probeDuration: (filePath) => { spawns.push({ port: 'probeDuration', filePath, after: mark.changed }); return after('port.probeDuration', 45); },
    probeAudio: (filePath) => { spawns.push({ port: 'probeAudio', filePath, after: mark.changed }); return after('port.probeAudio', { format: { duration: '45' } }); },
    // As main's finalizeRecording: media work writes temporary files, the
    // output is published with a durable rename (publish gate of the scope).
    finalizeForRecovery: async (recordId) => {
      await lock();
      // As main: the lock queue may run this long after the request.
      assertPublishAllowed();
      spawns.push({ port: 'finalizeForRecovery', recordId, after: mark.changed });
      const outputPath = path.join(root, recordId, 'audio.webm');
      await durable.writeFileAtomic(outputPath, Buffer.alloc(10, 2));
      return { success: true, outputPath, duration: 45, fileSize: 10, fileSizeMb: '0.00' };
    },
    ...portOverrides,
  };
  scopes = registryFactory({
    authority: s.authority, http, fs: countingFs, stores, timers, ports, log: quiet,
    send: (channel, payload) => sent.push({ channel, payload, after: mark.changed }),
  });

  const getRecordingPath = (id) => path.join(root, id);
  const read = {
    getUser: () => s.authority.getUser(),
    getRecordingPath,
    getRecordingsPath: () => root,
    recordingOwner: () => 'a',
    readUploadReceipt: (id) => {
      try { return JSON.parse(fs.readFileSync(path.join(getRecordingPath(id), 'upload-receipt.json'), 'utf8')); } catch { return null; }
    },
    assessRecordingUpload: () => after('read.assess', { allowed: true }),
    recordingState: (id) => ({ unsaved: false, locked: false, live: false, inFlight: scopes.inFlight.has(id) }),
    recordingInProgress: () => false,
    inFlight: (id) => scopes.inFlight.has(id),
    readFinalizedRecording: () => after('read.finalized', null),
    listSessions: () => [],
    listChunkBatches: () => [],
    usesNativeSources: () => false,
    validateAudioOutput: async () => ({ valid: true }),
    ...readOverrides,
  };
  const report = { messages: [], failures: [], exceptions: [] };
  const background = createBackground({
    config: { apiBaseUrl: API, appVersion: 'test', FINALIZATION_PENDING_MARKER: '.finalization-pending', rescanMs: 120000 },
    read,
    pure: {
      tokenUserId, sessionTokenUserId, canUploadForUser, verifiedUploadResult, withCaptureWarnings, repairRecoveredHistoryRecord,
      safeParseDuration: (m) => { const d = parseFloat(m?.format?.duration); return Number.isFinite(d) ? Math.round(d) : 0; },
      calculateUploadTimeout: () => 600000,
      FormData,
    },
    report: {
      captureMessage: (...a) => report.messages.push(a),
      captureException: (...a) => report.exceptions.push(a),
      captureUploadFailureOnce: (...a) => report.failures.push(a),
    },
    hooks: { onBusyChange: () => {} },
    log: quiet,
  });

  const change = () => {
    if (!mark.changed) sweep.queueAtChange = JSON.stringify(stores.queue.data);
    mark.changed = true;
  };
  const signOut = () => { change(); s.authority.signOut(); };
  const signInB = () => s.passwordSignIn('b').apply();
  const signOutThenB = () => { signOut(); signInB(); };
  const signInA = () => s.passwordSignIn('a').apply();
  const refresh = () => s.authority.applySession(s.authority.ticket({ userId: 'a' }), { token: jwt('a', 'refreshed'), user: { id: 'a' } }, { kind: 'refresh' });
  /** Ends every scope, lets the work settle, then removes the recordings root. */
  const cleanup = async () => {
    scopes.abortAll();
    for (let i = 0; i < 20; i++) await flush();
    // Windows keeps a folder with an open handle: close every source stream
    // the rig opened before removing the root.
    await Promise.all(openStreams.map((st) => (st.closed ? null : new Promise((done) => { st.once('close', done); st.destroy(); }))));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  const filePath = (id = 'r1') => path.join(root, id, 'audio.webm');

  return {
    root, fs: countingFs, disk, s, scopes, background, uploads: background.uploads, stores, http, answer, hooks, read, report,
    effects, requests, sent, sleeps, spawns, streams, mark, points, sweep, timers,
    change, signOut, signInB, signOutThenB, signInA, refresh, cleanup, filePath,
    effectsAfter: () => effects.filter((e) => e.after),
    requestsAfter: () => requests.filter((r) => r.after),
    sentAfter: () => sent.filter((e) => e.after),
    spawnsAfter: () => spawns.filter((e) => e.after),
  };
}
