// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { extendReference, installStartupObserver, startupClockReadout, summarizeCases, validateSnapshot, measureResources, assertResources, MAX_REFERENCE_BYTES } = require('../e2e-harness/capture-startup-diagnostic');
const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('capture-startup-unit-')) {
      throw new Error('Refusing temporary cleanup outside the startup test directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

describe('diagnostic memory headroom', () => {
  const gib = 1024 ** 3;
  const readers = overrides => ({ statfs: () => ({ bavail: 10 * gib / 4096, bsize: 4096 }),
    freeMemory: () => gib, totalMemory: () => 8 * gib, availableMemory: () => 4 * gib, ...overrides });

  it('uses available memory with the unchanged 3 GiB bound while retaining lower free memory as evidence', () => {
    const measured = measureResources('unused', readers());
    expect(measured).toMatchObject({ availableBytes: 10 * gib, freeMemoryBytes: gib, availableMemoryBytes: 4 * gib,
      totalMemoryBytes: 8 * gib, requiredMemoryBytes: 3 * gib, requiredDiskBytes: 5 * gib,
      memoryMetric: 'process.availableMemory', measurementErrors: {} });
    expect(() => assertResources(measured)).not.toThrow();
    expect(() => assertResources(measureResources('unused', readers({ availableMemory: () => 3 * gib - 1 })))).toThrow(/headroom insufficient/);
  });

  it('fails explicitly without substituting free/total memory when availability is unsupported or nonfinite', () => {
    for (const availableMemory of [undefined, () => NaN, () => Infinity, () => -1, () => { throw new Error('native measurement failed'); }]) {
      const measured = measureResources('unused', readers({ availableMemory }));
      expect(measured.availableMemoryBytes).toBeNull();
      expect(measured.measurementErrors.availableMemoryBytes).toBeTruthy();
      expect(() => assertResources(measured)).toThrow(/unavailable or invalid/);
    }
  });

  it('retains disk-read failures and does not admit an under-budget disk despite ample memory', () => {
    const invalid = measureResources('unused', readers({ statfs: () => { throw new Error('disk unavailable'); } }));
    expect(invalid.measurementErrors.availableBytes).toBe('disk unavailable');
    expect(() => assertResources(invalid)).toThrow(/unavailable or invalid/);
    const tight = measureResources('unused', readers({ statfs: () => ({ bavail: 5 * gib - 1, bsize: 1 }) }));
    expect(() => assertResources(tight)).toThrow(/disk=/);
  });
});

function prefixFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-startup-unit-')); temporary.push(directory);
  const bytes = Buffer.alloc(120 * 48000 * 2 + 44, 7);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  const prefix = path.join(directory, 'prefix.wav'); fs.writeFileSync(prefix, bytes);
  return { directory, prefix, bytes };
}

describe('startup WAV load comparison controls', () => {
  it('preserves the entire PCM prefix, changes only header lengths, and writes a real zero PCM tail', () => {
    const { directory, prefix, bytes } = prefixFixture();
    const small = extendReference(prefix, path.join(directory, 'small.wav'), 120);
    const large = extendReference(prefix, path.join(directory, 'larger.wav'), 121);
    const output = fs.readFileSync(large.wavPath);
    expect(fs.readFileSync(small.wavPath).equals(bytes)).toBe(true);
    expect(output.subarray(44, bytes.length).equals(bytes.subarray(44))).toBe(true);
    expect(output.subarray(bytes.length).every(value => value === 0)).toBe(true);
    expect(output.readUInt32LE(4)).toBe(output.length - 8);
    expect(output.readUInt32LE(40)).toBe(output.length - 44);
    expect(large.bytes).toBe(121 * 96000 + 44);
    expect(large.sha256).toBe(digest(output));
    expect(small.prefixPcmSha256).toBe(digest(bytes.subarray(44)));
    expect(large.prefixPcmSha256).toBe(small.prefixPcmSha256);
    expect(MAX_REFERENCE_BYTES).toBe(1759200044);
  });

  it('rejects out-of-bounds requests and does not overwrite previously preserved evidence', () => {
    const { directory, prefix } = prefixFixture();
    const output = path.join(directory, 'output.wav');
    for (const seconds of [119, 120.5, 18326, NaN, Infinity]) expect(() => extendReference(prefix, output, seconds)).toThrow(/Invalid bounded/);
    fs.writeFileSync(output, 'retained');
    expect(() => extendReference(prefix, output, 120)).toThrow();
    expect(fs.readFileSync(output, 'utf8')).toBe('retained');
  });

  it('rejects malformed declared WAV payload sizes before writing a new output', () => {
    const { directory, prefix, bytes } = prefixFixture();
    bytes.writeUInt32LE(2, 40); fs.writeFileSync(prefix, bytes);
    const output = path.join(directory, 'bad.wav');
    expect(() => extendReference(prefix, output, 120)).toThrow(/canonical/);
    expect(fs.existsSync(output)).toBe(false);
  });

  it('reports both actual historical clock disagreements without rewriting their origin or tolerance', () => {
    const result = startupClockReadout({ firstFrame: 0, lastFrame: 36601, sourceOffsetS: -0.03 },
      { startCalledAt: 36574.2, startedAt: 38057.5, firstDataAt: 38192.8 }, { requestedAt: 27606.9, receivedAt: 33321.9 });
    expect(result.eventClockErrorS).toBeCloseTo(4.7656, 6);
    expect(result.callClockErrorS).toBeCloseTo(3.2823, 6);
    expect(result.startEventDelayS).toBeCloseTo(1.4833, 6);
    expect(result.firstFrame).toBe(0);
    expect(result).not.toHaveProperty('fiveHourQualificationPassed');
    expect(() => startupClockReadout({}, {}, {})).toThrow(/Missing/);
  });

  it('retains a completed comparison when content fails without converting the diagnostic failure into a pass', () => {
    const clock = startupClockReadout({ firstFrame: 0, lastFrame: 91, sourceOffsetS: 0 },
      { startCalledAt: 1000, startedAt: 2000, firstDataAt: 3000 }, { requestedAt: 100, receivedAt: 200 });
    const cases = [true, false].map(pass => ({ completed: true, controlsValid: true, pass, nativeClock: clock }));
    expect(summarizeCases(cases)).toMatchObject({ measurementCompleted: true, pass: false,
      comparison: { firstFrame: { small: 0, large: 0, largeMinusSmall: 0 } } });
    expect(summarizeCases(cases.slice(0, 1))).toEqual({ measurementCompleted: false, pass: false, comparison: null });
  });
});

function observerFixture() {
  let at = 100;
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
  }
  const settings = { sampleRate: 48000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const track = { id: 'input', getSettings: () => settings, clone: vi.fn(), stop: vi.fn() };
  const stream = new Stream([track]);
  const get = vi.fn(async () => { at = 200; return stream; });
  const devices = { getUserMedia: get };
  class Recorder {
    constructor(source) { this.stream = source; this.state = 'inactive'; this.listeners = {}; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    emit(name, values = {}) { for (const listener of this.listeners[name] || []) listener({ timeStamp: at, ...values }); }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; at += 25; this.emit('start'); }
    stop() { this.state = 'inactive'; at += 25; this.emit('stop'); }
  }
  class Context {
    createMediaStreamDestination() { return { stream: new Stream([{ id: 'mixed' }]) }; }
  }
  const window = { AudioContext: Context }, nativeStart = Recorder.prototype.start;
  vm.runInNewContext('(' + installStartupObserver.toString() + ')()', {
    window, navigator: { mediaDevices: devices }, MediaRecorder: Recorder, performance: { now: () => at },
  });
  return { window, devices, get, stream, track, Recorder, Context, nativeStart, setAt: value => { at = value; } };
}

describe('passive startup observer', () => {
  it('returns the original stream and constraints, adds no recorder or clone, and distinguishes native and mixer tracks', async () => {
    const fixture = observerFixture();
    const constraints = { audio: { deviceId: { exact: 'chosen' } } };
    expect(await fixture.devices.getUserMedia(constraints)).toBe(fixture.stream);
    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.get).toHaveBeenCalledWith(constraints);
    expect(fixture.track.clone).not.toHaveBeenCalled();
    expect(fixture.window.__captureStartupEvidence.snapshot().records).toHaveLength(0);
    const native = new fixture.Recorder(fixture.stream);
    const mixed = new fixture.Recorder(new fixture.window.AudioContext().createMediaStreamDestination().stream);
    native.start(1000); mixed.start(1000);
    for (const recorder of [native, mixed]) {
      recorder.emit('dataavailable', { data: { size: 0 } });
      recorder.emit('dataavailable', { data: { size: 12 } });
      recorder.emit('dataavailable', { data: { size: 9 } });
      recorder.stop();
    }
    const snapshot = fixture.window.__captureStartupEvidence.snapshot();
    expect(validateSnapshot(snapshot, true).native).toMatchObject({ role: 'native-microphone', events: 3, emptyEvents: 1, bytes: 21, firstDataBytes: 12 });
    expect(snapshot.records[1].role).toBe('live-mix');
    fixture.window.__captureStartupEvidence.dispose();
    expect(fixture.devices.getUserMedia).toBe(fixture.get);
    expect(fixture.Recorder.prototype.start).toBe(fixture.nativeStart);
    expect(fixture.window.AudioContext).toBe(fixture.Context);
    expect(fixture.track.stop).not.toHaveBeenCalled();
  });

  it('rejects system capture and repeat acquisitions before calling the native API', async () => {
    const fixture = observerFixture();
    await expect(fixture.devices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } } })).rejects.toThrow(/one synthetic/);
    expect(fixture.get).not.toHaveBeenCalled();
    await fixture.devices.getUserMedia({ audio: true });
    await expect(fixture.devices.getUserMedia({ audio: true })).rejects.toThrow(/one synthetic/);
    expect(fixture.get).toHaveBeenCalledTimes(1);
  });

  it('refuses missing lifecycle evidence and disabled processing as valid default-case controls', async () => {
    const fixture = observerFixture();
    await fixture.devices.getUserMedia({ audio: true });
    const native = new fixture.Recorder(fixture.stream);
    const mixed = new fixture.Recorder(new fixture.window.AudioContext().createMediaStreamDestination().stream);
    native.start(1000); mixed.start(1000);
    const snapshot = fixture.window.__captureStartupEvidence.snapshot();
    expect(validateSnapshot(snapshot).native.role).toBe('native-microphone');
    expect(() => validateSnapshot(snapshot, true)).toThrow(/lifecycle/);
    snapshot.acquisitions[0].settings[0].echoCancellation = false;
    expect(() => validateSnapshot(snapshot)).toThrow(/processing/);
  });
});
