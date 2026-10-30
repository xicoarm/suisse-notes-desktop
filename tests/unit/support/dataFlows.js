// One run of the data flows (P5, round 13; shared with the real media of round
// 14): at point N sign-out and sign-in B, then owner A resumes, then the app
// restarts on the same disk. No test framework in here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeRig, quiet } from './sweep.js';
import { createBackgroundRig } from './backgroundRig.js';

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function sourceHashes(r, pattern) {
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

export const transfers = (r, mark = 0) => r.requests.slice(mark).filter((q) => q.url.endsWith('/api/uploads/complete') || q.url.endsWith('/api/desktop/upload'));

// `queueToo`: as main after a sign-in (afterSessionApplied), the queue as well: a
// recording queued before the change is uploaded by it, not by the recovery.
export async function resume(entry, r) {
  if (entry.resumes || entry.queueToo) await r.background.startQueue(r.scopes);
  if (entry.recovery) await r.background.startRecovery(r.scopes, 'sign-in');
  await quiet(entry, r);
}

/**
 * One point N: change, resumption by owner A, restart. Returns the problems;
 * null: the point does not exist. `entry.verify({ r, restarted })` (real media)
 * judges the result on the disk, after `damage(r)` (a mutant) if given.
 */
export async function dataRun(entry, n, { damage = null } = {}) {
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
    restarted = createBackgroundRig({ session: 'persisted', disk: r.disk, root: r.root, recordings: [], history, queue, active, realRead: !!entry.recovery, media: entry.opts?.media });
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
      if (!head.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) fail('no WebM after the resumption');
      // Recovery queues the finalized recording; a receipt only with an accepted upload.
      if (fs.existsSync(path.join(r.root, entry.playable, 'upload-receipt.json')) && acceptedBefore + again + late === 0) fail('a receipt without an upload');
    }
    if (damage) damage(r);
    if (entry.verify) for (const problem of await entry.verify(r, restarted)) fail(problem);
    return problems;
  } catch (error) {
    fail(`threw ${error?.stack || error}`);
    return problems;
  } finally {
    await (restarted || r).cleanup();
    if (restarted) await r.cleanup().catch(() => {});
  }
}
