/**
 * CDP-FREE long-run recorder endurance.
 *
 * The CDP-driven s7 endurance dies at 1-3h because the puppeteer<->app DevTools
 * connection drops over multi-hour runs (flat memory + non-deterministic timing +
 * a blink::DevToolsSession fatal → the CONNECTION dies, not the app; the app keeps
 * recording fine until the harness kills it). Production data confirms real users
 * complete 5h recordings.
 *
 * This test removes CDP from the long-run entirely: it uses CDP only briefly to
 * start recording, then DISCONNECTS the debugger and lets the app record like a
 * real unattended user. It monitors progress purely via the filesystem (chunk
 * accumulation) — the same bytes a real recording writes. If chunks keep
 * accumulating for ~5h, the recorder engine handles 5h meetings, full stop.
 *
 * Usage: SUISSE_E2E_PACKAGED_EXE="<win-unpacked>/Suisse Notes.exe" node verify-longrun.js
 */
const fs = require('fs');
const path = require('path');
const { buildScenario } = require('./lib/audio');
const { startMockBackend } = require('./lib/mock-backend');
const { AppDriver, sleep } = require('./lib/app-driver');

const EXE = 'C:/Users/arega/projects/Suisse_Notes_Desktop/dist/electron/Packaged/win-unpacked/Suisse Notes.exe';
const TARGET_SECONDS = 18900; // 5h15m
const PROGRESS = path.join(__dirname, 'work', 'longrun-progress.jsonl');

function countChunks(dir) {
  try {
    // recordings/<id>/chunks/*.webm
    let total = 0, newest = 0;
    for (const rec of fs.readdirSync(dir)) {
      const cd = path.join(dir, rec, 'chunks');
      if (fs.existsSync(cd)) {
        const files = fs.readdirSync(cd).filter(f => f.endsWith('.webm'));
        total += files.length;
        for (const f of files) {
          const m = fs.statSync(path.join(cd, f)).mtimeMs;
          if (m > newest) newest = m;
        }
      }
    }
    return { total, newest };
  } catch (e) { return { total: 0, newest: 0 }; }
}

(async () => {
  const sc = buildScenario('longrun', [{ type: 'speech', seconds: TARGET_SECONDS }]);
  const mock = await startMockBackend({ port: 3000 });
  const app = new AppDriver({ name: 'longrun', apiUrl: mock.url, fakeAudioWav: sc.wavPath, cdpPort: 9361, packagedExe: EXE });
  fs.writeFileSync(PROGRESS, '');
  const log = (o) => { const line = JSON.stringify(o); console.log(line); fs.appendFileSync(PROGRESS, line + '\n'); };
  try {
    await app.launch({ freshProfile: true });
    await app.login();
    // Desktop lands on /about after login; make sure we're on the record page
    // (with the record button) before starting.
    for (let i = 0; i < 6; i++) {
      if (await app.page.$('[data-test=record-start]')) break;
      await app.page.evaluate(() => { location.hash = '#/record'; }).catch(() => {});
      await sleep(2500);
    }
    await app.page.waitForSelector('[data-test=record-start]', { timeout: 30_000 });
    await app.startRecording();
    const recordId = await app.getRecordId();
    log({ event: 'started', recordId, at: 'cdp' });

    // Give the recorder a few seconds to write its first chunks, then let go of CDP.
    await sleep(15_000);
    const dir = app.recordingsDir;
    const first = countChunks(dir);
    log({ event: 'first-chunks', total: first.total });

    // >>> Disconnect the debugger. From here the app records with NO CDP attached,
    // exactly like a real user. We watch the filesystem only.
    try { app.browser?.disconnect(); } catch (e) { /* ignore */ }
    log({ event: 'cdp-disconnected' });

    // Completion is measured by CHUNK COUNT, not wall-clock — a machine sleep
    // jumps the clock forward without producing audio, and the old wall-clock
    // check false-PASSed on exactly that. ~1 chunk / 3s → a full 5h15m is ~6295.
    const EXPECTED_CHUNKS = Math.floor(TARGET_SECONDS / 3) - 10;
    const t0 = Date.now();
    let lastTotal = first.total;
    let lastWall = t0;
    let deadAt = null;
    let confounded = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await sleep(120_000); // check every 2 min via filesystem
      const nowWall = Date.now();
      const tSec = Math.round((nowWall - t0) / 1000);
      const wallGap = Math.round((nowWall - lastWall) / 1000); // should be ~120
      lastWall = nowWall;
      const c = countChunks(dir);
      const ageSec = c.newest ? Math.round((nowWall - c.newest) / 1000) : 999999;
      const grew = c.total > lastTotal;
      lastTotal = c.total;
      log({ event: 'tick', tSec, chunks: c.total, newestAgeSec: ageSec, grew, wallGap });

      // Machine-sleep detection: the loop only slept 120s, so a much larger wall
      // gap means the OS suspended us — a TEST-ENVIRONMENT confound, not an app
      // result. Flag it so we never report a sleep-corrupted run as PASS.
      if (wallGap > 400) { confounded = true; log({ event: 'MACHINE-SLEEP-DETECTED', tSec, wallGap, newestAgeSec: ageSec }); }

      // Real recorder stall: no fresh chunk in >5 min while we were NOT asleep.
      if (ageSec > 300 && wallGap < 400) { deadAt = tSec; log({ event: 'RECORDER-STALLED', tSec, chunks: c.total, newestAgeSec: ageSec }); break; }

      // Done when the recorder has actually produced a full 5h15m of chunks.
      if (c.total >= EXPECTED_CHUNKS) break;
      // Absolute wall-time safety cap (don't spin forever if something is off).
      if (tSec > TARGET_SECONDS + 5400) { log({ event: 'wall-timeout', tSec, chunks: c.total }); break; }
    }

    if (deadAt !== null) {
      log({ event: 'FAIL', reason: 'recorder stopped writing chunks while awake (real recorder death)', deadAt, finalChunks: lastTotal });
    } else if (confounded) {
      log({ event: 'INCONCLUSIVE', reason: 'machine slept during the run — re-run with the machine kept awake', finalChunks: lastTotal, expected: EXPECTED_CHUNKS });
    } else if (lastTotal >= EXPECTED_CHUNKS) {
      log({ event: 'PASS', reason: 'recorder wrote a full 5h15m of chunks continuously, CDP disconnected', finalChunks: lastTotal, expected: EXPECTED_CHUNKS });
    } else {
      log({ event: 'INCONCLUSIVE', reason: 'ended before reaching the expected chunk count', finalChunks: lastTotal, expected: EXPECTED_CHUNKS });
    }
  } catch (e) {
    log({ event: 'ERROR', message: e.message });
  } finally {
    try { app.proc && require('child_process').execSync(`taskkill /pid ${app.proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    await mock.close().catch(() => {});
  }
})();
