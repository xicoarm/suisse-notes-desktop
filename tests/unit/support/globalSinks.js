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

const require = createRequire(import.meta.url);

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
  const inRoot = (value) => {
    const rec = state.rec;
    const p = asPath(value);
    if (!rec || !p) return false;
    const rel = path.relative(rec.root, path.resolve(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const writeFlags = (flags) => /[wa+]/.test(String(flags ?? 'r'));
  const effect = (kind, target) => { if (state.rec) state.rec.effect(kind, String(asPath(target) ?? target)); };

  // name -> [effect kind, index of the target path] (callback and promise API alike)
  const PATH_WRITES = {
    writeFile: ['write', 0], appendFile: ['write', 0], mkdir: ['mkdir', 0], mkdtemp: ['mkdir', 0],
    rename: ['rename', 1], unlink: ['unlink', 0], rm: ['rm', 0], rmdir: ['rm', 0], copyFile: ['copy', 1],
    cp: ['copy', 1], truncate: ['truncate', 0], symlink: ['link', 1], link: ['link', 1], utimes: ['attr', 0],
    lutimes: ['attr', 0], chmod: ['attr', 0], chown: ['attr', 0], lchown: ['attr', 0],
  };
  const FD_WRITES = { write: 'write', writev: 'write', ftruncate: 'truncate', fchmod: 'attr', futimes: 'attr', fchown: 'attr' };
  const HANDLE_WRITES = { write: 'write', writev: 'write', writeFile: 'write', appendFile: 'write', truncate: 'truncate', chmod: 'attr', chown: 'attr', utimes: 'attr' };
  const HANDLE_WAITS = ['sync', 'datasync', 'close', 'read', 'readv', 'readFile', 'stat'];

  /** Is the call about the bound root? Effect kind (or null) and target. */
  function classify(name, args) {
    if (name in PATH_WRITES) {
      const [kind, index] = PATH_WRITES[name];
      const target = args[index];
      // writeFile/appendFile also take an fd.
      if (typeof target === 'number') return { kind, target: fdPaths.get(target), ours: fdPaths.has(target) && inRoot(fdPaths.get(target)) };
      return { kind, target, ours: inRoot(target) || (index === 1 && inRoot(args[0])) };
    }
    if (name in FD_WRITES) return { kind: FD_WRITES[name], target: fdPaths.get(args[0]), ours: fdPaths.has(args[0]) && inRoot(fdPaths.get(args[0])) };
    if (name === 'open') return { kind: writeFlags(args[1]) ? 'open' : null, target: args[0], ours: inRoot(args[0]) };
    if (['close', 'fsync', 'fdatasync', 'fstat', 'read', 'readv'].includes(name)) return { kind: null, target: fdPaths.get(args[0]), ours: fdPaths.has(args[0]) && inRoot(fdPaths.get(args[0])) };
    return { kind: null, target: args[0], ours: inRoot(args[0]) };
  }

  function wrapSync(name) {
    const base = name.slice(0, -4);
    const orig = fs[name];
    original.fs[name] = orig;
    fs[name] = function (...args) {
      if (!state.rec || inside.getStore()) return orig.apply(this, args);
      const c = classify(base, args);
      if (c.ours && c.kind) effect(c.kind, c.target);
      if (c.ours && base === 'rename' && state.rec.busy()) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      const result = inside.run(name, () => orig.apply(this, args));
      if (base === 'open') fdPaths.set(result, asPath(args[0]));
      if (base === 'close') fdPaths.delete(args[0]);
      return result;
    };
  }

  function wrapCallback(name) {
    const orig = fs[name];
    original.fs[name] = orig;
    fs[name] = function (...args) {
      const rec = state.rec;
      const cb = args[args.length - 1];
      if (!rec || typeof cb !== 'function' || inside.getStore()) return orig.apply(this, args);
      const c = classify(name, args);
      if (!c.ours) return orig.apply(this, args);
      if (c.kind) effect(c.kind, c.target);
      const pathArg = asPath(args[0]);
      const fd = args[0];
      args[args.length - 1] = function (...res) {
        if (name === 'open' && !res[0]) fdPaths.set(res[1], pathArg);
        if (name === 'close') fdPaths.delete(fd);
        inside.exit(() => rec.waitThen(`fs.${name}`, () => cb.apply(this, res), asPath(c.target)));
      };
      return inside.run(name, () => orig.apply(this, args));
    };
  }

  function wrapHandleProto(proto) {
    for (const name of [...Object.keys(HANDLE_WRITES), ...HANDLE_WAITS]) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;
      original.handle[name] = orig;
      proto[name] = function (...args) {
        const rec = state.rec;
        const target = handlePaths.get(this);
        if (!rec || !target || !inRoot(target) || inside.getStore()) return orig.apply(this, args);
        if (HANDLE_WRITES[name]) effect(HANDLE_WRITES[name], target);
        return rec.after(`handle.${name}`, inside.run(name, () => orig.apply(this, args)), target);
      };
    }
  }

  let handleProtoWrapped = false;
  function wrapPromise(name) {
    const orig = fs.promises[name];
    original.promises[name] = orig;
    fs.promises[name] = function (...args) {
      const rec = state.rec;
      if (!rec || inside.getStore()) return orig.apply(this, args);
      const c = classify(name, args);
      if (!c.ours) return orig.apply(this, args);
      if (c.kind) effect(c.kind, c.target);
      if (name === 'rename' && rec.busy()) return rec.after('fs.rename', Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })), asPath(c.target));
      let pending = inside.run(name, () => orig.apply(this, args));
      if (name === 'open') {
        pending = pending.then((handle) => {
          if (!handleProtoWrapped) { handleProtoWrapped = true; wrapHandleProto(Object.getPrototypeOf(handle)); }
          handlePaths.set(handle, asPath(args[0]));
          return handle;
        });
      }
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
