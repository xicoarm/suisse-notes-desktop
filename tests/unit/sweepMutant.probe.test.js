// @vitest-environment node
import { it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { baseline, sweptRun } from './support/sweep.js';
import { NAMED, chainEntry, makeNativeTemplate, removeNativeTemplate } from './support/chainEntries.js';
import { MUTANTS } from './support/mutants.js';

// The probe of the mutation test (review round 10, F4): runs the named
// points of one mutant (SWEEP_MUTANT, applied at load by globalSinks.js) and
// writes the violations to SWEEP_PROBE_OUT. Started only by
// sweepMutation.main.test.js in a child process of its own; skipped in a
// normal run.

const out = process.env.SWEEP_PROBE_OUT;
const mutant = MUTANTS[process.env.SWEEP_MUTANT || 'control'];
const keys = mutant && (mutant.cases === 'all' ? Object.keys(NAMED) : mutant.cases);
const native = !!keys && keys.some((key) => NAMED[key][1].includes('native'));

beforeAll(async () => { if (out && native) await makeNativeTemplate(); }, 60000);
afterAll(() => { if (out && native) removeNativeTemplate(); });

it.skipIf(!out)('sweep probe of one mutant', async () => {
  const result = { mutant: process.env.SWEEP_MUTANT || 'control', cases: {}, baselines: {} };
  for (const key of keys) {
    const [, name, point] = NAMED[key];
    const entry = chainEntry(name);
    if (!result.baselines[name]) {
      const base = await baseline(entry);
      result.baselines[name] = { result: base.result, effects: base.shape.effects, sent: base.shape.sent, spawns: base.spawns };
    }
    result.cases[key] = [];
    for (const variant of ['A', 'B']) result.cases[key].push(...await sweptRun(entry, point, variant));
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
}, 300000);
