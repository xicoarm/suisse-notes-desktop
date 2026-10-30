// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseline, makeRig, quiet } from './support/sweep.js';
import { dataRun, sourceHashes } from './support/dataFlows.js';
import { chainEntry, makeNativeTemplate, removeNativeTemplate } from './support/chainEntries.js';
import { sinks } from './support/globalSinks.js';
import { makeLiveWebm, loopWebm, finishWebm, makePcm, decode, exactAudio, similarReference, similarAudio } from './support/realMedia.js';

// F15 (round 14): the data flows of P5 with valid media, the real ffmpeg/ffprobe in
// the chain and the real decoder as the judge: the recording decodes, has its
// duration and its samples - the source's - after sign-out, sign-in B, sign-in A at
// a point of the flow and a restart; the object of the accepted upload is that file.
//
// Why a sample of the points: at every point these flows already run on stub media
// with their bytes compared (sessionSweep.data.main.test.js), and what a change does
// to the chain does not depend on the codec. What real media adds is what the bytes
// become, and that is decided at the ends of a flow: the first point (nothing done
// yet), the last (all but the end done) and the middle (a partial state to be taken
// over). Each extra run costs several processes, on Windows seconds each (budget of
// the CI job: 25 minutes).

const OLD = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
const SECONDS = 5;
const CHUNKS = /^chunk_\d+\.webm$/;
const UPLOAD = /^audio\.webm$/;
const META = JSON.stringify({ userId: 'a', startedAt: '2026-10-01T10:00:00.000Z' });
// Small blocks: an upload of several blocks, a transport that reads them.
const OPTS = { media: 'real', blockSize: 8192 };
const CHAIN_OPTS = { ...OPTS, recordings: [], history: [], realRead: true };

let work;
const media = {};
const filesOf = (file, count) => {
  const bytes = fs.readFileSync(file);
  const size = Math.ceil(bytes.length / count);
  return Array.from({ length: count }, (_, i) => bytes.subarray(i * size, (i + 1) * size));
};
const writeChunks = (r, id, parts, old = true) => {
  const dir = path.join(r.root, id);
  r.quietly(() => {
    fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
    parts.forEach((part, i) => {
      const file = path.join(dir, 'chunks', `chunk_${i}.webm`);
      fs.writeFileSync(file, part);
      if (old) fs.utimesSync(file, OLD, OLD);
    });
    fs.writeFileSync(path.join(dir, 'metadata.json'), META);
  });
};
const uploadedIs = (r, file) => {
  const last = r.completedUploads[r.completedUploads.length - 1];
  if (!last) return ['no accepted upload with an object'];
  return last.equals(fs.readFileSync(file)) ? [] : [`the object of the accepted upload is not the file (${last.length} of ${fs.statSync(file).size} bytes)`];
};
const finished = async (r, id, reference, label = 'audio.webm') => {
  const file = path.join(r.root, id, 'audio.webm');
  return [...await exactAudio(file, reference, label), ...(fs.existsSync(file) ? uploadedIs(r, file) : [])];
};

const QUEUE = (r) => {
  r.quietly(() => fs.writeFileSync(r.filePath('r1'), media.finishedBytes));
  r.stores.queue.data.pendingUploads = [{ recordId: 'r1', filePath: r.filePath('r1'), metadata: {}, userId: 'a', addedAt: '2026-10-29T10:00:00.000Z', retryCount: 0 }];
};
const recover = (r, scope) => r.background.recovery.recoverOrphanedRecordings(scope);
const upload = (entry) => ({ opts: OPTS, resumes: true, slow: true, sourcePattern: UPLOAD, prepare: QUEUE, ...entry });
const chain = (entry) => ({ opts: CHAIN_OPTS, recovery: true, queueToo: true, slow: true, rounds: 800, playable: 'c1', sourcePattern: CHUNKS, run: recover, ...entry });

const FLOWS = {
  upload: () => upload({
    name: 'upload',
    run: (r, scope) => r.background.pending.run(scope),
    verify: async (r) => [...await exactAudio(r.filePath('r1'), media.reference, 'source'), ...uploadedIs(r, r.filePath('r1'))],
  }),
  rename: () => upload({
    name: 'upload, rename retry and fsync of the receipt',
    // Starts with the server's acceptance in hand: no object here.
    opts: { ...OPTS, renameBusy: 2 }, accepted: true,
    run: (r, scope) => r.uploads.verifyAcceptedUpload(scope, 'r1', r.filePath(), { success: true, audioFileId: 'audio-1' }, 'a', true, null),
    verify: (r) => exactAudio(r.filePath('r1'), media.reference, 'source'),
  }),
  finalization: () => chain({
    name: 'finalization (WebM chunks)',
    prepare: (r) => writeChunks(r, 'c1', media.parts),
    verify: (r) => finished(r, 'c1', media.reference),
  }),
  rescan: () => chain({
    name: 'recovery re-scan',
    prepare: (r) => {
      writeChunks(r, 'c1', media.parts, false);
      r.timerHook = (ms) => {
        if (ms !== 120000) return;
        r.quietly(() => { for (const file of fs.readdirSync(path.join(r.root, 'c1', 'chunks'))) fs.utimesSync(path.join(r.root, 'c1', 'chunks', file), OLD, OLD); });
      };
    },
    run: recover,
    ended: (res) => res?.completed === true || res?.sessionEnded === true,
    verify: (r) => finished(r, 'c1', media.reference),
  }),
  merge: () => chain({
    name: 'finalization with the system audio merge (encoded again)',
    prepare: (r) => {
      writeChunks(r, 'c1', media.parts);
      r.quietly(() => { fs.copyFileSync(media.pcm, path.join(r.root, 'c1', 'system_audio.raw')); fs.utimesSync(path.join(r.root, 'c1', 'system_audio.raw'), OLD, OLD); });
    },
    verify: async (r) => {
      const file = path.join(r.root, 'c1', 'audio.webm');
      return [...await similarAudio(file, media.mixed, 'merged audio.webm'), ...(fs.existsSync(file) ? uploadedIs(r, file) : [])];
    },
  }),
  native: () => ({
    ...chainEntry('recovery, native sources'),
    name: 'finalization of native sources (encoded again)',
    opts: CHAIN_OPTS, queueToo: true, rounds: 800, playable: 'n1', sourcePattern: /^\d+\.webm$|^chunk.*\.webm$/,
    verify: async (r) => {
      const file = path.join(r.root, 'n1', 'audio.webm');
      return [...await similarAudio(file, media.heard, 'native audio.webm'), ...(fs.existsSync(file) ? uploadedIs(r, file) : [])];
    },
  }),
};

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-media-'));
  media.live = path.join(work, 'live.webm');
  media.finished = path.join(work, 'finished.webm');
  media.pcm = path.join(work, 'system.raw');
  await makeLiveWebm(media.live, { seconds: SECONDS });
  await finishWebm(media.live, media.finished);
  await makePcm(media.pcm, { seconds: SECONDS, base: 900 });
  media.finishedBytes = fs.readFileSync(media.finished);
  media.parts = filesOf(media.live, 8);
  media.reference = await decode(media.live);
  media.heard = await similarReference([{ file: media.live }]);
  media.mixed = await similarReference([{ file: media.live }, { file: media.pcm, format: ['-f', 's16le', '-ar', '48000', '-ac', '1'] }]);
  await makeNativeTemplate({ source: media.live, seconds: SECONDS });
}, 180000);
afterAll(() => {
  removeNativeTemplate();
  fs.rmSync(work, { recursive: true, force: true });
});

const middle = (max) => Math.ceil(max / 2);
/** The run at N; a point that a run does not reach (the last, by timing): the one before it. */
async function runAt(entry, n, options) {
  for (let point = n; point > 0 && point > n - 5; point--) {
    const found = await dataRun(entry, point, options);
    if (found) return found;
  }
  throw new Error(`${entry.name}: no point at ${n}`);
}

describe('F15: valid media, real decoder: first, middle and last point of each flow, then a restart', () => {
  it('the fixture itself: decodable, a duration, and every moment its own', async () => {
    expect(media.reference.code).toBe(0);
    expect(media.reference.err).toBe('');
    expect(Math.abs(media.reference.seconds - SECONDS)).toBeLessThan(0.1);
    expect((await decode(media.finished)).sha).toBe(media.reference.sha);
  });

  for (const key of Object.keys(FLOWS)) {
    it(key, async () => {
      const entry = FLOWS[key]();
      const base = await baseline(entry);
      expect(base.max).toBeGreaterThan(3);
      const problems = [];
      for (const n of new Set([1, middle(base.max), base.max])) problems.push(...await runAt(entry, n));
      expect(problems).toEqual([]);
    }, 900000);
  }
});

describe('F15: a long recording in 300 chunks', () => {
  const MINUTES = 10;
  let long;
  beforeAll(async () => {
    const base = path.join(work, 'long-base.webm');
    const file = path.join(work, 'long.webm');
    await makeLiveWebm(base, { seconds: 30 });
    await loopWebm(base, file, MINUTES * 2);
    long = { parts: filesOf(file, 300), reference: await decode(file) };
    expect(Math.abs(long.reference.seconds - MINUTES * 60)).toBeLessThan(1);
  }, 300000);

  const entry = () => chain({
    name: 'long recording', rounds: 4000,
    prepare: (r) => writeChunks(r, 'c1', long.parts),
    verify: (r) => finished(r, 'c1', long.reference),
  });

  it('untouched and with the change in the middle: every sample, every source, one upload', async () => {
    const e = entry();
    const r = await makeRig(e);
    let max;
    try {
      const sources = sourceHashes(r, CHUNKS);
      const result = await e.run(r, r.scopes.open());
      await quiet(e, r);
      max = r.points.length;
      expect(result).toEqual({ completed: true });
      expect(sourceHashes(r, CHUNKS)).toEqual(sources);
      expect(await e.verify(r)).toEqual([]);
    } finally {
      await r.cleanup();
    }
    expect(await runAt(e, middle(max))).toEqual([]);
  }, 900000);
});

describe('F15 mutants: the judge sees what the EBML check did not', () => {
  const { truncateSync, writeFileSync } = sinks.original.fs;
  const entry = () => FLOWS.finalization();
  const audioOf = (r) => path.join(r.root, 'c1', 'audio.webm');
  let point;
  beforeAll(async () => { point = middle((await baseline(entry())).max); }, 300000);

  const red = async (e, damage, pattern) => {
    const problems = await runAt(e, point, { damage });
    expect(problems.join('\n')).toMatch(pattern);
  };

  it('control: the same point, no damage: green', async () => {
    expect(await runAt(entry(), point)).toEqual([]);
  }, 300000);

  it('truncated recording: EBML still there, the samples are not', async () => {
    await red(entry(), (r) => {
      const file = audioOf(r);
      truncateSync(file, Math.floor(fs.statSync(file).size * 0.6));
      expect(fs.readFileSync(file).subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
    }, /decoded samples differ/);
  }, 300000);

  it('corrupted recording: bytes overwritten in the middle', async () => {
    await red(entry(), (r) => {
      const file = audioOf(r);
      const bytes = fs.readFileSync(file);
      bytes.fill(0xa5, Math.floor(bytes.length / 2), Math.floor(bytes.length / 2) + 2048);
      writeFileSync(file, bytes);
    }, /decoded samples differ/);
  }, 300000);

  it('the chain itself publishes a short recording: valid, receipted, and short', async () => {
    const e = entry();
    e.opts = { ...e.opts, mainTransform: (source) => {
      const from = "cmd.outputOptions(['-avoid_negative_ts', 'make_zero']).output(finalPath);";
      if (!source.includes(from)) throw new Error('mutant: edit not found');
      return source.replace(from, "cmd.outputOptions(['-avoid_negative_ts', 'make_zero', '-t', '2']).output(finalPath);");
    } };
    await red(e, null, /decoded [12]\.\d+ s of 5\.\d+ s/);
  }, 300000);

  it('a chunk lost from the sources: the recording misses it', async () => {
    const e = entry();
    const prepare = e.prepare;
    e.prepare = (r) => { prepare(r); r.quietly(() => fs.unlinkSync(path.join(r.root, 'c1', 'chunks', 'chunk_7.webm'))); };
    await red(e, null, /decoded samples differ/);
  }, 300000);

  it('the accepted object is not the file', async () => {
    await red(entry(), (r) => { const last = r.completedUploads.length - 1; r.completedUploads[last] = r.completedUploads[last].subarray(0, 4096); }, /object of the accepted upload is not the file/);
  }, 300000);

  it('encoded again: a window lost is seen', async () => {
    const e = FLOWS.merge();
    const p = middle((await baseline(e)).max);
    const problems = await runAt(e, p, { damage: (r) => {
      const file = audioOf(r);
      truncateSync(file, Math.floor(fs.statSync(file).size * 0.6));
    } });
    expect(problems.join('\n')).toMatch(/decoded [\d.]+ s of|window/);
  }, 300000);
});
