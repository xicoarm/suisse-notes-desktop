import { describe, expect, it, vi } from 'vitest';
import { createRecordingChunkWriter } from '../../src/services/recordingChunkWriter';

function blob(value, convert = () => Promise.resolve(Uint8Array.of(value).buffer)) {
  return { size: 1, arrayBuffer: convert };
}

describe('ordered audio persistence', () => {
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
