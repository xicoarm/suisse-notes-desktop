/**
 * App driver — launches the REAL desktop app (quasar dev electron) with the
 * dev-only test hooks and drives it over the Chrome DevTools Protocol like a
 * human: type credentials, click the record button, navigate pages, crash the
 * renderer. No mocked internals — the full renderer + main-process stack runs.
 */
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORK_DIR = path.join(__dirname, '..', 'work');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function diagnosticDeadline(promise, ms = 3000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostic sample timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Runs only in synthetic/local test pages. Wrapping start observes both an
// already-constructed recorder and future instances, without replacing their
// native handlers, constructor, capture stream, or recording implementation.
function installSyntheticCaptureProbe() {
  if (window.__suisseCaptureDiagnostics || !window.MediaRecorder) return;
  const entries = new Map();
  const observed = new WeakSet();
  let nextId = 0;
  const nativeStart = MediaRecorder.prototype.start;
  MediaRecorder.prototype.start = function (...args) {
    try {
      if (!observed.has(this)) {
        observed.add(this);
        const entry = { id: ++nextId, ref: new WeakRef(this), events: 0, bytes: 0, emptyEvents: 0, firstDataAt: null, lastDataAt: null, startedAt: null, stoppedAt: null };
        entries.set(entry.id, entry);
        // Bound diagnostic bookkeeping during extended/multi-recording runs.
        if (entries.size > 20) entries.delete(entries.keys().next().value);
        for (const type of ['start', 'dataavailable', 'pause', 'resume', 'stop', 'error']) {
          this.addEventListener(type, event => {
            try {
              const now = performance.now();
              if (type === 'start') entry.startedAt = event.timeStamp;
              if (type === 'stop') entry.stoppedAt = event.timeStamp;
              const size = type === 'dataavailable' ? event.data?.size || 0 : null;
              if (type === 'dataavailable') {
                entry.events++; entry.bytes += size;
                if (!size) entry.emptyEvents++;
                entry.firstDataAt ??= now; entry.lastDataAt = now;
              }
              console.debug('[synthetic-capture] ' + JSON.stringify({ id: entry.id, event: type, at: now,
                state: event.target?.state, bytes: size, error: event.error?.name || null }));
            } catch (_) { /* diagnostics must never throw into capture */ }
          });
        }
      }
    } catch (_) { /* native start must still run unchanged */ }
    return Reflect.apply(nativeStart, this, args);
  };
  window.__suisseCaptureDiagnostics = {
    snapshot: () => ({ at: performance.now(), visibility: document.visibilityState, recorders: [...entries.values()].map(entry => {
      const recorder = entry.ref.deref();
      const counts = { id: entry.id, events: entry.events, bytes: entry.bytes, emptyEvents: entry.emptyEvents,
        firstDataAt: entry.firstDataAt, lastDataAt: entry.lastDataAt, startedAt: entry.startedAt, stoppedAt: entry.stoppedAt };
      return { ...counts, state: recorder?.state || 'released', tracks: recorder?.stream?.getAudioTracks().map(track => ({
        readyState: track.readyState, enabled: track.enabled, muted: track.muted,
      })) || [] };
    }) }),
  };
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).setTimeout(5000, function () { this.destroy(new Error('CDP request timed out')); });
  });
}

class AppDriver {
  constructor(opts = {}) {
    this.cdpPort = opts.cdpPort || 9339;
    this.apiUrl = opts.apiUrl;                   // mock backend URL
    this.fakeAudioWav = opts.fakeAudioWav;       // scenario WAV fed as the mic
    this.userDataDir = opts.userDataDir || path.join(WORK_DIR, 'userdata', opts.name || 'default');
    this.env = opts.env || {};                   // extra env (e.g. VITE_SUISSE_MAX_DURATION_SECONDS)
    this.packagedExe = opts.packagedExe || null; // drive the built .exe instead of quasar dev
    this.appDir = opts.appDir || process.env.SUISSE_E2E_APP_DIR || null;
    this.proc = null;
    this.browser = null;
    this.page = null;
    this.log = [];
    this.diagnosticsDir = null;
    this.rendererListeners = new Map();
    this.diagnosticWriteErrorReported = false;
  }

  assertTestProfile() {
    const allowed = path.resolve(WORK_DIR, 'userdata');
    const target = path.resolve(this.userDataDir);
    if (!target.startsWith(allowed + path.sep)) throw new Error('Refusing to modify a non-test profile');
  }

  get recordingsDir() {
    return path.join(this.userDataDir, 'recordings');
  }

  beginDiagnostics(env) {
    // This driver is also used by live-backend scripts. Persist diagnostics
    // only for fake audio against a local mock API in the isolated profile.
    const isLocal = value => {
      try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); }
      catch (_) { return false; }
    };
    this.diagnosticsDir = null;
    this.diagnosticWriteErrorReported = false;
    this.log = [];
    if (!env.SUISSE_TEST_FAKE_AUDIO || !isLocal(env.API_BASE_URL) || !isLocal(env.VITE_API_URL) ||
        path.resolve(env.SUISSE_TEST_USERDATA) !== path.resolve(this.userDataDir)) return;
    const logsRoot = path.join(WORK_DIR, 'logs');
    fs.mkdirSync(logsRoot, { recursive: true });
    const profile = path.basename(path.resolve(this.userDataDir)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.diagnosticsDir = fs.mkdtempSync(path.join(logsRoot, `${profile}-${stamp}-`));
    this.writeDiagnostic('driver', 'Starting synthetic capture; profile=' + this.userDataDir);
  }

  writeDiagnostic(channel, message) {
    if (!this.diagnosticsDir) return;
    // Append during the run, not just after success: renderer/process crashes
    // and harness termination must leave their last observations available.
    try {
      fs.appendFileSync(path.join(this.diagnosticsDir, channel + '.log'),
        JSON.stringify({ time: new Date().toISOString(), message: String(message) }) + '\n');
    } catch (error) {
      // A diagnostic disk error must not prevent app cleanup or create the
      // very recording interruption this harness is trying to investigate.
      if (!this.diagnosticWriteErrorReported) this.log.push('[harness] Diagnostic write failed: ' + error.message);
      this.diagnosticWriteErrorReported = true;
    }
  }

  async observeRenderer(page) {
    if (!this.diagnosticsDir || this.rendererListeners.has(page)) return;
    const onConsole = message => this.writeDiagnostic('renderer',
      `${page.url()} [${message.type()}] ${message.text()}`);
    const onPageError = error => this.writeDiagnostic('renderer',
      `${page.url()} [pageerror] ${error.stack || error.message || error}`);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    const observer = { onConsole, onPageError, closed: false, contexts: new Map(), cdp: null, timer: null, sampling: false };
    this.rendererListeners.set(page, observer);
    this.writeDiagnostic('driver', 'Observing renderer ' + page.url());
    try {
      await diagnosticDeadline(page.evaluateOnNewDocument(installSyntheticCaptureProbe));
      await diagnosticDeadline(page.evaluate(installSyntheticCaptureProbe));
    } catch (error) { this.writeDiagnostic('driver', 'Recorder probe unavailable: ' + error.message); }
    try {
      const cdp = await diagnosticDeadline(page.target().createCDPSession());
      if (observer.closed) { await cdp.detach().catch(() => {}); return; }
      observer.cdp = cdp;
      for (const type of ['contextCreated', 'contextChanged']) {
        cdp.on('WebAudio.' + type, ({ context }) => {
          if (observer.closed) return;
          observer.contexts.set(context.contextId, context);
          this.writeDiagnostic('webaudio', JSON.stringify({ event: type, context }));
        });
      }
      cdp.on('WebAudio.contextWillBeDestroyed', ({ contextId }) => {
        observer.contexts.delete(contextId);
        if (!observer.closed) this.writeDiagnostic('webaudio', JSON.stringify({ event: 'contextWillBeDestroyed', contextId }));
      });
      await diagnosticDeadline(cdp.send('WebAudio.enable'));
    } catch (error) { this.writeDiagnostic('driver', 'WebAudio diagnostics unavailable: ' + error.message); }
    if (observer.closed) return;
    const sample = async () => {
      if (observer.closed || observer.sampling) return;
      observer.sampling = true;
      try {
        this.writeDiagnostic('progress', JSON.stringify({ disk: this.captureDiskProgress() }));
        const jobs = [diagnosticDeadline(page.evaluate(() => {
          const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
          const state = pinia?.state?.value?.recording;
          return { capture: window.__suisseCaptureDiagnostics?.snapshot(), store: state ? {
            phase: state.phase, duration: state.duration, chunkIndex: state.chunkIndex,
            chunkSaveErrors: state.chunkSaveErrors, recordingInterrupted: state.recordingInterrupted,
          } : null };
        })).then(value => { if (!observer.closed) this.writeDiagnostic('progress', JSON.stringify(value)); })];
        for (const context of observer.contexts.values()) {
          if (context.contextState === 'closed' || !observer.cdp) continue;
          jobs.push(diagnosticDeadline(observer.cdp.send('WebAudio.getRealtimeData', { contextId: context.contextId }))
            .then(value => { if (!observer.closed) this.writeDiagnostic('webaudio', JSON.stringify({
              event: 'sample', contextId: context.contextId, contextState: context.contextState, ...value,
            })); }));
        }
        const results = await Promise.allSettled(jobs);
        for (const result of results) {
          if (result.status === 'rejected' && !observer.closed) this.writeDiagnostic('driver', result.reason?.message || 'Diagnostic sample failed');
        }
      } catch (error) { if (!observer.closed) this.writeDiagnostic('driver', 'Progress diagnostics failed: ' + error.message); }
      finally { observer.sampling = false; }
    };
    observer.timer = setInterval(() => { void sample(); }, 5000);
    observer.timer.unref?.();
    void sample();
  }

  captureDiskProgress() {
    this.assertTestProfile();
    const activePath = path.join(this.userDataDir, 'active-recording.json');
    if (!fs.existsSync(activePath)) return { active: false };
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8')).activeSession;
    if (!active || !/^[a-f0-9-]{36}$/i.test(active.recordId || '')) return { active: false };
    const result = { active: true, recordId: active.recordId, chunkCount: active.chunkCount, lastChunkAt: active.lastChunkAt, sourceFiles: 0, sourceBytes: 0, finalBytes: null };
    const walk = directory => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        // Dirent checks exclude links; inspect file metadata, never audio data.
        if (entry.isDirectory()) walk(filename);
        else if (entry.isFile() && /\.(webm|pcm|wav|m4a)$/.test(entry.name)) {
          const size = fs.statSync(filename).size;
          if (/^audio\.(webm|wav|m4a)$/.test(entry.name)) result.finalBytes = size;
          else { result.sourceFiles++; result.sourceBytes += size; }
        }
      }
    };
    walk(path.join(this.recordingsDir, active.recordId));
    return result;
  }

  detachRendererDiagnostics() {
    for (const [page, handlers] of this.rendererListeners) {
      handlers.closed = true;
      if (handlers.timer) clearInterval(handlers.timer);
      if (handlers.cdp) handlers.cdp.detach().catch(() => {});
      page.off('console', handlers.onConsole);
      page.off('pageerror', handlers.onPageError);
    }
    this.rendererListeners.clear();
  }

  async launch({ freshProfile = true } = {}) {
    this.assertTestProfile();

    // Packaged-build mode (opts.packagedExe or SUISSE_E2E_PACKAGED_EXE): drive
    // the built .exe instead of `quasar dev`. Removes the dev-server HMR/websocket
    // confound for the endurance test. Requires SUISSE_E2E_HOOKS=1 (the packaged
    // build's escape to enable the test hooks).
    const packagedExe = this.packagedExe || process.env.SUISSE_E2E_PACKAGED_EXE || null;

    const env = {
      ...process.env,
      API_BASE_URL: this.apiUrl,
      VITE_API_URL: this.apiUrl,
      SUISSE_TEST_USERDATA: this.userDataDir,
      SUISSE_TEST_CDP_PORT: String(this.cdpPort),
      ...(this.fakeAudioWav ? { SUISSE_TEST_FAKE_AUDIO: this.fakeAudioWav } : {}),
      ...((packagedExe || this.fakeAudioWav || this.appDir) ? { SUISSE_E2E_HOOKS: '1' } : {}),
      ...this.env,
    };

    this.detachRendererDiagnostics();
    this.beginDiagnostics(env);
    // Diagnostics live outside userdata and survive both fresh profiles and
    // close({ keepProfile: false }). Every launch gets a distinct directory.
    if (freshProfile && fs.existsSync(this.userDataDir)) {
      // Keep every previous run, including failures, before starting afresh.
      // Move only this verified test profile into a unique evidence directory.
      const evidenceRoot = path.resolve(WORK_DIR, 'evidence');
      fs.mkdirSync(evidenceRoot, { recursive: true });
      const evidence = fs.mkdtempSync(path.join(evidenceRoot, path.basename(this.userDataDir) + '-'));
      const destination = path.resolve(evidence, 'userdata');
      if (!destination.startsWith(evidenceRoot + path.sep)) throw new Error('Invalid evidence path');
      fs.renameSync(path.resolve(this.userDataDir), destination);
      this.writeDiagnostic('driver', 'Previous profile preserved at ' + destination);
    }
    fs.mkdirSync(this.userDataDir, { recursive: true });

    const childOptions = { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' };
    if (this.appDir) {
      const appDirectory = path.resolve(this.appDir);
      if (!fs.existsSync(path.join(appDirectory, 'package.json'))) throw new Error('Build the Electron app before using SUISSE_E2E_APP_DIR');
      this.proc = spawn(require('electron'), [appDirectory], childOptions);
    } else if (packagedExe) {
      // Spawn the packaged app directly (no shell, no dev server).
      this.proc = spawn(packagedExe, [], childOptions);
    } else {
      // shell:true — Node 20+ on Windows refuses to spawn .cmd shims directly
      // (CVE-2024-27980 hardening); the whole tree is killed via taskkill /T.
      this.proc = spawn('npx quasar dev -m electron', {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    }
    const captureOutput = channel => data => {
      const message = data.toString();
      this.log.push(message);
      this.writeDiagnostic(channel, message);
    };
    this.proc.stdout.on('data', captureOutput('stdout'));
    this.proc.stderr.on('data', captureOutput('stderr'));

    // Wait for the CDP endpoint (quasar dev + electron start takes a while)
    const deadline = Date.now() + 180_000;
    let version = null;
    while (Date.now() < deadline) {
      try {
        version = await fetchJson(`http://127.0.0.1:${this.cdpPort}/json/version`);
        break;
      } catch (e) { await sleep(1500); }
    }
    if (!version) {
      throw new Error(`App did not open CDP port ${this.cdpPort} within 3min.\nLast output:\n${this.log.slice(-30).join('')}`);
    }

    this.browser = await puppeteer.connect({
      browserWSEndpoint: version.webSocketDebuggerUrl,
      defaultViewport: null,
    });

    await this.waitForStablePage();
    return this;
  }

  /**
   * quasar dev hot-reloads the renderer after the first compile, detaching
   * frames mid-wait. Re-resolve the page and re-try until either the login
   * form or the record page is present and SURVIVES a settle delay.
   */
  async waitForStablePage(timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    const seenUrls = new Set();
    while (Date.now() < deadline) {
      try {
        const pages = await this.browser.pages();
        this.page = pages.find(p => !p.url().startsWith('devtools://') && p.url() !== 'about:blank')
          || pages.find(p => !p.url().startsWith('devtools://'));
        if (!this.page) { await sleep(1500); continue; }
        await this.observeRenderer(this.page);
        seenUrls.add(this.page.url());
        // Fresh profiles land on the WELCOME page ("Anmelden" / "LOSLEGEN")
        // before any login form exists — click through it like a user.
        await this.page.evaluate(() => {
          const els = [...document.querySelectorAll('button, a, .q-btn')];
          const hit = els.find(el => /anmelden|log\s?in|sign\s?in/i.test(el.textContent || ''))
            || els.find(el => /loslegen|get started/i.test(el.textContent || ''));
          if (hit && !document.querySelector('input[type=email]') && !document.querySelector('[data-test=record-start]')) {
            hit.click();
          }
        }).catch(() => { /* page mid-navigation */ });
        // A restored-session relaunch (crash/power-loss recovery tests) lands on
        // the desktop HOME route (/about), which has neither the login form nor
        // the record button. Hop to /record so the page stabilizes on the record
        // UI. A valid session shows record-start there; an invalid one is bounced
        // to /login (email form) — either way waitForSelector below resolves.
        await this.page.evaluate(() => {
          if (location.hash.includes('/about') &&
              !document.querySelector('input[type=email]') &&
              !document.querySelector('[data-test=record-start]')) {
            location.hash = '#/record';
          }
        }).catch(() => { /* page mid-navigation */ });
        await this.page.waitForSelector('input[type=email], [data-test=record-start]', { timeout: 20_000 });
        await sleep(2500); // survive an imminent hot-reload
        await this.page.waitForSelector('input[type=email], [data-test=record-start]', { timeout: 10_000 });
        return this.page;
      } catch (e) {
        lastErr = e;
        await sleep(1500);
      }
    }
    // Post-mortem aids: page URL history + a screenshot of whatever is shown.
    try { await this.screenshot('stable-page-timeout'); } catch (e) { /* page may be dead */ }
    throw new Error(`App page never stabilized (urls seen: ${[...seenUrls].join(', ') || 'none'}): ${lastErr?.message}\nLast output:\n${this.log.slice(-20).join('')}`);
  }

  /** The recordId of the current/last recording, read from the store. */
  async getRecordId() {
    return this.page.evaluate(() => {
      const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
      return pinia?.state?.value?.recording?.recordId ?? null;
    });
  }

  /** Read a recording's history record (audioFileId, transcriptionId, status). */
  async getHistoryRecord(recordId) {
    return this.page.evaluate((rid) => {
      const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
      const recs = pinia?.state?.value?.['recordings-history']?.recordings
        || pinia?.state?.value?.recordingsHistory?.recordings || [];
      const r = recs.find(x => x.id === rid);
      return r ? { id: r.id, audioFileId: r.audioFileId, transcriptionId: r.transcriptionId, uploadStatus: r.uploadStatus, duration: r.duration } : null;
    }, recordId);
  }

  /** Realistic login through the actual form (no-op if already logged in). */
  async login(email = 'e2e@test.local', password = 'e2e-password') {
    const attempt = async () => {
      if (await this.page.$('[data-test=record-start]')) return true; // session restored
      await this.page.waitForSelector('input[type=email]', { timeout: 30_000 });
      await this.page.type('input[type=email]', email, { delay: 20 });
      await this.page.type('input[type=password]', password, { delay: 20 });
      await this.page.click('button[type=submit]');
      await this.page.waitForSelector('[data-test=record-start]', { timeout: 60_000 });
      return true;
    };
    try {
      return await attempt();
    } catch (e) {
      // One retry after re-stabilizing (hot reload or slow route guard).
      await this.waitForStablePage();
      return attempt();
    }
  }

  /**
   * Force the minutes store to unlimited directly in the page. Belt-and-
   * suspenders over the mock's unlimited response: guarantees the credit gate
   * (the "Kein Guthaben mehr" dialog) can never block a test regardless of API
   * routing / CORS / caching. Returns what it found, for diagnostics.
   */
  async seedUnlimitedMinutes() {
    return this.page.evaluate(() => {
      const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
      const m = pinia?.state?.value?.minutes;
      if (!m) return { seeded: false, reason: 'no minutes store' };
      const before = { remaining: m.remaining, unlimited: m.unlimited };
      m.unlimited = true;
      m.remaining = -1;
      m.total = -1;
      m.lastFetchedAt = Date.now(); // suppress the pre-start syncWithServer refetch
      return { seeded: true, before };
    });
  }

  async clickByTest(sel, timeout = 15_000) {
    await this.page.waitForSelector(sel, { timeout });
    await this.page.$eval(sel, (el) => {
      el.scrollIntoView({ block: 'center' });
      el.click();
    });
  }

  /**
   * Resilient start: the path from "idle" to "recording" has several racy
   * gates (credit re-sync on click, storage-preference dialog on first run,
   * button ripple/tooltip overlaps). Instead of a fixed click sequence, poll:
   * every second, look at the page and take whatever action moves us forward —
   * dismiss a credit dialog + re-seed, confirm the storage dialog, click
   * record if idle — until the recording phase is reached.
   */
  async startRecording(timeoutMs = 90_000) {
    await this.page.waitForSelector('[data-test=record-start], [data-test=record-stop]', { timeout: 60_000 });
    const deadline = Date.now() + timeoutMs;
    let lastAction = '';
    while (Date.now() < deadline) {
      const phase = await this.getPhase();
      if (phase === 'recording' || await this.page.$('[data-test=record-stop]')) return;

      const view = await this.page.evaluate(() => {
        const q = (sel) => document.querySelector(sel);
        const dialogText = [...document.querySelectorAll('.q-dialog')].map(d => d.textContent || '').join(' ');
        return {
          hasStart: !!q('[data-test=record-start]'),
          hasStorage: !!q('[data-test=storage-dialog-confirm]'),
          hasCredit: /Guthaben|no credit|minutes remaining|Kein Guthaben/i.test(dialogText),
        };
      });

      if (view.hasStorage) {
        await this.clickByTest('[data-test=storage-dialog-confirm]', 5_000).catch(() => {});
        lastAction = 'storage-confirm';
      } else if (view.hasCredit) {
        // Re-seed unlimited and dismiss the credit dialog, then retry start.
        await this.seedUnlimitedMinutes();
        await this.page.evaluate(() => {
          const btn = [...document.querySelectorAll('.q-dialog .q-btn')]
            .find(b => /später|later|abbrechen|cancel|schließen|close|vielleicht/i.test(b.textContent || ''));
          if (btn) btn.click();
        });
        lastAction = 'credit-dismiss+reseed';
      } else if (view.hasStart) {
        await this.seedUnlimitedMinutes();
        await this.clickByTest('[data-test=record-start]', 5_000).catch(() => {});
        lastAction = 'click-start';
      }
      await sleep(1000);
    }
    await this.screenshot('start-timeout');
    throw new Error(`Could not reach recording state within ${timeoutMs}ms (last action: ${lastAction}, phase: ${await this.getPhase()})`);
  }

  async stopRecording(timeoutMs = 30_000) {
    // In-page clicks bypass puppeteer hit-testing (a round q-btn reports
    // "not clickable" when a tooltip/ripple overlaps its center). Poll until
    // the recording phase actually ends — a single click can be swallowed if
    // the confirm bottom-sheet is mid-animation.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const phase = await this.getPhase();
      if (phase && phase !== 'recording' && phase !== 'paused') return;
      if (await this.page.$('[data-test=record-stop-confirm]')) {
        await this.clickByTest('[data-test=record-stop-confirm]', 5_000).catch(() => {});
      } else if (await this.page.$('[data-test=record-stop]')) {
        await this.clickByTest('[data-test=record-stop]', 5_000).catch(() => {});
      }
      await sleep(1000);
    }
    throw new Error(`Could not stop recording within ${timeoutMs}ms (phase: ${await this.getPhase()})`);
  }

  /** Wait until the recording store reports a phase (polled via the DOM-less
   *  Pinia store — read through the app's own reactive state). */
  async waitForPhase(phases, timeoutMs = 120_000) {
    const wanted = Array.isArray(phases) ? phases : [phases];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const phase = await this.getPhase();
      if (wanted.includes(phase)) return phase;
      await sleep(1000);
    }
    throw new Error(`Timed out waiting for phase ${wanted} (current: ${await this.getPhase()})`);
  }

  /**
   * H-003 fix: wrap page.evaluate in a hard timeout. If the app's renderer
   * freezes or the frame detaches during a long run, puppeteer's evaluate can
   * block for a very long time (observed: a single call hung ~2h on a dead
   * frame during the s7 endurance run, stretching an 8h zombie). A fast reject
   * lets the caller detect a dead app and abort in seconds instead of hours.
   */
  async evalTimed(fn, arg, timeoutMs = 15_000) {
    return Promise.race([
      this.page.evaluate(fn, arg),
      new Promise((_, rej) => setTimeout(() => rej(new Error('evalTimed: app unresponsive (' + timeoutMs + 'ms)')), timeoutMs)),
    ]);
  }

  /** True if the app is still responsive (a quick round-trip succeeds). */
  async isAppAlive() {
    try { await this.evalTimed(() => 1, undefined, 10_000); return true; }
    catch (e) { return false; }
  }

  /** True only after REPEATED unresponsiveness — a single missed ping can be a
   *  transient GC pause / host-contention hiccup, not a dead app. Confirms
   *  death over several retries so a long endurance run doesn't false-fail on a
   *  momentary stall while the app is actually fine. */
  async confirmDead(retries = 4, gapMs = 20_000) {
    for (let i = 0; i < retries; i++) {
      if (await this.isAppAlive()) return false; // recovered -> not dead
      if (i < retries - 1) await sleep(gapMs);
    }
    return true;
  }

  /** Renderer memory + DOM-size snapshot — used to detect growth/leaks over a
   *  long run (the "renderer gets sluggish after hours" hypothesis). */
  async getRendererMemory() {
    try {
      return await this.evalTimed(() => ({
        heapMB: (window.performance && performance.memory && performance.memory.usedJSHeapSize)
          ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        heapLimitMB: (window.performance && performance.memory && performance.memory.jsHeapSizeLimit)
          ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null,
        domNodes: document.getElementsByTagName('*').length,
      }), undefined, 10_000);
    } catch (e) {
      return { heapMB: null, domNodes: null };
    }
  }

  async getPhase() {
    return this.evalTimed(() => {
      const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
      const state = pinia?.state?.value?.recording;
      return state?.phase ?? null;
    });
  }

  /** Read the mic-health state as the UI sees it (badge + message text). */
  async getMicHealthUi() {
    return this.evalTimed(() => {
      const badge = document.querySelector('.mic-health-row .q-badge');
      const msg = document.querySelector('.mic-health-message');
      return { badge: badge?.textContent?.trim() ?? null, message: msg?.textContent?.trim() ?? null };
    });
  }

  async navigate(route) {
    await this.page.evaluate((r) => { window.location.hash = `#${r}`; }, route);
    await sleep(1500);
  }

  async crashRenderer() {
    const client = await this.page.target().createCDPSession();
    await Promise.race([client.send('Page.crash').catch(() => {}), sleep(5000)]);
  }

  async screenshot(name) {
    const dir = path.join(WORK_DIR, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${name}_${Date.now()}.png`);
    await this.page.screenshot({ path: p });
    return p;
  }

  /** Newest finalized recording file in the isolated profile. */
  findOutputFile() {
    if (!fs.existsSync(this.recordingsDir)) return null;
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/^audio\.(webm|m4a|wav)$/.test(e.name)) files.push(p);
      }
    };
    walk(this.recordingsDir);
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] || null;
  }

  async close({ keepProfile = true } = {}) {
    this.assertTestProfile();
    this.writeDiagnostic('driver', 'Closing synthetic app; keepProfile=' + keepProfile);
    // Save the complete buffered child output before disconnect/kill; streamed
    // channel logs above additionally survive a crash before close is reached.
    if (this.diagnosticsDir) {
      try { fs.writeFileSync(path.join(this.diagnosticsDir, 'child-combined.log'), this.log.join('')); }
      catch (error) { this.log.push('[harness] Final diagnostic write failed: ' + error.message); }
    }
    this.detachRendererDiagnostics();
    try { this.browser?.disconnect(); } catch (e) { /* ignore */ }
    if (this.proc && !this.proc.killed) {
      // Kill the whole quasar/electron tree
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(-this.proc.pid, 'SIGKILL'); // only our detached process group
      } catch (e) { /* already gone */ }
    }
    this.proc = null;
    if (!keepProfile) fs.rmSync(this.userDataDir, { recursive: true, force: true });
  }
}

module.exports = { AppDriver, sleep };
