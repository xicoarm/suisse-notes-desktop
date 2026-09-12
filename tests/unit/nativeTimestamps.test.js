// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCodedScenario, verifyCodedAudio, analyzeCodedAudio } = require('../e2e-harness/lib/coded-audio');
const { measureTimestampHoles, finalPausesFromHoles, assessNativeClock, readAssemblyPlanGaps, comparePlanGaps } = require('../e2e-harness/lib/native-timestamps');
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path;
const workRoot = path.resolve('tests/e2e-harness/work');
let directory, scenario;

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout: 60000 });
}

// The hosted fake microphone's signature: the waveform stays consecutive while
// the clock jumps forward. Shifting the timestamps of every frame from atS on
// keeps all content and writes a real packet-timestamp hole into the WebM.
function pausedOriginal(name, atS, lengthS) {
  const output = path.join(directory, name + '.webm');
  ffmpeg(['-i', scenario.wavPath, '-af', `asetpts=PTS+gte(T\\,${atS})*${lengthS}/TB`, '-c:a', 'libopus', '-b:a', '64k', output]);
  return output;
}

// Real upstream loss: frames are dropped and the survivors keep their original
// timestamps, so the hole coincides with missing content.
function lossOriginal(name, fromS, toS) {
  const output = path.join(directory, name + '.webm');
  ffmpeg(['-i', scenario.wavPath, '-af', `aselect=not(between(t\\,${fromS}\\,${toS}))`, '-c:a', 'libopus', '-b:a', '64k', output]);
  return output;
}

// The production finalizer's timestamp policy: materialize forward holes as
// silence without gradual stretching (src-electron/native-source-finalization.js).
function materialized(input, name) {
  const output = path.join(directory, name + '.webm');
  ffmpeg(['-i', input, '-af', 'asettb=1/48000,asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0:min_hard_comp=0.002:max_soft_comp=0',
    '-c:a', 'libopus', '-b:a', '64k', output]);
  return output;
}

describe('native timestamp holes', () => {
  beforeAll(() => {
    fs.mkdirSync(workRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(workRoot, 'native-timestamps-'));
    scenario = buildCodedScenario('holes-reference', [{ type: 'speech', seconds: 12 }], { outputDir: directory });
  });
  afterAll(() => {
    const target = path.resolve(directory);
    if (path.dirname(target) !== workRoot || !path.basename(target).startsWith('native-timestamps-')) throw new Error('Unsafe cleanup path');
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('measures a packet timestamp hole and finds none in continuous output', async () => {
    const continuous = path.join(directory, 'continuous.webm');
    ffmpeg(['-i', scenario.wavPath, '-c:a', 'libopus', '-b:a', '64k', continuous]);
    const clean = await measureTimestampHoles(continuous);
    expect(clean.holes).toEqual([]);
    expect(clean.overlaps).toEqual([]);
    expect(clean.packetDurationS).toBe(0.02);
    expect(Math.abs(clean.ptsSpanS - 12)).toBeLessThan(0.05);
    expect(Math.abs(clean.codedDurationS - clean.ptsSpanS)).toBeLessThan(0.0011);

    const paused = await measureTimestampHoles(pausedOriginal('paused', 5.2, 0.3));
    expect(paused.holes).toHaveLength(1);
    expect(paused.overlaps).toEqual([]);
    expect(Math.abs(paused.holes[0].startS - 5.2)).toBeLessThan(0.05);
    expect(Math.abs(paused.holes[0].lengthS - 0.3)).toBeLessThan(0.03);
    expect(paused.totalHoleS).toBe(paused.holes[0].lengthS);
    expect(Math.abs(paused.codedDurationS - 12)).toBeLessThan(0.05);
    expect(Math.abs(paused.codedDurationS + paused.totalHoleS - paused.ptsSpanS)).toBeLessThan(0.0011);
    expect(finalPausesFromHoles(paused, 0.25)).toEqual([{ startS: Math.round((paused.holes[0].startS + 0.25) * 1e6) / 1e6, lengthS: paused.holes[0].lengthS }]);
    expect(() => finalPausesFromHoles(paused, -1)).toThrow();
  });

  it('accepts the materialized final only as content plus exactly the measured silent pause', async () => {
    const original = pausedOriginal('paused-final', 5.2, 0.3);
    const holes = await measureTimestampHoles(original);
    const final = materialized(original, 'materialized');
    const pauses = finalPausesFromHoles(holes);
    // The as-is original is continuous content: the hole is time, not audio.
    const asIs = await verifyCodedAudio(original, scenario);
    expect(asIs.problems).toEqual([]);
    expect(asIs.identifiedFrames).toBe(24);
    const strict = await verifyCodedAudio(final, scenario, { expectedDurationS: 12.3 });
    expect(strict.pass).toBe(false);
    expect(strict.problems.some(problem => /DUPLICATED FRAME 10|INTERIOR TIMING: frames 10|INCOMPLETE OR REPEATED FRAME 10/.test(problem))).toBe(true);
    const aware = await verifyCodedAudio(final, scenario, { expectedDurationS: 12.3, expectedPauses: pauses });
    expect(aware.problems).toEqual([]);
    expect(aware.identifiedFrames).toBe(24);
    expect(aware.pauses).toHaveLength(1);
    expect(aware.pauses[0].silent).toBe(true);
    expect(Math.abs(aware.contentDurationS - (aware.durationS - holes.totalHoleS))).toBeLessThan(1e-6);
    // Declaring the pause where the file has no silence is rejected.
    const misplaced = await verifyCodedAudio(final, scenario, { expectedDurationS: 12.3, expectedPauses: [{ startS: 2.0, lengthS: pauses[0].lengthS }] });
    expect(misplaced.pass).toBe(false);
    expect(misplaced.problems.some(problem => problem.startsWith('PAUSE NOT SILENT'))).toBe(true);
    // Content-time grouping is also available to callers comparing two analyses.
    const analysis = await analyzeCodedAudio(final, { pauses });
    expect(analysis.groups.map(group => group.id)).toEqual(Array.from({ length: 24 }, (_, id) => id));
  });

  it('still rejects content that was really removed, even with the hole declared', async () => {
    const lost = lossOriginal('lost', 5.2, 5.5);
    const holes = await measureTimestampHoles(lost);
    expect(holes.holes).toHaveLength(1);
    const asIs = await verifyCodedAudio(lost, scenario);
    expect(asIs.pass).toBe(false);
    expect(asIs.problems.some(problem => /INCOMPLETE OR REPEATED FRAME 10|INTERIOR TIMING: frames (9→10|10→11)/.test(problem))).toBe(true);
    const aware = await verifyCodedAudio(materialized(lost, 'lost-materialized'), scenario, { expectedDurationS: 12, expectedPauses: finalPausesFromHoles(holes) });
    expect(aware.pass).toBe(false);
    expect(aware.problems.some(problem => /INCOMPLETE OR REPEATED FRAME 10|INTERIOR TIMING/.test(problem))).toBe(true);
  });

  it('checks the recorder wall clock against the timestamp span', async () => {
    const holes = await measureTimestampHoles(pausedOriginal('paused-clock', 5.0, 1.0));
    expect(Math.abs(holes.totalHoleS - 1)).toBeLessThan(0.03);
    expect(assessNativeClock(holes, 13.03).problems).toEqual([]);
    const invented = assessNativeClock(holes, holes.codedDurationS);
    expect(invented.problems).toHaveLength(1);
    expect(invented.problems[0]).toMatch(/^NATIVE CLOCK: native timestamp span .* exceeds the recorder wall clock/);
    // A source that starts delivering late (the fake WAV load) shortens the
    // span below wall time; that is reported, and judged elsewhere.
    const late = assessNativeClock(holes, holes.ptsSpanS + 4.8);
    expect(late.problems).toEqual([]);
    expect(late.lateDeliveryS).toBeCloseTo(4.8, 3);
    expect(assessNativeClock(holes, null).problems).toEqual([]);
    const overlapping = assessNativeClock({ ...holes, overlaps: [{ startS: 1, lengthS: 0.02, packetIndex: 50 }], totalOverlapS: 0.02 }, 13);
    expect(overlapping.problems).toEqual(['NATIVE CLOCK: 1 overlapping native timestamp(s) totaling 0.020s']);
  });

  it('cross-checks the finalization plan gap accounting and selects the validated plan', async () => {
    const holes = await measureTimestampHoles(pausedOriginal('paused-plan', 5.2, 0.3));
    const recording = fs.mkdtempSync(path.join(directory, 'recording-'));
    const plan = (status, gapSamples, gapCount = 1) => JSON.stringify({ validation: { status },
      sourceEvidence: [{ sourceId: 'source-a', timing: { gapCount, gapSamples, overlapCount: 0 } }] });
    expect(readAssemblyPlanGaps(recording)).toMatchObject({ plan: null, candidatePlans: 0, validatedPlans: 0 });
    for (const [name, content] of [['native-finalization-failed', plan('failed', 0, 0)], ['native-finalization-good', plan('passed', Math.round(holes.totalHoleS * 48000))]]) {
      fs.mkdirSync(path.join(recording, name));
      fs.writeFileSync(path.join(recording, name, 'plan.json'), content);
    }
    const selected = readAssemblyPlanGaps(recording);
    expect(selected.planPath).toBe(path.join(recording, 'native-finalization-good', 'plan.json'));
    expect(selected).toMatchObject({ candidatePlans: 2, validatedPlans: 1 });
    expect(comparePlanGaps(selected, 'source-a', holes).problems).toEqual([]);
    expect(comparePlanGaps(selected, 'source-b', holes).problems).toEqual(['NATIVE CLOCK: no validated finalization plan evidence for source source-b']);
    const disagreeing = { planPath: selected.planPath, plan: JSON.parse(plan('passed', 480, 2)) };
    expect(comparePlanGaps(disagreeing, 'source-a', holes).problems[0]).toMatch(/^NATIVE CLOCK: finalization plan recorded 2 gap\(s\) \/ 0\.010s/);
  }, 60000);
});
