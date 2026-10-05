/**
 * A REAL Teams call with two synthetic participants (Areg, 05.10.2026: "two fake
 * participants join a real Teams call and talk with synthetic voices, I join with
 * the Jabra and test it properly").
 *
 * The fully automatic check is s20-teams-call (Teams stand-in, runs before every
 * release). This one adds what only a real call has: Microsoft's Teams client and
 * network, codecs and noise suppression, and the real headset. It needs a person
 * in the meeting, so it is run by hand:
 *
 *   1. Areg starts a Teams meeting (e.g. "Meet now") with the Jabra, copies the link,
 *      starts the desktop app recording (system audio on, microphone "Automatisch").
 *   2. node tests/e2e-harness/teams-real-call.js join "<meeting link>"
 *      Two browser guests, "Katja Test" and "Hedda Test", join as anonymous guests;
 *      Areg admits them from the lobby. Once both are in, they hold the 30-second
 *      exchange of the s20 fixture (lines u2/u3/u5/u6/u9), then leave.
 *      Areg may talk too (his voice is the microphone side); optionally he invites
 *      the Suisse Meets bot to the same meeting to test the bot as well.
 *   3. Stop the recording, then
 *      node tests/e2e-harness/teams-real-call.js verify [recording file]
 *      checks the newest recording of the desktop app (read only): every sentence of
 *      both guests must be in it, complete. The microphone side is Areg's own voice
 *      and is not scored.
 *
 * The guests never touch a real device: each browser gets a synthetic microphone
 * (Web Audio, started on command so both speak in turn), no camera, a silent
 * fallback file for any other capture, and muted output — nothing they hear is
 * played on this computer, so nothing reaches the app's system-audio capture twice.
 * They stop if Teams shows a CAPTCHA (never solved by automation) or refuses guests.
 *
 *   node tests/e2e-harness/teams-real-call.js selftest   synthetic microphone in a local page
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { WORK_DIR } = require('./lib/audio');
const tc = require('./lib/teams-call');

const OUT = path.join(WORK_DIR, 'teams-real-call');
const GUESTS = [
  { speaker: 'remote1', name: 'Katja Test' },
  { speaker: 'remote2', name: 'Hedda Test' },
];
// A person admits the guests (join); an unattended bot test expects a lobby bypass and gives up sooner.
const LOBBY_TIMEOUT_MS = Number(process.env.SUISSE_TEAMS_LOBBY_TIMEOUT_S || 600) * 1000;
const INJECT_RATE = 24000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function browserPath() {
  const candidates = [
    process.env.SUISSE_TEAMS_GUEST_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('No Chrome or Edge found (set SUISSE_TEAMS_GUEST_BROWSER)');
  return found;
}

/** Runs in every frame before Teams' own code: the guest's only microphone. */
function installSyntheticMicrophone() {
  if (window.__synthMic || !navigator.mediaDevices) return;
  const devices = navigator.mediaDevices;
  const realGetUserMedia = devices.getUserMedia.bind(devices);
  const realEnumerate = devices.enumerateDevices.bind(devices);
  const state = { ctx: null, dest: null, buffer: null, source: null };
  const ensure = () => {
    if (!state.ctx) {
      state.ctx = new AudioContext({ sampleRate: 48000 });
      state.dest = state.ctx.createMediaStreamDestination();
      // A silent constant keeps the track delivering frames before the lines start.
      const keepAlive = state.ctx.createConstantSource();
      keepAlive.offset.value = 0;
      keepAlive.connect(state.dest);
      keepAlive.start();
    }
    if (state.ctx.state !== 'running') state.ctx.resume().catch(() => {});
    return state;
  };
  devices.getUserMedia = async (constraints = {}) => {
    if (constraints.video && !constraints.audio) throw new DOMException('No camera for synthetic guests', 'NotFoundError');
    if (constraints.audio) return new MediaStream([ensure().dest.stream.getAudioTracks()[0].clone()]);
    return realGetUserMedia(constraints);
  };
  devices.enumerateDevices = async () => (await realEnumerate()).filter(device => device.kind !== 'videoinput');
  window.__synthMic = {
    load(base64, rate) {
      const s = ensure();
      const bytes = atob(base64);
      const frames = bytes.length >> 1;
      const buffer = s.ctx.createBuffer(1, frames, rate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) {
        let v = bytes.charCodeAt(2 * i) | (bytes.charCodeAt(2 * i + 1) << 8);
        if (v >= 32768) v -= 65536;
        channel[i] = v / 32768;
      }
      s.buffer = buffer;
      return frames / rate;
    },
    start(delayS) {
      const s = ensure();
      const source = s.ctx.createBufferSource();
      source.buffer = s.buffer;
      source.connect(s.dest);
      source.start(s.ctx.currentTime + (delayS || 0));
      s.source = source;
      return true;
    },
    stop() { try { if (state.source) state.source.stop(); } catch (_) { /* already ended */ } },
    tracksHandedOut: () => !!state.dest,
  };
}

/** The guest's lines as 24 kHz 16-bit PCM in base64 (the injected buffer). */
function speakerPcmBase64(wav) {
  const samples = tc.decodeMono(wav, INJECT_RATE);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  return pcm.toString('base64');
}

async function launchGuest(guest, silenceWav) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-guest-'));
  const browser = await puppeteer.launch({
    executablePath: browserPath(),
    headless: false,
    userDataDir: profile,
    defaultViewport: null,
    args: [
      '--lang=en-US',
      '--window-size=900,720',
      '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      // Belt and braces: anything that bypasses the synthetic microphone gets a
      // silent file and a fake camera, never this computer's devices.
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${silenceWav}`,
      // The guest hears the meeting silently: nothing it receives is played here.
      '--mute-audio',
    ],
  });
  const [page] = await browser.pages();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.evaluateOnNewDocument(installSyntheticMicrophone);
  return { ...guest, browser, page, profile, state: 'starting', log: [] };
}

/** One look at the Teams page in every frame: what is on screen, what can be clicked. */
async function lookAt(page) {
  const views = [];
  for (const frame of page.frames()) {
    try {
      views.push(await frame.evaluate(() => {
        const text = (document.body && document.body.innerText) || '';
        const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const buttons = [...document.querySelectorAll('button, a[role=button], [role=button]')].filter(visible)
          .map(b => ({ label: (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 80), tid: b.getAttribute('data-tid') || '', disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' }));
        const nameInput = [...document.querySelectorAll('input[type=text], input:not([type])')].filter(visible)
          .some(i => /name/i.test((i.getAttribute('placeholder') || '') + ' ' + (i.getAttribute('aria-label') || '') + ' ' + (i.getAttribute('data-tid') || '')));
        return { text: text.slice(0, 4000), buttons, nameInput, hasMic: !!window.__synthMic };
      }));
    } catch (_) { /* frame navigating */ }
  }
  return views;
}

async function clickButton(page, pattern) {
  for (const frame of page.frames()) {
    try {
      const clicked = await frame.evaluate(source => {
        const re = new RegExp(source, 'i');
        const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const target = [...document.querySelectorAll('button, a[role=button], [role=button], a')].filter(visible)
          .find(b => re.test(`${b.getAttribute('aria-label') || ''} ${b.innerText || ''} ${b.getAttribute('data-tid') || ''}`) &&
            !b.disabled && b.getAttribute('aria-disabled') !== 'true');
        if (!target) return false;
        target.click();
        return true;
      }, pattern.source);
      if (clicked) return true;
    } catch (_) { /* frame navigating */ }
  }
  return false;
}

async function typeName(page, name) {
  for (const frame of page.frames()) {
    try {
      const handle = await frame.evaluateHandle(() => {
        const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        return [...document.querySelectorAll('input[type=text], input:not([type])')].filter(visible)
          .find(i => /name/i.test((i.getAttribute('placeholder') || '') + ' ' + (i.getAttribute('aria-label') || '') + ' ' + (i.getAttribute('data-tid') || ''))) || null;
      });
      const input = handle.asElement();
      if (!input) continue;
      const current = await frame.evaluate(el => el.value, input);
      if (current === name) return true;
      // Empty the field first (a triple click did not select Teams' text, every round appended the name).
      await input.focus();
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await input.type(name, { delay: 30 });
      return true;
    } catch (_) { /* frame navigating */ }
  }
  return false;
}

/** Drives one guest from the link to "in the meeting" (or a reason why not). */
async function admitGuest(guest, link, pcmBase64) {
  await guest.page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const deadline = Date.now() + LOBBY_TIMEOUT_MS;
  let loaded = false;
  while (Date.now() < deadline) {
    const views = await lookAt(guest.page);
    const text = views.map(v => v.text).join('\n');
    const labels = views.flatMap(v => v.buttons.map(b => `${b.label} ${b.tid}`)).join(' | ');
    const note = state => { if (guest.state !== state) { guest.state = state; guest.log.push({ at: Date.now(), state }); console.log(`  ${guest.name}: ${state}`); } };

    if (/captcha|verify (that )?you('| a)re (a )?human|i'm not a robot/i.test(text)) { note('captcha'); return 'Teams asks for a CAPTCHA - automation stops here (never solved automatically)'; }
    if (/anonymous users can.?t join|you can.?t join this meeting|denied|isn.?t available|meeting has ended/i.test(text)) { note('refused'); return `Teams refused the guest: ${text.slice(0, 160).replace(/\s+/g, ' ')}`; }

    // The synthetic microphone is in place before Teams asks for a microphone.
    if (!loaded) {
      for (const frame of guest.page.frames()) {
        try {
          if (await frame.evaluate(() => !!window.__synthMic)) {
            await frame.evaluate((data, rate) => window.__synthMic.load(data, rate), pcmBase64, INJECT_RATE);
            loaded = true;
          }
        } catch (_) { /* frame navigating */ }
      }
    }

    if (/hang ?up|leave/i.test(labels) && !/join now/i.test(labels)) { note('in meeting'); return null; }
    if (/let you in soon|waiting for (someone|the organizer)|in the lobby|lobby/i.test(text)) { note('lobby - please admit'); await sleep(2000); continue; }

    if (await clickButton(guest.page, /continue on this browser|join on the web|use the web app instead|joinOnWeb/)) { note('browser join'); await sleep(3000); continue; }
    if (views.some(v => v.nameInput)) await typeName(guest.page, guest.name);
    // Microphone on (the synthetic one), camera stays unavailable.
    await clickButton(guest.page, /^\s*(unmute|turn on (the )?mic|mic(rophone)? (is )?off)/);
    if (await clickButton(guest.page, /join now|prejoin-join-button/)) { note('asked to join'); await sleep(3000); continue; }
    note('loading');
    await sleep(1500);
  }
  return `not admitted within ${LOBBY_TIMEOUT_MS / 60_000} minutes`;
}

function assertTeamsLink(link) {
  if (!/^https:\/\/(teams\.microsoft\.com|teams\.live\.com)\//i.test(link || '')) throw new Error('Pass a Teams meeting link (https://teams.microsoft.com/...)');
}

/**
 * Brings both guests into the meeting, then hands control to `during(guests, talk)`;
 * `talk()` makes them hold the exchange once (both start in the same instant, so they
 * speak in turn as in the fixture) and resolves when it is over. Guests leave and the
 * browsers close afterwards, whatever happens. Problems end up in `result.problems`.
 */
async function withGuests(link, result, during) {
  const call = tc.prepareCall();
  fs.mkdirSync(OUT, { recursive: true });
  const silenceWav = path.join(OUT, 'silence.wav');
  tc.writeWav16(silenceWav, new Float32Array(48000), 48000);
  const guests = [];
  const talk = async () => {
    const go = Date.now();
    await Promise.all(guests.map(g => Promise.all(g.page.frames().map(f =>
      f.evaluate(() => window.__synthMic && window.__synthMic.tracksHandedOut() && window.__synthMic.start(0.3)).catch(() => false)))));
    (result.dialogues = result.dialogues || []).push(new Date(go + 300).toISOString());
    console.log(`  dialogue started; ${call.manifest.seconds.toFixed(0)} s`);
    await sleep(call.manifest.seconds * 1000 + 4000);
  };
  try {
    for (const guest of GUESTS) guests.push(await launchGuest(guest, silenceWav));
    const outcomes = await Promise.all(guests.map(g => admitGuest(g, link, speakerPcmBase64(call.speakerWavs[g.speaker]))));
    outcomes.forEach((problem, i) => { if (problem) result.problems.push(`${guests[i].name}: ${problem}`); });
    // A guest that did not get in: what its page showed (screenshot and button labels, no page text).
    for (const [i, problem] of outcomes.entries()) {
      if (!problem) continue;
      const g = guests[i];
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const shot = path.join(OUT, `guest_${g.speaker}_${stamp}.png`);
      await g.page.screenshot({ path: shot }).catch(() => {});
      const views = await lookAt(g.page).catch(() => []);
      g.seen = { url: g.page.url().replace(/\?.*$/, '?…'), buttons: views.flatMap(v => v.buttons.map(b => b.label || b.tid)).filter(Boolean).slice(0, 30) };
    }
    if (!result.problems.length) {
      await sleep(3000);
      await during(guests, talk, call);
    }
  } finally {
    for (const g of guests) {
      await clickButton(g.page, /hang ?up|leave/).catch(() => false);
      result.guests.push({ name: g.name, state: g.state, log: g.log, ...(g.seen ? { seen: g.seen } : {}) });
    }
    await sleep(1500);
    for (const g of guests) {
      await g.browser.close().catch(() => {});
      fs.rmSync(g.profile, { recursive: true, force: true });
    }
  }
  return call;
}

function writeLog(kind, startedAt, result) {
  const file = path.join(OUT, `${kind}_${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`  log: ${file}`);
}

async function join(link) {
  assertTeamsLink(link);
  const startedAt = new Date();
  const result = { link: link.replace(/\?.*$/, '?…'), startedAt: startedAt.toISOString(), guests: [], problems: [] };
  try {
    await withGuests(link, result, async (guests, talk) => { await talk(); });
  } finally {
    writeLog('join', startedAt, result);
  }
  console.log(result.problems.length ? `FAIL\n  ${result.problems.join('\n  ')}` : 'Guests spoke and left. Stop the recording, then run: node tests/e2e-harness/teams-real-call.js verify');
  return !result.problems.length;
}

// ---- the Teams bot in the same kind of call ---------------------------------------------

const LIVE_API = process.env.SUISSE_LIVE_API_URL || 'https://app.suisse-meets.ch';

async function api(method, route, { token, body } = {}) {
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
 * The Suisse Meets Teams bot, end to end, with nobody in the meeting but the two
 * synthetic guests: the test account invites the bot by link (the customer path of
 * the 03.10.2026 "failed" status), the guests talk, the bot leaves, and the finished
 * meeting must be COMPLETED - never FAILED on the way - with a transcript that holds
 * both guests' words under two speakers. SUISSE_BOT_TEST_HOLD_MINUTES keeps the call
 * open that long (16 = past the 15-minute safety net that caused the 03.10. status).
 * The meeting must let everyone bypass the lobby (Teams meeting options).
 * SUISSE_BOT_TEST_EXPECT_PROVIDER (mediabot | attendee) fails the run when the
 * backend sent the other bot.
 * Credentials: E2E_EMAIL (default desktop-e2e@suisse-notes.test) and E2E_PASSWORD
 * from the environment. On success the test meeting is deleted again.
 */
async function botCall(link) {
  assertTeamsLink(link);
  const email = process.env.E2E_EMAIL || 'desktop-e2e@suisse-notes.test';
  const password = process.env.E2E_PASSWORD;
  if (!password) throw new Error('Set E2E_PASSWORD (test account) in the environment');
  const holdMinutes = Math.max(0, Number(process.env.SUISSE_BOT_TEST_HOLD_MINUTES || '0'));
  const startedAt = new Date();
  const result = { kind: 'bot', api: LIVE_API, startedAt: startedAt.toISOString(), holdMinutes, guests: [], problems: [], statuses: [] };
  const login = await api('POST', '/api/auth/desktop', { body: { email, password } });
  const token = login.json?.token;
  if (!token) throw new Error(`Test account login failed (${login.status})`);

  let meetingId = null;
  const status = async () => {
    const res = await api('GET', `/api/meetings/${meetingId}`, { token });
    const meeting = res.json?.meeting;
    const current = meeting?.status || `HTTP ${res.status}`;
    const last = result.statuses[result.statuses.length - 1];
    if (!last || last.status !== current) {
      result.statuses.push({ at: new Date().toISOString(), status: current });
      console.log(`  bot meeting: ${current}`);
    }
    if (/^(FAILED|TRANSCRIPTION_FAILED|CANCELLED)$/.test(current) && !result.problems.some(p => p.startsWith('Meeting status'))) {
      result.problems.push(`Meeting status ${current}${meeting?.errorMessage ? ` (${String(meeting.errorMessage).slice(0, 120)})` : ''}`);
    }
    return { current, meeting };
  };

  try {
    // The bot first: anonymous guests may not be allowed to start a meeting alone.
    const invite = await api('POST', '/api/bot/join', { token, body: { meetingUrl: link, title: `Bot-Test synthetisch ${startedAt.toISOString().slice(0, 16)}` } });
    meetingId = invite.json?.meetingId || null;
    if (!meetingId) throw new Error(`Bot invite failed (${invite.status}): ${JSON.stringify(invite.json).slice(0, 200)}`);
    result.meetingId = meetingId;
    result.provider = invite.json?.provider || null;
    console.log(`  bot invited: meeting ${meetingId} (${result.provider})`);
    // A silent fallback to the other bot must not pass as a test of this one.
    const expectedProvider = process.env.SUISSE_BOT_TEST_EXPECT_PROVIDER;
    if (expectedProvider && result.provider !== expectedProvider) {
      result.problems.push(`Bot provider ${result.provider} - expected ${expectedProvider}`);
    }
    for (let i = 0; i < 24 && (await status()).current === 'BOT_JOINING'; i++) await sleep(5000);

    await withGuests(link, result, async (guests, talk) => {
      await sleep(10_000); // the bot hears both guests arrive
      await talk();
      const holdUntil = Date.now() + holdMinutes * 60_000;
      while (Date.now() < holdUntil) {
        await sleep(30_000);
        await status();
      }
      if (holdMinutes > 0) await talk(); // talking again after the hold proves the recording kept running
      const left = await api('POST', `/api/meetings/${meetingId}`, { token, body: { action: 'leave' } });
      result.botLeave = left.status;
    });

    // Recording -> processing -> transcript.
    let final = await status();
    const deadline = Date.now() + 25 * 60_000;
    while (!/^(COMPLETED|FAILED|TRANSCRIPTION_FAILED|CANCELLED)$/.test(final.current) && Date.now() < deadline) {
      await sleep(15_000);
      final = await status();
    }
    if (final.current !== 'COMPLETED') {
      if (!result.problems.some(p => p.startsWith('Meeting status'))) result.problems.push(`Meeting did not complete (last status ${final.current})`);
    } else {
      const segments = (final.meeting?.transcript?.segments || []).filter(s => !s.speakerRemovedAt);
      const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ');
      const text = norm(segments.map(s => s.text).join(' '));
      const call = tc.prepareCall();
      const perGuest = {};
      for (const guest of GUESTS) {
        const keywords = call.manifest.utterances.filter(u => u.speaker === guest.speaker).flatMap(u => u.keywords);
        const missing = keywords.filter(k => !text.includes(norm(k).trim()));
        perGuest[guest.name] = { found: keywords.length - missing.length, total: keywords.length, missing };
        if ((keywords.length - missing.length) / keywords.length < 0.75) {
          result.problems.push(`Transcript misses ${guest.name}: ${keywords.length - missing.length}/${keywords.length} keywords (missing ${missing.join(', ')})`);
        }
      }
      const speakers = [...new Set(segments.map(s => s.speakerName || s.speakerLabel).filter(Boolean))];
      result.transcript = { segments: segments.length, speakers, perGuest };
      console.log(`  transcript: ${segments.length} segments, speakers ${speakers.join(', ')}`);
      if (speakers.length < 2) result.problems.push(`Transcript has ${speakers.length} speaker(s); two guests spoke`);
    }
    if (result.statuses.some(s => s.status === 'FAILED') && final.current === 'COMPLETED') {
      result.problems.push('Meeting showed FAILED while the bot was still recording (the 03.10.2026 status problem)');
    }
  } finally {
    if (meetingId && !result.problems.length) {
      const removed = await api('DELETE', `/api/meetings/${meetingId}`, { token }).catch(() => ({ status: 0 }));
      result.deleted = removed.status < 300;
    }
    writeLog('bot', startedAt, result);
  }
  console.log(`${result.problems.length ? 'FAIL' : 'PASS'}  Teams bot with two synthetic guests${meetingId ? ` (meeting ${meetingId}${result.deleted ? ', deleted' : ', kept for inspection'})` : ''}`);
  for (const p of result.problems) console.log(`  PROBLEM: ${p}`);
  return !result.problems.length;
}

/** Newest finished recording of the installed or test desktop app (read only). */
function newestRecording() {
  const roots = [path.join(process.env.APPDATA || '', 'Suisse Notes', 'recordings'), path.join(os.homedir(), 'Library', 'Application Support', 'Suisse Notes', 'recordings')];
  const files = [];
  for (const root of roots.filter(r => fs.existsSync(r))) {
    for (const dir of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
      for (const name of ['audio.webm', 'audio.m4a', 'audio.wav']) {
        const file = path.join(root, dir.name, name);
        if (fs.existsSync(file)) files.push({ file, mtime: fs.statSync(file).mtimeMs });
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0]?.file || null;
}

function verify(file) {
  const recording = file || newestRecording();
  if (!recording || !fs.existsSync(recording)) throw new Error('No recording found - pass the file path');
  const call = tc.prepareCall();
  const seconds = tc.decodeMono(recording).length / 16000;
  const verdict = tc.verifyCall(recording, call, {
    tracks: call.speakerWavs, groupOf: u => u.speaker,
    searchS: [-5, Math.max(40, seconds)],
    // Teams' codecs, jitter buffer and noise suppression: a little more tolerance.
    minScore: 0.5, minCoverage: 0.8, maxJitterMs: 300,
  });
  console.log(`\n${verdict.pass ? 'PASS' : 'FAIL'}  real Teams call: ${recording}`);
  for (const n of verdict.notes) console.log(`  note: ${n}`);
  for (const u of verdict.utterances) console.log(`  ${u.found ? 'ok ' : 'MISSING'} ${u.id} ${u.voice}: match ${u.score ?? '-'}, ${u.coverage === undefined ? '-' : Math.round(u.coverage * 100) + ' %'} — ${u.text}`);
  for (const p of verdict.problems) console.log(`  PROBLEM: ${p}`);
  console.log('  (Your own voice - the microphone side - is not scored.)');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'verify_latest.json'), JSON.stringify({ recording, ...verdict }, null, 2));
  return verdict.pass;
}

/** The synthetic microphone end to end in the guest browser, without Teams. */
async function selftest() {
  const call = tc.prepareCall();
  fs.mkdirSync(OUT, { recursive: true });
  const silenceWav = path.join(OUT, 'silence.wav');
  tc.writeWav16(silenceWav, new Float32Array(48000), 48000);
  const guest = await launchGuest(GUESTS[0], silenceWav);
  try {
    // A local file is a secure context (microphone API available), like Teams' https page.
    const pageFile = path.join(OUT, 'selftest.html');
    fs.writeFileSync(pageFile, '<!doctype html><meta charset="utf-8"><title>synthetic microphone selftest</title><p>selftest</p>');
    await guest.page.goto('file:///' + pageFile.replace(/\\/g, '/'));
    const pcm = speakerPcmBase64(call.speakerWavs.remote1);
    const seconds = await guest.page.evaluate((data, rate) => window.__synthMic.load(data, rate), pcm, INJECT_RATE);
    // A page asks for a microphone like Teams does and records what it gets.
    const recorded = await guest.page.evaluate(async total => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const camera = await navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'camera opened', e => e.name);
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks = [];
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.start(1000);
      window.__synthMic.start(0.5);
      await new Promise(r => setTimeout(r, (total + 1.5) * 1000));
      recorder.stop();
      await new Promise(r => { recorder.onstop = r; });
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { webm: btoa(binary), camera };
    }, seconds);
    const file = path.join(OUT, 'selftest_guest_microphone.webm');
    fs.writeFileSync(file, Buffer.from(recorded.webm, 'base64'));
    const verdict = tc.verifyCall(file, call, { tracks: { remote1: call.speakerWavs.remote1 }, groupOf: u => u.speaker });
    const cameraBlocked = recorded.camera === 'NotFoundError';
    console.log(`${verdict.pass && cameraBlocked ? 'PASS' : 'FAIL'}  synthetic guest microphone: ${verdict.utterances.map(u => `${u.id}=${u.score}`).join(' ')}; camera request -> ${recorded.camera}`);
    for (const p of verdict.problems) console.log(`  PROBLEM: ${p}`);
    return verdict.pass && cameraBlocked;
  } finally {
    await guest.browser.close().catch(() => {});
    fs.rmSync(guest.profile, { recursive: true, force: true });
  }
}

module.exports = { join, botCall, verify, selftest, installSyntheticMicrophone };

if (require.main === module) {
  const [command, arg] = process.argv.slice(2);
  const link = arg || process.env.SUISSE_TEAMS_TEST_MEETING_LINK;
  const run = command === 'join' ? () => join(link) : command === 'bot' ? () => botCall(link)
    : command === 'verify' ? async () => verify(arg) : command === 'selftest' ? selftest : null;
  if (!run) {
    console.log('Usage: node tests/e2e-harness/teams-real-call.js join "<Teams meeting link>" | bot "<link>" | verify [recording] | selftest');
    process.exit(2);
  }
  run().then(ok => process.exit(ok ? 0 : 1), error => { console.error(error); process.exit(1); });
}
