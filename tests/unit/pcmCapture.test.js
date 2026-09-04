// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPcmCapture } = require('../../src-electron/pcm-capture');

let root;
let captures;
function child() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = vi.fn(signal => { proc.killed = true; return true; });
  proc.close = () => { proc.stdout.end(); proc.emit('close', 0); };
  return proc;
}
function capture(proc, extra = {}) {
  const result = createPcmCapture({ process: proc, filePath: path.join(root, 'system_audio.raw'), ...extra });
  captures.push({ result, proc });
  return result;
}
beforeEach(async () => {
  captures = [];
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-pcm-test-'));
});
afterEach(async () => {
  for (const { result, proc } of captures) { const stopped = result.stop(); proc.close(); await stopped; }
  vi.restoreAllMocks();
  if (!path.resolve(root).startsWith(path.join(os.tmpdir(), 'suisse-pcm-test-'))) throw Error('Unsafe cleanup');
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('macOS PCM capture supervision', () => {
  it('requires a real startup signal, including a JSON line split across stderr events', async () => {
    const proc = child();
    const c = capture(proc);
    let ready = false;
    c.started.then(() => { ready = true; });
    proc.stderr.write('{"message_type":"stream_');
    await Promise.resolve();
    expect(ready).toBe(false);
    proc.stderr.write('start"}\n');
    expect(await c.started).toMatchObject({ success: true });
  });

  it('drains late stdout before returning from stop and flushes every byte', async () => {
    const proc = child();
    const c = capture(proc);
    proc.stdout.write(Buffer.from('first'));
    await c.started;
    const stopped = c.stop();
    // exit can precede stdout closing; late bytes must still be persisted.
    proc.emit('exit', 0);
    proc.stdout.write(Buffer.from('last'));
    proc.close();
    expect(await stopped).toMatchObject({ success: true });
    expect(fs.readFileSync(c.filePath, 'utf8')).toBe('firstlast');
  });

  it('does not record through a user pause', async () => {
    const proc = child();
    const measured = [];
    const c = capture(proc, { onData: bytes => measured.push(bytes.toString()) });
    proc.stdout.write(Buffer.from('before'));
    await c.started;
    c.setPaused(true);
    proc.stdout.write(Buffer.from('private pause'));
    await new Promise(resolve => setImmediate(resolve));
    c.setPaused(false);
    proc.stdout.write(Buffer.from('after'));
    const stopped = c.stop(); proc.close(); await stopped;
    expect(fs.readFileSync(c.filePath, 'utf8')).toBe('beforeafter');
  });

  it('preserves accepted bytes and excludes paused bytes while disk opening is pending', async () => {
    const proc = child(); const c = capture(proc);
    proc.stdout.write(Buffer.from('before'));
    c.setPaused(true);
    proc.stdout.write(Buffer.from('private'));
    c.setPaused(false);
    proc.stdout.write(Buffer.from('after'));
    const stopped = c.stop(); proc.close(); await stopped;
    expect(fs.readFileSync(c.filePath, 'utf8')).toBe('beforeafter');
  });

  it('escalates to SIGKILL even though SIGTERM already set killed=true', async () => {
    const proc = child();
    proc.kill.mockImplementation(signal => {
      proc.killed = true;
      if (signal === 'SIGKILL') proc.close();
      return true;
    });
    const c = capture(proc, { killTimeoutMs: 20 });
    proc.stdout.write(Buffer.from('audio'));
    await c.started;
    await c.stop();
    expect(proc.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports an unexpected child exit instead of leaving capture healthy', async () => {
    const proc = child(); const onFailure = vi.fn();
    const c = capture(proc, { onFailure });
    proc.stdout.write(Buffer.from('audio'));
    await c.started;
    proc.close();
    expect(await c.stop()).toMatchObject({ success: false });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(c.filePath, 'utf8')).toBe('audio');
  });

  it('surfaces a disk-open failure and preserves existing data', async () => {
    const proc = child(); const onFailure = vi.fn();
    const c = capture(proc, { filePath: path.join(root, 'missing', 'audio.raw'), onFailure });
    proc.stdout.write(Buffer.from('audio'));
    expect(await c.started).toMatchObject({ success: false });
    const stopped = c.stop(); proc.close();
    expect(await stopped).toMatchObject({ success: false });
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
