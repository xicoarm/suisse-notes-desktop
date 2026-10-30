'use strict';

/**
 * Effect gate of main (security review 10/2026, round 10).
 *
 * WHY: round 9 put the session check into the scope's own methods and into
 * the renames of durable-files. The recovery chain (finalizeRecording,
 * recording-persistence, durable-files, the system-audio merge, native
 * finalization, the Opus inspection) still reached other system calls
 * directly - an mkdir after a readdir, an unlink after a publish, a second
 * ffprobe after the first - and each review found the next one. So there is
 * ONE checked sink now, at the module boundary: main installs this gate
 * before any other module is loaded, and every write-class call of `fs`
 * (sync, callback and promise API, FileHandle writes) and every
 * `child_process` start checks the publish gate of its asynchronous context
 * synchronously, right before the system call.
 *
 * - The publish gate is the context of background work of one session
 *   (session-scope.js runs ports and durable writes in `publishGate.run`).
 *   Outside such a context (foreground: recording, stop, export) every call
 *   passes unchanged.
 * - Inside it, after the session ended, the call is refused with the
 *   scope's SessionEndedError: sync calls throw, callback calls get it as
 *   their error, promise calls reject, a child process is never started (an
 *   already-dead child that failed is returned instead).
 * - Files: only paths inside `roots()` (the recordings folder) and file
 *   descriptors/handles opened on them. Logs, telemetry, the session record
 *   and the stores are not files of the recordings folder.
 * - Allowed after the change: removing an own unpublished temp file
 *   (`<name>.<uuid>.tmp`, durable-files). Calls Node makes inside an admitted
 *   call (rm walking a tree) belong to that call: it was handed to the system
 *   before the change.
 * - Child processes: every start in a gated context, whatever the binary
 *   (fluent-ffmpeg starts its processes from callbacks of its own). A
 *   process that already runs is not killed (council 3: media work only
 *   writes temporary files); its result is published only through the gate.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const path = require('path');

const publishGate = new AsyncLocalStorage();
const admitted = new AsyncLocalStorage();

/** Throws the gate's SessionEndedError after the session of this context ended. */
function assertPublishAllowed() {
  const gate = publishGate.getStore();
  if (gate) gate.assertAlive();
}

/** The refusal of this context (an error), or null. */
function refusal() {
  const gate = publishGate.getStore();
  if (!gate || admitted.getStore()) return null;
  try { gate.assertAlive(); return null; } catch (error) { return error; }
}

const TEMP = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

// name -> indices of the path arguments (callback and promise API alike)
const PATH_WRITES = {
  writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], rename: [0, 1], unlink: [0], rm: [0], rmdir: [0],
  copyFile: [1], cp: [1], truncate: [0], symlink: [1], link: [1], utimes: [0], lutimes: [0], chmod: [0],
  lchmod: [0], chown: [0], lchown: [0],
};
const FD_WRITES = ['write', 'writev', 'ftruncate', 'fchmod', 'futimes', 'fchown'];
const HANDLE_WRITES = ['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes'];
const writeFlags = (flags) => /[wa+]/.test(String(flags ?? 'r'));

const INSTALLED = Symbol.for('suisse.effectGate');

/**
 * Installs the gate on the `fs` and `child_process` modules (once per process).
 * @param {object} opts
 * @param {() => string[]} opts.roots - folders whose files are effects (the recordings folder)
 * @param {object} [opts.fs]
 * @param {object} [opts.childProcess]
 */
function installEffectGate({ roots, fs = require('fs'), childProcess = require('child_process') }) {
  // Installed once per process; a later call only replaces the folders (main
  // installs once; each test rig loads main's chain again with its own folder).
  if (fs[INSTALLED]) { fs[INSTALLED].roots = roots; return false; }
  const state = { roots };
  Object.defineProperty(fs, INSTALLED, { value: state });
  const protectedFds = new Set();
  const protectedHandles = new WeakSet();

  const asPath = (value) => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString();
    if (value instanceof URL) return require('url').fileURLToPath(value);
    return null;
  };
  /** Inside a root (an unreadable path argument fails closed). */
  function inside(value) {
    const p = asPath(value);
    if (p === null) return true;
    const target = path.resolve(p);
    let list;
    try { list = state.roots() || []; } catch (_) { return true; }
    return list.some((root) => {
      const rel = path.relative(path.resolve(root), target);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }
  /** Does this call write into a root? */
  function concerns(name, args) {
    if (name === 'open') return writeFlags(args[1]) && inside(args[0]);
    if (FD_WRITES.includes(name)) return protectedFds.has(args[0]);
    const indices = PATH_WRITES[name];
    if (!indices) return false;
    if ((name === 'writeFile' || name === 'appendFile') && typeof args[0] === 'number') return protectedFds.has(args[0]);
    if (name === 'unlink' && TEMP.test(String(asPath(args[0]) ?? ''))) return false;
    return indices.some((i) => inside(args[i]));
  }
  const remember = (name, args, fd) => { if (name === 'open' && typeof fd === 'number' && writeFlags(args[1]) && inside(args[0])) protectedFds.add(fd); };

  // Outside a gated context every call passes unchanged (no path check, no
  // bookkeeping). File descriptors and handles count as files of a root only
  // when opened for writing inside a gated context.
  function gateSync(name) {
    const base = name.slice(0, -4);
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function (...args) {
      if (base === 'close') protectedFds.delete(args[0]);
      if (!publishGate.getStore()) return original.apply(this, args);
      if (concerns(base, args)) { const error = refusal(); if (error) throw error; }
      const result = admitted.run(true, () => original.apply(this, args));
      if (base === 'open') remember(base, args, result);
      return result;
    };
  }

  function gateCallback(name) {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function (...args) {
      const callback = args[args.length - 1];
      if (name === 'close') protectedFds.delete(args[0]);
      if (typeof callback !== 'function' || !publishGate.getStore()) return original.apply(this, args);
      const opened = (error, fd) => { if (!error) remember(name, args, fd); };
      if (concerns(name, args)) {
        const error = refusal();
        if (error) { process.nextTick(callback, error); return undefined; }
      }
      args[args.length - 1] = function (...result) {
        if (name === 'open') opened(result[0], result[1]);
        return admitted.exit(() => callback.apply(this, result));
      };
      return admitted.run(true, () => original.apply(this, args));
    };
  }

  let handlesGated = false;
  function gateHandles(proto) {
    for (const name of HANDLE_WRITES) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      proto[name] = function (...args) {
        if (publishGate.getStore() && protectedHandles.has(this)) {
          const error = refusal();
          if (error) return Promise.reject(error);
          return admitted.run(true, () => original.apply(this, args));
        }
        return original.apply(this, args);
      };
    }
  }

  function gatePromise(name) {
    const original = fs.promises[name];
    if (typeof original !== 'function') return;
    fs.promises[name] = function (...args) {
      if (!publishGate.getStore()) return original.apply(this, args);
      if (concerns(name, args)) { const error = refusal(); if (error) return Promise.reject(error); }
      const pending = admitted.run(true, () => original.apply(this, args));
      if (name !== 'open' || !writeFlags(args[1]) || !inside(args[0])) return pending;
      return pending.then((handle) => {
        if (!handlesGated) { handlesGated = true; gateHandles(Object.getPrototypeOf(handle)); }
        protectedHandles.add(handle);
        return handle;
      });
    };
  }

  const CALLBACK = ['open', 'close', ...FD_WRITES, ...Object.keys(PATH_WRITES)];
  for (const name of CALLBACK) gateSync(`${name}Sync`);
  for (const name of CALLBACK) gateCallback(name);
  for (const name of ['open', ...Object.keys(PATH_WRITES)]) gatePromise(name);

  // --- child processes: no start after the session of this context ended ---
  function refusedChild(error, callback) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.exitCode = null;
    child.killed = false;
    child.kill = () => false;
    // It ends as a process that failed (exit code 1, the refusal on stderr),
    // not with an 'error' event: fluent-ffmpeg cannot take an 'error' event
    // of its child. Callback APIs get the refusal itself; the callers of the
    // recovery chain check the gate when a child fails (ffmpegWithTimeout,
    // encoded-opus-evidence), so the result is the scope's SESSION_ENDED.
    child.refusal = error;
    process.nextTick(() => {
      if (callback) callback(error, '', '');
      child.stderr.end(`${error.message}\n`);
      child.stdout.end();
      child.exitCode = 1;
      child.emit('exit', 1, null);
      child.emit('close', 1, null);
    });
    return child;
  }
  for (const name of ['spawn', 'execFile', 'exec', 'fork']) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    childProcess[name] = function (...args) {
      const error = refusal();
      if (error) return refusedChild(error, typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null);
      return original.apply(this, args);
    };
  }
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    childProcess[name] = function (...args) {
      const error = refusal();
      if (error) throw error;
      return original.apply(this, args);
    };
  }
  return true;
}

module.exports = { publishGate, assertPublishAllowed, installEffectGate };
