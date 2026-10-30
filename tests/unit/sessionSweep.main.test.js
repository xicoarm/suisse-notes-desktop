// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createBackgroundRig, webmChunk } from './support/backgroundRig.js';
import { ended, baseline, sweptRun, refreshRun } from './support/sweep.js';

// Review round 9 (council 3, required test 2): dynamic sweep N=1..max over
// every background entry of main. The REAL session authority, scope
// registry and background modules; every edge counts globally (HTTP, file
// effects, stores, renderer events, child processes, timers), not only
// through the scope, so a bypass is visible. At the N-th suspension point
// (HTTP answer, timer, fs promise incl. file handle write/sync/close, port,
// lock, retry sleep, rename retry) the session changes: (a) sign-out, (b)
// sign-out and sign-in B.
// Expected after the change: no request, no write, no event, no timer, no
// child process; the queue byte-identical; the result `sessionEnded`; B's
// registrations (claim, cancel handle) intact; after owner A signs in
// again exactly one resumption. Control: the same sweep with a refresh of
// the same session at point N - every entry runs through with the
// baseline's effects; plus offline retry and a long (multi-block)
// recording as entries of their own. Lower bound for max per entry; a
// mutant scope without alive() in commit/the publish gate turns it red.

const SCOPE_FILE = path.resolve('src-electron/session-scope.js');
const OLD = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;

const queued = (r, id = 'r1') => [{ recordId: id, filePath: r.filePath(id), metadata: {}, userId: 'a', addedAt: '2026-10-29T10:00:00.000Z', retryCount: 0 }];

// Round 10: a real first WebM chunk; main's real finalization chain runs.
function chunkDir(r, id, { fresh = false } = {}) {
  const dir = path.join(r.root, id);
  r.quietly(() => {
    fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
    const chunk = path.join(dir, 'chunks', 'chunk_0.webm');
    fs.writeFileSync(chunk, webmChunk());
    if (!fresh) fs.utimesSync(chunk, OLD, OLD);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ userId: 'a', startedAt: '2026-10-01T10:00:00.000Z' }));
  });
  return dir;
}
function emptyOrphan(r, id) {
  const dir = path.join(r.root, id);
  r.quietly(() => {
    fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
    fs.utimesSync(dir, OLD, OLD);
  });
}
const chunkSource = (r) => [path.join(r.root, 'c1', 'chunks', 'chunk_0.webm')];

/**
 * Entries: `opts` for the rig, `prepare(r)` (answers, files; may set
 * `r.queueInit`), `run(r, scope)`, `ended(result)`, `resumes` (carries
 * recording r1: one resumption expected), `min` (lower bound of points).
 */
const ENTRIES = [
  {
    name: 'queue run',
    prepare: (r) => { r.stores.queue.data.pendingUploads = queued(r); },
    run: (r, scope) => r.background.pending.run(scope),
    ended, resumes: true, min: 15,
  },
  {
    name: 'upload:start',
    run: (r, scope) => r.uploads.runUploadStart(scope, { recordId: 'r1', filePath: r.filePath(), metadata: {} }, { cancelled: () => false, quitting: () => false }),
    ended, resumes: true, min: 15,
  },
  {
    name: 'direct upload',
    prepare: (r) => { r.stores.queue.data.pendingUploads = queued(r); },
    run: (r, scope) => r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 2),
    ended, resumes: true, min: 15,
  },
  {
    name: 'direct upload, offline retry',
    prepare: (r) => {
      r.stores.queue.data.pendingUploads = queued(r);
      r.answer('post', '/api/uploads/init', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    },
    run: (r, scope) => r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 2),
    ended, resumes: true, min: 17,
  },
  {
    name: 'direct upload, long recording (3 blocks)',
    prepare: (r) => {
      r.stores.queue.data.pendingUploads = queued(r);
      r.answer('post', '/api/uploads/init', { status: 200, data: { mode: 'azure', sasUrl: 'https://blob.test/c/r?sig=1', audioFileId: 'audio-1', blockSize: 4, blobName: 'b' } });
    },
    run: (r, scope) => r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 2),
    ended, resumes: true, min: 17,
  },
  {
    name: 'legacy upload',
    prepare: (r) => {
      r.stores.queue.data.pendingUploads = queued(r);
      r.answer('post', '/api/uploads/init', { status: 200, data: { mode: 'fallback' } });
    },
    run: (r, scope) => r.uploads.uploadWithRetry(scope, 'r1', r.filePath(), {}, 2),
    ended, resumes: true, min: 12,
  },
  {
    name: 'verify + poll with 401 and refresh',
    prepare: (r) => {
      r.stores.queue.data.pendingUploads = queued(r);
      r.answer('get', /\/status$/, { status: 401, data: { error: 'expired' } });
    },
    run: (r, scope) => r.uploads.verifyAcceptedUpload(scope, 'r1', r.filePath(), { success: true, audioFileId: 'audio-1' }, 'a', true, null),
    ended, resumes: true, min: 12,
  },
  {
    name: 'verify + poll with gateway 502',
    prepare: (r) => {
      r.stores.queue.data.pendingUploads = queued(r);
      r.answer('get', /\/status$/, { status: 502, data: '<html>bad gateway</html>' });
    },
    run: (r, scope) => r.uploads.verifyAcceptedUpload(scope, 'r1', r.filePath(), { success: true, audioFileId: 'audio-1' }, 'a', true, null),
    ended, resumes: true, min: 12,
  },
  {
    name: 'verify, rename retry (EBUSY)',
    opts: { renameBusy: 2 },
    prepare: (r) => { r.stores.queue.data.pendingUploads = queued(r); },
    run: (r, scope) => r.uploads.verifyAcceptedUpload(scope, 'r1', r.filePath(), { success: true, audioFileId: 'audio-1' }, 'a', true, null),
    ended, resumes: true, min: 12, slow: true,
  },
  {
    name: 'token refresh',
    run: (r, scope) => r.uploads.refreshMainAuthToken(scope),
    ended: (res) => res?.success === false, min: 1,
  },
  {
    name: 'meeting status poll',
    prepare: (r) => { r.answer('get', /\/meeting\/[^/]+\/status$/, { status: 200, data: { status: 'PROCESSING' } }); },
    run: (r, scope) => r.uploads.pollMeetingTranscriptionStatus(scope, 'm1', 3),
    ended: (res) => res?.status === 'AUTH_EXPIRED', min: 3,
  },
  {
    name: 'recovery with finalization',
    opts: { recordings: [], history: [] },
    prepare: (r) => { chunkDir(r, 'c1'); },
    run: (r, scope) => r.background.recovery.recoverOrphanedRecordings(scope),
    ended, min: 8, recovery: true, sources: chunkSource,
  },
  {
    name: 'recovery re-scan',
    opts: { recordings: [], history: [] },
    prepare: (r) => {
      const dir = chunkDir(r, 'c1', { fresh: true });
      r.timerHook = (ms) => { if (ms === 120000) r.quietly(() => fs.utimesSync(path.join(dir, 'chunks', 'chunk_0.webm'), OLD, OLD)); };
    },
    run: (r, scope) => r.background.recovery.recoverOrphanedRecordings(scope),
    // The first pass completes; the change may land in the re-scan.
    ended: (res) => res?.completed === true || res?.sessionEnded === true, min: 8, recovery: true, sources: chunkSource,
  },
  {
    name: 'clean-up',
    opts: { recordings: [], history: [] },
    prepare: (r) => { emptyOrphan(r, 'o1'); emptyOrphan(r, 'o2'); },
    run: (r, scope) => r.background.recovery.cleanupOldOrphanedDirectories(scope),
    ended, min: 2,
  },
  {
    name: 'blob clean-up of a cancel',
    run: async (r, scope) => {
      try { return await r.background.abortDirectUpload(scope, { recordId: 'r1', audioFileId: 'audio-1' }); } catch (e) { if (e.code === 'SESSION_ENDED') return { sessionEnded: true }; throw e; }
    },
    ended, min: 1,
  },
];

/** A copy of session-scope.js without alive() in commit and/or the publish gate. */
const CUT_COMMIT = ['    function commit(fn) {\n      assertAlive();', '    function commit(fn) {'];
const CUT_GATE = ['return publishGate.run({ assertAlive }, fn);', 'return publishGate.run({ assertAlive: () => {} }, fn);'];

function mutantRegistry(cuts = [CUT_COMMIT, CUT_GATE]) {
  let src = fs.readFileSync(SCOPE_FILE, 'utf8').replace(/\r\n/g, '\n'); // Windows checkout: CRLF
  for (const [from, to] of cuts) {
    if (!src.includes(from)) throw new Error(`mutation anchor missing: ${from}`);
    src = src.replace(from, to);
  }
  const m = new Module(SCOPE_FILE, null);
  m.filename = SCOPE_FILE;
  m.paths = Module._nodeModulePaths(path.dirname(SCOPE_FILE));
  m._compile(src, SCOPE_FILE);
  return m.exports.createScopeRegistry;
}

const totals = { runs: 0, points: {} };

describe('sweep N=1..max: a session change at every suspension point', () => {
  for (const entry of ENTRIES) {
    it(`${entry.name}`, async () => {
      const base = await baseline(entry);
      totals.points[entry.name] = base.max;
      expect(base.max, `${entry.name}: points`).toBeGreaterThanOrEqual(entry.min);
      // The baseline itself runs through (no change).
      expect(entry.ended(base.result) && !entry.name.startsWith('recovery'), `${entry.name}: baseline ended`).toBe(false);
      const violations = [];
      for (let n = 1; n <= base.max; n++) {
        for (const variant of ['A', 'B']) {
          violations.push(...await sweptRun(entry, n, variant));
          totals.runs++;
        }
        violations.push(...await refreshRun(entry, n, base));
        totals.runs++;
      }
      expect(violations).toEqual([]);
    }, 120000);
  }

  it('totals (for the round-9 report)', () => {
    // eslint-disable-next-line no-console
    console.log(`[sweep] runs=${totals.runs} points=${JSON.stringify(totals.points)}`);
    expect(Object.keys(totals.points)).toHaveLength(ENTRIES.length);
  });
});

describe('mutation: alive() removed from commit and the publish gate', () => {
  it('the sweep turns red (verify with rename retry, recovery publish)', async () => {
    const factory = mutantRegistry();
    const violations = [];
    for (const entry of ENTRIES.filter((e) => ['verify, rename retry (EBUSY)', 'recovery with finalization', 'verify + poll with 401 and refresh'].includes(e.name))) {
      const base = await baseline(entry, { registryFactory: factory });
      for (let n = 1; n <= base.max; n++) violations.push(...await sweptRun(entry, n, 'A', { registryFactory: factory }));
    }
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /effects after the change/.test(v))).toBe(true);
  }, 120000);

  it('the publish gate alone (commitRename): red', async () => {
    const factory = mutantRegistry([CUT_GATE]);
    const entry = ENTRIES.find((e) => e.name === 'verify, rename retry (EBUSY)');
    const base = await baseline(entry, { registryFactory: factory });
    const violations = [];
    for (let n = 1; n <= base.max; n++) violations.push(...await sweptRun(entry, n, 'A', { registryFactory: factory }));
    expect(violations.some((v) => /"kind":"rename"/.test(v))).toBe(true);
  }, 120000);

  it('commit alone: the sweep cannot reach it (every background await resumes through settle()), the scope check is red', async () => {
    // Pinned finding of round 9: without alive() in commit the sweep stays
    // green, because no background continuation reaches a commit after a
    // change without passing a settled await or an explicit assertAlive.
    // commit's check is defence in depth; its own probe:
    const factory = mutantRegistry([CUT_COMMIT]);
    const entry = ENTRIES.find((e) => e.name === 'queue run');
    const base = await baseline(entry, { registryFactory: factory });
    const violations = [];
    for (let n = 1; n <= base.max; n++) violations.push(...await sweptRun(entry, n, 'A', { registryFactory: factory }));
    expect(violations).toEqual([]);
    for (const [label, registry] of [['mutant', factory], ['real', null]]) {
      const r = createBackgroundRig(registry ? { registryFactory: registry } : {});
      try {
        const scope = r.scopes.open();
        r.signOut();
        let threw = false;
        try { scope.update.queue(() => []); } catch { threw = true; }
        expect({ label, threw, writes: r.effectsAfter().length }).toEqual(label === 'mutant' ? { label, threw: false, writes: 1 } : { label, threw: true, writes: 0 });
      } finally {
        await r.cleanup();
      }
    }
  }, 120000);

  it('control: the unmutated scope passes the same runs', async () => {
    const violations = [];
    const entry = ENTRIES.find((e) => e.name === 'recovery with finalization');
    const base = await baseline(entry);
    for (let n = 1; n <= base.max; n++) violations.push(...await sweptRun(entry, n, 'A'));
    expect(violations).toEqual([]);
  }, 120000);
});

