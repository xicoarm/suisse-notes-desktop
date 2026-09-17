import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('uuid', () => ({ v4: () => 'test-uuid' }));
vi.stubGlobal('window', { electronAPI: { recording: {} } });
import { useRecordingStore } from '../../src/stores/recording';

// Compile the page's actual stop handlers with narrow dependencies (as in
// recordingBackpressure.handlers.test.js) and check where they leave the phase:
// 'processing' shows the blocking processing screen, so every path must leave it.
const source = fs.readFileSync('src/pages/RecordPage.vue', 'utf8').replace(/\r\n/g, '\n');
function declaration(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  if (first < 0 || last < first) throw new Error(`Missing declaration ${start}`);
  return source.slice(first, last);
}
const failProcessingSource = declaration('const failProcessing =', 'const handleStopInternal =');
const handlers = {
  handleStopInternal: declaration('const handleStopInternal =', 'const handleCancel = async'),
  handleSaveDeadRecording: declaration('const handleSaveDeadRecording = async', '// Handle discarding a dead recording'),
};
function compile(name, deps) {
  const names = Object.keys(deps);
  return new Function(...names, `${failProcessingSource}\n${handlers[name]}\nreturn ${name};`)(...names.map(key => deps[key]));
}

let store, deps, phaseAtUpload;
beforeEach(() => {
  setActivePinia(createPinia());
  store = useRecordingStore();
  store.recordId = 'rec-1';
  store.phase = 'recording';
  store.duration = 60;
  phaseAtUpload = null;
  deps = {
    recordingStore: store,
    // The service keeps the page's 'processing' through finalization.
    stopRecording: vi.fn(async () => ({ success: true, duration: 60 })),
    $q: { notify: vi.fn(), dialog: vi.fn(() => ({ onOk: () => ({ onCancel: () => {} }) })) },
    t: key => key,
    isElectron: () => true,
    isCapacitor: () => false,
    window: { electronAPI: { recording: { getFilePath: vi.fn(async () => ({ success: true, filePath: '/r/audio.webm', fileSize: 10 })) } } },
    historyStore: { updateRecording: vi.fn(async () => {}) },
    finalDuration: { value: 60 },
    currentFileSize: { value: 10 },
    currentFilePath: { value: '/r/audio.webm' },
    startAutoUpload: vi.fn(async () => { phaseAtUpload = store.phase; store.setUploading(); }),
    handleStop: vi.fn(),
    handleDiscardDeadRecording: vi.fn(),
  };
});

describe.each(Object.keys(handlers))('%s', name => {
  it('keeps the processing screen from stop until the upload starts', async () => {
    let phaseDuringStop = null;
    deps.stopRecording.mockImplementation(async () => { phaseDuringStop = store.phase; return { success: true, duration: 60 }; });
    await compile(name, deps)();
    expect(phaseDuringStop).toBe('processing');
    expect(phaseAtUpload).toBe('processing');
    expect(store.phase).toBe('uploading');
  });

  it('shows the error card when a step after finalization throws', async () => {
    deps.historyStore.updateRecording.mockRejectedValue(new Error('history write failed'));
    await compile(name, deps)();
    expect(deps.startAutoUpload).not.toHaveBeenCalled();
    expect(store.phase).toBe('error');
    expect(store.error).toBe('history write failed');
  });

  it('shows the error card when a failed save leaves the phase unsettled', async () => {
    deps.stopRecording.mockResolvedValue({ success: false, error: 'No active recording' });
    await compile(name, deps)();
    expect(store.phase).toBe('error');
    expect(store.error).toBe('No active recording');
  });

  it('keeps the message of a failure the store already settled', async () => {
    deps.stopRecording.mockImplementation(async () => {
      store.setError('Recording could not be saved: disk full');
      return { success: false, diskFull: true, error: 'raw ENOSPC' };
    });
    await compile(name, deps)();
    expect(store.phase).toBe('error');
    expect(store.error).toBe('Recording could not be saved: disk full');
  });

  it('leaves a discarded recording to the cancel flow', async () => {
    deps.stopRecording.mockResolvedValue({ success: false, cancelled: true, error: 'Recording was discarded' });
    await compile(name, deps)();
    expect(store.phase).not.toBe('error');
  });
});
