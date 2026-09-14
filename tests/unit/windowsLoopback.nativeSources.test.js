// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessNativeLoopbackTimeline, snapshotLoopbackCustody, verifyLoopbackCustody,
  assessNativeLoopbackPublication, requireNumberedLoopbackFrames } = require('../e2e-harness/windows-loopback-qualification');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('s14-native-unit-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const record = (id, role, track, startCalledAt) => ({ id, role, trackIds: [track], startCalledAt,
    startedAt: startCalledAt + 1300, stoppedAt: 55100, state: 'inactive', timesliceMs: 1000,
    events: 2, emptyEvents: 0, bytes: 10, convertedBytes: 10 });
  const records = [record(1, 'native-input', 'zero-mic', 1000), record(2, 'native-input', 'desktop', 1500), record(3, 'live-mix', 'mix', 2000)];
  const sources = ['microphone', 'system'].map((kind, index) => ({ sourceId: ids[index], kind, started: true,
    complete: true, interrupted: false, gaps: [], terminalMismatch: false, reason: 'stopped',
    startOffsetMs: index * 500, endOffsetMs: 54000, chunkCount: 2,
    chunks: [{ index: 0, size: 4 }, { index: 1, size: 6 }] }));
  const input = { microphoneTrackIds: ['ended-permission-probe', 'zero-mic'],
    desktopCalls: [{ tracks: [{ kind: 'audio', id: 'desktop' }, { kind: 'video', id: 'screen' }] }],
    playback: { startedAt: 4000 }, recorderStops: [
      { at: 55000, trackIds: ['zero-mic'] }, { at: 55020, trackIds: ['desktop'] }, { at: 55030, trackIds: ['mix'] },
    ] };
  return { sources, evidence: { records }, input };
}

describe('native Windows loopback roles and meeting clock', () => {
  it('uses native track identities and the common meeting endpoint, independent of mix order or delayed start events', () => {
    const { sources, evidence, input } = fixture();
    evidence.records.reverse();
    const result = assessNativeLoopbackTimeline(sources.reverse(), evidence, input);
    expect(result.expectedDurationS).toBe(54);
    expect(result.expectedSourceOffsetS).toBe(-3);
    expect(result.systemExpectedSourceOffsetS).toBe(-2.5);
    expect(result.epochs.find(epoch => epoch.kind === 'system')).toMatchObject({ recorderId: 2, trackId: 'desktop', startOffsetMs: 500 });
    // The two encoders overlap in time; their durations must not be summed.
    expect(result.expectedDurationS).toBeLessThan(60);
  });

  it('accepts an open, independently identified pair while recording', () => {
    const { sources, evidence, input } = fixture();
    sources.forEach(source => Object.assign(source, { complete: false, interrupted: true, endOffsetMs: null, reason: null }));
    evidence.records.forEach(record => Object.assign(record, { state: 'recording', stoppedAt: null }));
    expect(assessNativeLoopbackTimeline(sources, evidence, input, false).expectedDurationS).toBeNull();
  });

  it.each(['missing-system', 'extra-recorder', 'wrong-track', 'unknown-role', 'wrong-timeslice', 'unconverted-data',
    'wrong-offset', 'wrong-endpoint', 'missing-stop', 'unclosed-source', 'source-gap', 'wrong-byte-count', 'replacement'])('rejects invalid native qualification evidence: %s', failure => {
    const { sources, evidence, input } = fixture();
    if (failure === 'missing-system') sources.pop();
    if (failure === 'extra-recorder') evidence.records.push({ ...evidence.records[0], id: 4 });
    if (failure === 'wrong-track') evidence.records[1].trackIds = ['other-desktop'];
    if (failure === 'unknown-role') evidence.records[1].role = 'unknown';
    if (failure === 'wrong-timeslice') evidence.records[1].timesliceMs = 3000;
    if (failure === 'unconverted-data') evidence.records[1].convertedBytes = 4;
    if (failure === 'wrong-offset') sources[1].startOffsetMs = 600;
    if (failure === 'wrong-endpoint') sources[1].endOffsetMs = 53900;
    if (failure === 'missing-stop') input.recorderStops.splice(1, 1);
    if (failure === 'unclosed-source') sources[1].complete = false;
    if (failure === 'source-gap') sources[1].gaps = [{ start: 0, end: 0 }];
    if (failure === 'wrong-byte-count') sources[1].chunks[1].size = 5;
    if (failure === 'replacement') sources[1].reason = 'replacement';
    expect(() => assessNativeLoopbackTimeline(sources, evidence, input)).toThrow();
  });
});

function publication() {
  const { sources, evidence, input } = fixture();
  const timeline = assessNativeLoopbackTimeline(sources, evidence, input);
  const output = { sha256: 'a'.repeat(64), bytes: 1500 };
  const finalized = { version: 3, sourceMode: 'native', recovered: false, systemPcmIncluded: false,
    sourceIds: [...ids], filename: 'audio.webm', sha256: output.sha256, size: output.bytes, duration: 54 };
  const plan = { version: 1, recovery: false, systemPcmIncluded: false, sourceIds: [...ids],
    codecPolicy: 'opus-cbr-192k-20ms-reencoded-from-native-sources', mixingPolicy: 'unity-sum-no-limiter',
    onsetIsApproximate: true, sampleRate: 48000, channels: 2, totalSamples: 54 * 48000,
    sourceEvidence: timeline.epochs.map(epoch => ({ ...epoch, interrupted: false })),
    lanes: [{ kind: 'microphone' }, { kind: 'system' }],
    validation: { status: 'passed', expectedDecodedSamples: 54 * 48000, observedDecodedSamples: 54 * 48000 } };
  return { finalized, plan, timeline, output };
}

describe('native Windows loopback publication and reference boundaries', () => {
  it('requires both source lanes in the v3 receipt and validated assembly', () => {
    const values = publication();
    expect(() => assessNativeLoopbackPublication(values.finalized, values.plan, values.timeline, values.output)).not.toThrow();
  });

  it.each(['legacy-receipt', 'missing-system', 'duplicate-source', 'wrong-upload', 'wrong-size', 'extra-pcm',
    'omitted-lane', 'wrong-source-evidence', 'failed-validation', 'wrong-sample-count', 'wrong-timeline'])('rejects incomplete or misleading publication: %s', failure => {
    const { finalized, plan, timeline, output } = publication();
    if (failure === 'legacy-receipt') finalized.version = 2;
    if (failure === 'missing-system') finalized.sourceIds.pop();
    if (failure === 'duplicate-source') finalized.sourceIds[1] = ids[0];
    if (failure === 'wrong-upload') finalized.sha256 = 'b'.repeat(64);
    if (failure === 'wrong-size') finalized.size--;
    if (failure === 'extra-pcm') finalized.systemPcmIncluded = true;
    if (failure === 'omitted-lane') plan.lanes.pop();
    if (failure === 'wrong-source-evidence') plan.sourceEvidence[1].sourceId = ids[0];
    if (failure === 'failed-validation') plan.validation.status = 'failed';
    if (failure === 'wrong-sample-count') plan.validation.observedDecodedSamples -= 960;
    if (failure === 'wrong-timeline') plan.sourceEvidence[1].startOffsetMs += 500;
    expect(() => assessNativeLoopbackPublication(finalized, plan, timeline, output)).toThrow();
  });

  it('still rejects a missing first, last or interior numbered frame', () => {
    const all = { firstFrame: 0, lastFrame: 95, identifiedFrames: 96 };
    expect(() => requireNumberedLoopbackFrames(all)).not.toThrow();
    for (const change of [{ firstFrame: 1 }, { lastFrame: 94 }, { identifiedFrames: 95 }]) {
      expect(() => requireNumberedLoopbackFrames({ ...all, ...change })).toThrow('every supplied numbered frame');
    }
  });
});

function custodyFiles() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 's14-native-unit-'));
  temporary.push(directory);
  const sources = ['microphone', 'system'].map((kind, index) => {
    const base = path.join(directory, 'native-sources', ids[index]);
    fs.mkdirSync(path.join(base, 'chunks'), { recursive: true });
    const manifestPath = path.join(base, 'manifest.json'), startedPath = path.join(base, 'started.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ sourceId: ids[index], kind }));
    fs.writeFileSync(startedPath, JSON.stringify({ startOffsetMs: index * 500 }));
    const chunkPath = path.join(base, 'chunks', 'chunk_0.webm');
    // Identical bytes deliberately exercise identity rather than hash-only matching.
    fs.writeFileSync(chunkPath, Buffer.from([1, 2, 3, 4]));
    return { sourceId: ids[index], kind, startOffsetMs: index * 500, manifestPath, startedPath,
      endPath: null, chunks: [{ index: 0, path: chunkPath, size: 4 }] };
  });
  return { directory, sources };
}

describe('per-lane native original custody', () => {
  it('preserves both initial prefixes while allowing later chunks and terminal metadata', async () => {
    const { directory, sources } = custodyFiles();
    const prefix = await snapshotLoopbackCustody(directory, sources, 1);
    for (const source of sources) {
      source.endPath = path.join(path.dirname(source.manifestPath), 'end.json');
      fs.writeFileSync(source.endPath, JSON.stringify({ chunkCount: 2, endOffsetMs: 54000 }));
      const file = path.join(path.dirname(source.chunks[0].path), 'chunk_1.webm');
      fs.writeFileSync(file, Buffer.from([5, 6]));
      source.chunks.push({ index: 1, path: file, size: 2 });
    }
    const retained = await snapshotLoopbackCustody(directory, sources);
    expect(() => verifyLoopbackCustody(prefix, retained)).not.toThrow();
    expect(() => verifyLoopbackCustody(prefix, retained, false)).toThrow('entries changed');
  });

  it('rejects changed source bytes and changed start metadata', async () => {
    const { directory, sources } = custodyFiles();
    const prefix = await snapshotLoopbackCustody(directory, sources);
    fs.writeFileSync(sources[1].chunks[0].path, Buffer.from([9, 2, 3, 4]));
    const changed = await snapshotLoopbackCustody(directory, sources);
    expect(() => verifyLoopbackCustody(prefix, changed)).toThrow('bytes or metadata changed');
    fs.writeFileSync(sources[1].chunks[0].path, Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(sources[1].startedPath, JSON.stringify({ startOffsetMs: 800 }));
    const changedMetadata = await snapshotLoopbackCustody(directory, sources);
    expect(() => verifyLoopbackCustody(prefix, changedMetadata)).toThrow('bytes or metadata changed');
  });

  it('cannot substitute another source with the same bytes or move a chunk to another index', async () => {
    const { directory, sources } = custodyFiles();
    const prefix = await snapshotLoopbackCustody(directory, sources);
    expect(() => verifyLoopbackCustody(prefix, [prefix[0]])).toThrow('inventory changed');
    expect(() => verifyLoopbackCustody(prefix, [prefix[0], prefix[0]])).toThrow('inventory changed');
    const swapped = structuredClone(prefix);
    swapped[1].chunks[0].relativePath = swapped[0].chunks[0].relativePath;
    expect(() => verifyLoopbackCustody(prefix, swapped)).toThrow('bytes or metadata changed');
    const reindexed = structuredClone(prefix);
    reindexed[1].chunks[0].index = 1;
    expect(() => verifyLoopbackCustody(prefix, reindexed)).toThrow('bytes or metadata changed');
  });
});
