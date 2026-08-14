/**
 * LIVE recovery E2E — the F-003 fix against the REAL production backend.
 *
 * Proves the whole crash/power-loss recovery chain end-to-end on production
 * (not a mock): record → hard-kill mid-recording → relaunch → recover the
 * orphaned chunks → the main-process autonomous upload queue uploads the
 * recovered file to REAL Azure → backend transcribes → Meeting + segments in
 * the real DB. Then cleans up the test meeting.
 *
 * This is the test that was previously only run against the mock — the exact
 * gap Marc flagged. Uses the dedicated E2E account.
 *
 *   SUISSE_E2E_PACKAGED_EXE="<win-unpacked>/Suisse Meets.exe" node recovery-live.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { buildScenario } = require('./lib/audio');
const { AppDriver, sleep } = require('./lib/app-driver');
const backend = require('./lib/backend');

const line = '='.repeat(70);

function readHistory(userDataDir, recordId) {
  const p = path.join(userDataDir, 'recordings-history.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (data.recordings || []).find(r => r.id === recordId) || null;
  } catch (e) { return null; }
}

(async () => {
  const problems = [];
  const notes = [];
  let meetingId = null;

  const sc = buildScenario('recovlive', [{ type: 'speech', seconds: 60 }]);
  const app = new AppDriver({ name: 'recovery-live', apiUrl: backend.API, fakeAudioWav: sc.wavPath, cdpPort: 9347 });
  let recordId = null;
  let app2 = null;
  try {
    // 1) Record ~60s against the REAL backend, then hard-kill mid-recording.
    await app.launch({ freshProfile: true });
    await app.login(backend.E2E_EMAIL, backend.E2E_PASSWORD);
    notes.push('logged into live backend as ' + backend.E2E_EMAIL);
    await app.startRecording();
    recordId = await app.getRecordId();
    notes.push('recordId=' + recordId);
    await sleep(60_000);
    await app.close({ keepProfile: true });   // hard taskkill /T /F = power loss
    notes.push('hard-killed mid-recording (power-loss)');
    await sleep(3_000);

    // 2) Relaunch on the SAME profile → recovery + main-process autonomous upload.
    app2 = new AppDriver({ name: 'recovery-live', apiUrl: backend.API, cdpPort: 9349, userDataDir: app.userDataDir });
    try {
      await app2.launch({ freshProfile: false });
      await app2.login(backend.E2E_EMAIL, backend.E2E_PASSWORD).catch(() => {});
    } catch (e) {
      notes.push('(relaunch page did not stabilize — proceeding; recovery+upload run in main): ' + e.message.split('\n')[0]);
    }

    // 3) Recovery has a ~60s freshness guard + 2-min re-scan, then combine +
    //    upload. Poll the on-disk history for the backend-assigned audioFileId.
    notes.push('waiting for recovery + REAL upload (up to 5 min)...');
    let audioFileId = null;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await sleep(15_000);
      const rec = readHistory(app.userDataDir, recordId);
      if (rec && rec.audioFileId) { audioFileId = rec.audioFileId; notes.push(`recovered upload got audioFileId=${audioFileId} (status=${rec.uploadStatus})`); break; }
    }
    if (!audioFileId) {
      const rec = readHistory(app.userDataDir, recordId);
      problems.push(`Recovered recording never got an audioFileId (history uploadStatus=${rec?.uploadStatus}, filePath=${rec?.filePath ? 'set' : 'none'}). It did not upload to the real backend.`);
      throw new Error('no audioFileId after recovery');
    }

    // 4) Verify the REAL backend transcribed it.
    const token = await backend.loginLive();
    const status = await backend.pollUploadStatus(token, audioFileId, 300_000);
    notes.push('backend status=' + status);
    if (status !== 'COMPLETED') problems.push(`Backend did not reach COMPLETED (got ${status}) for the recovered recording.`);

    const v = backend.verifyBackendState(audioFileId);
    if (!v.ok) { problems.push('Backend DB verification failed: ' + v.reason); }
    else {
      meetingId = v.meetingId;
      notes.push(`DB: meetingId=${v.meetingId} status=${v.status} duration=${v.duration}s segments=${v.segments}`);
      if (v.segments === 0) problems.push('Recovered meeting has ZERO transcript segments.');
    }
  } catch (e) {
    problems.push('Recovery live E2E threw: ' + e.message);
  } finally {
    try { if (app2) await app2.close({ keepProfile: true }); } catch (e) { /* ignore */ }
    try { await app.close({ keepProfile: true }); } catch (e) { /* ignore */ }
    if (meetingId && problems.length === 0) {
      try { backend.cleanupMeeting(meetingId); notes.push('cleaned up test meeting ' + meetingId); }
      catch (e) { notes.push('CLEANUP FAILED for ' + meetingId + ' — delete manually'); }
    } else if (meetingId) {
      notes.push(`LEFT meeting ${meetingId} for inspection (had failures)`);
    }
    if (problems.length === 0) { try { backend.cleanupAllTestMeetings(); } catch (e) { /* best effort */ } }
  }

  const pass = problems.length === 0;
  console.log(`\n${line}\n${pass ? 'PASS' : 'FAIL'}  recovery-live (crash → recover → REAL upload → transcription)\n${line}`);
  for (const n of notes) console.log('  note:', n);
  for (const p of problems) console.log('  PROBLEM:', p);
  process.exit(pass ? 0 : 1);
})();
