// @vitest-environment node
import { sinks } from './support/globalSinks.js';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { AsyncResource } from 'node:async_hooks';
import { createRequire } from 'node:module';

// The context contract of main's effect gate (round 13, R-S7): in the context
// of a session that ended every effect is refused, whatever its target; without
// a context and in a living session the call goes straight through.
//
// Class probe: argument form {String, Buffer, URL, FD, Handle} x effect x API
// {sync, callback, promise} x target {recording, external}. Every cell in the
// ended context: refused, the oracle (support/globalSinks.js) counts nothing,
// every byte, mode and mtime stays. The same matrix alive and without a context:
// everything through, counted. No file of the fixture is special to the gate.

const require = createRequire(import.meta.url);
const gateModule = require('../../src-electron/effect-gate.js');
const { runInSession, bindSession, sealPort, installEffectGate } = gateModule;
const { createAppPorts } = require('../../src-electron/app-ports.js');
const { createSessionAuthority, fileRecordStore } = require('../../src-electron/session-authority.js');

const WIN = process.platform === 'win32';
const T0 = new Date('2026-01-01T00:00:00Z');
const uid = process.getuid ? process.getuid() : 0;
const gid = process.getgid ? process.getgid() : 0;

let base;
let work;
let rec;
let counter = 0;

class SessionEnded extends Error {
  constructor() { super('session ended'); this.code = 'SESSION_ENDED'; }
}
function session() {
  let over = false;
  return { assertAlive: () => { if (over) throw new SessionEnded(); }, end: () => { over = true; } };
}
const viaCallback = (fn) => new Promise((resolve, reject) => fn((error, value) => (error ? reject(error) : resolve(value))));
async function outcome(call) {
  try { await call(); return 'ok'; } catch (error) { return error?.code === 'SESSION_ENDED' ? 'refused' : String(error?.code || error); }
}

beforeAll(() => {
  installEffectGate();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-contract-'));
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function fresh() {
  work = path.join(base, `w${counter++}`);
  fs.mkdirSync(path.join(work, 'Recordings', 'c1', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(work, 'External', 'sub'), { recursive: true });
  for (const dir of ['Recordings/c1', 'External']) {
    const file = path.join(work, dir, 'data.json');
    fs.writeFileSync(file, '{"a":1}');
    fs.utimesSync(file, T0, T0);
  }
}
const folderOf = (target) => path.join(work, target === 'recording' ? 'Recordings/c1' : 'External');
/** Every entry below the fixture: bytes, mode, mtime. */
function state() {
  const out = {};
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      const st = fs.lstatSync(p);
      out[path.relative(work, p)] = d.isFile() ? `${st.mode.toString(8)} ${st.mtimeMs} ${fs.readFileSync(p).toString('base64')}` : `dir ${st.mode.toString(8)}`;
      if (d.isDirectory()) walk(p);
    }
  };
  walk(work);
  return out;
}
beforeEach(() => {
  rec = {
    root: path.join(base, 'no-root'), media: 'stub', effects: [],
    effect(kind, target, extra = {}) { this.effects.push({ kind, target, ...extra }); },
    after: (l, p) => p, waitThen: (l, fn) => setImmediate(fn), busy: () => false, spawn() {}, stream() {}, emulate: () => ({}),
  };
});

// --- the matrix ---
const FORMS = {
  String: (p) => p,
  Buffer: (p) => Buffer.from(p),
  URL: (p) => pathToFileURL(p),
};
/** Effects on a name: (form, folder) -> the arguments. Each exists as sync, callback and promise. */
const NAME_EFFECTS = {
  writeFile: (f, d) => [f(path.join(d, 'data.json')), 'X'],
  'writeFile (new)': (f, d) => [f(path.join(d, 'new.json')), 'X'],
  appendFile: (f, d) => [f(path.join(d, 'data.json')), 'X'],
  truncate: (f, d) => [f(path.join(d, 'data.json')), 0],
  chmod: (f, d) => [f(path.join(d, 'data.json')), 0o600],
  utimes: (f, d) => [f(path.join(d, 'data.json')), T0, new Date('2026-02-02T00:00:00Z')],
  chown: (f, d) => [f(path.join(d, 'data.json')), uid, gid],
  rename: (f, d) => [f(path.join(d, 'data.json')), f(path.join(d, 'moved.json'))],
  unlink: (f, d) => [f(path.join(d, 'data.json'))],
  copyFile: (f, d) => [f(path.join(d, 'data.json')), f(path.join(d, 'copy.json'))],
  link: (f, d) => [f(path.join(d, 'data.json')), f(path.join(d, 'hard.json'))],
  symlink: (f, d) => [f(path.join(d, 'data.json')), f(path.join(d, 'soft.json')), 'file'],
  mkdir: (f, d) => [f(path.join(d, 'made'))],
  rmdir: (f, d) => [f(path.join(d, 'sub'))],
  rm: (f, d) => [f(path.join(d, 'sub')), { recursive: true }],
  open: (f, d) => [f(path.join(d, 'data.json')), 'r+'],
  'open (numeric)': (f, d) => [f(path.join(d, 'data.json')), fs.constants.O_WRONLY],
  'open (exclusive)': (f, d) => [f(path.join(d, 'fresh.json')), 'wx'],
};
const realName = (name) => name.split(' ')[0];
const closeResult = (name, value) => {
  if (name !== 'open') return undefined;
  if (typeof value === 'number') fs.closeSync(value);
  else return value.close();
  return undefined;
};
const API = {
  sync: (name, args) => closeResult(name, fs[`${name}Sync`](...args)),
  callback: async (name, args) => closeResult(name, await viaCallback((cb) => fs[name](...args, cb))),
  promise: async (name, args) => closeResult(name, await fs.promises[name](...args)),
};
/** Effects on a descriptor (sync and callback; the promise API has none). */
const FD_EFFECTS = {
  write: (fd) => [fd, 'X'],
  writev: (fd) => [fd, [Buffer.from('X')]],
  ftruncate: (fd) => [fd, 0],
  fchmod: (fd) => [fd, 0o600],
  futimes: (fd) => [fd, T0, new Date('2026-02-02T00:00:00Z')],
  fchown: (fd) => [fd, uid, gid],
  writeFile: (fd) => [fd, 'X'],
  appendFile: (fd) => [fd, 'X'],
};
/** Effects on a handle. */
const HANDLE_EFFECTS = {
  write: (h) => h.write('X'),
  writev: (h) => h.writev([Buffer.from('X')]),
  writeFile: (h) => h.writeFile('X'),
  appendFile: (h) => h.appendFile('X'),
  truncate: (h) => h.truncate(0),
  chmod: (h) => h.chmod(0o600),
  utimes: (h) => h.utimes(T0, new Date('2026-02-02T00:00:00Z')),
  chown: (h) => h.chown(uid, gid),
  'promises.writeFile': (h) => fs.promises.writeFile(h, 'X'),
};
const cells = [];
for (const target of ['recording', 'external']) {
  for (const [form, f] of Object.entries(FORMS)) {
    for (const [name, make] of Object.entries(NAME_EFFECTS)) {
      for (const api of Object.keys(API)) {
        cells.push({ title: `${form} ${name} ${api} ${target}`, target, run: () => API[api](realName(name), make(f, folderOf(target))) });
      }
    }
  }
  for (const [name, make] of Object.entries(FD_EFFECTS)) {
    for (const api of ['sync', 'callback']) {
      for (const flags of ['r+', 'r']) {
        // An effect on a descriptor opened before the cell, whatever its flags.
        cells.push({ title: `FD(${flags}) ${name} ${api} ${target}`, target, descriptor: flags, onlyWhenRefused: flags === 'r', run: (fd) => API[api](name, make(fd)) });
      }
    }
  }
  for (const [name, call] of Object.entries(HANDLE_EFFECTS)) {
    for (const flags of ['r+', 'r']) {
      cells.push({ title: `Handle(${flags}) ${name} ${target}`, target, handle: flags, onlyWhenRefused: flags === 'r', run: (h) => call(h) });
    }
  }
}
async function runCell(cell, wrap) {
  fresh();
  const file = path.join(folderOf(cell.target), 'data.json');
  const held = cell.descriptor ? fs.openSync(file, cell.descriptor) : cell.handle ? await fs.promises.open(file, cell.handle) : null;
  const before = state();
  sinks.bind(rec);
  let result;
  try {
    result = await wrap(() => outcome(() => cell.run(held)));
  } finally {
    sinks.unbind(rec);
    if (typeof held === 'number') fs.closeSync(held);
    else if (held) await held.close();
  }
  return { result, before, after: state() };
}

describe('class probe: argument form x effect x API x target', () => {
  it(`in the context of an ended session all ${cells.length} cells are refused, nothing counted, nothing changed`, async () => {
    const wrong = [];
    for (const cell of cells) {
      const s = session();
      s.end();
      rec.effects = [];
      const { result, before, after } = await runCell(cell, (fn) => runInSession(s, fn));
      if (result !== 'refused') wrong.push(`${cell.title}: ${result}`);
      if (rec.effects.length) wrong.push(`${cell.title}: counted ${JSON.stringify(rec.effects)}`);
      if (JSON.stringify(before) !== JSON.stringify(after)) wrong.push(`${cell.title}: changed`);
    }
    expect(wrong).toEqual([]);
  }, 600000);

  const passing = cells.filter((c) => !c.onlyWhenRefused);
  for (const [context, wrap] of [['living session', (fn) => runInSession(session(), fn)], ['no context', (fn) => fn()]]) {
    it(`${context}: all ${passing.length} cells go through and are counted`, async () => {
      const wrong = [];
      let done = 0;
      for (const cell of passing) {
        rec.effects = [];
        const { result } = await runCell(cell, wrap);
        // What the system itself refuses here (no right for a link, no chown) is its answer.
        if (result === 'ok') done++;
        else if (result === 'refused' || result === 'EFFECT_REFUSED' || !['EPERM', 'ENOTSUP', 'EACCES', 'ENOSYS'].includes(result)) wrong.push(`${cell.title}: ${result}`);
        if (result === 'ok' && !rec.effects.length) wrong.push(`${cell.title}: not counted`);
      }
      expect(wrong).toEqual([]);
      expect(done).toBeGreaterThan(passing.length * 0.8);
    }, 600000);
  }

  it('a write stream: refused after the end wherever it points, through while alive', async () => {
    fresh();
    const write = (file) => new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(file);
      stream.on('error', reject);
      stream.end('X', (error) => (error ? reject(error) : resolve()));
    });
    const s = session();
    s.end();
    const before = state();
    const refused = await runInSession(s, async () => [
      await outcome(() => write(path.join(folderOf('recording'), 'data.json'))),
      await outcome(() => write(path.join(folderOf('external'), 'data.json'))),
    ]);
    expect({ refused, same: JSON.stringify(state()) === JSON.stringify(before) }).toEqual({ refused: ['refused', 'refused'], same: true });
    expect(await runInSession(session(), () => outcome(() => write(path.join(folderOf('external'), 'stream.txt'))))).toBe('ok');
  });

  it('no effect: reading, reading opens, fsync and close pass after the end', async () => {
    fresh();
    const file = path.join(folderOf('recording'), 'data.json');
    // fsync on descriptors opened for writing before the end: Windows refuses it on a reading one.
    const fd = fs.openSync(file, 'r+');
    const handle = await fs.promises.open(file, 'r+');
    const s = session();
    s.end();
    const r = await runInSession(s, async () => ({
      read: await outcome(() => fs.readFileSync(file)),
      open: await outcome(() => fs.closeSync(fs.openSync(file, 'r'))),
      promiseOpen: await outcome(async () => (await fs.promises.open(file, 'r')).close()),
      fsync: await outcome(() => { fs.fsyncSync(fd); fs.closeSync(fd); }),
      handle: await outcome(async () => { await handle.sync(); await handle.close(); }),
      stat: await outcome(() => fs.statSync(file)),
    }));
    expect(r).toEqual({ read: 'ok', open: 'ok', promiseOpen: 'ok', fsync: 'ok', handle: 'ok', stat: 'ok' });
  });
});

describe('P1: the static counter cases of round 12', () => {
  it.skipIf(process.platform !== 'linux')('F11: a path with a byte that is no UTF-8, a link into the recording: refused, bytes unchanged', async () => {
    fresh();
    const data = path.join(folderOf('recording'), 'data.json');
    const alias = Buffer.concat([Buffer.from(`${folderOf('external')}/`), Buffer.from([0xff])]);
    fs.symlinkSync(data, alias);
    const before = fs.readFileSync(data);
    const s = session();
    s.end();
    const result = await runInSession(s, () => outcome(() => fs.writeFileSync(alias, 'X')));
    expect({ result, same: fs.readFileSync(data).equals(before) }).toEqual({ result: 'refused', same: true });
    // Control: alive it does land there - the probe is real.
    await runInSession(session(), () => fs.writeFileSync(alias, 'X'));
    expect(fs.readFileSync(data, 'utf8')).toBe('X');
  });

  for (const api of ['sync', 'callback', 'promise']) {
    it(`F12: cp (${api}) with a link below its target into the recording: refused, bytes unchanged`, async () => {
      fresh();
      const ext = folderOf('external');
      const data = path.join(folderOf('recording'), 'data.json');
      fs.mkdirSync(path.join(ext, 'src', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(ext, 'src', 'sub', 'data.json'), 'X');
      fs.mkdirSync(path.join(ext, 'dst'));
      fs.symlinkSync(folderOf('recording'), path.join(ext, 'dst', 'sub'), WIN ? 'junction' : 'dir');
      const before = fs.readFileSync(data);
      const options = { recursive: true, dereference: true };
      const call = { sync: () => fs.cpSync(path.join(ext, 'src'), path.join(ext, 'dst'), options), callback: () => viaCallback((cb) => fs.cp(path.join(ext, 'src'), path.join(ext, 'dst'), options, cb)), promise: () => fs.promises.cp(path.join(ext, 'src'), path.join(ext, 'dst'), options) }[api];
      const s = session();
      s.end();
      const result = await runInSession(s, () => outcome(call));
      expect({ result, same: fs.readFileSync(data).equals(before) }).toEqual({ result: 'refused', same: true });
    });
  }
});

// P2: the red team's own sequence.
describe('P2: a listener of session A after its end', () => {
  const noContext = new AsyncResource('no-context');
  function handler(file, sent) {
    return () => {
      fs.writeFileSync(file, 'X');
      childProcess.execFileSync(process.execPath, ['-v']);
      gateModule.assertPublishAllowed();
      sent.push('event');
    };
  }
  const FIRES = {
    'without a context': (emitter) => noContext.runInAsyncScope(() => emitter.emit('go')),
    'under session B': (emitter) => runInSession(session(), () => emitter.emit('go')),
    'from an external timer': (emitter) => new Promise((resolve) => { noContext.runInAsyncScope(() => setTimeout(() => { emitter.emit('go'); resolve(); }, 1)); }),
  };
  for (const [how, fire] of Object.entries(FIRES)) {
    it(`bound: emit ${how}: no write, no process, no event; the refusal is handed on as an error`, async () => {
      fresh();
      const file = path.join(folderOf('external'), 'listener.txt');
      const a = session();
      const emitter = new EventEmitter();
      const sent = [];
      const errors = [];
      runInSession(a, () => emitter.on('go', bindSession(handler(file, sent), (error) => errors.push(error.code))));
      a.end();
      await fire(emitter);
      expect({ written: fs.existsSync(file), sent, errors }).toEqual({ written: false, sent: [], errors: ['SESSION_ENDED'] });
    });
  }

  it('control: the same bound listener in a living session has its effects', async () => {
    fresh();
    const file = path.join(folderOf('external'), 'listener.txt');
    const emitter = new EventEmitter();
    const sent = [];
    runInSession(session(), () => emitter.on('go', bindSession(handler(file, sent), () => {})));
    noContext.runInAsyncScope(() => emitter.emit('go'));
    expect({ written: fs.existsSync(file), sent }).toEqual({ written: true, sent: ['event'] });
  });

  it('a queue of a bound function: the refusal rejects its promise (no fail handler: it goes on)', async () => {
    fresh();
    const a = session();
    const fn = runInSession(a, () => bindSession(() => fs.writeFileSync(path.join(folderOf('external'), 'q.txt'), 'X')));
    a.end();
    await expect(Promise.resolve().then(fn)).rejects.toMatchObject({ code: 'SESSION_ENDED' });
  });

  it('without a context bindSession is the function itself', () => {
    const fn = () => {};
    expect(bindSession(fn)).toBe(fn);
  });
});

// R-S7.6: code of the caller never runs inside an admitted call.
describe('P2: foreign code is never admitted', () => {
  const delay = () => new Promise((resolve) => { setTimeout(resolve, 5); });

  for (const [state_, make] of [['living', () => session()], ['ended', () => { const s = session(); s.end(); return s; }]]) {
    it(`cp with a delayed filter (${state_} session): refused, the filter never runs`, async () => {
      fresh();
      const ext = folderOf('external');
      let ran = false;
      const filter = async () => { ran = true; await delay(); fs.writeFileSync(path.join(ext, 'filter.txt'), 'X'); return true; };
      const result = await runInSession(make(), () => outcome(() => fs.promises.cp(path.join(ext, 'sub'), path.join(ext, 'dst'), { recursive: true, filter })));
      expect(result === 'refused' || result === 'EFFECT_REFUSED').toBe(true);
      expect({ ran, note: fs.existsSync(path.join(ext, 'filter.txt')) }).toEqual({ ran: false, note: false });
    });

    for (const [name, data] of [['an async iterable', () => (async function* gen() { yield 'a'; })()], ['an iterable', () => ['a', 'b'][Symbol.iterator]()], ['a stream', () => fs.createReadStream(__filename)], ['an object with toString', () => ({ toString: () => 'x' })]]) {
      it(`writeFile/appendFile with ${name} (${state_} session): refused, nothing written`, async () => {
        fresh();
        const file = path.join(folderOf('external'), 'out.txt');
        const value = data();
        const results = await runInSession(make(), async () => [
          await outcome(() => fs.promises.writeFile(file, value)),
          await outcome(() => fs.promises.appendFile(file, value)),
          await outcome(() => fs.writeFileSync(file, value)),
          await outcome(() => viaCallback((cb) => fs.writeFile(file, value, cb))),
        ]);
        if (typeof value.destroy === 'function') value.destroy();
        expect(results.every((r) => r === 'refused' || r === 'EFFECT_REFUSED'), JSON.stringify(results)).toBe(true);
        expect(fs.existsSync(file)).toBe(false);
      });
    }

    it(`a handle's writeFile with an iterable (${state_} session): refused`, async () => {
      fresh();
      const handle = await fs.promises.open(path.join(folderOf('external'), 'data.json'), 'r+');
      const result = await runInSession(make(), () => outcome(() => handle.writeFile((async function* gen() { yield 'a'; })())));
      await handle.close();
      expect(result === 'refused' || result === 'EFFECT_REFUSED').toBe(true);
    });
  }

  it('without a context cp and iterables run as ever (R-S7.3)', async () => {
    fresh();
    const ext = folderOf('external');
    fs.writeFileSync(path.join(ext, 'sub', 'a.txt'), 'a');
    await fs.promises.cp(path.join(ext, 'sub'), path.join(ext, 'dst'), { recursive: true, filter: async () => true });
    await fs.promises.writeFile(path.join(ext, 'it.txt'), (async function* gen() { yield 'a'; })());
    expect({ copied: fs.existsSync(path.join(ext, 'dst', 'a.txt')), it: fs.readFileSync(path.join(ext, 'it.txt'), 'utf8') }).toEqual({ copied: true, it: 'a' });
  });

  it('a process start inside an admitted call is refused after the end (it ignores admitted)', async () => {
    fresh();
    const s = session();
    // Node's own stream of an admitted cp would run here; the nearest a test gets:
    // a getter of the options, read inside the admitted call.
    let result = null;
    const options = { get recursive() { s.end(); try { childProcess.execFileSync(process.execPath, ['-v']); result = 'ok'; } catch (error) { result = error.code; } return false; } };
    runInSession(s, () => { try { fs.mkdirSync(path.join(folderOf('external'), 'made'), options); } catch { /* its own answer */ } });
    expect(result).toBe('SESSION_ENDED');
  });
});

describe('R-S7.7: the temp rule', () => {
  const TEMP_NAME = 'data.json.3f0c2a52-7d1e-4c4b-9a7e-2b1d5f6a8c90.tmp';

  for (const api of ['sync', 'callback', 'promise']) {
    it(`an exclusive open of this context earns one unlink of its exact string (${api})`, async () => {
      fresh();
      const temp = path.join(folderOf('recording'), TEMP_NAME);
      const s = session();
      await runInSession(s, () => API[api]('open', [temp, 'wx']));
      s.end();
      const first = await runInSession(s, () => outcome(() => API[api]('unlink', [temp])));
      expect({ first, gone: fs.existsSync(temp) }).toEqual({ first: 'ok', gone: false });
      fs.writeFileSync(temp, 'again');
      const second = await runInSession(s, () => outcome(() => API[api]('unlink', [temp])));
      expect({ second, kept: fs.existsSync(temp) }).toEqual({ second: 'refused', kept: true });
    });
  }

  it('the name pattern alone earns nothing', async () => {
    fresh();
    const temp = path.join(folderOf('recording'), TEMP_NAME);
    fs.writeFileSync(temp, 'x');
    const s = session();
    s.end();
    expect(await runInSession(s, () => outcome(() => fs.unlinkSync(temp)))).toBe('refused');
    expect(fs.existsSync(temp)).toBe(true);
  });

  it('only the exact string: another spelling of the same file is refused', async () => {
    fresh();
    const temp = path.join(folderOf('recording'), TEMP_NAME);
    const s = session();
    await runInSession(s, () => fs.closeSync(fs.openSync(temp, 'wx')));
    s.end();
    const spelling = [folderOf('recording'), 'sub', '..', TEMP_NAME].join(path.sep);
    const results = await runInSession(s, async () => [await outcome(() => fs.unlinkSync(spelling)), await outcome(() => fs.unlinkSync(Buffer.from(temp)))]);
    expect(results).toEqual(['refused', 'refused']);
    expect(fs.existsSync(temp)).toBe(true);
  });

  it('another session\'s exclusive open earns this session nothing; a non-exclusive open neither', async () => {
    fresh();
    const temp = path.join(folderOf('recording'), TEMP_NAME);
    const other = path.join(folderOf('recording'), 'plain.tmp');
    await runInSession(session(), () => fs.closeSync(fs.openSync(temp, 'wx')));
    const s = session();
    await runInSession(s, () => fs.closeSync(fs.openSync(other, 'w')));
    s.end();
    const results = await runInSession(s, async () => [await outcome(() => fs.unlinkSync(temp)), await outcome(() => fs.unlinkSync(other))]);
    expect(results).toEqual(['refused', 'refused']);
  });

  it('once published (renamed) the string earns nothing any more', async () => {
    fresh();
    const temp = path.join(folderOf('recording'), TEMP_NAME);
    const s = session();
    await runInSession(s, () => { fs.closeSync(fs.openSync(temp, 'wx')); fs.renameSync(temp, path.join(folderOf('recording'), 'done.json')); });
    fs.writeFileSync(temp, 'later');
    s.end();
    expect(await runInSession(s, () => outcome(() => fs.unlinkSync(temp)))).toBe('refused');
  });

  it('other effects on an earned string stay refused', async () => {
    fresh();
    const temp = path.join(folderOf('recording'), TEMP_NAME);
    const s = session();
    await runInSession(s, () => fs.closeSync(fs.openSync(temp, 'wx')));
    s.end();
    const results = await runInSession(s, async () => [await outcome(() => fs.writeFileSync(temp, 'X')), await outcome(() => fs.renameSync(temp, `${temp}.x`))]);
    expect(results).toEqual(['refused', 'refused']);
  });
});

describe('P4: what leaves the context', () => {
  const electronLog = () => {
    const log = require('electron-log/node');
    log.transports.console.level = false;
    return log;
  };

  it('a log line from the ended context reaches its file, rotation included', async () => {
    fresh();
    const log = electronLog();
    const file = path.join(folderOf('external'), 'main.log');
    log.transports.file.resolvePathFn = () => file;
    log.transports.file.maxSize = 64;
    log.transports.file.sync = true;
    const logData = log.logData;
    const sentry = { captureMessage() {}, captureException() {} };
    createAppPorts({ log, Sentry: sentry });
    try {
      const s = session();
      s.end();
      runInSession(s, () => { for (let i = 0; i < 8; i++) log.info(`line ${i} from the ended context`); });
      expect(fs.readFileSync(file, 'utf8')).toContain('line 7');
      expect(fs.existsSync(`${file.slice(0, -4)}.old.log`) || fs.existsSync(`${file}.old`), 'rotated').toBe(true);
    } finally {
      log.logData = logData;
      log.transports.file.level = false;
    }
  });

  it('telemetry from the ended context: the event and what the reporter writes behind it', async () => {
    fresh();
    const store = path.join(folderOf('external'), 'sentry-offline.json');
    const events = [];
    const sentry = {
      captureMessage: (message, context) => { events.push({ message, context }); fs.writeFileSync(store, 'queued'); },
      captureException: (exception, context) => { events.push({ exception, context }); },
    };
    const { telemetry } = createAppPorts({ log: {}, Sentry: sentry });
    const s = session();
    s.end();
    const error = new Error('x');
    runInSession(s, () => { telemetry({ message: 'm', context: 'error' }); telemetry({ exception: error }); });
    expect(events).toEqual([{ message: 'm', context: 'error' }, { exception: error, context: undefined }]);
    expect(fs.readFileSync(store, 'utf8')).toBe('queued');
  });

  function authorityOn(file) {
    const token = { saved: null };
    return createSessionAuthority({
      recordStore: fileRecordStore(file),
      vault: { saveToken: (t) => { token.saved = t; return { success: true }; }, clearToken: () => { token.saved = null; return { success: true }; }, getToken: () => token.saved, readStoredToken: () => ({ status: 'missing' }) },
      userStore: { get: () => null, set: () => true, delete: () => true },
      flows: { clear: () => true, peek: () => null },
    });
  }
  it('the tombstone from the ended context of another session: written and read back (E5)', async () => {
    fresh();
    const file = path.join(folderOf('external'), 'session-authority.json');
    const authority = authorityOn(file);
    const s = session();
    s.end();
    const result = runInSession(s, () => authority.signOut());
    expect(result.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).signedOut).toBe(true);
  });

  it('nothing of a recording can go through a port: a path is only text', async () => {
    fresh();
    const data = path.join(folderOf('recording'), 'data.json');
    const before = state();
    const log = { logData: () => {} };
    const { appLog, telemetry } = createAppPorts({ log, Sentry: { captureMessage() {}, captureException() {} } });
    const s = session();
    s.end();
    runInSession(s, () => { appLog('info', data); telemetry({ message: data }); });
    expect(state()).toEqual(before);
  });

  it('a port takes no callback, there is no fourth one, the context is not exported', () => {
    const { appLog, telemetry } = createAppPorts({ log: { logData: () => {} }, Sentry: {} });
    expect(() => appLog('info', () => fs.writeFileSync('x', 'y'))).toThrow(/no callback/);
    expect(() => telemetry(() => {})).toThrow(/no callback/);
    expect(() => sealPort('settings', () => {})).toThrow(/no port/);
    expect(Object.keys(gateModule).sort()).toEqual(['assertPublishAllowed', 'bindSession', 'installEffectGate', 'runInSession', 'sealPort']);
  });

  it('without a context a port is a plain call too', () => {
    const lines = [];
    const log = { logData: (data, options) => lines.push([data, options.level]) };
    createAppPorts({ log, Sentry: {} });
    log.logData(['x'], { level: 'info' });
    expect(lines).toEqual([[['x'], 'info']]);
  });
});

// P6: the sink adds no system call: the same list of calls per open, gate or no gate.
describe('P6: no extra system call per open', () => {
  const WATCHED = ['lstatSync', 'fstatSync', 'statSync', 'readlinkSync', 'realpathSync', 'lstat', 'fstat', 'stat', 'readlink', 'realpath'];
  function countingFs() {
    const counts = {};
    const fake = { ...fs, promises: { ...fs.promises } };
    for (const name of [...WATCHED, 'openSync', 'open', 'closeSync', 'close', 'writeSync']) {
      const real = fs[name];
      counts[name] = 0;
      fake[name] = function (...args) { counts[name]++; return real.apply(fs, args); };
    }
    fake.promises.open = function (...args) { counts.promises_open = (counts.promises_open || 0) + 1; return fs.promises.open(...args); };
    for (const name of ['lstat', 'fstat', 'stat', 'readlink', 'realpath']) {
      counts[`promises_${name}`] = 0;
      fake.promises[name] = function (...args) { counts[`promises_${name}`]++; return fs.promises[name](...args); };
    }
    return { fake, counts };
  }
  const look = (counts) => Object.entries(counts).filter(([k, v]) => v > 0 && !['openSync', 'open', 'closeSync', 'close', 'writeSync', 'promises_open'].includes(k));
  async function scenario(target, f) {
    for (let i = 0; i < 5; i++) {
      const fd = f.openSync(path.join(target, `s${i}.txt`), 'w');
      f.writeSync(fd, 'x');
      f.closeSync(fd);
      f.closeSync(f.openSync(path.join(target, `s${i}.txt`), 'r'));
      await new Promise((resolve, reject) => f.open(path.join(target, `c${i}.txt`), 'w', (e, n) => { if (e) reject(e); else { f.closeSync(n); resolve(); } }));
      await (await f.promises.open(path.join(target, `p${i}.txt`), 'w')).close();
    }
  }
  it('lstat, fstat, readlink, stat per open: the same with and without the gate, without a context and in a living session', async () => {
    fresh();
    const plain = countingFs();
    await scenario(folderOf('external'), plain.fake);
    expect(look(plain.counts)).toEqual([]);
    const gated = countingFs();
    installEffectGate({ fs: gated.fake, childProcess: { spawn() {} } });
    await scenario(folderOf('recording'), gated.fake);
    expect(look(gated.counts)).toEqual([]);
    await runInSession(session(), () => scenario(folderOf('external'), gated.fake));
    expect(look(gated.counts)).toEqual([]);
    expect(gated.counts.openSync).toBe(plain.counts.openSync * 2);
  });
});
