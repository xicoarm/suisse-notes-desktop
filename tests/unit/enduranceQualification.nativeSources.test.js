// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createRecordingChunkWriter } from '../../src/services/recordingChunkWriter';

const require = createRequire(import.meta.url);
const { diskBudget, DEFAULT_SECONDS, ROTATION_SECONDS, installNativeEnduranceObserver, enduranceRecorderRoles,
  createNativeEnduranceLedger, assessNativeEndurancePreservation, assessNativeEnduranceAssembly,
  verifyRetainedSources } = require('../e2e-harness/endurance-qualification');
const { beginSource, markSourceStarted, saveSourceChunk, endSource } = require('../../src-electron/native-source-persistence');
const work = path.resolve('tests/e2e-harness/work');
let directory, ledgers;
beforeEach(() => { fs.mkdirSync(work, { recursive: true }); directory = fs.mkdtempSync(path.join(work, 'native-endurance-unit-')); ledgers = []; });
afterEach(() => {
  for (const ledger of ledgers) ledger.close();
  if (path.dirname(directory) !== work || !path.basename(directory).startsWith('native-endurance-unit-')) throw new Error('Unsafe native endurance cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
});

const sourceId = '00000000-0000-4000-8000-000000000001';
async function sourceFixture() {
  await beginSource(directory, { sourceId, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm;codecs=opus', settings: {} });
  await markSourceStarted(directory, sourceId, { startOffsetMs: 0 });
  await saveSourceChunk(directory, sourceId, Buffer.from('one'), 0);
  await saveSourceChunk(directory, sourceId, Buffer.from('second'), 1);
  const ledger = createNativeEnduranceLedger(directory, path.join(directory, 'observed.jsonl'));
  ledgers.push(ledger);
  const recorder = { acknowledgedCount: 1, acknowledgedBytes: 3, events: 2, emptyEvents: 0, bytes: 9,
    lastDataAt: 2000, acknowledgedAt: 2000, oldestUnconfirmedAt: 2000 };
  return { ledger, recorder };
}

function observerFixture() {
  const acquisitions = [{ requestedAt: 0, receivedAt: 1, trackIds: ['mic'] }];
  class Context { createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ id: 'mix' }] } }; } }
  class TestBlob {
    constructor(size) { this.size = size; }
    arrayBuffer() { return Promise.resolve(new Uint8Array(this.size).buffer); }
  }
  class Recorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.handlers = {}; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    start() { this.state = 'recording'; this.handlers.start?.({ timeStamp: 1000 }); return 'native-start'; }
    emit(size) { this.ondataavailable({ data: new TestBlob(size) }); }
  }
  const context = { window: { AudioContext: Context, __enduranceConstraints: { acquisitions } },
    Blob: TestBlob, MediaRecorder: Recorder, performance: { now: () => 1000 } };
  vm.runInNewContext('(' + installNativeEnduranceObserver.toString() + ')()', context);
  const microphone = new Recorder({ getAudioTracks: () => [{ id: 'mic' }] });
  const mixed = new Recorder(new context.window.AudioContext().createMediaStreamDestination().stream);
  mixed.ondataavailable = () => {}; mixed.start(1000);
  return { microphone, context, acquisitions, snapshot: () => context.window.__nativeEnduranceEvidence.snapshot() };
}

describe('bounded native endurance observation', () => {
  it('keeps aggregate snapshots bounded through thousands of real serial writer saves', async () => {
    const fixture = observerFixture();
    const writer = createRecordingChunkWriter({ save: async () => ({ success: true }) });
    fixture.microphone.ondataavailable = event => { writer.enqueue(event.data); };
    expect(fixture.microphone.start(1000)).toBe('native-start');
    for (let index = 0; index < 5000; index++) fixture.microphone.emit(4);
    await writer.drain();
    fixture.microphone.emit(0); await writer.drain();
    const snapshot = fixture.snapshot();
    const roles = enduranceRecorderRoles(snapshot, fixture.acquisitions);
    expect(roles.native).toMatchObject({ events: 5001, emptyEvents: 1, bytes: 20000,
      acknowledgedCount: 4999, acknowledgedBytes: 19996, conversionIndex: 4999 });
    expect(snapshot.errors).toEqual([]);
    expect(JSON.stringify(snapshot).length).toBeLessThan(2000);
    snapshot.records.reverse();
    expect(enduranceRecorderRoles(snapshot, fixture.acquisitions).native.role).toBe('native-microphone');
    snapshot.records.push({ ...roles.native });
    expect(() => enduranceRecorderRoles(snapshot, fixture.acquisitions)).toThrow('exactly one');
  });

  it('does not infer the first converted/saved Blob itself acknowledged', async () => {
    const fixture = observerFixture();
    const writer = createRecordingChunkWriter({ save: async () => ({ success: true }) });
    fixture.microphone.ondataavailable = event => { writer.enqueue(event.data); };
    fixture.microphone.start(1000); fixture.microphone.emit(10); await writer.drain();
    expect(enduranceRecorderRoles(fixture.snapshot(), fixture.acquisitions).native).toMatchObject({
      bytes: 10, acknowledgedCount: 0, acknowledgedBytes: 0, acknowledgedAt: null,
    });
  });
});

describe('native durability ledger and separate live-mix rotation', () => {
  it('records each source/path/index/hash once during capture and permits the clean final suffix while verifying all original bytes', async () => {
    const { ledger, recorder } = await sourceFixture();
    const first = await ledger.sample(recorder, 2200, 10000);
    expect(first).toMatchObject({ sourceId, committedCount: 2, committedBytes: 9, added: 2,
      acknowledgedCount: 1, acknowledgedBytes: 3, eventAgeS: 0.2, unconfirmedCount: 1, unconfirmedBytes: 6 });
    const second = await ledger.sample(recorder, 7200, 15000);
    expect(second).toMatchObject({ added: 0, observedNoProgressS: 5 });
    const rows = fs.readFileSync(path.join(directory, 'observed.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ sourceId, index: 0, relativePath: `native-sources/${sourceId}/chunks/chunk_0.webm`,
      sha256: crypto.createHash('sha256').update('one').digest('hex') });
    await saveSourceChunk(directory, sourceId, Buffer.from('tail'), 2);
    await endSource(directory, sourceId, { endOffsetMs: 3000, chunkCount: 3, reason: 'stop' });
    const result = await ledger.verify({ events: 3, emptyEvents: 0, bytes: 13 });
    expect(result).toMatchObject({ sourceId, chunkCount: 3, bytes: 13, observedDuringCaptureCount: 2, problems: [] });
    expect(result.retainedSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails missing acknowledged bytes, source replacement, and changed previously observed content', async () => {
    const { ledger, recorder } = await sourceFixture();
    await ledger.sample(recorder, 2200, 10000);
    await expect(ledger.sample({ ...recorder, acknowledgedBytes: 4 }, 2300, 10100)).rejects.toThrow('acknowledged prefix');
    await endSource(directory, sourceId, { endOffsetMs: 2000, chunkCount: 2, reason: 'stop' });
    fs.writeFileSync(path.join(directory, 'native-sources', sourceId, 'chunks', 'chunk_0.webm'), 'BAD');
    expect((await ledger.verify(recorder)).problems).toContain('Previously observed native source changed: ' + sourceId + '/0');
    const extraId = crypto.randomUUID();
    await beginSource(directory, { sourceId: extraId, kind: 'microphone', startOffsetMs: 2000, mimeType: 'audio/webm;codecs=opus', settings: {} });
    await expect(ledger.sample(recorder, 2300, 10200)).rejects.toThrow('inventory changed');
  });

  it('includes final unarchived mixed chunks without calling them another natural archive rotation', async () => {
    const archived = path.join(directory, 'source-chunks', '17700000'), active = path.join(directory, 'chunks');
    fs.mkdirSync(archived, { recursive: true }); fs.mkdirSync(active);
    fs.writeFileSync(path.join(archived, 'chunk_0.webm'), 'first');
    fs.writeFileSync(path.join(active, 'chunk_1.webm'), 'second');
    const result = await verifyRetainedSources(directory, 11, 2, path.join(directory, 'mixed.jsonl'));
    expect(result).toMatchObject({ batches: 2, archivedBatches: 1, activeBatchRetained: true, count: 2, bytes: 11, problems: [] });
    const rows = fs.readFileSync(result.manifestPath, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.map(row => row.relativePath)).toEqual(['source-chunks/17700000/chunk_0.webm', 'chunks/chunk_1.webm']);
    expect(rows.every(row => /^[a-f0-9]{64}$/.test(row.sha256))).toBe(true);
  });
});

describe('native endurance preserves existing duration and source-clock gates', () => {
  it('keeps 5h05 and natural 4h55 while budgeting simultaneous bytes and native fallback scratch', () => {
    expect(DEFAULT_SECONDS).toBe(18300); expect(ROTATION_SECONDS).toBe(17700);
    const legacy = diskBudget(18300), native = diskBudget(18300, true);
    expect(native).toMatchObject(legacy);
    expect(native.nativeExtraCopiesBytes).toBe(18300 * 32000 * 2);
    expect(native.nativeLosslessFallbackBytes).toBe(18300 * 48000 * 2 * 3 * 2);
  });

  it('compares complete source/final identity ranges and the same 1.5s source-clock budget', () => {
    const source = { pass: true, firstFrame: 2, lastFrame: 36601, sourceOffsetS: 1.2 };
    expect(assessNativeEndurancePreservation(source, { ...source, firstFrame: 3, lastFrame: 36600 }).problems).toEqual([]);
    expect(assessNativeEndurancePreservation(source, { ...source, firstFrame: 4 }).problems).toContain('NATIVE PRESERVATION: final omits durable native interior identities');
    expect(assessNativeEndurancePreservation(source, { ...source, sourceOffsetS: -0.4 }).problems).toContain('NATIVE PRESERVATION: source/final active-clock placement changed');
    expect(assessNativeEndurancePreservation(source, { ...source, sourceOffsetS: -0.3 }).problems).toEqual([]);
    expect(assessNativeEndurancePreservation(source, { ...source, pass: false }).problems).toHaveLength(1);
  });

  it('requires normal native completion and explicit re-encoding rather than a legacy or recovery receipt', () => {
    const receipt = { version: 3, sourceMode: 'native', recovered: false, sourceIds: [sourceId], systemPcmIncluded: false };
    const plan = { version: 1, recovery: false, codecPolicy: 'opus-cbr-192k-20ms-reencoded-from-native-sources', sourceIds: [sourceId],
      systemPcmIncluded: false, onsetIsApproximate: true };
    expect(assessNativeEnduranceAssembly(receipt, plan, sourceId)).toEqual([]);
    expect(assessNativeEnduranceAssembly({ ...receipt, recovered: true }, plan, sourceId)).toHaveLength(1);
    expect(assessNativeEnduranceAssembly(receipt, { ...plan, codecPolicy: 'copy' }, sourceId)).toHaveLength(1);
    expect(assessNativeEnduranceAssembly({ ...receipt, sourceIds: ['other'] }, plan, sourceId)).toHaveLength(1);
  });
});
