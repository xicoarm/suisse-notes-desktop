// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { sweptRun, sweepEntry } from './support/sweep.js';
import { CHAIN, chainEntry as entry, makeNativeTemplate, removeNativeTemplate } from './support/chainEntries.js';

// Review round 10 (F1-F4): the sweep over main's REAL recovery chain.
// finalizeForRecovery is main's own port (support/mainSlice.js), running
// finalizeRecording with recording-persistence, durable-files, the merge of
// system audio, native-source-finalization and encoded-opus-evidence -
// unchanged. Files, child processes and renderer events are counted at the
// module boundaries (support/globalSinks.js), FileHandle writes included;
// ffmpeg/ffprobe are a stub process there, or the bundled test binaries for
// the native recording (real Opus media). F1-F3 of review round 9 are named
// cases of their own (each failed at 1f4d97d, docs/security/pr50-r10-failfirst.txt).

const sep = path.sep;
beforeAll(makeNativeTemplate, 60000);
afterAll(removeNativeTemplate);

/** The change at a named point (label, target path or arguments). */
const at = (label, test) => (l, target) => l === label && !!target && test(String(target));

describe('F1-F3 of review round 9: named points of the real recovery chain', () => {
  const cases = [
    ['F1 durable-files: sign-out during readdir(chunks), before mkdir(source-chunks)', 'recovery, real chain (WebM)',
      at('fs.readdir', (t) => t.endsWith(`${sep}chunks`))],
    ['F1 recording-persistence: sign-out while the session is published, before unlink(source_raw)', 'recovery, real chain (WebM)',
      at('fs.rename', (t) => t.endsWith('source_final.webm'))],
    ['F1 recording-persistence: sign-out during archiveChunkBatch, before mkdir(sessions)', 'recovery, real chain (WebM)',
      at('fs.mkdir', (t) => t.endsWith(`${sep}chunks`))],
    ['F2 merge: sign-out while the merged file is published, before system:capture-warning', 'recovery, real chain with the system audio merge',
      at('handle.sync', (t) => t.endsWith('_merged.webm'))],
    ['F3 encoded-opus-evidence: sign-out during the first ffprobe, before the second', 'recovery, native sources (real media)',
      at('spawn:ffprobe', (t) => t.includes('-show_data') && t.includes('-show_streams'))],
    ['F3 encoded-opus-evidence: sign-out while the output is read (captureContent), before any ffprobe', 'recovery, native sources (real media)',
      at('fs.read', (t) => /native-finalization-[^/\\]+[/\\](fast-)?rendered\.webm$/.test(t))],
  ];
  for (const [title, name, point] of cases) {
    it(title, async () => {
      const violations = [];
      for (const variant of ['A', 'B']) violations.push(...await sweptRun(entry(name), point, variant));
      // eslint-disable-next-line no-console
      if (violations.length) console.log(`[sweep:chain] ${title}\n  ${violations.join('\n  ')}`);
      expect(violations).toEqual([]);
    }, 120000);
  }
});

const totals = { runs: 0, points: {} };

describe('sweep N=1..max over the real recovery chain (variants A, B, refresh control)', () => {
  for (const e of CHAIN) {
    it(e.name, async () => {
      const { base, violations, runs } = await sweepEntry(e);
      totals.points[e.name] = base.max;
      totals.runs += runs;
      // eslint-disable-next-line no-console
      if (violations.length) console.log(`[sweep:chain] ${e.name}: ${violations.length} violations\n  ${violations.slice(0, 12).join('\n  ')}`);
      expect(base.max, `${e.name}: points`).toBeGreaterThanOrEqual(e.min);
      // The baseline runs through and publishes the recording.
      expect(base.result, `${e.name}: baseline`).toEqual({ completed: true });
      expect(base.shape.effects.some((x) => /^rename:(c1|n1)\/audio\.webm$/.test(x)), `${e.name}: baseline published`).toBe(true);
      expect(violations).toEqual([]);
    }, 600000);
  }

  it('totals (for the round-10 report)', () => {
    // eslint-disable-next-line no-console
    console.log(`[sweep:chain] runs=${totals.runs} points=${JSON.stringify(totals.points)}`);
    expect(Object.keys(totals.points)).toHaveLength(CHAIN.length);
  });
});
