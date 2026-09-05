import { describe, expect, it, vi } from 'vitest';
import { createNativeSourceRecorder } from '../../src/services/nativeSourceRecorder';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const audioBlob = (value, size = 1) => ({ size, arrayBuffer: async () => {
  const bytes = new Uint8Array(size); bytes[0] = value; return bytes.buffer;
} });
function fixture(overrides = {}) {
  let clock = 0, id = 0;
  const log = [], recorders = [], onFatal = vi.fn();
  const bridge = {
    beginSource: vi.fn(async (recordId, descriptor) => { log.push(['begin', descriptor.sourceId]); return { success: true }; }),
    markSourceStarted: vi.fn(async (recordId, sourceId, marker) => { log.push(['mark', sourceId, marker.startOffsetMs]); return { success: true }; }),
    saveSourceChunk: vi.fn(async (recordId, sourceId, bytes, index) => { log.push(['save', sourceId, index, bytes[0]]); return { success: true }; }),
    endSource: vi.fn(async (recordId, sourceId, terminal) => { log.push(['end', sourceId, terminal]); return { success: true }; }),
  };
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
  }
  class Recorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; recorders.push(this); }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; log.push(['start', this]); this.onstart?.(); }
    data(value, size) { this.ondataavailable?.({ data: audioBlob(value, size) }); }
    finish(value = 99) { this.data(value); this.onstop?.(); }
    stop() { this.state = 'inactive'; if (!this.delayStop) queueMicrotask(() => this.finish()); }
    requestData() { this.data(77); }
  }
  const track = () => ({ kind: 'audio', readyState: 'live', enabled: true, stop: vi.fn(), clone: vi.fn(), getSettings: () => ({ sampleRate: 48000, channelCount: 1 }) });
  const source = () => new Stream([track()]);
  const coordinator = createNativeSourceRecorder({ recordId: 'meeting', bridge,
    MediaStream: Stream, MediaRecorder: Recorder, now: () => clock,
    activeOffsetMs: () => clock, createSourceId: () => `source-${++id}`, onFatal, ...overrides,
  });
  return { coordinator, bridge, recorders, source, onFatal, log, setClock: value => { clock = value; } };
}

describe('native source recorder custody', () => {
  it('requires the explicit MIME type recorded in the durable source manifest', () => {
    expect(() => fixture({ mimeType: '' })).toThrow('explicit audio MIME');
    expect(() => fixture({ mimeType: null })).toThrow('explicit audio MIME');
  });

  it('durably reserves before start, marks the actual call offset, and shares muted tracks', async () => {
    const f = fixture();
    const reserved = deferred();
    f.bridge.beginSource.mockImplementationOnce(() => reserved.promise);
    const source = f.source();
    source.getAudioTracks()[0].enabled = false;
    const attaching = f.coordinator.attach('microphone', source);
    await tick();
    expect(f.recorders).toHaveLength(0);
    f.setClock(180);
    reserved.resolve({ success: true });
    expect(await attaching).toMatchObject({ success: true, startOffsetMs: 180 });
    expect(f.bridge.beginSource.mock.calls[0][1].startOffsetMs).toBe(0);
    expect(f.bridge.markSourceStarted).toHaveBeenCalledWith('meeting', 'source-1', { startOffsetMs: 180 });
    expect(f.recorders[0].stream.getAudioTracks()[0]).toBe(source.getAudioTracks()[0]);
    expect(f.recorders[0].stream.getAudioTracks()[0].enabled).toBe(false);
    source.getAudioTracks()[0].enabled = true;
    expect(f.recorders[0].stream.getAudioTracks()[0].enabled).toBe(true);
    expect(await f.coordinator.stop()).toEqual({ success: true });
    expect(source.getAudioTracks()[0].stop).not.toHaveBeenCalled();
    expect(source.getAudioTracks()[0].clone).not.toHaveBeenCalled();
  });

  it('does not save audio before the start marker is durable', async () => {
    const f = fixture();
    const marker = deferred();
    f.bridge.markSourceStarted.mockImplementationOnce(() => marker.promise);
    const attaching = f.coordinator.attach('microphone', f.source());
    await tick();
    f.recorders[0].data(42);
    await tick();
    expect(f.bridge.saveSourceChunk).not.toHaveBeenCalled();
    marker.resolve({ success: true });
    await attaching;
    await f.coordinator.stop();
    expect(f.bridge.saveSourceChunk.mock.calls.map(call => call[2][0])).toEqual([42, 99]);
  });

  it('waits for final events after inactive and for a slow final durable write', async () => {
    const f = fixture();
    await f.coordinator.attach('microphone', f.source());
    const recorder = f.recorders[0];
    recorder.delayStop = true;
    recorder.state = 'inactive'; // Native emergency stop has queued, not dispatched, final events.
    const saving = deferred();
    f.bridge.saveSourceChunk.mockImplementationOnce(() => saving.promise);
    let settled = false;
    const stopping = f.coordinator.stop().then(result => { settled = true; return result; });
    await tick();
    expect(settled).toBe(false);
    recorder.finish(21);
    await tick();
    expect(settled).toBe(false);
    expect(f.bridge.endSource).not.toHaveBeenCalled();
    saving.resolve({ success: true });
    expect(await stopping).toEqual({ success: true });
    expect(f.bridge.endSource.mock.calls[0][2].chunkCount).toBe(1);
  });

  it('retains failed blobs and indexes, stops capture, and retries terminal metadata', async () => {
    const f = fixture();
    f.bridge.saveSourceChunk.mockResolvedValueOnce({ success: false, error: 'Disk busy', code: 'ENOSPC', diskFull: true });
    f.bridge.endSource.mockResolvedValueOnce({ success: false, error: 'Metadata busy' });
    await f.coordinator.attach('microphone', f.source());
    f.recorders[0].data(12);
    await tick();
    expect(f.onFatal).toHaveBeenCalledTimes(1);
    expect(f.onFatal).toHaveBeenCalledWith(expect.objectContaining({ error: 'Disk busy', code: 'ENOSPC', diskFull: true }));
    expect((await f.coordinator.stop()).success).toBe(false);
    expect(f.coordinator.getState().pendingBytes).toBe(2);
    expect((await f.coordinator.retry()).success).toBe(false);
    expect(f.bridge.saveSourceChunk.mock.calls.map(call => [call[3], call[2][0]])).toEqual([[0, 12], [0, 12], [1, 99]]);
    expect(await f.coordinator.retry()).toEqual({ success: true });
    expect(f.bridge.endSource.mock.calls.map(call => call[2].chunkCount)).toEqual([2, 2]);
    expect(f.coordinator.getState().phase).toBe('closed');
  });

  it('retries the same failed start marker before draining retained audio', async () => {
    const f = fixture();
    f.bridge.markSourceStarted.mockResolvedValueOnce({ success: false, error: 'Marker unavailable' });
    expect((await f.coordinator.attach('microphone', f.source())).success).toBe(false);
    await f.coordinator.stop();
    expect(f.bridge.saveSourceChunk).not.toHaveBeenCalled();
    f.setClock(5000);
    expect(await f.coordinator.retry()).toEqual({ success: true });
    expect(f.bridge.markSourceStarted.mock.calls.map(call => call[2])).toEqual([{ startOffsetMs: 0 }, { startOffsetMs: 0 }]);
    expect(f.bridge.saveSourceChunk).toHaveBeenCalledTimes(1);
  });

  it('retries an uncertain durable reservation without discarding another source', async () => {
    const f = fixture();
    await f.coordinator.attach('microphone', f.source());
    f.recorders[0].data(14);
    await tick();
    const published = [];
    f.bridge.beginSource.mockImplementationOnce(async (recordId, descriptor) => {
      published.push({ ...descriptor });
      throw Object.assign(new Error('Reply lost after publication'), { code: 'EIO' });
    });
    expect((await f.coordinator.attach('system', f.source())).success).toBe(false);
    expect((await f.coordinator.stop()).success).toBe(false);
    expect(f.onFatal).toHaveBeenCalledWith(expect.objectContaining({ code: 'EIO', sourceId: 'source-2' }));
    f.setClock(9000);
    expect(await f.coordinator.retry()).toEqual({ success: true });
    expect(f.bridge.beginSource.mock.calls[2][1]).toEqual(published[0]);
    expect(f.recorders).toHaveLength(1);
    expect(f.bridge.saveSourceChunk.mock.calls.map(call => call[2][0])).toEqual([14, 99]);
    expect(f.bridge.endSource.mock.calls.find(call => call[1] === 'source-2')[2]).toMatchObject({ chunkCount: 0, endOffsetMs: 0 });
  });

  it('starts the replacement before retiring the prior epoch at its actual cut', async () => {
    const f = fixture();
    const first = f.source(), next = f.source();
    await f.coordinator.attach('microphone', first);
    f.recorders[0].data(1);
    const reserved = deferred();
    f.bridge.beginSource.mockImplementationOnce(() => reserved.promise);
    f.setClock(100);
    const replacing = f.coordinator.attach('microphone', next);
    await tick();
    expect(f.recorders[0].state).toBe('recording');
    f.setClock(250);
    reserved.resolve({ success: true });
    expect(await replacing).toMatchObject({ startOffsetMs: 250, previousSourceId: 'source-1' });
    expect(f.recorders[1].state).toBe('recording');
    expect(f.bridge.endSource.mock.calls[0][2]).toMatchObject({ endOffsetMs: 250, reason: 'replacement' });
    await f.coordinator.stop();
    expect(first.getAudioTracks()[0].stop).not.toHaveBeenCalled();
    expect(next.getAudioTracks()[0].stop).not.toHaveBeenCalled();
  });

  it('ends epochs on pause and opens only the selected replacement after resume', async () => {
    const f = fixture();
    await f.coordinator.attach('microphone', f.source());
    f.setClock(300);
    expect(await f.coordinator.pause()).toEqual({ success: true });
    const next = f.source();
    next.getAudioTracks()[0].enabled = false;
    expect(await f.coordinator.attach('microphone', next)).toEqual({ success: true, paused: true });
    expect(f.recorders).toHaveLength(1);
    expect(await f.coordinator.resume()).toEqual({ success: true });
    expect(f.recorders).toHaveLength(2);
    expect(f.recorders[1].stream.getAudioTracks()[0]).toBe(next.getAudioTracks()[0]);
    expect(f.bridge.beginSource.mock.calls[1][1].startOffsetMs).toBe(300);
    await f.coordinator.stop();
  });

  it('does not start a late durable reservation after stop or explicit cancel', async () => {
    for (const ending of ['stop', 'cancel']) {
      const f = fixture();
      const reserved = deferred();
      f.bridge.beginSource.mockImplementationOnce(() => reserved.promise);
      const attaching = f.coordinator.attach('system', f.source());
      await tick();
      const ended = f.coordinator[ending]();
      reserved.resolve({ success: true });
      expect((await attaching).success).toBe(false);
      expect((await ended).success).toBe(true);
      expect(f.recorders).toHaveLength(0);
      expect(f.bridge.markSourceStarted).not.toHaveBeenCalled();
      expect((await f.coordinator.attach('microphone', f.source())).success).toBe(false);
    }
  });

  it('blocks pause-racing startup and records the selected source only after resume', async () => {
    const f = fixture();
    const reserved = deferred();
    f.bridge.beginSource.mockImplementationOnce(() => reserved.promise);
    const attaching = f.coordinator.attach('microphone', f.source());
    await tick();
    const paused = f.coordinator.pause();
    reserved.resolve({ success: true });
    expect(await attaching).toMatchObject({ success: true, paused: true });
    expect(await paused).toEqual({ success: true });
    expect(f.recorders).toHaveLength(0);
    await f.coordinator.resume();
    expect(f.recorders).toHaveLength(1);
    await f.coordinator.stop();
  });

  it('revokes a pending replacement when the source is detached', async () => {
    const f = fixture();
    await f.coordinator.attach('system', f.source());
    const reserved = deferred();
    f.bridge.beginSource.mockImplementationOnce(() => reserved.promise);
    const replacing = f.coordinator.attach('system', f.source());
    await tick();
    f.setClock(25);
    const detaching = f.coordinator.detach('system');
    expect(f.recorders[0].state).toBe('inactive');
    f.setClock(100);
    reserved.resolve({ success: true });
    expect((await replacing).success).toBe(false);
    expect(await detaching).toEqual({ success: true });
    expect(f.recorders).toHaveLength(1);
    expect(f.bridge.endSource.mock.calls.find(call => call[1] === 'source-1')[2].endOffsetMs).toBe(25);
    await f.coordinator.stop();
  });

  it('bounds aggregate active and retiring backlogs and preserves triggering/final blobs', async () => {
    const f = fixture({ maxPendingBytes: 4 });
    await f.coordinator.attach('microphone', f.source());
    await f.coordinator.attach('system', f.source());
    const save = deferred();
    f.bridge.saveSourceChunk.mockImplementation(() => save.promise);
    f.recorders[0].data(1, 2);
    f.recorders[1].data(2, 2);
    expect(f.onFatal).toHaveBeenCalledTimes(1);
    expect(f.onFatal).toHaveBeenCalledWith(expect.objectContaining({ backpressure: true, pendingBytes: 4, pendingCount: 2 }));
    expect(f.recorders.every(recorder => recorder.state === 'inactive')).toBe(true);
    await tick();
    expect(f.coordinator.getState().pendingBytes).toBe(6);
    save.resolve({ success: true });
    await f.coordinator.stop();
    expect(f.bridge.saveSourceChunk).toHaveBeenCalledTimes(4);
    expect(f.coordinator.getState().pendingBytes).toBe(0);
  });

  it('detects an aging single blocked write without waiting for another blob', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ maxPendingMs: 50 });
      await f.coordinator.attach('microphone', f.source());
      const write = deferred();
      f.bridge.saveSourceChunk.mockImplementationOnce(() => write.promise);
      f.recorders[0].data(1);
      f.setClock(50);
      await vi.advanceTimersByTimeAsync(50);
      expect(f.onFatal).toHaveBeenCalledTimes(1);
      write.resolve({ success: true });
      await vi.runAllTimersAsync();
      await f.coordinator.stop();
    } finally { vi.useRealTimers(); }
  });

  it('explicit discard waits an accepted write but rejects later final audio', async () => {
    const f = fixture();
    const track = f.source();
    await f.coordinator.attach('microphone', track);
    const write = deferred();
    f.bridge.saveSourceChunk.mockImplementationOnce(() => write.promise);
    f.recorders[0].data(1);
    await tick();
    let settled = false;
    const cancelling = f.coordinator.cancel().then(result => { settled = true; return result; });
    await tick();
    expect(settled).toBe(false);
    f.recorders[0].data(8);
    write.resolve({ success: true });
    expect(await cancelling).toEqual({ success: true, discarded: true });
    expect(f.bridge.saveSourceChunk).toHaveBeenCalledTimes(1);
    expect(track.getAudioTracks()[0].stop).not.toHaveBeenCalled();
    expect((await f.coordinator.retry()).success).toBe(false);
  });

  it('reports a missing final event as retryable instead of publishing incomplete success', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ stopTimeoutMs: 25 });
      await f.coordinator.attach('microphone', f.source());
      f.recorders[0].delayStop = true;
      const stopping = f.coordinator.stop();
      await vi.advanceTimersByTimeAsync(25);
      expect(await stopping).toMatchObject({ success: false });
      expect(f.bridge.endSource).not.toHaveBeenCalled();
      f.recorders[0].finish(3);
      expect(await f.coordinator.retry()).toEqual({ success: true });
      expect(f.bridge.endSource.mock.calls[0][2].chunkCount).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('flush acknowledges durable data from both lanes and tolerates a throwing fatal hook', async () => {
    const f = fixture({ onFatal: () => { throw new Error('Consumer failed'); } });
    await f.coordinator.attach('microphone', f.source());
    await f.coordinator.attach('system', f.source());
    expect(await f.coordinator.flush()).toEqual({ success: true });
    expect(f.bridge.saveSourceChunk).toHaveBeenCalledTimes(2);
    expect(() => f.recorders[0].onerror({ error: new Error('Encoder failed') })).not.toThrow();
    await f.coordinator.stop();
    expect(f.coordinator.getState().fatalError.error).toBe('Encoder failed');
  });
});
