/**
 * Live-backend helpers — talk to the REAL production backend
 * (app.suisse-notes.ch) and its database, for true end-to-end verification:
 * the uploaded file must produce a Meeting row, and transcription must run to
 * completion (Transcript + TranscriptSegment rows). Also cleans up afterward
 * so test recordings never accumulate in production.
 *
 * DB access is via `ssh suisse-notes psql` (same path used operationally).
 * The E2E user is provisioned by scripts/provision-e2e-user.mjs on the server.
 */
'use strict';

const https = require('https');
const { execFileSync } = require('child_process');

const API = 'https://app.suisse-notes.ch';
const E2E_EMAIL = 'desktop-e2e@suisse-notes.test';
const E2E_PASSWORD = process.env.E2E_PASSWORD || 'SuisseE2E!test123';
const SSH_HOST = 'suisse-notes';
const DB_PASSWORD = 'cSHQgme3yjpARlkR8uXqNYUPbsF0JX';

function req(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(API + path);
    const r = https.request(u, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(b); } catch (e) { /* non-json */ }
        resolve({ status: res.statusCode, json, raw: b });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function loginLive() {
  const res = await req('POST', '/api/auth/desktop', { body: { email: E2E_EMAIL, password: E2E_PASSWORD } });
  if (!res.json?.token) throw new Error(`Live login failed (${res.status}): ${res.raw?.slice(0, 200)}`);
  return res.json.token;
}

/** Poll the real upload-status endpoint until a terminal state or timeout. */
async function pollUploadStatus(token, audioFileId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await req('GET', `/api/desktop/upload/${audioFileId}/status`, { token });
    last = res.json?.status || `${res.status}`;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(last)) return last;
    await new Promise(r => setTimeout(r, 5000));
  }
  return `TIMEOUT(last=${last})`;
}

/** Run a read-only SQL query on the production DB via ssh; returns rows as arrays. */
function dbQuery(sql) {
  const remote = `PGPASSWORD='${DB_PASSWORD}' psql -h localhost -U postgres -d suisse_notes -tA -F '|' -c "${sql.replace(/"/g, '\\"')}"`;
  const out = execFileSync('ssh', [SSH_HOST, remote], { encoding: 'utf8', timeout: 30_000 });
  return out.trim().split('\n').filter(Boolean).map(l => l.split('|'));
}

/** Verify the uploaded recording produced real backend rows. */
function verifyBackendState(audioFileId) {
  // Meeting linked to this audio file
  const meeting = dbQuery(`SELECT id, status, duration FROM "Meeting" WHERE "audioFileId"='${audioFileId}'`);
  if (!meeting.length) return { ok: false, reason: `No Meeting row for audioFileId ${audioFileId}` };
  const [meetingId, status, duration] = meeting[0];
  // Transcript + segment count
  const seg = dbQuery(`SELECT count(*) FROM "TranscriptSegment" s JOIN "Transcript" t ON t.id=s."transcriptId" WHERE t."meetingId"='${meetingId}'`);
  const segments = parseInt(seg[0]?.[0] || '0', 10);
  return { ok: true, meetingId, status, duration: parseInt(duration || '0', 10), segments };
}

/** Delete a test meeting and its dependent rows so production stays clean. */
function cleanupMeeting(meetingId) {
  if (!meetingId) return;
  // ON DELETE CASCADE covers Transcript/TranscriptSegment/Access/etc.
  dbQuery(`DELETE FROM "Meeting" WHERE id='${meetingId}'`);
}

/** Safety-net cleanup: delete EVERY meeting owned by the E2E account, so a run
 *  that crashed before its per-meeting cleanup never leaves production dirty. */
function cleanupAllTestMeetings() {
  dbQuery(`DELETE FROM "Meeting" m USING "User" u WHERE m."userId"=u.id AND u.email='${E2E_EMAIL}'`);
}

module.exports = {
  API, E2E_EMAIL, E2E_PASSWORD,
  loginLive, pollUploadStatus, dbQuery, verifyBackendState, cleanupMeeting,
};
