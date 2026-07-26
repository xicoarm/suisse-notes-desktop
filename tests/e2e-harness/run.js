/**
 * E2E harness runner - real app, real audio, scripted adversity.
 *
 *   node tests/e2e-harness/run.js <scenario> [--keep]
 *
 * Scenarios:
 *   selftest          Generate ground truth + verify the verifier (no app)
 *   s1-baseline       4-min realistic meeting -> record -> stop -> upload -> verify
 *   s2-angela-bt      Angela replay: speech -> digital zeros -> -30dB speech ->
 *                     speech. Asserts the MSIG health UI reacts (badge +
 *                     precise message) and the output file matches ground truth
 *   s3-autosplit      Compressed long-meeting: auto-split every 3 min over an
 *                     8-min meeting -> split logic + session combining
 *   s4-storm          Terminal-400 backend: upload attempts must be BOUNDED
 *                     and stop (ELECTRON-27 regression)
 *   s5-resilience     Transient 500 / 401-expiry / socket-cut - upload must
 *                     survive all three and never lose the file
 *   s6-crash          Renderer crash mid-recording -> relaunch -> recovery
 *
 * Everything runs in an isolated userData profile against a local mock
 * backend. No production system is touched.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildScenario, WORK_DIR } = require('./lib/audio');
const { verdict } = require('./lib/verify');
const { startMockBackend } = require('./lib/mock-backend');
const { AppDriver, sleep } = require('./lib/app-driver');

const KEEP = process.argv.includes('--keep');

// Problem strings that indicate a PRODUCT defect (not a harness/timeout issue).
// When a verdict raises one of these, it is a real app-bug candidate and gets
// persisted to work/app-defects.json for promotion into FINDINGS.md.
const DEFECT_SIGNATURES = [
  /AUDIO GAP/i, /duplicat/i, /TRUNCAT/i, /TOO LONG/i, /SEGMENT LEVEL/i,
  /RETRY STORM/i, /data must be preserved/i, /Local file missing/i,
  /Recovery produced no/i, /never left "Healthy"/i, /FALSE ALARM/i,
  /Expected exactly 1 upload/i, /did not complete/i, /No output file/i,
];

function isDefect(problem) {
  return DEFECT_SIGNATURES.some(re => re.test(problem));
}

function recordDefects(name, result) {
  const defects = (result.problems || []).filter(isDefect);
  if (!defects.length) return;
  const file = path.join(WORK_DIR, 'app-defects.json');
  let all = [];
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first defect */ }
  for (const d of defects) {
    all.push({
      scenario: name,
      problem: d,
      notes: result.notes || [],
      evidence: `work/result_${name}.json`,
      capturedAt: new Date().toISOString(),
    });
  }
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  console.log(`\n  *** ${defects.length} APP-DEFECT candidate(s) recorded to work/app-defects.json ***`);
  console.log('  *** Review and promote to tests/e2e-harness/FINDINGS.md ***');
}

function report(name, result) {
  const line = '='.repeat(70);
  console.log(`\n${line}\n${result.pass ? 'PASS' : 'FAIL'}  ${name}\n${line}`);
  for (const n of result.notes || []) console.log(`  note: ${n}`);
  for (const p of result.problems || []) console.log(`  ${isDefect(p) ? 'APP-DEFECT' : 'PROBLEM'}: ${p}`);
  const outPath = path.join(WORK_DIR, `result_${name}.json`);
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  recordDefects(name, result);
  console.log(`  full result: ${outPath}`);
  return result.pass;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function selftest() {
  // Ground truth must verify against itself: every pulse found, levels right.
  const sc = buildScenario('selftest', [
    { type: 'speech', seconds: 40 },
    { type: 'zeros', seconds: 25 },
    { type: 'quiet', seconds: 40 },
    { type: 'speech', seconds: 20 },
  ]);
  const v = verdict(sc.wavPath, sc, { tailLossMaxS: 1 });
  return report('selftest', v);
}

async function withApp(name, scenario, opts, fn) {
  const mock = await startMockBackend({ port: opts.mockPort || 3000 });
  const app = new AppDriver({
    name,
    apiUrl: mock.url,
    fakeAudioWav: scenario?.wavPath,
    cdpPort: opts.cdpPort || 9339,
    env: opts.env || {},
  });
  try {
    await app.launch({ freshProfile: opts.freshProfile !== false });
    await app.login();
    const result = await fn(app, mock);
    return report(name, result);
  } finally {
    await app.close({ keepProfile: true });
    await mock.close();
    if (!KEEP) { /* profiles kept for post-mortem either way; user can clean work/ */ }
  }
}

async function s1Baseline() {
  const sc = buildScenario('s1', [{ type: 'speech', seconds: 240 }]);
  return withApp('s1-baseline', sc, {}, async (app, mock) => {
    await app.startRecording();
    await sleep(235_000);
    await app.stopRecording();
    await app.waitForPhase(['uploaded', 'idle'], 180_000);

    const out = app.findOutputFile();
    if (!out) return { pass: false, problems: ['No output file produced'] };
    const v = verdict(out, sc, { tailLossMaxS: 8 });
    const uploads = mock.state.requests.filter(r => r.url === '/api/desktop/upload');
    v.notes.push(`upload attempts: ${uploads.length}`);
    if (uploads.length !== 1) v.problems.push(`Expected exactly 1 upload attempt, saw ${uploads.length}`);
    v.pass = v.problems.length === 0;
    return v;
  });
}

async function s2AngelaBt() {
  // The Angela replay: healthy -> dead device (zeros) -> whisper-quiet -> healthy.
  const sc = buildScenario('s2', [
    { type: 'speech', seconds: 120 },
    { type: 'zeros', seconds: 90 },
    { type: 'quiet', seconds: 120 },
    { type: 'speech', seconds: 60 },
  ]);
  return withApp('s2-angela-bt', sc, {}, async (app, mock) => {
    const problems = [];
    const notes = [];
    const healthLog = [];

    await app.startRecording();

    // Sample the health UI every 5s for the whole scenario.
    const totalMs = sc.totalSeconds * 1000;
    const t0 = Date.now();
    while (Date.now() - t0 < totalMs - 5000) {
      await sleep(5000);
      const h = await app.getMicHealthUi();
      healthLog.push({ t: Math.round((Date.now() - t0) / 1000), ...h });
    }

    await app.stopRecording();
    await app.waitForPhase(['uploaded', 'idle'], 240_000);

    // 1. During the zeros window (120-210s) the health UI must escalate with
    //    the zero-signal wording within ~35s of the zeros starting (15s
    //    detection + re-acquire + verification, plus sampling slack).
    const zeroWarn = healthLog.find(h => h.t >= 120 && h.t <= 160 &&
      h.badge && !/healthy|in ordnung|checking|wird gepr/i.test(h.badge));
    if (!zeroWarn) {
      problems.push('Health UI never left "Healthy" during the dead-device (zeros) window');
    } else {
      notes.push(`zero-signal escalation seen at t=${zeroWarn.t}s: [${zeroWarn.badge}] ${String(zeroWarn.message).slice(0, 80)}`);
    }
    // 2. During healthy speech (first 100s) it must NOT warn (no false alarm).
    const falseAlarm = healthLog.find(h => h.t > 30 && h.t < 110 &&
      h.badge && !/healthy|in ordnung/i.test(h.badge));
    if (falseAlarm) problems.push(`FALSE ALARM at t=${falseAlarm.t}s during healthy speech: [${falseAlarm.badge}]`);
    // 3. The quiet window (210-330s) should surface the low-level hint
    //    (degraded badge) at some point - informational, so only WARN if absent.
    const lowLevel = healthLog.find(h => h.t >= 260 && h.t <= 330 &&
      h.badge && /unstable|instabil/i.test(h.badge));
    notes.push(lowLevel
      ? `low-level hint seen at t=${lowLevel.t}s`
      : 'low-level hint NOT observed in quiet window (tolerated - conservative detector)');

    // 4. File forensics: the CAPTURE must be lossless (holes) and correctly
    //    durated. NOTE: segment-LEVEL assertions are suppressed for s2 — the
    //    MSIG re-acquire calls getUserMedia again and Chromium's fake-audio
    //    device does not preserve the scripted level timeline across the
    //    re-open (see FINDINGS.md H-001). The app records faithfully; it does
    //    not control the fake source level. Real quiet-input detection is
    //    covered by the recordingService.micSignal unit test.
    const out = app.findOutputFile();
    if (!out) {
      problems.push('No output file produced');
      return { pass: false, problems, notes, healthLog };
    }
    const v = verdict(out, sc, { tailLossMaxS: 8, ignoreSegmentLevels: true });
    problems.push(...v.problems);
    notes.push(...v.notes);
    return { pass: problems.length === 0, problems, notes, healthLog };
  });
}

async function s3Autosplit() {
  const sc = buildScenario('s3', [{ type: 'speech', seconds: 480 }]); // 8 min
  return withApp('s3-autosplit', sc, {
    env: {
      VITE_SUISSE_MAX_DURATION_SECONDS: '180', // auto-split every 3 min
    },
  }, async (app) => {
    await app.startRecording();
    await sleep(475_000);
    await app.stopRecording();
    await app.waitForPhase(['uploaded', 'idle'], 300_000);

    const out = app.findOutputFile();
    if (!out) return { pass: false, problems: ['No output file produced after auto-split session'] };
    // The final combined file must contain the ENTIRE 8 minutes - two split
    // boundaries crossed with zero audio loss.
    const v = verdict(out, sc, { tailLossMaxS: 10 });
    v.notes.push('crossed 2 auto-split boundaries (180s compressed threshold)');
    return v;
  });
}

async function s4Storm() {
  const sc = buildScenario('s4', [{ type: 'speech', seconds: 60 }]);
  return withApp('s4-storm', sc, {}, async (app, mock) => {
    mock.setMode('upload-400');
    await app.startRecording();
    await sleep(55_000);
    await app.stopRecording();

    // Give the app time to attempt, fail, and (correctly) STOP retrying.
    await sleep(180_000);

    const problems = [];
    const notes = [];
    const uploads = mock.state.requests.filter(r => r.url === '/api/desktop/upload');
    notes.push(`upload attempts against terminal 400: ${uploads.length} over 3 minutes`);
    // uploadWithRetry does not retry non-retryable errors; the renderer may
    // attempt once more via its own path. Anything > 4 attempts = a loop.
    if (uploads.length === 0) problems.push('Upload was never attempted');
    if (uploads.length > 4) problems.push(`RETRY STORM: ${uploads.length} attempts against a terminal 400 (must stop after classification)`);
    // The file must still exist locally (terminal failure must NOT delete audio).
    const out = app.findOutputFile();
    if (!out) problems.push('Local file missing after terminal upload failure - data must be preserved');
    return { pass: problems.length === 0, problems, notes };
  });
}

async function s5Resilience() {
  const sc = buildScenario('s5', [{ type: 'speech', seconds: 60 }]);
  const runs = [
    ['upload-500-once', 'transient 500 then success'],
    ['upload-401-once', 'expired token then refresh+success'],
    ['upload-cut-50', 'socket cut mid-body then success'],
  ];
  const problems = [];
  const notes = [];
  for (const [mode, label] of runs) {
    const ok = await withApp(`s5-${mode}`, sc, { mockPort: 3000, cdpPort: 9339 }, async (app, mock) => {
      mock.setMode(mode);
      await app.startRecording();
      await sleep(55_000);
      await app.stopRecording();
      try {
        await app.waitForPhase(['uploaded', 'idle'], 240_000);
      } catch (e) {
        return { pass: false, problems: [`${label}: upload did not complete (${e.message})`], notes: [] };
      }
      const uploads = mock.state.requests.filter(r => r.url === '/api/desktop/upload');
      return {
        pass: uploads.length >= 2,
        problems: uploads.length >= 2 ? [] : [`${label}: expected retry (â‰¥2 attempts), saw ${uploads.length}`],
        notes: [`${label}: ${uploads.length} attempts, final success`],
      };
    });
    if (!ok) problems.push(`${label} FAILED`);
    else notes.push(`${label} OK`);
  }
  return report('s5-resilience-summary', { pass: problems.length === 0, problems, notes });
}

async function s6Crash() {
  const sc = buildScenario('s6', [{ type: 'speech', seconds: 180 }]);
  const mock = await startMockBackend({ port: 3000 });
  const app = new AppDriver({ name: 's6-crash', apiUrl: mock.url, fakeAudioWav: sc.wavPath, cdpPort: 9339 });
  try {
    await app.launch();
    await app.login();
    await app.startRecording();
    await sleep(90_000);           // 90s of audio captured
    await app.crashRenderer();     // the meeting "dies"
    await sleep(5_000);
    await app.close({ keepProfile: true });

    // Relaunch on the SAME profile - recovery must find and combine the chunks.
    const app2 = new AppDriver({ name: 's6-crash', apiUrl: mock.url, cdpPort: 9341, userDataDir: app.userDataDir });
    await app2.launch({ freshProfile: false });
    await app2.login();
    await sleep(30_000);           // recovery runs ~5s after launch + combine time

    const out = app2.findOutputFile();
    const problems = [];
    const notes = [];
    if (!out) {
      problems.push('Recovery produced no combined file after renderer crash');
    } else {
      // 90s captured minus in-flight timeslice (~3s) + crash slack.
      const truncated = { ...sc, totalSeconds: 90 };
      const v = verdict(out, truncated, { tailLossMaxS: 10, expectedDurationS: 90 });
      problems.push(...v.problems);
      notes.push(...v.notes, 'recovered after Page.crash at t=90s');
    }
    await app2.close({ keepProfile: true });
    return report('s6-crash', { pass: problems.length === 0, problems, notes });
  } finally {
    await app.close({ keepProfile: true }).catch(() => {});
    await mock.close();
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function s7Endurance() {
  // A realistic 5h15m workshop: four ~70-min talk blocks separated by three
  // ~13-min breaks (faint room tone). Crosses the REAL 4h55m auto-split
  // threshold during block 4, then runs ~20 min more so the post-split second
  // session and the multi-session combine are exercised. The breaks also test
  // the no-false-alarm requirement: faint steady noise must NOT trigger the
  // zero-signal or low-level health detectors.
  const plan = [
    { type: 'speech', seconds: 4200 }, { type: 'noise', seconds: 700 },
    { type: 'speech', seconds: 4200 }, { type: 'noise', seconds: 700 },
    { type: 'speech', seconds: 4200 }, { type: 'noise', seconds: 700 },
    { type: 'speech', seconds: 4200 },
  ]; // total 18900s = 5h15m
  console.log('s7: building 5h15m scenario audio (tiling cached speech pool)...');
  const sc = buildScenario('s7', plan);

  return withApp('s7-endurance', sc, {}, async (app, mock) => {
    const problems = [];
    const notes = [];
    const healthLog = [];
    const progressFile = path.join(WORK_DIR, 's7-progress.jsonl');
    fs.writeFileSync(progressFile, '');

    await app.startRecording();
    const t0 = Date.now();
    const totalMs = sc.totalSeconds * 1000;
    // Sample health + phase every 30s to disk (crash-proof evidence).
    let falseAlarmBreak = null;
    let splitObserved = false;
    let deadAtSec = null;
    while (Date.now() - t0 < totalMs - 5000) {
      await sleep(30_000);
      const tSec = Math.round((Date.now() - t0) / 1000);
      // Fail FAST if the app died (H-003): otherwise a frozen renderer makes the
      // health calls block for hours. If unresponsive, record when and abort.
      if (!(await app.isAppAlive())) {
        deadAtSec = tSec;
        fs.appendFileSync(progressFile, JSON.stringify({ t: tSec, dead: true }) + '\n');
        break;
      }
      let h = {}; let phase = null;
      try { h = await app.getMicHealthUi(); } catch (e) { /* keep going */ }
      try { phase = await app.getPhase(); } catch (e) { /* keep going */ }
      const rec = { t: tSec, phase, badge: h.badge, msg: (h.message || '').slice(0, 60) };
      healthLog.push(rec);
      fs.appendFileSync(progressFile, JSON.stringify(rec) + '\n');
      // Break windows (noise): must NOT show a critical/unstable badge.
      const inBreak = [[4200, 4900], [9100, 9800], [14000, 14700]].some(([s, e]) => tSec >= s + 30 && tSec < e - 30);
      if (inBreak && rec.badge && !/healthy|in ordnung/i.test(rec.badge)) falseAlarmBreak = rec;
    }

    // If the app died mid-run, report it clearly and stop (don't try to drive
    // a dead app). The recovered chunks (if any) are checked on the next launch
    // by the app's own recovery; here we just surface the death time.
    if (deadAtSec !== null) {
      const chunks = require('fs').existsSync(app.recordingsDir)
        ? require('fs').readdirSync(app.recordingsDir, { recursive: true }).filter(f => /chunk/.test(String(f))).length : 0;
      problems.push(`APP DIED at t=${deadAtSec}s (renderer unresponsive) — endurance NOT completed. ~${chunks} chunks on disk (~${Math.round(chunks * 3 / 60)} min captured before death).`);
      notes.push('NOTE: attribute cause carefully — a real endurance crash vs. host resource contention. Re-run in isolation (no other machine activity).');
      return { pass: false, problems, notes, healthLog: healthLog.slice(-20) };
    }

    await app.stopRecording(90_000);
    const phase = await app.waitForPhase(['uploaded', 'idle'], 600_000).catch(() => null);
    notes.push('final phase=' + phase);

    if (falseAlarmBreak) problems.push(`FALSE ALARM during a break at t=${falseAlarmBreak.t}s: [${falseAlarmBreak.badge}] (faint room tone must not warn)`);

    const out = app.findOutputFile();
    if (!out) {
      problems.push('No output file after 5h15m recording (auto-split/combine failure?)');
      return { pass: false, problems, notes, healthLog: healthLog.slice(-40) };
    }
    // The final combined file must contain the WHOLE 5h15m with no lost audio
    // across the split boundary. Segment levels skipped (breaks are noise).
    const v = verdict(out, sc, { tailLossMaxS: 20, ignoreSegmentLevels: true });
    problems.push(...v.problems);
    notes.push(...v.notes);
    const uploads = mock.state.requests.filter(r => r.url === '/api/desktop/upload');
    notes.push(`upload attempts: ${uploads.length}`);
    if (uploads.length !== 1) problems.push(`Expected exactly 1 upload, saw ${uploads.length}`);
    return { pass: problems.length === 0, problems, notes, healthLog: healthLog.slice(-40) };
  });
}

const SCENARIOS = {
  selftest,
  's1-baseline': s1Baseline,
  's2-angela-bt': s2AngelaBt,
  's3-autosplit': s3Autosplit,
  's4-storm': s4Storm,
  's5-resilience': s5Resilience,
  's6-crash': s6Crash,
  's7-endurance': s7Endurance,
};

(async () => {
  const name = process.argv[2];
  if (!name || !SCENARIOS[name]) {
    console.log(`Usage: node tests/e2e-harness/run.js <${Object.keys(SCENARIOS).join('|')}> [--keep]`);
    process.exit(2);
  }
  try {
    const pass = await SCENARIOS[name]();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error(`Scenario ${name} crashed:`, e);
    process.exit(1);
  }
})();

