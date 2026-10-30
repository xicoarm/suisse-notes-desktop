// The entries of the sweep over main's REAL recovery chain (review round
// 10, F4): shared by sessionSweep.chain.main.test.js and the mutation probe.
// No test framework in here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { webmChunk } from './backgroundRig.js';
import { ended } from './sweep.js';

const require = createRequire(import.meta.url);
const nativeSources = require('../../../src-electron/native-source-persistence.js');
const OLD = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
const sep = path.sep;

function webmRecording(r, id, { pcm = false } = {}) {
  const dir = path.join(r.root, id);
  r.quietly(() => {
    fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chunks', 'chunk_0.webm'), webmChunk());
    if (pcm) fs.writeFileSync(path.join(dir, 'system_audio.raw'), Buffer.alloc(9600, 1));
    for (const file of fs.readdirSync(path.join(dir, 'chunks'))) fs.utimesSync(path.join(dir, 'chunks', file), OLD, OLD);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ userId: 'a', startedAt: '2026-10-01T10:00:00.000Z' }));
  });
  return dir;
}

// A native recording (one microphone source, real Opus), made once with the
// bundled ffmpeg (no rig bound: not counted) and copied into each rig.
let nativeTemplate;
/** Makes the native template once (call before the native entry runs). */
export async function makeNativeTemplate() {
  if (nativeTemplate) return;
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-native-'));
  const webm = path.join(work, 'mic.webm');
  await new Promise((done, fail) => require('node:child_process').execFile(ffmpegPath,
    ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'libopus', '-y', webm],
    (error) => (error ? fail(error) : done())));
  nativeTemplate = path.join(work, 'n1');
  fs.mkdirSync(nativeTemplate);
  const sourceId = '3f0c2a52-7d1e-4c4b-9a7e-2b1d5f6a8c90';
  await nativeSources.beginSource(nativeTemplate, { sourceId, kind: 'microphone', startOffsetMs: 0, mimeType: 'audio/webm;codecs=opus', settings: { channelCount: 1 } });
  await nativeSources.markSourceStarted(nativeTemplate, sourceId, { startOffsetMs: 0 });
  await nativeSources.saveSourceChunk(nativeTemplate, sourceId, fs.readFileSync(webm), 0);
  await nativeSources.endSource(nativeTemplate, sourceId, { endOffsetMs: 1000, chunkCount: 1, reason: 'stopped' });
  fs.writeFileSync(path.join(nativeTemplate, 'metadata.json'), JSON.stringify({ userId: 'a', startedAt: '2026-10-01T10:00:00.000Z' }));
}
export function removeNativeTemplate() {
  if (nativeTemplate) fs.rmSync(path.dirname(nativeTemplate), { recursive: true, force: true });
  nativeTemplate = null;
}

function nativeRecording(r, id) {
  const dir = path.join(r.root, id);
  r.quietly(() => {
    fs.cpSync(nativeTemplate, dir, { recursive: true });
    const touch = (p) => { fs.utimesSync(p, OLD, OLD); if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) touch(path.join(p, f)); };
    touch(dir);
  });
  return dir;
}

const recover = (r, scope) => r.background.recovery.recoverOrphanedRecordings(scope);
const finalized = (id) => (r) => (fs.existsSync(path.join(r.root, id, 'audio.webm')) ? [] : [`${id}: no audio.webm after the resumption`]);

export const CHAIN = [
  {
    name: 'recovery, real chain (WebM)',
    opts: { recordings: [], history: [], realRead: true },
    prepare: (r) => { webmRecording(r, 'c1'); },
    run: recover, ended, min: 30, recovery: true,
    sources: (r) => [path.join(r.root, 'c1')],
    afterResume: finalized('c1'),
  },
  {
    name: 'recovery, real chain with the system audio merge',
    opts: { recordings: [], history: [], realRead: true },
    prepare: (r) => { webmRecording(r, 'c1', { pcm: true }); },
    run: recover, ended, min: 30, recovery: true,
    sources: (r) => [path.join(r.root, 'c1', 'system_audio.raw')],
    afterResume: finalized('c1'),
  },
  {
    name: 'recovery, native sources (real media)',
    opts: { recordings: [], history: [], realRead: true, media: 'real' },
    prepare: (r) => { nativeRecording(r, 'n1'); },
    run: recover, ended, min: 30, recovery: true, slow: true,
    sources: (r) => [path.join(r.root, 'n1', 'native-sources')],
    afterResume: finalized('n1'),
  },
];
export const chainEntry = (name) => CHAIN.find((e) => e.name.startsWith(name));


/** The change at a named point (label, target path or arguments). */
export const at = (label, test) => (l, target) => l === label && !!target && test(String(target));

/**
 * The rename that publishes the merged file over audio_building.webm (the
 * first rename to it after the merged file was synced). Stateful: a fresh
 * predicate per run (`fresh`, support/sweep.js).
 */
function afterMergePublished() {
  const make = () => {
    let synced = false;
    return (label, target) => {
      const t = String(target || '');
      if (label === 'handle.sync' && t.endsWith('_merged.webm')) synced = true;
      return synced && label === 'fs.rename' && t.endsWith(`${sep}audio_building.webm`);
    };
  };
  const point = make();
  point.fresh = make;
  return point;
}

/**
 * Named points (F1-F3 of review round 9, each failed at 1f4d97d; PATH: right
 * after the merged file is published, where the mutants of
 * support/mutants.js insert a new effect). key -> [title, entry, point]
 */
export const NAMED = {
  'F1 readdir': ['F1 durable-files: sign-out during readdir(chunks), before mkdir(source-chunks)', 'recovery, real chain (WebM)',
    at('fs.readdir', (t) => t.endsWith(`${sep}chunks`))],
  'F1 rename': ['F1 recording-persistence: sign-out while the session is published, before unlink(source_raw)', 'recovery, real chain (WebM)',
    at('fs.rename', (t) => t.endsWith('source_final.webm'))],
  'F1 mkdir': ['F1 recording-persistence: sign-out during archiveChunkBatch, before mkdir(sessions)', 'recovery, real chain (WebM)',
    at('fs.mkdir', (t) => t.endsWith(`${sep}chunks`))],
  'F2 merge': ['F2 merge: sign-out while the merged file is published, before system:capture-warning', 'recovery, real chain with the system audio merge',
    at('handle.sync', (t) => t.endsWith('_merged.webm'))],
  'F3 ffprobe': ['F3 encoded-opus-evidence: sign-out during the first ffprobe, before the second', 'recovery, native sources (real media)',
    at('spawn:ffprobe', (t) => t.includes('-show_data') && t.includes('-show_streams'))],
  'F3 read': ['F3 encoded-opus-evidence: sign-out while the output is read (captureContent), before any ffprobe', 'recovery, native sources (real media)',
    at('fs.read', (t) => /native-finalization-[^/\\]+[/\\](fast-)?rendered\.webm$/.test(t))],
  PATH: ['a new effect right after the merged file is published', 'recovery, real chain with the system audio merge',
    afterMergePublished()],
};
