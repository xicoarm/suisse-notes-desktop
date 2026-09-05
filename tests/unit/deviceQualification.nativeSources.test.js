// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const { assessNativeDeviceTimeline, nativeChunkCustody, verifyNativeCustody } = require('../e2e-harness/device-qualification');

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
function fixture(kind = 'reconnect') {
  const offsets = kind === 'reconnect' ? [0, 43000, 88000] : [0, 48000];
  const ends = kind === 'reconnect' ? [32000, 77000, 120000] : [48000, 90000];
  const sources = offsets.map((startOffsetMs, index) => ({ sourceId: ids[index], kind: 'microphone',
    complete: true, started: true, startOffsetMs, endOffsetMs: ends[index],
    reason: index === offsets.length - 1 ? 'stopped' : kind === 'reconnect' ? 'device-ended' : 'replacement',
    chunkCount: 3, chunks: [0, 1, 2].map(index => ({ index, size: 10 })) }));
  const native = offsets.map((offset, index) => ({ id: index + 1, role: 'native-input', trackIds: ['track-' + index],
    startCalledAt: 1000 + offset, startedAt: 1060 + offset, stoppedAt: 1080 + ends[index],
    timesliceMs: 1000, state: 'inactive', events: 4, emptyEvents: 1, bytes: 30, convertedBytes: 30 }));
  const mixed = { ...native[0], id: 20, role: 'live-mix', trackIds: ['mixed'], startCalledAt: 1200, stoppedAt: 1080 + ends.at(-1) };
  return { sources, roleEvidence: { records: [mixed, ...native].reverse() },
    fixture: { sourceStartedAt: 800, calls: native.map(recorder => ({ trackId: recorder.trackIds[0] })),
      recorderStops: [{ trackIds: native.at(-1).trackIds, at: 1000 + ends.at(-1) }] } };
}
const assess = (value, kind = 'reconnect') => assessNativeDeviceTimeline(kind, value.sources, value.roleEvidence, value.fixture);

describe('native device qualification timeline', () => {
  it('identifies every native source even when recorder order changes and includes outage time', () => {
    const value = fixture();
    const result = assess(value);
    expect(result.epochs.map(epoch => epoch.sourceId)).toEqual(ids);
    expect(result.epochs.map(epoch => epoch.trackId)).toEqual(['track-0', 'track-1', 'track-2']);
    expect(result.expectedDurationS).toBe(120);
    expect(result.expectedSourceOffsetS).toBe(0.2);
    expect(result.expectedDurationS).not.toBe((120000 - 88000) / 1000);
  });
  it('includes the original epoch before a same-device zero-input replacement', () => {
    const result = assess(fixture('zero-input'), 'zero-input');
    expect(result.expectedDurationS).toBe(90);
    expect(result.epochs).toHaveLength(2);
  });
  it.each(['missing', 'extra', 'duplicate'])('rejects %s epoch identities', operation => {
    const value = fixture();
    if (operation === 'missing') value.sources.pop();
    if (operation === 'extra') value.roleEvidence.records.push({ ...value.roleEvidence.records[0], id: 50 });
    if (operation === 'duplicate') value.sources[1].sourceId = value.sources[0].sourceId;
    expect(() => assess(value)).toThrow(/topology|duplicate/);
  });
  it.each(['unclosed', 'bytes', 'index', 'unknown-track', 'timestamp', 'clock'])('rejects %s native evidence', failure => {
    const value = fixture();
    if (failure === 'unclosed') value.sources[0].complete = false;
    if (failure === 'bytes') value.sources[0].chunks[0].size++;
    if (failure === 'index') value.sources[0].chunks[0].index = 1;
    if (failure === 'unknown-track') value.fixture.calls.shift();
    if (failure === 'timestamp') value.sources[1].startOffsetMs += 3;
    if (failure === 'clock') value.sources.at(-1).endOffsetMs -= 11000;
    expect(() => assess(value)).toThrow();
  });
  it('rejects ambiguous recorder correspondence rather than accepting nearest timestamps', () => {
    const value = fixture();
    value.roleEvidence.records.find(recorder => recorder.id === 2).startCalledAt = 1001;
    expect(() => assess(value)).toThrow('uniquely matched');
  });
  it('requires a unique final stop call instead of using delayed final-data delivery', () => {
    const value = fixture(); value.fixture.recorderStops = [];
    expect(() => assess(value)).toThrow('stop call');
  });
});

const folders = [];
afterEach(() => {
  for (const directory of folders.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('suisse-device-custody-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('native device original custody', () => {
  it('records the source UUID, index, relative path, size and hash of each original', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suisse-device-custody-')); folders.push(directory);
    const sources = ids.map(sourceId => {
      const file = path.join(directory, 'native-sources', sourceId, 'chunks', 'chunk_0.webm');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'same bytes');
      return { sourceId, chunks: [{ path: file, index: 0, size: 10 }] };
    });
    const chunks = await nativeChunkCustody(directory, sources);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ sourceId: ids[0], index: 0, bytes: 10,
      relativePath: `native-sources/${ids[0]}/chunks/chunk_0.webm` });
    expect(chunks[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyNativeCustody(chunks, chunks)).not.toThrow();
    expect(() => verifyNativeCustody([chunks[0]], chunks.slice(1))).toThrow('changed or disappeared');
  });
  it.each(['sourceId', 'index', 'relativePath', 'bytes', 'sha256'])('rejects changed %s even when some other identity has the same bytes', field => {
    const original = { sourceId: ids[0], index: 0, relativePath: `native-sources/${ids[0]}/chunks/chunk_0.webm`, bytes: 5, sha256: 'abc' };
    const modified = { ...original, [field]: typeof original[field] === 'number' ? original[field] + 1 : original[field] + '-changed' };
    expect(() => verifyNativeCustody([original], [modified])).toThrow('changed or disappeared');
  });
  it('rejects duplicate custody identities', () => {
    const chunk = { sourceId: ids[0], index: 0, relativePath: 'one', bytes: 1, sha256: 'abc' };
    expect(() => verifyNativeCustody([chunk], [chunk, chunk])).toThrow('Duplicate');
  });
});
