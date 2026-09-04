// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { AppDriver, installSyntheticCaptureProbe } = require('../e2e-harness/lib/app-driver');
const { killOwnedApp, snapshotChunks, compareChunks, prefixEndpointCoverage, assertSyntheticPath,
  parseCrashOptions, captureTimingEvidence, tailExposureProblems } = require('../e2e-harness/crash-qualification');
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

function probeFixture() {
  const nativeStart = vi.fn().mockReturnValue({ nativeReturn: true });
  const receivers = [];
  let clock = 125.5;
  class Recorder {
    constructor() {
      this.state = 'inactive';
      this.stream = { getAudioTracks: () => [] };
      this.handlers = new Map();
    }
    addEventListener(type, callback) { this.handlers.set(type, callback); }
    start(...args) {
      receivers.push(this);
      const result = nativeStart.apply(this, args);
      this.state = 'recording';
      return result;
    }
    emit(type, fields = {}) { this.handlers.get(type)?.({ target: this, ...fields }); }
  }
  const context = { window: { MediaRecorder: Recorder }, MediaRecorder: Recorder,
    performance: { now: () => clock }, document: { visibilityState: 'visible' }, console: { debug: vi.fn() } };
  vm.runInNewContext('(' + installSyntheticCaptureProbe.toString() + ')()', context);
  return { Recorder, nativeStart, receivers, context, setTime: time => { clock = time; }, snapshot: () => context.window.__suisseCaptureDiagnostics.snapshot() };
}

describe('passive native recording provenance', () => {
  it.each([1000, 3000])('observes %ims without changing native arguments, receiver or return value', timeslice => {
    const fixture = probeFixture(), recorder = new fixture.Recorder();
    const extraArgument = { marker: 'unchanged' };
    const returned = recorder.start(timeslice, extraArgument);
    expect(fixture.nativeStart).toHaveBeenCalledWith(timeslice, extraArgument);
    expect(fixture.receivers[0]).toBe(recorder);
    expect(returned).toBe(fixture.nativeStart.mock.results[0].value);
    expect(fixture.snapshot().recorders[0]).toMatchObject({ requestedTimesliceMs: timeslice, startCalledAt: 125.5, successfulStartCalls: 1 });
  });

  it('preserves omitted/non-numeric arguments without inventing a numeric source policy', () => {
    const fixture = probeFixture(), omitted = new fixture.Recorder(), nonnumeric = new fixture.Recorder();
    omitted.start();
    nonnumeric.start('1000');
    expect(fixture.nativeStart.mock.calls).toEqual([[], ['1000']]);
    expect(fixture.snapshot().recorders.map(recorder => recorder.requestedTimesliceMs)).toEqual([null, null]);
  });

  it('preserves native exceptions and does not replace the last successful start evidence', () => {
    const fixture = probeFixture(), recorder = new fixture.Recorder();
    recorder.start(1000);
    const failure = new Error('native start failed');
    fixture.nativeStart.mockImplementationOnce(() => { throw failure; });
    fixture.setTime(999);
    expect(() => recorder.start(3000)).toThrow(failure);
    expect(fixture.snapshot().recorders[0]).toMatchObject({ requestedTimesliceMs: 1000, startCalledAt: 125.5, successfulStartCalls: 1 });
  });

  it('uses observed event timing rather than requested seconds to measure native elapsed and last-data age', () => {
    const fixture = probeFixture(), recorder = new fixture.Recorder();
    recorder.start(1000);
    recorder.emit('start', { timeStamp: 200 });
    fixture.setTime(51200);
    recorder.emit('dataavailable', { data: { size: 1024 } });
    fixture.setTime(51750);
    const evidence = captureTimingEvidence({ capture: fixture.snapshot() }, 1000);
    expect(evidence).toMatchObject({ observedTimesliceMs: 1000, nativeElapsedS: 51.55, lastDataAgeS: 0.55, problems: [] });
  });
});

describe('fractional crash requests and explicit limits', () => {
  it('keeps the historical defaults and rounds only the spare reference to complete coded frames', () => {
    expect(parseCrashOptions()).toEqual({ seconds: 50, expectedTimesliceMs: null, maxTailExposureS: 4.5, referenceSeconds: 75 });
    for (const seconds of [45, 50.15, 50.5, 50.85, 60]) {
      const options = parseCrashOptions({ seconds, expectedTimesliceMs: 1000, maxTailExposureS: 1.25 });
      expect(options.seconds).toBe(seconds);
      expect(options.referenceSeconds).toBeGreaterThanOrEqual(seconds + 25);
      expect(options.referenceSeconds * 2).toBe(Math.floor(options.referenceSeconds * 2));
      expect(options.referenceSeconds - (seconds + 25)).toBeLessThan(0.5);
    }
  });

  it.each([44.99, 60.01, NaN, Infinity, '50.5'])('rejects invalid capture duration %s before launching', seconds => {
    expect(() => parseCrashOptions({ seconds })).toThrow('45–60');
  });

  it.each([{ expectedTimesliceMs: 0 }, { expectedTimesliceMs: 1000.5 }, { expectedTimesliceMs: '1000' },
    { maxTailExposureS: -1 }, { maxTailExposureS: NaN }, { maxTailExposureS: Infinity }])('rejects invalid limit %j', options => {
    expect(() => parseCrashOptions(options)).toThrow();
  });

  it('fails an expected one-second policy when the app actually requested three seconds or no evidence exists', () => {
    const before = { capture: { at: 52000, recorders: [{ startedAt: 1000, lastDataAt: 50000, requestedTimesliceMs: 3000 }] } };
    expect(captureTimingEvidence(before, 1000).problems).toEqual(['Observed MediaRecorder timeslice 3000ms differs from expected 1000ms']);
    expect(captureTimingEvidence({}, 1000).problems).toEqual(['Observed MediaRecorder timeslice unavailable differs from expected 1000ms']);
    expect(captureTimingEvidence(before).problems).toEqual([]);
  });

  it('applies an explicit tighter measured-tail limit while preserving the default threshold and separate termination bound', () => {
    const exposure = { notYetDurableSecondsAtLastObservation: 1.3, tailUpperBoundIncludingTerminationDelayS: 1.9 };
    expect(tailExposureProblems(exposure)).toEqual([]);
    expect(tailExposureProblems(exposure, 1.25)).toEqual(['Observed undurable tail exceeded the configured 1.25-second limit']);
    expect(tailExposureProblems({ notYetDurableSecondsAtLastObservation: 4.5 })).toEqual([]);
    expect(tailExposureProblems({ notYetDurableSecondsAtLastObservation: 4.5001 })).toHaveLength(1);
    expect(tailExposureProblems({ notYetDurableSecondsAtLastObservation: 0 }, 0)).toEqual([]);
    expect(tailExposureProblems({})).toHaveLength(1);
  });
});

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
