// The sweep of rounds 9 and 10 (council 3, required test 2), shared by the
// sweep tests and the mutation probe (support/sweepProbe.js runs it in a
// child process): at the N-th suspension point the session changes, (a)
// sign-out, (b) sign-out and sign-in B. Expected after the change: no
// request, no write, no event, no timer, no child process; the queue
// byte-identical; the result `sessionEnded`; B's registrations intact; after
// owner A signs in again exactly one resumption. Control: a refresh of the
// same session at point N changes nothing. No test framework in here.

import fs from 'node:fs';
import path from 'node:path';
import { createBackgroundRig, flush } from './backgroundRig.js';

export const ended = (res) => res?.sessionEnded === true;
// Own unpublished temp files of an interrupted durable write may be removed.
export const TEMP = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
export const notTemp = (effects) => effects.filter((e) => !(e.kind === 'unlink' && TEMP.test(e.target)));

/**
 * Waits until the background work is quiet: no call in flight and no new
 * suspension point, effect or request over three rounds (a fixed number of
 * flushes was too short under load: the re-scan's late points were missed).
 */
export async function quiet(entry, r) {
  const mark = () => (r ? `${r.points.length}/${r.effects.length}/${r.requests.length}/${r.spawns.length}` : '');
  let last = null;
  let stable = 0;
  for (let round = 0; round < 200 && stable < 3; round++) {
    for (let i = 0; i < 20; i++) await flush();
    await new Promise((res) => setTimeout(res, entry.slow ? 60 : 5));
    const now = mark();
    stable = now === last && !(r && r.inflight()) ? stable + 1 : 0;
    last = now;
  }
}

export async function makeRig(entry, extra = {}) {
  const r = createBackgroundRig({ ...(entry.opts || {}), ...extra });
  if (entry.prepare) await entry.prepare(r);
  r.hooks.onTimer = (ms) => { if (r.timerHook) r.timerHook(ms); };
  return r;
}

/** Effects as a comparable multiset (temp names and scratch folders without their random part). */
const where = (r, target) => (path.isAbsolute(target) ? path.relative(r.root, target) : target)
  .replace(TEMP, '.tmp').replace(/native-finalization-[^/\\]*/, 'native-finalization-X').replace(/source-chunks([/\\])\d+/, 'source-chunks$1N').replace(/\\/g, '/');
export const shape = (r) => ({
  effects: r.effects.map((e) => `${e.kind}:${where(r, e.target)}`).sort(),
  requests: r.requests.map((q) => `${q.method} ${q.url.replace(/^https?:\/\/[^/]+/, '')}`).sort(),
  sent: r.sent.map((e) => e.channel).sort(),
});

export async function baseline(entry, extra) {
  const r = await makeRig(entry, extra);
  try {
    const scope = r.scopes.open();
    const result = await entry.run(r, scope);
    await quiet(entry, r);
    return { result, max: r.points.length, shape: shape(r), labels: [...r.points], spawns: r.spawns.map((x) => x.port || `${x.file} ${(x.args || []).join(' ')}`) };
  } finally {
    await r.cleanup();
  }
}

/** Every violation of the rules after the change, from the counters of the rig. */
export function afterChange(r, label) {
  const out = [];
  const effects = notTemp(r.effectsAfter());
  if (effects.length) out.push(`${label}: effects after the change: ${JSON.stringify(effects.map((e) => `${e.kind}:${where(r, e.target)}`))}`);
  if (r.requestsAfter().length) out.push(`${label}: requests after the change: ${JSON.stringify(r.requestsAfter().map((q) => q.url))}`);
  if (r.sentAfter().length) out.push(`${label}: events after the change: ${JSON.stringify(r.sentAfter().map((e) => e.channel))}`);
  if (r.spawnsAfter().length) out.push(`${label}: child processes after the change: ${JSON.stringify(r.spawnsAfter().map((s) => s.port || `${s.file} ${s.args.slice(0, 6).join(' ')}`))}`);
  const timersAfter = r.sleeps.filter((s) => s.after);
  if (timersAfter.length) out.push(`${label}: timers after the change: ${JSON.stringify(timersAfter)}`);
  if (JSON.stringify(r.stores.queue.data) !== r.sweep.queueAtChange) out.push(`${label}: queue changed after the change`);
  return out;
}

// Scratch folders of native finalization: a child process already running at
// the change may still write there (council 3: temporary files only).
const SCRATCH = /(^|[/\\])native-finalization-[^/\\]*([/\\]|$)/;

/** Every file of the recordings root: its bytes, mode and mtime (read past the counters). */
export function snapshot(r) {
  const files = new Map();
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) {
        const st = fs.statSync(p);
        files.set(p, { bytes: fs.readFileSync(p), attrs: `${st.mode.toString(8)} ${st.mtimeMs}` });
      }
    }
  };
  r.quietly(() => { if (fs.existsSync(r.root)) walk(r.root); });
  return files;
}

/**
 * Round 11 (F7): independent of how the counters classify a call, the
 * files themselves - every file that existed at the change has the same
 * bytes before the resumption, and no new file appeared (own temp files and
 * the scratch of a running child process aside). Round 12 (F10): and the
 * same mode and mtime (fchmod, futimes, chmod through a descriptor opened
 * for reading). Removals are counted effects (an rm admitted before the
 * change may still walk its tree).
 */
export function contentAfter(r, before, label) {
  const now = snapshot(r);
  const own = (p) => TEMP.test(p) || SCRATCH.test(path.relative(r.root, p));
  const kept = [...before].filter(([p]) => !own(p) && now.has(p));
  const changed = kept.filter(([p, was]) => !now.get(p).bytes.equals(was.bytes)).map(([p]) => where(r, p));
  const attrs = kept.filter(([p, was]) => now.get(p).attrs !== was.attrs).map(([p]) => where(r, p));
  const created = [...now.keys()].filter((p) => !own(p) && !before.has(p)).map((p) => where(r, p));
  const out = [];
  if (changed.length) out.push(`${label}: content changed after the change: ${JSON.stringify(changed)}`);
  if (attrs.length) out.push(`${label}: attributes changed after the change: ${JSON.stringify(attrs)}`);
  if (created.length) out.push(`${label}: files created after the change: ${JSON.stringify(created)}`);
  return out;
}

/**
 * One swept run; returns the list of violations (empty: passed).
 * `at` is N, or a predicate (label, target) for the point of the change.
 */
export async function sweptRun(entry, at, variant, extra) {
  const r = await makeRig(entry, extra);
  const name = `${entry.name} ${typeof at === 'function' ? 'at the named point' : `N=${at}`} ${variant}`;
  const violations = [];
  const fail = (what) => violations.push(`${name}: ${what}`);
  let b = null;
  if (typeof at === 'function') r.sweep.when = at.fresh ? at.fresh() : at;
  else r.sweep.at = at;
  let atChange = null;
  r.sweep.action = () => {
    atChange = snapshot(r);
    r.signOut();
    if (variant === 'B') {
      r.signInB();
      // B's own registrations, made right at the change.
      b = { scope: r.scopes.open(), controller: new AbortController() };
      b.claimed = b.scope.claim('r1');
      b.scope.registerCancel('r1', b.controller);
    }
  };
  try {
    const scope = r.scopes.open();
    let resultBeforeChange = false;
    const result = await entry.run(r, scope).then((value) => { resultBeforeChange = !r.sweep.fired; return value; });
    await quiet(entry, r);
    if (!r.sweep.fired) { fail('the change never fired'); return violations; }
    violations.push(...afterChange(r, name));
    violations.push(...contentAfter(r, atChange, name));
    // A result settled before the change (the change landed in follow-up
    // work: queue kick, re-scan) need not be sessionEnded.
    if (!resultBeforeChange && !entry.ended(result)) fail(`result not sessionEnded: ${JSON.stringify(result)}`);
    const left = r.stores.queue.data.pendingUploads.find((u) => u.recordId === 'r1');
    if (entry.name === 'queue run' && ended(result) && left && left.retryCount !== 0) {
      fail('an attempt ended by the session change was counted as a retry');
    }
    if (variant === 'B') {
      if (!b.claimed || !r.scopes.inFlight.has('r1')) fail('B lost its claim');
      const cancel = r.scopes.cancelUpload('r1');
      if (!cancel || cancel.scope !== b.scope) fail('B lost its cancel handle');
      if (r.s.authority.getUser()?.id !== 'b' || !b.scope.alive()) fail('B session not intact');
      b.scope.release('r1');
    }
    if (entry.resumes) {
      // Owner A signs in again; main runs the queue (afterSessionApplied).
      if (variant === 'B') r.signOut();
      r.signInA();
      const mark = r.requests.length;
      await r.background.startQueue(r.scopes);
      await quiet(entry, r);
      const transfers = r.requests.slice(mark).filter((q) => q.url.endsWith('/api/uploads/complete') || q.url.endsWith('/api/desktop/upload'));
      const rec = r.stores.history.data.recordings.find((x) => x.id === 'r1');
      if (transfers.length > 1) fail(`resumption uploaded ${transfers.length} times`);
      if (rec?.uploadStatus !== 'uploaded') fail(`no resumption (history ${rec?.uploadStatus})`);
      if (r.stores.queue.data.pendingUploads.some((u) => u.recordId === 'r1')) fail('still queued after the resumption');
    }
    if (entry.recovery) {
      if (variant === 'B') r.signOut();
      r.signInA();
      const outcome = await r.background.startRecovery(r.scopes, 'sign-in');
      await quiet(entry, r);
      if (!outcome?.completed && !outcome?.skipped) fail(`recovery did not run again: ${JSON.stringify(outcome)}`);
      for (const source of entry.sources ? entry.sources(r) : []) if (!fs.existsSync(source)) fail(`source deleted: ${path.relative(r.root, source)}`);
      if (entry.afterResume) for (const problem of entry.afterResume(r)) fail(problem);
    }
  } catch (error) {
    fail(`threw ${error?.stack || error}`);
  } finally {
    await r.cleanup();
  }
  return violations;
}

/** The control: a refresh of the same session at point N changes nothing. */
export async function refreshRun(entry, n, base) {
  const r = await makeRig(entry);
  try {
    r.sweep.at = n;
    r.sweep.action = () => { r.refresh(); };
    const scope = r.scopes.open();
    const result = await entry.run(r, scope);
    await quiet(entry, r);
    const problems = [];
    if (JSON.stringify(result) !== JSON.stringify(base.result)) problems.push(`result ${JSON.stringify(result)} != ${JSON.stringify(base.result)}`);
    if (JSON.stringify(shape(r)) !== JSON.stringify(base.shape)) problems.push(`effects differ: ${JSON.stringify(shape(r))} vs ${JSON.stringify(base.shape)}`);
    if (!scope.alive()) problems.push('scope ended by a refresh');
    return problems.map((p) => `${entry.name} refresh N=${n}: ${p}`);
  } finally {
    await r.cleanup();
  }
}

/**
 * The points N of one entry's sweep (review round 11, Windows CI time):
 * all of 1..max by default. With SWEEP_SAMPLE=<fraction in (0,1)> (set by
 * CI on the Windows runner only, where one run takes about seven times as
 * long) a sample with a fixed seed (SWEEP_SEED, default 'r11'; per entry):
 * the first two and the last two points always, each other point with the
 * given probability. Linux and macOS run every point on every commit; the
 * gate is the same JavaScript on all three, the Windows-specific parts
 * (paths, CRLF, rename retries, letter case) are in the named points, the
 * mutants and the unit probes, which are never sampled.
 */
export function sweepPoints(max, key, { sample = process.env.SWEEP_SAMPLE, seed = process.env.SWEEP_SEED || 'r11' } = {}) {
  const all = Array.from({ length: max }, (_, i) => i + 1);
  if (sample === undefined || sample === '' || Number(sample) === 1) return all;
  const fraction = Number(sample);
  if (!(fraction > 0 && fraction < 1)) throw new Error(`SWEEP_SAMPLE must be a fraction in (0, 1], got ${sample}`);
  // FNV-1a of seed and entry, then mulberry32.
  let h = 2166136261;
  for (const ch of `${seed}:${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const next = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return all.filter((n) => {
    const draw = next();
    return n <= 2 || n > max - 2 || draw < fraction;
  });
}

/** The whole sweep of one entry: N=1..max (sweepPoints), variants A and B, the refresh control. */
export async function sweepEntry(entry, { variants = ['A', 'B'], control = true, extra } = {}) {
  const base = await baseline(entry, extra);
  const violations = [];
  let runs = 0;
  for (const n of sweepPoints(base.max, entry.name)) {
    for (const variant of variants) { violations.push(...await sweptRun(entry, n, variant, extra)); runs++; }
    if (control) { violations.push(...await refreshRun(entry, n, base)); runs++; }
  }
  return { base, violations, runs };
}
