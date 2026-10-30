// @vitest-environment node
import { sinks } from './support/globalSinks.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The oracle of the sweep (support/globalSinks.js) counts what really
// changes a file of the recordings folder (review round 11, F7): numeric
// open flags (O_TRUNC empties the file at the open, O_CREAT creates it),
// readFile with a writing flag and descriptors opened before the oracle was
// bound. It classifies on its own (not with the gate's function): a shared
// blind spot would hide itself.

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
    effect(kind, target, extra = {}) { this.effects.push({ kind, target, ...extra }); },
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

// Round 13: the oracle counts every effect, whatever its target, and code of
// the caller inside a call is no part of that call.
describe('round 13: every effect counts, wherever it lands', () => {
  const kinds = () => rec.effects.map((e) => e.kind);

  it('a write outside the recordings folder is an effect', () => {
    bound(() => fs.writeFileSync(path.join(base, 'app.log'), 'x'));
    expect(kinds()).toEqual(['write']);
  });

  it('a write to a descriptor opened before the oracle was bound is an effect', () => {
    const fd = fs.openSync(meta, 'r+');
    try { bound(() => fs.writeSync(fd, 'X', 0)); } finally { fs.closeSync(fd); }
    expect(counted()).toEqual(['write:c1/metadata.json']);
  });

  it('a write with a Buffer path, attributes through a reading handle: effects', async () => {
    const handle = await fs.promises.open(meta, 'r');
    sinks.bind(rec);
    fs.writeFileSync(Buffer.from(meta), 'X');
    try { await handle.chmod(0o644); } catch (error) { if (error.code !== 'EPERM') throw error; }
    sinks.unbind(rec);
    await handle.close();
    expect(kinds()).toEqual(['write', 'attr']);
  });

  it('what a cp filter does is counted on its own (the call does not hide it)', async () => {
    const src = path.join(base, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.txt'), 'a');
    const note = path.join(base, 'filter-note.txt');
    sinks.bind(rec);
    await fs.promises.cp(src, path.join(base, 'dst'), { recursive: true, filter: async () => { fs.writeFileSync(note, 'x'); return true; } });
    sinks.unbind(rec);
    expect(rec.effects.filter((e) => e.target === note).length).toBeGreaterThan(0);
  });

  it('what an iterable does while it is written is counted on its own', async () => {
    const note = path.join(base, 'iterable-note.txt');
    async function* data() { fs.writeFileSync(note, 'x'); yield 'a'; }
    sinks.bind(rec);
    await fs.promises.writeFile(path.join(base, 'out.txt'), data());
    sinks.unbind(rec);
    expect(rec.effects.some((e) => e.target === note)).toBe(true);
  });

  it('removing a temp file: only the removal an exclusive open earned is marked own, once, by its exact string', () => {
    const temp = path.join(base, 'x.tmp');
    const pattern = path.join(base, 'y.3f0c2a52-7d1e-4c4b-9a7e-2b1d5f6a8c90.tmp');
    fs.writeFileSync(pattern, 'p');
    bound(() => {
      fs.closeSync(fs.openSync(temp, 'wx'));
      fs.unlinkSync(temp);
      fs.closeSync(fs.openSync(temp, 'w'));
      fs.unlinkSync(temp);
      fs.unlinkSync(pattern);
    });
    expect(rec.effects.filter((e) => e.kind === 'unlink').map((e) => !!e.own)).toEqual([true, false, false]);
  });
});
