// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDisk, boot, jwt } from './support/desktopSession';

// Review round 9 (council 3, P2): the SessionScope of main's background work
// on the REAL session authority. R-S1 (a scope only for a released session),
// R-S2 (effects only through the scope, alive() right before the system
// call), R-S3 (abort only at an epoch change, never at a refresh; everything
// that waits ends once). Hüter probes: renamesAfterSessionChange=0 (change
// during file.sync) and requestsAfterSessionChange=0 (change during the
// gateway-retry sleep). Failed at 7c121955 (no session-scope.js).

const require = createRequire(import.meta.url);
const axios = require('axios');
const { createScopeRegistry, isSessionEnded } = require('../../src-electron/session-scope.js');
const { installApiResilience } = require('../../src-electron/api-resilience.js');
const durable = require('../../src-electron/durable-files.js');

const API = 'http://api.test';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function memoryStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const writes = [];
  return {
    data, writes,
    get: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d),
    set: (k, v) => { writes.push(k); data[k] = JSON.parse(JSON.stringify(v)); }
  };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A real axios instance whose transport is a counting fake; api-resilience installed. */
function fakeHttp({ sleep } = {}) {
  const requests = [];
  const answers = [];
  const instance = axios.create({
    adapter: (config) => {
      requests.push({ url: config.url, method: config.method, auth: config.headers?.Authorization || null, signal: config.signal });
      if (config.signal?.aborted) return Promise.reject(new axios.CanceledError('canceled', null, config));
      const next = answers.shift() || { status: 200, data: { ok: true } };
      const answer = typeof next === 'function' ? next(config) : next;
      return Promise.resolve(answer).then((a) => {
        const response = { data: a.data, status: a.status, statusText: String(a.status), headers: { 'content-type': 'application/json' }, config, request: {} };
        if (a.status >= 400) throw new axios.AxiosError(`HTTP ${a.status}`, 'ERR_BAD_RESPONSE', config, {}, response);
        return response;
      });
    }
  });
  installApiResilience({ axios: instance, log: quiet, getApiBaseUrl: () => API, sleep: sleep || (async () => {}) });
  return { instance, requests, answers };
}

function rig({ signedIn = true, sleep } = {}) {
  const disk = createDisk();
  let scopes;
  const s = boot(disk, { onAbort: () => scopes && scopes.abortAll() });
  if (signedIn) s.passwordSignIn('a').apply();
  const http = fakeHttp({ sleep });
  const stores = { history: memoryStore({ recordings: [] }), queue: memoryStore({ pendingUploads: [] }), active: memoryStore({ activeSession: null }) };
  const sent = [];
  scopes = createScopeRegistry({ authority: s.authority, http: http.instance, stores, send: (c, p) => sent.push(c), log: quiet });
  const signOut = () => s.authority.signOut();
  const signInB = () => s.passwordSignIn('b').apply();
  const refresh = () => {
    const t = s.authority.ticket({ userId: 'a' });
    return s.authority.applySession(t, { token: jwt('a', 'refreshed'), user: { id: 'a' } }, { kind: 'refresh' });
  };
  return { disk, s, scopes, http, stores, sent, signOut, signInB, refresh };
}

const tmpDirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-')); tmpDirs.push(d); return d; };

describe('R-S1: a scope only for a released session', () => {
  it('signed out, unreadable record or held migration: open() is null', () => {
    expect(rig({ signedIn: false }).scopes.open()).toBeNull();
    const held = createDisk();
    held.failRecordRead = true;
    const h = boot(held);
    expect(h.authority.state().migrationPending).toBe(true);
    expect(createScopeRegistry({ authority: h.authority, http: {}, stores: {} }).open()).toBeNull();
    const bad = createDisk();
    bad.record = '{broken';
    const u = boot(bad);
    expect(u.authority.state().unreadable).toBe(true);
    expect(createScopeRegistry({ authority: u.authority, http: {}, stores: {} }).open()).toBeNull();
  });

  it('signed in: alive until the epoch changes; a refresh keeps it alive', () => {
    const r = rig();
    const scope = r.scopes.open();
    expect(scope.alive()).toBe(true);
    expect(r.refresh().applied).toBe(true);
    expect(scope.alive()).toBe(true);
    r.signOut();
    expect(scope.alive()).toBe(false);
    r.signInB();
    expect(scope.alive()).toBe(false);
    expect(r.scopes.open().alive()).toBe(true);
  });
});

describe('R-S3: abort at every epoch change, never at a refresh', () => {
  for (const [name, change] of [
    ['sign-out', (r) => r.signOut()],
    ['sign-in of another account', (r) => r.signInB()],
    ['invalidate', (r) => r.s.authority.invalidate()],
    ['SSO after a sign-out', (r) => { r.signOut(); const t = r.s.authority.ticket(); r.s.authority.applySession(t, { token: jwt('c'), user: { id: 'c' } }, { kind: 'sso' }); }]
  ]) {
    it(`${name}: signal aborted, sleepers end once with sessionEnded, timers and tracked objects ended, notify dropped`, async () => {
      const r = rig();
      const scope = r.scopes.open();
      const fired = vi.fn();
      scope.timer(10_000, fired);
      const stopTick = vi.fn();
      scope.interval(10_000, stopTick);
      const tracked = { abort: vi.fn() };
      scope.track(tracked);
      const sleeping = scope.sleep(10_000);
      const settled = vi.fn();
      sleeping.then(settled, settled);
      change(r);
      await new Promise((res) => setTimeout(res, 0));
      expect(scope.signal.aborted).toBe(true);
      expect(settled).toHaveBeenCalledTimes(1);
      await expect(sleeping).rejects.toSatisfy(isSessionEnded);
      expect(tracked.abort).toHaveBeenCalledTimes(1);
      expect(r.scopes.size).toBe(0);
      scope.notify('upload:complete', {});
      expect(r.sent).toEqual([]);
      expect(fired).not.toHaveBeenCalled();
    });
  }

  it('refresh: nothing aborted', () => {
    const r = rig();
    const scope = r.scopes.open();
    const tracked = { abort: vi.fn() };
    scope.track(tracked);
    r.refresh();
    expect(scope.signal.aborted).toBe(false);
    expect(tracked.abort).not.toHaveBeenCalled();
    expect(r.scopes.size).toBe(1);
  });
});

describe('R-S2: effects only while alive, checked at the effect', () => {
  it('commit runs fn synchronously after alive(); after the change it throws and writes nothing; a promise is refused', () => {
    const r = rig();
    const scope = r.scopes.open();
    expect(scope.commit(() => 7)).toBe(7);
    expect(() => scope.commit(async () => {})).toThrow(/synchronous/);
    scope.update.queue((q) => [...q, { recordId: 'r1' }]);
    expect(r.stores.queue.writes).toEqual(['pendingUploads']);
    r.signOut();
    const fn = vi.fn();
    expect(() => scope.commit(fn)).toThrow(expect.objectContaining({ code: 'SESSION_ENDED' }));
    expect(fn).not.toHaveBeenCalled();
    expect(() => scope.update.queue(() => [])).toThrow(expect.objectContaining({ code: 'SESSION_ENDED' }));
    expect(r.stores.queue.writes).toEqual(['pendingUploads']);
  });

  it('http: the token of the scope, the scope signal; nothing is sent after the change and a late answer is dropped', async () => {
    const r = rig();
    const scope = r.scopes.open();
    const answer = deferred();
    r.http.answers.push(() => answer.promise);
    const call = scope.http.get(`${API}/api/x`, { auth: true });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.http.requests).toHaveLength(1);
    expect(r.http.requests[0].auth).toBe(`Bearer ${jwt('a', 'pw')}`);
    r.signOut();
    expect(r.http.requests[0].signal.aborted).toBe(true);
    answer.resolve({ status: 200, data: { ok: true } });
    await expect(call).rejects.toSatisfy(isSessionEnded);
    expect(() => scope.http.post(`${API}/api/y`, {})).toThrow(expect.objectContaining({ code: 'SESSION_ENDED' }));
    expect(r.http.requests).toHaveLength(1);
  });

  it('Hüter probe: gateway 502, session change during the retry sleep -> requestsAfterSessionChange = 0', async () => {
    const gate = deferred();
    const r = rig({ sleep: () => gate.promise });
    const scope = r.scopes.open();
    r.http.answers.push({ status: 502, data: '<html>bad gateway</html>' });
    const call = scope.http.get(`${API}/api/desktop/upload/a1/status`, { auth: true });
    for (let i = 0; i < 20 && r.http.requests.length === 0; i++) await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));
    const before = r.http.requests.length;
    r.signOut();
    r.signInB();
    gate.resolve();
    await expect(call).rejects.toSatisfy(isSessionEnded);
    expect(r.http.requests.length - before).toBe(0);
  });

  it('control: without a change the gateway retry goes out once more and succeeds', async () => {
    const r = rig();
    const scope = r.scopes.open();
    r.http.answers.push({ status: 502, data: '<html>bad gateway</html>' }, { status: 200, data: { status: 'COMPLETED' } });
    const res = await scope.http.get(`${API}/api/desktop/upload/a1/status`, { auth: true });
    expect(res.data.status).toBe('COMPLETED');
    expect(r.http.requests).toHaveLength(2);
  });

  it('commitRename: alive() before every rename, also in the retry -> no rename after the change', async () => {
    const r = rig();
    const scope = r.scopes.open();
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.tmp'), 'x');
    const real = fs.promises.rename;
    let calls = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      calls++;
      if (calls === 1) {
        r.signOut();
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return real(...args);
    });
    await expect(scope.commitRename(path.join(dir, 'a.tmp'), path.join(dir, 'a.json'))).rejects.toSatisfy(isSessionEnded);
    expect(calls).toBe(1);
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(false);
  });

  it('Hüter probe: change during file.sync of writeFileAtomic -> renamesAfterSessionChange = 0, receipt unchanged', async () => {
    const r = rig();
    const scope = r.scopes.open();
    const dir = tmp();
    const receipt = path.join(dir, 'upload-receipt.json');
    fs.writeFileSync(receipt, '{"old":true}');
    const realOpen = fs.promises.open;
    const renames = vi.spyOn(fs.promises, 'rename');
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { r.signOut(); r.signInB(); return sync(); };
      return handle;
    });
    await expect(scope.fs.writeFileAtomic(receipt, '{"new":true}')).rejects.toSatisfy(isSessionEnded);
    expect(renames).not.toHaveBeenCalled();
    expect(fs.readFileSync(receipt, 'utf8')).toBe('{"old":true}');
    expect(fs.readdirSync(dir)).toEqual(['upload-receipt.json']);
  });

  it('durable-files publish gate: foreground (no gate) is unchanged, a gated ended scope publishes nothing', async () => {
    const dir = tmp();
    await durable.writeFileAtomic(path.join(dir, 'fg.json'), '1');
    expect(fs.readFileSync(path.join(dir, 'fg.json'), 'utf8')).toBe('1');
    const assertAlive = () => { throw Object.assign(new Error('Signed out'), { code: 'SESSION_ENDED' }); };
    await expect(durable.publishGate.run({ assertAlive }, () => durable.writeFileAtomic(path.join(dir, 'bg.json'), '2'))).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    expect(fs.existsSync(path.join(dir, 'bg.json'))).toBe(false);
  });

  it('ports run only while alive and their late result is dropped', async () => {
    const r = rig();
    const finalize = deferred();
    const port = vi.fn(() => finalize.promise);
    const scopes = createScopeRegistry({ authority: r.s.authority, http: r.http.instance, stores: r.stores, ports: { finalizeForRecovery: port }, log: quiet });
    const scope = scopes.open();
    const run = scope.port.finalizeForRecovery('r1');
    r.signOut();
    scopes.abortAll();
    finalize.resolve({ success: true });
    await expect(run).rejects.toSatisfy(isSessionEnded);
    expect(() => scope.port.finalizeForRecovery('r2')).toThrow(expect.objectContaining({ code: 'SESSION_ENDED' }));
    expect(port).toHaveBeenCalledTimes(1);
  });
});

describe('R-S3: clean-up keyed by (scope, recordId)', () => {
  it('the late finally of an ended scope never releases the claim or the cancel handle of the next session', () => {
    const r = rig();
    const a = r.scopes.open();
    expect(a.claim('r1')).toBe(true);
    const handleA = a.registerCancel('r1', new AbortController());
    r.signOut();
    r.signInB();
    const b = r.scopes.open();
    expect(b.claim('r1')).toBe(true);
    const controllerB = new AbortController();
    b.registerCancel('r1', controllerB);
    a.release('r1');
    handleA.release();
    expect(r.scopes.inFlight.has('r1')).toBe(true);
    expect(r.scopes.cancelUpload('r1').scope).toBe(b);
    expect(controllerB.signal.aborted).toBe(true);
  });

  it('a live claim is not taken over', () => {
    const r = rig();
    const a = r.scopes.open();
    const b = r.scopes.open();
    expect(a.claim('r1')).toBe(true);
    expect(b.claim('r1')).toBe(false);
    b.release('r1');
    expect(r.scopes.inFlight.has('r1')).toBe(true);
    a.release('r1');
    expect(r.scopes.inFlight.has('r1')).toBe(false);
  });
});
