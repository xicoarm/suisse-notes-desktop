// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createRecordingChunkWriter } from '../../src/services/recordingChunkWriter';

const require = createRequire(import.meta.url);
const { installNativeCrashObserver, snapshotNativeSources, compareNativeSources, nativeCrashMapping,
  compareNativeRecoveredContent, nativeAssemblyProblems, nativeEndpointCoverage } = require('../e2e-harness/crash-qualification');
const { beginSource, markSourceStarted, saveSourceChunk } = require('../../src-electron/native-source-persistence');
const workRoot = path.resolve('tests/e2e-harness/work');
let fixtureRoot;
beforeEach(() => { fs.mkdirSync(workRoot, { recursive: true }); fixtureRoot = fs.mkdtempSync(path.join(workRoot, 's15-native-unit-')); });
afterEach(() => {
  if (path.dirname(fixtureRoot) !== workRoot || !path.basename(fixtureRoot).startsWith('s15-native-unit-')) throw new Error('Refusing unrelated fixture cleanup');
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function observerFixture() {
  let clock = 100;
  const input = { getAudioTracks: () => [{ id: 'native-mic' }] };
  class TestBlob {
    constructor(bytes) { this.size = bytes; }
    arrayBuffer() { return Promise.resolve(new Uint8Array(this.size).buffer); }
  }
  class Context { createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ id: 'mixed-destination' }] } }; } }
  class Recorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.listeners = new Map(); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; this.listeners.get('start')?.({ timeStamp: clock }); return 'native-return'; }
    emit(blob) { this.ondataavailable({ data: blob }); }
  }
  const acquire = vi.fn(async () => input);
  const context = { window: { AudioContext: Context, webkitAudioContext: Context }, MediaRecorder: Recorder,
    Blob: TestBlob, navigator: { mediaDevices: { getUserMedia: acquire } }, performance: { now: () => clock } };
  vm.runInNewContext('(' + installNativeCrashObserver.toString() + ')()', context);
  return { context, Recorder, TestBlob, acquire, setClock: value => { clock = value; },
    snapshot: () => context.window.__nativeCrashEvidence.snapshot() };
}

async function microtasks() { for (let i = 0; i < 15; i++) await Promise.resolve(); }

describe('native acknowledgement lower bound observes the actual serial writer', () => {
  it('does not acknowledge the current conversion, and advances only after the previous save resolves', async () => {
    const fixture = observerFixture(), releases = [];
    const save = vi.fn(() => new Promise(resolve => { releases.push(resolve); }));
    const writer = createRecordingChunkWriter({ save });
    const stream = await fixture.context.navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new fixture.Recorder(stream);
    recorder.ondataavailable = event => { writer.enqueue(event.data); };
    expect(recorder.start(1000)).toBe('native-return');
    recorder.emit(new fixture.TestBlob(100));
    recorder.emit(new fixture.TestBlob(200));
    await microtasks();
    expect(save).toHaveBeenCalledTimes(1);
    expect(fixture.snapshot().records[0]).toMatchObject({ acknowledgedCount: 0, lastConversionIndex: 0 });
    releases[0]({ success: true });
    await microtasks();
    expect(save).toHaveBeenCalledTimes(2);
    expect(fixture.snapshot().records[0]).toMatchObject({ acknowledgedCount: 1, lastConversionIndex: 1 });
    releases[1]({ success: true });
    await writer.drain();
    expect(fixture.snapshot().records[0].acknowledgedCount).toBe(1); // Latest ACK is deliberately excluded.
    expect(fixture.snapshot().records[0].chunks.map(chunk => chunk.bytes)).toEqual([100, 200]);
    expect(fixture.acquire).toHaveBeenCalledTimes(1);
  });

  it('does not count a failed save or its retry as another acknowledged Blob', async () => {
    const fixture = observerFixture();
    const save = vi.fn().mockResolvedValueOnce({ success: false, error: 'disk failure' }).mockResolvedValue({ success: true });
    const writer = createRecordingChunkWriter({ save });
    const stream = await fixture.context.navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new fixture.Recorder(stream);
    recorder.ondataavailable = event => { writer.enqueue(event.data); };
    recorder.start(1000);
    recorder.emit(new fixture.TestBlob(100)); recorder.emit(new fixture.TestBlob(200));
    expect((await writer.drain()).success).toBe(false);
    expect(fixture.snapshot().records[0].acknowledgedCount).toBe(0);
    await writer.drain({ retry: true });
    expect(fixture.snapshot().records[0].acknowledgedCount).toBe(1);
    expect(fixture.snapshot().errors).toEqual([]);
  });
});

const sourceId = '00000000-0000-4000-8000-000000000001';
function mappingFixture() {
  const recorder = { role: 'native-microphone', trackIds: ['mic'], state: 'recording', startedAt: 101,
    startCalledAt: 100, timesliceMs: 1000, acknowledgedCount: 1, chunks: [{ bytes: 4 }, { bytes: 5 }] };
  return { snapshot: { nativeCapture: { at: 2000, errors: [], acquisitions: [['mic']], records: [
    { ...recorder, role: 'live-mix', trackIds: ['mix'] }, recorder,
  ] } }, sources: [{ sourceId, kind: 'microphone', started: true, interrupted: true, startOffsetMs: 0 }] };
}

describe('native source roles and durable custody', () => {
  it('maps the native stream to its sole source UUID without relying on recorder order', () => {
    const { snapshot, sources } = mappingFixture();
    const first = nativeCrashMapping(snapshot, sources);
    snapshot.nativeCapture.records.reverse();
    expect(nativeCrashMapping(snapshot, sources)).toEqual(first);
    expect(first).toMatchObject({ sourceId, kind: 'microphone', acknowledgedCount: 1 });
  });

  it.each(['extra-source', 'replaced-recorder', 'wrong-track', 'wrong-timeslice', 'closed-source'])('fails ambiguous or out-of-scope evidence: %s', kind => {
    const { snapshot, sources } = mappingFixture();
    if (kind === 'extra-source') sources.push({ ...sources[0], sourceId: crypto.randomUUID(), kind: 'system' });
    if (kind === 'replaced-recorder') snapshot.nativeCapture.records.push({ ...snapshot.nativeCapture.records[1] });
    if (kind === 'wrong-track') snapshot.nativeCapture.records[1].trackIds = ['other'];
    if (kind === 'wrong-timeslice') snapshot.nativeCapture.records[1].timesliceMs = 3000;
    if (kind === 'closed-source') sources[0].interrupted = false;
    expect(() => nativeCrashMapping(snapshot, sources)).toThrow();
  });

  it('keeps acknowledged and later committed chunks distinct with exact source/path/index/hash identity', async () => {
    await beginSource(fixtureRoot, { sourceId, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm;codecs=opus', settings: {} });
    await markSourceStarted(fixtureRoot, sourceId, { startOffsetMs: 0 });
    await saveSourceChunk(fixtureRoot, sourceId, Buffer.from('first'), 0);
    await saveSourceChunk(fixtureRoot, sourceId, Buffer.from('second'), 1);
    const acknowledged = await snapshotNativeSources(fixtureRoot, { [sourceId]: 1 });
    const surviving = await snapshotNativeSources(fixtureRoot);
    expect(acknowledged[0].chunks).toEqual([expect.objectContaining({ sourceId, index: 0,
      relativePath: `native-sources/${sourceId}/chunks/chunk_0.webm`, bytes: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    expect(compareNativeSources(acknowledged, surviving)).toEqual([]);
    expect(compareNativeSources(acknowledged, surviving, false)).toContain('Recovery changed native chunk count: ' + sourceId);
    const changed = structuredClone(surviving);
    changed[0].chunks[0].relativePath = `native-sources/another-source/chunks/chunk_0.webm`;
    expect(compareNativeSources(acknowledged, changed)).toContain('Native source chunk changed or disappeared: ' + sourceId + '/0');
    const alteredMetadata = structuredClone(surviving);
    alteredMetadata[0].metadata[0].sha256 = 'changed';
    expect(compareNativeSources(acknowledged, alteredMetadata)).toContain('Native source metadata changed: ' + sourceId);
    await expect(snapshotNativeSources(fixtureRoot, { [sourceId]: 3 })).rejects.toThrow('acknowledged');
  });
});

describe('native recovered content and explicit re-encoding policy', () => {
  const groups = Array.from({ length: 10 }, (_, id) => ({ id, start: id * 0.5 + 0.1, end: id * 0.5 + 0.4 }));
  it('preserves every source interior identity at its active offset with a separately declared codec policy', () => {
    const original = { groups }, recovered = { groups: groups.map(group => ({ ...group, start: group.start + 0.02, end: group.end + 0.02 })) };
    expect(compareNativeRecoveredContent(original, recovered, 0.02).problems).toEqual([]);
    const receipt = { version: 3, sourceMode: 'native', recovered: true, sourceIds: [sourceId], systemPcmIncluded: false };
    const plan = { version: 1, recovery: true, codecPolicy: 'opus-cbr-192k-20ms-reencoded-from-native-sources', sourceIds: [sourceId],
      systemPcmIncluded: false, onsetIsApproximate: true, sampleRate: 48000, totalSamples: 240000 };
    expect(nativeAssemblyProblems(receipt, plan, [{ sourceId }])).toEqual([]);
    expect(nativeAssemblyProblems(receipt, { ...plan, codecPolicy: 'copy' }, [{ sourceId }])).toHaveLength(1);
    expect(nativeAssemblyProblems({ ...receipt, version: 2 }, plan, [{ sourceId }])).toHaveLength(1);
    expect(nativeAssemblyProblems({ ...receipt, sourceIds: [] }, plan, [{ sourceId }])).toHaveLength(1);
  });

  it('rejects a missing edge-interior ID even when the recovered common range shrinks, plus duplicates and moved content', () => {
    expect(compareNativeRecoveredContent({ groups }, { groups: groups.slice(2) }).problems).toContain('Recovered output omitted durable native marker 1');
    expect(compareNativeRecoveredContent({ groups }, { groups: [...groups, groups[4]] }).problems).toContain('Repeated recovered marker 4');
    const moved = groups.map(group => group.id === 4 ? { ...group, start: group.start + 0.2, end: group.end + 0.2 } : group);
    expect(compareNativeRecoveredContent({ groups }, { groups: moved }).problems).toContain('Recovered native marker moved on the active timeline: 4');
  });

  it('uses measured first/last positions for endpoint coverage rather than inferred frame identities', () => {
    expect(nativeEndpointCoverage({ durationS: 50, firstIdentifiedStartS: 0.2, lastIdentifiedEndS: 49.8 }).problems).toEqual([]);
    expect(nativeEndpointCoverage({ durationS: 50, firstIdentifiedStartS: 2, lastIdentifiedEndS: 49.8 }).problems).toHaveLength(1);
    expect(nativeEndpointCoverage({ durationS: 50, firstIdentifiedStartS: 0.2, lastIdentifiedEndS: 48 }).problems).toHaveLength(1);
    expect(nativeEndpointCoverage({ durationS: 50, firstFrame: 0, lastFrame: 99 }).problems).toHaveLength(1);
  });
});
