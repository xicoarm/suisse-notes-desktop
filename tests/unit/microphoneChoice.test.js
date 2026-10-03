// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  AUTO_MICROPHONE, meetingApp, resolveAlias, chooseAutomaticMicrophone,
  readMicrophoneChoice, storeMicrophoneChoice, findChosenMicrophone
} from '../../src/services/microphoneChoice.js';

const input = (deviceId, label, groupId = '') => ({ kind: 'audioinput', deviceId, label, groupId });
const session = (device, app, active = true) => ({ flow: 'input', device, defaultFor: [], sessions: [{ app, active, peak: 0 }] });
const storage = () => {
  const data = {};
  return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: k => { delete data[k]; } };
};

// The layout of the 03.10.2026 report: board microphone as the Windows default,
// the Jabra headset (where Teams talks) as the communication device.
const layout = () => [
  input('default', 'Default - Microphone Array (Intel® Smart Sound Technologie für digitale Mikrofone)', 'board'),
  input('communications', 'Communications - Mikrofon (Jabra Evolve2 65) (0b0e:24f6)', 'jabra'),
  input('array', 'Microphone Array (Intel® Smart Sound Technologie für digitale Mikrofone)', 'board'),
  input('jabra', 'Mikrofon (Jabra Evolve2 65) (0b0e:24f6)', 'jabra'),
];

describe('which microphone automatic records', () => {
  it('takes the Windows communication microphone, not the default one', () => {
    expect(chooseAutomaticMicrophone(layout(), null)).toEqual({
      deviceId: 'jabra', label: 'Mikrofon (Jabra Evolve2 65) (0b0e:24f6)', reason: 'communications',
    });
  });

  it('takes the microphone a meeting app is recording from, matched by the Windows device name', () => {
    const sessions = [session('Mikrofon (Jabra Evolve2 65)', 'ms-teams')];
    expect(chooseAutomaticMicrophone([...layout().slice(0, 1), ...layout().slice(2)], sessions))
      .toMatchObject({ deviceId: 'jabra', reason: 'meeting', app: 'Microsoft Teams' });
    const board = [session('Microphone Array (Intel® Smart Sound Technologie für digitale Mikrofone)', 'Zoom')];
    expect(chooseAutomaticMicrophone(layout(), board)).toMatchObject({ deviceId: 'array', reason: 'meeting', app: 'Zoom' });
  });

  it('ignores inactive sessions, other apps and the output devices', () => {
    const sessions = [
      session('Microphone Array (Intel® Smart Sound Technologie für digitale Mikrofone)', 'ms-teams', false),
      session('Microphone Array (Intel® Smart Sound Technologie für digitale Mikrofone)', 'pythonw'),
      { flow: 'output', device: 'Microphone Array (Intel® Smart Sound Technologie für digitale Mikrofone)', sessions: [{ app: 'ms-teams', active: true }] },
    ];
    expect(chooseAutomaticMicrophone(layout(), sessions)).toMatchObject({ deviceId: 'jabra', reason: 'communications' });
  });

  it('prefers a meeting app over a browser using another microphone', () => {
    const sessions = [
      session('Microphone Array (Intel® Smart Sound Technologie für digitale Mikrofone)', 'chrome'),
      session('Mikrofon (Jabra Evolve2 65)', 'Webex'),
    ];
    expect(chooseAutomaticMicrophone(layout(), sessions)).toMatchObject({ deviceId: 'jabra', app: 'Webex' });
    expect(chooseAutomaticMicrophone(layout(), sessions.slice(0, 1))).toMatchObject({ deviceId: 'array', app: 'Chrome' });
  });

  it('never records a loopback input, and skips virtual inputs for the defaults', () => {
    const inputs = [
      input('communications', 'Communications - Microsoft Teams Audio Device (Virtual)', 't'),
      input('default', 'Default - Stereo Mix (Realtek)', 'r'),
      input('teams', 'Microsoft Teams Audio Device (Virtual)', 't'),
      input('mix', 'Stereo Mix (Realtek)', 'r'),
      input('usb', 'USB Microphone', 'u'),
    ];
    const isVirtual = device => /virtual/i.test(device.label);
    expect(chooseAutomaticMicrophone(inputs, [session('Stereo Mix (Realtek)', 'ms-teams')], { isVirtual }))
      .toMatchObject({ deviceId: 'usb', reason: 'first' });
  });

  it('falls back to the system default, then to the first device (macOS has no communication alias)', () => {
    const mac = [input('default', 'Default - MacBook Pro Microphone', 'm'), input('mbp', 'MacBook Pro Microphone', 'm'), input('usb', 'USB Mic', 'u')];
    expect(chooseAutomaticMicrophone(mac, null)).toMatchObject({ deviceId: 'mbp', reason: 'default' });
    expect(chooseAutomaticMicrophone([input('usb', 'USB Mic')], null)).toMatchObject({ deviceId: 'usb', reason: 'first' });
    expect(chooseAutomaticMicrophone([input('default', 'Default - X')], null)).toBeNull();
  });

  it('resolves an alias by group, and by the label when the group holds several inputs', () => {
    const inputs = [
      input('default', 'Default - Line In (Realtek Audio)', 'rt'),
      input('mic', 'Microphone (Realtek Audio)', 'rt'),
      input('line', 'Line In (Realtek Audio)', 'rt'),
    ];
    expect(resolveAlias(inputs, 'default')?.deviceId).toBe('line');
    expect(resolveAlias(inputs, 'communications')).toBeNull();
  });

  it('names the meeting apps', () => {
    expect(meetingApp('ms-teams')).toEqual({ name: 'Microsoft Teams', browser: false });
    expect(meetingApp('Teams.exe')).toEqual({ name: 'Microsoft Teams', browser: false });
    expect(meetingApp('msedge')).toEqual({ name: 'Edge', browser: true });
    expect(meetingApp('Spotify')).toBeNull();
  });
});

describe('the remembered choice', () => {
  it('is automatic until the user picks a device, and survives a reload', () => {
    const store = storage();
    expect(readMicrophoneChoice(store)).toEqual({ mode: AUTO_MICROPHONE });
    storeMicrophoneChoice({ mode: 'device', deviceId: 'jabra', label: 'Jabra' }, store);
    expect(readMicrophoneChoice(store)).toEqual({ mode: 'device', deviceId: 'jabra', label: 'Jabra' });
    storeMicrophoneChoice({ mode: AUTO_MICROPHONE }, store);
    expect(readMicrophoneChoice(store)).toEqual({ mode: AUTO_MICROPHONE });
  });

  it('treats unreadable storage, junk and aliases as automatic', () => {
    expect(readMicrophoneChoice({ getItem: () => { throw new Error('blocked'); } })).toEqual({ mode: AUTO_MICROPHONE });
    expect(readMicrophoneChoice({ getItem: () => '{oops' })).toEqual({ mode: AUTO_MICROPHONE });
    expect(readMicrophoneChoice({ getItem: () => JSON.stringify({ deviceId: 'default' }) })).toEqual({ mode: AUTO_MICROPHONE });
    expect(() => storeMicrophoneChoice({ mode: 'device', deviceId: 'x' }, { setItem: () => { throw new Error('full'); } })).not.toThrow();
  });

  it('finds the chosen device by id, or by name when the id changed', () => {
    const mics = [{ id: 'a', label: 'Jabra' }, { id: 'b', label: 'Array' }];
    expect(findChosenMicrophone({ mode: 'device', deviceId: 'b', label: 'Array' }, mics)?.id).toBe('b');
    expect(findChosenMicrophone({ mode: 'device', deviceId: 'old', label: 'Jabra' }, mics)?.id).toBe('a');
    expect(findChosenMicrophone({ mode: 'device', deviceId: 'gone', label: 'Gone' }, mics)).toBeNull();
    expect(findChosenMicrophone({ mode: AUTO_MICROPHONE }, mics)).toBeNull();
  });
});
