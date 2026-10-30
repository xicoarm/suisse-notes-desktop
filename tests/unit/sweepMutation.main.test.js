// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MUTANTS, KIND_PATTERN } from './support/mutants.js';

// Mutation test of the sinks (review round 10, F4): each mutant of
// support/mutants.js runs the sweep probe (sweepMutant.probe.test.js) in a
// child process of its own - the mutant is applied when src-electron is
// loaded, so it is the code the sweep runs. Every sink kind (fs, child
// process, renderer event) has a «sink off» and a «bypass» mutant; each must
// turn the sweep red with a violation of its kind. The controls (unmutated,
// and the new paths through their sinks) must stay green, and the new paths
// must really run in the baseline (otherwise the bypass mutants would prove
// nothing).

const VITEST = path.resolve('node_modules/vitest/vitest.mjs');
const PROBE = 'tests/unit/sweepMutant.probe.test.js';

function probe(name) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-mutant-')), 'result.json');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST, 'run', PROBE, '--maxWorkers=1', '--minWorkers=1'], {
      env: { ...process.env, SWEEP_MUTANT: name, SWEEP_PROBE_OUT: out },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('close', (code) => {
      const result = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
      fs.rmSync(path.dirname(out), { recursive: true, force: true });
      resolve({ code, result, log: log.slice(-4000) });
    });
  });
}

const all = (result) => Object.values(result.cases).flat();
// Three probes at a time, all started at once.
const runs = {};
let active = 0;
const waiting = [];
const next = () => {
  while (active < 3 && waiting.length) {
    const [name, done] = waiting.shift();
    active++;
    probe(name).then((value) => { active--; done(value); next(); });
  }
};
for (const name of Object.keys(MUTANTS)) runs[name] = new Promise((done) => { waiting.push([name, done]); });
next();
const run = (name) => runs[name];

describe('mutants of the sinks: the sweep turns red', () => {
  it('control: the unmutated chain passes every named point', async () => {
    const { result, log } = await run('control');
    expect(result, log).not.toBeNull();
    expect(all(result)).toEqual([]);
  }, 600000);

  it('control: the new paths through their sinks pass, and they run in the baseline', async () => {
    const { result, log } = await run('paths-through-sinks');
    expect(result, log).not.toBeNull();
    expect(all(result)).toEqual([]);
    const base = result.baselines['recovery, real chain with the system audio merge'];
    expect(base.effects).toContain('write:c1/merge-note.txt');
    expect(base.spawns.some((s) => /ffprobe -version/.test(s))).toBe(true);
    expect(base.sent).toContain('system:capture-warning');
  }, 600000);

  for (const [name, mutant] of Object.entries(MUTANTS).filter(([, m]) => m.kind)) {
    it(`${name}: red with a violation of kind ${mutant.kind}`, async () => {
      const { result, log } = await run(name);
      expect(result, log).not.toBeNull();
      const violations = all(result);
      // eslint-disable-next-line no-console
      console.log(`[sweep:mutant] ${name}: ${violations.length} violations\n  ${violations.slice(0, 4).join('\n  ')}`);
      expect(violations.some((v) => KIND_PATTERN[mutant.kind].test(v)), `${name}: ${JSON.stringify(violations.slice(0, 6))}`).toBe(true);
    }, 600000);
  }
});
