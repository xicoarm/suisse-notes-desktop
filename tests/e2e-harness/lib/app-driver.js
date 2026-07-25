/**
 * App driver — launches the REAL desktop app (quasar dev electron) with the
 * dev-only test hooks and drives it over the Chrome DevTools Protocol like a
 * human: type credentials, click the record button, navigate pages, crash the
 * renderer. No mocked internals — the full renderer + main-process stack runs.
 */
'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORK_DIR = path.join(__dirname, '..', 'work');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class AppDriver {
  constructor(opts = {}) {
    this.cdpPort = opts.cdpPort || 9339;
    this.apiUrl = opts.apiUrl;                   // mock backend URL
    this.fakeAudioWav = opts.fakeAudioWav;       // scenario WAV fed as the mic
    this.userDataDir = opts.userDataDir || path.join(WORK_DIR, 'userdata', opts.name || 'default');
    this.env = opts.env || {};                   // extra env (e.g. VITE_SUISSE_MAX_DURATION_SECONDS)
    this.proc = null;
    this.browser = null;
    this.page = null;
    this.log = [];
  }

  get recordingsDir() {
    return path.join(this.userDataDir, 'recordings');
  }

  async launch({ freshProfile = true } = {}) {
    if (freshProfile) fs.rmSync(this.userDataDir, { recursive: true, force: true });
    fs.mkdirSync(this.userDataDir, { recursive: true });

    const env = {
      ...process.env,
      API_BASE_URL: this.apiUrl,
      VITE_API_URL: this.apiUrl,
      SUISSE_TEST_USERDATA: this.userDataDir,
      SUISSE_TEST_CDP_PORT: String(this.cdpPort),
      ...(this.fakeAudioWav ? { SUISSE_TEST_FAKE_AUDIO: this.fakeAudioWav } : {}),
      ...this.env,
    };

    // shell:true — Node 20+ on Windows refuses to spawn .cmd shims directly
    // (CVE-2024-27980 hardening); the whole tree is killed via taskkill /T.
    this.proc = spawn('npx quasar dev -m electron', {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    this.proc.stdout.on('data', d => this.log.push(d.toString()));
    this.proc.stderr.on('data', d => this.log.push(d.toString()));

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

  async getPhase() {
    return this.page.evaluate(() => {
      const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
      const state = pinia?.state?.value?.recording;
      return state?.phase ?? null;
    });
  }

  /** Read the mic-health state as the UI sees it (badge + message text). */
  async getMicHealthUi() {
    return this.page.evaluate(() => {
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
    await client.send('Page.crash').catch(() => { /* connection dies with the crash */ });
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
        else if (/\.(webm|m4a|wav)$/.test(e.name) && !e.name.startsWith('chunk')) files.push(p);
      }
    };
    walk(this.recordingsDir);
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] || null;
  }

  async close({ keepProfile = true } = {}) {
    try { this.browser?.disconnect(); } catch (e) { /* ignore */ }
    if (this.proc && !this.proc.killed) {
      // Kill the whole quasar/electron tree
      try { execSync(`taskkill /pid ${this.proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* already gone */ }
    }
    this.proc = null;
    if (!keepProfile) fs.rmSync(this.userDataDir, { recursive: true, force: true });
  }
}

module.exports = { AppDriver, sleep };
