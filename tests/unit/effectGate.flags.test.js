// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// The file sink of main (src-electron/effect-gate.js) at the system call
// itself, review round 11:
// - F6: numeric open flags (fs.constants O_WRONLY, O_RDWR, O_CREAT, O_TRUNC,
//   O_APPEND and their combinations) open for writing exactly like 'w', 'a',
//   'r+'; O_TRUNC empties the file at the open already. Sync, callback and
//   promise open, the descriptors and handles they return, write streams
//   and readFile with a writing flag.
// - Aliases of the recordings folder (a symlink or junction into it, a link
//   to one of its files, another letter case on macOS and Windows) are the
//   recordings folder.
// - Provenance: a descriptor or handle opened for writing OUTSIDE a gated
//   context (foreground) on a file of the folder is a file of the folder
//   when background work writes to it after its session ended.
// Every case runs in a gated context whose session ended and compares the
// file's content before and after: a refused call leaves it byte-identical.

const require = createRequire(import.meta.url);
const { publishGate, installEffectGate } = require('../../src-electron/effect-gate.js');
const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;

const CONTENT = '{"userId":"a","startedAt":"2026-10-01T10:00:00.000Z"}';
let base;
let root;
let outside;
let meta;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-gate-'));
  root = path.join(base, 'Recordings');
  outside = path.join(base, 'elsewhere');
  installEffectGate({ roots: () => [root] });
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'c1'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  meta = path.join(root, 'c1', 'metadata.json');
  fs.writeFileSync(meta, CONTENT);
});

class SessionEnded extends Error {
  constructor() { super('session ended'); this.code = 'SESSION_ENDED'; }
}
/** Runs fn in a gated context; `end()` ends its session. */
function gated(fn) {
  let ended = false;
  const gate = { assertAlive: () => { if (ended) throw new SessionEnded(); } };
  return publishGate.run(gate, () => fn(() => { ended = true; }));
}
/** The outcome of a call: 'refused' (SESSION_ENDED), 'ok' or the other error code. */
async function outcome(call) {
  try { await call(); return 'ok'; } catch (error) { return error?.code === 'SESSION_ENDED' ? 'refused' : String(error?.code || error); }
}
const viaCallback = (fn) => new Promise((resolve, reject) => fn((error, value) => (error ? reject(error) : resolve(value))));
const content = (file = meta) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

describe('F6: numeric open flags open for writing', () => {
  const FLAGS = {
    'O_WRONLY|O_TRUNC': O_WRONLY | O_TRUNC,
    O_RDWR,
    'O_WRONLY|O_APPEND': O_WRONLY | O_APPEND,
    'O_RDWR|O_CREAT': O_RDWR | O_CREAT,
    'O_WRONLY|O_CREAT|O_TRUNC': O_WRONLY | O_CREAT | O_TRUNC,
    'O_RDONLY|O_TRUNC': O_RDONLY | O_TRUNC,
    'r+': 'r+',
    'a+': 'a+',
    'rs+': 'rs+',
  };
  for (const [name, flags] of Object.entries(FLAGS)) {
    it(`openSync(metadata.json, ${name}) after the end: refused, content unchanged`, async () => {
      const result = await gated((end) => { end(); return outcome(() => fs.closeSync(fs.openSync(meta, flags))); });
      expect({ result, content: content() }).toEqual({ result: 'refused', content: CONTENT });
    });
    it(`open(metadata.json, ${name}, cb) after the end: refused, content unchanged`, async () => {
      const result = await gated((end) => { end(); return outcome(async () => fs.closeSync(await viaCallback((cb) => fs.open(meta, flags, cb)))); });
      expect({ result, content: content() }).toEqual({ result: 'refused', content: CONTENT });
    });
    it(`fs.promises.open(metadata.json, ${name}) after the end: refused, content unchanged`, async () => {
      const result = await gated((end) => { end(); return outcome(async () => (await fs.promises.open(meta, flags)).close()); });
      expect({ result, content: content() }).toEqual({ result: 'refused', content: CONTENT });
    });
  }

  it('O_WRONLY|O_CREAT of a new file after the end: refused, not created', async () => {
    const fresh = path.join(root, 'c1', 'fresh.txt');
    const result = await gated((end) => { end(); return outcome(() => fs.closeSync(fs.openSync(fresh, O_WRONLY | O_CREAT, 0o644))); });
    expect({ result, exists: fs.existsSync(fresh) }).toEqual({ result: 'refused', exists: false });
  });

  it('a descriptor opened with numeric flags before the end: its writes are refused after it', async () => {
    const result = await gated(async (end) => {
      const fd = fs.openSync(meta, O_RDWR);
      end();
      const r = {
        writeSync: await outcome(() => fs.writeSync(fd, 'X', 0)),
        ftruncateSync: await outcome(() => fs.ftruncateSync(fd, 0)),
        write: await outcome(() => viaCallback((cb) => fs.write(fd, 'X', 0, cb))),
        writeFileFd: await outcome(() => fs.writeFileSync(fd, 'X')),
      };
      fs.closeSync(fd);
      return r;
    });
    expect({ ...result, content: content() }).toEqual({ writeSync: 'refused', ftruncateSync: 'refused', write: 'refused', writeFileFd: 'refused', content: CONTENT });
  });

  it('a descriptor of the callback open with numeric flags before the end: refused after it', async () => {
    const result = await gated(async (end) => {
      const fd = await viaCallback((cb) => fs.open(meta, O_WRONLY | O_APPEND, cb));
      end();
      const r = await outcome(() => fs.writeSync(fd, 'X'));
      fs.closeSync(fd);
      return r;
    });
    expect({ result, content: content() }).toEqual({ result: 'refused', content: CONTENT });
  });

  it('a handle of the promise open with numeric flags before the end: its writes are refused after it', async () => {
    const result = await gated(async (end) => {
      const handle = await fs.promises.open(meta, O_RDWR);
      end();
      const r = {
        write: await outcome(() => handle.write('X', 0)),
        truncate: await outcome(() => handle.truncate(0)),
        writeFile: await outcome(() => handle.writeFile('X')),
      };
      await handle.close();
      return r;
    });
    expect({ ...result, content: content() }).toEqual({ write: 'refused', truncate: 'refused', writeFile: 'refused', content: CONTENT });
  });

  it('a write stream with numeric flags after the end: refused, content unchanged', async () => {
    const result = await gated((end) => {
      end();
      return outcome(() => new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(meta, { flags: O_WRONLY | O_TRUNC });
        stream.on('error', reject);
        stream.end('X', (error) => (error ? reject(error) : resolve()));
      }));
    });
    expect({ result, content: content() }).toEqual({ result: 'refused', content: CONTENT });
  });

  it('readFile with a writing flag after the end (w+ empties the file): refused', async () => {
    const result = await gated(async (end) => {
      end();
      return {
        sync: await outcome(() => fs.readFileSync(meta, { flag: 'w+' })),
        callback: await outcome(() => viaCallback((cb) => fs.readFile(meta, { flag: O_RDWR | O_TRUNC }, cb))),
        promise: await outcome(() => fs.promises.readFile(meta, { flag: 'w+' })),
      };
    });
    expect({ ...result, content: content() }).toEqual({ sync: 'refused', callback: 'refused', promise: 'refused', content: CONTENT });
  });

  it('controls: reading opens (numeric O_RDONLY, no flags, r) pass after the end', async () => {
    const result = await gated(async (end) => {
      end();
      return {
        rdonly: await outcome(() => fs.closeSync(fs.openSync(meta, O_RDONLY))),
        none: await outcome(async () => fs.closeSync(await viaCallback((cb) => fs.open(meta, cb)))),
        r: await outcome(async () => (await fs.promises.open(meta, 'r')).close()),
        readFile: await outcome(() => fs.readFileSync(meta)),
      };
    });
    expect(result).toEqual({ rdonly: 'ok', none: 'ok', r: 'ok', readFile: 'ok' });
  });

  it('controls: numeric writing opens outside the recordings folder pass after the end', async () => {
    const other = path.join(outside, 'log.txt');
    const result = await gated(async (end) => {
      end();
      return outcome(() => { const fd = fs.openSync(other, O_WRONLY | O_CREAT | O_TRUNC); fs.writeSync(fd, 'x'); fs.closeSync(fd); });
    });
    expect({ result, content: content(other) }).toEqual({ result: 'ok', content: 'x' });
  });

  it('controls: before the end every numeric writing open passes', async () => {
    const result = await gated(() => outcome(() => { const fd = fs.openSync(meta, O_WRONLY | O_APPEND); fs.writeSync(fd, '\n'); fs.closeSync(fd); }));
    expect({ result, content: content() }).toEqual({ result: 'ok', content: `${CONTENT}\n` });
  });
});

describe('aliases of the recordings folder', () => {
  /** A link; null where the system does not allow it (Windows without the right). */
  function link(target, at, type) {
    try { fs.symlinkSync(target, at, type); return at; } catch { return null; }
  }

  it('a symlink (junction) to a recording folder: writes through it are refused after the end', async (ctx) => {
    const alias = link(path.join(root, 'c1'), path.join(outside, 'alias'), 'junction');
    if (!alias) return ctx.skip();
    const result = await gated(async (end) => {
      end();
      return {
        writeFile: await outcome(() => fs.writeFileSync(path.join(alias, 'metadata.json'), 'X')),
        open: await outcome(() => fs.closeSync(fs.openSync(path.join(alias, 'metadata.json'), O_WRONLY | O_TRUNC))),
        create: await outcome(() => fs.writeFileSync(path.join(alias, 'new.txt'), 'X')),
        unlink: await outcome(() => fs.unlinkSync(path.join(alias, 'metadata.json'))),
      };
    });
    expect({ ...result, content: content(), created: fs.existsSync(path.join(root, 'c1', 'new.txt')) })
      .toEqual({ writeFile: 'refused', open: 'refused', create: 'refused', unlink: 'refused', content: CONTENT, created: false });
  });

  it('a symlink to a file of the folder: writing through it is refused, removing the link itself passes', async (ctx) => {
    const alias = link(meta, path.join(outside, 'meta-link.json'), 'file');
    if (!alias) return ctx.skip();
    const result = await gated(async (end) => {
      end();
      return {
        writeFile: await outcome(() => fs.writeFileSync(alias, 'X')),
        promise: await outcome(() => fs.promises.writeFile(alias, 'X')),
        unlinkLink: await outcome(() => fs.unlinkSync(alias)),
      };
    });
    expect({ ...result, content: content(), link: fs.existsSync(alias) }).toEqual({ writeFile: 'refused', promise: 'refused', unlinkLink: 'ok', content: CONTENT, link: false });
  });

  it('a dangling symlink into the folder: creating its target is refused', async (ctx) => {
    const target = path.join(root, 'c1', 'later.json');
    const alias = link(target, path.join(outside, 'later-link.json'), 'file');
    if (!alias) return ctx.skip();
    const result = await gated(async (end) => { end(); return outcome(() => fs.writeFileSync(alias, 'X')); });
    expect({ result, created: fs.existsSync(target) }).toEqual({ result: 'refused', created: false });
  });

  it.skipIf(process.platform === 'linux')('another letter case of the folder (macOS, Windows): refused after the end', async () => {
    const upper = path.join(path.dirname(root), path.basename(root).toUpperCase(), 'c1', 'metadata.json');
    const result = await gated(async (end) => { end(); return outcome(() => fs.writeFileSync(upper, 'X')); });
    expect({ result, content: content() }).toEqual({ result: 'refused', content: CONTENT });
  });

  it('a path with .. segments into the folder: refused after the end', async () => {
    const dotted = [outside, '..', path.basename(root), 'c1', '.', 'metadata.json'].join(path.sep);
    const result = await gated(async (end) => { end(); return outcome(() => fs.writeFileSync(dotted, 'X')); });
    expect({ result, content: content() }).toEqual({ result: 'refused', content: CONTENT });
  });
});

describe('provenance: descriptors and handles opened outside a gated context', () => {
  it('a descriptor opened in the foreground and written by background work after its end: refused', async () => {
    const fd = fs.openSync(meta, 'r+');
    try {
      const result = await gated(async (end) => {
        end();
        return {
          writeSync: await outcome(() => fs.writeSync(fd, 'X', 0)),
          write: await outcome(() => viaCallback((cb) => fs.write(fd, 'X', 0, cb))),
          ftruncate: await outcome(() => viaCallback((cb) => fs.ftruncate(fd, 0, cb))),
          appendFileFd: await outcome(() => fs.appendFileSync(fd, 'X')),
        };
      });
      expect({ ...result, content: content() }).toEqual({ writeSync: 'refused', write: 'refused', ftruncate: 'refused', appendFileFd: 'refused', content: CONTENT });
    } finally {
      fs.closeSync(fd);
    }
  });

  it('a numeric descriptor opened in the foreground (O_WRONLY|O_APPEND): refused after the end', async () => {
    const fd = fs.openSync(meta, O_WRONLY | O_APPEND);
    try {
      const result = await gated(async (end) => { end(); return outcome(() => fs.writeSync(fd, 'X')); });
      expect({ result, content: content() }).toEqual({ result: 'refused', content: CONTENT });
    } finally {
      fs.closeSync(fd);
    }
  });

  it('a handle opened in the foreground and written by background work after its end: refused', async () => {
    const handle = await fs.promises.open(meta, 'r+');
    try {
      const result = await gated(async (end) => {
        end();
        return {
          write: await outcome(() => handle.write('X', 0)),
          truncate: await outcome(() => handle.truncate(0)),
          fdWrite: await outcome(() => fs.writeSync(handle.fd, 'X', 0)),
        };
      });
      expect({ ...result, content: content() }).toEqual({ write: 'refused', truncate: 'refused', fdWrite: 'refused', content: CONTENT });
    } finally {
      await handle.close();
    }
  });

  it('controls: a foreground descriptor outside the folder, and a closed one reused, pass', async () => {
    const other = path.join(outside, 'log.txt');
    const fd = fs.openSync(other, 'w');
    try {
      const result = await gated(async (end) => { end(); return outcome(() => fs.writeSync(fd, 'x')); });
      expect(result).toBe('ok');
    } finally {
      fs.closeSync(fd);
    }
    // The number of a closed descriptor of the folder is no file of it.
    const first = fs.openSync(meta, 'r+');
    fs.closeSync(first);
    const again = fs.openSync(other, 'w');
    try {
      const result = await gated(async (end) => { end(); return outcome(() => fs.writeSync(again, 'y')); });
      expect(result).toBe('ok');
    } finally {
      fs.closeSync(again);
    }
  });
});

// Review round 12: fail-closed in the ended context - a call passes only when
// it is proven that it does not reach the folder.
describe('round 12, F8: a path resolved as the system resolves it', () => {
  function link(target, at, type) {
    try { fs.symlinkSync(target, at, type); return at; } catch { return null; }
  }

  it.skipIf(process.platform === 'win32')('a symlink plus «..» (the link first, then up from its target): refused, content unchanged', async (ctx) => {
    fs.mkdirSync(path.join(root, 'c1', 'sub'));
    const at = link(path.join(root, 'c1', 'sub'), path.join(outside, 'link'), 'dir');
    if (!at) return ctx.skip();
    const dotted = [at, '..', 'metadata.json'].join(path.sep);
    const result = await gated(async (end) => {
      end();
      return {
        open: await outcome(() => fs.closeSync(fs.openSync(dotted, O_WRONLY | O_CREAT | O_TRUNC))),
        writeFile: await outcome(() => fs.writeFileSync(dotted, 'X')),
        promise: await outcome(() => fs.promises.truncate(dotted, 0)),
      };
    });
    expect({ ...result, content: content() }).toEqual({ open: 'refused', writeFile: 'refused', promise: 'refused', content: CONTENT });
  });

  it('a path that cannot be decided (a link loop) is refused after the end, and fails by itself before it', async (ctx) => {
    const loop = link('loop', path.join(outside, 'loop'), 'file');
    if (!loop) return ctx.skip();
    const target = path.join(loop, 'x.txt');
    const after = await gated(async (end) => { end(); return outcome(() => fs.writeFileSync(target, 'X')); });
    const before = await gated(() => outcome(() => fs.writeFileSync(target, 'X')));
    expect({ after, before: before === 'refused' ? 'refused' : 'system error' }).toEqual({ after: 'refused', before: 'system error' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a folder without access on the way is refused after the end (not decidable)', async () => {
    const locked = path.join(outside, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const result = await gated(async (end) => { end(); return outcome(() => fs.writeFileSync(path.join(locked, 'inner', 'x.txt'), 'X')); });
      expect(result).toBe('refused');
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('a hard link to a file of the folder: writing through it is refused, removing the link itself passes', async (ctx) => {
    const hard = path.join(outside, 'hard.json');
    try { fs.linkSync(meta, hard); } catch { return ctx.skip(); }
    const result = await gated(async (end) => {
      end();
      return {
        writeFile: await outcome(() => fs.writeFileSync(hard, 'X')),
        chmod: await outcome(() => fs.chmodSync(hard, 0o444)),
        unlink: await outcome(() => fs.unlinkSync(hard)),
      };
    });
    expect({ ...result, content: content(), writable: (fs.statSync(meta).mode & 0o200) === 0o200 }).toEqual({ writeFile: 'refused', chmod: 'refused', unlink: 'ok', content: CONTENT, writable: true });
  });

  it('controls: a link outside plus «..» back outside, and a sibling folder named like the folder, pass', async (ctx) => {
    const logs = path.join(outside, 'logs');
    fs.mkdirSync(logs);
    const at = link(logs, path.join(outside, 'logdir'), 'dir');
    if (!at) return ctx.skip();
    const sibling = `${root}-old`;
    fs.mkdirSync(sibling);
    const result = await gated(async (end) => {
      end();
      return {
        dotted: await outcome(() => fs.writeFileSync([at, '..', 'logs', 'app.log'].join(path.sep), 'x')),
        sibling: await outcome(() => fs.writeFileSync(path.join(sibling, 'settings.json'), '{}')),
      };
    });
    expect(result).toEqual({ dotted: 'ok', sibling: 'ok' });
  });
});

describe('round 12, F9: what the open found is held until the close', () => {
  function link(target, at, type) {
    try { fs.symlinkSync(target, at, type); return at; } catch { return null; }
  }
  const ALIVE = { assertAlive() {} };

  for (const after of ['removed', 'renamed']) {
    it(`a descriptor and a handle opened in the foreground through a link, the link then ${after}: refused after logout and after login B`, async (ctx) => {
      const alias = link(meta, path.join(outside, 'meta-link.json'), 'file');
      if (!alias) return ctx.skip();
      const fd = fs.openSync(alias, 'r+');
      const handle = await fs.promises.open(alias, 'r+');
      if (after === 'removed') fs.unlinkSync(alias);
      else fs.renameSync(alias, `${alias}.old`);
      try {
        // Logout: the context of A ended. Login B: A's context still ended,
        // B's alive - B's own work passes, A's does not.
        const afterLogout = await gated(async (end) => {
          end();
          return { fd: await outcome(() => fs.writeSync(fd, 'X', 0)), handle: await outcome(() => handle.write('X', 0)) };
        });
        const afterLoginB = await gated(async (end) => {
          end();
          const a = { fd: await outcome(() => fs.writeSync(fd, 'X', 0)), handle: await outcome(() => handle.truncate(0)) };
          const b = await publishGate.run(ALIVE, async () => ({ fd: await outcome(() => fs.fsyncSync(fd)) }));
          return { a, b };
        });
        expect({ afterLogout, afterLoginB, content: content() }).toEqual({
          afterLogout: { fd: 'refused', handle: 'refused' },
          afterLoginB: { a: { fd: 'refused', handle: 'refused' }, b: { fd: 'ok' } },
          content: CONTENT,
        });
      } finally {
        fs.closeSync(fd);
        await handle.close();
      }
    });
  }

  it('a descriptor of the folder whose file was renamed out of the folder stays held', async () => {
    const fd = fs.openSync(meta, 'r+');
    const moved = path.join(outside, 'moved.json');
    fs.renameSync(meta, moved);
    try {
      const result = await gated(async (end) => { end(); return outcome(() => fs.writeSync(fd, 'X', 0)); });
      expect({ result, content: content(moved) }).toEqual({ result: 'refused', content: CONTENT });
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe('round 12, F10: reading opens and attributes', () => {
  const mode = () => fs.statSync(meta).mode;
  const mtime = () => fs.statSync(meta).mtimeMs;
  const PAST = new Date('2020-01-01T00:00:00Z');

  it('a descriptor opened for reading (foreground and ended context): fchmod, futimes, fchown refused after the end', async () => {
    const before = { mode: mode(), mtime: mtime() };
    const foreground = fs.openSync(meta, 'r');
    try {
      const result = await gated(async (end) => {
        const own = fs.openSync(meta, O_RDONLY);
        end();
        const r = {};
        for (const [name, fd] of [['foreground', foreground], ['own', own]]) {
          r[name] = {
            fchmod: await outcome(() => fs.fchmodSync(fd, 0o000)),
            futimes: await outcome(() => viaCallback((cb) => fs.futimes(fd, PAST, PAST, cb))),
            fchown: await outcome(() => fs.fchownSync(fd, process.getuid?.() ?? 0, process.getgid?.() ?? 0)),
          };
        }
        fs.closeSync(own);
        return r;
      });
      const refused = { fchmod: 'refused', futimes: 'refused', fchown: 'refused' };
      expect({ ...result, mode: mode(), mtime: mtime() }).toEqual({ foreground: refused, own: refused, ...before });
    } finally {
      fs.closeSync(foreground);
    }
  });

  it('a handle opened for reading: chmod, utimes, chown refused after the end; path chmod and utimes too', async () => {
    const before = { mode: mode(), mtime: mtime() };
    const handle = await fs.promises.open(meta, 'r');
    try {
      const result = await gated(async (end) => {
        end();
        return {
          chmod: await outcome(() => handle.chmod(0o000)),
          utimes: await outcome(() => handle.utimes(PAST, PAST)),
          chown: await outcome(() => handle.chown(process.getuid?.() ?? 0, process.getgid?.() ?? 0)),
          pathChmod: await outcome(() => fs.promises.chmod(meta, 0o000)),
          pathUtimes: await outcome(() => fs.utimesSync(meta, PAST, PAST)),
        };
      });
      expect({ ...result, mode: mode(), mtime: mtime() }).toEqual({ chmod: 'refused', utimes: 'refused', chown: 'refused', pathChmod: 'refused', pathUtimes: 'refused', ...before });
    } finally {
      await handle.close();
    }
  });

  it('controls: reading itself passes after the end; attributes of a file outside pass', async () => {
    const other = path.join(outside, 'log.txt');
    fs.writeFileSync(other, 'x');
    const result = await gated(async (end) => {
      end();
      const fd = fs.openSync(meta, 'r');
      const read = await outcome(() => fs.readSync(fd, Buffer.alloc(4), 0, 4, 0));
      fs.closeSync(fd);
      const out = fs.openSync(other, 'r');
      const attr = await outcome(() => { fs.fchmodSync(out, 0o644); fs.futimesSync(out, PAST, PAST); });
      fs.closeSync(out);
      return { read, attr };
    });
    expect(result).toEqual({ read: 'ok', attr: 'ok' });
  });
});
