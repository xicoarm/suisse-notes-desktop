/**
 * Independent native-source timestamp evidence for synthetic qualification.
 *
 * Chromium's hosted fake microphone skips late 10 ms buffers instead of
 * replaying them: FakeAudioWorker advances its scheduled read time while
 * FileSource advances the WAV cursor only for callbacks that actually run.
 * The MediaRecorder original therefore contains consecutive file content with
 * forward packet-timestamp holes, and the finalizer correctly materializes
 * those holes as silence (a real device's clock never pauses, so a hole from
 * real hardware is lost audio). These helpers measure the holes from the
 * original's packet timestamps, independently of the finalization plan, so
 * the final output can be checked as native content plus exactly those
 * silent pauses while the native original keeps its unchanged as-is oracle.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const FFPROBE = require('@ffprobe-installer/ffprobe').path;

// Same threshold as src-electron/native-source-finalization.js (min_hard_comp).
const MIN_HOLE_SECONDS = 0.002;
// Recorder start/stop events and the first/last packet differ by tens of
// milliseconds; half a second still exposes holes the recorder invented while
// audio kept flowing (then wall time equals decoded time, not the PTS span).
const CLOCK_TOLERANCE_SECONDS = 0.5;
const SAMPLE_RATE = 48000;

const round = value => Math.round(value * 1e6) / 1e6;

async function measureTimestampHoles(filePath, options = {}) {
  const minHoleS = options.minHoleS ?? MIN_HOLE_SECONDS;
  if (!Number.isFinite(minHoleS) || minHoleS <= 0) throw new Error('minHoleS must be a positive number of seconds');
  if (typeof filePath !== 'string' || !fs.statSync(filePath).isFile()) throw new Error('Timestamp measurement needs an existing file');
  const child = spawn(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=pts_time,duration_time',
    '-of', 'csv=p=0', filePath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('ffprobe packet listing failed: ' + stderr)));
  });
  closed.catch(() => {});
  const result = { file: filePath, packets: 0, firstPtsS: null, lastEndPtsS: null, ptsSpanS: null, codedDurationS: 0,
    packetDurationS: null, unknownDurations: 0, minHoleS, holes: [], overlaps: [], totalHoleS: 0, totalOverlapS: 0 };
  const durations = new Map();
  let previousEndS = null;
  try {
    for await (const line of readline.createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const [ptsText, durationText] = line.split(',');
      const ptsS = Number(ptsText);
      if (!Number.isFinite(ptsS)) throw new Error('ffprobe packet without a timestamp: ' + line);
      let durationS = Number(durationText);
      if (Number.isFinite(durationS) && durationS > 0) {
        durations.set(durationS, (durations.get(durationS) || 0) + 1);
        if (result.packetDurationS === null || durations.get(durationS) > durations.get(result.packetDurationS)) result.packetDurationS = durationS;
      } else {
        // Matroska SimpleBlocks normally carry a duration; fall back to the
        // dominant packet duration only for isolated unknown entries.
        result.unknownDurations++;
        if (result.packetDurationS === null) throw new Error('First audio packet has no duration: ' + line);
        durationS = result.packetDurationS;
      }
      if (result.firstPtsS === null) result.firstPtsS = ptsS;
      if (previousEndS !== null) {
        const deltaS = ptsS - previousEndS;
        if (deltaS > minHoleS) result.holes.push({ startS: round(previousEndS - result.firstPtsS), lengthS: round(deltaS), packetIndex: result.packets });
        else if (deltaS < -minHoleS) result.overlaps.push({ startS: round(previousEndS - result.firstPtsS), lengthS: round(-deltaS), packetIndex: result.packets });
      }
      previousEndS = ptsS + durationS;
      result.codedDurationS += durationS;
      result.packets++;
    }
    await closed;
  } catch (error) {
    child.kill();
    throw error;
  }
  if (!result.packets) throw new Error('No audio packets found in ' + filePath);
  result.firstPtsS = round(result.firstPtsS);
  result.lastEndPtsS = round(previousEndS);
  result.ptsSpanS = round(result.lastEndPtsS - result.firstPtsS);
  result.codedDurationS = round(result.codedDurationS);
  result.totalHoleS = round(result.holes.reduce((total, hole) => total + hole.lengthS, 0));
  result.totalOverlapS = round(result.overlaps.reduce((total, overlap) => total + overlap.lengthS, 0));
  return result;
}

/**
 * Positions of the measured holes on the finalized timeline. Finalization
 * applies asetpts=PTS-STARTPTS and then delays the lane by its start offset,
 * so a hole keeps its position relative to the first packet.
 */
function finalPausesFromHoles(measurement, startOffsetS = 0) {
  if (!Number.isFinite(startOffsetS) || startOffsetS < 0) throw new Error('Lane start offset must be a non-negative number of seconds');
  return (measurement?.holes || []).map(hole => ({ startS: round(hole.startS + startOffsetS), lengthS: hole.lengthS }));
}

/**
 * The recorder's start-event to stop-event interval must agree with the
 * native timestamp span. If the recorder had invented holes while audio
 * flowed, wall time would equal the decoded duration instead.
 */
function assessNativeClock(measurement, recorderWallS, toleranceS = CLOCK_TOLERANCE_SECONDS) {
  const problems = [];
  if (!measurement || !Number.isFinite(measurement.ptsSpanS)) throw new Error('Native clock assessment needs a timestamp measurement');
  if (measurement.overlaps.length) {
    problems.push(`NATIVE CLOCK: ${measurement.overlaps.length} overlapping native timestamp(s) totaling ${measurement.totalOverlapS.toFixed(3)}s`);
  }
  const residualS = Number.isFinite(recorderWallS) ? round(measurement.ptsSpanS - recorderWallS) : null;
  if (residualS !== null && Math.abs(residualS) > toleranceS) {
    problems.push(`NATIVE CLOCK: native timestamp span ${measurement.ptsSpanS.toFixed(3)}s differs from the recorder wall clock ${recorderWallS.toFixed(3)}s by ${residualS.toFixed(3)}s (tolerance ${toleranceS}s); ${measurement.holes.length} hole(s) total ${measurement.totalHoleS.toFixed(3)}s`);
  }
  return { recorderWallS: Number.isFinite(recorderWallS) ? recorderWallS : null, ptsSpanS: measurement.ptsSpanS,
    codedDurationS: measurement.codedDurationS, holeCount: measurement.holes.length, totalHoleS: measurement.totalHoleS,
    overlapCount: measurement.overlaps.length, residualS, toleranceS, problems };
}

/** The finalization plan that produced the published output, if exactly one validated plan exists. */
function readAssemblyPlanGaps(recordingDir) {
  const candidates = fs.readdirSync(recordingDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('native-finalization-'))
    .map(entry => path.join(recordingDir, entry.name, 'plan.json')).filter(file => fs.existsSync(file));
  const plans = candidates.map(planPath => ({ planPath, plan: JSON.parse(fs.readFileSync(planPath, 'utf8')) }))
    .filter(entry => entry.plan?.validation?.status === 'passed');
  if (plans.length !== 1) return { planPath: null, plan: null, candidatePlans: candidates.length, validatedPlans: plans.length };
  return { ...plans[0], candidatePlans: candidates.length, validatedPlans: 1 };
}

/** The plan's own gap accounting (FFmpeg ashowinfo) must agree with the packet measurement. */
function comparePlanGaps(planInfo, sourceId, measurement) {
  const problems = [];
  const evidence = planInfo?.plan?.sourceEvidence?.find(source => source.sourceId === sourceId);
  if (!evidence?.timing) {
    problems.push(`NATIVE CLOCK: no validated finalization plan evidence for source ${sourceId}`);
    return { planPath: planInfo?.planPath || null, sourceId, planGapCount: null, planGapS: null, measuredGapCount: measurement.holes.length, measuredGapS: measurement.totalHoleS, problems };
  }
  const planGapCount = evidence.timing.gapCount, planGapS = round((evidence.timing.gapSamples || 0) / SAMPLE_RATE);
  const planOverlapCount = evidence.timing.overlapCount || 0;
  if (planGapCount !== measurement.holes.length || Math.abs(planGapS - measurement.totalHoleS) > 0.0011 || planOverlapCount !== measurement.overlaps.length) {
    problems.push(`NATIVE CLOCK: finalization plan recorded ${planGapCount} gap(s) / ${planGapS.toFixed(3)}s and ${planOverlapCount} overlap(s) for ${sourceId}, but its packets show ${measurement.holes.length} hole(s) / ${measurement.totalHoleS.toFixed(3)}s and ${measurement.overlaps.length} overlap(s)`);
  }
  return { planPath: planInfo.planPath, sourceId, planGapCount, planGapS, planOverlapCount,
    measuredGapCount: measurement.holes.length, measuredGapS: measurement.totalHoleS, problems };
}

module.exports = { measureTimestampHoles, finalPausesFromHoles, assessNativeClock, readAssemblyPlanGaps, comparePlanGaps,
  MIN_HOLE_SECONDS, CLOCK_TOLERANCE_SECONDS };
