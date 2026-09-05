'use strict';

// GitHub-hosted, synthetic-only entry point. It never selects a real backend,
// real microphone, installed customer profile, or packaged release executable.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const repository = path.resolve(__dirname, '../../..');
const work = path.join(repository, 'tests/e2e-harness/work');
const bundle = path.join(repository, 'dist/electron/UnPackaged');
const scenario = process.argv[2] || 's11-capture-qualification';
if (!['s11-capture-qualification', 's12-device-qualification', 's13-coded-endurance', 's15-main-crash-qualification', 's16-capture-clock-diagnostic'].includes(scenario)) {
  throw new Error('Unknown hosted qualification scenario');
}
const diagnostics = path.join(work, 'ci', scenario);
const endurance = scenario === 's13-coded-endurance';
const mainCrash = scenario === 's15-main-crash-qualification';
const captureClock = scenario === 's16-capture-clock-diagnostic';
const timeoutMs = (endurance ? 330 : mainCrash ? 10 : 20) * 60 * 1000;
fs.mkdirSync(diagnostics, { recursive: true });

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFileSync(path.join(diagnostics, 'supervisor.log'), line);
  process.stdout.write(line);
}

function assertLocalUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Qualification requires an HTTP mock backend on loopback');
  }
}

function childEnvironment(bundleSha) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Do not pass runner tokens, signing credentials, or external-service
    // credentials into the app, its synthetic profile, or diagnostic logs.
    if (/(^|_)(TOKEN|SECRET|PASSWORD|API_KEY)(_|$)/i.test(key) || /^(APPLE_|CSC_)/i.test(key)) continue;
    if (['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'SUISSE_E2E_PACKAGED_EXE', 'SUISSE_TEST_USERDATA', 'SUISSE_TEST_FAKE_AUDIO'].includes(key)) continue;
    if (endurance && key === 'VITE_SUISSE_MAX_DURATION_SECONDS') continue;
    environment[key] = value;
  }
  return {
    ...environment,
    API_BASE_URL: 'http://127.0.0.1:3000',
    VITE_API_URL: 'http://127.0.0.1:3000',
    SUISSE_E2E_HOOKS: '1',
    SUISSE_TEST_NETWORK_ISOLATION: '1',
    SUISSE_E2E_APP_DIR: bundle,
    SUISSE_E2E_BUNDLE_SHA: bundleSha,
    ...(endurance ? { SUISSE_ENDURANCE_SECONDS: '18300', SUISSE_ENDURANCE_PROCESSING_DISABLED: '0' } : {}),
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    SENTRY_AUTH_TOKEN: '',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  };
}

function stopTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' }); }
    catch (_) { /* the test may already have closed its process tree */ }
    return;
  }
  // AppDriver starts its Electron child in a separate process group on POSIX.
  // Snapshot descendants before stopping the supervisor, so those groups do
  // not survive an outer deadline and hold files open during artifact upload.
  let descendants = [pid];
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    for (let i = 0; i < descendants.length; i++) {
      for (const [childPid, parentPid] of rows) {
        if (parentPid === descendants[i] && !descendants.includes(childPid)) descendants.push(childPid);
      }
    }
  } catch (_) { /* still terminate the known test supervisor */ }
  for (const target of descendants.reverse()) {
    try { process.kill(target, 'SIGKILL'); } catch (_) { /* already exited */ }
  }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('This entry point is restricted to GitHub Actions; use the ordinary local harness instead');
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Qualification requires a native Windows or macOS runner');
  if (process.env.SUISSE_E2E_HOOKS !== '1' || process.env.SUISSE_TEST_NETWORK_ISOLATION !== '1') {
    throw new Error('Qualification requires explicit E2E and network-isolation flags');
  }
  assertLocalUrl(process.env.API_BASE_URL);
  assertLocalUrl(process.env.VITE_API_URL);
  if (process.env.SUISSE_E2E_PACKAGED_EXE) throw new Error('A packaged release executable cannot be used by this job');
  if (endurance && (process.env.SUISSE_ENDURANCE_SECONDS !== '18300' || process.env.SUISSE_ENDURANCE_PROCESSING_DISABLED !== '0' || process.env.VITE_SUISSE_MAX_DURATION_SECONDS)) {
    throw new Error('Hosted endurance requires exactly 18300 seconds, default processing, and no accelerated rotation override');
  }
  if (path.resolve(repository, process.env.SUISSE_E2E_APP_DIR || '') !== bundle) throw new Error('Unexpected Electron bundle directory');
  const bundlePackage = JSON.parse(fs.readFileSync(path.join(bundle, 'package.json'), 'utf8'));
  const mainEntry = path.resolve(bundle, bundlePackage.main);
  if (!mainEntry.startsWith(bundle + path.sep) || !fs.statSync(mainEntry).isFile()) throw new Error('Electron bundle entry is missing or outside the bundle');

  const manifest = {
    scenario, startedAt: new Date().toISOString(), timeoutMs,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    platform: process.platform, architecture: process.arch, osRelease: os.release(),
    node: process.version, electron: require('electron/package.json').version,
    runnerImage: process.env.ImageOS || null, runnerImageVersion: process.env.ImageVersion || null,
    scope: 'Generated microphone input through native Electron; local mock upload only. Hardware capture, AudioTee, TCC, and Bluetooth/USB are not qualified.',
    ...(captureClock ? { diagnosticOnly: true, secondsPerCase: 180, processingModes: ['default', 'disabled'],
      successMeaning: 'Measurements completed under valid controls; does not clear existing endurance or capture failures.' } : {}),
    ...(endurance ? { captureSeconds: 18300, naturalRotationSeconds: 17700, processingDisabled: false,
      productionBackendQualified: false, referenceGeneration: { generator: 'tests/e2e-harness/lib/coded-audio.js',
        firstFrameId: 0, randomSeed: null, plan: [{ type: 'speech', seconds: 18325 }] } } : {}),
  };
  fs.writeFileSync(path.join(diagnostics, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`Starting ${scenario} on ${manifest.platform}/${manifest.architecture}; ${timeoutMs / 60000}-minute deadline`);
  const child = spawn(process.execPath, [path.join(repository, 'tests/e2e-harness/run.js'), scenario, '--keep'], {
    cwd: repository, env: childEnvironment(manifest.commit), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('data', data => {
      fs.appendFileSync(path.join(diagnostics, name + '.log'), data);
      (name === 'stdout' ? process.stdout : process.stderr).write(data);
    });
  }
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    log('Qualification exceeded its deadline; preserving all existing evidence and stopping only its process tree');
    stopTree(child.pid);
  }, timeoutMs);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(deadline));
  let passed = !timedOut && result.code === 0;
  if (endurance && passed) {
    // A zero exit code from a shortened local smoke must never qualify this job.
    try {
      const evidence = JSON.parse(fs.readFileSync(path.join(work, 'result_s13-coded-endurance.json'), 'utf8'));
      passed = evidence.fiveHourQualificationPassed === true && evidence.requestedSeconds === 18300;
    } catch (error) { passed = false; log('Missing or unreadable endurance result: ' + error.message); }
    if (!passed) log('Endurance result did not prove the required real 5h05 capture');
  }
  if (captureClock && passed) {
    try {
      const evidence = JSON.parse(fs.readFileSync(path.join(work, 'result_s16-capture-clock-diagnostic.json'), 'utf8'));
      passed = evidence.measurementCompleted === true && evidence.secondsPerCase === 180 && evidence.cases?.length === 2 &&
        evidence.cases.every(entry => entry.measurementCompleted && entry.controlsValid);
    } catch (error) { passed = false; log('Missing or unreadable capture-clock result: ' + error.message); }
  }
  fs.writeFileSync(path.join(diagnostics, 'exit.json'), JSON.stringify({ ...result, timedOut, passed, finishedAt: new Date().toISOString() }, null, 2));
  log(passed ? (captureClock ? 'Capture-clock diagnostic completed; existing qualification failures remain open' : 'Synthetic qualification passed') : 'Synthetic qualification failed; review the retained profiles, audio, and logs');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Synthetic audio ${captureClock ? 'diagnostic' : 'qualification'}: ${passed ? 'passed' : 'failed'}\n\n` +
      `Native ${manifest.platform}/${manifest.architecture}, Electron ${manifest.electron}. ` +
      `The artifact contains generated audio, original chunks, test profiles and diagnostics. ` +
      `This is not a test of physical microphones, Bluetooth/USB, AudioTee, or macOS privacy permissions.\n` +
      (captureClock ? '\nThis compares one native input against the actual app mixer for three minutes per processing mode. It does not qualify five hours or clear historical failures. Negotiated format changes and both clocks are retained.\n' : '') +
      (endurance ? '\nThe requested capture is 5h05 at normal speed with the default 4h55 source rotation. Local mock acceptance beyond five hours does not prove acceptance by the production backend, whose limit is five hours. Regenerable input WAVs are excluded; their metadata and generator revision are retained.\n' : ''));
  }
  process.exitCode = passed ? 0 : 1;
}

main().catch(error => {
  log('Qualification supervisor failed: ' + (error.stack || error.message));
  process.exitCode = 1;
});
