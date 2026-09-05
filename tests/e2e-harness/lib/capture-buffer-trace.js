'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const MAX_TRACE_BYTES = 64 * 1024 * 1024;
const TRACE_CONFIG = Object.freeze({ recordMode: 'recordUntilFull', traceBufferSizeInKb: 16384,
  includedCategories: ['disabled-by-default-mediastream'], excludedCategories: ['*'],
  enableSampling: false, enableSystrace: false });

function deadline(promise, milliseconds = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Audio trace operation timed out')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function summarizeTrace(trace) {
  if (!Array.isArray(trace.traceEvents)) throw new Error('Missing trace events');
  const counts = {}, threads = {}, faults = [];
  let firstTs = null, lastTs = null;
  for (const event of trace.traceEvents) {
    if (event.ph === 'E' || !event.cat?.split(',').includes('disabled-by-default-mediastream')) continue;
    counts[event.name] = (counts[event.name] || 0) + 1;
    if (Number.isFinite(event.ts)) { firstTs = firstTs === null ? event.ts : Math.min(firstTs, event.ts); lastTs = Math.max(lastTs ?? event.ts, event.ts); }
    if (!/WebAudioMediaStreamAudioSink::.*(FIFO full|underrun)$/.test(event.name)) continue;
    const key = event.pid + ':' + event.tid;
    const thread = threads[key] ||= { pid: event.pid, tid: event.tid, fifoFull: 0, underrun: 0 };
    if (event.name.endsWith('FIFO full')) thread.fifoFull++; else thread.underrun++;
    if (faults.length < 1000) faults.push({ name: event.name, ts: event.ts, pid: event.pid, tid: event.tid, args: event.args });
  }
  return { totalTraceEvents: trace.traceEvents.length, counts, threads: Object.values(threads), faults,
    firstTs, lastTs, observedSpanS: firstTs === null ? null : (lastTs - firstTs) / 1000000,
    notes: ['Multiple app AudioContexts are present. A FIFO event alone does not identify the recording mixer.',
      'Trace timing and buffer overhead are experimental variables. Absence of a fault in this short window does not clear prior failures.'] };
}

/** Synthetic diagnostic only. Stop tracing during capture; export after both recorders stop. */
async function startBufferTrace(page) {
  const client = await deadline(page.target().createCDPSession());
  const state = { config: TRACE_CONFIG, maximumDurationMs: 45000, maximumExportBytes: MAX_TRACE_BYTES,
    startedAt: null, stopRequestedAt: null, completedAt: null, maximumBufferUsage: 0, problems: [] };
  let stopped = null, timer = null, completion = null, stream = null, disposed = false;
  const completed = new Promise(resolve => { completion = resolve; });
  const onComplete = event => { stream = event.stream; state.completedAt = performance.now(); completion(event); };
  const onUsage = event => { state.maximumBufferUsage = Math.max(state.maximumBufferUsage, event.percentFull || 0); };
  client.on('Tracing.tracingComplete', onComplete);
  client.on('Tracing.bufferUsage', onUsage);
  const stop = () => {
    if (!stopped) {
      clearTimeout(timer); state.stopRequestedAt = performance.now();
      stopped = deadline(client.send('Tracing.end').then(() => completed)).then(event => {
        state.dataLossOccurred = event.dataLossOccurred === true;
        if (state.dataLossOccurred) state.problems.push('Audio trace buffer lost events');
        if (!event.stream) throw new Error('Missing audio trace stream');
        return state;
      });
      stopped.catch(() => {});
    }
    return stopped;
  };
  const detach = async () => {
    client.off('Tracing.tracingComplete', onComplete); client.off('Tracing.bufferUsage', onUsage);
    await deadline(client.detach()).catch(error => state.problems.push(error.message));
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true; clearTimeout(timer);
    try { await stop(); } catch (error) { state.problems.push(error.message); }
    if (stream) await deadline(client.send('IO.close', { handle: stream })).catch(error => state.problems.push(error.message));
    stream = null; await detach();
  };
  try {
    await deadline(client.send('Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json',
      bufferUsageReportingInterval: 5000, traceConfig: TRACE_CONFIG }));
    state.startedAt = performance.now();
    timer = setTimeout(() => { state.problems.push('Audio trace reached its independent 45-second deadline'); void stop(); }, state.maximumDurationMs);
  } catch (error) { await detach(); throw error; }
  return { state, stop, dispose,
    async exportTo(file) {
      await stop();
      if (!stream || disposed) throw new Error('Audio trace stream unavailable');
      const fd = fs.openSync(file, 'wx'); let bytes = 0;
      const hash = crypto.createHash('sha256'); const began = performance.now();
      try {
        let eof = false;
        while (!eof) {
          if (performance.now() - began > 60000) throw new Error('Audio trace export deadline');
          const response = await deadline(client.send('IO.read', { handle: stream, size: 65536 }));
          const data = Buffer.from(response.data, response.base64Encoded ? 'base64' : 'utf8');
          if (bytes + data.length > MAX_TRACE_BYTES) throw new Error('Audio trace exceeds export size cap');
          let offset = 0; while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
          bytes += data.length; hash.update(data);
          eof = response.eof === true;
        }
        fs.fsyncSync(fd); state.exportCompleted = true;
      } finally { fs.closeSync(fd); state.file = file; state.bytes = bytes; state.sha256 = hash.digest('hex'); }
      return state;
    },
  };
}

module.exports = { startBufferTrace, summarizeTrace, TRACE_CONFIG, MAX_TRACE_BYTES };
