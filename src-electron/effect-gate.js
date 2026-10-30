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
 *   at the open already), readFile with a writing flag is an open.
 * - Round 12, fail-closed: after the end a call passes only when it is
 *   PROVEN that it does not reach the folder. A path is resolved the way the
 *   system does it, name by name, a link followed where it stands before a
 *   later «..» goes up from its target (no normalization first), and also
 *   after collapsing «..» first (Windows and Node there); the letter case
 *   is folded on macOS and Windows, Windows' own spelling (short names) is
 *   taken from the system. A path that cannot be decided (a loop, no
 *   access, «..» after a missing name, a device path) is refused, and so is
 *   a write to the content or the attributes of a file with a second name
 *   (a hard link). Every descriptor and handle - any flags, any context -
 *   holds what its open found (the file's identity and whether it was a
 *   file of the folder) until its close: removing or renaming the alias
 *   later cannot weaken it. A call on a descriptor passes only for a pipe,
 *   a terminal or a socket, or for a file its open found outside that is
 *   still the same file, still outside and has no second name. Writes,
 *   truncation and attributes (fchmod, futimes, fchown, handle.chmod/
 *   utimes/chown) go through this one sink.
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
const WIN = process.platform === 'win32';
const FOLD = process.platform === 'darwin' || WIN;
const fold = (p) => (FOLD ? p.normalize('NFC').toLowerCase() : p);
const within = (root, target) => {
  const rel = path.relative(fold(root), fold(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
// How a call reaches its path: through every link ('follow'), on the name
// itself ('name': unlink of a link removes the link), or either ('both':
// link, copyFile and cp, where the systems differ).
const MODE = {
  unlink: 'name', rm: 'name', rmdir: 'name', rename: 'name', symlink: 'name', mkdir: 'name', mkdtemp: 'name',
  lutimes: 'name', lchmod: 'name', lchown: 'name', link: 'both', copyFile: 'both', cp: 'both',
};
// Calls on a name whose file keeps its content: a hard link elsewhere is no matter for them.
const NAME_ONLY = new Set(['unlink', 'rm', 'rmdir', 'rename', 'symlink', 'mkdir', 'mkdtemp']);
const MAX_LINKS = 40;
const SEPARATORS = WIN ? /[\\/]+/ : /\/+/;

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
  // Round 12: every descriptor and handle, opened in any context with any
  // flags: fd/handle -> what the open found (see `held`).
  const descriptors = new Map();
  const handles = new WeakMap();
  const { lstatSync, readlinkSync, fstatSync } = fs;
  const nativeRealpath = fs.realpathSync && fs.realpathSync.native;

  const asPath = (value) => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString();
    if (value instanceof URL) return require('url').fileURLToPath(value);
    return null;
  };
  /** The start of an absolute path ('/', 'C:\\', '\\\\server\\share\\') and its names; null: not decidable. */
  function split(p) {
    if (!WIN) return p.startsWith('/') ? { start: '/', names: p.split(SEPARATORS) } : null;
    const drive = /^([A-Za-z]:)[\\/]/.exec(p);
    if (drive) return { start: `${drive[1]}\\`, names: p.slice(3).split(SEPARATORS) };
    const unc = /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]+([^\\/]+)(?:[\\/]|$)/.exec(p);
    if (unc) return { start: `\\\\${unc[1]}\\${unc[2]}\\`, names: p.slice(unc[0].length).split(SEPARATORS) };
    // Device paths (\\?\, \\.\), a drive's own current folder (C:x), the current drive's root (\x).
    return null;
  }
  // A link's target as the system stores it on Windows (\\?\C:\..., \??\UNC\...).
  const plain = (target) => (WIN ? target.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '\\\\').replace(/^\\\?\?\\UNC\\/i, '\\\\').replace(/^([\\/]{2}[?.][\\/]|\\\?\?\\)(?=[A-Za-z]:)/, '') : target);

  /**
   * Round 12 (F8): the path the system reaches, resolved as the system does
   * it - name by name, a link followed where it stands, BEFORE a later «..»
   * goes up from its target (no normalization first: /out/link/../x is the
   * x next to the link's target). `follow` false: the last name itself (a
   * call on a link). Returns { real, stat } (stat: of the last name, null
   * when it does not exist) or null when the path cannot be decided: a loop
   * or more than 40 links, no access, a name that is no folder, «..» after
   * a missing name, a link that cannot be read, a device path.
   */
  function resolve(p, follow) {
    let absolute = p;
    if (!(WIN ? split(p) : p.startsWith('/'))) {
      let cwd;
      try { cwd = process.cwd(); } catch (_) { return null; }
      absolute = `${cwd}${path.sep}${p}`;
    }
    const parts = split(absolute);
    if (!parts) return null;
    const todo = parts.names.filter((name) => name !== '');
    // A trailing separator or «/.» follows a link even for a call on the name.
    const trailing = /[\\/]\.?$/.test(p) || /(^|[\\/])\.$/.test(p);
    let dir = parts.start;
    let missing = null;
    let stat;
    let links = 0;
    while (todo.length) {
      const name = todo.shift();
      if (name === '.') continue;
      if (name === '..') {
        if (missing) return null;
        dir = path.dirname(dir);
        stat = undefined;
        continue;
      }
      const at = path.join(dir, name);
      if (missing) { missing.push(name); dir = at; continue; }
      let st;
      try { st = lstatSync.call(fs, at, { throwIfNoEntry: false }); } catch (_) { return null; }
      if (!st) { missing = [name]; dir = at; stat = null; continue; }
      const last = todo.every((rest) => rest === '.');
      if (st.isSymbolicLink() && (!last || follow || trailing)) {
        if (++links > MAX_LINKS) return null;
        let target;
        try { target = plain(String(readlinkSync.call(fs, at))); } catch (_) { return null; }
        const absoluteTarget = split(target);
        if (absoluteTarget) {
          dir = absoluteTarget.start;
          todo.unshift(...absoluteTarget.names.filter((n) => n !== ''));
        } else if (WIN && /^([A-Za-z]:|[\\/])/.test(target)) {
          return null;
        } else {
          todo.unshift(...target.split(SEPARATORS).filter((n) => n !== ''));
        }
        continue;
      }
      dir = at;
      stat = st;
    }
    if (WIN) {
      // Short (8.3) names and the letter case: the system's own spelling of the existing part.
      const tail = missing ? missing.length : 0;
      let existing = dir;
      for (let i = 0; i < tail; i++) existing = path.dirname(existing);
      try { existing = nativeRealpath.call(fs, existing); } catch (_) { return null; }
      dir = path.join(existing, ...(missing || []));
    }
    return { real: dir, stat: stat || null };
  }
  /**
   * Every reading of a path: as the system resolves it, and after collapsing
   * «..» first (what Windows and Node there do before the system call).
   * Null when one of them cannot be decided.
   */
  function readings(p, follow) {
    let lexical;
    try { lexical = path.resolve(p); } catch (_) { return null; }
    const out = [];
    for (const source of lexical === p ? [p] : [p, lexical]) {
      const r = resolve(source, follow);
      if (!r) return null;
      out.push(r);
    }
    return out;
  }
  /** Every spelling of the folders (as given, collapsed, resolved); null: not decidable. */
  function rootForms() {
    let list;
    try { list = state.roots() || []; } catch (_) { return null; }
    const forms = [];
    for (const root of list) {
      const p = asPath(root);
      if (p === null) return null;
      forms.push(path.resolve(p));
      const r = readings(p, true);
      if (!r) return null;
      forms.push(...r.map((x) => x.real));
    }
    return forms;
  }
  const insideAny = (forms, target) => forms.some((root) => within(root, target));
  // A file with a second name: one of them may be in the folder.
  const shared = (stat) => Boolean(stat) && !stat.isDirectory() && stat.nlink > 1;

  /**
   * Round 12: may this call reach a file of the folders? Allowed only when it
   * is proven that it does not - in every reading of the path, and for a call
   * on the content or the attributes of a file, the file has no second name.
   */
  function reaches(value, mode, nameOnly = false) {
    const p = asPath(value);
    if (p === null || p === '') return true;
    const forms = rootForms();
    if (!forms) return true;
    try { if (insideAny(forms, path.resolve(p))) return true; } catch (_) { return true; }
    const follows = mode === 'both' ? [true, false] : [mode === 'follow'];
    for (const follow of follows) {
      const found = readings(p, follow);
      if (!found) return true;
      for (const { real, stat } of found) {
        if (insideAny(forms, real)) return true;
        if (!nameOnly && shared(stat)) return true;
      }
    }
    return false;
  }

  /**
   * Round 12 (F9/F10): what an open found, held until the close: the file's
   * identity (dev/ino of the descriptor) and its resolved path, and whether
   * it was a file of the folders then (or could not be decided). Losing the
   * alias later (the link removed or renamed) cannot weaken it.
   */
  let opening = false;
  function opened(target, fd) {
    const entry = { real: null, dev: null, ino: null, held: true };
    // An open made while the folders are asked for (none in main) stays held.
    if (opening) return entry;
    opening = true;
    try {
      const st = fstatSync.call(fs, fd);
      entry.dev = st.dev;
      entry.ino = st.ino;
      const p = asPath(target);
      const forms = rootForms();
      const found = p === null ? null : readings(p, true);
      if (!forms || !found) return entry;
      entry.real = found[0].real;
      // The path must lead to the file the descriptor holds.
      const same = found.every(({ stat }) => stat && stat.dev === st.dev && stat.ino === st.ino);
      entry.held = !same || insideAny(forms, path.resolve(p)) || found.some(({ real }) => insideAny(forms, real));
    } catch (_) { /* held */ } finally { opening = false; }
    return entry;
  }
  /**
   * May a call on this descriptor reach a file of the folders? Not a file
   * (a pipe, a terminal, a socket): no. A file: only when its open found it
   * outside, it is still the file of that open, it has no second name and
   * its path still leads to it, outside.
   */
  function heldFd(fd, entry) {
    if (typeof fd !== 'number') return true;
    let st;
    try { st = fstatSync.call(fs, fd); } catch (_) { return true; }
    if (!st.isFile() && !st.isDirectory()) return false;
    if (!entry || entry.held || entry.dev !== st.dev || entry.ino !== st.ino || shared(st)) return true;
    const forms = rootForms();
    const now = forms && readings(entry.real, true);
    if (!now) return true;
    return now.some(({ real, stat }) => !stat || stat.dev !== st.dev || stat.ino !== st.ino || insideAny(forms, real));
  }
  const handleOf = (value) => (value && typeof value === 'object' && handles.has(value) ? value : null);
  /** Does this call reach a file of the folders (asked only after the session of its context ended)? */
  function concerns(name, args) {
    if (name === 'open') return writeFlags(args[1]) && reaches(args[0], 'follow');
    if (name === 'readFile') return typeof args[1] === 'object' && args[1] !== null && writeFlags(args[1].flag) && asPath(args[0]) !== null && reaches(args[0], 'follow');
    if (FD_WRITES.includes(name)) return heldFd(args[0], descriptors.get(args[0]));
    const indices = PATH_WRITES[name];
    if (!indices) return false;
    if (name === 'writeFile' || name === 'appendFile') {
      if (typeof args[0] === 'number') return heldFd(args[0], descriptors.get(args[0]));
      const handle = handleOf(args[0]);
      if (handle) return heldFd(handle.fd, handles.get(handle));
      if (args[0] && typeof args[0] === 'object' && asPath(args[0]) === null) return true;
    }
    if (name === 'unlink' && TEMP.test(String(asPath(args[0]) ?? ''))) return false;
    return indices.some((i) => reaches(args[i], MODE[name] || 'follow', NAME_ONLY.has(name) || (name === 'link' && i === 1)));
  }
  const track = (target, fd) => { if (typeof fd === 'number') descriptors.set(fd, opened(target, fd)); };

  // Outside a gated context every call passes unchanged (no path check);
  // every descriptor and handle is remembered with what its open found.
  // Inside one, the path is examined only after the session ended.
  function gateSync(name) {
    const base = name.slice(0, -4);
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function (...args) {
      if (base === 'close') descriptors.delete(args[0]);
      if (!publishGate.getStore()) {
        const result = original.apply(this, args);
        if (base === 'open') track(args[0], result);
        return result;
      }
      const error = refusal();
      if (error && concerns(base, args)) throw error;
      const result = admitted.run(true, () => original.apply(this, args));
      if (base === 'open') track(args[0], result);
      return result;
    };
  }

  function gateCallback(name) {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function (...args) {
      const callback = args[args.length - 1];
      if (name === 'close') descriptors.delete(args[0]);
      if (typeof callback !== 'function') return original.apply(this, args);
      const target = args[0];
      const done = (error, fd) => { if (!error && name === 'open') track(target, fd); };
      if (!publishGate.getStore()) {
        if (name !== 'open') return original.apply(this, args);
        args[args.length - 1] = function (...result) { done(result[0], result[1]); return callback.apply(this, result); };
        return original.apply(this, args);
      }
      const error = refusal();
      if (error && concerns(name, args)) { process.nextTick(callback, error); return undefined; }
      args[args.length - 1] = function (...result) {
        done(result[0], result[1]);
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
        if (!publishGate.getStore()) return original.apply(this, args);
        const error = refusal();
        if (error && heldFd(this.fd, handles.get(this))) return Promise.reject(error);
        return admitted.run(true, () => original.apply(this, args));
      };
    }
    const close = proto.close;
    if (typeof close === 'function') {
      // The number is free for reuse only once the close completed.
      proto.close = function (...args) { if (handles.has(this)) descriptors.delete(this.fd); return close.apply(this, args); };
    }
  }
  const tracked = (pending, target) => pending.then((handle) => {
    if (!handlesGated) { handlesGated = true; gateHandles(Object.getPrototypeOf(handle)); }
    const entry = opened(target, handle.fd);
    handles.set(handle, entry);
    descriptors.set(handle.fd, entry);
    return handle;
  });

  function gatePromise(name) {
    const original = fs.promises[name];
    if (typeof original !== 'function') return;
    fs.promises[name] = function (...args) {
      const opens = name === 'open';
      if (!publishGate.getStore()) return opens ? tracked(original.apply(this, args), args[0]) : original.apply(this, args);
      const error = refusal();
      if (error && concerns(name, args)) return Promise.reject(error);
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
