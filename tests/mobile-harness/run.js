/**
 * Mobile reliability harness — the real Capacitor bundle, a virtual phone
 * (native bridge shim + file system on disk), a virtual Suisse Notes Pro
 * recorder speaking the T240 protocol, the scenario WAV as the microphone
 * and the adversarial mock backend.
 *
 *   node tests/mobile-harness/run.js <scenario> [--platform android|ios] [--minutes N] [--headful]
 *
 * Scenarios:
 *   m0-selftest        bridge boots, platform detection, file system + preferences round-trip, login
 *   m1-baseline        90 s meeting → record → stop → combine → upload → forensic verify
 *   m2-endurance       long recording (default 315 min = 5h15; --minutes N) → verify, exactly one upload
 *   m3-resilience      upload survives a transient 500, an expired token and a socket cut
 *   m4-delete-after-upload  "do not keep recordings on this phone": audio gone after the verified upload, entry kept
 *   m5-recorder-sync   pair → busy card → auto-sync (empty file, corrupted transfer, dropped link, button
 *                      recording) → bytes identical on the server → cancel keeps a skipped entry → unpair
 *   m6-crash-recovery  app killed mid-recording → relaunch → recovery combines and queues the upload
 *   m7-repair          reinstall (storage wiped) → the recorder still bound to the user's UUID → pairs again
 *   m8-sentry-capture  every error type reaches Sentry: uncaught, rejection, Vue, console.error/warn,
 *                      failed HTTP answers, errors before init, offline queue, unclean exit after a kill
 *   all                everything except m2
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildScenario } = require('../e2e-harness/lib/audio');
const { verdict } = require('../e2e-harness/lib/verify');
const { startMockBackend } = require('../e2e-harness/lib/mock-backend');
const { startDeviceServer } = require('./lib/device-server');
const { MobileApp, sleep, sentryEventText } = require('./lib/app');

const WORK_DIR = path.join(__dirname, 'work');
const GRADLE_VERSION_NAME = (/versionName\s+"([^"]+)"/.exec(fs.readFileSync(path.resolve(__dirname, '..', '..', 'src-capacitor', 'android', 'app', 'build.gradle'), 'utf8')) || [])[1];
const WWW_DIR = path.resolve(__dirname, '..', '..', 'src-capacitor', 'www');
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const PLATFORM = flag('--platform', process.env.SUISSE_MH_PLATFORM || 'android');
const HEADFUL = argv.includes('--headful');
const MOCK_PORT = parseInt(flag('--mock-port', '3000'), 10);

const DEFECT_SIGNATURES = [/LOST AUDIO/i, /TRUNCAT/i, /TOO LONG/i, /SEGMENT LEVEL/i, /duplicate/i, /never/i, /not deleted/i, /missing/i, /still/i, /storm/i, /mismatch/i, /did not/i, /No combined/i];

function report(name, result) {
  const line = '='.repeat(70);
  console.log(`\n${line}\n${result.pass ? 'PASS' : 'FAIL'}  ${name} (${PLATFORM})\n${line}`);
  for (const n of result.notes || []) console.log(`  note: ${n}`);
  for (const p of result.problems || []) console.log(`  ${DEFECT_SIGNATURES.some(re => re.test(p)) ? 'APP-DEFECT' : 'PROBLEM'}: ${p}`);
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const out = path.join(WORK_DIR, `result_${name}_${PLATFORM}.json`);
  fs.writeFileSync(out, JSON.stringify({ platform: PLATFORM, ...result, analysis: undefined }, null, 2));
  console.log(`  full result: ${out}`);
  return result.pass;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** Bring up mock + device server + app for one scenario. */
async function withApp(name, { scenario = null, recorder = null, bridge = {}, freshProfile = true, mockMode = 'ok', initScripts = [] } = {}, fn) {
  if (!fs.existsSync(path.join(WWW_DIR, 'index.html'))) {
    throw new Error(`No capacitor bundle at ${WWW_DIR} — run: npx quasar build -m capacitor -T android --skip-pkg`);
  }
  const uploadsDir = path.join(WORK_DIR, 'uploads', name);
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  const mock = await startMockBackend({ port: MOCK_PORT, captureUploadsDir: uploadsDir });
  mock.setMode(mockMode);
  const device = await startDeviceServer({ name, platform: PLATFORM, wwwDir: WWW_DIR });
  if (freshProfile) device.wipe();
  const app = new MobileApp({ name, device, mock, platform: PLATFORM, fakeAudioWav: scenario?.wavPath, recorder, bridge: { version: GRADLE_VERSION_NAME, ...bridge }, headful: HEADFUL, initScripts: [...initScripts] });
  try {
    await app.launch({ freshProfile });
    await app.login();
    const result = await fn(app, mock, device);
    fs.writeFileSync(path.join(WORK_DIR, `requests_${name}_${PLATFORM}.json`), JSON.stringify(mock.state.requests, null, 1));
    fs.writeFileSync(path.join(WORK_DIR, `sentry_${name}_${PLATFORM}.json`), JSON.stringify(app.sentryEvents().map(e => ({
      timestamp: e.timestamp, level: e.level, text: sentryEventText(e).slice(0, 200), release: e.release, tags: e.tags, mechanism: e.exception?.values?.[0]?.mechanism, previous_session: e.contexts?.previous_session, extra: e.extra
    })), null, 1));
    return report(name, result);
  } catch (e) {
    await app.screenshot('crash').catch(() => {});
    return report(name, { pass: false, problems: [`scenario crashed: ${e.message}`], notes: app.console.slice(-12) });
  } finally {
    await app.close();
    await device.close();
    await mock.close();
  }
}

const uploadsOf = (mock) => mock.state.requests.filter(r => r.url === '/api/desktop/upload');

/** Verify the combined file of the app's own recording against the scenario audio. */
function verifyCombined(device, sc, expectations) {
  const out = device.findCombined();
  if (!out) return { pass: false, problems: ['No combined recording file in the device file system'], notes: [] };
  const v = verdict(out, sc, expectations);
  v.notes.push(`combined file: ${path.relative(device.fsRoot, out)} (${fs.statSync(out).size} bytes)`);
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────

async function m0Selftest() {
  return withApp('m0-selftest', { recorder: { poweredOn: false } }, async (app, mock, device) => {
    const problems = [], notes = [];
    const info = await app.evalTimed(() => ({
      isNative: window.Capacitor.isNativePlatform(), platform: window.Capacitor.getPlatform(),
      hasBridge: typeof window.Capacitor.nativePromise === 'function'
    }));
    if (!info.isNative || info.platform !== PLATFORM) problems.push(`platform detection wrong: ${JSON.stringify(info)}`);
    // File system semantics through the bridge, exactly as the storage service
    // uses them for every 3-second chunk: tmp write → rename → stat → readdir.
    const fsr = await app.evalTimed(async () => {
      const call = (method, o) => window.Capacitor.nativePromise('Filesystem', method, o);
      const dir = window.Capacitor.getPlatform() === 'android' ? 'EXTERNAL' : 'DOCUMENTS';
      await call('writeFile', { path: 'recordings/selftest/chunks/.tmp_000000.webm', data: btoa('hello'), directory: dir, recursive: true });
      await call('rename', { from: 'recordings/selftest/chunks/.tmp_000000.webm', to: 'recordings/selftest/chunks/chunk_000000.webm', directory: dir, toDirectory: dir });
      const st = await call('stat', { path: 'recordings/selftest/chunks/chunk_000000.webm', directory: dir });
      const rd = await call('readdir', { path: 'recordings/selftest/chunks', directory: dir });
      let missingErr = null;
      try { await call('stat', { path: 'recordings/nope', directory: dir }); } catch (e) { missingErr = e.message; }
      return { size: st.size, names: rd.files.map(f => f.name), missingErr };
    }).catch(e => ({ error: e.message }));
    notes.push(`filesystem round-trip: ${JSON.stringify(fsr)}`);
    if (fsr.error || fsr.size !== 5 || JSON.stringify(fsr.names) !== '["chunk_000000.webm"]' || !fsr.missingErr) {
      problems.push(`filesystem semantics wrong: ${JSON.stringify(fsr)}`);
    }
    if (!device.find('recordings/selftest/chunks/chunk_000000.webm')) problems.push('bridge write did not reach the device file system');
    const prefs = await app.evalTimed(() => Object.keys(localStorage).filter(k => k.startsWith('CapacitorStorage.')).length);
    notes.push(`preferences persisted: ${prefs} keys`);
    if (!mock.state.requests.some(r => r.url === '/api/auth/desktop')) problems.push('login never reached the (mocked) backend');
    const disk = await app.evalTimed(async () => { const r = await window.Capacitor.nativePromise('Device', 'getInfo', {}); return r.realDiskFree; });
    if (!(disk > 0)) problems.push('Device.getInfo has no realDiskFree');
    const errors = app.console.filter(l => /^\[error\]|pageerror/.test(l) && !/sentry|favicon/i.test(l));
    notes.push(`console errors: ${errors.length}${errors.length ? ' — ' + errors.slice(0, 3).join(' | ').slice(0, 300) : ''}`);
    // Rebrand guard: no old product name in visible text, no old domain in links.
    const brand = [];
    for (const route of ['/record', '/history', '/device', '/settings', '/about']) {
      await app.navigate(route);
      await sleep(1500);
      const hit = await app.evalTimed(() => ({
        name: ((document.body.innerText || '').match(/suisse\s*notes/i) || [])[0] || null,
        link: [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).find(h => /suisse-notes\.ch/i.test(h || '')) || null
      }));
      if (hit.name || hit.link) brand.push(`${route}: ${[hit.name, hit.link].filter(Boolean).join(' ')}`);
    }
    notes.push(`rebrand guard on /record /history /device /settings /about: ${brand.length ? brand.join('; ') : 'clean'}`);
    if (brand.length) problems.push(`old brand still visible: ${brand.join('; ')}`);
    return { pass: problems.length === 0, problems, notes };
  });
}

async function m1Baseline() {
  const sc = buildScenario('m1', [{ type: 'speech', seconds: 90 }]);
  return withApp('m1-baseline', { scenario: sc }, async (app, mock, device) => {
    await app.startRecording();
    await sleep(85_000);
    await app.stopRecording();
    await app.waitForPhase(['uploaded', 'idle'], 180_000);
    const v = verifyCombined(device, sc, { tailLossMaxS: 8 });
    const ups = uploadsOf(mock);
    v.notes.push(`upload attempts: ${ups.length}`);
    if (ups.length !== 1) v.problems.push(`Expected exactly 1 upload attempt, saw ${ups.length}`);
    const hist = await app.getHistory();
    const rec = hist.find(r => r.uploadStatus === 'uploaded' || r.uploadStatus === 'pending_verification');
    if (!rec) v.problems.push(`history has no uploaded entry (statuses: ${hist.map(r => r.uploadStatus).join(',')})`);
    else v.notes.push(`history: ${rec.uploadStatus}, audioFileId=${rec.audioFileId}, filePath=${rec.filePath}`);
    if (rec && !rec.filePath) v.problems.push('local audio path missing although the default preference is "keep"');
    v.pass = v.problems.length === 0;
    return v;
  });
}

async function m2Endurance() {
  const minutes = parseInt(flag('--minutes', '315'), 10);
  const total = minutes * 60;
  // Talk blocks with faint room-tone breaks, like the desktop s7 plan.
  const plan = [];
  let left = total;
  while (left > 0) {
    const speech = Math.min(4200, left); plan.push({ type: 'speech', seconds: speech }); left -= speech;
    if (left > 0) { const br = Math.min(700, left); plan.push({ type: 'noise', seconds: br }); left -= br; }
  }
  console.log(`m2: building ${minutes} min scenario audio…`);
  const sc = buildScenario(`m2-${minutes}`, plan);
  return withApp('m2-endurance', { scenario: sc }, async (app, mock, device) => {
    const problems = [], notes = [];
    const progressFile = path.join(WORK_DIR, 'm2-progress.jsonl');
    fs.writeFileSync(progressFile, '');
    await app.startRecording();
    const t0 = Date.now();
    let dead = false;
    while (Date.now() - t0 < total * 1000 - 5000) {
      await sleep(30_000);
      const tSec = Math.round((Date.now() - t0) / 1000);
      let phase = null, chunks = 0, heap = null;
      try { phase = await app.getPhase(); } catch { dead = true; }
      try { chunks = device.chunkCount(await app.getRecordId()); } catch { /* ignore */ }
      try { heap = await app.evalTimed(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null); } catch { /* ignore */ }
      fs.appendFileSync(progressFile, JSON.stringify({ t: tSec, phase, chunks, heapMB: heap }) + '\n');
      if (phase !== 'recording' && phase !== 'paused') { problems.push(`recording phase left unexpectedly at t=${tSec}s (phase=${phase})`); break; }
    }
    if (dead) problems.push('APP DIED — page unresponsive');
    await app.stopRecording(120_000).catch(e => problems.push(`stop failed: ${e.message}`));
    const phase = await app.waitForPhase(['uploaded', 'idle'], 900_000).catch(() => null);
    notes.push(`final phase=${phase}`);
    const v = verifyCombined(device, sc, { tailLossMaxS: 20, ignoreSegmentLevels: true });
    problems.push(...v.problems); notes.push(...v.notes);
    const ups = uploadsOf(mock);
    notes.push(`upload attempts: ${ups.length}`);
    if (ups.length !== 1) problems.push(`Expected exactly 1 upload, saw ${ups.length}`);
    return { pass: problems.length === 0, problems, notes };
  });
}

async function m3Resilience() {
  const sc = buildScenario('m3', [{ type: 'speech', seconds: 40 }]);
  const runs = [['upload-500-once', 'transient 500 then success'], ['upload-401-once', 'expired token then refresh+success'], ['upload-cut-50', 'socket cut mid-body then success']];
  const problems = [], notes = [];
  for (const [mode, label] of runs) {
    const ok = await withApp(`m3-${mode}`, { scenario: sc, mockMode: mode }, async (app, mock) => {
      await app.startRecording();
      await sleep(35_000);
      await app.stopRecording();
      // A transient failure hands the file to the persistent upload queue,
      // which retries on its 60 s timer — judge by the history entry.
      const done = await app.waitFor(async () => {
        const hist = await app.getHistory();
        return hist.find(r => r.uploadStatus === 'uploaded' || r.uploadStatus === 'pending_verification') || null;
      }, { timeoutMs: 300_000, every: 2000, label: 'upload completion' }).catch(() => null);
      const ups = uploadsOf(mock);
      const hist = await app.getHistory();
      const p = [];
      if (ups.length < 2) p.push(`${label}: expected a retry (>=2 attempts), saw ${ups.length}`);
      if (!done) p.push(`${label}: history never reached uploaded (${hist.map(r => `${r.uploadStatus}/${r.uploadError || ''}`).join(',')})`);
      const phase = await app.getPhase();
      return { pass: p.length === 0, problems: p, notes: [`${label}: ${ups.length} attempts, final record-page phase=${phase}`] };
    });
    if (!ok) problems.push(`${label} FAILED`); else notes.push(`${label} OK`);
  }
  return report('m3-resilience-summary', { pass: problems.length === 0, problems, notes });
}

async function m4DeleteAfterUpload() {
  const sc = buildScenario('m4', [{ type: 'speech', seconds: 40 }]);
  return withApp('m4-delete-after-upload', { scenario: sc }, async (app, mock, device) => {
    const problems = [], notes = [];
    // The Settings choice, set through the store action the settings page calls.
    await app.evalTimed(async () => {
      const pinia = window.__harness.pinia();
      const store = pinia._s.get('recordings-history') || pinia._s.get('recordingsHistory');
      await store.setDefaultStoragePreference('delete_after_upload');
    });
    const pref = await app.store('recordings-history', 'defaultStoragePreference');
    notes.push(`preference: ${pref}`);
    if (pref !== 'delete_after_upload') problems.push(`preference not applied (${pref})`);
    await app.startRecording();
    await sleep(35_000);
    await app.stopRecording();
    await app.waitForPhase(['uploaded', 'idle'], 180_000);
    const recordId = await app.getRecordId();
    const combined = device.findCombined();
    notes.push(`combined after upload: ${combined ? path.relative(device.fsRoot, combined) : 'none'}`);
    // The record page defers the deletion by 30 s after the verified upload.
    const gone = await app.waitFor(async () => {
      const hist = await app.getHistory();
      const rec = hist.find(r => r.uploadStatus === 'uploaded' && r.audioFileId);
      const fileGone = !device.findCombined();
      const chunksGone = !device.find(`recordings/${recordId}`);
      return rec && !rec.filePath && fileGone && chunksGone ? { rec, fileGone, chunksGone } : null;
    }, { timeoutMs: 90_000, label: 'local audio deleted after the verified upload' }).catch(() => null);
    if (!gone) {
      const hist = await app.getHistory();
      problems.push(`local audio still on the phone after upload (history: ${JSON.stringify(hist.map(r => ({ s: r.uploadStatus, f: r.filePath })))}, combined=${!!device.findCombined()}, dir=${!!device.find(`recordings/${recordId}`)})`);
    } else {
      notes.push(`history entry kept: status=${gone.rec.uploadStatus} audioFileId=${gone.rec.audioFileId} filePath=${gone.rec.filePath} localAudioDeletedAt=${gone.rec.localAudioDeletedAt}`);
    }
    return { pass: problems.length === 0, problems, notes };
  });
}

async function m5RecorderSync() {
  const recorder = {
    poweredOn: true,
    files: [
      { file: 'R20260901-090000.opus', size: 96_000, seed: 11 },
      { file: 'R20260901-100000.opus', size: 0, seed: 12 },              // empty on the card
      { file: 'R20260901-110000.opus', size: 64_000, seed: 13 },         // corrupted once, then fine
      { file: 'R20260901-120000.opus', size: 128_000, seed: 14 }         // link drops mid-transfer once
    ],
    faults: { corruptFirstAttempts: { 'R20260901-110000.opus': 1 }, dropLinkOnce: { 'R20260901-120000.opus': true } }
  };
  return withApp('m5-recorder-sync', { recorder }, async (app, mock, device) => {
    const problems = [], notes = [];
    const uploadsDir = path.join(WORK_DIR, 'uploads', 'm5-recorder-sync');
    app.autoSkipPrep(true);

    // ---- pair through the device page ----
    await app.navigate('/device');
    await app.clickByTest('[data-test=device-scan]');
    await app.clickByTest('[data-test=device-scan-result]', 30_000);
    const dev = await app.waitFor(async () => { const d = await app.getDeviceState(); return d?.connectionState === 'connected' ? d : null; }, { timeoutMs: 60_000, label: 'pairing' })
      .catch(async (e) => { const d = await app.getDeviceState(); const rlog = await app.recorder('return r.log.slice(-15)'); throw new Error(`${e.message}; store=${d?.connectionState} error=${d?.error}; recorder=${JSON.stringify(rlog)}`); });
    notes.push(`paired: ${dev.deviceName} SN=${dev.deviceSN}`);
    // The card is busy for a while right after pairing (as after a device recording).
    await app.recorder('r.setBusy(a)', 6000);

    // ---- auto-sync: every non-empty file must arrive byte-identical ----
    const expectSynced = ['R20260901-090000.opus', 'R20260901-110000.opus', 'R20260901-120000.opus'];
    // Watch what the app makes of the recorder's file list: a list that comes
    // back with duplicates or missing entries makes recordings unfindable.
    const listSamples = [];
    const listWatch = setInterval(async () => {
      try {
        const d = await app.getDeviceState();
        const names = (d?.deviceFiles || []).map(f => f.file);
        const last = listSamples[listSamples.length - 1];
        if (!last || last.join('|') !== names.join('|')) listSamples.push(names);
      } catch { /* navigating */ }
    }, 1500);
    const synced = await app.waitFor(async () => {
      const d = await app.getDeviceState();
      return expectSynced.every(f => d.syncedFiles.includes(f)) && d.skippedFiles.includes('R20260901-100000.opus') ? d : null;
    }, { timeoutMs: 240_000, every: 2000, label: 'auto-sync of all files' }).catch(async () => {
      const d = await app.getDeviceState();
      notes.push(`device state at timeout: conn=${d.connectionState} sync=${d.syncState}/${d.syncError} phase=${d.syncPhase} files=${d.deviceFiles.map(f => f.file).join(',')} synced=${d.syncedFiles} skipped=${d.skippedFiles} tick=${d._pollTick} refresh=${d._listRefreshRequested} pollInProgress=${d._pollInProgress} timer=${d._autoSyncTimer != null} recOnDevice=${d.isRecordingOnDevice} reconnInProg=${d._reconnectInProgress}`);
      const rlog = await app.recorder('return r.log.map(l => Math.round((l.t - r.log[0].t) / 1000) + "s " + l.msg)');
      notes.push(`recorder log: ${rlog.join(' | ')}`);
      return null;
    });
    if (!synced) problems.push('auto-sync did not finish: not every file was synced/skipped as expected');

    clearInterval(listWatch);
    for (const names of listSamples) {
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      if (dupes.length) problems.push(`file list came back with duplicate entries: [${names.join(', ')}]`);
    }
    notes.push(`file-list samples: ${listSamples.map(n => `[${n.join(',')}]`).join(' → ')}`);
    const hist = await app.getHistory();
    const devRecs = hist.filter(r => r.source === 'device');
    notes.push(`device history entries: ${devRecs.length} — ${devRecs.map(r => `${r.deviceFilename}:${r.uploadStatus}`).join(', ')}`);
    const names = devRecs.map(r => r.deviceFilename);
    if (new Set(names).size !== names.length) problems.push(`duplicate history entries: ${names.join(',')}`);
    for (const f of recorder.files) if (!names.includes(f.file)) problems.push(`history is missing ${f.file}`);
    const empty = devRecs.find(r => r.deviceFilename === 'R20260901-100000.opus');
    if (!empty || empty.uploadStatus !== 'skipped' || empty.uploadError !== 'EMPTY_FILE') problems.push(`empty file not skipped with EMPTY_FILE (${JSON.stringify(empty && { s: empty.uploadStatus, e: empty.uploadError })})`);

    // bytes on the server == bytes on the recorder
    const uploaded = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).filter(n => n.endsWith('.bin')) : [];
    notes.push(`captured uploads: ${uploaded.length}`);
    const serverHashes = new Set(uploaded.map(n => sha256(fs.readFileSync(path.join(uploadsDir, n)))));
    for (const f of expectSynced) {
      const b64 = await app.recorder('return r.fileBase64(a)', f);
      const h = sha256(Buffer.from(b64, 'base64'));
      if (!serverHashes.has(h)) problems.push(`server never received the exact bytes of ${f}`);
    }
    const rstats = await app.recorder('return r.stats');
    notes.push(`recorder stats: ${JSON.stringify(rstats)}, attempts: ${JSON.stringify(await app.recorder('return r.attempts'))}`);
    notes.push(`pre-meeting prompts answered: ${app.prepPrompts} (once per file that reaches the prep phase)`);
    if (app.prepPrompts < 1) problems.push('the pre-meeting prompt never appeared for a synced device file');
    if (app.prepPrompts > recorder.files.length + 2) problems.push(`pre-meeting prompt shown ${app.prepPrompts} times for ${recorder.files.length} files — re-prompting`);
    if ((await app.recorder('return r.attempts["R20260901-110000.opus"]')) < 2) problems.push('corrupted transfer was not retried');

    // ---- recording made on the recorder while connected → picked up ----
    await app.recorder('r.pressRecord()');
    await sleep(3000);
    const newFile = await app.recorder('return r.stopRecord({ size: 40000 })');
    const picked = await app.waitFor(async () => { const d = await app.getDeviceState(); return d.syncedFiles.includes(newFile.file) ? d : null; }, { timeoutMs: 120_000, every: 2000, label: 'button recording auto-sync' }).catch(() => null);
    if (!picked) problems.push(`recording made with the recorder's button (${newFile.file}) was not synced automatically`);
    else notes.push(`button recording ${newFile.file} synced`);

    // ---- cancel a transfer: the entry stays as skipped ----
    await app.recorder('r.addFile({ file: "R20260901-130000.opus", size: 4000000, seed: 99 })');
    await app.clickByTest('[data-test=device-sync-all]', 60_000).catch(() => {});
    const downloading = await app.waitFor(async () => { const d = await app.getDeviceState(); return d.currentSyncFile === 'R20260901-130000.opus' && d.syncPhase === 'downloading' ? d : null; }, { timeoutMs: 60_000, every: 300, label: 'download in progress' }).catch(() => null);
    if (!downloading) problems.push('could not observe the transfer to cancel');
    else {
      await app.clickByTest('[data-test=device-cancel-current]', 5_000).catch(async () => app.evalTimed(() => window.__harness.pinia()._s.get('device').cancelCurrentFile()));
      const cancelled = await app.waitFor(async () => { const d = await app.getDeviceState(); return d.skippedFiles.includes('R20260901-130000.opus') ? d : null; }, { timeoutMs: 60_000, label: 'cancelled file marked skipped' }).catch(() => null);
      const h2 = await app.getHistory();
      const rec = h2.find(r => r.deviceFilename === 'R20260901-130000.opus');
      if (!cancelled || !rec || rec.uploadStatus !== 'skipped') problems.push(`cancelled transfer did not stay as a skipped entry (${JSON.stringify(rec && { s: rec.uploadStatus, f: rec.filePath })})`);
      else notes.push('cancelled transfer kept as skipped entry');
    }

    // ---- unpair through the menu ----
    await app.clickByTest('[data-test=device-menu]');
    await app.clickByTest('[data-test=device-forget]');
    await app.page.evaluate(() => { const b = [...document.querySelectorAll('.q-dialog .q-btn')].find(x => /vergessen|forget|oublier|dimentica/i.test(x.textContent || '')); if (b) b.click(); });
    const unpaired = await app.waitFor(async () => { const d = await app.getDeviceState(); const r = await app.recorder('return { bound: r.boundAppUuid, connected: r.connected, unpairs: r.stats.unpairs }'); return !d.pairedDevice && r.unpairs === 1 && !r.bound ? r : null; }, { timeoutMs: 30_000, label: 'unpair' }).catch(() => null);
    if (!unpaired) problems.push('forget device did not unpair the recorder (unpair command + binding cleared)');
    else notes.push('unpaired: recorder binding cleared, no reconnect loop');
    const notif = await app.harness('return h.state.notifications.length');
    notes.push(`local notifications shown: ${notif}`);
    return { pass: problems.length === 0, problems, notes };
  });
}

async function m6CrashRecovery() {
  const sc = buildScenario('m6', [{ type: 'speech', seconds: 120 }]);
  return withApp('m6-crash-recovery', { scenario: sc }, async (app, mock, device) => {
    const problems = [], notes = [];
    await app.startRecording();
    await sleep(60_000);
    const recordId = await app.getRecordId();
    const chunksBefore = device.chunkCount(recordId);
    notes.push(`chunks on disk before the kill: ${chunksBefore}`);
    // The OS kills the app: no stop, no combine. Relaunch on the same phone.
    await app.kill();
    await app.relaunch();
    await app.login();
    const recovered = await app.waitFor(async () => {
      const hist = await app.getHistory();
      const rec = hist.find(r => r.id === recordId);
      return rec && rec.filePath ? rec : null;
    }, { timeoutMs: 120_000, every: 2000, label: 'recovery of the interrupted recording' }).catch(() => null);
    if (!recovered) { problems.push('recovery produced no combined recording after the app was killed mid-recording'); return { pass: false, problems, notes }; }
    notes.push(`recovered: status=${recovered.uploadStatus} path=${recovered.filePath}`);
    const out = device.find(recovered.filePath);
    if (!out) problems.push(`recovered file not on disk: ${recovered.filePath}`);
    else {
      const v = verdict(out, { ...sc, totalSeconds: 60 }, { tailLossMaxS: 10, expectedDurationS: 60 });
      problems.push(...v.problems); notes.push(...v.notes);
    }
    const uploaded = await app.waitFor(async () => { const h = await app.getHistory(); const r = h.find(x => x.id === recordId); return r && (r.uploadStatus === 'uploaded' || r.uploadStatus === 'pending_verification') ? r : null; }, { timeoutMs: 180_000, every: 2000, label: 'upload of the recovered recording' }).catch(() => null);
    if (!uploaded) problems.push('recovered recording was not uploaded automatically');
    return { pass: problems.length === 0, problems, notes };
  });
}

async function m7Repair() {
  // The recorder is bound to the UUID this user's app derives from the user id
  // (what a previous install of 3.9.37+ would have registered).
  const recorder = { poweredOn: true, files: [{ file: 'R20260902-090000.opus', size: 20_000, seed: 21 }], boundAppUuid: null };
  const repairOk = await withApp('m7-repair', { recorder }, async (app) => {
    const problems = [], notes = [];
    await app.navigate('/device');
    await app.clickByTest('[data-test=device-scan]');
    await app.clickByTest('[data-test=device-scan-result]', 30_000);
    await app.waitFor(async () => (await app.getDeviceState())?.connectionState === 'connected', { timeoutMs: 60_000, label: 'first pairing' });
    const bound = await app.recorder('return r.boundAppUuid');
    notes.push(`recorder bound to ${bound}`);
    // Reinstall: every app preference gone, recorder keeps its binding.
    await app.evalTimed(() => localStorage.clear());
    await app.relaunch();
    await app.login();
    await app.navigate('/device');
    await app.clickByTest('[data-test=device-scan]');
    await app.clickByTest('[data-test=device-scan-result]', 30_000);
    const again = await app.waitFor(async () => (await app.getDeviceState())?.connectionState === 'connected', { timeoutMs: 60_000, label: 'pairing after reinstall' }).catch(() => false);
    const stats = await app.recorder('return r.stats');
    const boundAfter = await app.recorder('return r.boundAppUuid');
    notes.push(`handshakes=${stats.handshakes} rejected=${stats.rejectedHandshakes} bound after reinstall=${boundAfter}`);
    if (!again) problems.push(`re-pairing after a reinstall failed (error: ${(await app.getDeviceState())?.error})`);
    if (boundAfter !== bound) problems.push('the recorder was re-bound instead of accepting the same app identity');
    if (stats.handshakes < 2 || stats.rejectedHandshakes !== 0) problems.push(`expected 2 accepted handshakes, got ${JSON.stringify(stats)}`);
    return { pass: problems.length === 0, problems, notes };
  });
  // Sequential: both scenarios bind the same mock port.
  const foreignOk = await m7ForeignApp();
  return repairOk && foreignOk;
}

/** Control: a recorder bound to ANOTHER installation must be refused with the actionable message. */
async function m7ForeignApp() {
  const recorder = { poweredOn: true, fresh: true, files: [], boundAppUuid: 'ffffffff-0000-4000-8000-000000000001' };
  return withApp('m7-foreign-app', { recorder }, async (app) => {
    const problems = [], notes = [];
    await app.navigate('/device');
    await app.clickByTest('[data-test=device-scan]');
    await app.clickByTest('[data-test=device-scan-result]', 30_000);
    const state = await app.waitFor(async () => { const d = await app.getDeviceState(); return d?.error ? d : null; }, { timeoutMs: 60_000, label: 'pairing refusal' }).catch(() => null);
    const stats = await app.recorder('return r.stats');
    notes.push(`state=${state?.connectionState} error=${state?.error} handshakes=${JSON.stringify(stats)}`);
    if (!state || !/rejected pairing|paired/i.test(state.error || '')) problems.push('a recorder bound to another installation was not reported as such');
    if (state?.connectionState === 'connected') problems.push('connected to a recorder that rejected the pairing');
    if (state?.pairedDevice) problems.push('a refused recorder was saved as paired');
    return { pass: problems.length === 0, problems, notes };
  });
}

/**
 * Every kind of error must reach Sentry — in the real bundle, through the real
 * SDK transport — with the right release, redacted, sampled under a flood,
 * queued while offline and reported after the app was killed on screen.
 */
async function m8SentryCapture() {
  // Triggers live in a regular page script: Chrome treats code compiled by a
  // DevTools evaluation as cross-origin ("muted") and never dispatches window
  // error / unhandledrejection events for it — a real app error is not muted.
  const hooks = () => {
    window.__mh = {
      throwLater(msg) { setTimeout(() => { throw new Error(msg); }, 0); },
      rejectLater(msg) { setTimeout(() => { Promise.reject(new Error(msg)); }, 0); }
    };
  };
  return withApp('m8-sentry-capture', { initScripts: [hooks] }, async (app) => {
    const problems = [], notes = [];
    const expectedRelease = `ch.suissenotes.mobile@${GRADLE_VERSION_NAME}`;
    const waitEvent = (label, re, timeoutMs = 30_000) =>
      app.waitFor(async () => (app.findSentryEvents(re).length ? app.findSentryEvents(re) : null), { timeoutMs, every: 500, label }).catch(() => null);

    // Let the boot settle, then trigger each capture path from inside the page.
    await sleep(3000);
    notes.push(`rejection handler: ${await app.evalTimed(() => `${typeof window.onunhandledrejection} instrumented=${!!window.onunhandledrejection?.__SENTRY_INSTRUMENTED__} src=${String(window.onunhandledrejection).slice(0, 120)}`)}`);
    await app.evalTimed(() => { window.__mh.throwLater('mh-uncaught-window-error'); return true; });
    await app.evalTimed(() => { window.__mh.rejectLater('mh-unhandled-rejection'); return true; });
    await app.evalTimed(() => {
      console.error('mh: upload step failed', new Error('mh-console-error-object'));
      console.error('mh-console-error-text for record 4711');
      console.warn('mh-console-warn: keepalive failed');
    });
    await app.evalTimed(() => {
      const vueApp = document.querySelector('#q-app')?.__vue_app__;
      if (!vueApp?.config?.errorHandler) return 'no vue error handler installed';
      try {
        vueApp.config.errorHandler(new Error('mh-vue-component-error'), null, 'harness hook');
      } catch (e) {
        // Sentry's handler captures, then rethrows for Vue to log when the app has no own handler.
        if (e?.message !== 'mh-vue-component-error') return `handler threw: ${e?.message}`;
      }
      return 'ok';
    }).then((r) => { if (r !== 'ok') problems.push(`Vue error handler: ${r}`); });
    await app.evalTimed(async () => {
      for (const s of [500, 404, 413, 401, 402, 409]) await fetch(`https://app.suisse-meets.ch/api/__mh/status/${s}`).catch(() => null);
      return true;
    });

    const expectations = [
      ['uncaught window error', /mh-uncaught-window-error/],
      ['unhandled promise rejection', /mh-unhandled-rejection/],
      ['console.error with an Error', /mh-console-error-object/],
      ['console.error with text', /mh-console-error-text/],
      ['console.warn', /mh-console-warn/],
      ['Vue component error', /mh-vue-component-error/],
      ['HTTP 500 answer', /status code: 500/],
      ['HTTP 404 answer', /status code: 404/],
      ['HTTP 413 answer', /status code: 413/]
    ];
    for (const [label, re] of expectations) {
      const hit = await waitEvent(label, re, 20_000);
      if (!hit) problems.push(`NOT captured: ${label}`);
    }
    await sleep(2000);
    for (const s of [401, 402, 409]) {
      if (app.findSentryEvents(new RegExp(`status code: ${s}\\b`)).length) problems.push(`HTTP ${s} is part of normal operation but was captured`);
    }
    const warn = app.findSentryEvents(/mh-console-warn/)[0];
    if (warn && warn.level !== 'warning') problems.push(`console.warn captured with level ${warn.level}`);
    const http500 = app.findSentryEvents(/status code: 500/)[0];
    if (http500 && http500.exception?.values?.[0]?.mechanism?.handled !== true) problems.push('HTTP 500 counted as an unhandled crash');

    // Flood: 60 identical failures → the first 5, then 8th, 16th, 32nd.
    await app.evalTimed(() => { for (let i = 0; i < 60; i++) console.error(`mh-flood tick ${i}`); });
    await sleep(4000);
    const flood = app.findSentryEvents(/mh-flood tick/).length;
    notes.push(`flood of 60 identical errors → ${flood} events`);
    if (flood < 5 || flood > 9) problems.push(`flood sampling wrong: ${flood} events for 60 occurrences (expected 8)`);

    // Offline: ingest unreachable → queued → delivered after reconnect.
    app.sentryOffline = true;
    await app.evalTimed(() => { console.error('mh-offline-error while the phone has no network'); });
    await sleep(4000);
    const leaked = app.findSentryEvents(/mh-offline-error/).length;
    app.sentryOffline = false;
    await app.evalTimed(() => { window.dispatchEvent(new Event('online')); });
    const offline = await waitEvent('offline event after reconnect', /mh-offline-error/, 60_000);
    notes.push(`offline event: ${leaked ? 'delivered while offline (test invalid)' : (offline ? 'queued, delivered after reconnect' : 'LOST')}`);
    if (!offline) problems.push('an error raised offline never reached Sentry (offline queue missing)');

    // Release, environment, dist and redaction on everything captured so far.
    const events = app.sentryEvents();
    const wrongRelease = events.filter(e => e.release !== expectedRelease);
    if (wrongRelease.length) problems.push(`${wrongRelease.length} event(s) with release ${[...new Set(wrongRelease.map(e => e.release))].join(',')} (expected ${expectedRelease})`);
    if (events.some(e => e.environment !== 'production')) problems.push('event environment is not production');
    if (events.some(e => e.dist !== PLATFORM)) problems.push(`event dist is not ${PLATFORM}`);
    const raw = app.sentryEnvelopes.map(e => e.raw).join('\n');
    if (/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/.test(raw) || /Bearer\s+[A-Za-z0-9._-]{8,}/.test(raw)) problems.push('a token left the phone inside a Sentry envelope');

    // Unclean exit: killed while on screen → reported once on the next launch;
    // an error raised during that boot is captured too.
    const bootError = () => {
      document.addEventListener('DOMContentLoaded', () => { Promise.reject(new Error('mh-error-during-boot')); });
    };
    app.initScripts.push(bootError);
    await sleep(1500);
    await app.kill();
    await app.relaunch();
    await app.login();
    const unclean = await waitEvent('unclean-exit report', /previous session ended unexpectedly/, 60_000);
    if (!unclean) problems.push('an app killed on screen was not reported on the next launch');
    else notes.push(`unclean exit reported: ${JSON.stringify(unclean[0].contexts?.previous_session || {})}`);
    const bootErr = await waitEvent('error during boot', /mh-error-during-boot/, 30_000);
    if (!bootErr) problems.push('an error raised during boot was not captured');
    else notes.push(`boot error captured via ${bootErr[0].tags?.phase === 'boot' ? 'early buffer' : 'global handler'}`);

    // Control: leaving the screen normally, then killed in the background → nothing reported.
    app.initScripts.splice(app.initScripts.indexOf(bootError), 1);
    await app.harness('h.setAppActive(false); return true');
    // Chromium commits localStorage to disk in batches (~5 s); a phone's
    // Preferences write is immediate. Let the commit happen before the kill.
    await sleep(7000);
    const uncleanBefore = app.findSentryEvents(/previous session ended unexpectedly/).length;
    await app.kill();
    await app.relaunch();
    await app.login();
    await sleep(8000);
    const uncleanAfter = app.findSentryEvents(/previous session ended unexpectedly/).length;
    if (uncleanAfter !== uncleanBefore) problems.push('a normal background kill was reported as an unclean exit');

    const titles = [...new Set(app.sentryEvents().map(e => `${e.level}: ${sentryEventText(e).slice(0, 90)}`))];
    notes.push(`distinct events captured (${titles.length}): ${titles.filter(t => !/mh-|status code/.test(t)).slice(0, 12).join(' || ') || 'only the triggered ones'}`);
    return { pass: problems.length === 0, problems, notes };
  });
}

const SCENARIOS = {
  'm0-selftest': m0Selftest,
  'm1-baseline': m1Baseline,
  'm2-endurance': m2Endurance,
  'm3-resilience': m3Resilience,
  'm4-delete-after-upload': m4DeleteAfterUpload,
  'm5-recorder-sync': m5RecorderSync,
  'm6-crash-recovery': m6CrashRecovery,
  'm7-repair': m7Repair,
  'm8-sentry-capture': m8SentryCapture
};

(async () => {
  const name = argv.find(a => !a.startsWith('--') && !/^\d+$/.test(a) && !['android', 'ios'].includes(a));
  if (!name || (!SCENARIOS[name] && name !== 'all')) {
    console.log(`Usage: node tests/mobile-harness/run.js <${Object.keys(SCENARIOS).join('|')}|all> [--platform android|ios] [--minutes N] [--headful]`);
    process.exit(2);
  }
  const list = name === 'all' ? Object.keys(SCENARIOS).filter(s => s !== 'm2-endurance') : [name];
  let allPass = true;
  for (const s of list) {
    try { if (!(await SCENARIOS[s]())) allPass = false; }
    catch (e) { console.error(`Scenario ${s} crashed:`, e); allPass = false; }
  }
  process.exit(allPass ? 0 : 1);
})();
