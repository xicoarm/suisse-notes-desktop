/**
 * Forensic verifier — turns the pilot-pulse oracle into automated PASS/FAIL.
 *
 * Decodes ANY audio the app produced (webm/opus, wav, m4a) to raw PCM and:
 *  1. Finds every pilot pulse via Goertzel detection in 100 ms windows.
 *  2. Checks pulse count + spacing against the scenario timeline: a missing
 *     pulse = audio GAP, an extra/mis-spaced pulse = DUPLICATED audio, a
 *     shifted tail = desync, short file = TRUNCATION.
 *  3. Profiles RMS per second and validates each scenario segment's level
 *     (speech ≈ full level, quiet ≈ -30 dB, zeros ≈ digital silence).
 *
 * This is the same methodology used to crack the Angela incident and the
 * doubled-audio incident — codified as a repeatable oracle.
 */
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { FFMPEG } = require('./audio');

const SR = 16000;              // analysis rate — pulses at 7 kHz survive (Nyquist 8k)
const WIN_S = 0.1;             // 100 ms analysis windows
const PULSE_DETECT_DB = -35;   // pulse band energy above this = pulse present

/** Decode any audio file to mono float32 PCM at SR. */
function decodeToPcm(inputPath) {
  const buf = execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-ac', '1', '-ar', String(SR),
    '-f', 'f32le', '-',
  ], { maxBuffer: 1024 * 1024 * 1024 * 4 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

/** Goertzel power of `freq` in samples[start..start+len). */
function goertzel(samples, start, len, freq, sampleRate) {
  const k = Math.round((len * freq) / sampleRate);
  const w = (2 * Math.PI * k) / len;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    s0 = (samples[start + i] || 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power / (len * len / 4); // normalized ≈ amplitude^2 of that tone
}

function db(x) {
  return x > 0 ? 10 * Math.log10(x) : -Infinity;
}

/**
 * Analyze a produced file.
 * @param {string} filePath - the app's output audio
 * @param {object} scenarioMeta - the JSON written by buildScenario
 * @returns analysis { durationS, pulses: [t...], rmsPerSecondDb, segments: [...] }
 */
function analyze(filePath, scenarioMeta) {
  const pcm = decodeToPcm(filePath);
  const durationS = pcm.length / SR;
  const win = Math.round(WIN_S * SR);
  const freq = scenarioMeta.pilot.freq;

  // Pulse detection: per-window pilot-band energy, grouped into bursts.
  const pulses = [];
  let inPulse = false;
  for (let w0 = 0; w0 + win <= pcm.length; w0 += win) {
    const p = db(goertzel(pcm, w0, win, freq, SR));
    if (p > PULSE_DETECT_DB) {
      if (!inPulse) {
        pulses.push(w0 / SR);
        inPulse = true;
      }
    } else {
      inPulse = false;
    }
  }

  // RMS per second in dBFS (10*log10 of mean square == 20*log10 of RMS)
  const rms = [];
  for (let s0 = 0; s0 + SR <= pcm.length; s0 += SR) {
    let sum = 0;
    for (let i = 0; i < SR; i++) sum += pcm[s0 + i] * pcm[s0 + i];
    rms.push(10 * Math.log10(sum / SR || 1e-12));
  }

  return { durationS, pulses, rmsPerSecondDb: rms };
}

/**
 * Verdict: compare analysis against the scenario ground truth.
 * `expectations` allows scenario-specific tolerances:
 *   - startOffsetS: capture may begin mid-file (fake capture starts at file
 *     position 0 with the recording, so default 0)
 *   - tailLossMaxS: acceptable audio loss at the very end (crash tests)
 */
function verdict(filePath, scenarioMeta, expectations = {}) {
  const a = analyze(filePath, scenarioMeta);
  const problems = [];
  const notes = [];
  const period = scenarioMeta.pilot.periodS;
  const tailLossMaxS = expectations.tailLossMaxS ?? 5;

  // 1. Duration: file must cover the scenario minus acceptable tail loss.
  const expectedS = Math.min(scenarioMeta.totalSeconds, expectations.expectedDurationS ?? scenarioMeta.totalSeconds);
  if (a.durationS < expectedS - tailLossMaxS) {
    problems.push(`TRUNCATED: file is ${a.durationS.toFixed(1)}s, expected ≥ ${(expectedS - tailLossMaxS).toFixed(1)}s`);
  }
  if (a.durationS > expectedS + 15) {
    problems.push(`TOO LONG: file is ${a.durationS.toFixed(1)}s, expected ≈ ${expectedS.toFixed(1)}s (duplicated audio?)`);
  }

  // 2. Expected pulse times (pulses are muted inside zero windows).
  const zeroWindows = scenarioMeta.timeline.filter(s => s.type === 'zeros').map(s => [s.start, s.end]);
  const inZero = (t) => zeroWindows.some(([s, e]) => t >= s - 0.5 && t < e + 0.5);
  const expectedPulses = [];
  for (let t = 0; t < expectedS - 1; t += period) {
    if (!inZero(t)) expectedPulses.push(t);
  }

  // Match each expected pulse to a detected one within ±1.5s.
  const unmatched = [];
  const usedIdx = new Set();
  for (const et of expectedPulses) {
    if (et > a.durationS - 0.5) continue; // beyond captured audio (tail loss)
    let best = -1, bestDiff = Infinity;
    a.pulses.forEach((pt, i) => {
      const d = Math.abs(pt - et);
      if (!usedIdx.has(i) && d < bestDiff) { best = i; bestDiff = d; }
    });
    if (best >= 0 && bestDiff <= 1.5) {
      usedIdx.add(best);
    } else {
      unmatched.push(et);
    }
  }
  if (unmatched.length > 0) {
    problems.push(`AUDIO GAPS: ${unmatched.length} pilot pulse(s) missing at t≈[${unmatched.slice(0, 10).map(t => t.toFixed(0)).join(', ')}]s`);
  }
  const extras = a.pulses.filter((_, i) => !usedIdx.has(i));
  // Extra pulses within zero windows or beyond scenario = duplication/desync.
  const realExtras = extras.filter(t => t < expectedS + 2);
  if (realExtras.length > 0) {
    problems.push(`UNEXPECTED PULSES (duplication/desync?): ${realExtras.length} at t≈[${realExtras.slice(0, 10).map(t => t.toFixed(0)).join(', ')}]s`);
  }

  // 3. Segment level profile.
  for (const seg of scenarioMeta.timeline) {
    const s = Math.ceil(seg.start) + 1;
    const e = Math.min(Math.floor(seg.end) - 1, Math.floor(a.durationS) - 1);
    if (e - s < 3) continue; // segment too short (or beyond capture) to judge
    const vals = a.rmsPerSecondDb.slice(s, e);
    if (!vals.length) continue;
    const sorted = [...vals].sort((x, y) => x - y);
    const p90 = sorted[Math.min(sorted.length - 1, Math.round(0.9 * (sorted.length - 1)))];
    switch (seg.type) {
      case 'speech':
        if (p90 < -45) problems.push(`SEGMENT LEVEL: speech segment @${seg.start}s captured at P90 ${p90.toFixed(1)} dBFS (expected > -45)`);
        break;
      case 'zeros':
        if (p90 > -70) problems.push(`SEGMENT LEVEL: zeros segment @${seg.start}s shows P90 ${p90.toFixed(1)} dBFS (expected < -70 — silence not silent?)`);
        break;
      case 'quiet':
        if (p90 > -30) problems.push(`SEGMENT LEVEL: quiet segment @${seg.start}s too loud (P90 ${p90.toFixed(1)} dBFS)`);
        if (p90 < -75) problems.push(`SEGMENT LEVEL: quiet segment @${seg.start}s missing entirely (P90 ${p90.toFixed(1)} dBFS)`);
        break;
      default:
        break;
    }
  }

  notes.push(`duration=${a.durationS.toFixed(1)}s pulses=${a.pulses.length}/${expectedPulses.length}`);
  return { pass: problems.length === 0, problems, notes, analysis: a };
}

module.exports = { analyze, verdict, decodeToPcm };
