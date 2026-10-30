// @vitest-environment node
import { sinks } from './support/globalSinks.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Class probe of the file sink (review round 12): not single cases but the
// cross product
//   path form   {direct, relative, symlink to a file, symlink to a folder,
//                symlink plus «..», a chain of links, a dangling link, a hard
//                link, another letter case (macOS, Windows), a junction
//                (Windows)}
// x effect     {open sync/callback/promise with a writing flag, write,
//                writev, truncate, chmod, utimes, chown, rename, unlink,
//                link, copyFile, cp, mkdir, rm (sync/callback/promise),
//                write stream; on a descriptor or handle: write, writev,
//                ftruncate, fchmod, futimes, fchown, writeFile, appendFile,
//                write stream}
// x origin     {a path call in the ended context; a descriptor or handle
//                opened in the ended context; opened in the foreground and
//                the alias then removed or renamed}.
// Every cell expects: the sink refuses (SESSION_ENDED) and the content, mode
// and mtime of every file of the recordings folder stay as they were; and
// the same call let through (a session still alive: the sink switched off
// for it) is counted by the oracle (support/globalSinks.js, which resolves
// on its own) as an effect in the folder. A call on a link itself (unlink,
// rename, rm of a symlink or a hard link outside) is no effect on the folder
// and passes; control cells outside the folder (logs, settings, updates)
// pass. The open flags of a cell come from a generator with a fixed seed.

const require = createRequire(import.meta.url);
const { publishGate, installEffectGate } = require('../../src-electron/effect-gate.js');
const { O_RDWR, O_WRONLY, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;

const SEED = 0x5e12;
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const next = random(SEED);
const pick = (list) => list[Math.floor(next() * list.length)];
// Writing flags valid on every system (Windows refuses O_TRUNC without O_CREAT).
const WRITING = ['r+', 'a', 'a+', 'w', 'w+', 'rs+', O_RDWR, O_WRONLY | O_APPEND, O_RDWR | O_APPEND, O_WRONLY | O_CREAT | O_TRUNC];

const WIN = process.platform === 'win32';
const FOLDS = process.platform === 'darwin' || WIN;
const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-02-02T00:00:00Z');
const uid = process.getuid ? process.getuid() : 0;
const gid = process.getgid ? process.getgid() : 0;

let base;
let work;
let root;
let outside;
let counter = 0;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-class-'));
  root = path.join(base, 'Recordings');
  installEffectGate({ roots: () => [root] });
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

// --- the fixture of one cell ---
function writable(dir) {
  if (!fs.existsSync(dir)) return;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    try { fs.chmodSync(p, d.isDirectory() ? 0o755 : 0o644); } catch { /* a link */ }
    if (d.isDirectory()) writable(p);
  }
}
function fresh() {
  if (work) { writable(work); fs.rmSync(work, { recursive: true, force: true }); }
  // Same folder names in every cell; the work folder is new (Windows keeps a
  // removed name busy for a moment).
  work = path.join(base, `w${counter++}`);
  root = path.join(work, 'Recordings');
  outside = path.join(work, 'O');
  installEffectGate({ roots: () => [root] });
  fs.mkdirSync(path.join(root, 'c1', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'c1', 'metadata.json'), '{"userId":"a"}');
  fs.writeFileSync(path.join(root, 'c1', 'audio.webm'), Buffer.alloc(64, 7));
  fs.writeFileSync(path.join(outside, 'logs', 'app.log'), 'log\n');
  fs.writeFileSync(path.join(outside, 'source.txt'), 'source');
  for (const p of [path.join(root, 'c1', 'metadata.json'), path.join(root, 'c1', 'audio.webm'), path.join(root, 'c1', 'sub'), path.join(root, 'c1'), root]) fs.utimesSync(p, T0, T0);
}
/** Every entry of the recordings folder: bytes, mode, mtime. */
function state() {
  const out = {};
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      const st = fs.lstatSync(p);
      out[path.relative(root, p)] = `${st.mode.toString(8)} ${st.mtimeMs} ${d.isFile() ? fs.readFileSync(p).toString('base64') : d.isDirectory() ? 'dir' : 'other'}`;
      if (d.isDirectory()) walk(p);
    }
  };
  out['.'] = `${fs.statSync(root).mode.toString(8)} ${fs.statSync(root).mtimeMs}`;
  walk(root);
  return out;
}

class SessionEnded extends Error {
  constructor() { super('session ended'); this.code = 'SESSION_ENDED'; }
}
const ENDED = { assertAlive: () => { throw new SessionEnded(); } };
const ALIVE = { assertAlive: () => {} };
const inContext = (gate, fn) => publishGate.run(gate, fn);
// A call that never settles is a finding of its own (a refused stream that hangs).
async function outcome(call) {
  let timer;
  const hung = new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), 3000); });
  try {
    return await Promise.race([Promise.resolve().then(call).then(() => 'ok'), hung]);
  } catch (error) {
    return error?.code === 'SESSION_ENDED' ? 'refused' : String(error?.code || error?.message || error);
  } finally {
    clearTimeout(timer);
  }
}
const cb = (fn) => new Promise((resolve, reject) => fn((error, value) => (error ? reject(error) : resolve(value))));
const streamDone = (stream, data) => new Promise((resolve, reject) => {
  stream.on('error', reject);
  stream.end(data, (error) => (error ? reject(error) : resolve()));
});

// --- the oracle ---
const rec = {
  media: 'stub', effects: [],
  effect(kind, target) { this.effects.push({ kind, target }); },
  after: (l, p) => p, waitThen: (l, fn) => setImmediate(fn), busy: () => false, spawn() {}, stream() {}, emulate: () => ({}),
};
/** The effects on the folder the oracle counted while fn ran (it records only those). */
async function counted(fn) {
  rec.root = root;
  rec.effects = [];
  sinks.bind(rec);
  try { await fn(); } finally { sinks.unbind(rec); }
  return rec.effects.map((e) => e.kind);
}

// --- path forms: (target inside c1, its kind) -> { path, alias, unalias, rename } or null (not defined) ---
function link(target, at, type) {
  try { fs.symlinkSync(target, at, type); return true; } catch { return false; }
}
const raw = (...parts) => parts.join(path.sep);
const FORMS = {
  direct: (name) => ({ path: path.join(root, 'c1', name) }),
  relative: (name) => ({ path: path.relative(process.cwd(), path.join(root, 'c1', name)) }),
  'symlink to a file': (name, kind) => {
    if (kind !== 'file') return null;
    const at = path.join(outside, 'flink');
    return link(path.join(root, 'c1', name), at, 'file') ? { path: at, alias: at } : undefined;
  },
  'symlink to a folder': (name) => {
    const at = path.join(outside, 'dlink');
    return link(path.join(root, 'c1'), at, 'dir') ? { path: path.join(at, name), alias: at } : undefined;
  },
  'symlink plus ..': (name) => {
    // POSIX follows the link first, then goes up from its target; Windows
    // (and Node there) collapses the «..» first and lands outside. The sink
    // refuses both readings; the oracle reads as the system does, so on
    // Windows it has nothing to count, and a descriptor opened there is no
    // file of the folder.
    const at = path.join(outside, 'slink');
    return link(path.join(root, 'c1', 'sub'), at, 'dir') ? { path: raw(at, '..', name), alias: at, lexicalHere: WIN } : undefined;
  },
  'chain of links': (name) => {
    const first = path.join(outside, 'l1');
    const second = path.join(outside, 'l2');
    return link(path.join(root, 'c1'), second, 'dir') && link('l2', first, 'dir') ? { path: path.join(first, name), alias: first } : undefined;
  },
  'dangling link': () => {
    const at = path.join(outside, 'hang');
    return link(path.join(root, 'c1', 'later.json'), at, 'file') ? { path: at, alias: at, dangling: true } : undefined;
  },
  'hard link': (name, kind) => {
    if (kind !== 'file') return null;
    const at = path.join(outside, 'hard');
    try { fs.linkSync(path.join(root, 'c1', name), at); } catch { return undefined; }
    return { path: at, alias: at };
  },
  ...(FOLDS ? { 'letter case': (name) => ({ path: path.join(path.dirname(root), path.basename(root).toUpperCase(), 'C1', name.toUpperCase()) }) } : {}),
  ...(WIN ? {
    junction: (name) => {
      const at = path.join(outside, 'junc');
      return link(path.join(root, 'c1'), at, 'junction') ? { path: path.join(at, name), alias: at } : undefined;
    },
  } : {}),
};
// Calls on the name itself: on a link (symlink, hard link) outside they act on the link.
const ON_LINK = new Set(['symlink to a file', 'dangling link', 'hard link']);

// --- effects on a path: [name, target kind ('file' metadata.json, 'new' a new name), acts on the name?, call] ---
const src = () => path.join(outside, 'source.txt');
const away = () => path.join(outside, `moved-${counter}`);
const both = (name, kind, onName, sync, callback, promise) => [
  [`${name} sync`, kind, onName, sync],
  [`${name} callback`, kind, onName, callback],
  [`${name} promise`, kind, onName, promise],
];
const PATH_EFFECTS = [
  ...both('open', 'file', false,
    (p, flags) => { const fd = fs.openSync(p, flags); try { fs.writeSync(fd, 'X', 0); } finally { fs.closeSync(fd); } },
    async (p, flags) => { const fd = await cb((done) => fs.open(p, flags, done)); try { fs.writeSync(fd, 'X', 0); } finally { fs.closeSync(fd); } },
    async (p, flags) => { const h = await fs.promises.open(p, flags); try { await h.write('X', 0); } finally { await h.close(); } }),
  ...both('writeFile', 'file', false, (p) => fs.writeFileSync(p, 'X'), (p) => cb((d) => fs.writeFile(p, 'X', d)), (p) => fs.promises.writeFile(p, 'X')),
  ...both('writeFile new', 'new', false, (p) => fs.writeFileSync(p, 'X'), (p) => cb((d) => fs.writeFile(p, 'X', d)), (p) => fs.promises.writeFile(p, 'X')),
  ...both('appendFile', 'file', false, (p) => fs.appendFileSync(p, 'X'), (p) => cb((d) => fs.appendFile(p, 'X', d)), (p) => fs.promises.appendFile(p, 'X')),
  ['writev', 'file', false, (p) => { const fd = fs.openSync(p, 'r+'); try { fs.writevSync(fd, [Buffer.from('X')], 0); } finally { fs.closeSync(fd); } }],
  ...both('truncate', 'file', false, (p) => fs.truncateSync(p, 0), (p) => cb((d) => fs.truncate(p, 0, d)), (p) => fs.promises.truncate(p, 0)),
  ...both('chmod', 'file', false, (p) => fs.chmodSync(p, 0o444), (p) => cb((d) => fs.chmod(p, 0o444, d)), (p) => fs.promises.chmod(p, 0o444)),
  ...both('utimes', 'file', false, (p) => fs.utimesSync(p, T1, T1), (p) => cb((d) => fs.utimes(p, T1, T1, d)), (p) => fs.promises.utimes(p, T1, T1)),
  ...both('chown', 'file', false, (p) => fs.chownSync(p, uid, gid), (p) => cb((d) => fs.chown(p, uid, gid, d)), (p) => fs.promises.chown(p, uid, gid)),
  ...both('rename', 'file', true, (p) => fs.renameSync(p, away()), (p) => cb((d) => fs.rename(p, away(), d)), (p) => fs.promises.rename(p, away())),
  ...both('unlink', 'file', true, (p) => fs.unlinkSync(p), (p) => cb((d) => fs.unlink(p, d)), (p) => fs.promises.unlink(p)),
  // link: Linux links the name, macOS may follow it - both readings count.
  ...both('link', 'file', false, (p) => fs.linkSync(p, away()), (p) => cb((d) => fs.link(p, away(), d)), (p) => fs.promises.link(p, away())),
  ...both('copyFile', 'file', false, (p) => fs.copyFileSync(src(), p), (p) => cb((d) => fs.copyFile(src(), p, d)), (p) => fs.promises.copyFile(src(), p)),
  ...both('cp', 'file', false, (p) => fs.cpSync(src(), p), (p) => cb((d) => fs.cp(src(), p, d)), (p) => fs.promises.cp(src(), p)),
  ...both('mkdir', 'new', true, (p) => fs.mkdirSync(p), (p) => cb((d) => fs.mkdir(p, d)), (p) => fs.promises.mkdir(p)),
  ...both('rm', 'file', true, (p) => fs.rmSync(p), (p) => cb((d) => fs.rm(p, d)), (p) => fs.promises.rm(p)),
  ['write stream', 'file', false, (p, flags) => streamDone(fs.createWriteStream(p, { flags: typeof flags === 'string' ? flags : 'r+' }), 'X')],
];
const NEW_NAME = { file: 'metadata.json', new: 'fresh.txt' };

// --- effects on a descriptor (fd) or a handle (h) ---
const FD_EFFECTS = [
  ['write', (fd) => fs.writeSync(fd, 'X', 0)],
  ['write callback', (fd) => cb((d) => fs.write(fd, 'X', 0, d))],
  ['writev', (fd) => fs.writevSync(fd, [Buffer.from('X')], 0)],
  ['ftruncate', (fd) => fs.ftruncateSync(fd, 0)],
  ['ftruncate callback', (fd) => cb((d) => fs.ftruncate(fd, 0, d))],
  ['fchmod', (fd) => fs.fchmodSync(fd, 0o444)],
  ['fchmod callback', (fd) => cb((d) => fs.fchmod(fd, 0o444, d))],
  ['futimes', (fd) => fs.futimesSync(fd, T1, T1)],
  ['futimes callback', (fd) => cb((d) => fs.futimes(fd, T1, T1, d))],
  ['fchown', (fd) => fs.fchownSync(fd, uid, gid)],
  ['writeFile(fd)', (fd) => fs.writeFileSync(fd, 'X')],
  ['appendFile(fd)', (fd) => fs.appendFileSync(fd, 'X')],
  ['write stream(fd)', (fd) => streamDone(fs.createWriteStream(null, { fd, autoClose: false, start: 0 }), 'X')],
];
const HANDLE_EFFECTS = [
  ['handle.write', (h) => h.write('X', 0)],
  ['handle.writev', (h) => h.writev([Buffer.from('X')], 0)],
  ['handle.truncate', (h) => h.truncate(0)],
  ['handle.chmod', (h) => h.chmod(0o444)],
  ['handle.utimes', (h) => h.utimes(T1, T1)],
  ['handle.chown', (h) => h.chown(uid, gid)],
  ['handle.writeFile', (h) => h.writeFile('X')],
  ['handle.appendFile', (h) => h.appendFile('X')],
  ['fs.promises.writeFile(handle)', (h) => fs.promises.writeFile(h, 'X')],
  // autoClose: a FileHandle stream without it keeps the handle referenced,
  // its close never settles. A refused stream closes its handle: the call
  // let through gets a second handle of the same open (`spare`).
  ['handle write stream', (h) => streamDone(h.createWriteStream({ start: 0 }), 'X'), { spare: true }],
  ['fs.writeSync(handle.fd)', (h) => fs.writeSync(h.fd, 'X', 0)],
];
// Origins of a descriptor: opened in the ended context (reading), or in the
// foreground (reading or writing) and the alias then removed or renamed.
const ORIGINS = [
  { name: 'opened in the ended context', mode: 'r', ended: true },
  { name: 'foreground r, alias removed', mode: 'r', after: 'remove' },
  { name: 'foreground r+, alias removed', mode: 'r+', after: 'remove' },
  { name: 'foreground r, alias renamed', mode: 'r', after: 'rename' },
  { name: 'foreground r+, alias renamed', mode: 'r+', after: 'rename' },
];
function unalias(form, how) {
  if (form.alias) {
    if (how === 'remove') fs.unlinkSync(form.alias);
    else fs.renameSync(form.alias, `${form.alias}-renamed`);
    return true;
  }
  // No alias (direct, relative, letter case): the file is renamed inside its folder.
  if (how === 'rename') { fs.renameSync(path.join(root, 'c1', 'metadata.json'), path.join(root, 'c1', 'metadata.moved.json')); return true; }
  return false;
}

const tally = { cells: 0, refused: 0, oracle: 0, refusedOnly: 0, onLink: 0, controls: 0, undefinedForms: 0 };

/**
 * One cell: refused in the ended context with the folder unchanged, and the
 * same call let through counted by the oracle. Returns the mismatch or null.
 */
async function protectedCell(label, run, oracle = true, through = run) {
  if (process.env.CLASS_TRACE) process.stderr.write(`${label}\n`);
  tally.cells++;
  const before = state();
  const result = await inContext(ENDED, () => outcome(run));
  const after = state();
  const kinds = await counted(() => inContext(ALIVE, () => outcome(through)));
  const problems = [];
  if (result !== 'refused') problems.push(`sink: ${result}`);
  if (JSON.stringify(after) !== JSON.stringify(before)) problems.push(`folder changed: ${JSON.stringify(Object.keys(after).filter((k) => after[k] !== before[k]).concat(Object.keys(before).filter((k) => !(k in after))))}`);
  if (oracle && !kinds.length) problems.push('oracle: not counted');
  if (result === 'refused') tally.refused++;
  if (kinds.length || !oracle) tally.oracle++;
  if (!oracle) tally.refusedOnly++;
  return problems.length ? `${label}: ${problems.join('; ')}` : null;
}
/** A call on a link itself, or a control outside: passes, the folder unchanged, nothing counted. */
async function passingCell(label, run, kind) {
  if (process.env.CLASS_TRACE) process.stderr.write(`${label}\n`);
  tally[kind]++;
  const before = state();
  let result;
  const kinds = await counted(() => inContext(ENDED, async () => { result = await outcome(run); }));
  const after = state();
  const problems = [];
  if (result === 'refused' || (kind === 'controls' && result !== 'ok')) problems.push(`sink: ${result}`);
  if (JSON.stringify(after) !== JSON.stringify(before)) problems.push('folder changed');
  if (kinds.length) problems.push(`oracle counted ${kinds.join(',')}`);
  return problems.length ? `${label}: ${problems.join('; ')}` : null;
}

for (const formName of Object.keys(FORMS)) {
  describe(`path form: ${formName}`, () => {
    it('every path effect in the ended context: refused, the folder unchanged, the oracle counts it', async () => {
      const problems = [];
      for (const [effect, kind, onName, call] of PATH_EFFECTS) {
        fresh();
        const form = FORMS[formName](NEW_NAME[kind], kind);
        if (form === null) continue;
        if (form === undefined) { tally.undefinedForms++; continue; } // no right to make the link
        const flags = pick(WRITING);
        const run = () => call(form.path, flags);
        const label = `${formName} x ${effect}${effect.startsWith('open') ? ` (${typeof flags === 'number' ? `0x${flags.toString(16)}` : flags})` : ''}`;
        const problem = onName && ON_LINK.has(formName) ? await passingCell(label, run, 'onLink') : await protectedCell(label, run, !form.lexicalHere);
        if (problem) problems.push(problem);
      }
      expect(problems).toEqual([]);
    }, 300000);

    it('every descriptor and handle effect, by origin: refused, the folder unchanged, the oracle counts it', async () => {
      const problems = [];
      for (const origin of ORIGINS) {
        for (const [effect, call, handle, { spare } = {}] of [...FD_EFFECTS.map(([n, c]) => [n, c, false]), ...HANDLE_EFFECTS.map(([n, c, o]) => [n, c, true, o])]) {
          fresh();
          const form = FORMS[formName]('metadata.json', 'file');
          if (form === null) continue;
          if (form === undefined) { tally.undefinedForms++; continue; }
          if (form.lexicalHere) continue;
          const mode = form.dangling ? 'a+' : origin.mode;
          if (form.dangling && origin.ended) continue; // nothing to read
          const handles = [];
          try {
            const open = () => (handle ? fs.promises.open(form.path, mode) : fs.openSync(form.path, mode));
            for (let i = 0; i < (spare ? 2 : 1); i++) handles.push(await (origin.ended ? inContext(ENDED, open) : open()));
          } catch (error) {
            problems.push(`${formName} x ${origin.name} x ${effect}: open failed ${error.code}`);
            continue;
          }
          try {
            if (origin.after && !unalias(form, origin.after)) continue;
            const [first, second = first] = handles;
            const problem = await protectedCell(`${formName} x ${origin.name} x ${effect}`, () => call(first), true, () => call(second));
            if (problem) problems.push(problem);
          } finally {
            for (const opened of handles) {
              if (handle) await outcome(() => opened.close());
              else try { fs.closeSync(opened); } catch { /* closed */ }
            }
          }
        }
      }
      expect(problems).toEqual([]);
    }, 300000);
  });
}

describe('control cells outside the recordings folder: no over-refusal', () => {
  // Logs, settings, updates: a file outside, through its own links too, and a
  // sibling whose name starts like the folder's.
  const TARGETS = {
    'a log file': () => path.join(outside, 'logs', 'app.log'),
    'a log file, relative': () => path.relative(process.cwd(), path.join(outside, 'logs', 'app.log')),
    'a link to a log file': () => (link(path.join(outside, 'logs', 'app.log'), path.join(outside, 'loglink'), 'file') ? path.join(outside, 'loglink') : null),
    'a link to the log folder plus ..': () => (link(path.join(outside, 'logs'), path.join(outside, 'logdir'), 'dir') ? raw(path.join(outside, 'logdir'), '..', 'logs', 'app.log') : null),
    'a sibling of the folder (Recordings-old)': () => { fs.mkdirSync(`${root}-old`); fs.writeFileSync(path.join(`${root}-old`, 'settings.json'), '{}'); return path.join(`${root}-old`, 'settings.json'); },
    'an update file': () => { fs.mkdirSync(path.join(outside, 'updates')); fs.writeFileSync(path.join(outside, 'updates', 'latest.yml'), 'v'); return path.join(outside, 'updates', 'latest.yml'); },
  };

  it('every path effect on them in the ended context passes', async () => {
    const problems = [];
    for (const [target, make] of Object.entries(TARGETS)) {
      for (const [effect, kind, , call] of PATH_EFFECTS) {
        fresh();
        let p = make();
        if (p === null) continue;
        if (kind === 'new') p = path.join(path.dirname(p), 'new-file');
        const flags = pick(WRITING);
        const problem = await passingCell(`${target} x ${effect}`, () => call(p, flags), 'controls');
        if (problem) problems.push(problem);
      }
    }
    expect(problems).toEqual([]);
  }, 300000);

  it('every descriptor and handle effect on them passes, opened in the ended context or the foreground', async () => {
    const problems = [];
    for (const [target, make] of Object.entries(TARGETS)) {
      for (const where of ['ended', 'foreground']) {
        for (const [effect, call, handle] of [...FD_EFFECTS.map(([n, c]) => [n, c, false]), ...HANDLE_EFFECTS.map(([n, c]) => [n, c, true])]) {
          fresh();
          const p = make();
          if (p === null) continue;
          const open = () => (handle ? fs.promises.open(p, 'r+') : fs.openSync(p, 'r+'));
          const opened = await (where === 'ended' ? inContext(ENDED, open) : open());
          try {
            const problem = await passingCell(`${target} (${where}) x ${effect}`, () => call(opened), 'controls');
            if (problem) problems.push(problem);
          } finally {
            if (handle) await outcome(() => opened.close());
            else try { fs.closeSync(opened); } catch { /* closed */ }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  }, 300000);

  it('summary of the class probe', () => {
    // eslint-disable-next-line no-console
    console.log(`class probe (seed 0x${SEED.toString(16)}, ${process.platform}): ${tally.cells} protected cells, ${tally.refused} refused, ${tally.oracle} counted by the oracle (${tally.refusedOnly} of them refused on the Windows reading only, nothing to count); ${tally.onLink} cells on a link itself passed; ${tally.controls} control cells; ${tally.undefinedForms} cells without the right to make a link`);
    expect(tally.refused).toBe(tally.cells);
    expect(tally.oracle).toBe(tally.cells);
    expect(tally.cells).toBeGreaterThan(0);
  });
});
