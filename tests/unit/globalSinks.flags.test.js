// @vitest-environment node
import { sinks } from './support/globalSinks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The oracle of the sweep (support/globalSinks.js) counts what really
// changes a file of the recordings folder (review round 11, F7): numeric
// open flags (O_TRUNC empties the file at the open, O_CREAT creates it),
// readFile with a writing flag, writes through an alias of the folder, and
// descriptors opened before the oracle was bound. It classifies on its own
// (not with the gate's function): a shared blind spot would hide itself.

const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
let base;
let root;
let meta;
let rec;
const counted = () => rec.effects.map((e) => `${e.kind}:${path.relative(root, e.target).split(path.sep).join('/')}`);

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sinks-flags-'));
  root = path.join(base, 'Recordings');
  fs.mkdirSync(path.join(root, 'c1'), { recursive: true });
  meta = path.join(root, 'c1', 'metadata.json');
  fs.writeFileSync(meta, '{}');
  rec = {
    root, media: 'stub', effects: [],
    effect(kind, target) { this.effects.push({ kind, target }); },
    after: (l, p) => p, waitThen: (l, fn) => setImmediate(fn), busy: () => false, spawn() {}, stream() {}, emulate: () => ({}),
  };
});
afterEach(() => {
  sinks.unbind(rec);
  fs.rmSync(base, { recursive: true, force: true });
});
const bound = (fn) => { sinks.bind(rec); try { return fn(); } finally { sinks.unbind(rec); } };

describe('F7: the oracle counts numeric writing opens', () => {
  for (const [name, flags] of Object.entries({ 'O_WRONLY|O_TRUNC': O_WRONLY | O_TRUNC, O_RDWR, 'O_WRONLY|O_APPEND': O_WRONLY | O_APPEND, 'O_RDONLY|O_TRUNC': O_RDONLY | O_TRUNC })) {
    it(`openSync(metadata.json, ${name}) is an effect`, () => {
      // Counted before the system call; Windows refuses O_TRUNC without
      // O_CREAT (EINVAL), the attempt is still an effect.
      bound(() => { try { fs.closeSync(fs.openSync(meta, flags)); } catch (error) { if (error.code !== 'EINVAL') throw error; } });
      expect(counted()).toContain('open:c1/metadata.json');
    });
  }

  it('O_WRONLY|O_CREAT of a new file is an effect (sync, callback, promise)', async () => {
    sinks.bind(rec);
    fs.closeSync(fs.openSync(path.join(root, 'c1', 'a.txt'), O_WRONLY | O_CREAT));
    await new Promise((done, fail) => fs.open(path.join(root, 'c1', 'b.txt'), O_WRONLY | O_CREAT, (e, fd) => (e ? fail(e) : (fs.closeSync(fd), done()))));
    await (await fs.promises.open(path.join(root, 'c1', 'c.txt'), O_RDWR | O_CREAT)).close();
    sinks.unbind(rec);
    expect(counted()).toEqual(expect.arrayContaining(['open:c1/a.txt', 'open:c1/b.txt', 'open:c1/c.txt']));
  });

  it('readFile with a writing flag is an effect', async () => {
    sinks.bind(rec);
    fs.readFileSync(meta, { flag: 'r+' });
    await fs.promises.readFile(meta, { flag: O_RDWR });
    sinks.unbind(rec);
    expect(counted().filter((e) => e === 'open:c1/metadata.json')).toHaveLength(2);
  });

  it('controls: reading opens are no effect', async () => {
    sinks.bind(rec);
    fs.closeSync(fs.openSync(meta, O_RDONLY));
    fs.closeSync(fs.openSync(meta, 'r'));
    fs.readFileSync(meta);
    await new Promise((done) => fs.open(meta, (e, fd) => { fs.closeSync(fd); done(); }));
    sinks.unbind(rec);
    expect(counted()).toEqual([]);
  });
});

describe('the oracle sees aliases and earlier descriptors', () => {
  it('a write through a symlink (junction) into the folder is an effect', (ctx) => {
    const alias = path.join(base, 'alias');
    try { fs.symlinkSync(path.join(root, 'c1'), alias, 'junction'); } catch { return ctx.skip(); }
    bound(() => fs.writeFileSync(path.join(alias, 'metadata.json'), 'X'));
    expect(counted()).toEqual(['write:c1/metadata.json']);
  });

  it('a write to a descriptor opened before the oracle was bound is an effect', () => {
    const fd = fs.openSync(meta, 'r+');
    try {
      bound(() => fs.writeSync(fd, 'X', 0));
    } finally {
      fs.closeSync(fd);
    }
    expect(counted()).toEqual(['write:c1/metadata.json']);
  });
});

// Review round 12: the oracle reads a path as the system does (its own
// resolution: the system's realpath of the raw path), holds what an open
// found, and counts attributes; independent of the gate's resolution.
describe('round 12: where a call really lands', () => {
  const link = (target, at, type) => { try { fs.symlinkSync(target, at, type); return at; } catch { return null; } };

  it.skipIf(process.platform === 'win32')('F8: a write through a symlink plus «..» is an effect on the folder', (ctx) => {
    fs.mkdirSync(path.join(root, 'c1', 'sub'));
    const at = link(path.join(root, 'c1', 'sub'), path.join(base, 'link'), 'dir');
    if (!at) return ctx.skip();
    bound(() => fs.writeFileSync([at, '..', 'metadata.json'].join(path.sep), 'X'));
    expect(counted()).toEqual(['write:c1/metadata.json']);
  });

  it('F8: a write through a chain of links and to a dangling link into the folder is an effect', (ctx) => {
    const second = link(path.join(root, 'c1'), path.join(base, 'l2'), 'dir');
    const first = second && link('l2', path.join(base, 'l1'), 'dir');
    const hang = link(path.join(root, 'c1', 'later.json'), path.join(base, 'hang'), 'file');
    if (!first || !hang) return ctx.skip();
    bound(() => { fs.writeFileSync(path.join(first, 'metadata.json'), 'X'); fs.writeFileSync(hang, 'X'); });
    expect(counted()).toEqual(['write:c1/metadata.json', 'write:c1/later.json']);
  });

  it('F8: a write through a hard link to a file of the folder is an effect; removing the link is not', (ctx) => {
    const hard = path.join(base, 'hard.json');
    try { fs.linkSync(meta, hard); } catch { return ctx.skip(); }
    bound(() => { fs.writeFileSync(hard, 'X'); fs.unlinkSync(hard); });
    expect(counted()).toEqual(['write:c1/metadata.json']);
  });

  it('F9: a descriptor and a handle opened through a link, the link then removed: their writes are effects', async (ctx) => {
    const alias = link(meta, path.join(base, 'meta-link.json'), 'file');
    if (!alias) return ctx.skip();
    const fd = fs.openSync(alias, 'r+');
    const handle = await fs.promises.open(alias, 'r+');
    fs.unlinkSync(alias);
    sinks.bind(rec);
    fs.writeSync(fd, 'X', 0);
    await handle.write('Y', 0);
    await fs.promises.writeFile(handle, 'Z');
    sinks.unbind(rec);
    fs.closeSync(fd);
    await handle.close();
    expect(counted()).toEqual(['write:c1/metadata.json', 'write:c1/metadata.json', 'write:c1/metadata.json']);
  });

  it('F10: attributes through a descriptor or handle opened for reading are effects', async () => {
    const fd = fs.openSync(meta, 'r');
    const handle = await fs.promises.open(meta, 'r');
    // Counted before the call; Windows refuses times on a reading descriptor (EPERM).
    const attempt = async (call) => { try { await call(); } catch (error) { if (error.code !== 'EPERM') throw error; } };
    sinks.bind(rec);
    try {
      await attempt(() => fs.fchmodSync(fd, 0o644));
      await attempt(() => fs.futimesSync(fd, new Date(), new Date()));
      await attempt(() => handle.chmod(0o644));
      await attempt(() => handle.utimes(new Date(), new Date()));
    } finally {
      sinks.unbind(rec);
    }
    fs.closeSync(fd);
    await handle.close();
    expect(counted()).toEqual(['attr:c1/metadata.json', 'attr:c1/metadata.json', 'attr:c1/metadata.json', 'attr:c1/metadata.json']);
  });

  it('controls: a link outside plus «..» back outside, and reading through a link into the folder, are no effect', (ctx) => {
    fs.mkdirSync(path.join(base, 'logs'));
    const at = link(path.join(base, 'logs'), path.join(base, 'logdir'), 'dir');
    const alias = link(path.join(root, 'c1'), path.join(base, 'alias'), 'dir');
    if (!at || !alias) return ctx.skip();
    bound(() => {
      fs.writeFileSync([at, '..', 'logs', 'app.log'].join(path.sep), 'x');
      fs.readFileSync(path.join(alias, 'metadata.json'));
      fs.closeSync(fs.openSync(path.join(alias, 'metadata.json'), 'r'));
    });
    expect(counted()).toEqual([]);
  });
});
