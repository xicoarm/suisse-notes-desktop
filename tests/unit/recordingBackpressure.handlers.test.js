// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

// Compile the actual event-handler declarations with narrow dependencies so
// these checks exercise their production conditions without mounting a page.
function declaration(file, start, end) {
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  if (first < 0 || last < first) throw new Error('Missing handler declaration');
  return source.slice(first, last);
}

describe('backlog emergency handling', () => {
  it('revokes device rebind ownership before pageless stream and helper teardown', async () => {
    const source = declaration('src/services/recordingSafetyNet.js', 'async function stopSystemAudioStandalone()', '/**\n * Emergency stop-with-save');
    const order = [];
    const stop = new Function('stopSystemAudioRebindMonitor', 'recordingService', 'isElectron', 'window', 'console',
      source + '\nreturn stopSystemAudioStandalone;')(() => order.push('revoke'), {
        removeSystemAudioStream: () => order.push('detach'),
        setSystemAudioActive: () => order.push('inactive'),
      }, () => true, { electronAPI: { systemAudio: { stop: async () => order.push('helper') } } }, { warn: vi.fn() });
    await stop();
    expect(order).toEqual(['revoke', 'detach', 'inactive', 'helper']);
  });

  it('stops with save on the Record page without calling pressure an exhausted retry', async () => {
    const source = declaration('src/composables/useRecorder.js', 'const handleChunkSaveFailure =', '// Chunk-progress watchdog');
    const service = { stopRecording: vi.fn().mockResolvedValue({ success: true }) };
    const store = {}, stopSystemAudio = vi.fn(), warning = { value: null };
    const handler = new Function('recordingService', 'recordingStore', 'stopSystemAudio', 'chunkSaveError', 'console',
      source + '\nreturn handleChunkSaveFailure;')(service, store, stopSystemAudio, warning, { error: vi.fn() });
    const data = { backpressure: true, pendingBytes: 1024, oldestPendingMs: 15000 };
    await handler(data);
    expect(service.stopRecording).toHaveBeenCalledWith(store, stopSystemAudio);
    expect(warning.value).toBe(data);
    expect(data).not.toHaveProperty('retriesExhausted');
    await handler(null);
    expect(warning.value).toBeNull();
    expect(service.stopRecording).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('routes the same warning through the safety net only when the Record page is inactive (%s)', recordPageActive => {
    const source = declaration('src/services/recordingSafetyNet.js', 'function handleChunkSaveFailure(data)', 'function handleCaptureRecoveryFailed');
    const emergencyStop = vi.fn();
    const handler = new Function('recordPageActive', 'useRecordingStore', 'emergencyStop',
      source + '\nreturn handleChunkSaveFailure;')(recordPageActive, () => ({ isRecording: true }), emergencyStop);
    handler({ backpressure: true, pendingBytes: 1024, oldestPendingMs: 15000 });
    if (recordPageActive) expect(emergencyStop).not.toHaveBeenCalled();
    else expect(emergencyStop).toHaveBeenCalledWith('safetyNetChunkFailStop');
  });
});
