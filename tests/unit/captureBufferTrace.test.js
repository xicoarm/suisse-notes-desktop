// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { startBufferTrace, summarizeTrace } = require('../e2e-harness/lib/capture-buffer-trace');
const directories = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function output() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suisse-trace-')); directories.push(dir); return path.join(dir, 'trace.json'); }
function clientFixture({ dataLoss = false, failRead = false } = {}) {
  const client = new EventEmitter(); let reads = 0;
  client.send = vi.fn(async method => {
    if (method === 'Tracing.end') client.emit('Tracing.tracingComplete', { stream: 'owned-trace', dataLossOccurred: dataLoss });
    if (method === 'IO.read') {
      if (failRead) throw new Error('connection lost');
      reads++;
      return reads === 1 ? { data: Buffer.from('{"traceEvents":').toString('base64'), base64Encoded: true, eof: false } : { data: '[]}', eof: true };
    }
    return {};
  });
  client.detach = vi.fn(async () => {});
  return { client, page: { target: () => ({ createCDPSession: async () => client }) } };
}

describe('bounded native audio trace', () => {
  it('counts media FIFO faults once and keeps thread identity without claiming a mixer identity', () => {
    const full = { name: 'WebAudioMediaStreamAudioSink::OnData FIFO full', cat: 'disabled-by-default-mediastream', pid: 1, tid: 2, ts: 100, ph: 'B' };
    const result = summarizeTrace({ traceEvents: [full, { ...full, ph: 'E' }, { ...full, cat: 'other' },
      { ...full, name: 'WebAudioMediaStreamAudioSink::ProvideInput underrun', pid: 3, ts: 1000100, args: { 'frames missing': 128 } }] });
    expect(result.threads).toEqual([{ pid: 1, tid: 2, fifoFull: 1, underrun: 0 }, { pid: 3, tid: 2, fifoFull: 0, underrun: 1 }]);
    expect(result.observedSpanS).toBe(1);
    expect(result.faults).toHaveLength(2);
    expect(() => summarizeTrace({})).toThrow('Missing trace events');
  });

  it('stops collection without transferring trace bytes during live audio capture', async () => {
    const { client, page } = clientFixture(); const trace = await startBufferTrace(page);
    client.emit('Tracing.bufferUsage', { percentFull: 0.4 });
    await trace.stop(); await trace.stop();
    expect(client.send.mock.calls.map(call => call[0])).toEqual(['Tracing.start', 'Tracing.end']);
    const file = output(); await trace.exportTo(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ traceEvents: [] });
    expect(trace.state.maximumBufferUsage).toBe(0.4);
    expect(trace.state.exportCompleted).toBe(true);
    await trace.dispose(); await trace.dispose();
    expect(client.detach).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls.filter(call => call[0] === 'IO.close')).toEqual([['IO.close', { handle: 'owned-trace' }]]);
  });

  it('retains trace data-loss evidence instead of treating incomplete trace coverage as clean', async () => {
    const { page } = clientFixture({ dataLoss: true }); const trace = await startBufferTrace(page);
    await trace.exportTo(output());
    expect(trace.state.dataLossOccurred).toBe(true);
    expect(trace.state.problems).toContain('Audio trace buffer lost events');
    await trace.dispose();
  });

  it('independently stops after its hard deadline when the capture loop no longer progresses', async () => {
    vi.useFakeTimers(); const { client, page } = clientFixture(); const trace = await startBufferTrace(page);
    await vi.advanceTimersByTimeAsync(45000);
    expect(client.send.mock.calls.some(call => call[0] === 'Tracing.end')).toBe(true);
    expect(trace.state.problems).toContain('Audio trace reached its independent 45-second deadline');
    await trace.dispose();
  });

  it('preserves an incomplete export and closes its owned stream after a read failure', async () => {
    const { client, page } = clientFixture({ failRead: true }); const trace = await startBufferTrace(page); const file = output();
    await expect(trace.exportTo(file)).rejects.toThrow('connection lost');
    expect(fs.existsSync(file)).toBe(true);
    expect(trace.state.exportCompleted).not.toBe(true);
    await trace.dispose();
    expect(client.detach).toHaveBeenCalledTimes(1);
  });
});
