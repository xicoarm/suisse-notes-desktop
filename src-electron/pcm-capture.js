'use strict';

const fs = require('fs');
const { Writable } = require('stream');
const { finished } = require('stream/promises');
const { performance } = require('perf_hooks');
const path = require('path');
const durableFiles = require('./durable-files');

// Supervise AudioTee without Electron dependencies so disk failures, partial
// stderr lines, late stdout and termination escalation can be tested on both OSes.
// Optional evidence adapter methods return promises (or { success: false }).
// The caller durably reserves its attempt BEFORE spawning proc. Supply the
// original requestStartedAt so reservation/spawn latency stays in elapsedMs.
// All observations approximate source placement; none identifies first sample
// capture time. onClosed runs only after disk and evidence completion barriers.
function createPcmCapture({ process: proc, filePath, offsetMs = 0, onData = () => {}, onFailure = () => {}, onClosed = () => {}, startupTimeoutMs = 10000, killTimeoutMs = 3000,
  evidence = null, now = () => performance.now(), requestStartedAt = now(), activeOffsetMs = null }) {
  let paused = false;
  let stopping = false;
  let closed = false;
  let failure = null;
  let stopPromise = null;
  let file;
  let lastSync = null;
  let directorySynced = false;
  let writtenBytes = 0;
  let pauseStartedAt = null;
  let pausedMs = 0;
  let frozenOffset = null;
  let evidenceQueue = Promise.resolve();
  let finishPromise = null;
  let firstDataEvidence = null;
  const observedEvents = new Set();
  const elapsed = () => Math.max(0, now() - requestStartedAt);
  const activeOffset = () => frozenOffset ?? (activeOffsetMs ? activeOffsetMs() :
    offsetMs + elapsed() - pausedMs - (pauseStartedAt === null ? 0 : Math.max(0, now() - pauseStartedAt)));
  const freezeOffset = () => { frozenOffset ??= activeOffset(); };
  let settleStart;
  let settledStart = false;
  const started = new Promise(resolve => { settleStart = resolve; });
  const startResult = result => {
    if (settledStart) return;
    settledStart = true;
    clearTimeout(startupTimer);
    settleStart(result);
  };
  const fail = (error, stage = 'capture') => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    if (evidence && stage !== 'evidence-failure') {
      queueEvidence('failure', [failure, { stage, elapsedMs: elapsed() }]);
    }
    startResult({ success: false, error: failure.message });
    // Main's callback may call stop(). Never await it here: stop waits for
    // disk/evidence, including the operation that discovered this failure.
    try { Promise.resolve(onFailure(failure)).catch(() => {}); } catch (_) { /* diagnostics */ }
    if (!closed) { try { proc.kill('SIGTERM'); } catch (_) { /* stop owns escalation */ } }
  };
  function queueEvidence(method, args) {
    if (!evidence) return Promise.resolve();
    const operation = evidenceQueue.then(async () => {
      if (typeof evidence[method] !== 'function') throw new Error(`PCM evidence adapter is missing ${method}`);
      const result = await evidence[method](...args);
      if (result?.success === false) throw Object.assign(new Error(result.error || `PCM ${method} evidence could not be saved`), { code: result.code });
    });
    // The queue remains drainable after failure, allowing the failure/end
    // sidecars to be attempted without losing the first capture error.
    evidenceQueue = operation.catch(error => { fail(error, `evidence-${method}`); });
    return evidenceQueue;
  }
  function observe(name, details = {}) {
    if (observedEvents.has(name)) return evidenceQueue;
    observedEvents.add(name);
    return queueEvidence('event', [name, { elapsedMs: elapsed(), activeOffsetMs: activeOffset(), ...details }]);
  }
  async function drainEvidence() {
    let pending;
    do { pending = evidenceQueue; await pending; } while (pending !== evidenceQueue);
  }
  const startupTimer = setTimeout(() => fail(new Error('System audio did not start within 10 seconds')), startupTimeoutMs);
  const fileReady = fs.promises.open(filePath, 'a+').then(async handle => {
    file = handle;
    const size = (await file.stat()).size;
    const targetBytes = Math.max(0, Math.floor(offsetMs)) * 96; // 48kHz mono s16le
    if (targetBytes > size) await file.truncate(targetBytes); // sparse zero padding
    return file;
  });
  // Attach a rejection observer immediately, even if the child never sends PCM.
  fileReady.catch(fail);
  const sink = new Writable({
    highWaterMark: 64 * 1024,
    write(bytes, encoding, done) {
      (async () => {
        await fileReady;
        await file.writeFile(bytes);
        writtenBytes += bytes.length;
        const syncAt = now();
        if (lastSync === null || syncAt - lastSync >= 1000) {
          await file.sync();
          if (!directorySynced) {
            durableFiles.syncDirectorySync(path.dirname(filePath));
            directorySynced = true;
          }
          lastSync = syncAt;
        }
        if (firstDataEvidence) await firstDataEvidence;
        if (!failure) startResult({ success: true, filePath });
        try { onData(bytes); } catch (_) { /* signal analysis never breaks capture */ }
      })().then(() => done(), done);
    },
    final(done) {
      (async () => { await fileReady; await file.sync(); await file.close(); file = null; })().then(() => done(), done);
    },
    destroy(error, done) {
      (async () => {
        await fileReady.catch(() => {});
        if (file) { await file.close().catch(() => {}); file = null; }
      })().then(() => done(error), done);
    },
  });
  const saved = finished(sink).then(() => ({ success: true, filePath }), error => {
    fail(error);
    return { success: false, error: error.message, filePath };
  });
  // Decide pause inclusion when bytes arrive, before asynchronous disk writes.
  // Accepted pre-pause bytes remain queued; paused bytes never enter the queue.
  proc.stdout.on('data', bytes => {
    if (paused || sink.destroyed) return;
    if (bytes.length && !firstDataEvidence) firstDataEvidence = observe('first-data', { byteLength: bytes.length });
    if (!sink.write(bytes)) proc.stdout.pause();
  });
  sink.on('drain', () => proc.stdout.resume());
  proc.stdout.on('end', () => { if (!sink.writableEnded && !sink.destroyed) sink.end(); });
  proc.stdout.on('error', error => sink.destroy(error));
  let stderr = '';
  proc.stderr.on('data', bytes => {
    stderr += bytes.toString('utf8');
    let newline;
    while ((newline = stderr.indexOf('\n')) >= 0) {
      const line = stderr.slice(0, newline);
      stderr = stderr.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (event.message_type === 'stream_start') {
          Promise.all([fileReady, observe('stream-start')]).then(() => {
            if (!failure) startResult({ success: true, filePath });
          }, fail);
        }
        if (event.message_type === 'error') fail(new Error(event.data?.message || 'System audio capture error'));
      } catch (_) { /* ordinary diagnostic text */ }
    }
    if (stderr.length > 65536) stderr = stderr.slice(-65536);
  });
  proc.on('error', fail);
  proc.once('spawn', () => { observe('spawned'); });
  let resolveClosed;
  const childClosed = new Promise(resolve => { resolveClosed = resolve; });
  async function finish(result) {
    if (!finishPromise) finishPromise = (async () => {
      await drainEvidence();
      if (evidence && !failure && (!writtenBytes || writtenBytes % 2 !== 0)) {
        fail(new Error(writtenBytes ? 'System audio ended with an incomplete PCM sample' : 'System audio stopped without saving audio'), 'pcm-extent');
      }
      await drainEvidence();
      await queueEvidence('finish', [{ success: !failure && result.success && closed,
        childClosed: closed, diskDrained: result.success, endOffsetMs: activeOffset(), elapsedMs: elapsed(),
        reason: failure ? 'capture-failed' : stopping ? 'stopped' : 'unexpected-close' }]);
      await drainEvidence();
      return failure ? { success: false, error: failure.message, code: failure.code, filePath } : result;
    })();
    return finishPromise;
  }
  const fullyClosed = childClosed.then(async () => {
    const result = await finish(await saved);
    try { onClosed(); } catch (_) { /* diagnostics */ }
    return result;
  });
  proc.once('close', () => {
    closed = true;
    freezeOffset();
    clearTimeout(startupTimer);
    if (!stopping) fail(new Error('System audio capture stopped unexpectedly'));
    // A closed process can leave unread PCM buffered in a paused stdout
    // stream. Its normal end handler owns sink.end() after those bytes drain.
    // Ending the sink here suppresses drain/resume and silently loses the tail.
    if (proc.stdout.readableEnded && !sink.writableEnded && !sink.destroyed) sink.end();
    resolveClosed();
  });

  async function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    freezeOffset();
    if (!closed) observe('stop-requested');
    clearTimeout(startupTimer);
    startResult({ success: false, error: 'System audio stopped before startup completed' });
    stopPromise = Promise.resolve().then(async () => {
      if (!closed) {
        // killed only means a signal was SENT. It does not mean the process
        // exited. Always escalate if close has not arrived by the deadline.
        const killTimer = setTimeout(() => { if (!closed) proc.kill('SIGKILL'); }, killTimeoutMs);
        let timeout;
        try {
          proc.kill('SIGTERM');
          await Promise.race([
            childClosed,
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('System audio process did not terminate')), killTimeoutMs + 3000); }),
          ]);
        } catch (error) {
          fail(error);
          sink.destroy(error);
        } finally { clearTimeout(killTimer); clearTimeout(timeout); }
      }
      return closed ? fullyClosed : finish(await saved);
    });
    return stopPromise;
  }
  return { started, stop, setPaused: value => {
    const next = !!value;
    if (next && !paused) pauseStartedAt = now();
    if (!next && paused && pauseStartedAt !== null) { pausedMs += Math.max(0, now() - pauseStartedAt); pauseStartedAt = null; }
    paused = next;
    if (paused) proc.stdout.resume();
  }, get paused() { return paused; }, filePath, process: proc };
}

module.exports = { createPcmCapture };
