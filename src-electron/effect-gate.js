'use strict';

/**
 * Effect gate of main (security review 10/2026, round 13, context contract).
 *
 * WHY: rounds 10 to 12 asked WHERE an effect lands (paths, aliases, descriptor
 * provenance). That class cannot be closed and the normal recording path paid
 * for it. Round 13 asks only IN WHICH CONTEXT an effect runs. This module knows
 * no path, no file identity and no folder.
 *
 * - Effect (R-S7.1): every call of the gated `fs` list (sync, callback,
 *   promise), FileHandle writes, opening with writing flags, `child_process`
 *   starts, `sendToRenderer`. No effect: reading, `close`, `fsync`, opening
 *   for reading.
 * - Refusal (R-S7.2): in the context of a session that ended every effect is
 *   refused, whatever its target, spelling, descriptor or origin: sync calls
 *   throw the scope's SessionEndedError, callback calls get it as their error,
 *   promise calls reject, a child process is never started.
 * - No extra work (R-S7.3): without a context and in a living session the call
 *   goes straight through: no extra system call, no entry per open.
 * - Binding (R-S7.4): the context is created only by `runInSession` (the
 *   scope's `gated()`). Listeners, queues and callbacks of the port chain that
 *   can fire from a foreign context bind with `bindSession` when registered.
 * - Way out (R-S7.5): the context objects are not exported; `.exit`,
 *   `.enterWith` and `.disable` exist only here. Exactly three ports leave the
 *   context, without a free path and without a caller's callback: `appLog`,
 *   `telemetry`, `authorityPersist` (see `sealPort`).
 * - Composed calls (R-S7.6): a Node operation admitted before the end runs to
 *   its end inside (open + write never leave a file half empty). Foreign code
 *   is never admitted: `cp` and non-binary data for `writeFile`/`appendFile`
 *   are refused in every session context, also a living one. Process starts
 *   ignore `admitted`.
 * - Temp (R-S7.7): a successful exclusive open in a context remembers the exact
 *   path string; after the end that allows exactly one unlink of exactly this
 *   string. Any other rest stays until a session of its owner clears it.
 * - Processes (R-S7.8): a running process is not killed; it only writes
 *   temporary files and its result is published only through the gate.
 */

const { AsyncLocalStorage, AsyncResource } = require('async_hooks');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { constants } = require('fs');

const publishGate = new AsyncLocalStorage();
const admitted = new AsyncLocalStorage();

/** Runs fn in the context of one session; gate.assertAlive throws once it ended. */
function runInSession(gate, fn) {
  return publishGate.run(gate, fn);
}

/** Throws the gate's SessionEndedError after the session of this context ended. */
function assertPublishAllowed() {
  const gate = publishGate.getStore();
  if (gate) gate.assertAlive();
}

/** The refusal of a gate (an error), or null. */
function refusalOf(gate) {
  try { gate.assertAlive(); return null; } catch (error) { return error; }
}

/**
 * R-S7.4: fn keeps the session context of its registration, whatever context
 * fires it. A refusal thrown inside goes to `fail` as an error when given (an
 * emitter has nobody to throw it to), else on to the caller (a promise chain).
 * Without a context: fn itself, nothing to bind.
 */
function bindSession(fn, fail = null) {
  if (!publishGate.getStore()) return fn;
  return AsyncResource.bind(function bound(...args) {
    try {
      return fn.apply(this, args);
    } catch (error) {
      if (!fail || !error || error.code !== 'SESSION_ENDED') throw error;
      fail(error);
      return undefined;
    }
  });
}

// R-S7.5: the closed list of ways out of a context.
const PORTS = new Set(['appLog', 'telemetry', 'authorityPersist']);

/**
 * One of the three ports: `body` runs outside every session context. A port
 * has a fixed destination and takes data only: a function as an argument is
 * refused (no caller's callback ever runs outside the context).
 */
function sealPort(name, body) {
  if (!PORTS.has(name)) throw new Error(`effect-gate: no port ${name}`);
  return (...args) => {
    if (args.some((arg) => typeof arg === 'function')) throw new Error(`effect-gate: port ${name} takes no callback`);
    return publishGate.exit(() => body(...args));
  };
}

// R-S7.1, callback and promise API alike.
const NAME_WRITES = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'truncate', 'symlink', 'link', 'utimes', 'lutimes', 'chmod', 'lchmod', 'chown', 'lchown'];
const FD_WRITES = ['write', 'writev', 'ftruncate', 'fchmod', 'futimes', 'fchown'];
const HANDLE_WRITES = ['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes'];
const WRITE_BITS = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND;

/** Does an open with these flags write (or create, or empty) the file? */
function writeFlags(flags) {
  if (typeof flags === 'number') return (flags & WRITE_BITS) !== 0;
  // open(path, callback) and open(path): read
  if (flags === undefined || flags === null || typeof flags === 'function') return false;
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return true;
}
const exclusiveFlags = (flags) => (typeof flags === 'number'
  ? (flags & constants.O_EXCL) !== 0 && (flags & constants.O_CREAT) !== 0
  : typeof flags === 'string' && flags.includes('x'));
const binary = (data) => typeof data === 'string' || ArrayBuffer.isView(data);

/** Is this call an effect at all? (Reading opens are not.) */
function isEffect(name, args) {
  if (name === 'open') return writeFlags(args[1]);
  if (name === 'readFile') return typeof args[1] === 'object' && args[1] !== null && writeFlags(args[1].flag);
  return true;
}
/** Would this call run code of its caller inside the call? (R-S7.6) */
function runsForeignCode(name, args) {
  if (name === 'cp') return true;
  return (name === 'writeFile' || name === 'appendFile') && !binary(args[1]);
}
const foreignCodeError = (name) => Object.assign(new Error(`effect-gate: ${name} would run foreign code inside a session context`), { code: 'EFFECT_REFUSED' });

// R-S7.7: gate -> the exact path strings of its exclusive opens.
const temps = new WeakMap();
function rememberTemp(gate, target) {
  if (typeof target !== 'string') return;
  if (!temps.has(gate)) temps.set(gate, new Set());
  temps.get(gate).add(target);
}
const forgetTemp = (gate, target) => { const own = temps.get(gate); return own ? own.delete(target) : false; };
const hasTemp = (gate, target) => { const own = temps.get(gate); return own ? own.has(target) : false; };

/** The error this call is refused with, or null: it goes on. */
function refusalFor(gate, name, args) {
  const error = refusalOf(gate);
  if (error) {
    // Exactly one unlink of exactly the string of an exclusive open.
    if (name === 'unlink' && forgetTemp(gate, args[0])) return null;
    return error;
  }
  return runsForeignCode(name, args) ? foreignCodeError(name) : null;
}
/** Book-keeping of the temp entries after a call of a context that succeeded. */
function settled(gate, name, args) {
  if (name === 'open' && exclusiveFlags(args[1])) rememberTemp(gate, args[0]);
  else if ((name === 'rename' || name === 'unlink') && hasTemp(gate, args[0])) forgetTemp(gate, args[0]);
}

const INSTALLED = Symbol.for('suisse.effectGate');

/**
 * Installs the gate on the `fs` and `child_process` modules (once per process).
 * @param {object} [opts]
 * @param {object} [opts.fs]
 * @param {object} [opts.childProcess]
 */
function installEffectGate({ fs = require('fs'), childProcess = require('child_process') } = {}) {
  if (fs[INSTALLED]) return false;
  Object.defineProperty(fs, INSTALLED, { value: true });

  function gateSync(name) {
    const base = name.slice(0, -4);
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function (...args) {
      const gate = publishGate.getStore();
      if (!gate || admitted.getStore() || !isEffect(base, args)) return original.apply(this, args);
      const error = refusalFor(gate, base, args);
      if (error) throw error;
      const result = admitted.run(true, () => original.apply(this, args));
      settled(gate, base, args);
      return result;
    };
  }

  function gateCallback(name) {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function (...args) {
      const gate = publishGate.getStore();
      const callback = args[args.length - 1];
      if (!gate || admitted.getStore() || typeof callback !== 'function' || !isEffect(name, args)) return original.apply(this, args);
      const error = refusalFor(gate, name, args);
      if (error) { process.nextTick(callback, error); return undefined; }
      args[args.length - 1] = function (...result) {
        if (!result[0]) settled(gate, name, args);
        return admitted.exit(() => callback.apply(this, result));
      };
      return admitted.run(true, () => original.apply(this, args));
    };
  }

  // The prototype of FileHandle is reachable only through a handle: taken from
  // the first one, once. After that an open is the direct call.
  let handlesGated = false;
  function gateHandles(proto) {
    for (const name of HANDLE_WRITES) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      proto[name] = function (...args) {
        const gate = publishGate.getStore();
        if (!gate || admitted.getStore()) return original.apply(this, args);
        const error = refusalOf(gate) || (runsForeignCode(name, [null, args[0]]) ? foreignCodeError(name) : null);
        if (error) return Promise.reject(error);
        return admitted.run(true, () => original.apply(this, args));
      };
    }
  }

  function gatePromise(name) {
    const original = fs.promises[name];
    if (typeof original !== 'function') return;
    fs.promises[name] = function (...args) {
      const gate = publishGate.getStore();
      let pending;
      if (!gate || admitted.getStore() || !isEffect(name, args)) {
        pending = original.apply(this, args);
      } else {
        const error = refusalFor(gate, name, args);
        if (error) return Promise.reject(error);
        pending = admitted.run(true, () => original.apply(this, args));
        if (name === 'open' ? exclusiveFlags(args[1]) : (name === 'rename' || name === 'unlink') && hasTemp(gate, args[0])) {
          const inner = pending;
          pending = inner.then((value) => { settled(gate, name, args); return value; });
        }
      }
      if (name !== 'open' || handlesGated) return pending;
      return pending.then((handle) => {
        if (!handlesGated) { handlesGated = true; gateHandles(Object.getPrototypeOf(handle)); }
        return handle;
      });
    };
  }

  for (const name of ['open', 'readFile', ...FD_WRITES, ...NAME_WRITES]) gateSync(`${name}Sync`);
  for (const name of ['open', 'readFile', ...FD_WRITES, ...NAME_WRITES]) gateCallback(name);
  for (const name of ['open', 'readFile', ...NAME_WRITES]) gatePromise(name);

  // --- child processes: no start after the session of this context ended ---
  function refusedChild(error, callback) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.exitCode = null;
    child.killed = false;
    child.kill = () => false;
    // It ends as a process that failed (exit code 1, the refusal on stderr),
    // not with an 'error' event: fluent-ffmpeg cannot take an 'error' event
    // of its child. Callback APIs get the refusal itself; the callers of the
    // recovery chain check the gate when a child fails (ffmpegWithTimeout,
    // encoded-opus-evidence), so the result is the scope's SESSION_ENDED.
    child.refusal = error;
    process.nextTick(() => {
      if (callback) callback(error, '', '');
      child.stderr.end(`${error.message}\n`);
      child.stdout.end();
      child.exitCode = 1;
      child.emit('exit', 1, null);
      child.emit('close', 1, null);
    });
    return child;
  }
  // R-S7.6: `admitted` plays no part here.
  const startRefusal = () => {
    const gate = publishGate.getStore();
    return gate ? refusalOf(gate) : null;
  };
  for (const name of ['spawn', 'execFile', 'exec', 'fork']) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    childProcess[name] = function (...args) {
      const error = startRefusal();
      if (error) return refusedChild(error, typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null);
      return original.apply(this, args);
    };
  }
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    childProcess[name] = function (...args) {
      const error = startRefusal();
      if (error) throw error;
      return original.apply(this, args);
    };
  }
  return true;
}

module.exports = { runInSession, assertPublishAllowed, bindSession, sealPort, installEffectGate };
