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
const { spawn } = require('child_process');
const { buildScenario, WORK_DIR } = require('./lib/audio');
const { verdict, decodeToPcm, goertzel: vgoertzel, db: vdb, SR: VSR } = require('./lib/verify');

const REPO_ROOT_E2E = path.resolve(__dirname, '..', '..');
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
    const batchRoot = path.join(path.dirname(out), 'source-chunks');
    const batches = fs.existsSync(batchRoot) ? fs.readdirSync(batchRoot).filter(name => /^\d+$/.test(name)).length : 0;
    if (batches < 3) { v.problems.push('Session rotation did not retain at least three source batches'); v.pass = false; }
    v.notes.push('retained ' + batches + ' source batches after crossing 180s compressed split boundaries');
    return v;
  });
}

// Exercise the real main-process custody decision, not just a mocked result.
async function s10UploadCustody() {
  const sc = buildScenario('s10', [{ type: 'speech', seconds: 60 }]);
  return withApp('s10-upload-custody', sc, {}, async (app, mock) => {
    mock.setMode('status-unknown');
    await app.startRecording(); await sleep(45000); await app.stopRecording();
    await app.waitForPhase(['error'], 180000);
    const filePath = app.findOutputFile();
    if (!filePath) return { pass: false, problems: ['No output file after uncertain upload'] };
    const recordId = path.basename(path.dirname(filePath));
    const receiptPath = path.join(path.dirname(filePath), 'upload-receipt.json');
    const problems = []; const notes = [];
    const checksum = require('crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    let receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.verified || receipt.canDelete) problems.push('Unknown status incorrectly authorized deletion');
    const remote = mock.state.uploads.get(receipt.audioFileId);
    if (remote?.sha256 !== checksum) problems.push('Uploaded bytes do not match the local final file');
    for (const mode of ['status-404', 'status-401']) {
      mock.setMode(mode);
      const result = await app.page.evaluate(params => window.electronAPI.upload.start(params), { recordId, filePath, metadata: {} });
      if (result.success || result.verified || result.canDelete || !result.pendingVerification) problems.push(mode + ' incorrectly accepted as verified');
      const deletion = await app.page.evaluate(id => window.electronAPI.recording.deleteRecording(id, { requireVerified: true }), recordId);
      if (deletion.success || !fs.existsSync(filePath)) problems.push(mode + ' did not retain local audio');
    }
    mock.setMode('ok');
    const result = await app.page.evaluate(params => window.electronAPI.upload.start(params), { recordId, filePath, metadata: {} });
    if (!result.success || !result.verified) problems.push('Accepted upload did not verify after server recovery');
    if (result.canDelete !== false || result.contentVerified !== false || result.pendingVerification) problems.push('Confirmed status did not preserve local audio without claiming content verification');
    const attempts = mock.state.requests.filter(r => r.url === '/api/desktop/upload');
    if (attempts.length !== 1) problems.push('Expected exactly 1 upload, observed ' + attempts.length);
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (!receipt.verified) problems.push('Verified receipt was not persisted');
    if (receipt.canDelete !== false || receipt.contentVerified !== false) problems.push('Confirmed receipt incorrectly granted deletion or content verification');
    const confirmedDeletion = await app.page.evaluate(id => window.electronAPI.recording.deleteRecording(id, { requireVerified: true }), recordId);
    if (confirmedDeletion.success || !fs.existsSync(filePath)) problems.push('Confirmed Meeting status allowed automatic deletion');
    const oldReceipt = { ...receipt, canDelete: true };
    delete oldReceipt.contentVerified;
    fs.writeFileSync(receiptPath, JSON.stringify(oldReceipt));
    const oldReceiptDeletion = await app.page.evaluate(id => window.electronAPI.recording.deleteRecording(id, { requireVerified: true }), recordId);
    if (oldReceiptDeletion.success || !fs.existsSync(filePath)) problems.push('An older receipt bypassed automatic local retention');
    notes.push('Unknown enum, 404 and 401 retain audio and refuse deletion; later confirmation reuses one accepted upload.');
    notes.push('Confirmed uploads remain successful but retain local audio; even an older canDelete=true receipt cannot authorize automatic deletion.');
    notes.push('Multipart file SHA-256 matches the local final file.');
    await app.page.evaluate(id => window.electronAPI.recording.setUnsavedAudio(id), recordId);
    const protectedDelete = await app.page.evaluate(id => window.electronAPI.recording.deleteRecording(id), recordId);
    if (protectedDelete.success || !fs.existsSync(filePath)) problems.push('Deletion ignored in-memory unsaved audio');
    const protectedUpload = await app.page.evaluate(params => window.electronAPI.upload.start(params), { recordId, filePath, metadata: {} });
    if (protectedUpload.success || protectedUpload.canDelete) problems.push('Upload ignored in-memory unsaved audio');
    await app.page.evaluate(() => window.electronAPI.recording.setUnsavedAudio(null));
    notes.push('Main process refuses deletion and upload while audio remains unsaved in renderer memory.');
    fs.appendFileSync(filePath, 'modified-after-upload');
    const changedDeletion = await app.page.evaluate(id => window.electronAPI.recording.deleteRecording(id, { requireVerified: true }), recordId);
    if (changedDeletion.success || !fs.existsSync(filePath)) problems.push('Changed audio was deleted using an old upload receipt');
    notes.push('Automatic retention also applies after local file mutation; this refusal does not test checksum-based deletion authorization.');
    // This explicit deletion is last and is limited to this synthetic profile.
    app.assertTestProfile();
    const recordingDirectory = path.resolve(path.dirname(filePath));
    if (path.dirname(recordingDirectory) !== path.resolve(app.recordingsDir)) throw new Error('Refusing to delete outside the synthetic recording directory');
    const manualDeletion = await app.page.evaluate(id => window.electronAPI.recording.deleteRecording(id), recordId);
    if (!manualDeletion.success || fs.existsSync(recordingDirectory)) problems.push('Explicit manual deletion did not remove the synthetic recording');
    notes.push('Explicit manual deletion remains available after all retention checks and removes only the synthetic recording.');
    return { pass: problems.length === 0, problems, notes };
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
  let app2;
  try {
    await app.launch();
    await app.login();
    await app.startRecording();
    await sleep(90_000);           // 90s of audio captured
    await app.crashRenderer();     // the meeting "dies"
    await sleep(5_000);
    await app.close({ keepProfile: true });

    // Relaunch on the SAME profile - recovery must find and combine the chunks.
    app2 = new AppDriver({ name: 's6-crash', apiUrl: mock.url, cdpPort: 9341, userDataDir: app.userDataDir });
    await app2.launch({ freshProfile: false });
    await app2.login();
    // Fresh chunks are intentionally deferred; allow the scheduled rescan.
    const recoveryDeadline = Date.now() + 180000;
    while (!app2.findOutputFile() && Date.now() < recoveryDeadline) await sleep(1000);

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
    if (app2) await app2.close({ keepProfile: true }).catch(() => {});
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
      // Only abort after REPEATED unresponsiveness (confirmDead retries over
      // ~90s). A single missed 10s ping is often a transient GC pause or
      // host-contention hiccup, not a dead app — insta-killing on it false-failed
      // a 5h run while the app (and real 5h user recordings) were actually fine.
      if (await app.confirmDead()) {
        deadAtSec = tSec;
        fs.appendFileSync(progressFile, JSON.stringify({ t: tSec, dead: true, note: 'unresponsive across confirmDead retries (~90s)' }) + '\n');
        break;
      }
      let h = {}; let phase = null; let mem = {};
      try { h = await app.getMicHealthUi(); } catch (e) { /* keep going */ }
      try { phase = await app.getPhase(); } catch (e) { /* keep going */ }
      try { mem = await app.getRendererMemory(); } catch (e) { /* keep going */ }
      const rec = { t: tSec, phase, badge: h.badge, msg: (h.message || '').slice(0, 60), heapMB: mem.heapMB, domNodes: mem.domNodes };
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

/**
 * s8-sysaudio — Windows output-endpoint split (incident 2026-08-14).
 *
 * Runs with REAL devices (no fake-audio switch: `use-fake-device-for-media-stream`
 * would fake the loopback too). The mic therefore records a quiet room, which
 * makes the oracle clean — any tone in the output can only have arrived through
 * the system-audio capture.
 *
 *   Phase A: tone to the default COMMUNICATION endpoint (headset). This is where
 *            Teams/Zoom render. The loopback must MISS it, and the app must say so.
 *   Phase B: tone to the default MULTIMEDIA endpoint. The loopback must CATCH it,
 *            and the warning must clear.
 *
 * Phase B's endpoint is typically muted at 0% on this machine — irrelevant, and
 * useful: WASAPI loopback taps the mix before endpoint volume, so phase B cannot
 * reach the microphone acoustically. Anything found at PHASE_B_FREQ is proof of
 * a genuine digital capture, not of a speaker bleeding into the mic.
 */
const PHASE_A_FREQ = 1000;  // -> an endpoint the loopback CANNOT hear
const PHASE_B_FREQ = 1500;  // -> the multimedia default (the loopback MUST hear it)

/**
 * Read the machine's real endpoint layout via the native helper. The scenario
 * must never assume a particular Windows sound configuration — the defaults are
 * ambient state a user (or Windows itself, on a Bluetooth connect) can change
 * between runs, and an assumed layout turns into false failures.
 */
function readEndpoints() {
  const exe = path.join(REPO_ROOT_E2E, 'resources', 'sysloopback', 'win-x64', 'sysloopback.exe');
  if (!fs.existsSync(exe)) return null;
  let out;
  try {
    out = require('child_process').execFileSync(exe, ['--list'], { encoding: 'utf8', timeout: 20000 });
  } catch (e) { return null; }

  const devices = [];
  const defaults = {};
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; }
    if (j.event === 'device') devices.push(j.detail.split(' :: ')[0]);
    if (j.event === 'default') {
      const [role, name] = j.detail.split(' :: ');
      defaults[role] = name;
    }
  }
  return { devices, defaults };
}

function playTone({ device, freq, seconds }) {
  const electronExe = path.join(REPO_ROOT_E2E, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electronExe, [
    path.join(__dirname, 'tone-player'),
    '--device', device, '--freq', String(freq), '--seconds', String(seconds),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', d => out.push(d.toString()));
  child.stderr.on('data', d => out.push(d.toString()));
  return {
    child,
    log: out,
    stop: () => { try { child.kill(); } catch (e) { /* already gone */ } },
    done: new Promise(res => child.on('exit', c => res({ code: c, log: out.join('') }))),
  };
}

/**
 * Endpoint names are localized and contain umlauts ("Kopfhörer (Jabra …)").
 * Match on the parenthesised product name when there is one — it is the stable,
 * ASCII-ish part shared between the WASAPI friendly name and Chromium's label.
 */
function matchToken(endpointName) {
  if (!endpointName) return '';
  const m = /\(([^)]+)\)/.exec(endpointName);
  return (m ? m[1] : endpointName).split(/\s+/).slice(0, 2).join(' ');
}

/**
 * Pre-flight: does this endpoint actually carry capturable audio right now?
 *
 * A Windows render endpoint can be "active" and still deliver pure silence to
 * WASAPI loopback — a Bluetooth headset that is powered off or asleep is the
 * common case, and Windows happily keeps it as the default output. Measured
 * with the NATIVE helper, which binds to the endpoint directly, so this is a
 * property of the endpoint rather than of the app under test. Without this
 * probe the scenario would blame the product for a dead headset.
 */
async function endpointCarriesAudio(endpointName) {
  const exe = path.join(REPO_ROOT_E2E, 'resources', 'sysloopback', 'win-x64', 'sysloopback.exe');
  if (!fs.existsSync(exe)) return null;
  const wav = path.join(WORK_DIR, 'endpoint-probe.wav');
  try { fs.unlinkSync(wav); } catch (e) { /* first run */ }

  const cap = spawn(exe, ['--role', 'multimedia', '--seconds', '9', '--out', wav], { stdio: 'ignore' });
  const capDone = new Promise(res => cap.on('exit', res));
  await sleep(1500);
  const tone = playTone({ device: matchToken(endpointName), freq: PHASE_B_FREQ, seconds: 5 });
  await tone.done;
  await capDone;

  if (!fs.existsSync(wav)) return null;
  try { return toneLevelDb(decodeToPcm(wav), PHASE_B_FREQ); }
  catch (e) { return null; }
}

/** dBFS of one tone across the whole file. */
function toneLevelDb(pcm, freq) {
  const win = Math.round(0.1 * VSR);
  let peak = 0;
  for (let w0 = 0; w0 + win <= pcm.length; w0 += win) {
    const p = vgoertzel(pcm, w0, win, freq, VSR);
    if (p > peak) peak = p;
  }
  return vdb(peak);
}

async function s8SysAudio() {
  const eps = readEndpoints();
  if (!eps) {
    console.log('s8-sysaudio: sysloopback helper unavailable — cannot read endpoint layout');
    return false;
  }
  const mmDefault = eps.defaults.multimedia;      // what the loopback binds to
  const commsDefault = eps.defaults.communications;
  const mismatchExpected = Boolean(mmDefault && commsDefault && mmDefault !== commsDefault);
  // Phase A needs an endpoint the loopback CANNOT hear: any active endpoint that
  // is not the multimedia default. Prefer the comms default (the real incident).
  const deafTarget = (commsDefault && commsDefault !== mmDefault)
    ? commsDefault
    : eps.devices.find(d => d !== mmDefault);

  console.log(`s8-sysaudio: multimedia=${mmDefault} | communications=${commsDefault} | mismatch=${mismatchExpected}`);

  // Probe BEFORE launching the app: is the endpoint the loopback will bind to
  // even alive? Decides whether phase B can prove anything.
  const mmAlive = await endpointCarriesAudio(mmDefault);
  console.log(`s8-sysaudio: multimedia endpoint carries audio: ${mmAlive === null ? 'unknown' : mmAlive.toFixed(1) + 'dB'}`);

  return withApp('s8-sysaudio', null, { cdpPort: 9347 }, async (app, mock) => {
    const problems = [];
    const notes = [];
    notes.push(`endpoints: multimedia="${mmDefault}" communications="${commsDefault}" mismatch=${mismatchExpected}`);

    // The app must read back the persisted preference — the getter used to be
    // hard-coded to `false`, so the toggle silently reset OFF every launch.
    const persisted = await app.evalTimed(async () => {
      await window.electronAPI.systemAudio.setEnabled(true);
      return window.electronAPI.systemAudio.getEnabled();
    });
    if (persisted !== true) problems.push(`systemAudio.getEnabled() returned ${persisted} right after setEnabled(true) — the config getter is still lying`);
    notes.push(`config getEnabled after setEnabled(true): ${persisted}`);

    // "System audio will be captured" only renders while the toggle is truly on,
    // so it is the honest signal — a synthetic el.click() can leave the DOM
    // attribute stale without Quasar ever having flipped the model.
    const ui = () => app.evalTimed(() => ({
      toggleOn: !!document.querySelector('.system-audio-active'),
      routing: document.querySelector('[data-test=system-audio-routing-warning]')?.textContent?.trim() ?? null,
      silent: document.querySelector('[data-test=system-audio-silent-warning]')?.textContent?.trim() ?? null,
    }));

    // Turn the real toggle on the way a user does — a real mouse event, because
    // Quasar's QToggle does not react reliably to a synthetic el.click().
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await ui()).toggleOn) break;
      try { await app.page.click('[data-test=system-audio-toggle]'); }
      catch (e) { notes.push(`toggle click attempt ${attempt + 1} failed: ${e.message}`); }
      await sleep(2000);
    }

    const beforeStart = await ui();
    notes.push(`toggle on: ${beforeStart.toggleOn}`);
    if (!beforeStart.toggleOn) {
      // Everything downstream measures the system-audio path; without it the
      // run proves nothing, so fail loudly instead of reporting phantom defects.
      return { pass: false, problems: ['System-audio toggle did not turn on — the rest of the scenario would be meaningless'], notes };
    }

    // The warning must track reality in BOTH directions: shown when the machine
    // really has a split, and — just as important — absent when it does not.
    if (mismatchExpected && !beforeStart.routing) {
      problems.push(`Endpoint split exists (multimedia="${mmDefault}" vs communications="${commsDefault}") but no warning was shown`);
    } else if (!mismatchExpected && beforeStart.routing) {
      problems.push(`FALSE ALARM: endpoint warning shown although both default roles are "${mmDefault}"`);
    } else {
      notes.push(mismatchExpected
        ? `routing warning correctly shown: ${beforeStart.routing.slice(0, 140)}`
        : 'no routing warning, and none expected (both default roles agree)');
    }

    await app.startRecording();

    // ---- Phase A: play where the loopback CANNOT hear ------------------------
    // This reproduces the incident: audio exists, the user hears it, the capture
    // is live — and records nothing.
    let silentSeenAfterS = null;
    if (!deafTarget) {
      notes.push('SKIPPED phase A: only one active render endpoint, so no endpoint is out of the loopback\'s reach');
    } else {
      const toneA = playTone({ device: matchToken(deafTarget), freq: PHASE_A_FREQ, seconds: 130 });
      for (let t = 0; t < 130; t += 5) {
        await sleep(5000);
        const u = await ui();
        if (u.silent && silentSeenAfterS === null) { silentSeenAfterS = t + 5; break; }
      }
      toneA.stop();
      await toneA.done;
      notes.push(`tone-player A -> "${deafTarget}": ${toneA.log.join('').trim()}`);

      if (silentSeenAfterS === null) {
        problems.push(`Silence watchdog never fired while the loopback listened to "${mmDefault}" and the audio played to "${deafTarget}" for >2 min`);
      } else {
        notes.push(`silence warning appeared after ~${silentSeenAfterS}s`);
        if (silentSeenAfterS < 85) problems.push(`Silence warning fired after only ${silentSeenAfterS}s (threshold is 90s) — too trigger-happy`);
      }
    }

    // ---- Phase B: play where the loopback actually listens -------------------
    let phaseBRan = false;
    if (mmAlive === null || mmAlive < -70) {
      notes.push(`SKIPPED phase B: the multimedia default "${mmDefault}" carries no capturable audio ` +
                 `(native probe ${mmAlive === null ? 'unavailable' : mmAlive.toFixed(1) + 'dB'}) — a powered-off or ` +
                 'sleeping Bluetooth endpoint cannot be captured by ANY method, so "the warning clears when audio ' +
                 'arrives" is not testable in this audio configuration. Covered by the SASIG unit tests. ' +
                 'To test it live, make a wired/active endpoint the Windows default output.');
    } else {
      phaseBRan = true;
      const toneB = playTone({ device: matchToken(mmDefault), freq: PHASE_B_FREQ, seconds: 45 });
      await sleep(20_000);
      const during = await ui();
      if (during.silent) problems.push('Silence warning did NOT clear after real system audio arrived');
      else notes.push('silence warning cleared once system audio arrived');
      await toneB.done;
      notes.push(`tone-player B: ${toneB.log.join('').trim()}`);
    }

    await app.stopRecording();
    await app.waitForPhase(['uploaded', 'idle'], 180_000);

    // ---- Forensics on the produced file --------------------------------------
    const out = app.findOutputFile();
    if (!out) return { pass: false, problems: [...problems, 'No output file produced'], notes };

    const pcm = decodeToPcm(out);
    const aDb = toneLevelDb(pcm, PHASE_A_FREQ);
    const bDb = toneLevelDb(pcm, PHASE_B_FREQ);
    notes.push(`output ${(pcm.length / VSR).toFixed(1)}s | ${PHASE_A_FREQ}Hz (comms endpoint) ${aDb.toFixed(1)}dB | ${PHASE_B_FREQ}Hz (default endpoint) ${bDb.toFixed(1)}dB`);

    if (phaseBRan && bDb < -60) {
      problems.push(`System audio played to the multimedia default "${mmDefault}" was not captured (${PHASE_B_FREQ}Hz at ${bDb.toFixed(1)}dB) — the capture path itself is broken`);
    }
    if (deafTarget && aDb > bDb - 20) {
      notes.push(`NOTE: ${PHASE_A_FREQ}Hz is only ${(bDb - aDb).toFixed(1)}dB below ${PHASE_B_FREQ}Hz — most likely acoustic leakage into the room mic rather than loopback capture`);
    }

    return { pass: problems.length === 0, problems, notes };
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
  's10-upload-custody': s10UploadCustody,
  's7-endurance': s7Endurance,
  's8-sysaudio': s8SysAudio,
  's11-capture-qualification': async () => report('s11-capture-qualification', await require('./qualification').runCaptureQualification()),
  's12-device-qualification': async () => report('s12-device-qualification', await require('./device-qualification').runDeviceQualification()),
  's13-coded-endurance': async () => report('s13-coded-endurance', await require('./endurance-qualification').runCodedEndurance()),
  's14-system-audio-qualification': async () => (await require('./windows-loopback-qualification').runSystemAudioQualification()).pass,
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
