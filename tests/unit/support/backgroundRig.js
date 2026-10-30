// Test rig for main's background work (review rounds 9 and 10): the REAL
// session authority (desktopSession boot), the REAL scope registry, the REAL
// background modules (src-electron/background/) and - round 10, F4 - the
// REAL ports and renderer send of main (support/mainSlice.js: finalizeRecording
// with its whole chain, the recording lock, ffprobe), with the REAL modules
// it uses. Stand-ins only at the edges, and every edge counts globally:
// - Files and child processes: support/globalSinks.js counts at the `fs`
//   and `child_process` module boundaries (FileHandle writes included);
//   ffmpeg/ffprobe are a stub process there (or the bundled test binaries:
//   `media: 'real'`).
// - HTTP: a real axios instance (api-resilience installed) whose transport
//   is a router; every request is logged with `after` (sent after the
//   session change).
// - Stores (history, queue, active): every set is an effect.
// - Renderer: main's window is a fake whose `webContents.send` is logged.
// - Timers of the background: logged.
// `change()` marks the moment of the session change; `effectsAfter()` and
// `requestsAfter()` are what the rules forbid after it.

import { sinks, emulateMedia, STUB_FFMPEG, STUB_FFPROBE } from './globalSinks.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDisk, boot, jwt } from './desktopSession.js';
import { compileMainChain, loadMainChain } from './mainSlice.js';

const require = createRequire(import.meta.url);
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const { createScopeRegistry } = require('../../../src-electron/session-scope.js');
const { installApiResilience } = require('../../../src-electron/api-resilience.js');
const { createBackground } = require('../../../src-electron/background/index.js');
const { tokenUserId, canUploadForUser, verifiedUploadResult } = require('../../../src-electron/upload-safety.js');
const { tokenUserId: sessionTokenUserId } = require('../../../src-electron/session-authority.js');
const { withCaptureWarnings } = require('../../../src-electron/recording-history-warnings.js');
const { repairRecoveredHistoryRecord } = require('../../../src-electron/recording-export.js');
const persistence = require('../../../src-electron/recording-persistence.js');
const durableFiles = require('../../../src-electron/durable-files.js');
const nativeSession = require('../../../src-electron/native-recording-session.js');
const eligibility = require('../../../src-electron/recording-upload-eligibility.js');

export { jwt, sinks, STUB_FFMPEG, STUB_FFPROBE };
export const API = 'http://api.test';
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

export function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A WebM chunk as MediaRecorder writes the first one (EBML header). */
export function webmChunk(size = 2048, fill = 3) {
  const bytes = Buffer.alloc(size, fill);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(bytes);
  return bytes;
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
export async function until(predicate, rounds = 200) {
  for (let i = 0; i < rounds && !predicate(); i++) await flush();
  if (!predicate()) throw new Error('until: condition not reached');
}

ffmpeg.setFfmpegPath(STUB_FFMPEG);
ffmpeg.setFfprobePath(STUB_FFPROBE);
// fluent-ffmpeg asks the binary for its formats/encoders once per process
// and caches them: ask now, so every rig sees the same suspension points.
{
  const warm = { root: os.tmpdir(), media: 'stub', effect() {}, after: (l, p) => p, waitThen: (l, fn) => setImmediate(fn), busy: () => false, spawn() {}, stream() {}, emulate: (file, args) => emulateMedia(file, args) };
  sinks.bind(warm);
  await new Promise((done, fail) => ffmpeg().availableFormats((e) => (e ? fail(e) : done())));
  await new Promise((done, fail) => ffmpeg().availableEncoders((e) => (e ? fail(e) : done())));
  sinks.unbind(warm);
}

// The chain of main is compiled once; each rig evaluates it afresh (own lock
// map, own binary health) with its own edges.
let compiled = null;
const mainChain = () => (compiled || (compiled = compileMainChain()));

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
 * @param {boolean} [opts.realRead] main's real read helpers (recovery with the real chain)
 * @param {object} [opts.ports] overrides of main's ports
 * @param {'stub'|'real'} [opts.media] ffmpeg/ffprobe: stub process or the bundled test binaries
 * @param {(args: string[]) => boolean} [opts.ffmpegFails] the stub ffmpeg fails for these arguments
 * @param {(source: string) => string} [opts.mainTransform] a mutation of main's source (compiled per rig)
 * @param {object} [opts.disk] the persistent state of an earlier rig (a restart; with session 'persisted')
 * @param {string} [opts.session] see below
 */
export function createBackgroundRig({
  session = 'signedIn', recordings = ['r1'], lateAnswers = false, read: readOverrides = {}, ports: portOverrides = {},
  history, queue, active, renameBusy = 0, registryFactory = createScopeRegistry, realRead = false, media = 'stub',
  ffmpegFails = null, mainTransform = null, disk: givenDisk = null,
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
  const reports = [];
  const hooks = { onTimer: null, onEffect: null, hold: null };
  // Suspension points (sweep): every asynchronous edge counts once, right
  // before the waiting code continues - HTTP answers, timers, every fs
  // completion inside the recordings root (promise and callback API, file
  // handles), child-process exits. `sweep.at = N` fires `sweep.action` at
  // the N-th point (label, target path).
  const points = [];
  const sweep = { at: 0, action: null, fired: false, queueAtChange: null, when: null };
  const hit = (label, target = null) => {
    if (paused) return;
    points.push(label);
    if (sweep.fired || !sweep.action) return;
    if (sweep.when ? sweep.when(label, target) : sweep.at === points.length) { sweep.fired = true; sweep.action(label, target); }
  };
  // `hooks.hold(label)` may return a promise: the edge then waits for it
  // (a delayed system call) before the waiting code continues.
  const held = async (label, target) => { const h = hooks.hold && hooks.hold(label, target); if (h) await h; };
  const after = (label, promise, target = null) => Promise.resolve(promise).then(
    async (value) => { await held(label, target); hit(label, target); return value; },
    async (error) => { await held(label, target); hit(label, target); throw error; }
  );
  // Fixture writes of the test itself (r.quietly) are no effects.
  let paused = false;
  const quietly = (fn) => { paused = true; try { return fn(); } finally { paused = false; } };
  const effect = (kind, target) => {
    if (paused) return;
    effects.push({ kind, target: String(target), after: mark.changed });
    if (hooks.onEffect) hooks.onEffect(kind, String(target));
  };
  let busy = renameBusy;
  const recorder = {
    root,
    media,
    effect,
    after,
    waitThen: (label, fn, target = null) => {
      Promise.resolve().then(async () => {
        await held(label, target);
        hit(label, target);
        try { fn(); } catch (error) { process.nextTick(() => { throw error; }); }
      });
    },
    busy: () => (busy > 0 ? (busy--, true) : false),
    spawn: (info) => { if (!paused) spawns.push({ ...info, after: mark.changed }); },
    stream: (file, stream) => { streams.push(file); openStreams.push(stream); },
    emulate: (file, args) => emulateMedia(file, args, { fail: ffmpegFails }),
  };
  sinks.bind(recorder);

  function memoryStore(name, key, initial) {
    const data = { [key]: JSON.parse(JSON.stringify(initial)) };
    return {
      data,
      get: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d),
      set: (k, v) => { effect(name, k); data[k] = JSON.parse(JSON.stringify(v)); },
      delete: (k) => { effect(name, k); delete data[k]; },
    };
  }
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
  // record is not readable at this start), 'unreadable' (broken record),
  // 'persisted' (a restart on `disk`: the session it holds, no new sign-in).
  let scopes;
  const disk = givenDisk || createDisk();
  if (session === 'tombstone' || session === 'held') {
    const before = boot(disk);
    before.passwordSignIn('a').apply();
    if (session === 'tombstone') before.authority.signOut();
  }
  if (session === 'held') disk.failRecordRead = true;
  if (session === 'unreadable') disk.record = '{broken';
  const s = boot(disk, { onAbort: () => scopes && scopes.abortAll() });
  if (session === 'signedIn') s.passwordSignIn('a').apply();

  // Main's chain with its edges (Electron, window, Sentry, binary paths).
  const window = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload, after: mark.changed }) } };
  const sentry = {
    captureMessage: (...a) => reports.push({ kind: 'message', args: a, after: mark.changed }),
    captureException: (...a) => reports.push({ kind: 'exception', args: a, after: mark.changed }),
  };
  const chain = loadMainChain(mainTransform ? compileMainChain({ transform: mainTransform }) : mainChain(), {
    app: { isPackaged: false, getPath: () => root, getVersion: () => 'test' },
    ffmpeg,
    log: quiet,
    Sentry: sentry,
    mainWindow: window,
    historyStore: stores.history,
    uploadQueueStore: stores.queue,
    activeRecordingStore: stores.active,
    sessionAuthority: s.authority,
    inFlightUploads: { has: (id) => !!scopes && scopes.inFlight.has(id) },
    resolveBundledBinaryPaths: () => ({ ffmpeg: STUB_FFMPEG, ffprobe: STUB_FFPROBE }),
    // Main's effect gate is installed once per process; loading the chain
    // again (each rig) replaces its folder with this one (effect-gate.js).
    getRecordingsPath: () => root,
    isExportRecoveryBusy: () => false,
    stopSystemAudio: async () => ({ success: true }),
    activeAudioTee: null,
    isRecordingInProgress: false,
    isProcessingRecording: false,
    unsavedRecordingId: null,
    reportBinaryHealthOnce: () => {},
    updateRecordingPowerBlocker: () => {},
  });
  // Port calls are logged too (an effect of their own: a port must not
  // start after the change).
  const ports = {};
  for (const [name, fn] of Object.entries({ ...chain.ports, ...portOverrides })) {
    ports[name] = (...args) => {
      spawns.push({ port: name, recordId: name === 'finalizeForRecovery' ? args[0] : undefined, filePath: name === 'finalizeForRecovery' ? undefined : args[0], after: mark.changed });
      return fn(...args);
    };
  }
  scopes = registryFactory({
    authority: s.authority, http, stores, timers, ports, log: quiet, send: chain.send,
  });

  const getRecordingPath = (id) => path.join(root, id);
  const mainRead = {
    readFinalizedRecording: (dirPath) => persistence.readFinalizedRecording(dirPath),
    listSessions: (dirPath) => persistence.listSessions(dirPath),
    listChunkBatches: (dirPath) => durableFiles.listChunkBatches(dirPath),
    usesNativeSources: (dirPath) => nativeSession.usesNativeSources(dirPath),
    validateAudioOutput: (filePath) => chain.validateAudioOutput(filePath),
    assessRecordingUpload: (args) => eligibility.assessRecordingUpload(args),
  };
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
    ...(realRead ? mainRead : {}),
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
    sinks.unbind(recorder);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  const filePath = (id = 'r1') => path.join(root, id, 'audio.webm');

  return {
    root, disk, s, scopes, background, uploads: background.uploads, stores, http, answer, hooks, read, report, chain,
    effects, requests, sent, sleeps, spawns, streams, reports, mark, points, sweep, timers,
    change, signOut, signInB, signOutThenB, signInA, refresh, cleanup, filePath, quietly,
    effectsAfter: () => effects.filter((e) => e.after),
    requestsAfter: () => requests.filter((r) => r.after),
    sentAfter: () => sent.filter((e) => e.after),
    spawnsAfter: () => spawns.filter((e) => e.after),
    reportsAfter: () => reports.filter((e) => e.after),
  };
}
