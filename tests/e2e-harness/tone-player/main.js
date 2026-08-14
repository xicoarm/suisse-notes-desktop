/**
 * Endpoint-targeted tone player for the system-audio E2E scenario.
 *
 * Plays a sine wave to a SPECIFIC Windows audio output endpoint (via setSinkId),
 * so the harness can prove what the app's loopback capture does and does not
 * hear. This is the whole point of the 2026-08-14 incident: audio rendered to
 * the default COMMUNICATION endpoint is inaudible to a loopback bound to the
 * default MULTIMEDIA endpoint.
 *
 *   electron tests/e2e-harness/tone-player --device "Jabra" --freq 1000 --seconds 110
 *
 * --device is a case-insensitive substring of the endpoint label. The generic
 * "default"/"communications" pseudo-devices are skipped so we always bind to a
 * concrete endpoint. Prints the resolved device, then exits when done.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const opts = {
  device: arg('device', ''),
  freq: Number(arg('freq', '1000')),
  seconds: Number(arg('seconds', '10')),
  gain: Number(arg('gain', '0.2')),
};

app.commandLine.appendSwitch('use-fake-ui-for-media-stream'); // auto-grant, no prompt

app.whenReady().then(() => {
  ipcMain.handle('opts', () => opts);
  ipcMain.handle('log', (e, m) => { console.log(m); return true; });
  ipcMain.handle('done', (e, code) => { app.exit(code || 0); return true; });

  const win = new BrowserWindow({
    width: 420, height: 200, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  // Hard stop so a stuck player can never wedge a scenario.
  setTimeout(() => app.exit(3), (opts.seconds + 30) * 1000);
});

app.on('window-all-closed', () => app.exit(0));
