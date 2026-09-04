// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AppDriver } = require('../e2e-harness/lib/app-driver');
const { killOwnedApp, snapshotChunks, compareChunks, prefixEndpointCoverage, assertSyntheticPath } = require('../e2e-harness/crash-qualification');
const workRoot = path.resolve('tests/e2e-harness/work');
let fixtureRoot;
beforeEach(() => {
  fs.mkdirSync(workRoot, { recursive: true });
  fixtureRoot = fs.mkdtempSync(path.join(workRoot, 's15-unit-'));
});
afterEach(() => {
  if (path.dirname(fixtureRoot) !== workRoot || !path.basename(fixtureRoot).startsWith('s15-unit-')) throw new Error('Refusing unrelated fixture cleanup');
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function childFixture() {
  const app = new AppDriver({ name: 's15-unit-owned', appDir: path.join(fixtureRoot, 'compiled-app') });
  const child = new EventEmitter();
  Object.assign(child, { pid: process.pid + 100000, exitCode: null, signalCode: null, spawnargs: ['electron', app.appDir] });
  app.proc = child;
  return { app, child };
}

describe('whole-process synthetic crash safeguards', () => {
  it('targets exactly the observed Windows child tree and clears the exited PID', async () => {
    const { app, child } = childFixture();
    const pid = child.pid;
    const kill = vi.fn(() => { queueMicrotask(() => child.emit('exit', 1, null)); });
    const result = await killOwnedApp(app, { platform: 'win32', execFileSync: kill });
    expect(kill).toHaveBeenCalledWith('taskkill', ['/PID', String(pid), '/T', '/F'], expect.objectContaining({ windowsHide: true, timeout: 15000 }));
    expect(result).toMatchObject({ pid, platform: 'win32', code: 1 });
    expect(app.proc).toBeNull();
  });

  it('targets only the detached Mac process group with SIGKILL', async () => {
    const { app, child } = childFixture(), pid = child.pid;
    const kill = vi.fn(() => { queueMicrotask(() => child.emit('exit', null, 'SIGKILL')); });
    expect(await killOwnedApp(app, { platform: 'darwin', kill })).toMatchObject({ pid, signal: 'SIGKILL' });
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
    expect(app.proc).toBeNull();
  });

  it.each(['own-pid', 'system-pid', 'exited', 'different-app', 'real-profile'])('rejects unsafe kill ownership: %s', async kind => {
    const { app, child } = childFixture();
    if (kind === 'own-pid') child.pid = process.pid;
    if (kind === 'system-pid') child.pid = 1;
    if (kind === 'exited') child.exitCode = 0;
    if (kind === 'different-app') child.spawnargs = ['electron', path.join(fixtureRoot, 'other-app')];
    if (kind === 'real-profile') app.userDataDir = path.resolve('not-synthetic-profile');
    const kill = vi.fn();
    await expect(killOwnedApp(app, { platform: 'win32', execFileSync: kill })).rejects.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('durable crash-prefix evidence', () => {
  it('preserves acknowledged hashes across archive moves and excludes unpublished temporary chunks', async () => {
    const chunks = path.join(fixtureRoot, 'chunks');
    fs.mkdirSync(chunks);
    fs.writeFileSync(path.join(chunks, 'chunk_0.webm'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(chunks, 'chunk_1.webm'), Buffer.from([4, 5]));
    fs.writeFileSync(path.join(chunks, 'chunk_2.webm.pending.tmp'), Buffer.from([6]));
    const acknowledged = await snapshotChunks(fixtureRoot, 1);
    expect(acknowledged.map(chunk => chunk.index)).toEqual([0]);
    const destination = path.join(fixtureRoot, 'source-chunks', '12345');
    fs.mkdirSync(path.dirname(destination));
    for (const target of [chunks, destination]) if (!path.resolve(target).startsWith(fixtureRoot + path.sep)) throw new Error('Archive move outside fixture');
    fs.renameSync(chunks, destination);
    const archived = await snapshotChunks(fixtureRoot);
    expect(archived.map(chunk => chunk.index)).toEqual([0, 1]);
    expect(compareChunks(acknowledged, archived)).toEqual([]);
    fs.writeFileSync(path.join(destination, 'chunk_0.webm'), Buffer.from([9, 2, 3]));
    expect(compareChunks(acknowledged, await snapshotChunks(fixtureRoot))).toContain('Previously durable chunk changed: 0');
  });

  it('rejects missing, duplicated and replaced acknowledged chunks without relying on total bytes', () => {
    const chunks = [{ index: 0, bytes: 3, sha256: 'first' }, { index: 1, bytes: 3, sha256: 'second' }];
    expect(compareChunks(chunks, chunks.slice(1))).toContain('Previously durable chunk disappeared: 0');
    expect(compareChunks(chunks, [chunks[0], chunks[0]])).toContain('Duplicate durable chunk index 0');
    expect(compareChunks(chunks, [chunks[0], { ...chunks[1], sha256: 'replacement' }])).toContain('Previously durable chunk changed: 1');
    expect(() => assertSyntheticPath(path.resolve('outside-harness.webm'))).toThrow('synthetic');
  });

  it('allows partial coded boundary frames and rejects unidentified leading or trailing gaps', () => {
    const good = { sourceOffsetS: 2.08, firstFrame: 4, lastFrame: 94, durationS: 45 };
    expect(prefixEndpointCoverage(good).problems).toEqual([]);
    expect(prefixEndpointCoverage({ ...good, firstFrame: 9 }).problems).toContain('Recovered prefix begins with excessive unidentified audio');
    expect(prefixEndpointCoverage({ ...good, lastFrame: 89 }).problems).toContain('Recovered prefix ends with excessive unidentified audio');
    expect(prefixEndpointCoverage({ ...good, sourceOffsetS: null }).problems).toHaveLength(1);
  });
});
