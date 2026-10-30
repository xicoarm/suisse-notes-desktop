'use strict';

// Measurement probe of main (review round 13, P7), put in front of main's source
// by the measurement workflow only, the same on every head: event-loop delay and
// open latency of the running app, written every two seconds and at the exit.
// The open wrappers go on one turn later, above the gate of that head.

const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const out = path.join(process.env.GATE_PROBE_DIR, `main-${process.pid}.json`);
const writeFileSync = fs.writeFileSync;
const monitor = monitorEventLoopDelay({ resolution: 5 });
monitor.enable();
const opens = [];
const now = () => Number(process.hrtime.bigint()) / 1000;
const note = (start) => { if (opens.length < 200000) opens.push(now() - start); };

setImmediate(() => {
  const openSync = fs.openSync;
  fs.openSync = function (...args) { const start = now(); try { return openSync.apply(this, args); } finally { note(start); } };
  const open = fs.open;
  fs.open = function (...args) {
    const callback = args[args.length - 1];
    if (typeof callback !== 'function') return open.apply(this, args);
    const start = now();
    args[args.length - 1] = function (...result) { note(start); return callback.apply(this, result); };
    return open.apply(this, args);
  };
  const promiseOpen = fs.promises.open;
  fs.promises.open = function (...args) { const start = now(); return promiseOpen.apply(this, args).finally(() => note(start)); };
});

function flush() {
  const sorted = [...opens].sort((a, b) => a - b);
  const at = (p) => (sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1)) : null);
  writeFileSync(out, JSON.stringify({
    loop_p50_ms: Number((monitor.percentile(50) / 1e6).toFixed(3)),
    loop_p99_ms: Number((monitor.percentile(99) / 1e6).toFixed(3)),
    loop_max_ms: Number((monitor.max / 1e6).toFixed(3)),
    opens: sorted.length, open_p50_us: at(0.5), open_p99_us: at(0.99), open_max_us: at(1),
  }));
}
setInterval(flush, 2000).unref();
process.on('exit', flush);
