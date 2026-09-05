import { v4 as uuidv4 } from 'uuid';
import { createRecordingChunkWriter } from './recordingChunkWriter';

/**
 * Desktop native source archive. Owns recorders and writers, NEVER source tracks.
 *
 * bridge: beginSource(recordId, descriptor), markSourceStarted(recordId, sourceId,
 * {startOffsetMs}), saveSourceChunk(recordId, sourceId, bytes, index), and
 * endSource(recordId, sourceId, {endOffsetMs, chunkCount, reason}). Each resolves
 * {success,error}. Source writes must be idempotent for their identity/index.
 *
 * attach(kind, stream) prepares a replacement before retiring the previous epoch;
 * its result includes the actual recorder.start() call offset (the cut). Source
 * tracks are shared, so existing enabled/mute changes apply without cloning.
 * pause ends epochs; attach while paused only selects a source; resume starts
 * fresh epochs. stop blocks further mutation, waits final events and durable
 * writes; retry resumes failed writes/terminal metadata without restarting audio.
 * cancel is explicit discard: revokes late work and waits in-flight writes before
 * returning, after which the caller may delete storage. flush requests receipts
 * from every live source. getState exposes immutable diagnostics.
 *
 * activeOffsetMs must use the meeting's active timeline (excluding pauses).
 * A start-call offset removes manifest-I/O latency, but is NOT proof of exact
 * first-sample timing; native scheduling/packet onset still needs qualification.
 */
export function createNativeSourceRecorder({
  recordId, bridge, MediaRecorder: Recorder = globalThis.MediaRecorder,
  MediaStream: Stream = globalThis.MediaStream, now = () => performance.now(),
  activeOffsetMs = now, createSourceId = uuidv4, onFatal = () => {},
  mimeType = 'audio/webm;codecs=opus', timesliceMs = 1000,
  stopTimeoutMs = 10000, flushTimeoutMs = 6000,
  maxPendingBytes = 16 * 1024 * 1024, maxPendingMs = 15000,
}) {
  if (!recordId || !bridge || ['beginSource', 'markSourceStarted', 'saveSourceChunk', 'endSource']
    .some(method => typeof bridge[method] !== 'function')) throw new Error('Native source persistence bridge is incomplete');
  if (typeof mimeType !== 'string' || !mimeType.startsWith('audio/')) {
    throw new Error('Native source capture requires an explicit audio MIME type');
  }
  let phase = 'open', generation = 0, fatalError = null, serial = Promise.resolve();
  let completion = null, cancellation = null, pressureTimer = null;
  const selected = new Map(), active = new Map(), epochs = new Set(), selectionGeneration = new Map();
  const offset = () => {
    const value = activeOffsetMs();
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid native-source timeline offset');
    return value;
  };
  const failed = error => ({ success: false, error: String(error?.message || error?.error || error).slice(0, 2000) });
  const checked = result => {
    if (result?.success !== true) throw Object.assign(new Error(result?.error || 'Native source could not be saved'), result || {});
    return result;
  };
  const enqueue = operation => {
    const result = serial.then(operation);
    serial = result.catch(() => {});
    return result;
  };
  const canMutate = () => phase === 'open' || phase === 'paused';
  const blocked = () => ({ success: false, error: 'Native source archive is closing or discarded' });

  function fatal(error, epoch = null) {
    if (phase === 'cancelled' || fatalError) return;
    fatalError = { ...failed(error), sourceId: epoch?.sourceId || null };
    if (typeof error?.code === 'string') fatalError.code = error.code.slice(0, 64);
    if (error?.diskFull || error?.code === 'ENOSPC') fatalError.diskFull = true;
    if (error?.backpressure === true) fatalError.backpressure = true;
    for (const field of ['pendingBytes', 'pendingCount', 'oldestPendingMs']) {
      if (Number.isFinite(error?.[field]) && error[field] >= 0) fatalError[field] = error[field];
    }
    try { onFatal({ ...fatalError }); } catch (_) { /* diagnostics cannot interrupt preservation */ }
    // Stop immediately even if there is no page-level listener. Final blobs still
    // join their epoch writer; the hook is not responsible for bounding capture.
    try { void stop().catch(() => {}); } catch (_) { /* caller can inspect the latched fatal state */ }
  }

  function pressure() {
    clearTimeout(pressureTimer);
    pressureTimer = null;
    if (phase === 'cancelled' || fatalError) return;
    let bytes = 0, age = 0, count = 0;
    for (const epoch of epochs) {
      bytes += epoch.writer.pendingBytes;
      count += epoch.writer.pendingCount;
      age = Math.max(age, epoch.writer.oldestPendingMs);
    }
    if (bytes >= maxPendingBytes || (count > 0 && age >= maxPendingMs)) {
      fatal(Object.assign(new Error('Native audio saving is falling behind'), {
        backpressure: true, pendingBytes: bytes, pendingCount: count, oldestPendingMs: age,
      }));
    } else if (count > 0) pressureTimer = setTimeout(pressure, Math.max(1, maxPendingMs - age));
  }

  async function markStarted(epoch, retry = false) {
    if (epoch.marked) return { success: true };
    if (epoch.markFailure && !retry) throw epoch.markFailure;
    if (!epoch.markPromise) {
      epoch.markFailure = null;
      epoch.markPromise = Promise.resolve().then(() => bridge.markSourceStarted(recordId, epoch.sourceId,
        { startOffsetMs: epoch.startOffsetMs })).then(checked).then(result => {
        epoch.marked = true;
        return result;
      }).catch(error => {
        epoch.markFailure = error;
        fatal(error, epoch);
        throw error;
      }).finally(() => { epoch.markPromise = null; });
    }
    return epoch.markPromise;
  }

  function requestStop(epoch, reason, cut = null) {
    if (epoch.stopRequested) return;
    epoch.stopRequested = true;
    epoch.endOffsetMs = cut ?? offset();
    epoch.reason = reason;
    if (!epoch.started) return;
    try {
      // Native state becomes inactive BEFORE final data/stop are dispatched.
      if (epoch.recorder.state !== 'inactive') epoch.recorder.stop();
    } catch (error) { epoch.stopError = error; fatal(error, epoch); }
  }

  function waitForStop(epoch) {
    if (!epoch.started || epoch.stopObserved) return Promise.resolve({ success: true });
    return new Promise(resolve => {
      const finish = result => {
        clearTimeout(timer);
        epoch.stopWaiters.delete(finish);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ success: false, error: 'Native source has not delivered its final audio' }), stopTimeoutMs);
      epoch.stopWaiters.add(finish);
    });
  }

  async function finishEpoch(epoch, retry = false) {
    if (epoch.ended) return { success: true };
    // A failed IPC reply does not prove reservation publication failed. Reuse
    // the exact descriptor/identity; never abandon another lane's saved audio.
    if (!epoch.began && epoch.beginFailure && retry) {
      try {
        checked(await bridge.beginSource(recordId, epoch.descriptor));
        epoch.began = true;
        epoch.beginFailure = null;
      } catch (error) { epoch.beginFailure = error; return failed(error); }
    }
    if (!epoch.began) return epoch.beginFailure ? failed(epoch.beginFailure) : { success: true };
    const stopped = await waitForStop(epoch);
    if (!stopped.success) return stopped;
    try {
      if (epoch.started) await markStarted(epoch, retry);
      checked(await epoch.writer.drain({ retry }));
      if (phase === 'cancelled') return blocked();
      checked(await bridge.endSource(recordId, epoch.sourceId, {
        endOffsetMs: epoch.endOffsetMs ?? epoch.reservedOffsetMs,
        chunkCount: epoch.chunkCount, reason: epoch.reason || 'startup-aborted',
      }));
      epoch.ended = true;
      return { success: true };
    } catch (error) { fatal(error, epoch); return failed(error); }
  }

  async function prepare(kind, source, token, selectionToken) {
    const tracks = source?.getAudioTracks?.();
    if (!tracks?.length || tracks.some(track => track.readyState === 'ended')) throw new Error('Native source has no live audio track');
    const epoch = {
      sourceId: createSourceId(), kind, source, reservedOffsetMs: offset(),
      startOffsetMs: null, startEventAt: null, chunkCount: 0,
      began: false, started: false, marked: false, ended: false,
      stopRequested: false, stopObserved: false, stopWaiters: new Set(), flushWaiters: new Set(),
    };
    epoch.writer = createRecordingChunkWriter({ now,
      save: async bytes => {
        try {
          await markStarted(epoch);
          checked(await bridge.saveSourceChunk(recordId, epoch.sourceId, bytes, epoch.chunkCount));
          epoch.chunkCount++;
          return { success: true };
        } catch (error) {
          // Preserve structured IPC errors before the generic writer reduces
          // its failure to retry bookkeeping fields.
          fatal(error, epoch);
          throw error;
        }
      },
      onSaved: pressure,
      onFailure: error => fatal(error, epoch),
    });
    epoch.descriptor = {
      sourceId: epoch.sourceId, kind, startOffsetMs: epoch.reservedOffsetMs,
      mimeType, settings: { ...(tracks[0].getSettings?.() || {}) },
    };
    epochs.add(epoch);
    try {
      checked(await bridge.beginSource(recordId, epoch.descriptor));
      epoch.began = true;
    } catch (error) { epoch.beginFailure = error; fatal(error, epoch); throw error; }
    if (token !== generation || selectionToken !== selectionGeneration.get(kind) || phase !== 'open') {
      requestStop(epoch, 'startup-aborted', epoch.reservedOffsetMs);
      if (phase !== 'cancelled') await finishEpoch(epoch);
      return null;
    }
    try {
      const recorder = new Recorder(new Stream(tracks), mimeType ? { mimeType } : {});
      epoch.recorder = recorder;
      recorder.onstart = () => { epoch.startEventAt = now(); };
      recorder.ondataavailable = event => {
        if (phase === 'cancelled') return;
        const waiters = [...epoch.flushWaiters];
        epoch.flushWaiters.clear();
        const saved = epoch.writer.enqueue(event.data);
        pressure();
        saved.then(result => waiters.forEach(resolve => resolve({ ...result, success: event.data.size > 0 && result.success })));
      };
      recorder.onstop = () => {
        epoch.stopObserved = true;
        epoch.stopWaiters.forEach(resolve => resolve({ success: true }));
        if (!epoch.stopRequested && phase !== 'cancelled') fatal(new Error('Native audio source stopped unexpectedly'), epoch);
      };
      recorder.onerror = event => fatal(event.error || new Error('Native source recorder failed'), epoch);
      epoch.startOffsetMs = offset();
      epoch.startCallAt = now();
      epoch.started = true;
      try { recorder.start(timesliceMs); }
      catch (error) { epoch.started = false; throw error; }
      // A synchronous test/native event may already have begun this marker.
      await markStarted(epoch);
      if (token !== generation || selectionToken !== selectionGeneration.get(kind) || phase !== 'open') {
        requestStop(epoch, 'startup-aborted');
        if (phase !== 'cancelled') await finishEpoch(epoch);
        return null;
      }
      return epoch;
    } catch (error) {
      requestStop(epoch, 'startup-failed');
      fatal(error, epoch);
      throw error;
    }
  }

  async function attachInternal(kind, source, token, selectionToken) {
    if (!canMutate() || token !== generation || selectionToken !== selectionGeneration.get(kind)) return blocked();
    if (!['microphone', 'system'].includes(kind)) return failed(new Error('Unsupported native source kind'));
    const previous = active.get(kind);
    if (selected.get(kind) === source && (previous || phase === 'paused')) return { success: true, unchanged: true };
    if (phase === 'paused') { selected.set(kind, source); return { success: true, paused: true }; }
    try {
      const next = await prepare(kind, source, token, selectionToken);
      if (!next) {
        if (phase === 'paused' && token === generation && selectionToken === selectionGeneration.get(kind)) {
          selected.set(kind, source);
          return { success: true, paused: true };
        }
        return blocked();
      }
      selected.set(kind, source);
      active.set(kind, next);
      if (previous) {
        requestStop(previous, 'replacement', next.startOffsetMs);
        const retired = await finishEpoch(previous);
        if (!retired.success) { fatal(new Error(retired.error), previous); return retired; }
      }
      return { success: true, sourceId: next.sourceId, startOffsetMs: next.startOffsetMs, previousSourceId: previous?.sourceId || null };
    } catch (error) { return failed(error); }
  }

  function attach(kind, source) {
    if (!canMutate()) return Promise.resolve(blocked());
    const token = generation;
    const selectionToken = (selectionGeneration.get(kind) || 0) + 1;
    selectionGeneration.set(kind, selectionToken);
    return enqueue(() => attachInternal(kind, source, token, selectionToken));
  }

  function detach(kind) {
    if (!canMutate()) return Promise.resolve(blocked());
    const token = generation;
    const selectionToken = (selectionGeneration.get(kind) || 0) + 1;
    selectionGeneration.set(kind, selectionToken); // Revoke a pending source reservation.
    const cut = offset();
    const current = active.get(kind);
    if (current) requestStop(current, 'detached', cut);
    return enqueue(async () => {
      if (!canMutate() || token !== generation || selectionToken !== selectionGeneration.get(kind)) return blocked();
      selected.delete(kind);
      const epoch = active.get(kind);
      active.delete(kind);
      if (!epoch) return { success: true };
      requestStop(epoch, 'detached', cut);
      const result = await finishEpoch(epoch);
      if (!result.success) fatal(new Error(result.error), epoch);
      return result;
    });
  }

  function pause() {
    if (!canMutate()) return Promise.resolve(blocked());
    if (phase === 'paused') return enqueue(() => ({ success: true }));
    phase = 'paused';
    const cut = offset();
    for (const epoch of epochs) if (!epoch.stopRequested) requestStop(epoch, 'paused', cut);
    return enqueue(async () => {
      if (phase !== 'paused') return blocked();
      const results = await Promise.all([...active.values()].map(epoch => finishEpoch(epoch)));
      active.clear();
      const failure = results.find(result => !result.success);
      if (failure) fatal(new Error(failure.error));
      return failure || { success: true };
    });
  }

  function resume() {
    if (!canMutate()) return Promise.resolve(blocked());
    return enqueue(async () => {
      if (phase !== 'paused') return phase === 'open' ? { success: true } : blocked();
      phase = 'open';
      const token = generation;
      for (const [kind, source] of selected) {
        const result = await attachInternal(kind, source, token, selectionGeneration.get(kind));
        if (!result.success) return result;
      }
      return { success: true };
    });
  }

  function stop() {
    if (phase === 'cancelled') return Promise.resolve(blocked());
    if (completion) return completion;
    if (phase === 'closed') return Promise.resolve({ success: true });
    phase = 'closing';
    generation++;
    clearTimeout(pressureTimer);
    for (const epoch of epochs) requestStop(epoch, 'stopped');
    completion = enqueue(async () => {
      const results = await Promise.all([...epochs].map(epoch => finishEpoch(epoch)));
      if (phase === 'cancelled') return blocked();
      const failure = results.find(result => !result.success);
      if (!failure) { phase = 'closed'; active.clear(); selected.clear(); }
      else fatal(new Error(failure.error));
      return failure || { success: true };
    }).finally(() => { completion = null; });
    return completion;
  }

  function retry() {
    if (phase === 'cancelled') return Promise.resolve(blocked());
    if (phase === 'open' || phase === 'paused') return Promise.resolve(failed(new Error('Stop native capture before retrying saved audio')));
    return enqueue(async () => {
      const results = await Promise.all([...epochs].map(epoch => finishEpoch(epoch, true)));
      if (phase === 'cancelled') return blocked();
      const failure = results.find(result => !result.success);
      if (!failure) { phase = 'closed'; active.clear(); selected.clear(); }
      return failure || { success: true };
    });
  }

  function cancel() {
    if (cancellation) return cancellation;
    phase = 'cancelled';
    generation++;
    clearTimeout(pressureTimer);
    for (const epoch of epochs) requestStop(epoch, 'discarded');
    cancellation = enqueue(async () => {
      await Promise.all([...epochs].map(epoch => epoch.writer.drain()));
      for (const epoch of epochs) {
        if (epoch.recorder) {
          epoch.recorder.ondataavailable = epoch.recorder.onstop = epoch.recorder.onerror = epoch.recorder.onstart = null;
        }
        epoch.stopWaiters.forEach(resolve => resolve(blocked()));
        epoch.flushWaiters.forEach(resolve => resolve(blocked()));
      }
      epochs.clear(); active.clear(); selected.clear();
      return { success: true, discarded: true };
    });
    return cancellation;
  }

  async function flush() {
    if (!canMutate()) return blocked();
    const results = await Promise.all([...epochs].map(async epoch => {
      if (!epoch.started || epoch.stopRequested) return epoch.writer.drain();
      return new Promise(resolve => {
        const done = result => { clearTimeout(timer); epoch.flushWaiters.delete(done); resolve(result); };
        const timer = setTimeout(() => done({ success: false, timedOut: true, error: 'Native source flush timed out' }), flushTimeoutMs);
        epoch.flushWaiters.add(done);
        try { epoch.recorder.requestData(); }
        catch (error) { done(failed(error)); }
      });
    }));
    return results.find(result => !result.success) || { success: true };
  }

  function getState() {
    return { phase, fatalError: fatalError && { ...fatalError },
      pendingBytes: [...epochs].reduce((total, epoch) => total + epoch.writer.pendingBytes, 0),
      sources: [...epochs].map(epoch => ({ sourceId: epoch.sourceId, kind: epoch.kind,
        startOffsetMs: epoch.startOffsetMs, endOffsetMs: epoch.endOffsetMs ?? null,
        startCallAt: epoch.startCallAt ?? null, startEventAt: epoch.startEventAt,
        chunkCount: epoch.chunkCount, pendingCount: epoch.writer.pendingCount,
        began: epoch.began, marked: epoch.marked, started: epoch.started,
        stopObserved: epoch.stopObserved, ended: epoch.ended,
        recorderState: epoch.recorder?.state || 'not-started' })),
    };
  }
  return { attach, detach, pause, resume, stop, retry, cancel, flush, getState };
}
