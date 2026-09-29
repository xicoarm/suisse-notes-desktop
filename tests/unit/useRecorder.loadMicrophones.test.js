// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

// Compile the real loadMicrophones declaration with narrow dependencies, the
// same way recordingBackpressure.handlers.test.js exercises page handlers.
function loadMicrophonesWith({ getUserMedia, enumerateDevices = async () => [] }) {
  const source = fs.readFileSync('src/composables/useRecorder.js', 'utf8').replace(/\r\n/g, '\n');
  const first = source.indexOf('const loadMicrophones = async () => {');
  const last = source.indexOf('// Event handlers for service events', first);
  if (first < 0 || last < first) throw new Error('Missing loadMicrophones declaration');
  const state = {
    availableMicrophones: { value: [{ id: 'headset', label: 'Headset' }] },
    selectedMicrophoneId: { value: 'headset' },
    loadingMicrophones: { value: false },
    console: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const navigator = { mediaDevices: { getUserMedia, enumerateDevices } };
  const load = new Function('navigator', 'availableMicrophones', 'selectedMicrophoneId', 'loadingMicrophones', '_systemAudioRef', 'console',
    source.slice(first, last) + '\nreturn loadMicrophones;')(navigator, state.availableMicrophones, state.selectedMicrophoneId,
    state.loadingMicrophones, null, state.console);
  return { load, state };
}

const domError = (name, message) => Object.assign(new Error(message), { name });

describe('loading the microphone list', () => {
  // ELECTRON-6Z: a docked laptop lost every audio input for a moment (dock and
  // displays re-attached seconds later). Chromium answers getUserMedia with
  // NotFoundError; that is the computer's state, not an app failure.
  it('treats "no microphone connected" as a state: breadcrumb only, list and selection untouched', async () => {
    const { load, state } = loadMicrophonesWith({ getUserMedia: async () => { throw domError('NotFoundError', 'Requested device not found'); } });
    await load();
    expect(state.console.error).not.toHaveBeenCalled();
    expect(state.console.warn).not.toHaveBeenCalled();
    expect(state.console.info).toHaveBeenCalledWith('No microphone connected right now:', 'Requested device not found');
    expect(state.availableMicrophones.value).toEqual([{ id: 'headset', label: 'Headset' }]);
    expect(state.selectedMicrophoneId.value).toBe('headset');
    expect(state.loadingMicrophones.value).toBe(false);
  });

  it.each(['NotAllowedError', 'NotReadableError', 'AbortError'])('still reports %s as an error', async name => {
    const failure = domError(name, 'failed');
    const { load, state } = loadMicrophonesWith({ getUserMedia: async () => { throw failure; } });
    await load();
    expect(state.console.error).toHaveBeenCalledWith('Error loading microphones:', failure);
    expect(state.loadingMicrophones.value).toBe(false);
  });

  it('lists the inputs when a microphone is available', async () => {
    const { load, state } = loadMicrophonesWith({
      getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
      enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'usb-mic', label: 'USB Mic' }, { kind: 'audiooutput', deviceId: 'spk', label: 'Speaker' }],
    });
    await load();
    expect(state.availableMicrophones.value).toEqual([{ id: 'usb-mic', label: 'USB Mic' }]);
    expect(state.console.error).not.toHaveBeenCalled();
  });
});
