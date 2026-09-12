// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { parseProcesses, claimGroup, validateGroup } = require('../e2e-harness/ci/macos-packaged-groups');
const { supervise, stopGroups } = require('../e2e-harness/ci/macos-packaged-supervisor');
const birth = 'Sat Sep 12 10:00:00 2026';
const later = 'Sat Sep 12 10:00:01 2026';
const earlier = 'Sat Sep 12 09:59:59 2026';
let root, children;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'macos-packaged-unit-')));
  children = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(absolute).startsWith('macos-packaged-unit-') || fs.lstatSync(absolute).isSymbolicLink()) {
    throw new Error('Unsafe process-group fixture cleanup');
  }
  fs.rmSync(absolute, { recursive: true, force: true });
});

function row(pid, ppid, pgid = pid, born = birth, state = 'S') {
  return { pid, ppid, pgid, birth: born, state };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fakeChild(pid = 42042) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, connected: true,
    stdout: new PassThrough(), stderr: new PassThrough(), send: vi.fn() });
  child.disconnect = vi.fn(() => { child.connected = false; child.emit('disconnect'); });
  child.kill = vi.fn(signal => {
    if (!Number.isSafeInteger(child.pid)) return false;
    child.signalCode = signal;
    child.emit('exit', null, signal);
    child.connected = false;
    child.emit('disconnect');
    child.emit('close');
    return true;
  });
  children.push(child);
  return child;
}
function workerExited(child, { close = true, code = 0 } = {}) {
  child.exitCode = code;
  child.emit('exit', code, null);
  child.connected = false; child.emit('disconnect');
  if (close) child.emit('close');
}
function start(child, overrides = {}) {
  const spawnProcess = vi.fn(() => child);
  const readTable = vi.fn(async () => [row(child.pid, process.pid)]);
  const stopTree = vi.fn(async () => ({ signalled: [], remaining: [], liveProcesses: 0 }));
  const options = { root, directory: root, timeoutMs: 10000, spawnProcess, readTable, stopTree, ...overrides };
  const pending = supervise(path.join(root, 'unexecuted-worker.js'), [], options);
  return { pending, ...options };
}
function json(name) { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }

describe('native process identity snapshots', () => {
  it('parses macOS stat/lstart including parent0 and ignores kernel task0', () => {
    expect(parseProcesses(`0 0 0 R ${birth}\n 1 0 1 Ss ${birth}\n42 1 42 S+ ${later}\n`)).toEqual([
      row(1, 0, 1, birth, 'Ss'), row(42, 1, 42, later, 'S+')
    ]);
    expect(parseProcesses('')).toEqual([]);
  });

  it.each([
    `bad 1 42 S ${birth}`, `42 -1 42 S ${birth}`, `42 1 0 S ${birth}`,
    `42 1 42 S not-a-date`, `42 1 42`, `1.5 1 42 S ${birth}`
  ])('rejects malformed process ownership rows: %s', line => {
    expect(() => parseProcesses(line)).toThrow('ownership snapshot');
  });

  it('claims only the child group leader belonging to the expected parent', () => {
    const rows = [row(42, 10), row(43, 42, 42, later)];
    expect(claimGroup(rows, 42, 10)).toEqual({ pid: 42, birth });
    expect(() => claimGroup(rows, 42, 999)).toThrow('ownership');
    expect(() => claimGroup(rows, 43, 42)).toThrow('ownership');
    expect(() => claimGroup(rows, 44, 42)).toThrow('ownership');
    expect(claimGroup([row(50, 1, 50, later)], 50, 42, birth)).toEqual({ pid: 50, birth: later });
    expect(() => claimGroup([row(50, 1, 50, earlier)], 50, 42, birth)).toThrow('ownership');
  });

  it('retains a claimed group after leader exit but rejects PID reuse or older unrelated members', () => {
    const claim = { pid: 42, birth };
    expect(validateGroup([row(43, 1, 42, later)], claim)).toEqual([row(43, 1, 42, later)]);
    expect(validateGroup([], claim)).toEqual([]);
    expect(() => validateGroup([row(42, 1, 42, later)], claim)).toThrow('identity changed');
    expect(() => validateGroup([row(42, 1, 99, birth)], claim)).toThrow('identity changed');
    expect(() => validateGroup([row(43, 1, 42, earlier)], claim)).toThrow('older unrelated');
  });

  it('reports only actual detached spawn events over the worker IPC channel', () => {
    const child = fakeChild(100);
    const childProcess = { spawn: vi.fn(() => child) };
    const send = vi.fn(), module = { exports: {} };
    const filename = require.resolve('../e2e-harness/ci/macos-packaged-groups');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, process: { send },
      require: name => name === 'child_process' ? childProcess : {} });
    module.exports.reportDetachedSpawns();
    childProcess.spawn('/Applications/Fixture.app/Contents/MacOS/Fixture', [], { detached: true });
    expect(send).not.toHaveBeenCalled();
    child.emit('spawn');
    expect(send).toHaveBeenCalledWith({ type: 'packaged-owned-group', pid: 100,
      executable: '/Applications/Fixture.app/Contents/MacOS/Fixture' });
    send.mockClear();
    childProcess.spawn('npm', [], { detached: false });
    child.emit('spawn');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('bounded cleanup of registered process groups', () => {
  it('signals each group once, detached children first, and verifies no live members remain', async () => {
    const claims = [{ pid: 42, birth }, { pid: 50, birth: later }];
    const readTable = vi.fn().mockResolvedValueOnce([row(42, 10), row(50, 42, 50, later), row(51, 50, 50, later)]).mockResolvedValue([]);
    const kill = vi.fn();
    expect(await stopGroups(claims, { readTable, kill })).toEqual({ signalled: [50, 42], remaining: [], liveProcesses: 0 });
    expect(kill.mock.calls).toEqual([[-50, 'SIGKILL'], [-42, 'SIGKILL']]);
  });

  it('rejects duplicate group claims before sending any signal', async () => {
    const claim = { pid: 42, birth };
    const readTable = vi.fn().mockResolvedValueOnce([row(42, 10)]).mockResolvedValue([]);
    const kill = vi.fn();
    await expect(stopGroups([claim, { ...claim }], { readTable, kill })).rejects.toThrow('Duplicate');
    expect(kill).not.toHaveBeenCalled();
  });

  it('validates every birth before sending any signal', async () => {
    const kill = vi.fn();
    await expect(stopGroups([{ pid: 42, birth }, { pid: 50, birth }], {
      readTable: async () => [row(42, 10), row(50, 1, 50, later)], kill
    })).rejects.toThrow('identity changed');
    expect(kill).not.toHaveBeenCalled();
  });

  it('cleans surviving group members after leader exit and excludes zombies from live counts', async () => {
    const kill = vi.fn();
    const readTable = vi.fn().mockResolvedValueOnce([row(43, 1, 42, later)]).mockResolvedValue([row(43, 1, 42, later, 'Z')]);
    const result = await stopGroups([{ pid: 42, birth }], { readTable, kill });
    expect(kill).toHaveBeenCalledWith(-42, 'SIGKILL');
    expect(result.liveProcesses).toBe(0);
    expect(result.remaining).toEqual([row(43, 1, 42, later, 'Z')]);
  });

  it('does not hide permission failures or a reused PID during post-kill verification', async () => {
    await expect(stopGroups([{ pid: 42, birth }], { readTable: async () => [row(42, 10)],
      kill: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); }
    })).rejects.toThrow('permission denied');
    const readTable = vi.fn().mockResolvedValueOnce([row(42, 10)]).mockResolvedValue([row(42, 1, 42, later)]);
    await expect(stopGroups([{ pid: 42, birth }], { readTable, kill: vi.fn() })).rejects.toThrow('identity changed');
  });

  it('bounds waiting for groups which remain alive instead of reporting successful cleanup', async () => {
    vi.useFakeTimers();
    const readTable = vi.fn(async () => [row(42, 10)]), kill = vi.fn();
    const failure = expect(stopGroups([{ pid: 42, birth }], { readTable, kill })).rejects.toThrow('remain alive');
    await vi.advanceTimersByTimeAsync(2100);
    await failure;
    expect(readTable.mock.calls.length).toBeLessThanOrEqual(21);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('supervisor completion and persisted failure evidence', () => {
  it('withholds the worker handshake until the actual group birth is established', async () => {
    const child = fakeChild(), table = deferred();
    const fixture = start(child, { readTable: () => table.promise });
    child.emit('spawn');
    expect(child.send).not.toHaveBeenCalled();
    table.resolve([row(child.pid, process.pid)]);
    await flush();
    expect(child.send).toHaveBeenCalledWith({ type: 'packaged-supervisor-ready' });
    expect(json('process-groups.json').claims).toEqual([{ pid: child.pid, birth }]);
    workerExited(child);
    expect(await fixture.pending).toMatchObject({ code: 0, cleanupVerified: true, cleanupError: null, failure: null });
    expect(fixture.spawnProcess.mock.calls[0][2]).toMatchObject({ detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  });

  it('awaits delayed cleanup and writes its evidence before returning after leader exit', async () => {
    const child = fakeChild(), cleanup = deferred();
    const fixture = start(child, { stopTree: () => cleanup.promise });
    child.emit('spawn'); await flush();
    workerExited(child);
    let complete = false;
    fixture.pending.then(() => { complete = true; });
    await flush();
    expect(complete).toBe(false);
    expect(fs.existsSync(path.join(root, 'exit.json'))).toBe(false);
    cleanup.resolve({ signalled: [child.pid], remaining: [], liveProcesses: 0 });
    const result = await fixture.pending;
    expect(result.cleanupVerified).toBe(true);
    expect(json('process-cleanup.json').signalled).toEqual([child.pid]);
    expect(json('exit.json')).toEqual(result);
  });

  it('cleans an exited leader without waiting forever for descendant-held pipes', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const fixture = start(child);
    child.emit('spawn'); await flush();
    workerExited(child, { close: false });
    await flush();
    expect(fixture.stopTree).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001);
    const result = await fixture.pending;
    expect(result).toMatchObject({ code: 0, timedOut: false, cleanupVerified: true });
    expect(result.failure).toContain('pipes did not close');
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.connected).toBe(false);
    expect(json('process-cleanup.json').claims).toEqual([{ pid: child.pid, birth }]);
  });

  it('treats real diagnostic log write errors as failures while still cleaning the owned group', async () => {
    const child = fakeChild();
    fs.mkdirSync(path.join(root, 'stdout.log'));
    const fixture = start(child);
    child.emit('spawn'); await flush();
    child.stdout.write('cannot append to directory');
    const result = await fixture.pending;
    expect(result.failure).toContain('Diagnostic log write failed');
    expect(fixture.stopTree).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(json('exit.json').failure).toBe(result.failure);
  });

  it('records asynchronous spawn errors without claiming process cleanup was verified', async () => {
    const child = fakeChild();
    child.pid = undefined;
    const fixture = start(child);
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    child.connected = false; child.emit('disconnect'); child.emit('close');
    const result = await fixture.pending;
    expect(result).toMatchObject({ code: null, spawnError: 'spawn ENOENT', failure: 'spawn ENOENT', cleanupVerified: false });
    expect(child.send).not.toHaveBeenCalled();
    expect(fixture.stopTree.mock.calls[0][0]).toEqual([]);
    expect(json('exit.json').spawnError).toBe('spawn ENOENT');
  });

  it('registers only the expected packaged app group and includes it in cleanup after worker exit', async () => {
    const child = fakeChild(), executable = '/Applications/Fixture.app/Contents/MacOS/Fixture';
    const appPid = child.pid + 1;
    const table = deferred();
    const readTable = vi.fn().mockResolvedValueOnce([row(child.pid, process.pid)]).mockImplementation(() => table.promise);
    const fixture = start(child, { expectedDetachedExecutable: executable, readTable });
    child.emit('spawn'); await flush();
    child.emit('message', { type: 'packaged-owned-group', pid: appPid, executable });
    workerExited(child);
    await flush();
    expect(fixture.stopTree).not.toHaveBeenCalled();
    // The ps snapshot completes after the worker exits; the app is now owned
    // by init but still has the actual reported PID and valid creation time.
    table.resolve([row(appPid, 1, appPid, later)]);
    const result = await fixture.pending;
    expect(result.failure).toBeNull();
    expect(fixture.stopTree.mock.calls[0][0]).toEqual([{ pid: child.pid, birth }, { pid: appPid, birth: later }]);
    expect(json('process-cleanup.json').claims).toHaveLength(2);
  });

  it('keeps packaged cleanup unverified when only the worker registered before exit', async () => {
    const child = fakeChild();
    const fixture = start(child, { expectedDetachedExecutable: '/Applications/Fixture.app/Contents/MacOS/Fixture' });
    child.emit('spawn'); await flush();
    // A worker can die after spawning the app but before its spawn event reports
    // that detached PID. Cleaning the known worker group cannot prove app exit.
    workerExited(child, { code: 1 });
    const result = await fixture.pending;
    expect(result).toMatchObject({ code: 1, cleanupVerified: false });
    expect(result.cleanupError).toContain('Exactly one owned packaged app group was not registered');
    expect(fixture.stopTree.mock.calls[0][0]).toEqual([{ pid: child.pid, birth }]);
    expect(json('exit.json').cleanupVerified).toBe(false);
  });

  it('drains a detached-spawn IPC message arriving after exit before finalizing the cleanup claim list', async () => {
    const child = fakeChild(), executable = '/Applications/Fixture.app/Contents/MacOS/Fixture';
    const appPid = child.pid + 1;
    const readTable = vi.fn().mockResolvedValueOnce([row(child.pid, process.pid)])
      .mockResolvedValue([row(appPid, 1, appPid, later)]);
    const fixture = start(child, { expectedDetachedExecutable: executable, readTable });
    child.emit('spawn'); await flush();
    child.exitCode = 0; child.emit('exit', 0, null);
    await flush();
    expect(fixture.stopTree).not.toHaveBeenCalled();
    child.emit('message', { type: 'packaged-owned-group', pid: appPid, executable });
    child.connected = false; child.emit('disconnect'); child.emit('close');
    const result = await fixture.pending;
    expect(result).toMatchObject({ cleanupVerified: true, failure: null, cleanupError: null });
    expect(json('process-cleanup.json').claims).toEqual([{ pid: child.pid, birth }, { pid: appPid, birth: later }]);
  });

  it('rejects an unexpected detached executable while retaining proven group ownership for cleanup', async () => {
    const child = fakeChild();
    const appPid = child.pid + 1;
    const fixture = start(child, { expectedDetachedExecutable: '/expected/app',
      readTable: async () => [row(child.pid, process.pid), row(appPid, child.pid, appPid, later)] });
    child.emit('spawn'); await flush();
    child.emit('message', { type: 'packaged-owned-group', pid: child.pid + 1, executable: '/unexpected/app' });
    const result = await fixture.pending;
    expect(result.failure).toContain('Detached process ownership');
    expect(result.cleanupError).toContain('Unexpected detached executable');
    expect(json('process-cleanup.json').claims).toEqual([{ pid: child.pid, birth }, { pid: appPid, birth: later }]);
  });

  it('rejects concurrent duplicate IPC registrations without duplicating an owned group claim', async () => {
    const child = fakeChild(), executable = '/Applications/Fixture.app/Contents/MacOS/Fixture';
    const appPid = child.pid + 1, table = deferred();
    const readTable = vi.fn().mockResolvedValueOnce([row(child.pid, process.pid)]).mockImplementation(() => table.promise);
    const fixture = start(child, { expectedDetachedExecutable: executable, readTable });
    child.emit('spawn'); await flush();
    const message = { type: 'packaged-owned-group', pid: appPid, executable };
    child.emit('message', message); child.emit('message', message);
    await flush();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fixture.stopTree).not.toHaveBeenCalled();
    table.resolve([row(appPid, 1, appPid, later)]);
    const result = await fixture.pending;
    expect(result.cleanupError).toContain('Unexpected detached child registration');
    expect(json('process-cleanup.json').claims).toEqual([{ pid: child.pid, birth }, { pid: appPid, birth: later }]);
    expect(fixture.stopTree).toHaveBeenCalledTimes(1);
  });

  it('reports group cleanup failure without marking termination verified', async () => {
    const child = fakeChild();
    const fixture = start(child, { stopTree: async () => { throw new Error('EPERM for owned process group'); } });
    child.emit('spawn'); await flush();
    workerExited(child);
    const result = await fixture.pending;
    expect(result).toMatchObject({ code: 0, cleanupVerified: false, cleanupError: 'EPERM for owned process group' });
    expect(json('process-cleanup.json').error).toBe(result.cleanupError);
    expect(json('exit.json').cleanupVerified).toBe(false);
  });

  it('waits for cleanup on deadline and records timeout even if killing immediately closes the worker', async () => {
    vi.useFakeTimers();
    const child = fakeChild(), cleanup = deferred();
    const fixture = start(child, { timeoutMs: 50, stopTree: () => cleanup.promise });
    child.emit('spawn'); await flush();
    await vi.advanceTimersByTimeAsync(51);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.existsSync(path.join(root, 'exit.json'))).toBe(false);
    cleanup.resolve({ signalled: [child.pid], remaining: [], liveProcesses: 0 });
    const result = await fixture.pending;
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL', cleanupVerified: true });
    expect(json('exit.json').timedOut).toBe(true);
  });
});
