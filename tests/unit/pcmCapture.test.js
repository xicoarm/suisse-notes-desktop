// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPcmCapture } = require('../../src-electron/pcm-capture');
const durableFiles = require('../../src-electron/durable-files');
const { beginPcmAttempt, markPcmEvent, recordPcmFailure, endPcmAttempt, inspectPcmCaptureEvidence } = require('../../src-electron/pcm-capture-evidence');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const evidenceAdapter = () => ({ event: vi.fn(async () => ({ success: true })),
  failure: vi.fn(async () => ({ success: true })), finish: vi.fn(async () => ({ success: true })) });

let root;
let captures;
function child() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; return true; });
  proc.close = () => { proc.stdout.end(); proc.emit('close', 0); };
  return proc;
}
function capture(proc, extra = {}) {
  const result = createPcmCapture({ process: proc, filePath: path.join(root, 'system_audio.raw'), ...extra });
  captures.push({ result, proc });
  return result;
}
beforeEach(async () => {
  captures = [];
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-pcm-test-'));
});
afterEach(async () => {
  for (const { result, proc } of captures) { const stopped = result.stop(); proc.close(); await stopped; }
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (!path.resolve(root).startsWith(path.join(os.tmpdir(), 'suisse-pcm-test-'))) throw Error('Unsafe cleanup');
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('macOS PCM capture supervision', () => {
  it('requires a real startup signal, including a JSON line split across stderr events', async () => {
    const proc = child();
    const c = capture(proc);
    let ready = false;
    c.started.then(() => { ready = true; });
    proc.stderr.write('{"message_type":"stream_');
    await Promise.resolve();
    expect(ready).toBe(false);
    proc.stderr.write('start"}\n');
    expect(await c.started).toMatchObject({ success: true });
  });

  it('drains late stdout before returning from stop and flushes every byte', async () => {
    const proc = child();
    const c = capture(proc);
    proc.stdout.write(Buffer.from('first'));
    await c.started;
    const stopped = c.stop();
    // exit can precede stdout closing; late bytes must still be persisted.
    proc.emit('exit', 0);
    proc.stdout.write(Buffer.from('last'));
    proc.close();
    expect(await stopped).toMatchObject({ success: true });
    expect(fs.readFileSync(c.filePath, 'utf8')).toBe('firstlast');
  });

  it('does not record through a user pause', async () => {
    const proc = child();
    const measured = [];
    const c = capture(proc, { onData: bytes => measured.push(bytes.toString()) });
    proc.stdout.write(Buffer.from('before'));
    await c.started;
    c.setPaused(true);
    proc.stdout.write(Buffer.from('private pause'));
    await new Promise(resolve => setImmediate(resolve));
    c.setPaused(false);
    proc.stdout.write(Buffer.from('after'));
    const stopped = c.stop(); proc.close(); await stopped;
    expect(fs.readFileSync(c.filePath, 'utf8')).toBe('beforeafter');
  });

  it('preserves accepted bytes and excludes paused bytes while disk opening is pending', async () => {
    const proc = child(); const c = capture(proc);
    proc.stdout.write(Buffer.from('before'));
    c.setPaused(true);
    proc.stdout.write(Buffer.from('private'));
    c.setPaused(false);
    proc.stdout.write(Buffer.from('after'));
    const stopped = c.stop(); proc.close(); await stopped;
    expect(fs.readFileSync(c.filePath, 'utf8')).toBe('beforeafter');
  });

  it('escalates to SIGKILL even though SIGTERM already set killed=true', async () => {
    const proc = child();
    proc.kill.mockImplementation(signal => {
      proc.killed = true;
      if (signal === 'SIGKILL') proc.close();
      return true;
    });
    const c = capture(proc, { killTimeoutMs: 20 });
    proc.stdout.write(Buffer.from('audio'));
    await c.started;
    await c.stop();
    expect(proc.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports an unexpected child exit instead of leaving capture healthy', async () => {
    const proc = child(); const onFailure = vi.fn();
    const c = capture(proc, { onFailure });
    proc.stdout.write(Buffer.from('audio'));
    await c.started;
    proc.close();
    expect(await c.stop()).toMatchObject({ success: false });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(c.filePath, 'utf8')).toBe('audio');
  });

  it('surfaces a disk-open failure and preserves existing data', async () => {
    const proc = child(); const onFailure = vi.fn();
    const c = capture(proc, { filePath: path.join(root, 'missing', 'audio.raw'), onFailure });
    proc.stdout.write(Buffer.from('audio'));
    expect(await c.started).toMatchObject({ success: false });
    const stopped = c.stop(); proc.close();
    expect(await stopped).toMatchObject({ success: false });
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});

describe('durable PCM capture lifecycle barriers', () => {
  it('retains stdout buffered by disk backpressure even when the child closes before that buffer drains', async () => {
    const proc = child(), evidence = evidenceAdapter(), opened = deferred();
    const handle = await fs.promises.open(path.join(root, 'system_audio.raw'), 'a+');
    vi.spyOn(fs.promises, 'open').mockReturnValue(opened.promise);
    const c = capture(proc, { evidence });
    const first = Buffer.alloc(64 * 1024, 0x11), last = Buffer.alloc(64 * 1024, 0x22);
    proc.stdout.write(first);
    expect(proc.stdout.isPaused()).toBe(true);
    proc.stdout.write(last);
    const stopped = c.stop(); proc.close(); opened.resolve(handle);
    expect(await stopped).toMatchObject({ success: true });
    expect(fs.readFileSync(c.filePath)).toEqual(Buffer.concat([first, last]));
    expect(evidence.finish).toHaveBeenCalledWith(expect.objectContaining({ success: true, childClosed: true, diskDrained: true }));
  });

  it('syncs the containing directory after the first PCM file sync and before acknowledging data', async () => {
    const proc = child(), evidence = evidenceAdapter(), synced = deferred(), ordering = [];
    const handle = { stat: vi.fn(async () => ({ size: 0 })), writeFile: vi.fn(async () => {}),
      sync: vi.fn().mockImplementationOnce(async () => { await synced.promise; ordering.push('file-sync'); }).mockResolvedValue(),
      close: vi.fn(async () => {}) };
    vi.spyOn(fs.promises, 'open').mockResolvedValue(handle);
    const syncDirectory = vi.spyOn(durableFiles, 'syncDirectorySync').mockImplementation(() => ordering.push('directory-sync'));
    const c = capture(proc, { evidence, onData: () => ordering.push('accepted-data-notification') });
    proc.stdout.write(Buffer.from('audio!'));
    await vi.waitFor(() => expect(handle.sync).toHaveBeenCalledOnce());
    expect(syncDirectory).not.toHaveBeenCalled();
    synced.resolve(); await c.started;
    expect(ordering).toEqual(['file-sync', 'directory-sync', 'accepted-data-notification']);
    proc.stdout.write(Buffer.from('later!'));
    const stopped = c.stop(); proc.close(); expect(await stopped).toMatchObject({ success: true });
    expect(syncDirectory).toHaveBeenCalledOnce();
    expect(syncDirectory).toHaveBeenCalledWith(root);
  });

  it('fails capture if the new PCM file directory cannot be synced', async () => {
    const proc = child(), evidence = evidenceAdapter();
    vi.spyOn(durableFiles, 'syncDirectorySync').mockImplementation(() => { throw Object.assign(new Error('Directory sync failed'), { code: 'EIO' }); });
    const c = capture(proc, { evidence }); proc.stdout.write(Buffer.from('audio!'));
    expect(await c.started).toMatchObject({ success: false, error: 'Directory sync failed' });
    const stopped = c.stop(); proc.close();
    expect(await stopped).toMatchObject({ success: false, code: 'EIO' });
    expect(evidence.finish).toHaveBeenCalledWith(expect.objectContaining({ success: false, diskDrained: false }));
    expect(fs.readFileSync(c.filePath, 'utf8')).toBe('audio!');
  });

  it('keeps periodic PCM syncing on a monotonic clock when the system wall clock moves backwards', async () => {
    let clock = 0;
    const proc = child(), onData = vi.fn();
    const handle = { stat: vi.fn(async () => ({ size: 0 })), writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    vi.spyOn(fs.promises, 'open').mockResolvedValue(handle);
    vi.spyOn(durableFiles, 'syncDirectorySync').mockImplementation(() => {});
    vi.spyOn(Date, 'now').mockReturnValue(90000);
    const c = capture(proc, { now: () => clock, onData });
    proc.stdout.write(Buffer.from('first!')); await c.started;
    expect(handle.sync).toHaveBeenCalledOnce();
    clock = 1000; Date.now.mockReturnValue(1);
    proc.stdout.write(Buffer.from('later!'));
    await vi.waitFor(() => expect(onData).toHaveBeenCalledTimes(2));
    expect(handle.sync).toHaveBeenCalledTimes(2);
  });

  it('serializes observations and anchors them to the original request before reservation and spawn', async () => {
    const proc = child(), evidence = evidenceAdapter(), spawned = deferred();
    // Windows cannot ftruncate an append-only descriptor. Existing extent
    // isolates this clock test from the macOS-only sparse padding operation.
    fs.writeFileSync(path.join(root, 'system_audio.raw'), Buffer.alloc(200 * 96));
    evidence.event.mockImplementationOnce(() => spawned.promise);
    let clock = 35;
    const c = capture(proc, { evidence, now: () => clock, requestStartedAt: 10, offsetMs: 200 });
    proc.emit('spawn');
    clock = 50; proc.stderr.write('{"message_type":"stream_start"}\n');
    clock = 75; proc.stdout.write(Buffer.from('audio!'));
    await turn();
    expect(evidence.event).toHaveBeenCalledTimes(1);
    let ready = false; c.started.then(() => { ready = true; });
    expect(ready).toBe(false);
    spawned.resolve({ success: true });
    expect(await c.started).toEqual({ success: true, filePath: c.filePath });
    await turn();
    expect(evidence.event.mock.calls).toEqual([
      ['spawned', { elapsedMs: 25, activeOffsetMs: 225 }],
      ['stream-start', { elapsedMs: 40, activeOffsetMs: 240 }],
      ['first-data', { elapsedMs: 65, activeOffsetMs: 265, byteLength: 6 }],
    ]);
    clock = 100; const stopped = c.stop(); proc.close();
    expect(await stopped).toMatchObject({ success: true });
    expect(evidence.event).toHaveBeenLastCalledWith('stop-requested', { elapsedMs: 90, activeOffsetMs: 290 });
  });

  it('requires child close, final fsync, file close and the durable finish acknowledgement before clearing capture', async () => {
    const proc = child(), evidence = evidenceAdapter(), synced = deferred(), fileClosed = deferred(), terminal = deferred();
    const handle = { stat: vi.fn(async () => ({ size: 0 })), writeFile: vi.fn(async () => {}),
      sync: vi.fn().mockResolvedValueOnce().mockImplementationOnce(() => synced.promise), close: vi.fn(() => fileClosed.promise) };
    vi.spyOn(fs.promises, 'open').mockResolvedValue(handle);
    evidence.finish.mockImplementation(() => terminal.promise);
    const onClosed = vi.fn(), c = capture(proc, { evidence, onClosed });
    proc.emit('spawn'); proc.stdout.write(Buffer.from('audio!')); await c.started;
    const stopped = c.stop(); proc.stdout.end(); proc.emit('exit', 0);
    await vi.waitFor(() => expect(handle.sync).toHaveBeenCalledTimes(2));
    expect(handle.close).not.toHaveBeenCalled(); expect(evidence.finish).not.toHaveBeenCalled();
    synced.resolve(); await vi.waitFor(() => expect(handle.close).toHaveBeenCalledOnce());
    expect(evidence.finish).not.toHaveBeenCalled();
    fileClosed.resolve(); await turn();
    expect(evidence.finish).not.toHaveBeenCalled(); // stdout/disk completion alone is insufficient.
    proc.close(); await vi.waitFor(() => expect(evidence.finish).toHaveBeenCalledOnce());
    expect(evidence.finish).toHaveBeenCalledWith(expect.objectContaining({ success: true, childClosed: true, diskDrained: true }));
    expect(onClosed).not.toHaveBeenCalled();
    terminal.resolve({ success: true });
    expect(await stopped).toMatchObject({ success: true }); expect(onClosed).toHaveBeenCalledOnce();
  });

  it('observes the first accepted bytes before disk scheduling and excludes intentionally paused input', async () => {
    const proc = child(), evidence = evidenceAdapter(), opened = deferred();
    fs.writeFileSync(path.join(root, 'system_audio.raw'), Buffer.alloc(200 * 96));
    const handle = await fs.promises.open(path.join(root, 'system_audio.raw'), 'a+');
    vi.spyOn(fs.promises, 'open').mockReturnValue(opened.promise);
    let clock = 10;
    const c = capture(proc, { evidence, now: () => clock, requestStartedAt: 0, offsetMs: 200 });
    clock = 20; c.setPaused(true); proc.stdout.write(Buffer.from('private paused input'));
    clock = 60; c.setPaused(false);
    clock = 80; proc.stdout.write(Buffer.from('audio!'));
    await turn();
    expect(evidence.event).toHaveBeenCalledWith('first-data', { elapsedMs: 80, activeOffsetMs: 240, byteLength: 6 });
    expect(evidence.event.mock.calls.filter(call => call[0] === 'first-data')).toHaveLength(1);
    clock = 1000; opened.resolve(handle); await c.started;
    const stopped = c.stop(); proc.close(); expect(await stopped).toEqual({ success: true, filePath: c.filePath });
    expect(fs.readFileSync(c.filePath).subarray(200 * 96).toString()).toBe('audio!');
  });

  it('latches a failed evidence event and safely supports an onFailure callback that calls stop', async () => {
    const proc = child(), evidence = evidenceAdapter();
    evidence.event.mockResolvedValueOnce({ success: false, code: 'ENOSPC', error: 'Evidence disk full' });
    proc.kill.mockImplementation(() => { queueMicrotask(() => proc.close()); return true; });
    let c;
    const onFailure = vi.fn(() => c.stop());
    c = capture(proc, { evidence, onFailure }); proc.emit('spawn');
    expect(await c.started).toMatchObject({ success: false, error: 'Evidence disk full' });
    expect(await c.stop()).toMatchObject({ success: false, code: 'ENOSPC', error: 'Evidence disk full' });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(evidence.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOSPC' }), expect.objectContaining({ stage: 'evidence-event' }));
    expect(evidence.finish).toHaveBeenCalledWith(expect.objectContaining({ success: false, childClosed: true }));
  });

  it('persists unexpected-close failure and its terminal result before onClosed runs', async () => {
    const proc = child(), evidence = evidenceAdapter(), failed = deferred(), ended = deferred(), onClosed = vi.fn();
    evidence.failure.mockImplementation(() => failed.promise); evidence.finish.mockImplementation(() => ended.promise);
    const c = capture(proc, { evidence, onClosed });
    proc.stdout.write(Buffer.from('audio!')); await c.started; proc.close();
    const stopped = c.stop();
    await vi.waitFor(() => expect(evidence.failure).toHaveBeenCalledOnce());
    expect(onClosed).not.toHaveBeenCalled(); expect(evidence.finish).not.toHaveBeenCalled();
    failed.resolve({ success: true });
    await vi.waitFor(() => expect(evidence.finish).toHaveBeenCalledOnce());
    expect(evidence.finish).toHaveBeenCalledWith(expect.objectContaining({ success: false, childClosed: true, diskDrained: true }));
    expect(onClosed).not.toHaveBeenCalled(); ended.resolve({ success: true });
    expect(await stopped).toMatchObject({ success: false }); expect(onClosed).toHaveBeenCalledOnce();
  });

  it('keeps the capture failed if writing its failure evidence also rejects', async () => {
    const proc = child(), evidence = evidenceAdapter();
    evidence.failure.mockRejectedValue(new Error('Cannot write failure evidence'));
    const c = capture(proc, { evidence });
    proc.stdout.write(Buffer.from('audio!')); await c.started; proc.close();
    expect(await c.stop()).toMatchObject({ success: false, error: 'System audio capture stopped unexpectedly' });
    expect(evidence.failure).toHaveBeenCalledOnce();
    expect(evidence.finish).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('records a child process error before reporting closure', async () => {
    const proc = child(), evidence = evidenceAdapter(), onClosed = vi.fn();
    const c = capture(proc, { evidence, onClosed });
    proc.stdout.write(Buffer.from('audio!')); await c.started;
    proc.emit('error', Object.assign(new Error('Child pipe failed'), { code: 'EPIPE' }));
    const stopped = c.stop(); proc.close();
    expect(await stopped).toMatchObject({ success: false, code: 'EPIPE' });
    expect(evidence.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'EPIPE' }), expect.any(Object));
    expect(evidence.finish).toHaveBeenCalledWith(expect.objectContaining({ success: false, childClosed: true, diskDrained: true }));
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('cannot publish success when process termination never confirms close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const proc = child(), evidence = evidenceAdapter(), onClosed = vi.fn();
    const c = capture(proc, { evidence, onClosed, killTimeoutMs: 20 });
    proc.stdout.write(Buffer.from('audio!')); await c.started;
    const stopped = c.stop(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3020);
    expect(await stopped).toMatchObject({ success: false, error: 'System audio process did not terminate' });
    expect(evidence.finish).toHaveBeenCalledWith(expect.objectContaining({ success: false, childClosed: false, diskDrained: false }));
    expect(onClosed).not.toHaveBeenCalled();
    proc.close(); await turn(); expect(onClosed).toHaveBeenCalledOnce();
  });

  it('blocks successful stop and onClosed until a failed final evidence write is recorded', async () => {
    const proc = child(), evidence = evidenceAdapter(), failed = deferred(), onClosed = vi.fn();
    evidence.finish.mockResolvedValue({ success: false, error: 'Terminal evidence failed' });
    evidence.failure.mockImplementation(() => failed.promise);
    const c = capture(proc, { evidence, onClosed });
    proc.stdout.write(Buffer.from('audio!')); await c.started;
    const stopped = c.stop(); proc.close();
    await vi.waitFor(() => expect(evidence.failure).toHaveBeenCalledOnce());
    expect(onClosed).not.toHaveBeenCalled(); failed.resolve({ success: true });
    expect(await stopped).toMatchObject({ success: false, error: 'Terminal evidence failed' });
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('does not report an empty or partial-sample PCM attempt as successful', async () => {
    for (const content of ['', 'odd']) {
      const proc = child(), evidence = evidenceAdapter(), c = capture(proc, { evidence });
      proc.stderr.write('{"message_type":"stream_start"}\n'); await c.started;
      if (content) proc.stdout.write(Buffer.from(content));
      const stopped = c.stop(); proc.close();
      expect(await stopped).toMatchObject({ success: false });
      expect(evidence.finish).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    }
  });

  it('publishes a real successful PCM sidecar only after complete bytes and lifecycle evidence exist', async () => {
    const attemptId = '510485ee-b250-490c-a2c7-7a467bb8ec13';
    await beginPcmAttempt(root, { attemptId, required: true, requestOffsetMs: 0, requestedAt: '2026-09-05T12:00:00.000Z' });
    const evidence = {
      event: (event, details) => markPcmEvent(root, attemptId, { event, ...details }),
      failure: (error, details) => recordPcmFailure(root, attemptId, { ...details, message: error.message, code: error.code || '' }),
      finish: details => endPcmAttempt(root, attemptId, details),
    };
    const proc = child(); let clock = 20, atClosed;
    const c = capture(proc, { evidence, offsetMs: 0, requestStartedAt: 0, now: () => clock,
      onClosed: () => { atClosed = inspectPcmCaptureEvidence(root); } });
    proc.emit('spawn'); clock = 30; proc.stderr.write('{"message_type":"stream_start"}\n');
    clock = 50; proc.stdout.write(Buffer.from('abcdefgh')); await c.started;
    clock = 80; const stopped = c.stop(); proc.close();
    expect(await stopped).toEqual({ success: true, filePath: c.filePath });
    expect(atClosed).toMatchObject({ complete: true, canFinalize: true, required: true });
    expect(atClosed.attempts[0].events['first-data']).toMatchObject({ elapsedMs: 50, activeOffsetMs: 50, byteLength: 8 });
    expect(atClosed.attempts[0].end).toMatchObject({ success: true, childClosed: true, diskDrained: true, audioBytes: 8, pcmEndBytes: 8 });
  });
});
