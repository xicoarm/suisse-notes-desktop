/**
 * Power-loss recovery verification (regression for the stuck-history-entry bug).
 *
 * Reproduces EXACTLY what killed the 5h endurance run: a recording is in progress
 * (history entry already persisted as uploadStatus:'recording'), then the whole
 * app tree is hard-killed mid-recording (taskkill /T /F === power loss, no
 * graceful finalize). On relaunch the app must:
 *   1. reconstruct a valid combined file from the orphaned chunks, AND
 *   2. register that file in history (NOT leave it stuck at 'recording'), AND
 *   3. actually upload it.
 *
 * The old code skipped (2)/(3) whenever a history entry already existed (which is
 * always, after a real crash) — stranding the recovered audio on disk. This test
 * asserts the DISK history file + the mock's received uploads (ground truth), not
 * just pinia state (which is a separate in-memory copy).
 */
const fs = require('fs');
const path = require('path');
const { buildScenario } = require('./lib/audio');
const { startMockBackend } = require('./lib/mock-backend');
const { AppDriver, sleep } = require('./lib/app-driver');

const EXE = 'C:/Users/arega/projects/Suisse_Notes_Desktop/dist/electron/Packaged/win-unpacked/Suisse Notes.exe';

function readHistoryFile(userDataDir, recordId) {
  const p = path.join(userDataDir, 'recordings-history.json');
  if (!fs.existsSync(p)) return { file: p, exists: false };
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rec = (data.recordings || []).find(r => r.id === recordId) || null;
  return { file: p, exists: true, rec };
}

(async () => {
  const sc = buildScenario('recov', [{ type: 'speech', seconds: 60 }]);
  const mock = await startMockBackend({ port: 3000 });
  const app = new AppDriver({ name: 'recov-powerloss', apiUrl: mock.url, fakeAudioWav: sc.wavPath, cdpPort: 9355, packagedExe: EXE });
  let recordId = null;
  try {
    await app.launch({ freshProfile: true });
    await app.login();
    await app.startRecording();
    console.log('recording... capturing 60s');
    await sleep(60_000);
    recordId = await app.getRecordId();
    console.log('recordId:', recordId);

    // POWER LOSS: hard-kill the whole tree mid-recording (no graceful finalize).
    await app.close({ keepProfile: true });
    console.log('>>> hard-killed mid-recording (power-loss simulation)');

    // Confirm the pre-condition: history entry stuck at 'recording' with no file.
    const pre = readHistoryFile(app.userDataDir, recordId);
    console.log('pre-relaunch history entry:', JSON.stringify(pre.rec));

    await sleep(3_000);

    // RELAUNCH on the SAME profile with the FIXED build. Tolerate page-stabilize
    // failures — recovery + upload run in main/renderer regardless of whether our
    // CDP page attaches. We assert on ground truth (disk history file + mock).
    var app2 = new AppDriver({ name: 'recov-powerloss', apiUrl: mock.url, cdpPort: 9357, userDataDir: app.userDataDir, packagedExe: EXE });
    global.__app2 = app2;
    try {
      await app2.launch({ freshProfile: false });
      await app2.login().catch(() => console.log('(login/page not driven — proceeding on disk+mock ground truth)'));
    } catch (e) {
      console.log('(app2 page did not stabilize — proceeding; process is alive and running recovery):', e.message.split('\n')[0]);
    }

    // Recovery skips chunks <60s old and re-scans at +2min, then combines +
    // uploads. Poll ground truth for up to 4 min; stop as soon as it uploads.
    console.log('polling disk history + mock uploads for up to 240s...');
    let post, uploads = [], inits = [];
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      await sleep(10_000);
      post = readHistoryFile(app.userDataDir, recordId);
      uploads = mock.state.requests.filter(r => r.url === '/api/desktop/upload');
      inits = mock.state.requests.filter(r => r.url === '/api/uploads/init');
      const st = post.rec?.uploadStatus;
      console.log(`  t+${Math.round((240000-(deadline-Date.now()))/1000)}s status=${st} filePath=${post.rec?.filePath?'set':'-'} uploads=${uploads.length} inits=${inits.length}`);
      if (uploads.length > 0 || inits.length > 0 || ['uploaded','completed'].includes(st)) break;
    }

    const out = app2.findOutputFile();
    const pinia = await app2.getHistoryRecord(recordId).catch(() => null);

    console.log('\n=== RESULTS ===');
    console.log('combined file on disk :', out ? path.basename(out) + ' (' + (fs.statSync(out).size / 1e6).toFixed(1) + ' MB)' : 'NONE');
    console.log('history file entry    :', JSON.stringify(post.rec));
    console.log('pinia (UI) entry      :', JSON.stringify(pinia));
    console.log('mock upload requests  :', uploads.length, '| init(SAS) requests:', inits.length);

    const problems = [];
    if (!out) problems.push('no combined file — recovery did not reconstruct the recording');
    if (!post.rec) problems.push('recording absent from history file');
    else {
      if (post.rec.uploadStatus === 'recording') problems.push('STUCK: history file still uploadStatus=recording (the bug — file update did not take)');
      if (!post.rec.filePath) problems.push('history entry has no filePath (recovered file not linked)');
      if (post.rec.recovered !== true) problems.push('history entry not marked recovered');
    }
    const uploaded = uploads.length > 0 || inits.length > 0 ||
      ['uploaded', 'completed', 'uploading'].includes(post.rec?.uploadStatus);
    if (!uploaded) problems.push('recovered recording did NOT progress to upload (visible but never sent)');

    console.log('\n' + (problems.length
      ? 'FAIL:\n  - ' + problems.join('\n  - ')
      : 'PASS: power-loss recording reconstructed, registered in history, AND uploaded'));

    await app2.close({ keepProfile: true });
  } finally {
    try { if (global.__app2) await global.__app2.close({ keepProfile: true }); } catch (e) { /* ignore */ }
    await app.close({ keepProfile: true }).catch(() => {});
    await mock.close();
  }
})().catch(e => { console.error('ERROR', e); process.exit(1); });
