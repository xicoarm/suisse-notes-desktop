// Global sinks of the sweep (review round 10, F4): the effects of main's
// background work are counted where they leave the process, at the module
// boundaries, not through what the code under test is handed:
// - every write-class call of the `fs` module (sync, callback and promise
//   API) and of every FileHandle (write, writev, writeFile, appendFile,
//   truncate), with the target path;
// - every `child_process` call (spawn, execFile, exec, fork and the sync
//   ones). ffmpeg/ffprobe are replaced HERE by a stub process (or, for real
//   media, forwarded to the bundled test binaries) - the chain itself runs
//   unchanged;
// - suspension points: every asynchronous fs completion inside the bound
//   recordings root and every child-process exit (the sweep changes the
//   session at the N-th one).
// Installed once per worker, before any module of src-electron or
// fluent-ffmpeg is loaded (those capture `spawn` at load). Unbound, every
// wrapper is a plain pass-through.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { mutate } from './mutants.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const STUB_FFMPEG = path.join(os.tmpdir(), 'sweep-stub', 'ffmpeg');
export const STUB_FFPROBE = path.join(os.tmpdir(), 'sweep-stub', 'ffprobe');

function install() {
  const early = Object.keys(require.cache).filter((file) => /[\\/](src-electron|fluent-ffmpeg)[\\/]/.test(file));
  if (early.length) throw new Error(`globalSinks must load before ${early[0]}`);

  const state = { rec: null };
  // Calls Node makes INSIDE a counted call (rm walks the tree with rmdir and
  // unlink) belong to that call: handed to the system with it.
  const inside = new AsyncLocalStorage();
  const original = { fs: {}, promises: {}, handle: {}, cp: {} };
  const fdPaths = new Map();
  const handlePaths = new WeakMap();

  const asPath = (value) => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString();
    if (value instanceof URL) return value.pathname;
    return null;
  };
  const FOLDS = process.platform === 'darwin' || process.platform === 'win32';
  const foldCase = (p) => (FOLDS ? p.toLowerCase() : p);
  const under = (root, target) => {
    const rel = path.relative(foldCase(root), foldCase(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const inRoot = (value) => {
    const rec = state.rec;
    const p = asPath(value);
    if (!rec || !p) return false;
    return under(rec.root, path.resolve(p));
  };
  // Round 11 (F7): the oracle's own reading of open flags - not the gate's
  // function, so a blind spot of one cannot hide in the other. Flag strings
  // by Node's table (only r, rs, sr read), numbers by their access mode and
  // the bits that change a file at the open; anything else counts.
  const READING = new Set(['r', 'rs', 'sr']);
  const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
  const changesFile = (flags) => {
    if (flags === undefined || flags === null || typeof flags === 'function') return false;
    if (typeof flags === 'string') return !READING.has(flags);
    if (typeof flags !== 'number') return true;
    if ((flags & (O_WRONLY | O_RDWR)) !== O_RDONLY) return true;
    return [O_CREAT, O_TRUNC, O_APPEND].some((bit) => (flags & bit) === bit);
  };

  // Round 12 (F8): where a call really lands, read the way the system reads
  // the path - its own realpath of the RAW path (POSIX follows a link before
  // a later «..» goes up from its target; Windows, and Node there, collapse
  // «..» first) - and for a name that does not exist (yet): the real folder
  // plus the name, a dangling link by its target. `own`: a call on the name
  // itself (unlink of a link). Null: not decidable (a loop, no access, «..»
  // after a missing name) - counted as the folder.
  const WINDOWS = process.platform === 'win32';
  const absoluteOf = (p) => (WINDOWS ? path.resolve(p) : (p.startsWith('/') ? p : `${process.cwd()}/${p}`));
  function lastName(p) {
    const trimmed = p.length > 1 ? p.replace(WINDOWS ? /[\\/]+$/ : /\/+$/, '') : p;
    const at = WINDOWS ? Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) : trimmed.lastIndexOf('/');
    if (at < 0 || at === trimmed.length - 1) return null;
    const dir = trimmed.slice(0, at);
    return { dir: dir === '' ? '/' : (WINDOWS && /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir), name: trimmed.slice(at + 1) };
  }
  function realTarget(p, own, hops = 0) {
    if (p === null || p === undefined || hops > 40) return null;
    const abs = absoluteOf(p);
    if (own && !/[\\/]\.?$/.test(p)) {
      const last = lastName(abs);
      if (last && last.name !== '.' && last.name !== '..') {
        const dir = realTarget(last.dir, false, hops);
        return dir && path.join(dir, last.name);
      }
    }
    try { return original.fs.realpathSync.native(abs); } catch (error) { if (error.code !== 'ENOENT') return null; }
    const last = lastName(abs);
    if (!last || last.name === '..') return null;
    if (last.name === '.') return realTarget(last.dir, false, hops);
    const dir = realTarget(last.dir, false, hops);
    if (!dir) return null;
    const at = path.join(dir, last.name);
    let st;
    try { st = original.fs.lstatSync(at, { throwIfNoEntry: false }); } catch { return null; }
    if (!st) return at;
    if (!st.isSymbolicLink()) return null;
    let link;
    try { link = String(original.fs.readlinkSync(at)); } catch { return null; }
    return realTarget(path.isAbsolute(link) ? link : `${dir}${path.sep}${link}`, false, hops + 1);
  }
  /** A real path as a path under the bound root (the folder itself when not decidable), or null. */
  function ourTarget(real) {
    const rec = state.rec;
    if (!rec) return null;
    if (real === null) return rec.root;
    for (const root of [rec.root, realTarget(rec.root, false)]) {
      if (root && under(root, real)) return path.join(rec.root, real.slice(root.length).replace(/^[\\/]+/, ''));
    }
    return null;
  }
  /** The file with this identity in the bound root (a hard link, a descriptor whose name is gone), or null. */
  function sameFileInRoot(st) {
    const rec = state.rec;
    if (!rec || !st) return null;
    const same = (s) => s.dev === st.dev && s.ino === st.ino;
    const walk = (dir) => {
      for (const d of original.fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (same(original.fs.lstatSync(p))) return p;
        if (d.isDirectory()) { const found = walk(p); if (found) return found; }
      }
      return null;
    };
    try { return same(original.fs.lstatSync(rec.root)) ? rec.root : walk(rec.root); } catch { return null; }
  }
  // Descriptors and handles: what their open found (round 12, F9): the raw
  // path and its real path then, whatever happens to the alias later.
  const UNDECIDED = Symbol('undecided');
  const opened = (target) => {
    const raw = asPath(target);
    return { raw, real: raw === null ? UNDECIDED : realTarget(raw, false) ?? UNDECIDED };
  };
  const remember = (fd, target) => { if (typeof fd === 'number') fdPaths.set(fd, opened(target)); };
  const fdRaw = (fd) => fdPaths.get(fd)?.raw;
  /** A descriptor's file under the root: by its open, else by its identity now. */
  function fdTarget(fd, entry) {
    if (entry) {
      const mapped = ourTarget(entry.real === UNDECIDED ? null : entry.real);
      if (mapped) return mapped;
    }
    let st;
    try { st = original.fs.fstatSync(fd); } catch { return null; }
    return sameFileInRoot(st);
  }

  const effect = (kind, target) => { if (state.rec) state.rec.effect(kind, String(asPath(target) ?? target)); };

  // name -> [effect kind, index of the target path] (callback and promise API alike)
  const PATH_WRITES = {
    writeFile: ['write', 0], appendFile: ['write', 0], mkdir: ['mkdir', 0], mkdtemp: ['mkdir', 0],
    rename: ['rename', 1], unlink: ['unlink', 0], rm: ['rm', 0], rmdir: ['rm', 0], copyFile: ['copy', 1],
    cp: ['copy', 1], truncate: ['truncate', 0], symlink: ['link', 1], link: ['link', 1], utimes: ['attr', 0],
    lutimes: ['attr', 0], chmod: ['attr', 0], lchmod: ['attr', 0], chown: ['attr', 0], lchown: ['attr', 0],
  };
  const FD_WRITES = { write: 'write', writev: 'write', ftruncate: 'truncate', fchmod: 'attr', futimes: 'attr', fchown: 'attr' };
  const HANDLE_WRITES = { write: 'write', writev: 'write', writeFile: 'write', appendFile: 'write', truncate: 'truncate', chmod: 'attr', chown: 'attr', utimes: 'attr' };
  const HANDLE_WAITS = ['sync', 'datasync', 'close', 'read', 'readv', 'readFile', 'stat'];
  // Calls on the name itself; the content of the file stays (no identity check).
  const ON_NAME = new Set(['unlink', 'rm', 'rmdir', 'rename', 'symlink', 'mkdir', 'mkdtemp', 'lutimes', 'lchmod', 'lchown']);
  const NAME_ONLY = new Set(['unlink', 'rm', 'rmdir', 'rename', 'symlink', 'mkdir', 'mkdtemp']);
  const isHandle = (value) => value !== null && typeof value === 'object' && handlePaths.has(value);

  /** Is the call about the bound root? Effect kind (or null) and target. */
  function classify(name, args) {
    const c = classifyByName(name, args);
    if (c.ours || !c.kind) return c;
    // Not under the root by its name: where it really lands (an alias, a
    // descriptor whose alias is gone, a hard link)?
    const real = landsIn(name, args);
    return real ? { ...c, target: real, ours: true } : c;
  }
  function landsIn(name, args) {
    if (name in FD_WRITES) return fdTarget(args[0], fdPaths.get(args[0]));
    if ((name === 'writeFile' || name === 'appendFile') && typeof args[0] === 'number') return fdTarget(args[0], fdPaths.get(args[0]));
    if ((name === 'writeFile' || name === 'appendFile') && isHandle(args[0])) return fdTarget(args[0].fd, handlePaths.get(args[0]));
    const index = name === 'open' || name === 'readFile' ? 0 : PATH_WRITES[name]?.[1];
    if (index === undefined) return null;
    // rename and link: the source too (moved away, or a second name made for it).
    // link: Linux links the name, macOS may follow it - both readings.
    const paths = name === 'rename' ? [[args[0], true], [args[1], true]]
      : name === 'link' ? [[args[0], true], [args[0], false], [args[1], true]]
        : [[args[index], ON_NAME.has(name)]];
    for (const [value, own] of paths) {
      const p = asPath(value);
      if (p === null) continue;
      const mapped = ourTarget(realTarget(p, own));
      if (mapped) return mapped;
      // The same file under another name (a hard link): its identity.
      if (!NAME_ONLY.has(name) && !(name === 'link' && value === args[1])) {
        let st;
        try { st = (own ? original.fs.lstatSync : original.fs.statSync)(p, { throwIfNoEntry: false }); } catch { st = null; }
        const same = st && !st.isDirectory() ? sameFileInRoot(st) : null;
        if (same) return same;
      }
    }
    return null;
  }
  function classifyByName(name, args) {
    if (name in PATH_WRITES) {
      const [kind, index] = PATH_WRITES[name];
      const target = args[index];
      // writeFile/appendFile also take an fd or a FileHandle.
      if (typeof target === 'number') return { kind, target: fdRaw(target), ours: fdPaths.has(target) && inRoot(fdRaw(target)) };
      if (isHandle(target)) return { kind, target: handlePaths.get(target).raw, ours: inRoot(handlePaths.get(target).raw) };
      return { kind, target, ours: inRoot(target) || (index === 1 && inRoot(args[0])) };
    }
    if (name in FD_WRITES) return { kind: FD_WRITES[name], target: fdRaw(args[0]), ours: fdPaths.has(args[0]) && inRoot(fdRaw(args[0])) };
    if (name === 'open') return { kind: changesFile(args[1]) ? 'open' : null, target: args[0], ours: inRoot(args[0]) };
    // readFile with a writing flag opens for writing (w+ empties the file).
    if (name === 'readFile' && typeof args[1] === 'object' && args[1] !== null && changesFile(args[1].flag) && asPath(args[0])) return { kind: 'open', target: args[0], ours: inRoot(args[0]) };
    if (['close', 'fsync', 'fdatasync', 'fstat', 'read', 'readv'].includes(name)) return { kind: null, target: fdRaw(args[0]), ours: fdPaths.has(args[0]) && inRoot(fdRaw(args[0])) };
    return { kind: null, target: args[0], ours: inRoot(args[0]) };
  }

  function wrapSync(name) {
    const base = name.slice(0, -4);
    const orig = fs[name];
    original.fs[name] = orig;
    fs[name] = function (...args) {
      // Descriptors are remembered unbound too: one opened before a run and
      // written during it is a file of the root (round 11), by what its
      // open found (round 12).
      if (!state.rec || inside.getStore()) {
        const result = orig.apply(this, args);
        if (base === 'open' && !inside.getStore()) remember(result, args[0]);
        if (base === 'close') fdPaths.delete(args[0]);
        return result;
      }
      const c = classify(base, args);
      if (c.ours && c.kind) effect(c.kind, c.target);
      if (c.ours && base === 'rename' && state.rec.busy()) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      const result = inside.run(name, () => orig.apply(this, args));
      if (base === 'open') remember(result, args[0]);
      if (base === 'close') fdPaths.delete(args[0]);
      return result;
    };
    // realpathSync.native and the like stay reachable.
    for (const key of Object.keys(orig)) fs[name][key] = orig[key];
  }

  function wrapCallback(name) {
    const orig = fs[name];
    original.fs[name] = orig;
    fs[name] = function (...args) {
      const rec = state.rec;
      const cb = args[args.length - 1];
      if (typeof cb !== 'function' || inside.getStore()) return orig.apply(this, args);
      const target = args[0];
      const book = (res) => {
        if (name === 'open' && !res[0]) remember(res[1], target);
        if (name === 'close') fdPaths.delete(target);
      };
      const c = rec ? classify(name, args) : null;
      if (!c || !c.ours) {
        if (name !== 'open' && name !== 'close') return orig.apply(this, args);
        args[args.length - 1] = function (...res) { book(res); return cb.apply(this, res); };
        return orig.apply(this, args);
      }
      if (c.kind) effect(c.kind, c.target);
      args[args.length - 1] = function (...res) {
        book(res);
        inside.exit(() => rec.waitThen(`fs.${name}`, () => cb.apply(this, res), asPath(c.target)));
      };
      return inside.run(name, () => orig.apply(this, args));
    };
    for (const key of Object.keys(orig)) fs[name][key] = orig[key];
  }

  function wrapHandleProto(proto) {
    for (const name of [...Object.keys(HANDLE_WRITES), ...HANDLE_WAITS]) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;
      original.handle[name] = orig;
      proto[name] = function (...args) {
        if (name === 'close') fdPaths.delete(this.fd);
        const rec = state.rec;
        const entry = handlePaths.get(this);
        if (!rec || inside.getStore()) return orig.apply(this, args);
        let target = entry && inRoot(entry.raw) ? entry.raw : null;
        // A write: where it really lands (round 12, F9/F10).
        if (!target && HANDLE_WRITES[name]) target = fdTarget(this.fd, entry);
        if (!target) return orig.apply(this, args);
        if (HANDLE_WRITES[name]) effect(HANDLE_WRITES[name], target);
        return rec.after(`handle.${name}`, inside.run(name, () => orig.apply(this, args)), target);
      };
    }
  }

  let handleProtoWrapped = false;
  const rememberHandle = (handle, target) => {
    if (!handleProtoWrapped) { handleProtoWrapped = true; wrapHandleProto(Object.getPrototypeOf(handle)); }
    const entry = opened(target);
    handlePaths.set(handle, entry);
    fdPaths.set(handle.fd, entry);
    return handle;
  };
  function wrapPromise(name) {
    const orig = fs.promises[name];
    original.promises[name] = orig;
    fs.promises[name] = function (...args) {
      const rec = state.rec;
      if (inside.getStore()) return orig.apply(this, args);
      const c = rec ? classify(name, args) : null;
      if (!c || !c.ours) return name === 'open' ? orig.apply(this, args).then((handle) => rememberHandle(handle, args[0])) : orig.apply(this, args);
      if (c.kind) effect(c.kind, c.target);
      if (name === 'rename' && rec.busy()) return rec.after('fs.rename', Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })), asPath(c.target));
      let pending = inside.run(name, () => orig.apply(this, args));
      if (name === 'open') pending = pending.then((handle) => rememberHandle(handle, args[0]));
      return rec.after(`fs.${name}`, pending, asPath(c.target));
    };
  }

  const SYNC = Object.keys(fs).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function' && k !== 'existsSync');
  for (const name of SYNC) wrapSync(name);
  const CALLBACK = ['open', 'close', 'read', 'readv', 'write', 'writev', 'fsync', 'fdatasync', 'fstat', 'ftruncate', 'fchmod', 'futimes', 'fchown',
    ...Object.keys(PATH_WRITES), 'stat', 'lstat', 'readdir', 'readFile', 'access', 'realpath', 'opendir'];
  for (const name of CALLBACK) if (typeof fs[name] === 'function') wrapCallback(name);
  for (const name of Object.keys(fs.promises)) if (typeof fs.promises[name] === 'function') wrapPromise(name);
  // Source streams of the bound root (legacy upload tests; closed before the root is removed).
  const createReadStream = fs.createReadStream;
  original.fs.createReadStream = createReadStream;
  fs.createReadStream = function (file, ...rest) {
    const stream = createReadStream.call(this, file, ...rest);
    if (state.rec && inRoot(file)) state.rec.stream(String(asPath(file)), stream);
    return stream;
  };

  // --- child processes ---
  function fakeChild(rec, label, run, args) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 424242;
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    const outcome = run();
    rec.waitThen(label, () => {
      if (outcome.stdout) child.stdout.write(outcome.stdout);
      if (outcome.stderr) child.stderr.write(outcome.stderr);
      child.stdout.end();
      child.stderr.end();
      const code = outcome.code ?? 0;
      child.exitCode = code;
      // As a real process: exit, then close once stdio has ended.
      setImmediate(() => { child.emit('exit', code, null); setImmediate(() => child.emit('close', code, null)); });
    }, args.join(' '));
    return child;
  }

  const stubbed = (file) => file === STUB_FFMPEG || file === STUB_FFPROBE;
  const realBinary = (file) => (file === STUB_FFMPEG ? require('@ffmpeg-installer/ffmpeg').path : require('@ffprobe-installer/ffprobe').path);

  function spawnLike(name) {
    const orig = childProcess[name];
    original.cp[name] = orig;
    childProcess[name] = function (file, ...rest) {
      const rec = state.rec;
      if (!rec) return orig.call(this, file, ...rest);
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      rec.spawn({ call: name, file: path.basename(String(file)), args });
      if (!stubbed(file)) return orig.call(this, file, ...rest);
      if (rec.media === 'real') {
        // Real media: the bundled binary; the exit is a suspension point.
        const child = orig.call(this, realBinary(file), ...rest);
        const emit = child.emit.bind(child);
        let held = null;
        child.emit = (event, ...payload) => {
          if (event !== 'exit' && event !== 'close') return emit(event, ...payload);
          if (!held) held = new Promise((done) => rec.waitThen(`spawn:${path.basename(file)}`, done, args.join(' ')));
          held.then(() => emit(event, ...payload));
          return true;
        };
        return child;
      }
      const callback = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
      const child = fakeChild(rec, `spawn:${path.basename(file)}`, () => rec.emulate(file, args), args);
      if (callback) {
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.once('close', (code) => callback(code ? Object.assign(new Error(`stub exited ${code}: ${err}`), { code }) : null, out, err));
      }
      return child;
    };
  }
  for (const name of ['spawn', 'execFile', 'exec', 'fork']) spawnLike(name);
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const orig = childProcess[name];
    original.cp[name] = orig;
    childProcess[name] = function (file, ...rest) {
      if (state.rec) state.rec.spawn({ call: name, file: path.basename(String(file)), args: Array.isArray(rest[0]) ? rest[0] : [] });
      return orig.call(this, file, ...rest);
    };
  }

  // The functions as a module sees them that captured them before main
  // installed its gate (counted here, not gated): the bypass mutants
  // (support/mutants.js) use them.
  globalThis.__sweepPreGate = {
    fs: { writeFileSync: fs.writeFileSync, mkdirSync: fs.mkdirSync, unlinkSync: fs.unlinkSync, renameSync: fs.renameSync, openSync: fs.openSync, closeSync: fs.closeSync, utimesSync: fs.utimesSync },
    cp: { execFile: childProcess.execFile, spawn: childProcess.spawn },
  };

  // A mutant (SWEEP_MUTANT): its edits of src-electron applied at load.
  if (process.env.SWEEP_MUTANT) {
    const Module = require('module');
    const load = Module._extensions['.js'];
    Module._extensions['.js'] = function (module, filename) {
      const rel = path.relative(ROOT, filename).split(path.sep).join('/');
      if (rel.startsWith('src-electron/')) {
        const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
        const mutated = mutate(rel, source);
        if (mutated !== source) return module._compile(mutated, filename);
      }
      return load(module, filename);
    };
  }

  return {
    state,
    original,
    /** Binds the recorder of one rig (the only one at a time). */
    bind(rec) { state.rec = rec; },
    unbind(rec) { if (state.rec === rec) state.rec = null; },
  };
}

export const sinks = globalThis.__sweepSinks || (globalThis.__sweepSinks = install());

/** The stub media: ffmpeg writes a small WebM to its output, ffprobe reports 45 s. */
export function emulateMedia(file, args, { fail = null } = {}) {
  if (file === STUB_FFMPEG) {
    if (args.includes('-formats')) {
      return { stdout: 'File formats:\n --\n DE matroska,webm   Matroska / WebM\n DE s16le           PCM signed 16-bit little-endian\n DE f32le           PCM 32-bit floating-point little-endian\n DE flac            raw FLAC\n DE ogg             Ogg\n DE opus            Ogg Opus\n  E null            raw null video\n DE concat          Virtual concatenation script\n DE wav             WAV / WAVE\n D  lavfi           Libavfilter virtual input device\n' };
    }
    if (args.includes('-encoders')) {
      return { stdout: 'Encoders:\n ------\n A..... libopus              libopus Opus\n A..... pcm_s16le            PCM signed 16-bit little-endian\n A..... pcm_f32le            PCM 32-bit floating point little-endian\n A..... flac                 FLAC\n A..... pcm_s24le            PCM signed 24-bit little-endian\n' };
    }
    if (args.includes('-filters') || args.includes('-codecs')) return { stdout: '' };
    if (fail && fail(args)) return { code: 1, stderr: 'stub ffmpeg: failed\n' };
    const output = args[args.length - 1];
    const bytes = Buffer.alloc(4096, 7);
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(bytes);
    sinks.original.fs.writeFileSync.call(fs, output, bytes);
    return { stderr: 'size=4kB time=00:00:45.00 bitrate=0.7kbits/s\n' };
  }
  // ffprobe: JSON (execFile, -of json) or fluent's key=value sections.
  if (args.includes('json')) return { stdout: JSON.stringify({ format: { duration: '45.000000', start_time: '0.000000' }, streams: [{ codec_type: 'audio', codec_name: 'opus' }] }) };
  return { stdout: '[STREAM]\nindex=0\ncodec_type=audio\ncodec_name=opus\n[/STREAM]\n[FORMAT]\nduration=45.000000\nstart_time=0.000000\n[/FORMAT]\n' };
}
