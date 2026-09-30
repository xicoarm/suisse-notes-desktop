// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

// Compile the real loadMicrophones declaration with narrow dependencies, the
// same way recordingBackpressure.handlers.test.js exercises page handlers.
function loadMicrophonesWith({ getUserMedia, enumerateDevices = async () => [], selected = 'headset' }) {
  const source = fs.readFileSync('src/composables/useRecorder.js', 'utf8').replace(/\r\n/g, '\n');
  const first = source.indexOf('const loadMicrophones = async () => {');
  const last = source.indexOf('// Event handlers for service events', first);
  if (first < 0 || last < first) throw new Error('Missing loadMicrophones declaration');
  const state = {
    availableMicrophones: { value: [{ id: 'headset', label: 'Headset' }] },
    selectedMicrophoneId: { value: selected },
    loadingMicrophones: { value: false },
    console: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    systemAudio: { checkOutputRouting: vi.fn(async () => {}) },
  };
  const navigator = { mediaDevices: { getUserMedia, enumerateDevices } };
  const load = new Function('navigator', 'availableMicrophones', 'selectedMicrophoneId', 'loadingMicrophones', '_systemAudioRef', 'console',
    source.slice(first, last) + '\nreturn loadMicrophones;')(navigator, state.availableMicrophones, state.selectedMicrophoneId,
    state.loadingMicrophones, state.systemAudio, state.console);
  return { load, state };
}

const domError = (name, message) => Object.assign(new Error(message), { name });
const input = (deviceId, label) => ({ kind: 'audioinput', deviceId, label });
const failing = (name, message) => async () => { throw domError(name, message); };

describe('loading the microphone list', () => {
  // ELECTRON-6Z: a docked laptop lost every audio input for a moment (dock and
  // displays re-attached seconds later). Chromium answers getUserMedia with
  // NotFoundError; that is the computer's state, not an app failure.
  it('shows an empty list when no microphone is connected: a breadcrumb, no error, selection untouched', async () => {
    const { load, state } = loadMicrophonesWith({ getUserMedia: failing('NotFoundError', 'Requested device not found') });
    await load();
    expect(state.console.error).not.toHaveBeenCalled();
    expect(state.console.warn).not.toHaveBeenCalled();
    expect(state.console.info).toHaveBeenCalledWith('Microphone probe failed:', 'NotFoundError', 'Requested device not found');
    expect(state.availableMicrophones.value).toEqual([]);
    expect(state.selectedMicrophoneId.value).toBe('headset');
    expect(state.loadingMicrophones.value).toBe(false);
  });

  // ELECTRON-70: with no recording running, a device change re-read the list
  // while the default microphone could not be opened. The other inputs are
  // fine and the desktop names them without a stream: the list must update.
  it('still updates the list when the default microphone cannot be opened right now', async () => {
    const { load, state } = loadMicrophonesWith({
      getUserMedia: failing('NotReadableError', 'Could not start audio source'),
      enumerateDevices: async () => [input('default', 'Default - Speakerphone'), input('speakerphone', 'Speakerphone'), input('array', 'Microphone Array'),
        { kind: 'audiooutput', deviceId: 'spk', label: 'Speaker' }],
    });
    await load();
    expect(state.console.error).not.toHaveBeenCalled();
    expect(state.console.info).toHaveBeenCalledWith('Microphone probe failed:', 'NotReadableError', 'Could not start audio source');
    expect(state.availableMicrophones.value.map(mic => mic.id)).toEqual(['default', 'speakerphone', 'array']);
    expect(state.selectedMicrophoneId.value).toBe('headset');
    expect(state.systemAudio.checkOutputRouting).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous list when the platform gives no device names without a stream', async () => {
    const { load, state } = loadMicrophonesWith({
      getUserMedia: failing('NotReadableError', 'Could not start audio source'),
      enumerateDevices: async () => [input('a1', ''), input('b2', '')],
    });
    await load();
    expect(state.availableMicrophones.value).toEqual([{ id: 'headset', label: 'Headset' }]);
    expect(state.systemAudio.checkOutputRouting).not.toHaveBeenCalled();
    expect(state.console.error).not.toHaveBeenCalled();
  });

  it.each(['NotAllowedError', 'AbortError', 'SecurityError'])('still reports %s as an error', async name => {
    const failure = domError(name, 'failed');
    const { load, state } = loadMicrophonesWith({ getUserMedia: async () => { throw failure; }, enumerateDevices: async () => [input('a1', '')] });
    await load();
    expect(state.console.error).toHaveBeenCalledWith('Error loading microphones:', failure);
    expect(state.availableMicrophones.value).toEqual([{ id: 'headset', label: 'Headset' }]);
    expect(state.loadingMicrophones.value).toBe(false);
  });

  it('reports a failing device enumeration as an error', async () => {
    const failure = new Error('enumeration failed');
    const { load, state } = loadMicrophonesWith({ getUserMedia: async () => ({ getTracks: () => [] }), enumerateDevices: async () => { throw failure; } });
    await load();
    expect(state.console.error).toHaveBeenCalledWith('Error loading microphones:', failure);
    expect(state.loadingMicrophones.value).toBe(false);
  });

  it('lists the inputs, stops the probe stream and selects the first input when none is selected', async () => {
    const stop = vi.fn();
    const { load, state } = loadMicrophonesWith({
      getUserMedia: async () => ({ getTracks: () => [{ stop }] }), selected: '',
      enumerateDevices: async () => [input('usb-mic', 'USB Mic'), input('no-name-1234567', ''), { kind: 'audiooutput', deviceId: 'spk', label: 'Speaker' }],
    });
    await load();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(state.availableMicrophones.value).toEqual([{ id: 'usb-mic', label: 'USB Mic' }, { id: 'no-name-1234567', label: 'Microphone no-name-...' }]);
    expect(state.selectedMicrophoneId.value).toBe('usb-mic');
    expect(state.systemAudio.checkOutputRouting).toHaveBeenCalledTimes(1);
    expect(state.console.error).not.toHaveBeenCalled();
    expect(state.console.info).not.toHaveBeenCalled();
  });
});
