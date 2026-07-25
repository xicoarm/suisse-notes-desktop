/* Debug: what happens after clicking record-start? */
'use strict';
const path = require('path');
const { buildScenario } = require('./lib/audio');
const { startMockBackend } = require('./lib/mock-backend');
const { AppDriver, sleep } = require('./lib/app-driver');

(async () => {
  const sc = buildScenario('dbg', [{ type: 'speech', seconds: 120 }]);
  const mock = await startMockBackend({ port: 3000 });
  const app = new AppDriver({ name: 'debug', apiUrl: mock.url, fakeAudioWav: sc.wavPath, cdpPort: 9339 });
  try {
    await app.launch();
    app.page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith('devtools') && !u.includes('localhost:930') && !/\.(js|css|png|woff2?|svg|map)(\?|$)/.test(u)) {
        console.log('NET>', r.method(), u.slice(0, 130));
      }
    });
    await app.login();
    console.log('LOGIN OK, clicking record-start');
    await app.page.click('[data-test=record-start]');
    for (let i = 1; i <= 5; i++) {
      await sleep(5000);
      const state = await app.page.evaluate(() => ({
        url: window.location.hash,
        hasStorageDialog: !!document.querySelector('[data-test=storage-dialog-confirm]'),
        hasStop: !!document.querySelector('[data-test=record-stop]'),
        hasStart: !!document.querySelector('[data-test=record-start]'),
        dialogs: [...document.querySelectorAll('.q-dialog')].map(d => d.textContent.slice(0, 120)),
        notifs: [...document.querySelectorAll('.q-notification')].map(n => n.textContent.slice(0, 160)),
        banners: [...document.querySelectorAll('.q-banner, .health-notice')].map(b => b.textContent.slice(0, 120)),
      }));
      console.log(`t=${i * 5}s`, JSON.stringify(state, null, 1));
      await app.screenshot(`debug_t${i * 5}`);
      if (state.hasStorageDialog) {
        console.log('clicking storage dialog confirm');
        await app.page.click('[data-test=storage-dialog-confirm]');
      }
      if (state.hasStop) { console.log('RECORDING STARTED'); break; }
    }
    // Interrogate the app from inside: token state + direct IPC results.
    const probe = await app.page.evaluate(async () => {
      const out = { hasElectronAPI: !!window.electronAPI };
      try { out.minutesIpc = window.electronAPI?.minutes ? await window.electronAPI.minutes.fetch() : 'no minutes api'; } catch (e) { out.minutesIpc = `threw: ${e.message}`; }
      try { out.mainApiUrl = window.electronAPI?.config?.getApiUrl ? await window.electronAPI.config.getApiUrl() : 'no config api'; } catch (e) { out.mainApiUrl = `threw: ${e.message}`; }
      try { out.storedToken = window.electronAPI?.auth?.getToken ? !!(await window.electronAPI.auth.getToken())?.token || JSON.stringify(await window.electronAPI.auth.getToken()).slice(0, 120) : 'no auth api'; } catch (e) { out.storedToken = `threw: ${e.message}`; }
      out.localStorageToken = !!localStorage.getItem('token') || Object.keys(localStorage).filter(k => /token|auth/i.test(k)).join(',');
      return out;
    });
    console.log('---- in-app probe ----');
    console.log(JSON.stringify(probe, null, 1));

    console.log('---- mock backend requests ----');
    for (const r of mock.state.requests) {
      console.log(`${r.method} ${r.url} (${r.bodyBytes}b)${r.note ? ' ' + r.note : ''}`);
    }

    // main-process log tail for start errors
    console.log('---- app output tail ----');
    console.log(app.log.slice(-15).join(''));
  } finally {
    await app.close({ keepProfile: true });
    await mock.close();
  }
})();

