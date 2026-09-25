/**
 * SLEEP: recording across system sleep and macOS dark wakes
 * (ELECTRON-6G, 6H, 6J, 6K, 6M, 6N, 6P, 6Q, 6R, 6S — 2026-09-25).
 *
 * A MacBook lid was closed mid-recording. The built-in microphone vanished,
 * auto-recovery moved the recording onto "Microsoft Teams Audio Device
 * (Virtual)", the renderer froze for 16 minutes, and dark wakes then ran the
 * timers for a few seconds at a time with audio I/O powered down. Every
 * wall-clock detector judged the frozen time: a 5s switch probe, a 989s
 * "zero signal" run, a 997s "capture stall", and a 3s grace timer that fired
 * 16 minutes late. When the lid opened, the recording was still on the
 * silent virtual device.
 *
 * Simulation: vi.setSystemTime() jumps the wall clock without running timers
 * (the renderer is frozen; fake timers keep their monotonic schedule), and
 * the mock AudioContext clock stands still while ctrl.clockFrozen is set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ messages: [] }));
vi.mock('../../src/boot/sentry', () => ({
  captureMessage: (message, level = 'info') => { sentry.messages.push({ message, level }); }
}));

import * as recordingService from '../../src/services/recordingService';

const ctrl = {
  amplitude: 0.1,
  byteVal: 50,
  clockFrozen: false,
  frozenAt: 0,
  clockLostS: 0, // audio time that never rendered (frozen spans)
  chunksFlow: true,
  deviceAmplitude: {} // per physical device; others use `amplitude`
};

function amplitudeFor(stream) {
  const id = stream?.getAudioTracks?.()[0]?.getSettings?.().deviceId;
  return id in ctrl.deviceAmplitude ? ctrl.deviceAmplitude[id] : ctrl.amplitude;
}

// The audio clock renders with the monotonic clock, stands still while audio
// I/O is powered down and resumes where it stopped (it never jumps ahead).
const audioNow = () => performance.now() / 1000 - ctrl.clockLostS;
function freezeAudioClock() {
  if (ctrl.clockFrozen) return;
  ctrl.frozenAt = audioNow();
  ctrl.clockFrozen = true;
}
function resumeAudioClock() {
  if (!ctrl.clockFrozen) return;
  ctrl.clockLostS = performance.now() / 1000 - ctrl.frozenAt;
  ctrl.clockFrozen = false;
}

class MockAnalyser {
  constructor() { this.fftSize = 256; this.frequencyBinCount = 128; this.source = null; }
  getByteFrequencyData(array) { array.fill(amplitudeFor(this.source) > 0 ? ctrl.byteVal : 0); }
  getFloatTimeDomainData(buf) {
    const amplitude = amplitudeFor(this.source);
    for (let i = 0; i < buf.length; i++) buf[i] = amplitude * Math.sin(i * 0.3);
  }
}

class MockAudioContext {
  constructor() { this.state = 'running'; }
  // Advances with the monotonic clock unless audio I/O is powered down.
  get currentTime() { return ctrl.clockFrozen ? ctrl.frozenAt : audioNow(); }
  createAnalyser() { return new MockAnalyser(); }
  createMediaStreamSource(stream) {
    return { connect: node => { if (node instanceof MockAnalyser) node.source = stream; }, disconnect: () => {} };
  }
  createMediaStreamDestination() { return { stream: new MockMediaStream([]) }; }
  close() { this.state = 'closed'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
}

class MockMediaRecorder {
  constructor(source) {
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    if (!source?.getAudioTracks().length) MockMediaRecorder.last = this;
  }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  requestData() {}
}
MockMediaRecorder.isTypeSupported = () => true;

class MockMediaStream {
  constructor(tracks = []) { this._tracks = tracks; }
  getAudioTracks() { return this._tracks; }
  getVideoTracks() { return []; }
  getTracks() { return this._tracks; }
}

function createTrack({ deviceId, groupId, label }) {
  return {
    kind: 'audio', enabled: true, muted: false, readyState: 'live', stop: vi.fn(),
    getSettings: () => ({ deviceId, groupId }), label,
    onended: null, onmute: null, onunmute: null
  };
}

const MBP = { kind: 'audioinput', deviceId: 'mbp', groupId: 'grp-mbp', label: 'MacBook Pro Microphone (Built-in)' };
const DEFAULT_MBP = { kind: 'audioinput', deviceId: 'default', groupId: 'grp-mbp', label: 'Default - MacBook Pro Microphone (Built-in)' };
const TEAMS = { kind: 'audioinput', deviceId: 'teams', groupId: 'grp-teams', label: 'Microsoft Teams Audio Device (Virtual)' };
const DEFAULT_TEAMS = { kind: 'audioinput', deviceId: 'default', groupId: 'grp-teams', label: 'Default - Microsoft Teams Audio Device (Virtual)' };
const USB = { kind: 'audioinput', deviceId: 'usb', groupId: 'grp-usb', label: 'USB Mic (USB)' };

// What the OS reports right now, what cannot be opened, and every
// microphone the service asked for (in order).
let world;

function installDevices() {
  navigator.mediaDevices.enumerateDevices.mockImplementation(async () => world.inputs.map(d => ({ ...d })));
  navigator.mediaDevices.getUserMedia.mockImplementation(async ({ audio }) => {
    const id = audio?.deviceId?.exact || audio?.deviceId?.ideal || 'default';
    world.opened.push(id);
    const device = world.inputs.find(d => d.deviceId === id);
    if (!device || world.unopenable.has(id)) throw new DOMException('Requested device not found', 'NotFoundError');
    const delay = world.openDelayMs[id];
    if (delay) {
      await new Promise(resolve => setTimeout(resolve, delay));
      throw new DOMException('Device busy', 'NotReadableError');
    }
    if (world.slowOpenMs[id]) await new Promise(resolve => setTimeout(resolve, world.slowOpenMs[id]));
    const physical = id === 'default'
      ? world.inputs.find(d => d.deviceId !== 'default' && d.groupId === device.groupId)
      : device;
    const track = createTrack(physical);
    world.tracks.push(track);
    return new MockMediaStream([track]);
  });
}

function createStore() {
  return {
    startRecording: vi.fn().mockResolvedValue({ success: true }),
    confirmCaptureStarted: vi.fn(),
    stopRecording: vi.fn().mockResolvedValue({ success: true, filePath: 'fake.webm' }),
    reset: vi.fn(),
    saveChunk: vi.fn().mockResolvedValue({ success: true }),
    setError: vi.fn(),
    updateDuration: vi.fn(),
    handleRecordingDeath: vi.fn(),
    chunkSaveErrors: 0,
    chunkSaveErrorWarning: false,
    isRecording: false,
    isPaused: false,
    recordingInterrupted: false,
    chunkIndex: 0,
    recordId: 'rec-sleep'
  };
}

let chunkTimer = null;

async function startRecording(store, { deviceId = null } = {}) {
  if (window.electronAPI?.recording) {
    for (const method of ['beginSource', 'markSourceStarted', 'saveSourceChunk', 'endSource', 'setInProgress', 'setProcessing', 'setUnsavedAudio', 'saveMetadata']) {
      window.electronAPI.recording[method] ||= vi.fn(async () => ({ success: true }));
    }
  }
  const result = await recordingService.startRecording({
    recordingStore: store, authStore: null, deviceId,
    systemAudioEnabled: false, captureSystemAudio: null,
    isAutoSplitting: { value: false }, maxRecordingSeconds: null
  });
  expect(result.success).toBe(true);
  store.isRecording = true;
  const recorder = MockMediaRecorder.last;
  chunkTimer = setInterval(() => {
    if (ctrl.chunksFlow && recorder.state === 'recording') {
      recorder.ondataavailable?.({ target: recorder, data: { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } });
    }
  }, 1000);
  return { micTrack: world.tracks[0], recorder };
}

/** Lid closed / system asleep: audio stops, then the renderer is frozen for `ms`. */
function sleepFor(ms) {
  ctrl.chunksFlow = false;
  freezeAudioClock();
  vi.setSystemTime(Date.now() + ms);
}

/** Full wake: audio I/O is powered again. */
function wake() {
  resumeAudioClock();
  ctrl.chunksFlow = true;
}

function health() {
  return recordingService.getState().recordingHealth;
}

function fireDeviceChange() {
  const call = navigator.mediaDevices.addEventListener.mock.calls.filter(c => c[0] === 'devicechange').at(-1);
  return call[1]();
}

describe('recording across system sleep and dark wakes (ELECTRON-6G…6S)', () => {
  let events;
  let listeners;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    Object.assign(ctrl, { amplitude: 0.1, byteVal: 50, clockFrozen: false, frozenAt: 0, clockLostS: 0, chunksFlow: true, deviceAmplitude: {} });
    sentry.messages = [];
    MockMediaRecorder.last = null;
    global.MediaRecorder = MockMediaRecorder;
    global.MediaStream = MockMediaStream;
    global.window.AudioContext = MockAudioContext;
    global.window.webkitAudioContext = MockAudioContext;
    global.navigator.mediaDevices = {
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    world = { inputs: [DEFAULT_MBP, MBP, TEAMS], unopenable: new Set(), openDelayMs: {}, slowOpenMs: {}, opened: [], tracks: [] };
    installDevices();

    events = { stalled: [], recovered: [], recoveryFailed: [], autoSwitched: [], health: [] };
    listeners = {
      captureStalled: d => events.stalled.push(d),
      captureRecovered: d => events.recovered.push(d),
      captureRecoveryFailed: d => events.recoveryFailed.push(d),
      micAutoSwitched: d => events.autoSwitched.push(d),
      healthChange: d => events.health.push(d)
    };
    for (const [event, fn] of Object.entries(listeners)) recordingService.addEventListener(event, fn);
  });

  afterEach(async () => {
    for (const [event, fn] of Object.entries(listeners)) recordingService.removeEventListener(event, fn);
    clearInterval(chunkTimer);
    await recordingService.cleanup();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete window.electronAPI;
  });

  // The Record page preselects the first enumerated input, i.e. Chromium's
  // 'default' alias; null is the plain system default.
  it.each([null, 'default'])('replays the lid-close incident (mic %s): nothing judges the sleep, no virtual input, the built-in mic returns on wake', async deviceId => {
    const store = createStore();
    const { micTrack } = await startRecording(store, { deviceId }); // resolves to the built-in mic
    await vi.advanceTimersByTimeAsync(10000);
    expect(health().status).toBe('ok');

    // Lid closes: audio stops and the built-in mic's track ends. It is still
    // listed for a moment but can no longer be opened, and macOS points the
    // 'default' alias at the only input left: the Teams virtual device.
    ctrl.chunksFlow = false;
    world.inputs = [DEFAULT_TEAMS, MBP, TEAMS];
    world.unopenable = new Set(['mbp']);
    micTrack.readyState = 'ended';
    micTrack.onended();
    await vi.advanceTimersByTimeAsync(500);
    expect(health().reasonCode).toBe('track_ended');

    // The incident: sleep 989s, dark wake 4s, sleep 1056s, dark wake 7s.
    world.inputs = [DEFAULT_TEAMS, TEAMS];
    sleepFor(989000);
    await vi.advanceTimersByTimeAsync(4000);
    sleepFor(1056000);
    await vi.advanceTimersByTimeAsync(7000);

    expect(world.opened).not.toContain('teams');
    expect(world.opened.filter(id => id === 'default')).toHaveLength(1); // only the initial start
    expect(events.stalled).toEqual([]);
    expect(events.recoveryFailed).toEqual([]);
    expect(health().reasonCode).toBe('track_ended');

    // The lid opens: a full wake, and the built-in mic is back.
    world.inputs = [DEFAULT_MBP, MBP, TEAMS];
    world.unopenable = new Set();
    sleepFor(600000);
    wake();
    await vi.advanceTimersByTimeAsync(1000);

    expect(events.autoSwitched).toHaveLength(1);
    expect(health().status).toBe('ok');
    expect(health().trackLabel).toBe('MacBook Pro Microphone (Built-in)');
    expect(world.opened).not.toContain('teams');
    expect(events.stalled).toEqual([]);
    expect(sentry.messages.filter(m => m.level === 'error')).toEqual([]);
  });

  it('judges a switch probe that spans a sleep on awake audio only', async () => {
    world.inputs = [DEFAULT_MBP, MBP, USB];
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(2000);

    ctrl.amplitude = 0; // nobody has spoken into the new mic yet
    ctrl.byteVal = 0;
    const result = await recordingService.switchMicrophoneStream('usb');
    expect(result.success).toBe(true);
    let verdict;
    result.verified.then(v => { verdict = v; });
    await vi.advanceTimersByTimeAsync(1000); // probe pending when the lid closes

    sleepFor(600000);
    await vi.advanceTimersByTimeAsync(7000); // dark wake: clock frozen
    expect(verdict).toBeUndefined();
    expect(health().verifying).toBe(true);

    wake();
    ctrl.amplitude = 0.1;
    ctrl.byteVal = 50;
    await vi.advanceTimersByTimeAsync(300);
    expect(verdict).toBe('signal');
    expect(health().status).toBe('ok');
  });

  it('never counts sleep toward zero signal, but still catches real zeros after the wake', async () => {
    const store = createStore();
    await startRecording(store, { deviceId: 'mbp' });
    await vi.advanceTimersByTimeAsync(2000);

    ctrl.amplitude = 0;
    ctrl.byteVal = 0;
    await vi.advanceTimersByTimeAsync(5000);
    sleepFor(900000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(health().reasonCode).not.toBe('zero_signal');
    expect(world.opened).toEqual(['mbp']); // no re-acquire for a sleep
    expect(sentry.messages.some(m => /ZERO SIGNAL/.test(m.message))).toBe(false);

    wake(); // awake, and the device really delivers zeros
    await vi.advanceTimersByTimeAsync(16000);
    expect(health().reasonCode).toBe('zero_signal');
    expect(world.opened).toEqual(['mbp', 'mbp']); // exactly one same-device re-acquire
  });

  it('does not report the sleep as a capture stall, but still catches a real stall after the wake', async () => {
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);

    sleepFor(997000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(events.stalled).toEqual([]);

    // Awake with a running audio clock, but the recorder produces nothing.
    resumeAudioClock();
    await vi.advanceTimersByTimeAsync(31000);
    expect(events.stalled).toHaveLength(1);
    expect(events.stalled[0].secondsSinceLastChunk).toBeLessThan(40);
    expect(sentry.messages.find(m => /capture STALLED/.test(m.message)).level).toBe('warning');
  });

  it('never fakes a recovered capture when the app is foregrounded during a recovery episode', async () => {
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(5000);

    ctrl.chunksFlow = false; // a real stall while awake
    await vi.advanceTimersByTimeAsync(36000);
    expect(events.stalled).toHaveLength(1);

    recordingService.notifyForegrounded();
    await vi.advanceTimersByTimeAsync(10000);
    expect(events.recovered).toEqual([]);
    expect(sentry.messages.some(m => /capture RECOVERED/.test(m.message))).toBe(false);

    ctrl.chunksFlow = true;
    await vi.advanceTimersByTimeAsync(6000);
    expect(events.recovered.length).toBeGreaterThan(0);
  });

  it('does not let a grace timer that fires after a sleep overwrite a live replacement’s verdict', async () => {
    world.inputs = [MBP, USB];
    const store = createStore();
    const { micTrack } = await startRecording(store, { deviceId: 'mbp' });
    await vi.advanceTimersByTimeAsync(2000);

    ctrl.amplitude = 0; // the replacement turns out to deliver nothing
    ctrl.byteVal = 0;
    world.inputs = [USB];
    micTrack.readyState = 'ended';
    micTrack.onended();
    await vi.advanceTimersByTimeAsync(200); // auto-recovery opened 'usb'; its probe is pending
    expect(world.opened).toEqual(['mbp', 'usb']);

    sleepFor(900000);
    wake();
    const afterWake = events.health.length;
    await vi.advanceTimersByTimeAsync(8000); // grace fires ~3s after the wake, the verdict at ~5s

    const stale = events.health.slice(afterWake).filter(h => h.reasonCode === 'track_ended');
    expect(stale).toEqual([]);
    expect(health().reasonCode).toBe('zero_signal');
    expect(health().afterSwitch).toBe(true);
    expect(world.opened).toEqual(['mbp', 'usb']); // no re-acquire racing the recovery pass
  });

  it.each([null, 'default'])('keeps the capture-recovery re-acquire off virtual inputs through a long dark wake (mic %s)', async deviceId => {
    const store = createStore();
    const { micTrack } = await startRecording(store, { deviceId });
    await vi.advanceTimersByTimeAsync(5000);

    ctrl.chunksFlow = false;
    world.inputs = [DEFAULT_TEAMS, TEAMS];
    micTrack.readyState = 'ended';
    micTrack.onended();
    await vi.advanceTimersByTimeAsync(500);

    sleepFor(900000);
    await vi.advanceTimersByTimeAsync(75000); // long enough for the stall watchdog and INT-2 to run
    expect(sentry.messages.some(m => /capture recovery started/.test(m.message))).toBe(true);
    expect(world.opened).not.toContain('teams');
    expect(world.opened.filter(id => id === 'default')).toHaveLength(1);
    expect(health().reasonCode).toBe('track_ended');

    world.inputs = [DEFAULT_MBP, MBP, TEAMS];
    sleepFor(60000);
    wake();
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.autoSwitched).toHaveLength(1);
    expect(health().status).toBe('ok');
    expect(health().trackLabel).toBe('MacBook Pro Microphone (Built-in)');
  });

  it('does not push a recovery episode that starts right after a wake into the future', async () => {
    const store = createStore();
    const { micTrack } = await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);

    sleepFor(600000);
    wake();
    micTrack.onmute(); // the first task after the freeze is a track event, not one of our timers
    await vi.advanceTimersByTimeAsync(40000);

    expect(events.recoveryFailed).toEqual([]);
    expect(sentry.messages.some(m => /capture RECOVERED/.test(m.message))).toBe(true);
    expect(sentry.messages.filter(m => m.level === 'error')).toEqual([]);
  });

  it('tells the user the real gap, sleep included, when capture comes back after a wake', async () => {
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(5000);

    ctrl.chunksFlow = false; // a real stall while awake
    await vi.advanceTimersByTimeAsync(41000);
    expect(events.stalled).toHaveLength(1);

    sleepFor(600000);
    wake();
    await vi.advanceTimersByTimeAsync(12000);
    const recovered = events.recovered.find(e => e.gapSeconds !== undefined);
    expect(recovered.gapSeconds).toBeGreaterThanOrEqual(600);
    expect(events.recoveryFailed).toEqual([]);
  });

  it('keeps counting a stall while throttled timers run with audio still rendering (hidden mobile WebView)', async () => {
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);

    ctrl.chunksFlow = false; // capture really stalls; the audio clock keeps running
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + 55000); // timers throttled to about once a minute...
      ctrl.clockLostS -= 55; // ...while that audio kept rendering
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(events.stalled).toHaveLength(1);
    expect(sentry.messages.find(m => /capture STALLED/.test(m.message)).level).toBe('error');
  });

  it('moves off a silent fallback when the input set changes during the pass', async () => {
    world.inputs = [MBP, USB];
    ctrl.deviceAmplitude = { usb: 0 }; // the only other input delivers nothing
    const store = createStore();
    const { micTrack } = await startRecording(store, { deviceId: 'mbp' });
    await vi.advanceTimersByTimeAsync(2000);

    world.inputs = [USB];
    micTrack.readyState = 'ended';
    micTrack.onended();
    await vi.advanceTimersByTimeAsync(1000); // USB probe pending
    world.inputs = [USB, MBP]; // the built-in mic comes back mid-pass
    await fireDeviceChange();
    await vi.advanceTimersByTimeAsync(8000);

    expect(events.autoSwitched.map(e => e.deviceId)).toEqual(['mbp']);
    expect(health().status).toBe('ok');
    expect(health().trackLabel).toBe('MacBook Pro Microphone (Built-in)');
  });

  it('does not re-probe the same silent inputs on device changes that bring nothing new', async () => {
    world.inputs = [MBP, USB];
    ctrl.deviceAmplitude = { usb: 0 };
    const store = createStore();
    const { micTrack } = await startRecording(store, { deviceId: 'mbp' });
    await vi.advanceTimersByTimeAsync(2000);

    world.inputs = [USB];
    micTrack.readyState = 'ended';
    micTrack.onended();
    // USB judged silent (5s), the recording stays on it, and the zero-signal
    // episode spends its one same-device re-acquire (15s + 5s probe).
    await vi.advanceTimersByTimeAsync(30000);
    expect(world.opened).toEqual(['mbp', 'usb', 'usb']);
    const opens = world.opened.length;

    for (let i = 0; i < 3; i++) { // e.g. Bluetooth profile flips on the output side
      await fireDeviceChange();
      await vi.advanceTimersByTimeAsync(6000);
    }
    expect(world.opened).toHaveLength(opens);
    expect(health().reasonCode).toBe('zero_signal');
  });

  it('never replaces a device the user picks while auto-recovery is still opening a candidate', async () => {
    const micA = { kind: 'audioinput', deviceId: 'a', groupId: 'grp-a', label: 'Mic A (USB)' };
    const micB = { kind: 'audioinput', deviceId: 'b', groupId: 'grp-b', label: 'Mic B (USB)' };
    const pick = { kind: 'audioinput', deviceId: 'pick', groupId: 'grp-pick', label: 'User Pick (USB)' };
    world.inputs = [MBP, micA, micB, pick];
    const store = createStore();
    const { micTrack } = await startRecording(store, { deviceId: 'mbp' });
    await vi.advanceTimersByTimeAsync(2000);

    world.inputs = [micA, micB, pick];
    world.slowOpenMs = { a: 2000 };
    micTrack.readyState = 'ended';
    micTrack.onended();
    await vi.advanceTimersByTimeAsync(500); // auto-recovery waits for Mic A to open
    const picked = await recordingService.switchMicrophoneStream('pick');
    expect(picked.success).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);

    expect(world.opened).not.toContain('b');
    expect(health().trackLabel).toBe('User Pick (USB)');
    expect(health().status).toBe('ok');
  });

  it('abandons a switch probe that cannot measure for two minutes instead of latching recovery', async () => {
    world.inputs = [MBP, USB];
    const store = createStore();
    const { micTrack } = await startRecording(store, { deviceId: 'mbp' });
    await vi.advanceTimersByTimeAsync(2000);

    world.inputs = [USB];
    ctrl.deviceAmplitude = { usb: 0 }; // a context that never rendered reads zeros
    freezeAudioClock(); // awake, but audio does not render (no timer gap)
    micTrack.readyState = 'ended';
    micTrack.onended();
    await vi.advanceTimersByTimeAsync(125000);
    expect(sentry.messages.some(m => /could not be measured/.test(m.message))).toBe(true);

    resumeAudioClock();
    world.inputs = [USB, MBP];
    const pass = fireDeviceChange(); // a new pass can run: nothing stayed latched
    await vi.advanceTimersByTimeAsync(1000);
    await pass;
    expect(events.autoSwitched).toHaveLength(1);
  }, 30000);

  it('still recovers when a device the user just picked is unplugged during its probe', async () => {
    world.inputs = [MBP, USB];
    const store = createStore();
    await startRecording(store, { deviceId: 'mbp' });
    await vi.advanceTimersByTimeAsync(2000);

    ctrl.amplitude = 0;
    ctrl.byteVal = 0;
    const picked = await recordingService.switchMicrophoneStream('usb');
    expect(picked.success).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);

    const usbTrack = world.tracks.at(-1);
    world.inputs = [MBP];
    ctrl.amplitude = 0.1;
    ctrl.byteVal = 50;
    usbTrack.readyState = 'ended';
    usbTrack.onended();
    await vi.advanceTimersByTimeAsync(1000);

    expect(events.autoSwitched.map(e => e.deviceId)).toEqual(['mbp']);
    expect(health().status).toBe('ok');
  });

  it('keeps a virtual input the user explicitly chose as a recovery candidate', async () => {
    const krisp = { kind: 'audioinput', deviceId: 'krisp', groupId: 'grp-krisp', label: 'Krisp Microphone (Virtual)' };
    world.inputs = [krisp, TEAMS];
    const store = createStore();
    const { micTrack } = await startRecording(store, { deviceId: 'krisp' });
    await vi.advanceTimersByTimeAsync(2000);

    micTrack.readyState = 'ended';
    micTrack.onended();
    await vi.advanceTimersByTimeAsync(1000);

    expect(world.opened).toEqual(['krisp', 'krisp']);
    expect(events.autoSwitched.map(e => e.deviceId)).toEqual(['krisp']);
    expect(health().status).toBe('ok');
  });

  it('re-runs recovery for a device change that arrived while a pass was probing', async () => {
    world.inputs = [MBP, USB];
    const store = createStore();
    const { micTrack } = await startRecording(store, { deviceId: 'mbp' });
    await vi.advanceTimersByTimeAsync(2000);

    // The first pass only finds a USB mic that is busy and fails slowly…
    world.inputs = [USB];
    world.openDelayMs = { usb: 2000 };
    micTrack.readyState = 'ended';
    micTrack.onended();
    await vi.advanceTimersByTimeAsync(1000);

    // …while the built-in mic comes back and announces itself mid-pass.
    world.inputs = [USB, MBP];
    await fireDeviceChange();
    await vi.advanceTimersByTimeAsync(20000);

    expect(events.autoSwitched.map(e => e.deviceId)).toEqual(['mbp']);
    expect(health().status).toBe('ok');
  });

  it('looks for the lost microphone again when the app returns to the foreground', async () => {
    world.inputs = [MBP];
    const store = createStore();
    const { micTrack } = await startRecording(store, { deviceId: 'mbp' });
    await vi.advanceTimersByTimeAsync(2000);

    world.inputs = [TEAMS];
    micTrack.readyState = 'ended';
    micTrack.onended();
    await vi.advanceTimersByTimeAsync(4000);
    expect(health().reasonCode).toBe('track_ended');

    world.inputs = [MBP, TEAMS]; // back, but no devicechange reached the renderer
    recordingService.notifyForegrounded();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.autoSwitched.map(e => e.deviceId)).toEqual(['mbp']);
    expect(world.opened).not.toContain('teams');
  });

  it('does not declare the recorder wedged while a dark wake keeps the audio clock frozen (desktop)', async () => {
    window.electronAPI = { recording: {} };
    const store = createStore();
    await startRecording(store);
    await vi.advanceTimersByTimeAsync(10000);

    sleepFor(900000);
    await vi.advanceTimersByTimeAsync(75000); // a long dark wake (Power Nap)
    expect(events.recoveryFailed).toEqual([]);
    const stallReports = sentry.messages.filter(m => /STALLED/.test(m.message));
    expect(stallReports.length).toBeGreaterThan(0);
    expect(stallReports.every(m => m.level === 'warning')).toBe(true);

    wake();
    await vi.advanceTimersByTimeAsync(6000);
    expect(events.recoveryFailed).toEqual([]);
    expect(events.recovered.length).toBeGreaterThan(0);
  });

  it('classifies virtual and loopback inputs', () => {
    for (const label of [
      'Microsoft Teams Audio Device (Virtual)',
      'Default - Microsoft Teams Audio Device (Virtual)',
      'ZoomAudioDevice (Virtual)',
      'BlackHole 2ch (Virtual)',
      'Aggregate Device (Aggregate)',
      'CABLE Output (VB-Audio Virtual Cable)',
      'Stereo Mix (Realtek(R) Audio)',
      'Stereomix (Realtek(R) Audio)',
      'Loopback Audio',
      'Line 1 (Virtual Audio Cable)',
      'Voicemod Virtual Audio Device (WDM)',
      'Steam Streaming Microphone'
    ]) expect(recordingService.isLikelyVirtualInput({ label })).toBe(true);
    for (const label of [
      'MacBook Pro Microphone (Built-in)',
      'AirPods Pro (Bluetooth)',
      'Jabra Speak 510 (USB)',
      'Microphone (Realtek(R) Audio)',
      'Headset (Jabra Evolve2 65)',
      'Microphone Array (Intel® Smart Sound Technology for Digital Microphones)',
      'Jabra Speak 750 MS Teams',
      'Microphone (HyperX Virtual Surround Sound)',
      'Behringer Stereo Mixer',
      ''
    ]) expect(recordingService.isLikelyVirtualInput({ label })).toBe(false);
  });
});
