// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = fs.readFileSync(path.resolve('src-electron/electron-main.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error('Binary-health function boundary changed');
  return source.slice(from, to);
}
function fixture() {
  vi.useFakeTimers();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = { resume: vi.fn() };
  child.kill = vi.fn();
  const spawn = vi.fn(() => child);
  const execFile = vi.fn((file, args, options, callback) => callback(null, '{"format":{"duration":"12.5"}}'));
  const health = { ffprobe: { available: null } };
  const functions = vm.runInNewContext(
    section('function probeBinary(', '\n// Runs once at app.whenReady.') +
    section('function getAudioMetadata(', '\n// Helper: Validate chunk sequence') +
    '\n({ probeBinary, getAudioMetadata });', {
      fs: { statSync: () => ({ size: 100, mode: 0o755 }) }, setTimeout, clearTimeout,
      require: name => { if (name !== 'child_process') throw Error('Unexpected dependency'); return { spawn, execFile }; },
      binaryHealth: health, resolveBundledBinaryPaths: () => ({ ffprobe: '/synthetic/ffprobe' }),
      isSpawnError: () => false, markBinaryUnavailable: vi.fn(),
    });
  return { child, spawn, execFile, health, ...functions };
}
afterEach(() => vi.useRealTimers());

describe('bundled media binary startup probe', () => {
  it('leaves a timed-out probe inconclusive so a subsequent real media operation can succeed', async () => {
    const f = fixture(), pending = f.probeBinary('/synthetic/ffprobe', 50);
    await vi.advanceTimersByTimeAsync(50);
    Object.assign(f.health.ffprobe, await pending);
    expect(f.health.ffprobe.available).toBeNull();
    expect(f.health.ffprobe.error).toContain('timed out');
    expect(f.child.kill).toHaveBeenCalledOnce();
    expect(f.child.stderr.resume).toHaveBeenCalledOnce();
    expect(await f.getAudioMetadata('/synthetic/recording.webm')).toEqual({ format: { duration: '12.5' } });
    expect(f.execFile).toHaveBeenCalledOnce();
  });

  it('does not turn timeout-triggered child termination into a permanent unavailable result', async () => {
    const f = fixture(), pending = f.probeBinary('/synthetic/ffprobe', 50);
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    f.child.emit('close', null, 'SIGKILL');
    expect(result.available).toBeNull();
    expect(result.error).toBe('probe timed out after 50ms');
  });

  it('still blocks real operations after an actual missing-executable spawn failure', async () => {
    const f = fixture(), pending = f.probeBinary('/synthetic/ffprobe', 50);
    f.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    Object.assign(f.health.ffprobe, await pending);
    expect(f.health.ffprobe).toMatchObject({ available: false, errno: 'ENOENT' });
    await expect(f.getAudioMetadata('/synthetic/recording.webm')).rejects.toThrow('binary unavailable');
    expect(f.execFile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records successful execution and cancels the startup deadline', async () => {
    const f = fixture(), pending = f.probeBinary('/synthetic/ffprobe', 50);
    f.child.stdout.emit('data', Buffer.from('ffprobe version synthetic\nextra'));
    f.child.emit('close', 0, null);
    expect(await pending).toMatchObject({ available: true, versionLine: 'ffprobe version synthetic' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
