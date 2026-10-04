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
 *      Two browser guests, "Katja (Test)" and "Hedda (Test)", join as anonymous guests;
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
  { speaker: 'remote1', name: 'Katja (Test)' },
  { speaker: 'remote2', name: 'Hedda (Test)' },
];
const LOBBY_TIMEOUT_MS = 10 * 60_000;
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
      await input.click({ clickCount: 3 });
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

async function join(link) {
  if (!/^https:\/\/(teams\.microsoft\.com|teams\.live\.com)\//i.test(link || '')) throw new Error('Pass a Teams meeting link (https://teams.microsoft.com/...)');
  const call = tc.prepareCall();
  fs.mkdirSync(OUT, { recursive: true });
  const silenceWav = path.join(OUT, 'silence.wav');
  tc.writeWav16(silenceWav, new Float32Array(48000), 48000);
  const startedAt = new Date();
  const result = { link: link.replace(/\?.*$/, '?…'), startedAt: startedAt.toISOString(), guests: [], problems: [] };
  const guests = [];
  try {
    for (const guest of GUESTS) guests.push(await launchGuest(guest, silenceWav));
    const outcomes = await Promise.all(guests.map(g => admitGuest(g, link, speakerPcmBase64(call.speakerWavs[g.speaker]))));
    outcomes.forEach((problem, i) => { if (problem) result.problems.push(`${guests[i].name}: ${problem}`); });
    if (!result.problems.length) {
      await sleep(3000);
      // Both start in the same instant, so they speak in turn as in the fixture.
      const go = Date.now();
      await Promise.all(guests.map(g => Promise.all(g.page.frames().map(f => f.evaluate(() => window.__synthMic && window.__synthMic.tracksHandedOut() && window.__synthMic.start(0.3)).catch(() => false)))));
      result.dialogueStartedAt = new Date(go + 300).toISOString();
      console.log(`  dialogue started ${result.dialogueStartedAt}; ${call.manifest.seconds.toFixed(0)} s`);
      await sleep(call.manifest.seconds * 1000 + 4000);
      for (const g of guests) await clickButton(g.page, /hang ?up|leave/);
      await sleep(2000);
    }
  } finally {
    for (const g of guests) {
      result.guests.push({ name: g.name, state: g.state, log: g.log });
      await g.browser.close().catch(() => {});
      fs.rmSync(g.profile, { recursive: true, force: true });
    }
    const file = path.join(OUT, `join_${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(`  log: ${file}`);
  }
  console.log(result.problems.length ? `FAIL\n  ${result.problems.join('\n  ')}` : 'Guests spoke and left. Stop the recording, then run: node tests/e2e-harness/teams-real-call.js verify');
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

module.exports = { join, verify, selftest, installSyntheticMicrophone };

if (require.main === module) {
  const [command, arg] = process.argv.slice(2);
  const run = command === 'join' ? () => join(arg) : command === 'verify' ? async () => verify(arg) : command === 'selftest' ? selftest : null;
  if (!run) {
    console.log('Usage: node tests/e2e-harness/teams-real-call.js join "<Teams meeting link>" | verify [recording] | selftest');
    process.exit(2);
  }
  run().then(ok => process.exit(ok ? 0 : 1), error => { console.error(error); process.exit(1); });
}
