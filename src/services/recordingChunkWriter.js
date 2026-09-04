// Reserve each position BEFORE Blob.arrayBuffer() yields. Otherwise a later
// blob can reach the disk queue first, corrupting WebM cluster order.
export function createRecordingChunkWriter({ save, onSaved = () => {}, onFailure = () => {} }) {
  const pending = [];
  let running = null;
  let failure = null;

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
        try { onSaved(item.bytes.byteLength); } catch (_) { /* diagnostics */ }
      }
      return { success: true };
    })().finally(() => { running = null; });
    return running;
  }

  return {
    enqueue(blob) {
      if (blob.size > 0) pending.push({ blob });
      return run();
    },
    async drain({ retry = false } = {}) {
      if (running) await running;
      if (retry) failure = null;
      return run();
    },
    get pendingCount() { return pending.length; },
    get failure() { return failure; },
  };
}
