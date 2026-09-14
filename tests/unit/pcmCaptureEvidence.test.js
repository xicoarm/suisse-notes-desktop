// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { beginPcmAttempt, markPcmEvent, recordPcmFailure, endPcmAttempt,
  inspectPcmCaptureEvidence, pcmEvidenceFingerprint } = require('../../src-electron/pcm-capture-evidence');
let root, attemptId;
const requestedAt = '2026-09-05T20:00:00.000Z';
const reservation = extra => ({ attemptId, required: true, requestOffsetMs: 0, requestedAt, ...extra });
const complete = extra => ({ success: true, childClosed: true, diskDrained: true,
  endOffsetMs: 1000, elapsedMs: 1000, reason: 'stopped', ...extra });
const attemptPath = id => path.join(root, 'pcm-capture-attempts', id || attemptId);
const pcmPath = () => path.join(root, 'system_audio.raw');
async function firstData(id = attemptId, byteLength = 4) {
  return markPcmEvent(root, id, { event: 'first-data', elapsedMs: 35, activeOffsetMs: 35, byteLength });
}
async function successful(id = attemptId) {
  await beginPcmAttempt(root, reservation({ attemptId: id }));
  await firstData(id);
  await fs.promises.appendFile(pcmPath(), Buffer.from([1, 2, 3, 4]));
  await endPcmAttempt(root, id, complete());
}
beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-pcm-evidence-')); attemptId = randomUUID(); });
afterEach(async () => {
  vi.restoreAllMocks();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-pcm-evidence-')) throw new Error('Unsafe PCM evidence cleanup');
  await fs.promises.rm(resolved, { recursive: true, force: true });
});

describe('durable AudioTee lifecycle evidence', () => {
  it('records required capture intent before a child or PCM exists and preserves it across restart', async () => {
    await beginPcmAttempt(root, reservation());
    expect(fs.existsSync(pcmPath())).toBe(false);
    const state = inspectPcmCaptureEvidence(root);
    expect(state).toMatchObject({ required: true, canFinalize: false, complete: false, timingIsApproximate: true });
    expect(state.attempts[0]).toMatchObject({ interrupted: true, complete: false });
    expect(state.blockingIssues.map(issue => issue.kind)).toContain('required-pcm-missing');
    expect(inspectPcmCaptureEvidence(root, { recovery: true })).toMatchObject({ canFinalize: true, complete: false });
    expect(inspectPcmCaptureEvidence(root, { recovery: true }).warnings.length).toBeGreaterThan(0);
  });

  it('never treats stream_start or sparse padding as proof that system audio was captured', async () => {
    await beginPcmAttempt(root, reservation({ requestOffsetMs: 1000 }));
    await markPcmEvent(root, attemptId, { event: 'stream-start', elapsedMs: 10, activeOffsetMs: 1010 });
    await fs.promises.writeFile(pcmPath(), Buffer.alloc(96000));
    await expect(endPcmAttempt(root, attemptId, complete({ endOffsetMs: 2000 }))).rejects.toThrow();
    const state = inspectPcmCaptureEvidence(root);
    expect(state.canFinalize).toBe(false);
    expect(state.attempts[0].manifest.appendStartBytes).toBe(96000);
    expect(state.attempts[0].events['stream-start'].timingIsApproximate).toBe(true);
    expect(fs.statSync(pcmPath()).size).toBe(96000);
  });

  it('requires child close AND disk drain before immutable successful completion', async () => {
    await beginPcmAttempt(root, reservation()); await firstData();
    await fs.promises.writeFile(pcmPath(), Buffer.from([1, 2, 3, 4]));
    for (const barriers of [{ childClosed: false }, { diskDrained: false }]) {
      await expect(endPcmAttempt(root, attemptId, complete(barriers))).rejects.toThrow('inconsistent');
      expect(fs.existsSync(path.join(attemptPath(), 'end.json'))).toBe(false);
    }
    await endPcmAttempt(root, attemptId, complete());
    expect(inspectPcmCaptureEvidence(root)).toMatchObject({ canFinalize: true, complete: true });
    expect(inspectPcmCaptureEvidence(root).attempts[0].end.audioBytes).toBe(4);
    expect(await endPcmAttempt(root, attemptId, complete())).toMatchObject({ duplicate: true });
  });

  it('keeps failed capture durable after active process state is gone and even when a later attempt succeeds', async () => {
    await beginPcmAttempt(root, reservation()); await firstData();
    await fs.promises.writeFile(pcmPath(), Buffer.from([1, 2, 3, 4]));
    await recordPcmFailure(root, attemptId, { stage: 'stdout-write', code: 'ENOSPC', message: 'Disk full', elapsedMs: 500 });
    await expect(endPcmAttempt(root, attemptId, complete())).rejects.toThrow('missing');
    await endPcmAttempt(root, attemptId, complete({ success: false }));
    await successful(randomUUID());
    const normal = inspectPcmCaptureEvidence(root);
    expect(normal.canFinalize).toBe(false);
    expect(normal.blockingIssues.some(issue => issue.kind === 'capture-failed' && issue.attemptId === attemptId)).toBe(true);
    const recovered = inspectPcmCaptureEvidence(root, { recovery: true });
    expect(recovered.canFinalize).toBe(true);
    expect(recovered.complete).toBe(false);
    expect(fs.readFileSync(pcmPath())).toEqual(Buffer.from([1, 2, 3, 4, 1, 2, 3, 4]));
  });

  it('makes reservations and events exact retries while preserving the original byte extent after later appends', async () => {
    await successful();
    const originalEnd = fs.readFileSync(path.join(attemptPath(), 'end.json'), 'utf8');
    await fs.promises.appendFile(pcmPath(), Buffer.from([5, 6]));
    expect(await beginPcmAttempt(root, reservation())).toMatchObject({ duplicate: true, manifest: { pcmStartBytes: 0 } });
    expect(await firstData()).toMatchObject({ duplicate: true });
    expect(await endPcmAttempt(root, attemptId, complete())).toMatchObject({ duplicate: true, audioBytes: 4 });
    expect(fs.readFileSync(path.join(attemptPath(), 'end.json'), 'utf8')).toBe(originalEnd);
    await expect(beginPcmAttempt(root, reservation({ required: false }))).rejects.toThrow('conflicting');
    await expect(markPcmEvent(root, attemptId, { event: 'first-data', elapsedMs: 36, activeOffsetMs: 36, byteLength: 4 })).rejects.toThrow('conflicting');
    await expect(recordPcmFailure(root, attemptId, { stage: 'late', code: '', message: 'cannot rewrite success', elapsedMs: 1001 })).rejects.toThrow('successful');
  });

  it('detects PCM disappearing or shrinking after a successful receipt', async () => {
    await successful();
    await fs.promises.truncate(pcmPath(), 2);
    let state = inspectPcmCaptureEvidence(root);
    expect(state.canFinalize).toBe(false);
    expect(state.blockingIssues.map(issue => issue.kind)).toContain('pcm-shorter-than-capture-receipt');
    await fs.promises.unlink(pcmPath());
    state = inspectPcmCaptureEvidence(root);
    expect(state.blockingIssues.map(issue => issue.kind)).toContain('required-pcm-missing');
    expect(fs.existsSync(path.join(attemptPath(), 'end.json'))).toBe(true);
  });

  it('binds every lifecycle sidecar to the recording fingerprint', async () => {
    const fingerprints = [pcmEvidenceFingerprint(root)];
    await beginPcmAttempt(root, reservation()); fingerprints.push(pcmEvidenceFingerprint(root));
    await markPcmEvent(root, attemptId, { event: 'spawned', elapsedMs: 1, activeOffsetMs: 1 }); fingerprints.push(pcmEvidenceFingerprint(root));
    await markPcmEvent(root, attemptId, { event: 'stream-start', elapsedMs: 10, activeOffsetMs: 10 }); fingerprints.push(pcmEvidenceFingerprint(root));
    await firstData(); fingerprints.push(pcmEvidenceFingerprint(root));
    await fs.promises.writeFile(pcmPath(), Buffer.from([1, 2, 3, 4]));
    await markPcmEvent(root, attemptId, { event: 'stop-requested', elapsedMs: 900, activeOffsetMs: 900 }); fingerprints.push(pcmEvidenceFingerprint(root));
    await endPcmAttempt(root, attemptId, complete()); fingerprints.push(pcmEvidenceFingerprint(root));
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('retains an interrupted required reservation and never silently completes from an earlier successful attempt', async () => {
    await successful();
    const previous = pcmEvidenceFingerprint(root);
    const nextId = randomUUID(), realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((file, ...args) => {
      if (String(file).includes('manifest.json.')) throw Object.assign(new Error('manifest fsync failed'), { code: 'EIO' });
      return realOpen(file, ...args);
    });
    await expect(beginPcmAttempt(root, reservation({ attemptId: nextId }))).rejects.toThrow('manifest fsync failed');
    vi.restoreAllMocks();
    expect(fs.existsSync(attemptPath(nextId))).toBe(false);
    expect(inspectPcmCaptureEvidence(root)).toMatchObject({ canFinalize: false, complete: false, required: true });
    expect(pcmEvidenceFingerprint(root)).not.toBe(previous);
    const recovered = inspectPcmCaptureEvidence(root, { recovery: true });
    expect(recovered).toMatchObject({ canFinalize: true, complete: false });
    expect(recovered.warnings.map(warning => warning.kind)).toContain('capture-reservation-interrupted');
    const staging = fs.readdirSync(path.join(root, 'pcm-capture-attempts')).find(name => name.endsWith('.tmp'));
    expect(staging).toBeTruthy();
    await beginPcmAttempt(root, reservation({ attemptId: nextId }));
    expect(fs.existsSync(path.join(root, 'pcm-capture-attempts', staging))).toBe(true);
  });

  it('preserves intent after failure before the first manifest and fingerprints partial evidence', async () => {
    const absent = pcmEvidenceFingerprint(root);
    await fs.promises.mkdir(path.join(root, 'pcm-capture-attempts'));
    expect(inspectPcmCaptureEvidence(root)).toMatchObject({ canFinalize: false, complete: false, required: true });
    const empty = pcmEvidenceFingerprint(root);
    expect(empty).not.toBe(absent);
    const staging = path.join(root, 'pcm-capture-attempts', `${attemptId}.${randomUUID()}.tmp`);
    await fs.promises.mkdir(staging);
    await fs.promises.writeFile(path.join(staging, 'manifest.json.partial.tmp'), '{');
    const partial = pcmEvidenceFingerprint(root);
    expect(partial).not.toBe(empty);
    await fs.promises.appendFile(path.join(staging, 'manifest.json.partial.tmp'), '"version":1');
    expect(pcmEvidenceFingerprint(root)).not.toBe(partial);
    expect(inspectPcmCaptureEvidence(root, { recovery: true })).toMatchObject({ canFinalize: true, complete: false });
  });

  it('replays ambiguous manifest/end acknowledgements after atomic publication', async () => {
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (to === attemptPath()) throw Object.assign(new Error('reservation ack lost'), { code: 'EIO' });
    });
    await expect(beginPcmAttempt(root, reservation())).rejects.toThrow('ack lost');
    vi.restoreAllMocks();
    expect(await beginPcmAttempt(root, reservation())).toMatchObject({ duplicate: true });
    await firstData(); await fs.promises.writeFile(pcmPath(), Buffer.from([1, 2, 3, 4]));
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (to === path.join(attemptPath(), 'end.json')) throw Object.assign(new Error('end ack lost'), { code: 'EIO' });
    });
    await expect(endPcmAttempt(root, attemptId, complete())).rejects.toThrow('end ack lost');
    vi.restoreAllMocks();
    expect(await endPcmAttempt(root, attemptId, complete())).toMatchObject({ duplicate: true });
    expect(inspectPcmCaptureEvidence(root).complete).toBe(true);
  });

  it('rejects malformed evidence and traversal instead of silently bypassing required capture', async () => {
    for (const attempt of ['../outside', '', undefined]) await expect(beginPcmAttempt(root, reservation({ attemptId: attempt }))).rejects.toThrow('attempt ID');
    await beginPcmAttempt(root, reservation());
    await fs.promises.writeFile(path.join(attemptPath(), 'manifest.json'), 'null');
    expect(() => inspectPcmCaptureEvidence(root)).toThrow('invalid manifest');
    expect(() => pcmEvidenceFingerprint(root)).toThrow();
    await expect(beginPcmAttempt(root, reservation())).rejects.toThrow();
    expect(fs.readFileSync(path.join(attemptPath(), 'manifest.json'), 'utf8')).toBe('null');
  });

  it('blocks a claimed successful drain that saved less than the observed first data chunk', async () => {
    await beginPcmAttempt(root, reservation()); await firstData(attemptId, 100);
    await fs.promises.writeFile(pcmPath(), Buffer.from([1, 2]));
    await expect(endPcmAttempt(root, attemptId, complete())).rejects.toThrow('missing');
    expect(inspectPcmCaptureEvidence(root).canFinalize).toBe(false);
  });
});
