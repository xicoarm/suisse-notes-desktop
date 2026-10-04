// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as microphoneChoice from '../../src/services/microphoneChoice.js';

// Compile the real microphone block of useRecorder (from "// Microphone
// selection" to the service event handlers) with narrow dependencies, the same
// way recordingBackpressure.handlers.test.js exercises page handlers.
function loadMicrophonesWith({ getUserMedia, enumerateDevices = async () => [], selected = 'headset',
  desktop = false, deviceSessions, storage = memoryStorage(), recording = false }) {
  const source = fs.readFileSync('src/composables/useRecorder.js', 'utf8').replace(/\r\n/g, '\n');
  const first = source.indexOf('  // Microphone selection');
  const last = source.indexOf('// Event handlers for service events', first);
  if (first < 0 || last < first) throw new Error('Missing microphone block');
  const console = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const systemAudio = { checkOutputRouting: vi.fn(async () => {}) };
  const navigator = { mediaDevices: { getUserMedia, enumerateDevices } };
  const window = { electronAPI: deviceSessions ? { systemAudio: { deviceSessions } } : {} };
  const recordingStore = { isRecording: recording, isPaused: false };
  const recordingService = { isLikelyVirtualInput: device => /virtual/i.test(device?.label || '') };
  const choice = {
    ...microphoneChoice,
    readMicrophoneChoice: () => microphoneChoice.readMicrophoneChoice(storage),
    storeMicrophoneChoice: value => microphoneChoice.storeMicrophoneChoice(value, storage),
  };
  const block = new Function('ref', 'isElectron', 'navigator', 'window', 'recordingStore', 'recordingService', '_systemAudioRef', 'console',
    'AUTO_MICROPHONE', 'chooseAutomaticMicrophone', 'readMicrophoneChoice', 'storeMicrophoneChoice', 'findChosenMicrophone',
    source.slice(first, last) + `
    return { availableMicrophones, selectedMicrophoneId, loadingMicrophones, microphoneChoice, automaticMicrophone,
      setMicrophoneChoice, refreshAutomaticMicrophone, loadMicrophones, microphonesLoaded };`)(
    value => ({ value }), () => desktop, navigator, window, recordingStore, recordingService, systemAudio, console,
    choice.AUTO_MICROPHONE, choice.chooseAutomaticMicrophone, choice.readMicrophoneChoice, choice.storeMicrophoneChoice,
    choice.findChosenMicrophone);
  block.availableMicrophones.value = [{ id: 'headset', label: 'Headset' }];
  block.selectedMicrophoneId.value = selected;
  const state = { ...block, console, systemAudio, recordingStore, storage };
  return { load: block.loadMicrophones, loaded: block.microphonesLoaded, state };
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; },
    data,
  };
}

const domError = (name, message) => Object.assign(new Error(message), { name });
const input = (deviceId, label, groupId = '') => ({ kind: 'audioinput', deviceId, label, groupId });
const failing = (name, message) => async () => { throw domError(name, message); };
const openProbe = async () => ({ getTracks: () => [] });

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

  it('keeps the previous list when only some inputs are named', async () => {
    const { load, state } = loadMicrophonesWith({
      getUserMedia: failing('NotReadableError', 'Could not start audio source'),
      enumerateDevices: async () => [input('a1', 'Named Mic'), input('b2', '')],
    });
    await load();
    expect(state.availableMicrophones.value).toEqual([{ id: 'headset', label: 'Headset' }]);
  });

  it('reports a denied permission as an error and still lists the named inputs (desktop)', async () => {
    const failure = domError('NotAllowedError', 'Permission denied');
    const { load, state } = loadMicrophonesWith({ getUserMedia: async () => { throw failure; }, enumerateDevices: async () => [input('array', 'Microphone Array')], desktop: true });
    await load();
    expect(state.console.error).toHaveBeenCalledWith('Error loading microphones:', failure);
    expect(state.console.info).not.toHaveBeenCalled();
    expect(state.availableMicrophones.value).toEqual([{ id: 'array', label: 'Microphone Array' }]);
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
    const { load, state } = loadMicrophonesWith({ getUserMedia: openProbe, enumerateDevices: async () => { throw failure; } });
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

  // The Record page's start gate: a click while the list is still being read
  // (the page has just opened) must wait for that read, not open the
  // microphone again right before the recording opens it.
  it('lets the start gate wait for the read in flight instead of probing a second time', async () => {
    let release;
    const getUserMedia = vi.fn(() => new Promise(resolve => { release = () => resolve({ getTracks: () => [] }); }));
    const { load, loaded, state } = loadMicrophonesWith({ getUserMedia, enumerateDevices: async () => [input('usb', 'USB Mic')] });
    state.availableMicrophones.value = [];
    const mounting = load();
    const gate = loaded();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([mounting, gate]);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(state.availableMicrophones.value).toEqual([{ id: 'usb', label: 'USB Mic' }]);
  });

  it('reads the list for the start gate when no read is running, and never waits longer than 5 s', async () => {
    const quick = loadMicrophonesWith({ getUserMedia: vi.fn(openProbe), enumerateDevices: async () => [input('usb', 'USB Mic')] });
    await quick.loaded();
    expect(quick.state.availableMicrophones.value).toEqual([{ id: 'usb', label: 'USB Mic' }]);
    vi.useFakeTimers();
    try {
      const stuck = loadMicrophonesWith({ getUserMedia: () => new Promise(() => {}) });
      let settled = false;
      stuck.loaded().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(4900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

// Areg, 03.10.2026: the app recorded the Windows DEFAULT microphone while the
// call ran on the headset Teams uses (the default COMMUNICATION device), and
// forgot every choice. On the desktop the list now holds real devices only and
// "automatic" means the microphone the meeting uses.
describe('the desktop microphone choice', () => {
  const windowsInputs = () => [
    input('default', 'Default - Microphone Array (Intel Smart Sound)', 'g-board'),
    input('communications', 'Communications - Mikrofon (Jabra Evolve2 65) (0b0e:24f6)', 'g-jabra'),
    input('array-id', 'Microphone Array (Intel Smart Sound)', 'g-board'),
    input('jabra-id', 'Mikrofon (Jabra Evolve2 65) (0b0e:24f6)', 'g-jabra'),
    input('teams-virtual', 'Microsoft Teams Audio Device (Virtual)', 'g-teams'),
  ];

  it('lists real devices only and records the Windows communication microphone by default', async () => {
    const { load, state } = loadMicrophonesWith({ getUserMedia: openProbe, enumerateDevices: async () => windowsInputs(), desktop: true, selected: '' });
    await load();
    expect(state.availableMicrophones.value.map(mic => mic.id)).toEqual(['array-id', 'jabra-id', 'teams-virtual']);
    expect(state.microphoneChoice.value).toEqual({ mode: 'auto' });
    expect(state.automaticMicrophone.value).toMatchObject({ deviceId: 'jabra-id', reason: 'communications' });
    expect(state.selectedMicrophoneId.value).toBe('jabra-id');
  });

  it('records the microphone the meeting app is using when Windows says which one', async () => {
    const deviceSessions = vi.fn(async () => ({ success: true, devices: [
      { flow: 'input', device: 'Microphone Array (Intel Smart Sound)', defaultFor: ['console'], sessions: [{ app: 'ms-teams', active: true, peak: 0.1 }] },
      { flow: 'input', device: 'Mikrofon (Jabra Evolve2 65)', defaultFor: ['communications'], sessions: [] },
    ] }));
    const { load, state } = loadMicrophonesWith({ getUserMedia: openProbe, enumerateDevices: async () => windowsInputs(), desktop: true, deviceSessions });
    await load();
    expect(state.automaticMicrophone.value).toMatchObject({ deviceId: 'array-id', reason: 'meeting', app: 'Microsoft Teams' });
    expect(state.selectedMicrophoneId.value).toBe('array-id');
  });

  it('keeps a device the user picked, across launches, and goes back to automatic when it is gone', async () => {
    const storage = memoryStorage();
    const first = loadMicrophonesWith({ getUserMedia: openProbe, enumerateDevices: async () => windowsInputs(), desktop: true, storage });
    await first.load();
    first.state.setMicrophoneChoice('array-id');
    expect(first.state.selectedMicrophoneId.value).toBe('array-id');

    const nextLaunch = loadMicrophonesWith({ getUserMedia: openProbe, enumerateDevices: async () => windowsInputs(), desktop: true, storage });
    await nextLaunch.load();
    expect(nextLaunch.state.microphoneChoice.value).toMatchObject({ mode: 'device', deviceId: 'array-id' });
    expect(nextLaunch.state.selectedMicrophoneId.value).toBe('array-id');

    const unplugged = loadMicrophonesWith({ getUserMedia: openProbe, enumerateDevices: async () => windowsInputs().filter(d => !d.label.includes('Intel')), desktop: true, storage });
    await unplugged.load();
    expect(unplugged.state.selectedMicrophoneId.value).toBe('jabra-id');

    nextLaunch.state.setMicrophoneChoice('auto');
    expect(storage.data).toEqual({});
    expect(nextLaunch.state.selectedMicrophoneId.value).toBe('jabra-id');
  });

  it('never moves a running recording to another device when the list changes', async () => {
    const { load, state } = loadMicrophonesWith({ getUserMedia: openProbe, enumerateDevices: async () => windowsInputs(), desktop: true, selected: 'array-id', recording: true });
    await load();
    expect(state.selectedMicrophoneId.value).toBe('array-id');
    expect(state.automaticMicrophone.value).toMatchObject({ deviceId: 'jabra-id' });
  });

  // s15 allows exactly one getUserMedia between page load and the start click:
  // re-reading what automatic means must not open a microphone.
  it('refreshes what automatic means without opening a microphone', async () => {
    const getUserMedia = vi.fn(openProbe);
    let inputs = windowsInputs().filter(d => !d.label.includes('Jabra'));
    const { load, state } = loadMicrophonesWith({ getUserMedia, enumerateDevices: async () => inputs, desktop: true });
    await load();
    expect(state.selectedMicrophoneId.value).toBe('array-id');
    inputs = windowsInputs();
    await state.refreshAutomaticMicrophone(500);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(state.selectedMicrophoneId.value).toBe('jabra-id');
  });

  it('does not wait for a helper that never answers', async () => {
    vi.useFakeTimers();
    try {
      const { state } = loadMicrophonesWith({ getUserMedia: openProbe, enumerateDevices: async () => windowsInputs(), desktop: true,
        deviceSessions: () => new Promise(() => {}) });
      let done = false;
      state.refreshAutomaticMicrophone(1500).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(1600);
      expect(done).toBe(true);
      expect(state.selectedMicrophoneId.value).toBe('jabra-id');
    } finally { vi.useRealTimers(); }
  });
});
