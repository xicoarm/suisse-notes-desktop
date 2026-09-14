// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createNativeSourceRecorder } from '../../src/services/nativeSourceRecorder';

const require = createRequire(import.meta.url);
const storage = require('../../src-electron/native-source-persistence');
let root, archive, clock, recorders, bridge;

class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getAudioTracks() { return this.tracks; }
}
class Recorder {
  constructor(stream) { this.stream = stream; this.state = 'inactive'; recorders.push(this); }
  start() { this.state = 'recording'; queueMicrotask(() => this.onstart?.()); }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.data('final-' + this.stream.getAudioTracks()[0].name);
      this.onstop?.();
    });
  }
  data(bytes) { this.ondataavailable?.({ data: new Blob([bytes]) }); }
}
function source(name) {
  return new Stream([{ name, enabled: true, readyState: 'live',
    getSettings: () => ({ sampleRate: 48000, channelCount: 1, echoCancellation: true }) }]);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Native archive did not settle');
    await tick();
  }
}
const audio = entry => Buffer.concat(entry.chunkPaths.map(file => fs.readFileSync(file))).toString();

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-native-integration-'));
  clock = 0; recorders = [];
  bridge = {};
  // Electron is deliberately absent. Exercise the real renderer coordinator
  // against the real disk protocol through the same response/error shape.
  for (const name of ['beginSource', 'markSourceStarted', 'saveSourceChunk', 'endSource']) {
    bridge[name] = async (_recordId, ...args) => {
      try { return await storage[name](root, ...args); }
      catch (error) { return { success: false, error: error.message, code: error.code }; }
    };
  }
  archive = createNativeSourceRecorder({ recordId: 'fixture', bridge, MediaRecorder: Recorder,
    MediaStream: Stream, activeOffsetMs: () => clock, stopTimeoutMs: 2000 });
});
afterEach(async () => {
  await archive.cancel();
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('suisse-native-integration-')) throw new Error('Invalid cleanup path');
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('native source coordinator and durable storage contract', () => {
  it('recovers an acknowledged-on-disk write after its IPC reply is lost, without duplicating either source', async () => {
    const save = bridge.saveSourceChunk;
    let loseReply = true;
    bridge.saveSourceChunk = async (...args) => {
      const result = await save(...args);
      if (loseReply) { loseReply = false; return { success: false, error: 'IPC reply lost after durable publication' }; }
      return result;
    };
    expect(await archive.attach('microphone', source('mic'))).toMatchObject({ success: true });
    expect(await archive.attach('system', source('system'))).toMatchObject({ success: true });
    clock = 1200;
    recorders[0].data('accepted-mic-');
    await until(() => archive.getState().fatalError !== null);
    expect((await archive.stop()).success).toBe(false);
    expect(await archive.retry()).toMatchObject({ success: true });
    const sources = storage.inspectNativeSources(root);
    expect(sources).toHaveLength(2);
    expect(sources.every(entry => entry.complete)).toBe(true);
    expect(audio(sources.find(entry => entry.kind === 'microphone'))).toBe('accepted-mic-final-mic');
    expect(audio(sources.find(entry => entry.kind === 'system'))).toBe('final-system');
  });

  it('retries the same durable start marker before saving audio retained after a lost start reply', async () => {
    const start = bridge.markSourceStarted;
    let loseReply = true;
    bridge.markSourceStarted = async (...args) => {
      const result = await start(...args);
      if (loseReply) { loseReply = false; return { success: false, error: 'Start reply lost' }; }
      return result;
    };
    expect((await archive.attach('microphone', source('mic'))).success).toBe(false);
    await archive.stop();
    expect(storage.inspectNativeSources(root)[0].chunkCount).toBe(0);
    expect(await archive.retry()).toMatchObject({ success: true });
    const [recovered] = storage.inspectNativeSources(root);
    expect(recovered).toMatchObject({ startOffsetMs: 0, chunkCount: 1, complete: true });
    expect(audio(recovered)).toBe('final-mic');
  });

  it('stores independent paused and replacement epochs on the active timeline, without recording a paused replacement', async () => {
    const first = source('first'), replacement = source('replacement');
    expect(await archive.attach('microphone', first)).toMatchObject({ success: true });
    clock = 1000;
    expect(await archive.pause()).toMatchObject({ success: true });
    expect(await archive.attach('microphone', replacement)).toMatchObject({ success: true, paused: true });
    replacement.getAudioTracks()[0].enabled = false;
    expect(recorders).toHaveLength(1);
    expect(await archive.resume()).toMatchObject({ success: true });
    expect(recorders).toHaveLength(2);
    expect(recorders[1].stream.getAudioTracks()[0]).toBe(replacement.getAudioTracks()[0]);
    expect(recorders[1].stream.getAudioTracks()[0].enabled).toBe(false);
    clock = 2500;
    expect(await archive.stop()).toMatchObject({ success: true });
    const sources = storage.inspectNativeSources(root);
    expect(sources.map(entry => [entry.startOffsetMs, entry.endOffsetMs, entry.reason])).toEqual([
      [0, 1000, 'paused'], [1000, 2500, 'stopped'],
    ]);
    expect(sources.map(audio)).toEqual(['final-first', 'final-replacement']);
  });
});
