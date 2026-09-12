// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { watchOwnedDevTools, validateDevToolsEndpoint, validateAppIdentity } = require('../e2e-harness/lib/app-driver');
const endpoint = 'ws://127.0.0.1:49152/devtools/browser/1234-abcd';
const watchers = [];
function child() {
  return Object.assign(new EventEmitter(), { stderr: new EventEmitter(), stdout: new EventEmitter(),
    pid: 999999, exitCode: null, signalCode: null, killed: false });
}
function watch(proc, options) {
  const watcher = watchOwnedDevTools(proc, options); watchers.push(watcher); return watcher;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { watchers.splice(0).forEach(watcher => watcher.close()); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('owned DevTools announcement', () => {
  it('accepts a loopback endpoint split across stderr frames and releases startup listeners', async () => {
    const proc = child(), owner = watch(proc);
    proc.stderr.emit('data', Buffer.from('ordinary startup\nDevTools lis'));
    proc.stderr.emit('data', Buffer.from('tening on ws://127.0.0.1:49152/devtools/bro'));
    proc.stderr.emit('data', Buffer.from('wser/1234-abcd\r\n'));
    expect(await owner.ready).toBe(endpoint);
    expect(proc.stderr.listenerCount('data')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    owner.close();
    expect(proc.listenerCount('exit')).toBe(0); expect(proc.listenerCount('error')).toBe(0);
  });
  it.each(['ws://example.invalid:49152/devtools/browser/id', 'ws://localhost:49152/devtools/browser/id',
    'wss://127.0.0.1:49152/devtools/browser/id', 'ws://user@127.0.0.1:49152/devtools/browser/id',
    'ws://127.0.0.1:49152/devtools/browser/id?other=1', 'ws://127.0.0.1:49152/devtools/page/id',
    'ws://127.0.0.1/devtools/browser/id'])('rejects unexpected endpoint %s', value => {
    expect(() => validateDevToolsEndpoint(value)).toThrow();
  });
  it('allows numeric IPv6 loopback and checks an explicitly requested fixed port', () => {
    expect(validateDevToolsEndpoint('ws://[::1]:49152/devtools/browser/id', 49152)).toContain('[::1]');
    expect(() => validateDevToolsEndpoint(endpoint, 9339)).toThrow('unexpected');
  });
  it.each(['exit', 'error', 'bind'])('rejects owned child %s before a connection', async reason => {
    const proc = child(), owner = watch(proc);
    const failed = expect(owner.ready).rejects.toThrow(/Owned/);
    if (reason === 'exit') proc.emit('exit', 1, null);
    else if (reason === 'error') proc.emit('error', new Error('spawn failed'));
    else proc.stderr.emit('data', Buffer.from('bind() failed: Address already in use (10048)\n'));
    await failed;
  });
  it('rejects an already exited child and exit after its endpoint announcement', async () => {
    const exited = child(); exited.exitCode = 1;
    await expect(watch(exited).ready).rejects.toThrow('exited');
    const proc = child(), owner = watch(proc);
    proc.stderr.emit('data', Buffer.from(`DevTools listening on ${endpoint}\n`)); await owner.ready;
    proc.emit('exit', 0, null);
    expect(owner.assertAlive).toThrow('exited');
    await expect(owner.race(new Promise(() => {}))).rejects.toThrow('exited');
  });
  it('bounds both unterminated stderr and startup time without polling any port', async () => {
    const proc = child(), owner = watch(proc, { maxLineBytes: 32 });
    const oversized = expect(owner.ready).rejects.toThrow('bound');
    proc.stderr.emit('data', Buffer.from('x'.repeat(33))); await oversized;
    const timed = watch(child(), { timeoutMs: 40 });
    const expired = expect(timed.ready).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(40); await expired;
  });
  it('settles pending startup when its owner closes before an endpoint arrives', async () => {
    const proc = child(), owner = watch(proc);
    const stopped = expect(owner.ready).rejects.toThrow('closed');
    owner.close(); await stopped;
    expect(proc.stderr.listenerCount('data')).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('renderer identity comparison', () => {
  it('normalizes Windows absolute paths without weakening macOS path identity', () => {
    const expected = { userDataDir: 'C:\\Tests\\Owned', apiUrl: 'http://127.0.0.1:3000' };
    expect(() => validateAppIdentity({ userDataDir: 'c:/tests/owned/', apiUrl: 'http://127.0.0.1:3000/' }, expected, 'win32')).not.toThrow();
    expect(() => validateAppIdentity({ userDataDir: '/Tests/Owned', apiUrl: expected.apiUrl },
      { userDataDir: '/tests/owned', apiUrl: expected.apiUrl }, 'darwin')).toThrow('match');
    expect(() => validateAppIdentity({ userDataDir: '../owned', apiUrl: expected.apiUrl }, expected, 'win32')).toThrow('absolute');
  });
  it.each([{ userDataDir: '/other', apiUrl: 'http://127.0.0.1:3000' },
    { userDataDir: '/owned', apiUrl: 'https://production.invalid' }, null])('rejects wrong or missing identity %j', identity => {
    expect(() => validateAppIdentity(identity, { userDataDir: '/owned', apiUrl: 'http://127.0.0.1:3000' }, 'darwin')).toThrow();
  });
});

// Run the actual launch/stabilization methods with owned process/renderer
// doubles. No network, Electron, microphone, real profile or filesystem writes.
function driverFixture(identityOverride, connectOverride, platform = 'win32') {
  const filename = require.resolve('../e2e-harness/lib/app-driver');
  const proc = child(), kill = vi.fn(), spawn = vi.fn(() => proc), actions = vi.fn(), observed = vi.fn();
  let identity;
  const page = { url: () => 'file:///owned/index.html', evaluate: vi.fn(async fn => {
    if (fn.toString().includes('getUserDataPath')) return identity;
    actions(); return undefined;
  }), waitForSelector: vi.fn(async () => {}) };
  const browser = { pages: vi.fn(async () => [page]), disconnect: vi.fn() };
  const connect = vi.fn(connectOverride || (async () => browser));
  const loaded = { exports: {} };
  const mocks = { child_process: { spawn, execFileSync: kill }, fs: { existsSync: () => false, mkdirSync: vi.fn() },
    path, 'puppeteer-core': { connect } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: loaded, exports: loaded.exports,
    require: id => { if (Object.hasOwn(mocks, id)) return mocks[id]; throw new Error('Unexpected dependency: ' + id); },
    __dirname: path.dirname(filename), process: { platform, env: {}, kill }, URL, Buffer, console, setTimeout, clearTimeout });
  const app = new loaded.exports.AppDriver({ name: 'isolation-unit-owned', packagedExe: 'synthetic.exe', apiUrl: 'http://127.0.0.1:3000' });
  identity = { userDataDir: app.userDataDir, apiUrl: app.apiUrl, ...identityOverride };
  app.observeRenderer = observed;
  return { app, proc, spawn, kill, actions, observed, page, browser, connect };
}

describe('AppDriver fails closed before renderer actions', () => {
  it('ignores stale occupied-port data and aborts owned bind failure with zero effects', async () => {
    const fixture = driverFixture(); const launching = fixture.app.launch();
    const failure = expect(launching).rejects.toThrow('bind');
    // A foreign endpoint can exist; launch has no HTTP dependency or fallback.
    fixture.proc.stdout.emit('data', Buffer.from(`DevTools listening on ${endpoint}\n`));
    fixture.proc.stderr.emit('data', Buffer.from('bind() failed: Address already in use\n'));
    await failure;
    expect(fixture.connect).not.toHaveBeenCalled(); expect(fixture.actions).not.toHaveBeenCalled();
    expect(fixture.observed).not.toHaveBeenCalled(); expect(fixture.kill).toHaveBeenCalledTimes(1);
  });
  it.each([{ userDataDir: path.resolve('tests/e2e-harness/work/userdata/someone-else') },
    { apiUrl: 'https://production.invalid' }])('rejects connected wrong identity before diagnostics/actions %j', wrong => {
    return (async () => {
      const fixture = driverFixture(wrong); const launching = fixture.app.launch();
      const failure = expect(launching).rejects.toThrow('match');
      fixture.proc.stderr.emit('data', Buffer.from(`DevTools listening on ${endpoint}\n`));
      await failure;
      expect(fixture.page.evaluate).toHaveBeenCalledTimes(1); expect(fixture.actions).not.toHaveBeenCalled();
      expect(fixture.observed).not.toHaveBeenCalled(); expect(fixture.browser.disconnect).toHaveBeenCalledTimes(1);
    })();
  });
  it('retries identity verification after a mid-check renderer navigation but not after a closed target', async () => {
    const fixture = driverFixture();
    fixture.page.evaluate.mockImplementationOnce(async () => { throw new Error('Execution context was destroyed, most likely because of a navigation.'); });
    const launching = fixture.app.launch();
    fixture.proc.stderr.emit('data', Buffer.from(`DevTools listening on ${endpoint}\n`));
    await vi.advanceTimersByTimeAsync(6000); await launching;
    const identityChecks = fixture.page.evaluate.mock.calls.filter(([fn]) => fn.toString().includes('getUserDataPath'));
    expect(identityChecks).toHaveLength(2);
    expect(fixture.observed).toHaveBeenCalledTimes(1); expect(fixture.actions).toHaveBeenCalled();
    await fixture.app.close();

    const closed = driverFixture();
    closed.page.evaluate.mockImplementationOnce(async () => { throw new Error('Target closed'); });
    const failing = closed.app.launch();
    const failure = expect(failing).rejects.toThrow('Could not verify connected app identity');
    closed.proc.stderr.emit('data', Buffer.from(`DevTools listening on ${endpoint}\n`));
    await failure;
    expect(closed.page.evaluate).toHaveBeenCalledTimes(1); expect(closed.actions).not.toHaveBeenCalled();
    expect(closed.observed).not.toHaveBeenCalled(); expect(closed.browser.disconnect).toHaveBeenCalledTimes(1);
  });
  it('connects only to its announced endpoint and checks identity before allowing actions', async () => {
    const fixture = driverFixture();
    fixture.app.env = { SUISSE_TEST_USERDATA: 'C:\\not-owned', SUISSE_TEST_CDP_PORT: '9339',
      API_BASE_URL: 'https://production.invalid', VITE_API_URL: 'https://production.invalid' };
    const launching = fixture.app.launch();
    expect(fixture.spawn.mock.calls[0][2].env.SUISSE_TEST_CDP_PORT).toBe('0');
    expect(fixture.spawn.mock.calls[0][2].env.SUISSE_TEST_USERDATA).toBe(path.resolve(fixture.app.userDataDir));
    expect(fixture.spawn.mock.calls[0][2].env.API_BASE_URL).toBe(fixture.app.apiUrl);
    fixture.proc.stderr.emit('data', Buffer.from(`DevTools listening on ${endpoint}\n`));
    await vi.advanceTimersByTimeAsync(3000); await launching;
    expect(fixture.connect).toHaveBeenCalledWith({ browserWSEndpoint: endpoint, defaultViewport: null });
    expect(fixture.page.evaluate.mock.invocationCallOrder[0]).toBeLessThan(fixture.observed.mock.invocationCallOrder[0]);
    expect(fixture.observed.mock.invocationCallOrder[0]).toBeLessThan(fixture.actions.mock.invocationCallOrder[0]);
    await fixture.app.close();
    expect(fixture.proc.listenerCount('exit')).toBe(0); expect(fixture.proc.listenerCount('error')).toBe(0);
  });
  it('disconnects a connection that resolves after owned child exit', async () => {
    let connected; const fixture = driverFixture(undefined, () => new Promise(resolve => { connected = resolve; }));
    const launching = fixture.app.launch(), failure = expect(launching).rejects.toThrow('exited');
    fixture.proc.stderr.emit('data', Buffer.from(`DevTools listening on ${endpoint}\n`));
    await vi.advanceTimersByTimeAsync(0);
    fixture.proc.exitCode = 1; fixture.proc.emit('exit', 1, null); await failure;
    connected(fixture.browser); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.browser.disconnect).toHaveBeenCalledTimes(1); expect(fixture.actions).not.toHaveBeenCalled();
    expect(fixture.kill).not.toHaveBeenCalled();
  });
  it('disconnects a connection that resolves after the connection deadline', async () => {
    let connected; const fixture = driverFixture(undefined, () => new Promise(resolve => { connected = resolve; }));
    const launching = fixture.app.launch(), failure = expect(launching).rejects.toThrow('timed out');
    fixture.proc.stderr.emit('data', Buffer.from(`DevTools listening on ${endpoint}\n`));
    await vi.advanceTimersByTimeAsync(15100); await failure;
    connected(fixture.browser); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.browser.disconnect).toHaveBeenCalledTimes(1);
    expect(fixture.actions).not.toHaveBeenCalled(); expect(fixture.observed).not.toHaveBeenCalled();
  });
  it.each(['missing', 'throws', 'timeout'])('fails closed when app identity IPC is %s', async mode => {
    const fixture = driverFixture();
    fixture.page.evaluate.mockImplementation(() => {
      if (mode === 'throws') throw new Error('IPC unavailable');
      return mode === 'timeout' ? new Promise(() => {}) : Promise.resolve(null);
    });
    const launching = fixture.app.launch(), failure = expect(launching).rejects.toThrow(/identity/);
    fixture.proc.stderr.emit('data', Buffer.from(`DevTools listening on ${endpoint}\n`));
    await vi.advanceTimersByTimeAsync(mode === 'timeout' ? 5100 : 0); await failure;
    expect(fixture.actions).not.toHaveBeenCalled(); expect(fixture.observed).not.toHaveBeenCalled();
  });
  it('cleans only the owned detached POSIX process group if its launcher already exited', async () => {
    const fixture = driverFixture(undefined, undefined, 'darwin');
    fixture.app.proc = fixture.proc; fixture.proc.exitCode = 1;
    await fixture.app.close();
    expect(fixture.kill).toHaveBeenCalledTimes(1);
    expect(fixture.kill).toHaveBeenCalledWith(-fixture.proc.pid, 'SIGKILL');
  });
});
