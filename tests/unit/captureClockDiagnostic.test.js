// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { compareGroups, clockReadout, installWitness } = require('../e2e-harness/capture-clock-diagnostic');

const groups = (first, last, offset = 0) => ({ groups: Array.from({ length: last - first + 1 }, (_, index) => {
  const id = first + index;
  return { id, start: id * 0.5 + offset + 0.02, end: id * 0.5 + offset + 0.48 };
}) });

describe('same-source capture comparison', () => {
  it('compares shared interior identities despite different recording endpoints and a constant offset', () => {
    const result = compareGroups(groups(0, 40), groups(3, 38, -0.8));
    expect(result.commonSourceInterval).toMatchObject({ firstFrame: 4, lastFrame: 37 });
    expect(result.alignedFrames).toHaveLength(34);
    expect(result.maximumAbsoluteRelativeDriftS).toBeLessThan(1e-12);
    expect(result.problems).toEqual([]);
  });

  it('reports a missing or duplicated source identity instead of hiding it with an offset', () => {
    const mixed = groups(0, 40);
    mixed.groups = mixed.groups.filter(group => group.id !== 10);
    mixed.groups.splice(20, 0, { ...mixed.groups[19] });
    const result = compareGroups(groups(0, 40), mixed);
    expect(result.problems).toContain('Frame 10: direct groups=1, mixed groups=0');
    expect(result.problems.some(problem => problem.endsWith('mixed groups=2'))).toBe(true);
  });

  it('retains progressive drift without mistaking a constant startup offset for drift', () => {
    const mixed = groups(0, 40, 0.3);
    for (const group of mixed.groups) { group.start += group.id * 0.001; group.end += group.id * 0.001; }
    const result = compareGroups(groups(0, 40), mixed);
    expect(result.lastRelativeDriftS).toBeCloseTo(0.038, 9);
    expect(result.maximumAbsoluteRelativeDriftS).toBeCloseTo(0.038, 9);
  });

  it('detects reordered content even when every shared identity appears exactly once', () => {
    const mixed = groups(0, 40);
    [mixed.groups[10], mixed.groups[11]] = [mixed.groups[11], mixed.groups[10]];
    expect(compareGroups(groups(0, 40), mixed).problems).toContain('mixed: reordered source frame 11 followed by 10');
  });

  it('refuses insufficient common source evidence', () => {
    expect(compareGroups({ groups: [] }, groups(0, 40)).problems).toHaveLength(1);
    expect(compareGroups(groups(0, 40), groups(38, 50)).problems).toHaveLength(1);
  });

  it('identifies the actual mixer by its output track and compares elapsed clock deltas', () => {
    const snapshots = [100, 105].map((wall, index) => ({ renderer: { at: wall * 1000,
      contexts: [{ id: 1, currentTime: 50 + index * 4.9, state: 'running' }] } }));
    const result = clockReadout(snapshots, { contexts: [{ id: 1, sampleRate: 48000, destinationTrackIds: ['mixed'] }],
      recorders: [{ role: 'actual-application', trackIds: ['mixed'] }, { role: 'direct-witness', trackIds: ['clone'] }] });
    expect(result[0].isActualApplicationRecordingContext).toBe(true);
    expect(result[0].performanceMinusContextS).toBeCloseTo(0.1);
  });
});

function witnessFixture(processingDisabled = false) {
  const cloneTrack = { id: 'clone', stop: vi.fn() };
  const originalTrack = { id: 'original', clone: () => cloneTrack, stop: vi.fn(), getSettings: () => ({ sampleRate: 44100, channelCount: 2 }) };
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
  }
  class Recorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.listeners = {}; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    emit(type, detail = {}) { for (const listener of this.listeners[type] || []) listener({ timeStamp: 100, ...detail }); }
    start(interval) { this.interval = interval; this.state = 'recording'; this.emit('start'); }
    stop() { this.state = 'inactive'; this.emit('stop'); }
  }
  class Context {
    constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; }
    addEventListener() {}
    createMediaStreamDestination() { return { stream: new Stream([{ id: 'mixed' }]) }; }
  }
  const source = new Stream([originalTrack]);
  const nativeGet = vi.fn(async () => source);
  const devices = { getUserMedia: nativeGet };
  const window = { MediaRecorder: Recorder, AudioContext: Context };
  const sandbox = { window, navigator: { mediaDevices: devices }, MediaRecorder: Recorder, MediaStream: Stream,
    document: { visibilityState: 'visible' }, performance: { now: () => 100 }, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() };
  vm.runInNewContext('(' + installWitness.toString() + ')(' + JSON.stringify({ processingDisabled }) + ')', sandbox);
  return { window, devices, source, nativeGet, originalTrack, cloneTrack, Recorder };
}

describe('native witness isolation', () => {
  it('tees a clone, returns the identical acquired stream, and cleanup leaves the original track alone', async () => {
    const fixture = witnessFixture();
    const constraints = { audio: { deviceId: { exact: 'chosen' } } };
    expect(await fixture.devices.getUserMedia(constraints)).toBe(fixture.source);
    expect(fixture.nativeGet).toHaveBeenCalledWith(constraints);
    const appRecorder = new fixture.Recorder(new fixture.window.AudioContext().createMediaStreamDestination().stream);
    appRecorder.start(1000);
    expect(fixture.window.__directMixedWitness.snapshot().recorders.map(item => item.role)).toEqual(['direct-witness', 'actual-application']);
    await fixture.window.__directMixedWitness.dispose();
    expect(fixture.devices.getUserMedia).toBe(fixture.nativeGet);
    expect(fixture.originalTrack.stop).not.toHaveBeenCalled();
    expect(fixture.cloneTrack.stop).toHaveBeenCalled();
  });

  it('rejects system capture and a second acquisition while preserving the first source', async () => {
    const fixture = witnessFixture();
    await expect(fixture.devices.getUserMedia({ audio: true, video: true })).rejects.toThrow('Synthetic microphone only');
    expect(fixture.nativeGet).not.toHaveBeenCalled();
    await fixture.devices.getUserMedia({ audio: true });
    await expect(fixture.devices.getUserMedia({ audio: true })).rejects.toThrow('Single-source');
    expect(fixture.nativeGet).toHaveBeenCalledTimes(1);
    await fixture.window.__directMixedWitness.dispose();
  });

  it('disables only requested processing flags and records the actual negotiated format', async () => {
    const fixture = witnessFixture(true);
    await fixture.devices.getUserMedia({ audio: { deviceId: { exact: 'chosen' }, channelCount: 1 } });
    expect(fixture.nativeGet.mock.calls[0][0]).toMatchObject({ audio: { deviceId: { exact: 'chosen' }, channelCount: 1,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    expect(fixture.window.__directMixedWitness.snapshot().acquisitions[0].settings[0]).toEqual({ sampleRate: 44100, channelCount: 2 });
    await fixture.window.__directMixedWitness.dispose();
  });
});
