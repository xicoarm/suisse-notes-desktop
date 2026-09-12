// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PINNED, REPLAY_ROOT, validateManifest, hashFiles, verifyHash, assertIsolatedPaths,
  parseArguments, createCommandRunner, preserveOutputs } = require('../e2e-harness/finalization-replay');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'suisse-finalization-replay-test-')); });
afterEach(() => {
  vi.useRealTimers();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-finalization-replay-test-')) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(resolved, { recursive: true, force: true });
});
function manifest() {
  return { commit: PINNED.commit, scenario: 's13-coded-endurance', platform: 'darwin', architecture: 'x64',
    captureSeconds: 18300, productionBackendQualified: false, processingDisabled: false,
    referenceGeneration: { generator: 'tests/e2e-harness/lib/coded-audio.js', firstFrameId: 0,
      plan: [{ type: 'speech', seconds: 18325 }] } };
}
function command() {
  const value = new EventEmitter();
  value.run = vi.fn(() => { value.emit('start'); });
  value.kill = vi.fn();
  value.ffmpegProc = { pid: 1234 };
  return value;
}

describe('generated Intel finalization replay restrictions', () => {
  it('rejects a different source revision, platform, duration, processing policy or source generator', () => {
    expect(() => validateManifest(manifest())).not.toThrow();
    for (const patch of [{ commit: 'newer' }, { platform: 'win32' }, { architecture: 'arm64' },
      { captureSeconds: 18299 }, { productionBackendQualified: true }, { processingDisabled: true },
      { referenceGeneration: { generator: 'microphone' } }]) {
      expect(() => validateManifest({ ...manifest(), ...patch })).toThrow('pinned generated Intel');
    }
  });
  it('requires explicit artifact input, refuses argument overrides and isolates outputs from original evidence', () => {
    expect(() => parseArguments([])).toThrow('--artifact-dir is required');
    expect(() => parseArguments(['--artifact-dir', '--worker'])).toThrow('Missing value');
    expect(() => parseArguments(['--artifact-dir', root, '--duration', '10'])).toThrow('Unsupported');
    expect(() => parseArguments(['--artifact-dir', root, '--artifact-dir', root])).toThrow('repeated');
    expect(parseArguments(['--artifact-dir', root])['--artifact-dir']).toBe(root);
    expect(() => assertIsolatedPaths(root, path.join(REPLAY_ROOT, 'new'))).not.toThrow();
    expect(() => assertIsolatedPaths(REPLAY_ROOT, path.join(REPLAY_ROOT, 'new'))).toThrow('separate');
    expect(() => assertIsolatedPaths(root, path.join(root, 'output'))).toThrow('new child');
    expect(() => assertIsolatedPaths(root, REPLAY_ROOT)).toThrow('new child');
  });
  it('hashes ordered source bytes and refuses mutation, reordering or size mismatch', async () => {
    const first = path.join(root, 'a'), second = path.join(root, 'b');
    fs.writeFileSync(first, 'first'); fs.writeFileSync(second, 'second');
    const expected = { bytes: 11, sha256: createHash('sha256').update('firstsecond').digest('hex') };
    expect(verifyHash(await hashFiles([first, second]), expected)).toEqual(expected);
    expect(() => verifyHash({ ...expected, bytes: 10 }, expected)).toThrow('mismatch');
    const reordered = await hashFiles([second, first]);
    expect(() => verifyHash(reordered, expected)).toThrow('mismatch');
    fs.writeFileSync(first, 'other');
    const mutated = await hashFiles([first, second]);
    expect(() => verifyHash(mutated, expected)).toThrow('mismatch');
    await expect(hashFiles([root])).rejects.toThrow('Unsafe replay input');
  });
  it('salvages scratch candidate and plan without exporting original chunks or calling it validated', async () => {
    const output = path.join(root, 'output'); fs.mkdirSync(output);
    const scratch = path.join(root, 'native-finalization-test'); fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, 'fast-rendered.webm'), 'partial');
    fs.writeFileSync(path.join(scratch, 'plan.json'), '{}');
    fs.writeFileSync(path.join(scratch, `${PINNED.sourceId}.webm`), 'original');
    fs.mkdirSync(path.join(root, 'native-sources'));
    fs.writeFileSync(path.join(root, 'native-sources', 'private.webm'), 'original');
    fs.writeFileSync(path.join(output, 'sandbox.json'), JSON.stringify({ path: root }));
    const files = await preserveOutputs(output);
    expect(files.map(item => item.file).sort()).toEqual([
      path.join('native-finalization-test', 'fast-rendered.webm'), path.join('native-finalization-test', 'plan.json'),
    ]);
    expect(files.every(item => item.validated === false)).toBe(true);
    expect(fs.existsSync(path.join(output, 'native-sources'))).toBe(false);
    expect(fs.existsSync(path.join(output, 'native-finalization-test', `${PINNED.sourceId}.webm`))).toBe(false);
  });
});

describe('replay FFmpeg instrumentation preserves failure gates', () => {
  it('records bounded progress and the supplied timeout without altering command options', async () => {
    vi.useFakeTimers();
    const records = [], media = command(); let now = 0;
    const run = createCommandRunner((phase, data) => records.push({ phase, ...data }), { now: () => now, intervalMs: 15000 });
    const pending = run(media, 2700000, 'Encode native recording directly');
    media.emit('progress', { timemark: '00:01:30.00', currentKbps: 192, targetSize: 100 });
    now = 15000; await vi.advanceTimersByTimeAsync(15000);
    media.emit('end'); await pending;
    expect(records[0]).toMatchObject({ phase: 'operation-start', timeoutMs: 2700000 });
    expect(records.find(item => item.phase === 'operation-progress')).toMatchObject({ childPid: 1234,
      operationElapsedMs: 15000, progress: { timemark: '00:01:30.00' } });
    expect(records.at(-1)).toMatchObject({ phase: 'operation-end', status: 'passed' });
    expect(media.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['wall', 'silence'])('kills and rejects the %s timeout while retaining failure evidence', async cause => {
    vi.useFakeTimers();
    const records = [], media = command(); let now = 0;
    const run = createCommandRunner((phase, data) => records.push({ phase, ...data }), { now: () => now });
    const pending = run(media, cause === 'wall' ? 1000 : 2700000, 'Encode');
    const rejection = expect(pending).rejects.toThrow(cause === 'wall' ? 'timed out' : 'stalled');
    media.emit('stderr', 'bounded useful diagnostic');
    now = cause === 'wall' ? 1000 : 30000;
    await vi.advanceTimersByTimeAsync(now); await rejection;
    expect(media.kill).toHaveBeenCalledWith('SIGKILL');
    expect(records.at(-1)).toMatchObject({ status: 'failed', stderrTail: ['bounded useful diagnostic'] });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears every timer after a synchronous command startup failure', async () => {
    vi.useFakeTimers();
    const media = command(); media.run.mockImplementation(() => { throw new Error('spawn failed'); });
    await expect(createCommandRunner(() => {})(media, 2700000, 'Encode')).rejects.toThrow('spawn failed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
