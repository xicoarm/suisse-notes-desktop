/**
 * s20-teams-call — a Teams call, simulated end to end, against the real desktop app.
 *
 * Areg, 04.10.2026: "Can we simulate the Teams conversations, with synthetic
 * voices, so everything is tested automatically and nobody has to test by hand
 * before a release?" This is that test. It replaces the manual check "join a
 * Teams call with the Jabra, record with system audio on, listen whether both
 * sides are in it".
 *
 *   1. ms-teams-sim.exe (teams-sim/TeamsSim.cs) stands in for Teams: it holds a
 *      microphone open and plays the far end (Katja, Hedda) on the Windows
 *      COMMUNICATION output — on this laptop that is not the default output, the
 *      exact topology of the 03.10.2026 failure.
 *   2. The desktop app (compiled E2E bundle, isolated profile, local mock backend)
 *      records with system audio ON and the microphone on "Automatisch". The
 *      local speaker (Stefan) is the microphone: Chromium's fake capture device
 *      plays his track. The fake device wears the name of the microphone the
 *      Teams stand-in holds open, so "Automatisch" has to find "the microphone
 *      Microsoft Teams is using" through the real helper and the real choice code.
 *   3. After stop -> save -> upload, lib/teams-call.js proves from the finished
 *      file that every sentence of both sides is there, complete and in order.
 *   Also checked: no silence/routing warning during the call, the upload equals
 *   the local file, the picker said "the microphone Microsoft Teams is using".
 *   4. Where the call output is not the default output, a witness records the
 *      default output during the call (all that Chromium's loopback, the app up
 *      to 4.7.12, could hear): it must carry none of the call. With
 *      SUISSE_TEAMS_CALL_REQUIRE_SPLIT=1 (CI) a run without that topology fails.
 *
 * Runs on Windows with at least one audio output (hosted CI: a virtual cable, see
 * ci/install-virtual-audio.ps1). It plays sound on the communication output;
 * SUISSE_TEAMS_SIM_VOLUME (0..1, default 1) lowers it for local runs without
 * changing what the test proves.
 *
 *   node tests/e2e-harness/run.js teams-call-selftest   verifier sanity, no app
 *   node tests/e2e-harness/run.js s20-teams-call        the call (SUISSE_E2E_APP_DIR)
 *   node tests/e2e-harness/run.js s20-teams-call-live   the call through the real backend
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { FFMPEG, WORK_DIR } = require('./lib/audio');
const { startMockBackend } = require('./lib/mock-backend');
const { AppDriver, sleep } = require('./lib/app-driver');
const tc = require('./lib/teams-call');
const { buildTeamsSim } = require('./teams-sim/build');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYSLOOPBACK = path.join(REPO_ROOT, 'resources', 'sysloopback', 'win-x64', 'sysloopback.exe');

// ---- the verifier must catch what it claims to catch -------------------------------

/** Mixes the two tracks like a recording would, optionally damaged, Opus-coded. */
function syntheticRecording(call, name, { localOffsetS = 0.4, remoteOffsetS = 1.7, dropRemote = false, dropLocal = false, silence = null, shiftRemoteAfterS = null } = {}) {
  const rate = 48000;
  const local = tc.decodeMono(call.localWav, rate);
  const remote = tc.decodeMono(call.remoteWav, rate);
  const length = Math.ceil((Math.max(local.length / rate + localOffsetS, remote.length / rate + remoteOffsetS) + 1.5) * rate);
  const mix = new Float32Array(length);
  if (!dropLocal) local.forEach((v, i) => { mix[i + Math.round(localOffsetS * rate)] += v * 0.7; });
  if (!dropRemote) {
    remote.forEach((v, i) => {
      // A source that loses 600 ms mid-call (everything after it arrives early).
      const shift = shiftRemoteAfterS !== null && i / rate > shiftRemoteAfterS ? -0.6 : 0;
      const at = i + Math.round((remoteOffsetS + shift) * rate);
      if (at >= 0 && at < mix.length) mix[at] += v * 0.5;
    });
  }
  if (silence) mix.fill(0, Math.round(silence[0] * rate), Math.round(silence[1] * rate));
  const dir = path.join(tc.OUT_DIR, 'selftest');
  const wav = path.join(dir, `${name}.wav`);
  const webm = path.join(dir, `${name}.webm`);
  tc.writeWav16(wav, mix, rate);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-b:a', '32k', webm]);
  return webm;
}

async function runTeamsCallSelftest() {
  const call = tc.prepareCall();
  const u4 = call.manifest.utterances.find(u => u.id === 'u4');
  const cases = [
    { name: 'intact', expectPass: true, opts: {} },
    { name: 'meeting-side-missing', expectPass: false, expect: /Meeting \(system audio\) side missing/, opts: { dropRemote: true } },
    { name: 'microphone-side-missing', expectPass: false, expect: /Microphone side missing/, opts: { dropLocal: true } },
    { name: 'gap-inside-sentence', expectPass: false, expect: /u4 .*(not recognisable|audible)/, opts: { silence: [0.4 + u4.start + 1.0, 0.4 + u4.start + 2.2] } },
    { name: 'source-time-jump', expectPass: false, expect: /TIME JUMP|AUDIO GAP/, opts: { shiftRemoteAfterS: 30 } },
  ];
  const problems = [];
  const notes = [];
  for (const c of cases) {
    const verdict = tc.verifyCall(syntheticRecording(call, c.name, c.opts), call);
    const ok = verdict.pass === c.expectPass && (!c.expect || verdict.problems.some(p => c.expect.test(p)));
    notes.push(`${c.name}: ${verdict.pass ? 'pass' : 'fail'} (${verdict.problems.length} problems) — ${ok ? 'as expected' : 'WRONG'}`);
    if (!ok) problems.push(`Verifier self-test "${c.name}" expected ${c.expectPass ? 'pass' : 'a detected defect'}, got: ${verdict.problems.join(' | ') || 'pass'}`);
    if (c.name === 'intact') notes.push(`intact scores: ${verdict.utterances.map(u => `${u.id}=${u.score}/${u.coverage}`).join(' ')}`);
  }
  return { pass: problems.length === 0, problems, notes };
}

// ---- the Teams stand-in ---------------------------------------------------------------

function listDevices(exe) {
  const out = execFileSync(exe, ['--list'], { encoding: 'utf8', timeout: 20_000 });
  return out.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(e => e && e.event === 'device');
}

function startTeamsSim(exe, args) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const events = [];
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch (_) { event = { event: 'raw', text: line }; }
      events.push(event);
      for (const w of [...waiters]) if (w.match(event)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(event); }
    }
  });
  child.stderr.on('data', chunk => events.push({ event: 'stderr', text: chunk.toString('utf8').trim() }));
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return {
    events,
    exited,
    waitFor(name, timeoutMs) {
      const found = events.find(e => e.event === name);
      if (found) return Promise.resolve(found);
      // An error, or for the microphone a mic-error, ends the wait at once.
      const failure = name === 'mic-open' ? ['error', 'mic-error', 'mic-missing'] : ['error'];
      const early = events.find(e => failure.includes(e.event));
      if (early) return Promise.reject(new Error(`Teams stand-in: ${early.event} ${early.message || early.match || ''}`.trim()));
      return new Promise((resolve, reject) => {
        const waiter = {
          match: e => e.event === name || failure.includes(e.event),
          resolve: e => (failure.includes(e.event) ? reject(new Error(`Teams stand-in: ${e.event} ${e.message || e.match || ''}`.trim())) : resolve(e)),
        };
        waiters.push(waiter);
        setTimeout(() => reject(new Error(`Teams stand-in: no "${name}" within ${timeoutMs} ms (${JSON.stringify(events.slice(-3))})`)), timeoutMs);
      });
    },
    send(line) { try { child.stdin.write(line + '\n'); } catch (_) { /* gone */ } },
    async stop() {
      this.send('stop');
      const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
      if (code === 'timeout') { try { child.kill(); } catch (_) { /* gone */ } }
    },
  };
}

// ---- the call ---------------------------------------------------------------------------

/**
 * Runs in the renderer before the app's own code: the fake capture device
 * "Fake Audio Input 1" is listed under the name of the microphone Teams holds
 * open. Nothing else changes — same deviceId, same stream, same capture path.
 */
function relabelFakeMicrophone(teamsMicName) {
  const devices = navigator.mediaDevices;
  const original = devices.enumerateDevices.bind(devices);
  devices.enumerateDevices = async () => (await original()).map(device => {
    if (device.kind !== 'audioinput' || device.label !== 'Fake Audio Input 1') return device;
    return {
      deviceId: device.deviceId, groupId: device.groupId, kind: device.kind, label: teamsMicName,
      toJSON() { return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label }; },
    };
  });
  window.__teamsCallRelabel = teamsMicName;
}

// ---- live: the same call through the real backend and transcription -------------------

const LIVE_API = process.env.SUISSE_LIVE_API_URL || 'https://app.suisse-meets.ch';

async function liveRequest(method, route, { token, body } = {}) {
  const response = await fetch(LIVE_API + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await response.json(); } catch (_) { /* not JSON */ }
  return { status: response.status, json };
}

/**
 * The finished recording went to the real backend: wait for its transcript and
 * check that the words of BOTH sides are in it and that more than one speaker was
 * told apart. On success the test meeting is deleted again (API, owner delete);
 * on failure it stays for inspection.
 */
async function verifyLive(app, recordId, call, { email, password }) {
  const problems = [];
  const notes = [];
  const login = await liveRequest('POST', '/api/auth/desktop', { body: { email, password } });
  const token = login.json?.token;
  if (!token) return { problems: [`Live login failed (${login.status})`], notes };

  let record = null;
  for (let i = 0; i < 30 && !record?.audioFileId; i++) {
    record = await app.getHistoryRecord(recordId);
    if (!record?.audioFileId) await sleep(2000);
  }
  if (!record?.audioFileId) return { problems: [`The upload never reached the backend (upload status ${record?.uploadStatus})`], notes };

  let status = null;
  let meetingId = null;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const res = await liveRequest('GET', `/api/desktop/upload/${record.audioFileId}/status`, { token });
    status = String(res.json?.status || res.status);
    meetingId = res.json?.meetingId || meetingId;
    if (/^(completed|failed|cancelled|transcription_failed)$/i.test(status)) break;
    await sleep(5000);
  }
  notes.push(`backend: meeting ${meetingId}, status ${status}`);
  if (!/^completed$/i.test(status)) return { problems: [`Backend did not finish the transcript (status ${status})`], notes, meetingId };

  const meeting = (await liveRequest('GET', `/api/meetings/${meetingId}`, { token })).json?.meeting;
  const segments = meeting?.transcript?.segments || [];
  const text = segments.map(s => s.text || s.content || '').join(' ');
  const speakers = new Set(segments.map(s => s.speaker ?? s.speakerLabel ?? s.speakerId)
    .filter(v => v !== undefined && v !== null && v !== ''));
  const recall = tc.transcriptRecall(text, call.manifest);
  notes.push(`transcript: ${segments.length} segments, ${speakers.size} speakers; keywords microphone ` +
    `${recall.local.found}/${recall.local.total}, meeting ${recall.remote.found}/${recall.remote.total}`);
  for (const side of ['local', 'remote']) {
    const r = recall[side];
    if (r.found / r.total < 0.75) {
      problems.push(`Transcript misses the ${side === 'local' ? 'microphone' : 'meeting'} side: ${r.found}/${r.total} keywords (missing ${r.missing.join(', ')})`);
    }
  }
  if (speakers.size < 2) problems.push(`Transcript has ${speakers.size} speaker(s); the call had three voices`);

  if (!problems.length) {
    const removed = await liveRequest('DELETE', `/api/meetings/${meetingId}`, { token });
    notes.push(removed.status < 300 ? `test meeting ${meetingId} deleted` : `could not delete test meeting ${meetingId} (${removed.status}) — delete it by hand`);
  } else {
    notes.push(`test meeting ${meetingId} kept for inspection`);
  }
  return { problems, notes, meetingId, transcriptText: text.slice(0, 4000) };
}

async function runTeamsCall({ live = false } = {}) {
  const problems = [];
  const notes = [];
  if (process.platform !== 'win32') return { pass: false, problems: ['s20-teams-call is Windows-only (macOS: AudioTee path, not yet simulated)'], notes };
  const appDir = process.env.SUISSE_E2E_APP_DIR;
  if (!appDir) return { pass: false, problems: ['Set SUISSE_E2E_APP_DIR to a compiled E2E bundle (see README)'], notes };
  if (!fs.existsSync(SYSLOOPBACK)) return { pass: false, problems: ['resources/sysloopback/win-x64/sysloopback.exe is missing (npm run build builds it)'], notes };

  const call = tc.prepareCall();
  const sim = buildTeamsSim();
  const devices = listDevices(sim);
  const outputs = devices.filter(d => d.flow === 'output');
  const inputs = devices.filter(d => d.flow === 'input');
  const commsOut = outputs.find(d => d.defaultFor.includes('communications'));
  const consoleOut = outputs.find(d => d.defaultFor.includes('console'));
  const commsIn = inputs.find(d => d.defaultFor.includes('communications')) || inputs[0];
  if (!commsOut) return { pass: false, problems: ['No audio output on this machine — the Teams stand-in has nowhere to play (CI: install the virtual cable first)'], notes };
  const split = Boolean(consoleOut && consoleOut.id !== commsOut.id);
  notes.push(`Teams plays on "${commsOut.name}" (communications)${split ? `; default output is "${consoleOut.name}" — the 03.10. topology` : ' (also the default output)'}`);
  notes.push(commsIn ? `Teams holds the microphone "${commsIn.name}"` : 'no input device: Teams holds no microphone, "Automatisch" cannot find a meeting');

  const volume = Math.min(1, Math.max(0, Number(process.env.SUISSE_TEAMS_SIM_VOLUME || '1')));
  const teams = startTeamsSim(sim, [
    '--play', call.remoteWav, '--role', 'communications', '--session-volume', String(volume), '--wait-go', '--linger', '2',
    // Teams marks its call audio as Communications; Windows hides such streams from
    // process loopback (the 4.7.13 failure, 05.10.2026). The stand-in does the same,
    // except where the sound card routes Communications elsewhere (CI's virtual cable:
    // SUISSE_TEAMS_SIM_CATEGORY=none, see ci/install-virtual-audio.ps1).
    ...(process.env.SUISSE_TEAMS_SIM_CATEGORY === 'none' ? [] : ['--category', process.env.SUISSE_TEAMS_SIM_CATEGORY || 'communications']),
    ...(commsIn ? ['--hold-mic', '--mic-device', commsIn.id] : []),
  ]);

  const liveAccount = { email: process.env.E2E_EMAIL || 'desktop-e2e@suisse-notes.test', password: process.env.E2E_PASSWORD };
  if (live && !liveAccount.password) {
    await teams.stop();
    return { pass: false, problems: ['Live mode needs E2E_PASSWORD (the desktop-e2e test account) in the environment'], notes };
  }
  const mock = live ? null : await startMockBackend({ port: Number(process.env.SUISSE_E2E_MOCK_PORT || 3000) });
  const app = new AppDriver({
    name: live ? 's20-teams-call-live' : 's20-teams-call', apiUrl: live ? LIVE_API : mock.url,
    fakeAudioWav: call.localWav, appDir, cdpPort: 9361, env: live ? {} : { SUISSE_TEST_NETWORK_ISOLATION: '1' },
  });
  if (live) notes.push(`LIVE: real backend ${LIVE_API}, account ${liveAccount.email}`);
  const timeline = [];
  const mark = (what, extra = {}) => timeline.push({ at: Date.now(), what, ...extra });
  try {
    await teams.waitFor('ready', 20_000);
    if (commsIn) await teams.waitFor('mic-open', 10_000);
    mark('teams-ready');

    await app.launch({ freshProfile: true });
    if (live) await app.login(liveAccount.email, liveAccount.password);
    else await app.login();
    if (commsIn) {
      // Install the relabel before the app's code runs, then load the page fresh.
      await app.page.evaluateOnNewDocument(relabelFakeMicrophone, commsIn.name);
      await app.page.reload({ waitUntil: 'domcontentloaded' });
      await app.page.waitForSelector('[data-test=record-start]', { timeout: 60_000 });
    }
    mark('app-ready');

    const support = await app.evalTimed(async () => {
      await window.electronAPI.systemAudio.setEnabled(true);
      return window.electronAPI.systemAudio.isSupported();
    });
    if (!support?.nativeCapture) problems.push(`The native system-audio helper is not active (${JSON.stringify(support)}) — the app would hear the default output only`);

    const ui = () => app.evalTimed(() => ({
      toggleOn: !!document.querySelector('.system-audio-active'),
      routing: document.querySelector('[data-test=system-audio-routing-warning]')?.textContent?.trim() || null,
      silent: document.querySelector('[data-test=system-audio-silent-warning]')?.textContent?.trim() || null,
      micHint: document.querySelector('.mic-auto-hint')?.textContent?.trim() || null,
      micLabel: document.querySelector('.mic-select')?.textContent?.trim() || null,
      // The system-audio meter (since 4.7.15): what the capture hears, shown to the user.
      systemMeter: parseFloat(document.querySelector('[data-test=system-audio-level] .level-bar')?.style?.width) || 0,
      toasts: [...document.querySelectorAll('.q-notification')].map(n => n.textContent.trim()).join(' | '),
    }));
    for (let attempt = 0; attempt < 3 && !(await ui()).toggleOn; attempt++) {
      try { await app.page.click('[data-test=system-audio-toggle]'); } catch (e) { notes.push(`toggle click ${attempt + 1}: ${e.message}`); }
      await sleep(2000);
    }

    // "Automatisch" re-reads which microphone the meeting uses on focus and on start.
    let before = await ui();
    for (let i = 0; i < 10 && commsIn && !/Teams/.test(before.micHint || ''); i++) {
      await app.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sleep(1000);
      before = await ui();
    }
    notes.push(`before the call: system audio ${before.toggleOn ? 'on' : 'OFF'}; microphone "${before.micLabel}"; hint "${before.micHint}"`);
    if (!before.toggleOn) {
      return { pass: false, problems: [...problems, 'System-audio toggle did not turn on — the call would prove nothing'], notes, timeline };
    }
    if (before.routing) problems.push(`Output-device warning shown although the helper records every device: ${before.routing.slice(0, 160)}`);
    if (commsIn && !/Microsoft Teams/.test(before.micHint || '')) {
      problems.push(`"Automatisch" did not pick the microphone Microsoft Teams is using ("${commsIn.name}"); hint: "${before.micHint}"`);
    }

    await app.startRecording();
    mark('recording');
    const recordId = await app.getRecordId();
    // Witness of the 03.10.2026 failure mode: record what the DEFAULT output carries
    // during the call — that endpoint is all Chromium's loopback (the app up to
    // 4.7.12) could hear. In the split topology it must carry none of the call.
    const witnessFile = path.join(tc.OUT_DIR, 'default-output-witness.wav');
    fs.rmSync(witnessFile, { force: true });
    const witness = split
      ? spawn(SYSLOOPBACK, ['--role', 'console', '--seconds', String(Math.ceil(call.manifest.seconds + 6)), '--out', witnessFile],
        { stdio: 'ignore', windowsHide: true })
      : null;
    const witnessDone = witness ? new Promise(resolve => witness.on('exit', resolve)) : null;
    teams.send('go');
    const playing = await teams.waitFor('playing', 10_000);
    mark('teams-playing', { device: playing.device });

    // The call: watch the warnings while it runs, like a user glancing at the app.
    const seconds = call.manifest.seconds;
    const warnings = [];
    let systemMeterMax = 0;
    const callEnds = Date.now() + seconds * 1000;
    while (Date.now() < callEnds) {
      await sleep(5000);
      const u = await ui();
      systemMeterMax = Math.max(systemMeterMax, u.systemMeter);
      if (u.silent) warnings.push(`silence warning: ${u.silent.slice(0, 120)}`);
      if (/stille|silen|kein ton|no sound|no audio/i.test(u.toasts)) warnings.push(`toast: ${u.toasts.slice(0, 160)}`);
    }
    await teams.waitFor('finished', 30_000);
    await sleep(2500); // the far end's last words leave the device buffers
    mark('teams-finished');
    if (warnings.length) problems.push(`The app warned during a healthy call: ${[...new Set(warnings)].join(' | ')}`);
    notes.push(`system-audio meter during the call: up to ${systemMeterMax} %`);
    if (systemMeterMax < 20) problems.push(`The system-audio meter stayed at ${systemMeterMax} % while the far end talked - the user cannot see that the call is heard`);

    const during = await ui();
    if (commsIn && !/Microsoft Teams/.test(during.micHint || before.micHint || '')) notes.push(`hint during the call: "${during.micHint}"`);

    await app.stopRecording();
    mark('stopped');
    await app.waitForPhase(['uploaded', 'idle'], 240_000);
    mark('uploaded');

    const file = app.findOutputFile();
    if (!file) return { pass: false, problems: [...problems, 'No output file produced'], notes, timeline };
    notes.push(`recording: ${path.relative(WORK_DIR, file)}`);

    const verdict = tc.verifyCall(file, call);
    problems.push(...verdict.problems);
    notes.push(...verdict.notes);

    // Did the call reach the default output too? If not, a capture bound to it (the
    // pre-4.7.13 path) would have recorded the meeting side as silence — and this run
    // proves the app records it anyway. CI requires that topology.
    let defaultOutputHeardCall = null;
    if (witnessDone) {
      await Promise.race([witnessDone, sleep(20_000)]);
      const witnessSeconds = fs.existsSync(witnessFile) ? tc.decodeMono(witnessFile).length / 16000 : 0;
      if (witnessSeconds >= call.manifest.seconds - 2) {
        defaultOutputHeardCall = tc.verifyCall(witnessFile, call).sides.remote.lagFrames !== null;
        notes.push(defaultOutputHeardCall
          ? `the default output "${consoleOut.name}" carried the call too — not the 03.10. situation`
          : `the default output "${consoleOut.name}" carried none of the call: a capture bound to it (the app up to 4.7.12) would have recorded silence, as on 03.10.2026`);
      } else {
        notes.push(`default-output witness recorded only ${witnessSeconds.toFixed(1)} s (helper unavailable?)`);
      }
    }
    if (process.env.SUISSE_TEAMS_CALL_REQUIRE_SPLIT === '1' && defaultOutputHeardCall !== false) {
      problems.push('This run did not reproduce the 03.10.2026 topology (call on the communication output, absent from the default output)');
    }

    let liveResult = null;
    if (live) {
      liveResult = await verifyLive(app, recordId, call, liveAccount);
      problems.push(...liveResult.problems);
      notes.push(...liveResult.notes);
    } else {
      // The backend received exactly the bytes the user keeps locally.
      const uploads = [...mock.state.uploads.values()];
      const localSha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (uploads.length !== 1) problems.push(`Expected exactly 1 upload, saw ${uploads.length}`);
      else if (uploads[0].sha256 !== localSha) problems.push('Uploaded audio differs from the local recording');
      else notes.push(`upload = local file (sha256 ${localSha.slice(0, 12)}…)`);
    }

    await app.screenshot('s20-after-upload').catch(() => {});
    return {
      pass: problems.length === 0, problems, notes, timeline,
      topology: { teamsOutput: commsOut.name, defaultOutput: consoleOut?.name || null, split, defaultOutputHeardCall, teamsMicrophone: commsIn?.name || null },
      sides: verdict.sides, utterances: verdict.utterances,
      ...(liveResult ? { live: { meetingId: liveResult.meetingId, transcriptText: liveResult.transcriptText } } : {}),
      teamsEvents: teams.events.filter(e => e.event !== 'position'),
    };
  } catch (error) {
    await app.screenshot('s20-error').catch(() => {});
    return { pass: false, problems: [...problems, `Scenario error: ${error.message}`], notes, timeline, teamsEvents: teams.events };
  } finally {
    await teams.stop();
    await app.close({ keepProfile: true });
    if (mock) await mock.close();
  }
}

module.exports = { runTeamsCall, runTeamsCallSelftest };
