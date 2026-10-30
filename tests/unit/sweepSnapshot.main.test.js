// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot, contentAfter } from './support/sweep.js';
import { createBackgroundRig } from './support/backgroundRig.js';

// Round 14 (F16, R-S7.7): the snapshot hides no file by its name. A foreign file
// named like a durable write's temp, or like the scratch of native finalization,
// is compared like any other, in the recordings folder and in the external canary
// folder. Exempt is only what the run proved: the exact path of an exclusive open,
// the exact folder of a mkdtemp while a process running at the change names it.

const UUID = '3f0c2a52-7d1e-4c4b-9a7e-2b1d5f6a8c90';
const TEMP_NAME = `victim.json.${UUID}.tmp`;
const OLD = new Date('2020-01-01T00:00:00Z');

let r;
afterEach(async () => { await r.cleanup(); });

/** A fixture file, the snapshot at the change, the file after `act`. */
function report({ folder, name, act, prepare = () => {} }) {
  r = createBackgroundRig();
  const dir = folder === 'canary' ? r.canary : path.join(r.root, 'r1');
  const file = path.join(dir, name);
  r.quietly(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'before'); });
  prepare(file);
  const before = snapshot(r);
  r.quietly(() => act(file));
  return contentAfter(r, before, 'probe').join('\n');
}

const change = (file) => fs.writeFileSync(file, 'after');
const attributes = (file) => fs.utimesSync(file, OLD, OLD);

describe.each(['root', 'canary'])('a foreign file, %s folder', (folder) => {
  it('a changed foreign temp name is reported, under its real name', () => {
    const list = report({ folder, name: TEMP_NAME, act: change });
    expect(list).toContain('content changed after the change');
    expect(list).toContain(TEMP_NAME);
  });

  it('changed attributes of a foreign temp name are reported', () => {
    expect(report({ folder, name: TEMP_NAME, act: attributes })).toContain('attributes changed after the change');
  });

  it('a new file with a temp name is reported', () => {
    const made = `new.json.${UUID}.tmp`;
    expect(report({ folder, name: 'other.json', act: (file) => fs.writeFileSync(path.join(path.dirname(file), made), 'x') })).toContain(made);
  });

  it('a file named like the scratch of finalization is reported', () => {
    expect(report({ folder, name: path.join('native-finalization-abc', 'rendered.webm'), act: change })).toContain('content changed after the change');
  });
});

describe('what the run proved, and only that', () => {
  it('control: the exact path of an exclusive open may change', () => {
    r = createBackgroundRig();
    const temp = path.join(r.root, 'r1', `data.json.${UUID}.tmp`);
    fs.closeSync(fs.openSync(temp, 'wx'));
    const before = snapshot(r);
    r.quietly(() => fs.writeFileSync(temp, 'still being written'));
    expect(contentAfter(r, before, 'probe')).toEqual([]);
  });

  it('control: a file an exclusive open created after the change is its own (the gate decides on the open)', () => {
    r = createBackgroundRig();
    const before = snapshot(r);
    fs.closeSync(fs.openSync(path.join(r.root, 'r1', 'late.tmp'), 'wx'));
    expect(contentAfter(r, before, 'probe')).toEqual([]);
  });

  it('the proof is for the exact string: the same name beside it stays foreign', () => {
    r = createBackgroundRig();
    const dir = path.join(r.root, 'r1');
    fs.closeSync(fs.openSync(path.join(dir, TEMP_NAME), 'wx'));
    r.quietly(() => { fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', TEMP_NAME), 'before'); });
    const before = snapshot(r);
    r.quietly(() => fs.writeFileSync(path.join(dir, 'sub', TEMP_NAME), 'after'));
    expect(contentAfter(r, before, 'probe').join()).toContain(`r1/sub/${TEMP_NAME}`);
  });

  it('a failed exclusive open proves nothing', () => {
    r = createBackgroundRig();
    const temp = path.join(r.root, 'r1', TEMP_NAME);
    r.quietly(() => fs.writeFileSync(temp, 'before'));
    expect(() => fs.openSync(temp, 'wx')).toThrow(/EEXIST/);
    const before = snapshot(r);
    r.quietly(() => change(temp));
    expect(contentAfter(r, before, 'probe').join()).toContain(TEMP_NAME);
  });

  it('an open that is not exclusive proves nothing', () => {
    r = createBackgroundRig();
    const temp = path.join(r.root, 'r1', TEMP_NAME);
    fs.closeSync(fs.openSync(temp, 'w'));
    const before = snapshot(r);
    r.quietly(() => change(temp));
    expect(contentAfter(r, before, 'probe').join()).toContain(TEMP_NAME);
  });

  it('what an exclusive temp was published to is no temp', () => {
    r = createBackgroundRig();
    const dir = path.join(r.root, 'r1');
    const temp = path.join(dir, TEMP_NAME);
    fs.closeSync(fs.openSync(temp, 'wx'));
    fs.renameSync(temp, path.join(dir, 'victim.json'));
    const before = snapshot(r);
    r.quietly(() => change(path.join(dir, 'victim.json')));
    expect(contentAfter(r, before, 'probe').join()).toContain('r1/victim.json');
  });

  describe('scratch', () => {
    const scratchCase = async ({ running }) => {
      r = createBackgroundRig({ media: 'real' });
      const dir = await fs.promises.mkdtemp(path.join(r.root, 'r1', 'native-finalization-'));
      const output = path.join(dir, 'rendered.txt');
      if (running) r.running.add({ args: ['-y', running === 'names' ? output : path.join(os.tmpdir(), 'other')] });
      const before = snapshot(r);
      r.quietly(() => fs.writeFileSync(output, 'written by the process'));
      return { dir, list: contentAfter(r, before, 'probe').join() };
    };
    it('control: a process running at the change writes into the folder it names', async () => {
      expect((await scratchCase({ running: 'names' })).list).toBe('');
    });
    it('no process at the change: a write into the scratch is reported', async () => {
      expect((await scratchCase({ running: null })).list).toContain('rendered.txt');
    });
    it('a process that names another folder proves nothing', async () => {
      expect((await scratchCase({ running: 'other' })).list).toContain('rendered.txt');
    });
    it('a folder of the same name no mkdtemp of this run returned proves nothing', () => {
      r = createBackgroundRig();
      const dir = path.join(r.root, 'r1', 'native-finalization-foreign');
      r.quietly(() => fs.mkdirSync(dir));
      r.running.add({ args: [path.join(dir, 'rendered.webm')] });
      const before = snapshot(r);
      r.quietly(() => fs.writeFileSync(path.join(dir, 'rendered.webm'), 'x'));
      expect(contentAfter(r, before, 'probe').join()).toContain('rendered.webm');
    });
  });
});
