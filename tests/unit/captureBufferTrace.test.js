// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { startBufferTrace, summarizeTrace, TRACE_CONFIG, MAX_TRACE_BYTES, MAX_CALLBACK_MEASUREMENTS } = require('../e2e-harness/lib/capture-buffer-trace');
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
    expect(client.send.mock.calls[0][1].traceConfig).toEqual(TRACE_CONFIG);
    expect(TRACE_CONFIG.includedCategories).toEqual(['audio', 'disabled-by-default-mediastream']);
    expect(TRACE_CONFIG.traceBufferSizeInKb).toBe(16384);
    expect(MAX_TRACE_BYTES).toBe(64 * 1024 * 1024);
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

  it('preserves delivery END timestamps across nested processor and WebAudio events and separates callback stages', () => {
    const event = (name, ph, ts, args = {}, extra = {}) => ({ name, ph, ts, args, pid: 1, tid: 2, cat: 'audio', ...extra });
    const input = 'InputController::OnData', delivery = 'AudioInputDevice::AudioThreadCallback::Process';
    const result = summarizeTrace({ traceEvents: [
      event(input, 'X', 1000000, { 'capture time (ms)': 1000 }, { dur: 30, pid: 9, tid: 10 }),
      event(delivery, 'B', 1003000),
      event('AudioProcessor::ProcessCapturedAudio', 'B', 1003100, { 'delay (ms)': 3.1 }),
      event('AudioProcessor::ProcessData', 'X', 1003150, { 'capture_delay (ms)': 3.2 }, { dur: 200 }),
      event('AudioProcessor::ProcessCapturedAudio', 'E', 1003500),
      event('WebAudioMediaStreamAudioSink::OnData FIFO full', 'B', 1003600, { 'frames dropped': 480 }, { cat: 'disabled-by-default-mediastream' }),
      event('WebAudioMediaStreamAudioSink::OnData FIFO full', 'E', 1003700, {}, { cat: 'disabled-by-default-mediastream' }),
      event(undefined, 'E', 1004000, { 'capture_time (ms)': 1000, 'now_time (ms)': 1003 }),
      event(input, 'X', 1010000, { 'capture time (ms)': 1010 }, { dur: 30, pid: 9, tid: 10 }),
      event(delivery, 'X', 1023000, { 'capture_time (ms)': 1010, 'now_time (ms)': 1023 }, { dur: 1000 }),
    ] }).callbackTiming;
    expect(result.problems).toEqual([]);
    expect(result.measurements.find(item => item.name === delivery)).toMatchObject({ stage: 'renderer-delivery',
      durationUs: 1000, captureTimeMs: 1000, deliveryTimeMs: 1003, captureDelayMs: 3,
      args: { 'capture_time (ms)': 1000, 'now_time (ms)': 1003 } });
    expect(result.measurements.find(item => item.stage === 'processing-input')).toMatchObject({ durationUs: 400, captureDelayMs: 3.1 });
    expect(result.cadence.find(item => item.stage === 'renderer-delivery')).toMatchObject({ callbacks: 2,
      minimumCaptureStepMs: 10, maximumCaptureStepMs: 10, maximumCallbackStepMs: 20, maximumCaptureDelayMs: 13 });
    expect(result.cadence.find(item => item.stage === 'input-callback')).toMatchObject({ pid: 9, tid: 10, maximumCallbackStepMs: 10 });
    expect(result.incompleteCallbacks).toBe(0);
  });

  it('does not call absent upstream instrumentation or lost END arguments a healthy trace', () => {
    expect(summarizeTrace({ traceEvents: [] }).callbackTiming.problems).toEqual([
      'Missing upstream callback trace: InputController::OnData',
      'Missing upstream callback trace: AudioInputDevice::AudioThreadCallback::Process',
    ]);
    const result = summarizeTrace({ traceEvents: [
      { name: 'InputController::OnData', cat: 'audio', ph: 'X', ts: 0, dur: 10, pid: 1, tid: 1, args: { 'capture time (ms)': 0 } },
      { name: 'AudioInputDevice::AudioThreadCallback::Process', cat: 'audio', ph: 'X', ts: 1000, dur: 100, pid: 2, tid: 2 },
    ] }).callbackTiming;
    expect(result.problems).toContain('Missing capture/arrival timestamp arguments: AudioInputDevice::AudioThreadCallback::Process');
    expect(result.measurements.some(item => item.stage.startsWith('processing-'))).toBe(false);
  });

  it('keeps callback summary memory bounded and reports omitted measurements', () => {
    const events = Array.from({ length: MAX_CALLBACK_MEASUREMENTS + 1 }, (_, index) => ({ name: 'InputController::OnData',
      cat: 'audio', ph: 'X', ts: index * 10000, dur: 10, pid: 1, tid: 1, args: { 'capture time (ms)': index * 10 } }));
    const result = summarizeTrace({ traceEvents: events }).callbackTiming;
    expect(result.measurements).toHaveLength(MAX_CALLBACK_MEASUREMENTS);
    expect(result.omittedMeasurements).toBe(1);
    expect(result.problems).toContain('Audio callback summary exceeded its measurement cap');
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
