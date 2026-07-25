/**
 * LIVE end-to-end test — the real desktop app against the REAL production
 * backend (app.suisse-notes.ch). Proves the full path a customer relies on:
 *
 *   record → combine → upload to Azure → backend Meeting created →
 *   transcription runs → Transcript + TranscriptSegment rows exist.
 *
 * Then it CLEANS UP the test meeting so production data stays clean.
 *
 * Uses the dedicated E2E account (desktop-e2e@suisse-notes.test, unlimited
 * minutes, provisioned by scripts/provision-e2e-user.mjs on the server).
 *
 *   node tests/e2e-harness/run-live.js
 *
 * Short audio (~45s) keeps transcription cost negligible. Any backend upload
 * or transcription failure is reported and left UNcleaned for inspection.
 */
'use strict';

const { buildScenario } = require('./lib/audio');
const { AppDriver, sleep } = require('./lib/app-driver');
const backend = require('./lib/backend');

const line = '='.repeat(70);

(async () => {
  const problems = [];
  const notes = [];
  let meetingId = null;

  // ~45s of realistic speech — enough to transcribe, cheap enough to be free-ish.
  const sc = buildScenario('live', [{ type: 'speech', seconds: 45 }]);

  const app = new AppDriver({
    name: 'live',
    apiUrl: backend.API,                 // REAL backend
    fakeAudioWav: sc.wavPath,
    cdpPort: 9345,
  });

  try {
    await app.launch();
    await app.login(backend.E2E_EMAIL, backend.E2E_PASSWORD);
    notes.push('logged into live backend as ' + backend.E2E_EMAIL);

    await app.startRecording();
    const recordId = await app.getRecordId();
    notes.push('recordId=' + recordId);
    await sleep(43_000);
    await app.stopRecording();

    // Wait for the app to finish uploading (phase → uploaded/idle).
    let phase = null;
    try { phase = await app.waitForPhase(['uploaded', 'idle'], 240_000); } catch (e) { /* handled below */ }
    notes.push('post-upload phase=' + phase);

    // Read the audioFileId the backend assigned (via the app's history record).
    let rec = null;
    for (let i = 0; i < 20 && !(rec && rec.audioFileId); i++) {
      rec = await app.getHistoryRecord(recordId);
      if (rec && rec.audioFileId) break;
      await sleep(2000);
    }
    if (!rec || !rec.audioFileId) {
      problems.push(`Upload did not yield an audioFileId (uploadStatus=${rec?.uploadStatus}). File likely never reached the backend.`);
      throw new Error('no audioFileId');
    }
    const audioFileId = rec.audioFileId;
    notes.push(`audioFileId=${audioFileId} uploadStatus=${rec.uploadStatus}`);

    // Poll the REAL backend for transcription completion.
    const token = await backend.loginLive();
    const status = await backend.pollUploadStatus(token, audioFileId, 300_000);
    notes.push('backend status=' + status);
    if (status !== 'COMPLETED') {
      problems.push(`Backend did not reach COMPLETED (got ${status}). Transcription or processing failed on the backend.`);
    }

    // Verify real DB rows: Meeting + transcript segments.
    const v = backend.verifyBackendState(audioFileId);
    if (!v.ok) {
      problems.push(`Backend DB verification failed: ${v.reason}`);
    } else {
      meetingId = v.meetingId;
      notes.push(`DB: meetingId=${v.meetingId} status=${v.status} duration=${v.duration}s segments=${v.segments}`);
      if (v.segments === 0) {
        problems.push('Meeting exists but has ZERO transcript segments — transcription produced no text.');
      }
      if (v.duration <= 0) {
        problems.push(`Meeting duration is ${v.duration}s — backend did not record a valid duration.`);
      }
    }
  } catch (e) {
    problems.push('Live E2E threw: ' + e.message);
  } finally {
    // Clean up the test meeting unless something failed (leave it for inspection).
    if (meetingId && problems.length === 0) {
      try { backend.cleanupMeeting(meetingId); notes.push('cleaned up test meeting ' + meetingId); }
      catch (e) { notes.push('CLEANUP FAILED for ' + meetingId + ': ' + e.message + ' (delete manually)'); }
    } else if (meetingId) {
      notes.push(`LEFT test meeting ${meetingId} in place for inspection (had failures)`);
    }
    // Safety net: on a clean pass, also sweep any orphaned E2E meetings from
    // earlier crashed runs so production never accumulates test data.
    if (problems.length === 0) {
      try { backend.cleanupAllTestMeetings(); } catch (e) { /* best effort */ }
    }
    await app.close({ keepProfile: true });
  }

  const pass = problems.length === 0;
  console.log(`\n${line}\n${pass ? 'PASS' : 'FAIL'}  live-e2e (desktop → real backend → transcription)\n${line}`);
  for (const n of notes) console.log('  note:', n);
  for (const p of problems) console.log('  PROBLEM:', p);
  process.exit(pass ? 0 : 1);
})();
