'use strict';

const fs = require('fs');
const { Writable } = require('stream');
const { finished } = require('stream/promises');

// Supervise AudioTee without Electron dependencies so disk failures, partial
// stderr lines, late stdout and termination escalation can be tested on both OSes.
function createPcmCapture({ process: proc, filePath, offsetMs = 0, onData = () => {}, onFailure = () => {}, onClosed = () => {}, startupTimeoutMs = 10000, killTimeoutMs = 3000 }) {
  let paused = false;
  let stopping = false;
  let closed = false;
  let failure = null;
  let stopPromise = null;
  let file;
  let lastSync = 0;
  let settleStart;
  let settledStart = false;
  const started = new Promise(resolve => { settleStart = resolve; });
  const startResult = result => {
    if (settledStart) return;
    settledStart = true;
    clearTimeout(startupTimer);
    settleStart(result);
  };
  const fail = error => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    startResult({ success: false, error: failure.message });
    try { onFailure(failure); } catch (_) { /* diagnostics */ }
    if (!closed) proc.kill('SIGTERM');
  };
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
        if (Date.now() - lastSync >= 1000) {
          await file.sync();
          lastSync = Date.now();
        }
        startResult({ success: true, filePath });
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
        if (event.message_type === 'stream_start') fileReady.then(() => startResult({ success: true, filePath }), fail);
        if (event.message_type === 'error') fail(new Error(event.data?.message || 'System audio capture error'));
      } catch (_) { /* ordinary diagnostic text */ }
    }
    if (stderr.length > 65536) stderr = stderr.slice(-65536);
  });
  proc.on('error', fail);
  let resolveClosed;
  const childClosed = new Promise(resolve => { resolveClosed = resolve; });
  proc.once('close', () => {
    closed = true;
    clearTimeout(startupTimer);
    if (!stopping) fail(new Error('System audio capture stopped unexpectedly'));
    if (!sink.writableEnded && !sink.destroyed) sink.end();
    resolveClosed();
    saved.then(() => { try { onClosed(); } catch (_) { /* diagnostics */ } });
  });

  async function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearTimeout(startupTimer);
    startResult({ success: false, error: 'System audio stopped before startup completed' });
    stopPromise = (async () => {
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
      const result = await saved;
      return failure ? { success: false, error: failure.message, filePath } : result;
    })();
    return stopPromise;
  }
  return { started, stop, setPaused: value => { paused = !!value; if (paused) proc.stdout.resume(); }, get paused() { return paused; }, filePath, process: proc };
}

module.exports = { createPcmCapture };
