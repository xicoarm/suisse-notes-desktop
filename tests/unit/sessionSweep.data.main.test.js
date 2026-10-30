// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeRig, quiet, sweepPoints, ended, refreshRun, baseline } from './support/sweep.js';
import { CHAIN } from './support/chainEntries.js';
import { webmChunk } from './support/backgroundRig.js';
import { dataRun, sourceHashes, transfers } from './support/dataFlows.js';

// P5 (round 13): the data, not the counters. At every suspension point of the
// upload, the rename retry, fsync, the finalization and the re-scan: sign-out,
// sign-in B, sign-in A again, then a restart of the app on the same disk.
// Expected: every source file byte-identical, the recording published, no receipt
// and no «uploaded» without an accepted upload, exactly one resumption, no failed
// attempt counted. Controls: a refresh at every point, offline, a long recording.
// Stub media at every point; valid media and the real decoder at a sample of the
// same points (round 14): sessionSweep.media.main.test.js.

const OLD = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
// Stub media: only the WebM header can be checked here.
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const queued = (r) => [{ recordId: 'r1', filePath: r.filePath('r1'), metadata: {}, userId: 'a', addedAt: '2026-10-29T10:00:00.000Z', retryCount: 0 }];
const UPLOAD = /^audio\.webm$/;
const CHUNKS = /^chunk_\d+\.webm$/;
const upload = (entry) => ({ resumes: true, ended, sourcePattern: UPLOAD, ...entry });
const QUEUE = (r) => { r.stores.queue.data.pendingUploads = queued(r); };

const ENTRIES = [
  upload({ name: 'upload', prepare: QUEUE, run: (r, scope) => r.background.pending.run(scope) }),
  upload({
    name: 'upload, rename retry and fsync of the receipt',
    // Starts with the server's acceptance in hand.
    opts: { renameBusy: 2 }, slow: true, accepted: true,
    prepare: QUEUE,
    run: (r, scope) => r.uploads.verifyAcceptedUpload(scope, 'r1', r.filePath(), { success: true, audioFileId: 'audio-1' }, 'a', true, null),
  }),
  { ...CHAIN.find((e) => e.name === 'recovery, real chain (WebM)'), sourcePattern: CHUNKS, playable: 'c1' },
  {
    name: 'recovery re-scan',
    opts: { recordings: [], history: [], realRead: true },
    prepare: (r) => {
      const dir = path.join(r.root, 'c1');
      r.quietly(() => {
        fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'chunks', 'chunk_0.webm'), webmChunk());
        fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ userId: 'a', startedAt: '2026-10-01T10:00:00.000Z' }));
      });
      r.timerHook = (ms) => { if (ms === 120000) r.quietly(() => fs.utimesSync(path.join(dir, 'chunks', 'chunk_0.webm'), OLD, OLD)); };
    },
    run: (r, scope) => r.background.recovery.recoverOrphanedRecordings(scope),
    ended: (res) => res?.completed === true || res?.sessionEnded === true,
    recovery: true, sourcePattern: CHUNKS,
  },
];

describe('P5: logout and login B/A at every point, then a restart', () => {
  const totals = {};
  for (const entry of ENTRIES) {
    it(entry.name, async () => {
      const base = await baseline(entry);
      const problems = [];
      let runs = 0;
      for (const n of sweepPoints(base.max, `data ${entry.name}`)) {
        const found = await dataRun(entry, n);
        if (found) { problems.push(...found); runs++; }
      }
      totals[entry.name] = runs;
      expect(runs).toBeGreaterThan(3);
      expect(problems).toEqual([]);
    }, 1800000);
  }

  it('totals', () => {
    // eslint-disable-next-line no-console
    console.log(`[sweep:data] ${JSON.stringify(totals)}`);
    expect(Object.keys(totals)).toHaveLength(ENTRIES.length);
  });
});

describe('P5 controls: legitimate work is untouched', () => {
  it('a refresh at every point of the upload changes nothing', async () => {
    const entry = ENTRIES[0];
    const base = await baseline(entry);
    const problems = [];
    for (const n of sweepPoints(base.max, 'data refresh')) problems.push(...await refreshRun(entry, n, base));
    expect(problems).toEqual([]);
  }, 600000);

  it('offline: a real network failure is a failed attempt and the retry completes; the source stays', async () => {
    const entry = upload({ name: 'offline', prepare: (r) => { QUEUE(r); r.answer('post', '/api/uploads/init', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })); } });
    const r = await makeRig(entry);
    try {
      const sources = sourceHashes(r, UPLOAD);
      const result = await r.uploads.uploadWithRetry(r.scopes.open(), 'r1', r.filePath(), {}, 2);
      await quiet(entry, r);
      expect(result?.success).toBe(true);
      expect(transfers(r)).toHaveLength(1);
      expect(sourceHashes(r, UPLOAD)).toEqual(sources);
    } finally {
      await r.cleanup();
    }
  }, 60000);

  it('a long recording (300 chunks): finalized, every chunk byte-identical', async () => {
    const entry = {
      name: 'long',
      opts: { recordings: [], history: [], realRead: true },
      prepare: (r) => {
        const dir = path.join(r.root, 'c1');
        r.quietly(() => {
          fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
          for (let i = 0; i < 300; i++) {
            const file = path.join(dir, 'chunks', `chunk_${i}.webm`);
            fs.writeFileSync(file, i === 0 ? webmChunk() : Buffer.alloc(2048, i % 251));
            fs.utimesSync(file, OLD, OLD);
          }
          fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ userId: 'a', startedAt: '2026-10-01T10:00:00.000Z' }));
        });
      },
    };
    const r = await makeRig(entry);
    try {
      const sources = sourceHashes(r, CHUNKS);
      const result = await r.background.recovery.recoverOrphanedRecordings(r.scopes.open());
      await quiet(entry, r);
      expect(result).toEqual({ completed: true });
      expect(sourceHashes(r, CHUNKS)).toEqual(sources);
      expect(fs.readFileSync(path.join(r.root, 'c1', 'audio.webm')).subarray(0, 4).equals(EBML)).toBe(true);
    } finally {
      await r.cleanup();
    }
  }, 120000);
});
