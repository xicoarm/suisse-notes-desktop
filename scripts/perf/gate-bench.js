#!/usr/bin/env node
'use strict';

// Measurement of the effect gate for one head (review round 13, P6): the same
// scenario, with the gate of the given head installed. Prints one JSON line.
//   node scripts/perf/gate-bench.js <path to effect-gate.js> <label> [--slow]
// --slow: every lstat, fstat, stat, readlink and realpath costs 2 ms of blocked
// main thread before the gate captures them (stand-in for a network or cloud
// folder; a head without such calls is not slowed down).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const [gatePath, label] = process.argv.slice(2);
const SLOW = process.argv.includes('--slow');
const ROUNDS = Number(process.env.GATE_BENCH_ROUNDS || 1500);

if (SLOW) {
  const block = (ms) => { const end = process.hrtime.bigint() + BigInt(ms) * 1000000n; while (process.hrtime.bigint() < end); };
  for (const name of ['lstatSync', 'fstatSync', 'statSync', 'readlinkSync', 'realpathSync']) {
    const real = fs[name];
    const slowed = function (...args) { block(2); return real.apply(this, args); };
    Object.assign(slowed, real);
    fs[name] = slowed;
  }
}

const gate = require(path.resolve(gatePath));
const counts = { lstat: 0, fstat: 0, stat: 0, readlink: 0, realpath: 0 };
for (const [name, key] of [['lstatSync', 'lstat'], ['fstatSync', 'fstat'], ['statSync', 'stat'], ['readlinkSync', 'readlink'], ['realpathSync', 'realpath']]) {
  const real = fs[name];
  const counted = function (...args) { counts[key]++; return real.apply(this, args); };
  Object.assign(counted, real);
  fs[name] = counted;
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bench-'));
const deep = path.join(base, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'Recordings', 'c1');
fs.mkdirSync(deep, { recursive: true });
gate.installEffectGate({ roots: () => [path.join(base, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'Recordings')] });

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const summary = (values) => {
  const sorted = [...values].sort((x, y) => x - y);
  return { p50_us: Number(percentile(sorted, 0.5).toFixed(1)), p99_us: Number(percentile(sorted, 0.99).toFixed(1)), max_us: Number(sorted[sorted.length - 1].toFixed(1)) };
};
const now = () => Number(process.hrtime.bigint()) / 1000;

async function scenario(name, run) {
  const opens = [];
  const monitor = monitorEventLoopDelay({ resolution: 1 });
  monitor.enable();
  const before = { ...counts };
  for (let i = 0; i < ROUNDS; i++) {
    const file = path.join(deep, `f${i % 50}.bin`);
    const start = now();
    await run(file);
    opens.push(now() - start);
    // The event loop turns between two opens, as in the app.
    if (i % 5 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  monitor.disable();
  const calls = {};
  for (const key of Object.keys(counts)) calls[key] = (counts[key] - before[key]) / ROUNDS;
  return {
    name,
    open: summary(opens),
    loop_p50_ms: Number((monitor.percentile(50) / 1e6).toFixed(3)),
    loop_p99_ms: Number((monitor.percentile(99) / 1e6).toFixed(3)),
    calls_per_open: calls,
  };
}

const SCENARIOS = {
  sync_write: (file) => { const fd = fs.openSync(file, 'w'); fs.writeSync(fd, 'x'); fs.closeSync(fd); },
  sync_read: (file) => { fs.closeSync(fs.openSync(file, 'a')); fs.closeSync(fs.openSync(file, 'r')); },
  callback_write: (file) => new Promise((resolve, reject) => fs.open(file, 'w', (error, fd) => { if (error) reject(error); else { fs.closeSync(fd); resolve(); } })),
  promise_write: async (file) => { const handle = await fs.promises.open(file, 'w'); await handle.close(); },
};

(async () => {
  const results = [];
  for (const [name, run] of Object.entries(SCENARIOS)) results.push(await scenario(name, run));
  fs.rmSync(base, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ label, platform: process.platform, arch: process.arch, slow: SLOW, rounds: ROUNDS, results })}\n`);
})();
