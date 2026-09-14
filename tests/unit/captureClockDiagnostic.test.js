// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { compareGroups, clockReadout, installWitness, createClockDriver, analyzeCapturedEvidence,
  disposeCaptureTrace, finalizeCaptureControls } = require('../e2e-harness/capture-clock-diagnostic');
const { AppDriver } = require('../e2e-harness/lib/app-driver');
const directories = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('suisse-clock-evidence-')) {
      throw new Error('Refusing to remove unexpected evidence fixture: ' + target);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});
function outputDirectory() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suisse-clock-evidence-')); directories.push(directory); return directory; }

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

function witnessFixture(processingDisabled = false, { fixedFormat = false, settings = { sampleRate: 44100, channelCount: 2 } } = {}) {
  const cloneTrack = { id: 'clone', stop: vi.fn() };
  const originalTrack = { id: 'original', clone: () => cloneTrack, stop: vi.fn(), getSettings: () => settings };
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
  vm.runInNewContext('(' + installWitness.toString() + ')(' + JSON.stringify({ processingDisabled, fixedFormat }) + ')', sandbox);
  return { window, devices, source, nativeGet, originalTrack, cloneTrack, Recorder };
}

describe('native witness isolation', () => {
  it('ends the actual start loop at the first rejected format instead of retrying acquisition for 90 seconds', async () => {
    vi.useFakeTimers();
    const fixture = witnessFixture(false, { fixedFormat: true });
    class BaseDriver {
      constructor() {
        this.page = { waitForSelector: vi.fn(async () => {}), $: vi.fn(async () => null),
          evaluate: vi.fn(async () => ({ hasStart: true, hasStorage: false, hasCredit: false })) };
        this.seedUnlimitedMinutes = vi.fn(async () => {});
        this.clickByTest = vi.fn(async () => fixture.devices.getUserMedia({ audio: true }));
        this.screenshot = vi.fn(async () => {});
      }
      async evalTimed() { return fixture.window.__directMixedWitness.snapshot().errors; }
      async getPhase() { return 'idle'; }
      startRecording(...args) { return AppDriver.prototype.startRecording.apply(this, args); }
    }
    const Driver = createClockDriver(BaseDriver), driver = new Driver();
    const starting = driver.startRecording();
    const rejected = expect(starting).rejects.toThrow('Fixed diagnostic format was not negotiated: expected 48000 Hz mono');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(driver.clickByTest).toHaveBeenCalledTimes(1);
    expect(fixture.nativeGet).toHaveBeenCalledTimes(1);
    expect(driver.screenshot).not.toHaveBeenCalled();
    expect(fixture.window.__directMixedWitness.snapshot().errors).toHaveLength(1);
    await fixture.window.__directMixedWitness.dispose();
  });
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

  it.each([false, true])('requires and records an actually negotiated fixed format with processingDisabled=%s', async processingDisabled => {
    const settings = { sampleRate: 48000, channelCount: 1, echoCancellation: !processingDisabled,
      noiseSuppression: !processingDisabled, autoGainControl: !processingDisabled };
    const fixture = witnessFixture(processingDisabled, { fixedFormat: true, settings });
    const constraints = { audio: { deviceId: { exact: 'chosen' }, sampleRate: 44100, channelCount: 2, echoCancellation: true } };
    expect(await fixture.devices.getUserMedia(constraints)).toBe(fixture.source);
    expect(fixture.nativeGet.mock.calls[0][0]).toMatchObject({ audio: { deviceId: { exact: 'chosen' },
      sampleRate: { exact: 48000 }, channelCount: { exact: 1 }, echoCancellation: !processingDisabled } });
    expect(constraints.audio).toMatchObject({ sampleRate: 44100, channelCount: 2, echoCancellation: true });
    expect(fixture.window.__directMixedWitness.snapshot().acquisitions[0]).toMatchObject({ fixedFormatRequired: true,
      fixedFormatConfirmed: true, settings: [settings] });
    await fixture.window.__directMixedWitness.dispose();
    expect(fixture.originalTrack.stop).not.toHaveBeenCalled();
  });

  it.each([{ sampleRate: 44100, channelCount: 1 }, { sampleRate: 48000, channelCount: 2 }, {}])(
    'rejects mismatched or unavailable actual format and retains the evidence without leaking an acquired track: %s', async settings => {
      const fixture = witnessFixture(false, { fixedFormat: true, settings });
      await expect(fixture.devices.getUserMedia({ audio: true })).rejects.toThrow('expected 48000 Hz mono');
      expect(fixture.originalTrack.stop).toHaveBeenCalledTimes(1);
      expect(fixture.cloneTrack.stop).not.toHaveBeenCalled();
      const snapshot = fixture.window.__directMixedWitness.snapshot();
      expect(snapshot.acquisitions[0]).toMatchObject({ fixedFormatConfirmed: false, settings: [settings] });
      expect(snapshot.recorders).toEqual([]);
      expect(snapshot.errors).toContain('Fixed diagnostic format was not negotiated: expected 48000 Hz mono');
      await fixture.window.__directMixedWitness.dispose();
    });
});

describe('captured evidence survives optional trace failure', () => {
  function savedResult(directory) {
    const trace = path.join(directory, 'audio-buffer-trace.json');
    fs.writeFileSync(trace, JSON.stringify({ traceEvents: [{ name: 'WebAudioMediaStreamAudioSink::OnData',
      cat: 'disabled-by-default-mediastream', ph: 'X', pid: 1, tid: 2, ts: 100, dur: 1 }] }));
    return { options: { traceBuffers: true }, problems: [], directPath: 'native-input-original.webm',
      mixedPath: 'live-mix-original.webm', finalPath: 'published-audio.webm',
      directSha256: 'native-sha', mixedSha256: 'mixed-sha', finalSha256: 'final-sha',
      upload: { localSha256: 'final-sha', remoteSha256: 'final-sha', canDelete: false },
      bufferTrace: { file: trace, exportCompleted: true, problems: [] } };
  }

  it('grants controls only after decoded evidence and final provenance verification both succeed', async () => {
    const directory = outputDirectory(), result = savedResult(directory);
    result.options.traceBuffers = false;
    await analyzeCapturedEvidence(result, directory, async () => ({ ...groups(0, 40), durationS: 20.5, decoderWarnings: null }));
    expect(result.measurementCompleted).toBe(true);
    expect(result.controlsValid).toBe(false);
    const verify = vi.fn();
    finalizeCaptureControls(result, verify);
    expect(verify).toHaveBeenCalledOnce();
    expect(result.controlsValid).toBe(true);
  });

  it('keeps decoded evidence but invalidates controls when post-analysis provenance verification fails', async () => {
    const directory = outputDirectory(), result = savedResult(directory);
    result.options.traceBuffers = false;
    await analyzeCapturedEvidence(result, directory, async () => ({ ...groups(0, 40), durationS: 20.5, decoderWarnings: null }));
    const verify = vi.fn(() => { throw new Error('Bundle, runtime, or harness changed during diagnostic'); });
    finalizeCaptureControls(result, verify);
    expect(verify).toHaveBeenCalledOnce();
    expect(result.measurementCompleted).toBe(true);
    expect(result.controlsValid).toBe(false);
    expect(result.problems).toEqual(['Bundle, runtime, or harness changed during diagnostic']);
    for (const role of ['direct', 'mixed', 'final']) expect(JSON.parse(fs.readFileSync(path.join(directory, role + '-analysis.json'), 'utf8')).durationS).toBe(20.5);
    expect(result.finalSourceComparison.alignedFrames).toHaveLength(39);
    expect(result.upload).toEqual({ localSha256: 'final-sha', remoteSha256: 'final-sha', canDelete: false });
    // A later successful recheck cannot erase an earlier intermittent failure.
    finalizeCaptureControls(result, () => {});
    expect(result.controlsValid).toBe(false);
  });

  it('continues after rejected trace disposal and retains failed controls despite successful final provenance', async () => {
    const directory = outputDirectory(), result = savedResult(directory);
    result.options.traceBuffers = false;
    await analyzeCapturedEvidence(result, directory, async () => ({ ...groups(0, 40), durationS: 20.5, decoderWarnings: null }));
    const trace = { dispose: vi.fn().mockRejectedValue(new Error('CDP detached during cleanup')) };
    await expect(disposeCaptureTrace(trace, result.problems)).resolves.toBeUndefined();
    const verify = vi.fn();
    finalizeCaptureControls(result, verify);
    expect(verify).toHaveBeenCalledOnce();
    expect(result.problems).toEqual(['Audio trace cleanup: CDP detached during cleanup']);
    expect(result.measurementCompleted).toBe(true);
    expect(result.controlsValid).toBe(false);
    expect(result.decoded.finalDurationS).toBe(20.5);
  });

  it('retains all decoded source/final and upload evidence while unavailable upstream trace coverage still fails controls', async () => {
    const directory = outputDirectory(), result = savedResult(directory);
    const analyze = vi.fn(async () => ({ ...groups(0, 40), durationS: 20.5, decoderWarnings: null }));
    await analyzeCapturedEvidence(result, directory, analyze);
    expect(analyze.mock.calls.map(call => call[0])).toEqual([result.directPath, result.mixedPath, result.finalPath]);
    for (const role of ['direct', 'mixed', 'final']) expect(JSON.parse(fs.readFileSync(path.join(directory, role + '-analysis.json'), 'utf8')).durationS).toBe(20.5);
    expect(result.measurementCompleted).toBe(true);
    expect(result.controlsValid).toBe(false);
    expect(result.traceCoverage).toMatchObject({ complete: false });
    expect(result.problems).toContain('Missing upstream callback trace: InputController::OnData');
    expect(result.commonSourceComparison.alignedFrames).toHaveLength(39);
    expect(result.finalSourceComparison.alignedFrames).toHaveLength(39);
    expect(result.upload).toEqual({ localSha256: 'final-sha', remoteSha256: 'final-sha', canDelete: false });
    expect(result.directSha256).toBe('native-sha');
  });

  it('continues final-file analysis after trace export and one source decoder fail, without declaring complete evidence', async () => {
    const directory = outputDirectory(), result = savedResult(directory);
    result.bufferTrace.exportCompleted = false;
    result.traceProblems = ['Audio trace export: connection lost'];
    const analyze = vi.fn(async file => {
      if (file === result.mixedPath) throw new Error('invalid mixed source');
      return { ...groups(0, 40), durationS: 20.5, decoderWarnings: null };
    });
    await analyzeCapturedEvidence(result, directory, analyze);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(result.problems).toContain('Audio trace export: connection lost');
    expect(result.problems).toContain('Audio trace export did not complete');
    expect(result.problems).toContain('mixed audio analysis: invalid mixed source');
    expect(result.decoded.finalDurationS).toBe(20.5);
    expect(result.finalSourceComparison.alignedFrames).toHaveLength(39);
    expect(result.commonSourceComparison).toBeUndefined();
    expect(result.measurementCompleted).toBe(false);
    expect(result.controlsValid).toBe(false);
  });
});
