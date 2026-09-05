// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { classifyWitnessRecorders, legacyChunkFiles, legacyBatchLayout, installRecordingRoleObserver } = require('../e2e-harness/lib/native-recorder-evidence');

function capture({ extra = false, archived = true } = {}) {
  return { acquisitions: [{ sourceTrackIds: ['mic'] }], contexts: [{ destinationTrackIds: ['mix'] }], recorders: [
    { role: 'direct-witness', trackIds: ['witness'] },
    { role: 'actual-application', trackIds: ['mix'] },
    ...(archived ? [{ role: 'actual-application', trackIds: ['mic'] }] : []),
    ...(extra ? [{ role: 'actual-application', trackIds: ['unknown'] }] : []),
  ] };
}

describe('native and actual mixer recorder identities', () => {
  it('classifies by source/destination track even when the archive is last', () => {
    const result = classifyWitnessRecorders(capture(), 1);
    expect(result.problems).toEqual([]);
    expect(result.mixed.trackIds).toEqual(['mix']);
    expect(result.native[0].trackIds).toEqual(['mic']);
  });
  it('keeps the old two-recorder diagnostic explicit and rejects missing expected archives', () => {
    expect(classifyWitnessRecorders(capture({ archived: false }), 0).problems).toEqual([]);
    expect(classifyWitnessRecorders(capture({ archived: false }), 1).problems).toContain('Expected 1 native archive recorders, observed 0');
    expect(classifyWitnessRecorders(capture(), 0).problems).toContain('Expected 0 native archive recorders, observed 1');
  });
  it('rejects unclassified or duplicate live mix recorders rather than allowing any count', () => {
    expect(classifyWitnessRecorders(capture({ extra: true }), 1).problems).toContain('Unclassified application recorder observed');
    const duplicated = capture(); duplicated.recorders.push({ role: 'actual-application', trackIds: ['mix'] });
    expect(classifyWitnessRecorders(duplicated, 1).problems).toContain('Expected exactly one actual live-mix recorder');
  });
});

const folders = [];
function diskFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suisse-recorder-evidence-')); folders.push(root);
  const put = (relative, content = 'audio') => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  return { root, put };
}
afterEach(() => {
  vi.useRealTimers();
  for (const folder of folders.splice(0)) {
    if (!path.resolve(folder).startsWith(path.join(os.tmpdir(), 'suisse-recorder-evidence-'))) throw new Error('Invalid fixture cleanup path');
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe('retaining the real mixed stream independently of the protected final', () => {
  it('counts two archived rotations and the final retained batch without counting empty or native directories', () => {
    const { root, put } = diskFixture();
    put('source-chunks/100/chunk_0.webm'); put('source-chunks/200/chunk_1.webm'); put('chunks/chunk_2.webm');
    put('native-sources/native/chunks/chunk_0.webm');
    fs.mkdirSync(path.join(root, 'source-chunks/300'));
    expect(legacyBatchLayout(root)).toMatchObject({ batches: 3, archivedBatches: 2, activeBatchRetained: true });
    fs.unlinkSync(path.join(root, 'chunks/chunk_2.webm'));
    expect(legacyBatchLayout(root)).toMatchObject({ batches: 2, archivedBatches: 2, activeBatchRetained: false });
    put('source-chunks/300/chunk_2.webm');
    expect(legacyBatchLayout(root)).toMatchObject({ batches: 3, archivedBatches: 3, activeBatchRetained: false });
  });
  it('orders only legacy chunks across batches, excluding native chunks and final artifacts', () => {
    const { root, put } = diskFixture();
    put('source-chunks/100/chunk_0.webm'); put('chunks/chunk_1.webm');
    put('native-sources/native/chunks/chunk_0.webm', 'protected input'); put('audio.webm', 'protected final');
    const files = legacyChunkFiles(root);
    expect(files.map(file => file.index)).toEqual([0, 1]);
    expect(files.every(file => !file.file.includes('native-sources'))).toBe(true);
  });
  it('rejects missing and duplicated legacy indices instead of replacing the comparison with final audio', () => {
    const { root, put } = diskFixture(); put('chunks/chunk_1.webm');
    expect(() => legacyChunkFiles(root)).toThrow('missing or duplicate');
    put('chunks/chunk_0.webm'); put('source-chunks/100/chunk_0.webm');
    expect(() => legacyChunkFiles(root)).toThrow('missing or duplicate');
  });
});

function observerFixture(delayRole) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  class BlobFixture {
    constructor(value) { this.value = value; this.size = 1; this.type = 'audio/webm;codecs=opus'; }
    arrayBuffer() { return Promise.resolve(Uint8Array.of(this.value).buffer); }
  }
  class Recorder {
    constructor(id) { this.state = 'inactive'; this.stream = { getAudioTracks: () => [{ id }] }; this.listeners = {}; }
    start() { this.state = 'recording'; this.emit('start'); }
    stop() { this.state = 'inactive'; this.emit('stop'); }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    emit(type, data) {
      const event = { data, target: this, timeStamp: performance.now() };
      this['on' + type]?.(event);
      for (const listener of this.listeners[type] || []) listener(event);
    }
  }
  class Context {
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ id: 'mixed' }] } }; }
  }
  const window = { AudioContext: Context, webkitAudioContext: Context };
  const originalStart = Recorder.prototype.start, originalArrayBuffer = BlobFixture.prototype.arrayBuffer;
  vm.runInNewContext('(' + installRecordingRoleObserver.toString() + ')(' + JSON.stringify({ delayRole }) + ')',
    { window, Blob: BlobFixture, MediaRecorder: Recorder, performance, setTimeout, clearTimeout });
  const native = new Recorder('mic'), mixed = new Recorder('mixed');
  const conversions = [];
  for (const recorder of [native, mixed]) recorder.ondataavailable = event => {
    conversions.push({ recorder, promise: event.data.arrayBuffer() });
  };
  native.start(1000); // Real app starts archive before constructing its mixer.
  new window.AudioContext().createMediaStreamDestination(); mixed.start(1000);
  return { window, native, mixed, BlobFixture, conversions, Recorder, originalStart, originalArrayBuffer, Context };
}

describe('deterministic source-specific Blob delay', () => {
  it('delays the mixed Blob even though the native archive emits first', async () => {
    const fixture = observerFixture('live-mix');
    fixture.native.emit('dataavailable', new fixture.BlobFixture(11));
    fixture.mixed.emit('dataavailable', new fixture.BlobFixture(22));
    expect(new Uint8Array(await fixture.conversions[0].promise)).toEqual(Uint8Array.of(11));
    let mixedDone = false; fixture.conversions[1].promise.then(() => { mixedDone = true; });
    await vi.advanceTimersByTimeAsync(13999); expect(mixedDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(mixedDone).toBe(true);
    expect(fixture.window.__recordingRoleEvidence.snapshot().fault).toMatchObject({ targetRole: 'live-mix', recorderId: 2, startedAt: 0, completedAt: 14000 });
  });
  it('independently delays native conversion and retains bounded pending-age evidence', async () => {
    const fixture = observerFixture('native-input');
    fixture.native.emit('dataavailable', new fixture.BlobFixture(11));
    fixture.mixed.emit('dataavailable', new fixture.BlobFixture(22));
    expect(new Uint8Array(await fixture.conversions[1].promise)).toEqual(Uint8Array.of(22));
    await vi.advanceTimersByTimeAsync(11000);
    const snapshot = fixture.window.__recordingRoleEvidence.sampleFault();
    expect(snapshot.fault).toMatchObject({ targetRole: 'native-input', recorderId: 1, completedAt: null });
    expect(snapshot.fault.samples[0]).toMatchObject({ at: 11000, pendingBlobBytes: 1, convertedBytes: 0 });
    await vi.advanceTimersByTimeAsync(3000); await fixture.conversions[0].promise;
    expect(fixture.window.__recordingRoleEvidence.snapshot().records[0].convertedBytes).toBe(1);
  });
  it('observes baseline conversion and restores each wrapper without stopping native tracks', async () => {
    const fixture = observerFixture(null);
    fixture.native.emit('dataavailable', new fixture.BlobFixture(33));
    await fixture.conversions[0].promise;
    expect(fixture.window.__recordingRoleEvidence.snapshot().fault.injected).toBe(false);
    fixture.window.__recordingRoleEvidence.dispose();
    expect(fixture.Recorder.prototype.start).toBe(fixture.originalStart);
    expect(fixture.BlobFixture.prototype.arrayBuffer).toBe(fixture.originalArrayBuffer);
    expect(fixture.window.AudioContext).toBe(fixture.Context);
    expect(fixture.native.state).toBe('recording');
  });
});
