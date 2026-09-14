// Reserve each position BEFORE Blob.arrayBuffer() yields. Otherwise a later
// blob can reach the disk queue first, corrupting WebM cluster order.
export function createRecordingChunkWriter({ save, onSaved = () => {}, onFailure = () => {}, onBackpressure, now = () => performance.now() }) {
  const pending = [];
  let running = null;
  let failure = null;
  let pendingBytes = 0;
  let backpressure = null;

  const oldestPendingMs = () => pending.length ? Math.max(0, now() - pending[0].enqueuedAt) : 0;

  function checkBackpressure() {
    if (!onBackpressure || backpressure || !pending.length) return;
    const age = oldestPendingMs();
    if (pendingBytes < 16 * 1024 * 1024 && age < 15000) return;
    // Latch before notifying: stopping MediaRecorder may synchronously deliver
    // a final blob. It must join the FIFO without recursively stopping again.
    backpressure = { pendingBytes, pendingCount: pending.length, oldestPendingMs: age };
    try { onBackpressure(backpressure); } catch (_) { /* keep draining accepted audio */ }
  }

  function run() {
    if (running) return running;
    if (failure) return Promise.resolve({ success: false, ...failure });
    running = (async () => {
      while (pending.length) {
        const item = pending[0];
        let result;
        try {
          if (!item.bytes) item.bytes = new Uint8Array(await item.blob.arrayBuffer());
          result = await save(item.bytes);
          if (!result?.success) throw Object.assign(new Error(result?.error || 'Audio could not be saved'), result || {});
        } catch (error) {
          failure = { error: error.message, diskFull: error.diskFull || error.code === 'ENOSPC' };
          // Keep the blob AND its position. New recordings are blocked until a
          // retry saves these bytes or the user explicitly discards them.
          try { onFailure(failure); } catch (_) { /* diagnostics must not break persistence */ }
          return { ...failure, success: false };
        }
        pending.shift();
        pendingBytes -= item.blob.size;
        try { onSaved(item.bytes.byteLength); } catch (_) { /* diagnostics */ }
      }
      return { success: true };
    })().finally(() => { running = null; });
    return running;
  }

  return {
    enqueue(blob) {
      if (blob.size > 0) {
        pending.push({ blob, enqueuedAt: now() });
        pendingBytes += blob.size;
      }
      // A warning requests capture stop; it never rejects accepted/final blobs
      // or turns pressure into a failed write that would stall the drain.
      checkBackpressure();
      return run();
    },
    async drain({ retry = false } = {}) {
      if (running) await running;
      if (retry) failure = null;
      return run();
    },
    get pendingCount() { return pending.length; },
    get pendingBytes() { return pendingBytes; },
    get oldestPendingMs() { return oldestPendingMs(); },
    get backpressure() { return backpressure; },
    get failure() { return failure; },
  };
}
