// @vitest-environment node
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeRig, quiet, sweepPoints, ended, refreshRun, baseline } from './support/sweep.js';
import { CHAIN } from './support/chainEntries.js';
import { createBackgroundRig, webmChunk } from './support/backgroundRig.js';

// P5 (round 13): the data, not the counters. At every suspension point of the
// upload, the rename retry, fsync, the finalization and the re-scan: sign-out,
// sign-in B, sign-in A again, then a restart of the app on the same disk.
// Expected: every source file byte-identical, the recording playable, no receipt
// and no «uploaded» without an accepted upload, exactly one resumption, no failed
// attempt counted. Controls: a refresh at every point, offline, a long recording.

const OLD = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const queued = (r) => [{ recordId: 'r1', filePath: r.filePath('r1'), metadata: {}, userId: 'a', addedAt: '2026-10-29T10:00:00.000Z', retryCount: 0 }];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function sourceHashes(r, pattern) {
  const out = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (pattern.test(d.name)) out.push(hash(p));
    }
  };
  r.quietly(() => walk(r.root));
  return out.sort();
}

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

const transfers = (r, mark = 0) => r.requests.slice(mark).filter((q) => q.url.endsWith('/api/uploads/complete') || q.url.endsWith('/api/desktop/upload'));

async function resume(entry, r) {
  if (entry.resumes) await r.background.startQueue(r.scopes);
  if (entry.recovery) await r.background.startRecovery(r.scopes, 'sign-in');
  await quiet(entry, r);
}

/** One point N: change, resumption by owner A, restart. Returns the problems; null: the point does not exist. */
async function dataRun(entry, n) {
  const r = await makeRig(entry);
  const problems = [];
  const fail = (what) => problems.push(`${entry.name} N=${n}: ${what}`);
  let restarted = null;
  try {
    const sources = sourceHashes(r, entry.sourcePattern);
    if (!sources.length) fail('fixture without sources');
    r.sweep.at = n;
    r.sweep.action = () => { r.signOut(); r.signInB(); };
    await entry.run(r, r.scopes.open());
    await quiet(entry, r);
    if (!r.sweep.fired) return null;
    const left = r.stores.queue.data.pendingUploads.find((u) => u.recordId === 'r1');
    if (left && left.retryCount !== 0) fail(`a failed attempt was counted (${left.retryCount})`);
    const acceptedBefore = transfers(r).length;
    r.signOut();
    r.signInA();
    const mark = r.requests.length;
    await resume(entry, r);
    const again = transfers(r, mark).length;
    if (again > 1) fail(`${again} resumptions`);
    const history = JSON.parse(JSON.stringify(r.stores.history.data.recordings));
    const queue = JSON.parse(JSON.stringify(r.stores.queue.data.pendingUploads));
    const active = r.stores.active.data.activeSession;
    await r.cleanup({ keepRoot: true });

    // The app starts again on the same disk.
    restarted = createBackgroundRig({ session: 'persisted', disk: r.disk, root: r.root, recordings: [], history, queue, active, realRead: !!entry.recovery });
    await resume(entry, restarted);
    const late = transfers(restarted).length;
    if (late) fail(`${late} further uploads after the restart`);
    const now = sourceHashes(restarted, entry.sourcePattern);
    for (const h of sources) if (!now.includes(h)) fail('a source changed or is gone');
    if (entry.resumes) {
      const rec = restarted.stores.history.data.recordings.find((x) => x.id === 'r1');
      if (rec?.uploadStatus !== 'uploaded') fail(`no resumption (history ${rec?.uploadStatus})`);
      if (!entry.accepted && acceptedBefore + again === 0) fail('uploaded without an accepted upload');
      if (restarted.stores.queue.data.pendingUploads.some((u) => u.recordId === 'r1')) fail('still queued');
      const receipt = path.join(r.root, 'r1', 'upload-receipt.json');
      if (!fs.existsSync(receipt)) fail('no receipt of the accepted upload');
    }
    if (entry.playable) {
      const audio = path.join(r.root, entry.playable, 'audio.webm');
      const head = fs.existsSync(audio) ? fs.readFileSync(audio).subarray(0, 4) : Buffer.alloc(0);
      if (!head.equals(EBML)) fail('not playable after the resumption');
      // Recovery queues the finalized recording; a receipt only with an accepted upload.
      if (fs.existsSync(path.join(r.root, entry.playable, 'upload-receipt.json')) && acceptedBefore + again + late === 0) fail('a receipt without an upload');
    }
    return problems;
  } catch (error) {
    fail(`threw ${error?.stack || error}`);
    return problems;
  } finally {
    await (restarted || r).cleanup();
    if (restarted) await r.cleanup().catch(() => {});
  }
}

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
