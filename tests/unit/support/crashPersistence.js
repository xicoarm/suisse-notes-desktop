// Crash snapshots at storage operations (security review 10/2026 round 6, R5).
//
// All persistent stores of one app instance live in `state`. Every write or
// delete is an operation `op(name, effect)`. `crashAt(op, n, 'vor'|'nach')`
// takes a snapshot of all stores right before / right after the n-th
// operation of that name; from then on the instance is dead: every further
// operation (read, write, delete) is refused with a Crash and changes
// nothing. A restart builds new modules and instances on the snapshot.
// `faultAt(op, n)` instead lets the n-th operation fail (throws a Fault,
// changes nothing) and the instance lives on.

export class Crash extends Error {
  constructor(message) {
    super(message);
    this.name = 'Crash';
  }
}

export class Fault extends Error {
  constructor(message) {
    super(message);
    this.name = 'Fault';
  }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function createCrashPersistence(initial = {}) {
  const state = clone(initial) || {};
  const counts = {};
  const ops = [];
  let plan = null;
  let dead = false;
  let snapshot = null;

  const alive = () => {
    if (dead) throw new Crash('instance is dead');
  };

  function die(label) {
    snapshot = clone(state);
    dead = true;
    throw new Crash(`crash ${label}`);
  }

  function op(name, effect) {
    alive();
    counts[name] = (counts[name] || 0) + 1;
    const n = counts[name];
    ops.push({ op: name, n });
    const hit = !!plan && plan.op === name && plan.n === n;
    if (hit && plan.when === 'fault') throw new Fault(`fault ${name}#${n}`);
    if (hit && plan.when === 'vor') die(`before ${name}#${n}`);
    const result = effect();
    if (hit && plan.when === 'nach') die(`after ${name}#${n}`);
    return result;
  }

  function read(fn) {
    alive();
    return fn();
  }

  /** A key-value store (electron-store / keystore / Preferences shape) named `name`. */
  function kv(name) {
    if (!state[name]) state[name] = {};
    return {
      get: (k, d) => read(() => (Object.prototype.hasOwnProperty.call(state[name], k) ? clone(state[name][k]) : d)),
      set: (k, v) => op(`${name}.set`, () => { state[name][k] = clone(v); }),
      delete: (k) => op(`${name}.delete`, () => { delete state[name][k]; })
    };
  }

  /** localStorage with the Storage interface on top of kv(name). */
  function webStorage(name) {
    const store = kv(name);
    return {
      getItem: (k) => { const v = store.get(k); return v === undefined ? null : v; },
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => { for (const k of Object.keys(state[name])) store.delete(k); }
    };
  }

  return {
    state,
    ops,
    op,
    read,
    kv,
    webStorage,
    crashAt(name, n, when) {
      if (when !== 'vor' && when !== 'nach') throw new Error('when: vor | nach');
      plan = { op: name, n, when };
    },
    faultAt(name, n) {
      plan = { op: name, n, when: 'fault' };
    },
    get dead() { return dead; },
    snapshot: () => snapshot
  };
}
