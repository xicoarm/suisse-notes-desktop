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
 * - Round 11: open flags are classified by their bits too (fs.constants
 *   O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND - O_TRUNC empties a file
 *   at the open already), readFile with a writing flag is an open. A path
 *   is compared after its real path (symlinks, junctions; for a new file or
 *   a call that acts on the link itself the parent's), with the letter case
 *   folded on macOS and Windows. A descriptor or handle opened for writing
 *   is remembered with its path whatever the context it was opened in, so
 *   a write to it from background work after the end is refused even when
 *   the foreground opened it. Not resolved: hard links to a file of the
 *   folder made elsewhere (main makes none; `link` is checked on both
 *   names), descriptors from outside the fs module (none in main: static
 *   rules).
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
const { constants } = require('fs');

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
  copyFile: [1], cp: [1], truncate: [0], symlink: [1], link: [0, 1], utimes: [0], lutimes: [0], chmod: [0],
  lchmod: [0], chown: [0], lchown: [0],
};
// Calls on the link itself, not on what it points to (or creating a name):
// their path is compared by its parent's real path.
const NOFOLLOW = new Set(['unlink', 'rm', 'rmdir', 'rename', 'symlink', 'link', 'lutimes', 'lchmod', 'lchown', 'mkdir', 'mkdtemp']);
const FD_WRITES = ['write', 'writev', 'ftruncate', 'fchmod', 'futimes', 'fchown'];
const HANDLE_WRITES = ['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes'];
const WRITE_BITS = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND;

/** Does an open with these flags write (or create, or empty) the file? */
function writeFlags(flags) {
  if (typeof flags === 'number') return (flags & WRITE_BITS) !== 0;
  // open(path, callback) and open(path): read
  if (flags === undefined || flags === null || typeof flags === 'function') return false;
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return true;
}
const FOLD = process.platform === 'darwin' || process.platform === 'win32';
const fold = (p) => (FOLD ? p.normalize('NFC').toLowerCase() : p);
const within = (root, target) => {
  const rel = path.relative(fold(root), fold(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

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
  if (fs[INSTALLED]) { fs[INSTALLED].roots = roots; fs[INSTALLED].version++; return false; }
  const state = { roots, version: 0 };
  Object.defineProperty(fs, INSTALLED, { value: state });
  // Descriptors and handles opened for writing, in any context: fd/handle ->
  // { path, version, inside } (inside: decided once, when first needed).
  const writableFds = new Map();
  const writableHandles = new WeakMap();
  const { realpathSync, readlinkSync } = fs;

  const asPath = (value) => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString();
    if (value instanceof URL) return require('url').fileURLToPath(value);
    return null;
  };
  /**
   * The real path: the nearest existing ancestor resolved (a dangling link
   * to its target), the rest appended. `follow` false: the last component
   * is the name itself (unlink of a link removes the link).
   */
  function canonical(p, follow) {
    let target = path.resolve(p);
    const rest = [];
    if (!follow) { rest.unshift(path.basename(target)); target = path.dirname(target); }
    for (let hops = 0; hops < 64; hops++) {
      try { return path.join(realpathSync.call(fs, target), ...rest); } catch (_) { /* missing or dangling */ }
      try { target = path.resolve(path.dirname(target), readlinkSync.call(fs, target)); continue; } catch (_) { /* no link */ }
      const parent = path.dirname(target);
      if (parent === target) break;
      rest.unshift(path.basename(target));
      target = parent;
    }
    return path.join(target, ...rest);
  }
  const canonicalRoots = new Map();
  const canonicalRoot = (root) => {
    if (!canonicalRoots.has(root)) {
      if (canonicalRoots.size > 64) canonicalRoots.clear();
      canonicalRoots.set(root, canonical(root, true));
    }
    return canonicalRoots.get(root);
  };
  /** Inside a root (an unreadable path argument fails closed). */
  function inside(value, follow = true) {
    const p = asPath(value);
    if (p === null) return true;
    let list;
    try { list = (state.roots() || []).map((root) => path.resolve(root)); } catch (_) { return true; }
    const target = path.resolve(p);
    if (list.some((root) => within(root, target))) return true;
    // Not inside by its name: by its real path (an alias of the folder)?
    let real;
    try { real = canonical(target, follow); } catch (_) { return true; }
    return list.some((root) => within(canonicalRoot(root), real));
  }
  const entry = (value) => ({ path: asPath(value), version: -1, inside: false });
  const insideEntry = (e) => {
    if (!e) return false;
    if (e.version !== state.version) { e.inside = e.path === null || inside(e.path); e.version = state.version; }
    return e.inside;
  };
  /** Does this call write into a root? */
  function concerns(name, args) {
    if (name === 'open') return writeFlags(args[1]) && inside(args[0]);
    if (name === 'readFile') return typeof args[1] === 'object' && args[1] !== null && writeFlags(args[1].flag) && asPath(args[0]) !== null && inside(args[0]);
    if (FD_WRITES.includes(name)) return insideEntry(writableFds.get(args[0]));
    const indices = PATH_WRITES[name];
    if (!indices) return false;
    if (name === 'writeFile' || name === 'appendFile') {
      if (typeof args[0] === 'number') return insideEntry(writableFds.get(args[0]));
      if (writableHandles.has(args[0])) return insideEntry(writableHandles.get(args[0]));
    }
    if (name === 'unlink' && TEMP.test(String(asPath(args[0]) ?? ''))) return false;
    return indices.some((i) => inside(args[i], !NOFOLLOW.has(name)));
  }
  const track = (args, fd) => { if (typeof fd === 'number' && writeFlags(args[1])) writableFds.set(fd, entry(args[0])); };

  // Outside a gated context every call passes unchanged (no path check);
  // only a descriptor or handle opened for writing is remembered.
  function gateSync(name) {
    const base = name.slice(0, -4);
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function (...args) {
      if (base === 'close') writableFds.delete(args[0]);
      if (!publishGate.getStore()) {
        const opened = original.apply(this, args);
        if (base === 'open') track(args, opened);
        return opened;
      }
      if (concerns(base, args)) { const error = refusal(); if (error) throw error; }
      const result = admitted.run(true, () => original.apply(this, args));
      if (base === 'open') track(args, result);
      return result;
    };
  }

  function gateCallback(name) {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function (...args) {
      const callback = args[args.length - 1];
      if (name === 'close') writableFds.delete(args[0]);
      if (typeof callback !== 'function') return original.apply(this, args);
      const opens = name === 'open' && writeFlags(args[1]);
      const opened = (error, fd) => { if (!error && opens) track(args, fd); };
      if (!publishGate.getStore()) {
        if (!opens) return original.apply(this, args);
        args[args.length - 1] = function (...result) { opened(result[0], result[1]); return callback.apply(this, result); };
        return original.apply(this, args);
      }
      if (concerns(name, args)) {
        const error = refusal();
        if (error) { process.nextTick(callback, error); return undefined; }
      }
      args[args.length - 1] = function (...result) {
        opened(result[0], result[1]);
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
        if (publishGate.getStore() && insideEntry(writableHandles.get(this))) {
          const error = refusal();
          if (error) return Promise.reject(error);
          return admitted.run(true, () => original.apply(this, args));
        }
        return original.apply(this, args);
      };
    }
    const close = proto.close;
    if (typeof close === 'function') {
      // The number is free for reuse only once the close completed.
      proto.close = function (...args) { if (writableHandles.has(this)) writableFds.delete(this.fd); return close.apply(this, args); };
    }
  }
  const tracked = (pending, target) => pending.then((handle) => {
    if (!handlesGated) { handlesGated = true; gateHandles(Object.getPrototypeOf(handle)); }
    const e = entry(target);
    writableHandles.set(handle, e);
    writableFds.set(handle.fd, e);
    return handle;
  });

  function gatePromise(name) {
    const original = fs.promises[name];
    if (typeof original !== 'function') return;
    fs.promises[name] = function (...args) {
      const opens = name === 'open' && writeFlags(args[1]);
      if (!publishGate.getStore()) return opens ? tracked(original.apply(this, args), args[0]) : original.apply(this, args);
      if (concerns(name, args)) { const error = refusal(); if (error) return Promise.reject(error); }
      const pending = admitted.run(true, () => original.apply(this, args));
      return opens ? tracked(pending, args[0]) : pending;
    };
  }

  const CALLBACK = ['open', 'close', 'readFile', ...FD_WRITES, ...Object.keys(PATH_WRITES)];
  for (const name of CALLBACK) gateSync(`${name}Sync`);
  for (const name of CALLBACK) gateCallback(name);
  for (const name of ['open', 'readFile', ...Object.keys(PATH_WRITES)]) gatePromise(name);

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
