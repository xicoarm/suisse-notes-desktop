/**
 * Mobile app driver — Chromium (puppeteer-core) running the REAL capacitor
 * bundle with the native bridge shim + virtual recorder injected, mobile
 * emulation, the scenario WAV as the microphone and every production API
 * call rerouted to the mock backend (request interception; the bundle keeps
 * its production URL and CSP, nothing is rebuilt for the test).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { installBridge } = require('./bridge');
const { installVirtualRecorder } = require('./virtual-recorder');

const WORK_DIR = path.join(__dirname, '..', 'work');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findChrome() {
  const env = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env && fs.existsSync(env)) return env;
  const candidates = process.platform === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ] : [
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/opt/hostedtoolcache/chromium/latest/x64/chrome'
  ];
  const hit = candidates.find(p => p && fs.existsSync(p));
  if (!hit) throw new Error('No Chrome/Chromium found — set CHROME_PATH');
  return hit;
}

class MobileApp {
  /**
   * @param {object} opts
   * @param {string} opts.name        scenario name (profile + work dirs)
   * @param {object} opts.device      device server (startDeviceServer)
   * @param {object} opts.mock        mock backend (startMockBackend)
   * @param {string} [opts.platform]  'android' | 'ios'
   * @param {string} [opts.fakeAudioWav]
   * @param {object} [opts.recorder]  virtual recorder config (files, boundAppUuid, …)
   * @param {object} [opts.bridge]    extra bridge config (diskFree, battery)
   */
  constructor(opts) {
    this.name = opts.name;
    this.device = opts.device;
    this.mock = opts.mock;
    this.platform = opts.platform || 'android';
    this.fakeAudioWav = opts.fakeAudioWav || null;
    this.recorderCfg = opts.recorder || { poweredOn: false };
    this.bridgeCfg = opts.bridge || {};
    this.headful = !!opts.headful || process.env.SUISSE_MH_HEADFUL === '1';
    this.profileDir = opts.profileDir || path.join(WORK_DIR, 'profile', this.name);
    this.browser = null;
    this.page = null;
    this.console = [];
    this.apiHost = opts.apiHost || 'app.suisse-meets.ch';
  }

  async launch({ freshProfile = true } = {}) {
    if (freshProfile) fs.rmSync(this.profileDir, { recursive: true, force: true });
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--disable-dev-shm-usage',
      '--lang=de-CH'
    ];
    if (this.fakeAudioWav) args.push(`--use-file-for-fake-audio-capture=${this.fakeAudioWav}`);
    this.browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: this.headful ? false : true,
      userDataDir: this.profileDir,
      args,
      defaultViewport: null
    });
    this.page = (await this.browser.pages())[0] || await this.browser.newPage();
    // beforeunload prompts (the app guards navigation while recording) must
    // never block a scripted relaunch.
    this.page.on('dialog', (d) => d.accept().catch(() => {}));
    await this.page.setUserAgent(this.platform === 'ios'
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
      : 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36');
    await this.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    this.page.on('console', (m) => { this.console.push(`[${m.type()}] ${m.text()}`); if (this.console.length > 5000) this.console.shift(); });
    this.page.on('pageerror', (e) => this.console.push(`[pageerror] ${e.message}`));
    await this._installInterception();
    await this.page.evaluateOnNewDocument(installVirtualRecorder, this.recorderCfg);
    await this.page.evaluateOnNewDocument(installBridge, { platform: this.platform, deviceUrl: this.device.url, ...this.bridgeCfg });
    await this.page.goto(`${this.device.url}/`, { waitUntil: 'domcontentloaded' });
    await this.waitForStablePage();
    return this;
  }

  /** Production API host → mock backend; Sentry ingest → swallowed. */
  async _installInterception() {
    await this.page.setRequestInterception(true);
    this.page.on('request', (req) => {
      const url = req.url();
      try {
        const u = new URL(url);
        if (u.hostname === this.apiHost || u.hostname === 'app.suisse-notes.ch') {
          return req.continue({ url: `${this.mock.url}${u.pathname}${u.search}` });
        }
        if (/sentry\.io$/.test(u.hostname) || u.hostname.endsWith('.ingest.de.sentry.io')) {
          return req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
        }
        if (u.protocol === 'capacitor:') {
          // iOS: capacitor://localhost/_capacitor_file_/… is served by the WebView's
          // scheme handler on a phone. Chromium cannot fetch it — the app's
          // base64 fallback is what runs in that case, exactly as on iOS 26.
          return req.abort('failed');
        }
      } catch { /* non-URL */ }
      return req.continue();
    });
  }

  async waitForStablePage(timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        await this.page.evaluate(() => {
          const els = [...document.querySelectorAll('button, a, .q-btn')];
          const hit = els.find(el => /anmelden|log\s?in|sign\s?in|connexion|accedi/i.test(el.textContent || ''))
            || els.find(el => /loslegen|get started|commencer|inizia/i.test(el.textContent || ''));
          if (hit && !document.querySelector('input[type=email]') && !document.querySelector('[data-test=record-start]')) hit.click();
          if (location.hash.includes('/about') && !document.querySelector('input[type=email]') && !document.querySelector('[data-test=record-start]')) location.hash = '#/record';
        }).catch(() => {});
        await this.page.waitForSelector('input[type=email], [data-test=record-start]', { timeout: 10_000 });
        return;
      } catch (e) { lastErr = e; await sleep(1000); }
    }
    await this.screenshot('stable-page-timeout').catch(() => {});
    throw new Error(`App page never stabilized: ${lastErr?.message}\n${this.console.slice(-15).join('\n')}`);
  }

  async login(email = 'e2e@test.local', password = 'e2e-password') {
    if (await this.page.$('[data-test=record-start]')) return;
    await this.page.waitForSelector('input[type=email]', { timeout: 30_000 });
    await this.page.type('input[type=email]', email, { delay: 10 });
    await this.page.type('input[type=password]', password, { delay: 10 });
    await this.page.click('button[type=submit]');
    await this.page.waitForSelector('[data-test=record-start]', { timeout: 60_000 });
    await this.seedUnlimitedMinutes();
  }

  async evalTimed(fn, arg, timeoutMs = 15_000) {
    return Promise.race([
      this.page.evaluate(fn, arg),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`evalTimed: app unresponsive (${timeoutMs}ms)`)), timeoutMs))
    ]);
  }

  /** Read Pinia state through the app's own store instances. */
  async store(name, pick) {
    return this.evalTimed(([n, p]) => {
      const pinia = window.__harness?.pinia?.();
      const s = pinia?.state?.value?.[n];
      if (!s) return null;
      return p ? JSON.parse(JSON.stringify(p.split('.').reduce((o, k) => (o == null ? o : o[k]), s) ?? null)) : JSON.parse(JSON.stringify(s));
    }, [name, pick || null]);
  }
  async getPhase() { return this.store('recording', 'phase'); }
  async getRecordId() { return this.store('recording', 'recordId'); }
  async getHistory() { return (await this.store('recordings-history', 'recordings')) || (await this.store('recordingsHistory', 'recordings')) || []; }
  async getDeviceState() { return this.store('device'); }
  async recorder(fn, arg) { return this.evalTimed(([src, a]) => { const r = window.__harness.recorder; return (new Function('r', 'a', src))(r, a); }, [fn, arg]); }
  async harness(fn, arg) { return this.evalTimed(([src, a]) => (new Function('h', 'a', src))(window.__harness, a), [fn, arg]); }

  async seedUnlimitedMinutes() {
    return this.evalTimed(() => {
      const m = window.__harness?.pinia?.()?.state?.value?.minutes;
      if (!m) return false;
      m.unlimited = true; m.remaining = -1; m.total = -1; m.lastFetchedAt = Date.now();
      return true;
    });
  }

  /**
   * The device sync asks for pre-meeting context per file (a product
   * decision: the pipeline WAITS for the answer). Tap "skip" whenever the
   * prompt appears, and count the prompts so a scenario can assert it was
   * asked once per file.
   */
  autoSkipPrep(on = true) {
    this.prepPrompts = this.prepPrompts || 0;
    clearInterval(this._prepTimer);
    if (!on) return;
    this._prepTimer = setInterval(async () => {
      try {
        const btn = await this.page?.$('[data-test=prep-skip]');
        if (btn) { this.prepPrompts++; await this.page.$eval('[data-test=prep-skip]', el => el.click()); await sleep(800); }
      } catch { /* page navigating */ }
    }, 700);
  }

  async clickByTest(sel, timeout = 15_000) {
    await this.page.waitForSelector(sel, { timeout });
    await this.page.$eval(sel, (el) => { el.scrollIntoView({ block: 'center' }); el.click(); });
  }

  async navigate(route) {
    await this.page.evaluate((r) => { window.location.hash = `#${r}`; }, route);
    await sleep(800);
  }

  async startRecording(timeoutMs = 90_000) {
    await this.navigate('/record');
    await this.page.waitForSelector('[data-test=record-start], [data-test=record-stop]', { timeout: 60_000 });
    const deadline = Date.now() + timeoutMs;
    let lastAction = '';
    while (Date.now() < deadline) {
      const phase = await this.getPhase();
      if (phase === 'recording' || await this.page.$('[data-test=record-stop]')) return;
      const view = await this.page.evaluate(() => {
        const q = (sel) => document.querySelector(sel);
        const dialogText = [...document.querySelectorAll('.q-dialog')].map(d => d.textContent || '').join(' ');
        return { hasStart: !!q('[data-test=record-start]'), hasStorage: !!q('[data-test=storage-dialog-confirm]'), hasCredit: /Guthaben|no credit|minutes remaining|Kein Guthaben/i.test(dialogText) };
      });
      if (view.hasStorage) { await this.clickByTest('[data-test=storage-dialog-confirm]', 5_000).catch(() => {}); lastAction = 'storage-confirm'; }
      else if (view.hasCredit) {
        await this.seedUnlimitedMinutes();
        await this.page.evaluate(() => { const b = [...document.querySelectorAll('.q-dialog .q-btn')].find(x => /später|later|abbrechen|cancel|schließen|close|vielleicht/i.test(x.textContent || '')); if (b) b.click(); });
        lastAction = 'credit-dismiss';
      } else if (view.hasStart) { await this.seedUnlimitedMinutes(); await this.clickByTest('[data-test=record-start]', 5_000).catch(() => {}); lastAction = 'click-start'; }
      await sleep(1000);
    }
    await this.screenshot('start-timeout');
    throw new Error(`Could not reach recording state (last action: ${lastAction}, phase: ${await this.getPhase()})\n${this.console.slice(-10).join('\n')}`);
  }

  async stopRecording(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const phase = await this.getPhase();
      if (phase && phase !== 'recording' && phase !== 'paused') return;
      if (await this.page.$('[data-test=record-stop-confirm]')) await this.clickByTest('[data-test=record-stop-confirm]', 5_000).catch(() => {});
      else if (await this.page.$('[data-test=record-stop]')) await this.clickByTest('[data-test=record-stop]', 5_000).catch(() => {});
      await sleep(1000);
    }
    throw new Error(`Could not stop recording (phase: ${await this.getPhase()})`);
  }

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

  async waitFor(predicate, { timeoutMs = 60_000, every = 1000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await predicate();
      if (last) return last;
      await sleep(every);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  /** "App killed by the OS": SIGKILL the browser (no unload handlers run). */
  async kill() {
    const proc = this.browser?.process();
    try { proc?.kill('SIGKILL'); } catch { /* already gone */ }
    await new Promise(r => setTimeout(r, 1500));
    this.browser = null;
    this.page = null;
  }

  /** Relaunch on the same phone: profile (preferences, session) + VFS persist. */
  async relaunch() {
    if (!this.browser) return this.launch({ freshProfile: false });
    await this.page.goto(`${this.device.url}/`, { waitUntil: 'domcontentloaded' });
    await this.waitForStablePage();
    return this;
  }

  async screenshot(name) {
    const dir = path.join(WORK_DIR, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${this.name}_${name}_${Date.now()}.png`);
    await this.page.screenshot({ path: p });
    return p;
  }

  async close() {
    clearInterval(this._prepTimer);
    try {
      fs.mkdirSync(path.join(WORK_DIR, 'console'), { recursive: true });
      fs.writeFileSync(path.join(WORK_DIR, 'console', `${this.name}.log`), this.console.join('\n'));
    } catch { /* ignore */ }
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.browser = null;
  }
}

module.exports = { MobileApp, sleep, findChrome };
