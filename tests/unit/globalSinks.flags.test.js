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
