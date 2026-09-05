// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../../src-electron/native-source-persistence');
const { beginSource, markSourceStarted, saveSourceChunk, endSource, inspectNativeSources, sourceFingerprint } = require(modulePath);
let root;
let sourceId;

function layout(id = sourceId) {
  const directory = path.join(root, 'native-sources', id);
  return { directory, chunks: path.join(directory, 'chunks'), manifest: path.join(directory, 'manifest.json'),
    started: path.join(directory, 'started.json'), end: path.join(directory, 'end.json') };
}
function options(overrides = {}) {
  return { sourceId, kind: 'microphone', startOffsetMs: 10, mimeType: 'audio/webm;codecs=opus',
    settings: { channelCount: 1, sampleRate: 48000, echoCancellation: true }, ...overrides };
}
async function start(overrides = {}) {
  const values = options(overrides);
  await beginSource(root, values);
  await markSourceStarted(root, values.sourceId, { startOffsetMs: values.startOffsetMs + 25 });
  return values.sourceId;
}
async function save(index, data = `audio-${index}`, id = sourceId) {
  return saveSourceChunk(root, id, Buffer.from(data), index);
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'suisse-native-source-test-'));
  sourceId = randomUUID();
});
afterEach(async () => {
  vi.restoreAllMocks();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('suisse-native-source-test-')) {
    throw new Error('Invalid native-source fixture cleanup path');
  }
  await fs.promises.rm(resolved, { recursive: true, force: true });
});

describe('durable independent native audio sources', () => {
  it('distinguishes a reserved source from captured audio and uses the actual start time', async () => {
    expect(inspectNativeSources(root)).toEqual([]);
    await beginSource(root, options());
    expect(inspectNativeSources(root)[0]).toMatchObject({ reservedStartOffsetMs: 10, startOffsetMs: null,
      started: false, complete: false, interrupted: true, hasAudio: false, chunkPaths: [] });
    await expect(save(0)).rejects.toThrow('no durable start marker');
    await markSourceStarted(root, sourceId, { startOffsetMs: 85.25 });
    await save(0);
    const source = inspectNativeSources(root)[0];
    expect(source).toMatchObject({ reservedStartOffsetMs: 10, startOffsetMs: 85.25,
      interrupted: true, hasAudio: true, complete: false });
    expect(fs.readFileSync(source.chunkPaths[0], 'utf8')).toBe('audio-0');
  });

  it('preserves exact independent lanes and source order through device replacement', async () => {
    const system = await start({ sourceId: randomUUID(), kind: 'system', startOffsetMs: 0 });
    await start();
    const replacement = await start({ sourceId: randomUUID(), startOffsetMs: 1000 });
    await save(0, 'mic'); await save(0, 'system', system); await save(0, 'replacement', replacement);
    await endSource(root, sourceId, { endOffsetMs: 1025, chunkCount: 1, reason: 'device-replaced' });
    await endSource(root, system, { endOffsetMs: 2000, chunkCount: 1, reason: 'stop' });
    await endSource(root, replacement, { endOffsetMs: 2000, chunkCount: 1, reason: 'stop' });
    const sources = inspectNativeSources(root);
    expect(sources.map(source => source.sourceId)).toEqual([system, sourceId, replacement]);
    expect(sources.every(source => source.complete && !source.interrupted)).toBe(true);
    expect(sources.map(source => fs.readFileSync(source.chunkPaths[0], 'utf8'))).toEqual(['system', 'mic', 'replacement']);
  });

  it('makes begin, actual start, chunk and end retries idempotent without rewriting originals', async () => {
    await start();
    expect(await beginSource(root, options())).toMatchObject({ duplicate: true });
    expect(await markSourceStarted(root, sourceId, { startOffsetMs: 35 })).toMatchObject({ duplicate: true });
    await save(0, 'retained');
    const original = fs.statSync(path.join(layout().chunks, 'chunk_0.webm'));
    expect(await save(0, 'retained')).toMatchObject({ duplicate: true, byteLength: 8 });
    const terminal = { endOffsetMs: 1000, chunkCount: 1, reason: 'stop' };
    expect(await endSource(root, sourceId, terminal)).toMatchObject({ duplicate: false });
    expect(await endSource(root, sourceId, terminal)).toMatchObject({ duplicate: true });
    expect(await save(0, 'retained')).toMatchObject({ duplicate: true });
    expect(fs.statSync(path.join(layout().chunks, 'chunk_0.webm')).mtimeMs).toBe(original.mtimeMs);
    await expect(save(1, 'late')).rejects.toThrow('ended source');
    await expect(save(0, 'modified')).rejects.toThrow('conflicts');
    await expect(beginSource(root, options({ kind: 'system' }))).rejects.toThrow('conflicts');
    await expect(markSourceStarted(root, sourceId, { startOffsetMs: 36 })).rejects.toThrow('conflicts');
    await expect(endSource(root, sourceId, { ...terminal, endOffsetMs: 1001 })).rejects.toThrow('conflicts');
    expect(fs.readFileSync(path.join(layout().chunks, 'chunk_0.webm'), 'utf8')).toBe('retained');
  });

  it('discovers a chunk published just before a failed acknowledgement and resumes after restart', async () => {
    await start();
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => {
      await realRename(from, to);
      throw Object.assign(new Error('crash after publication'), { code: 'EIO' });
    });
    await expect(save(0, 'published-before-ack')).rejects.toThrow('crash after publication');
    vi.restoreAllMocks();
    expect(fs.readFileSync(path.join(layout().chunks, 'chunk_0.webm'), 'utf8')).toBe('published-before-ack');
    delete require.cache[modulePath];
    const restarted = require(modulePath);
    expect(restarted.inspectNativeSources(root)[0]).toMatchObject({ chunkCount: 1, interrupted: true });
    expect(await restarted.saveSourceChunk(root, sourceId, Buffer.from('published-before-ack'), 0)).toMatchObject({ duplicate: true });
    await restarted.saveSourceChunk(root, sourceId, Buffer.from('after-restart'), 1);
    await restarted.endSource(root, sourceId, { endOffsetMs: 2000, chunkCount: 2, reason: 'stop' });
    expect(restarted.inspectNativeSources(root)[0]).toMatchObject({ chunkCount: 2, complete: true });
  });

  it('completes an exact retry when a live writer cache predates publication', async () => {
    await start(); await save(0);
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => {
      await realRename(from, to);
      throw Object.assign(new Error('post-rename sync failed'), { code: 'EIO' });
    });
    await expect(save(1)).rejects.toThrow('sync failed');
    vi.restoreAllMocks();
    expect(await save(1)).toMatchObject({ duplicate: true });
    await save(2);
    expect(inspectNativeSources(root)[0].chunkCount).toBe(3);
  });

  it('rejects a skipped index and detects a gap on disk without losing later audio', async () => {
    await start(); await save(0);
    await expect(save(2)).rejects.toThrow('gap');
    await fs.promises.writeFile(path.join(layout().chunks, 'chunk_2.webm'), 'third');
    const source = inspectNativeSources(root)[0];
    expect(source.gaps).toEqual([{ start: 1, end: 1 }]);
    expect(source.chunkPaths.map(file => path.basename(file))).toEqual(['chunk_0.webm', 'chunk_2.webm']);
    await expect(endSource(root, sourceId, { endOffsetMs: 3000, chunkCount: 2, reason: 'stop' })).rejects.toThrow('gap');
    expect(fs.existsSync(layout().end)).toBe(false);
    expect(fs.readFileSync(source.chunkPaths[1], 'utf8')).toBe('third');
  });

  it('never acknowledges completion when an expected final chunk is missing', async () => {
    await start(); await save(0);
    await expect(endSource(root, sourceId, { endOffsetMs: 2000, chunkCount: 2, reason: 'stop' })).rejects.toThrow('count mismatch');
    await save(1);
    await endSource(root, sourceId, { endOffsetMs: 2000, chunkCount: 2, reason: 'stop' });
    await fs.promises.unlink(path.join(layout().chunks, 'chunk_1.webm'));
    expect(inspectNativeSources(root)[0]).toMatchObject({ terminalMismatch: true, complete: false, expectedChunkCount: 2 });
    await expect(endSource(root, sourceId, { endOffsetMs: 2000, chunkCount: 2, reason: 'stop' })).rejects.toThrow('mismatch');
  });

  it('can retry a terminal marker publication after the acknowledgement fails', async () => {
    await start(); await save(0);
    const terminal = { endOffsetMs: 1000, chunkCount: 1, reason: 'stop' };
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => {
      await realRename(from, to);
      throw Object.assign(new Error('end acknowledgement failed'), { code: 'EIO' });
    });
    await expect(endSource(root, sourceId, terminal)).rejects.toThrow('acknowledgement failed');
    vi.restoreAllMocks();
    expect(await endSource(root, sourceId, terminal)).toMatchObject({ duplicate: true });
    expect(inspectNativeSources(root)[0].complete).toBe(true);
  });

  it('detects changed starts, ends and source bytes when computing completion fingerprints', async () => {
    const absent = sourceFingerprint(root);
    await beginSource(root, options());
    const reserved = sourceFingerprint(root);
    expect(reserved).not.toBe(absent);
    await markSourceStarted(root, sourceId, { startOffsetMs: 35 });
    const started = sourceFingerprint(root);
    expect(started).not.toBe(reserved);
    await save(0, 'original');
    const recorded = sourceFingerprint(root);
    expect(recorded).not.toBe(started);
    await endSource(root, sourceId, { endOffsetMs: 1000, chunkCount: 1, reason: 'stop' });
    const ended = sourceFingerprint(root);
    expect(ended).not.toBe(recorded);
    const file = path.join(layout().chunks, 'chunk_0.webm');
    await fs.promises.writeFile(file, 'tampered');
    await fs.promises.utimes(file, new Date(100000), new Date(100000));
    expect(sourceFingerprint(root)).not.toBe(ended);
    const manifest = JSON.parse(fs.readFileSync(layout().manifest, 'utf8'));
    const beforeSettings = sourceFingerprint(root);
    await fs.promises.writeFile(layout().manifest, JSON.stringify({ ...manifest, settings: { sampleRate: 44100 } }));
    expect(sourceFingerprint(root)).not.toBe(beforeSettings);
  });

  it('retains partial temporary artifacts without treating them as committed audio', async () => {
    await start(); await save(0);
    const temporary = [path.join(root, 'native-sources', 'unpublished.tmp'),
      path.join(layout().directory, 'manifest.json.interrupted.tmp'), path.join(layout().chunks, 'chunk_1.webm.interrupted.tmp')];
    for (const file of temporary) await fs.promises.writeFile(file, 'partial');
    const fingerprint = sourceFingerprint(root);
    await save(0);
    expect(inspectNativeSources(root)[0].chunkCount).toBe(1);
    expect(sourceFingerprint(root)).toBe(fingerprint);
    for (const file of temporary) expect(fs.readFileSync(file, 'utf8')).toBe('partial');
  });

  it('refuses truncated manifests, orphan source folders and unrecognized audio files', async () => {
    await start(); await save(0);
    const original = fs.readFileSync(layout().manifest, 'utf8');
    await fs.promises.writeFile(layout().manifest, '{"version":');
    expect(() => inspectNativeSources(root)).toThrow('malformed JSON');
    await expect(beginSource(root, options())).rejects.toThrow('malformed JSON');
    expect(fs.readFileSync(path.join(layout().chunks, 'chunk_0.webm'), 'utf8')).toBe('audio-0');
    await fs.promises.writeFile(layout().manifest, original);
    const orphan = path.join(root, 'native-sources', randomUUID());
    await fs.promises.mkdir(path.join(orphan, 'chunks'), { recursive: true });
    await fs.promises.writeFile(path.join(orphan, 'chunks', 'chunk_0.webm'), 'orphan-audio');
    expect(() => inspectNativeSources(root)).toThrow('manifest');
    await expect(beginSource(root, options({ sourceId: path.basename(orphan) }))).rejects.toThrow('manifest');
    // Keep the orphan evidence but turn it into an explicitly uncommitted
    // artifact so the separate unknown-file validation can be exercised.
    await fs.promises.rename(orphan, `${orphan}.tmp`);
    await fs.promises.writeFile(path.join(layout().chunks, 'unexpected.webm'), 'audio');
    expect(() => inspectNativeSources(root)).toThrow('unrecognized source chunk');
    expect(() => sourceFingerprint(root)).toThrow('unrecognized source chunk');
  });

  it('refuses a public orphan reservation and allows ending an acknowledged reservation that never started', async () => {
    await fs.promises.mkdir(layout().chunks, { recursive: true });
    await fs.promises.writeFile(path.join(layout().directory, 'manifest.json.partial.tmp'), 'partial');
    await expect(beginSource(root, options())).rejects.toThrow('manifest');
    await fs.promises.rename(layout().directory, `${layout().directory}.tmp`);
    await beginSource(root, options());
    expect(inspectNativeSources(root)[0]).toMatchObject({ started: false, hasAudio: false });
    await endSource(root, sourceId, { endOffsetMs: 20, chunkCount: 0, reason: 'start-failed' });
    expect(inspectNativeSources(root)[0]).toMatchObject({ started: false, complete: false, interrupted: false });
    await expect(markSourceStarted(root, sourceId, { startOffsetMs: 35 })).rejects.toThrow('ended source');
  });

  it('keeps completed audio inspectable when a new reservation crashes before manifest publication', async () => {
    await start(); await save(0, 'earlier-audio');
    await endSource(root, sourceId, { endOffsetMs: 1000, chunkCount: 1, reason: 'replacement' });
    const previousFingerprint = sourceFingerprint(root);
    const replacementId = randomUUID();
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((file, ...args) => {
      if (String(file).includes('manifest.json.')) throw Object.assign(new Error('manifest write failed'), { code: 'EIO' });
      return realOpen(file, ...args);
    });
    await expect(beginSource(root, options({ sourceId: replacementId, startOffsetMs: 1000 }))).rejects.toThrow('manifest write failed');
    vi.restoreAllMocks();
    expect(fs.existsSync(layout(replacementId).directory)).toBe(false);
    const entries = fs.readdirSync(path.join(root, 'native-sources'));
    expect(entries).toHaveLength(2);
    const retainedStaging = entries.find(name => name.endsWith('.tmp'));
    expect(retainedStaging).toBeTruthy();
    expect(inspectNativeSources(root)).toHaveLength(1);
    expect(inspectNativeSources(root)[0]).toMatchObject({ complete: true, chunkCount: 1 });
    expect(sourceFingerprint(root)).toBe(previousFingerprint);
    await beginSource(root, options({ sourceId: replacementId, startOffsetMs: 1000 }));
    expect(inspectNativeSources(root)).toHaveLength(2);
    expect(fs.existsSync(path.join(root, 'native-sources', retainedStaging))).toBe(true);
  });

  it('replays a reservation whose final directory rename succeeded before acknowledgement failed', async () => {
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (to === layout().directory) throw Object.assign(new Error('reservation acknowledgement failed'), { code: 'EIO' });
    });
    await expect(beginSource(root, options())).rejects.toThrow('reservation acknowledgement failed');
    vi.restoreAllMocks();
    expect(inspectNativeSources(root)[0]).toMatchObject({ started: false, chunkCount: 0 });
    expect(await beginSource(root, options())).toMatchObject({ duplicate: true });
    await markSourceStarted(root, sourceId, { startOffsetMs: 35 });
    await save(0, 'after-reservation-retry');
    expect(inspectNativeSources(root)[0].chunkCount).toBe(1);
  });

  it('does not replace an existing null JSON manifest or marker as though it were absent', async () => {
    await beginSource(root, options());
    const original = fs.readFileSync(layout().manifest, 'utf8');
    await fs.promises.writeFile(layout().manifest, 'null');
    await expect(beginSource(root, options())).rejects.toThrow('invalid source manifest');
    expect(fs.readFileSync(layout().manifest, 'utf8')).toBe('null');
    await fs.promises.writeFile(layout().manifest, original);
    await fs.promises.writeFile(layout().started, 'null');
    await expect(markSourceStarted(root, sourceId, { startOffsetMs: 35 })).rejects.toThrow('invalid source start marker');
    expect(fs.readFileSync(layout().started, 'utf8')).toBe('null');
  });

  it('does not scan the growing chunks directory on every acknowledged chunk', async () => {
    await start(); await save(0);
    const reads = vi.spyOn(fs, 'readdirSync');
    for (let index = 1; index < 24; index++) await save(index);
    expect(reads.mock.calls.filter(([directory]) => directory === layout().chunks)).toHaveLength(0);
    expect(inspectNativeSources(root)[0].chunkCount).toBe(24);
  });

  it('rejects traversal, malformed metadata, invalid offsets and ambiguous chunk names', async () => {
    for (const bad of ['../outside', 'A'.repeat(36), '', `${sourceId}/..`]) {
      await expect(beginSource(root, options({ sourceId: bad }))).rejects.toThrow('source ID');
    }
    for (const overrides of [{ kind: 'other' }, { startOffsetMs: NaN }, { startOffsetMs: -1 },
      { mimeType: '../audio' }, { settings: { nested: {} } }, { settings: { deviceId: 'x'.repeat(1025) } },
      { settings: JSON.parse('{"__proto__":"unsafe"}') }]) {
      await expect(beginSource(root, options(overrides))).rejects.toThrow('Native audio sources');
    }
    await start();
    await expect(markSourceStarted(root, sourceId, { startOffsetMs: 9 })).rejects.toThrow('precedes');
    await expect(endSource(root, sourceId, { endOffsetMs: 34, chunkCount: 0, reason: 'stop' })).rejects.toThrow('precedes');
    await expect(saveSourceChunk(root, sourceId, [], 0)).rejects.toThrow('bytes');
    await expect(saveSourceChunk(root, sourceId, Buffer.alloc(0), 0)).rejects.toThrow('bytes');
    await expect(save(-1)).rejects.toThrow('index');
    await fs.promises.writeFile(path.join(layout().chunks, 'chunk_00.webm'), 'ambiguous');
    expect(() => inspectNativeSources(root)).toThrow('unrecognized');
  });

  it('rejects a source directory junction instead of writing outside the recording', async () => {
    await fs.promises.mkdir(path.join(root, 'native-sources'));
    const outside = path.join(root, 'outside');
    await fs.promises.mkdir(outside);
    await fs.promises.symlink(outside, layout().directory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(beginSource(root, options())).rejects.toThrow('unsafe directory');
    expect(() => inspectNativeSources(root)).toThrow('unsafe directory');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
