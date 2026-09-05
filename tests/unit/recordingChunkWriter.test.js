import { describe, expect, it, vi } from 'vitest';
import { createRecordingChunkWriter } from '../../src/services/recordingChunkWriter';

function blob(value, convert = () => Promise.resolve(Uint8Array.of(value).buffer)) {
  return { size: 1, arrayBuffer: convert };
}

describe('ordered audio persistence', () => {
  it('detects an aging backlog despite successful writes every two seconds', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    try {
      const saved = [], savedAt = [];
      const pressure = vi.fn();
      const writer = createRecordingChunkWriter({
        save: bytes => new Promise(resolve => setTimeout(() => {
          saved.push(bytes[0]); savedAt.push(performance.now()); resolve({ success: true });
        }, 2000)), onBackpressure: pressure,
      });
      let accepted = 0;
      while (!pressure.mock.calls.length && accepted < 40) {
        writer.enqueue(blob(accepted++));
        if (!pressure.mock.calls.length) await vi.advanceTimersByTimeAsync(1000);
      }
      expect(pressure).toHaveBeenCalledTimes(1);
      expect(pressure.mock.calls[0][0]).toMatchObject({ oldestPendingMs: 15000 });
      expect(performance.now() - savedAt.at(-1)).toBeLessThanOrEqual(1000);
      expect(writer.pendingBytes).toBe(accepted - saved.length);
      writer.enqueue(blob(99)); // Native stop must still deliver its final blob.
      const drained = writer.drain();
      await vi.advanceTimersByTimeAsync(100000);
      expect(await drained).toEqual({ success: true });
      expect(saved).toEqual([...Array.from({ length: accepted }, (_, i) => i), 99]);
      expect(writer.pendingBytes).toBe(0);
      expect(writer.oldestPendingMs).toBe(0);
      expect(pressure).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('retains a large triggering blob and a reentrant final blob, notifying only once', async () => {
    const bytes = new Uint8Array(16 * 1024 * 1024);
    bytes[0] = 17; bytes[bytes.length - 1] = 23;
    const saved = [];
    let writer;
    const pressure = vi.fn(() => { writer.enqueue(blob(99)); });
    writer = createRecordingChunkWriter({ onBackpressure: pressure, save: async data => {
      saved.push([data.length, data[0], data[data.length - 1]]); return { success: true };
    } });
    await writer.enqueue({ size: bytes.length, arrayBuffer: async () => bytes.buffer });
    await writer.drain();
    expect(pressure).toHaveBeenCalledTimes(1);
    expect(pressure).toHaveBeenCalledWith(expect.objectContaining({ pendingBytes: bytes.length, pendingCount: 1 }));
    expect(saved).toEqual([[bytes.length, 17, 23], [1, 99, 99]]);
    expect(writer.pendingBytes).toBe(0);
  });

  it('keeps pressure diagnostics and failed bytes through retry without poisoning the drain', async () => {
    let now = 0;
    const pressure = vi.fn();
    const save = vi.fn().mockResolvedValueOnce({ success: false, error: 'temporary failure' })
      .mockResolvedValue({ success: true });
    const writer = createRecordingChunkWriter({ save, onBackpressure: pressure, now: () => now });
    await writer.enqueue(blob(1));
    now = 15000;
    await writer.enqueue(blob(2));
    expect(pressure).toHaveBeenCalledTimes(1);
    expect(writer.pendingBytes).toBe(2);
    expect(writer.oldestPendingMs).toBe(15000);
    expect(await writer.drain({ retry: true })).toEqual({ success: true });
    expect(save.mock.calls.map(([bytes]) => bytes[0])).toEqual([1, 1, 2]);
    expect(writer.pendingBytes).toBe(0);
    expect(writer.backpressure).toMatchObject({ pendingBytes: 2, oldestPendingMs: 15000 });
  });

  it('keeps event order when the first blob takes longer to read', async () => {
    let resolveFirst;
    const saved = [];
    const writer = createRecordingChunkWriter({ save: async data => { saved.push(data[0]); return { success: true }; } });
    writer.enqueue(blob(1, () => new Promise(resolve => { resolveFirst = resolve; })));
    writer.enqueue(blob(2));
    expect(saved).toEqual([]);
    resolveFirst(Uint8Array.of(1).buffer);
    await writer.drain();
    expect(saved).toEqual([1, 2]);
  });

  it('keeps failed bytes and later blobs for an explicit retry', async () => {
    const saved = [];
    const onFailure = vi.fn();
    const save = vi.fn().mockResolvedValueOnce({ success: false, diskFull: true, error: 'Disk full' })
      .mockImplementation(async bytes => { saved.push(bytes[0]); return { success: true }; });
    const writer = createRecordingChunkWriter({ save, onFailure });
    await writer.enqueue(blob(1));
    await writer.enqueue(blob(2));
    expect(save).toHaveBeenCalledTimes(1);
    expect(writer.pendingCount).toBe(2);
    expect(await writer.drain()).toMatchObject({ success: false, diskFull: true });
    expect(await writer.drain({ retry: true })).toEqual({ success: true });
    expect(saved).toEqual([1, 2]);
    expect(writer.pendingCount).toBe(0);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('waits for all final chunks, including writes slower than a stop event', async () => {
    let finish;
    const writer = createRecordingChunkWriter({ save: () => new Promise(resolve => { finish = resolve; }) });
    writer.enqueue(blob(1));
    await Promise.resolve();
    let drained = false;
    const drain = writer.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish({ success: true });
    await drain;
    expect(drained).toBe(true);
  });
});
