const { app, BrowserWindow, ipcMain, safeStorage, protocol, shell, dialog, Menu, Tray, nativeImage, desktopCapturer, systemPreferences, powerMonitor, powerSaveBlocker, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
// Effect gate (security review 10/2026, rounds 10 and 13): installed before any
// other module is loaded. Every effect in the context of a session that has
// ended is refused at the fs / child_process module boundary, right before the
// system call (effect-gate.js).
require('./effect-gate').installEffectGate();
const { bindSession } = require('./effect-gate');
const { createAppPorts } = require('./app-ports');
const { writeFileAtomic, writeFileAtomicSync, publishFile, concatenateFiles, archiveChunkBatch, listChunkBatches, syncDirectorySync, assertPublishAllowed } = require('./durable-files');
const { createRecordingPersistence, readFinalizedRecording, listSessions } = require('./recording-persistence');
const nativeSourcePersistence = require('./native-source-persistence');
const { createNativeSourceFinalization } = require('./native-source-finalization');
const { createTokenVault } = require('./token-vault');
const { NATIVE_CAPTURE_MODE, usesNativeSources, readNativeCaptureMarker, markNativeCaptureSession } = require('./native-recording-session');
const { assessRecordingUpload, FINALIZATION_PENDING_MARKER } = require('./recording-upload-eligibility');
const { withCaptureWarnings, hydrateHistoryCaptureWarnings } = require('./recording-history-warnings');
const { createRecordingExporter, repairRecoveredHistoryRecord, assertExportRecoveryReady } = require('./recording-export');
const { createPcmCapture } = require('./pcm-capture');
const { resolveSysLoopbackPath, sysLoopbackArgs, describeHelperEvent, parseDeviceSessions } = require('./windows-system-audio');
const pcmCaptureEvidence = require('./pcm-capture-evidence');
const { validateNativeMedia } = require('./native-media-validation');
const { tokenUserId, canUploadForUser, verifiedUploadResult } = require('./upload-safety');
const { pathToFileURL } = require('url');
const axios = require('axios');
const Store = require('electron-store');
const ffmpeg = require('fluent-ffmpeg');
const { autoUpdater } = require('electron-updater');
const { createUpdateChecks, isPersistentDownloadError, UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_AFTER_WAKE_MS, UPDATE_CHECK_MIN_GAP_MS } = require('./update-checks');
const log = require('electron-log');
const Sentry = require('@sentry/electron/main');
const { machineIdSync } = require('node-machine-id');
const { createScopeRegistry, isSessionEnded } = require('./session-scope');
const { createBackground } = require('./background');
const queueOps = require('./background/queue-ops');

// === App identity pinning (display "Suisse Meets", machine "Suisse Notes") ===
// Keeps userData at %APPDATA%\Suisse Notes and the macOS safeStorage Keychain
// service at "Suisse Notes Safe Storage" across the rebrand — nothing moves,
// no one is logged out; only the display name changes. Full rationale in
// src-electron/app-identity.js. Must run before ANYTHING touches userData or
// safeStorage (Sentry/crashpad, electron-store, electron-log, the
// single-instance lock), hence synchronous at module top.
require('./app-identity').pinAppIdentity(app);

// Trust the OS certificate store from the main process. Must run before any
// outbound HTTPS (auto-update, uploads, Sentry) so corporate / TLS-inspection
// roots are honoured. See os-ca.js for the full rationale.
require('./os-ca').installOsTrustStore();

// Route main-process axios traffic through the OS-configured proxy. Node
// ignores Windows/macOS proxy settings; on proxy-enforcing networks direct
// connects are dropped and uploads die with ETIMEDOUT while the renderer
// works. See os-proxy.js for the full rationale.
require('./os-proxy').installSystemProxy();

// === Log Rotation Configuration ===
// Prevent infinite log file growth
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB max per log file
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}] [{level}] {text}';
log.transports.file.archiveLogFn = (oldLogFile) => {
  // Keep up to 3 archived log files
  const archivePath = oldLogFile.path + '.old';
  const fs = require('fs');

  // Remove oldest archive if it exists
  const archive3 = archivePath + '.3';
  const archive2 = archivePath + '.2';
  const archive1 = archivePath + '.1';

  try {
    if (fs.existsSync(archive3)) fs.unlinkSync(archive3);
    if (fs.existsSync(archive2)) fs.renameSync(archive2, archive3);
    if (fs.existsSync(archive1)) fs.renameSync(archive1, archive2);
    if (fs.existsSync(archivePath)) fs.renameSync(archivePath, archive1);
    fs.renameSync(oldLogFile.path, archivePath);
  } catch (e) {
    console.warn('Log rotation error:', e);
  }
};

// Initialize Sentry for crash reporting (must be early)
// Client-network failure modes that are almost always user-side (dropped WiFi,
// captive portal, ISP DNS hiccup, antivirus intercept) rather than our bug or
// backend outage. We still keep them in Sentry at 'warning' level so aggregate
// trends are visible, but they should not trigger error-level alerts.
const TRANSIENT_NETWORK_CODES = new Set([
  'ENOTFOUND',      // DNS couldn't resolve host
  'ETIMEDOUT',      // TCP connect/read timeout
  'ECONNABORTED',   // axios cancelled the request (its own timeout fired)
  'ECONNRESET',     // connection dropped mid-transfer
  'EPIPE',          // peer closed the connection while we were writing
  'ENETUNREACH',    // no route to host
  'EAI_AGAIN'       // transient DNS failure
]);
// 408: the server gave up waiting for the client. 502/503/504: nginx while the
// backend restarts — already retried by api-resilience.js, so one that
// reaches a log line is a restart or outage, not a client bug.
const TRANSIENT_NETWORK_STATUSES = new Set([408, 502, 503, 504]);

function isTransientNetworkError(err, message) {
  if (err && TRANSIENT_NETWORK_CODES.has(err.code)) return true;
  // api-resilience.js: HTML page instead of JSON, or an exhausted gateway retry.
  if (err?.code === 'ENONJSON' || err?.transient === true) return true;
  if (err?.response?.status && TRANSIENT_NETWORK_STATUSES.has(err.response.status)) return true;
  if (typeof message === 'string') {
    if (/socket hang up/i.test(message)) return true;
    if (/network error/i.test(message)) return true;
    if (/getaddrinfo/i.test(message)) return true;
    // The SDK's own unhandled-rejection hook reports these before the
    // process handler below can filter them (ELECTRON-67: an update download
    // cut by the laptop going back to sleep; the updater retries later).
    if (/net::ERR_NETWORK_CHANGED|net::ERR_NETWORK_IO_SUSPENDED|net::ERR_INTERNET_DISCONNECTED/i.test(message)) return true;
  }
  return false;
}

const sentryReporting = require('./sentry-reporting');

Sentry.init({
  enabled: process.env.SUISSE_E2E_HOOKS !== '1',
  dsn: 'https://185912b1585eb5138079ae189a6d41ec@o4510659364716544.ingest.de.sentry.io/4510659366748240',
  // E2E test runs drive the *packaged* app with SUISSE_E2E_HOOKS=1. Without this
  // guard those runs would tag events `production` and masquerade as real-user
  // incidents in the same issue stream (the mic-health/recovery telemetry fires
  // loudly by design). Route them to a dedicated `e2e` environment so triage can
  // filter `environment:production` and never see synthetic test noise.
  environment: process.env.SUISSE_E2E_HOOKS === '1'
    ? 'e2e'
    : (app.isPackaged ? 'production' : 'development'),
  release: `suisse-notes@${app.getVersion()}`,
  // Desktop diagnosis used to depend on asking the user for main.log. Keep the
  // stack of every captured message and a long breadcrumb trail so a single
  // event carries the steps that led to it.
  attachStacktrace: true,
  maxBreadcrumbs: 200,
  beforeSend(event, hint) {
    // Scrub sensitive data from error reports
    if (event.request?.headers?.authorization) {
      event.request.headers.authorization = '[REDACTED]';
    }
    // Read-only volume: the app guides the user to move it to /Applications, so
    // this is not an incident — but it stays reportable, because how often it
    // happens is exactly what we could not see while it was dropped here.
    const message = event.exception?.values?.[0]?.value || event.message || '';
    if (message.includes('read-only volume') || (message.includes('read-only') && message.includes('move the application'))) {
      event.level = 'warning';
      event.tags = { ...(event.tags || {}), handled_by_ux: 'read-only-volume' };
    }
    // Downgrade client-transient network errors to 'warning' so alert rules
    // scoped to error level stop paging on user WiFi drops.
    if (isTransientNetworkError(hint?.originalException, message)) {
      event.level = 'warning';
      event.tags = { ...(event.tags || {}), transient_network: 'true' };
    }
    // Errors and log lines reach Sentry as raw objects (sentry-reporting.js
    // captureException): redact message, exception values, stack, extra,
    // contexts and breadcrumbs here, for every event of the main process.
    return sentryReporting.redactEvent(event);
  },
  beforeBreadcrumb(crumb) {
    return sentryReporting.redactBreadcrumb(crumb);
  }
});

// Everything the main process logs is now reported: an error line becomes a
// Sentry event, a warning becomes a warning-level event, and info lines become
// breadcrumbs. Before this, a failed AudioTee start, a failed finalization or a
// refused IPC call existed only in the user's local main.log.
// (sentryReporting is required above Sentry.init: beforeSend redacts with it.)
const twoFactorAuth = require('./auth-two-factor');
sentryReporting.installLogReporting({ log, Sentry });
// R-S7.5: log lines and events of the port chain leave the session context here.
const { telemetry } = createAppPorts({ log, Sentry });
const windowReporting = sentryReporting.installWindowReporting({ Sentry, log });

// === Global Error Handlers ===
// Catch uncaught exceptions in main process
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error);
  telemetry({ exception: error });
  // Don't exit immediately - try to keep app running for upload completion
});

process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message || String(reason);
  // electron-updater's SimpleURLLoaderWrapper leaks unhandled rejections when
  // a download chunk fails mid-transfer (network flicker, VPN reconnect,
  // sleep/wake). The updater retries internally and surfaces a real failure
  // via autoUpdater.on('error') if it gives up — so this rejection is noise.
  if (/net::ERR_NETWORK_CHANGED|net::ERR_NETWORK_IO_SUSPENDED|net::ERR_INTERNET_DISCONNECTED/i.test(msg)) {
    // Keep it out of the error stream, but no longer invisible: the log hook
    // files it as a warning, so a download that really dies in this shape is
    // still countable.
    log.warn('Transient net:: rejection (likely auto-updater during network change):', msg);
    return;
  }
  log.error('Unhandled Rejection at:', promise, 'reason:', reason);
  telemetry({ exception: reason instanceof Error ? reason : new Error(String(reason)) });
});

// Handle renderer process crashes
app.on('render-process-gone', (event, webContents, details) => {
  if (mainWindow && !mainWindow.isDestroyed() && webContents !== mainWindow.webContents) return;
  isRecordingInProgress = false;
  isProcessingRecording = false;
  unsavedRecordingId = null;
  updateRecordingPowerBlocker();
  log.error('Renderer process gone:', details);
  Sentry.captureMessage(`Renderer crashed: ${details.reason}`, 'error');

  // The renderer owned the capture session. AudioTee (macOS system audio) is a
  // spawned child that would otherwise keep writing wall-clock PCM to disk with
  // no mic timeline to pair it with — the eventual merge of that torn pair
  // produces a badly desynced file. Stop it now; recovery re-files what exists.
  stopSystemAudio().catch(e => log.warn('Failed to stop AudioTee after renderer crash:', e?.message));

  // P0 Data Loss Fix: Write crash metadata for active recording (V8)
  // Do NOT clear active recording state - let the recovery find it on next launch
  try {
    const activeSession = getActiveRecording();
    if (activeSession && activeSession.recordId) {
      const recordPath = getRecordingPath(activeSession.recordId);
      const metadataPath = path.join(recordPath, 'metadata.json');

      let metadata = {};
      if (fs.existsSync(metadataPath)) {
        try {
          metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        } catch (e) { /* start fresh */ }
      }

      metadata.captureWarnings = [...new Set([...(metadata.captureWarnings || []), 'renderer-crash'])];
      metadata.status = 'interrupted';
      metadata.crashReason = details.reason;
      metadata.crashedAt = new Date().toISOString();
      metadata.chunkCount = activeSession.chunkCount;
      metadata.userId = activeSession.userId || metadata.userId;

      writeFileWithSync(metadataPath, JSON.stringify(metadata, null, 2));
      log.info('Crash metadata written for recording:', activeSession.recordId);
    }
  } catch (e) {
    log.error('Failed to write crash metadata:', e);
  }
});

app.on('child-process-gone', (event, details) => {
  // Normal process termination (e.g. idle worker or clean shutdown) is expected lifecycle
  if (details.reason === 'clean-exit') {
    log.info('Child process exited cleanly:', details.type || 'unknown');
    return;
  }

  // OS process termination
  if (details.reason === 'killed') {
    log.warn('Child process killed:', details);
    return;
  }

  log.warn('Child process gone:', details);

  const isRecording = Boolean(isRecordingInProgress || (typeof getActiveRecording === 'function' && getActiveRecording()?.recordId));

  // Detect Audio Service crash (macOS ScreenCaptureKit bug / Windows audio reset) and notify renderer to recover
  if (details.serviceName === 'audio.mojom.AudioService' && details.reason === 'crashed') {
    log.warn('Audio Service crashed — notifying renderer to recover system audio');
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToRenderer('system:audio-service-crashed', {
        reason: details.reason,
        exitCode: details.exitCode
      });
    }
  }

  // Chromium GPU process restarts automatically on driver/display reset (Windows TDR / macOS GPU switch)
  if (details.type === 'GPU') {
    Sentry.withScope(scope => {
      scope.setLevel('warning');
      scope.setTag('source', 'child-process');
      scope.setTag('process_type', 'GPU');
      if (details.exitCode !== undefined) scope.setTag('exit_code', String(details.exitCode));
      scope.setTag('recording_active', String(isRecording));
      scope.setExtra('details', details);
      Sentry.captureMessage(`GPU process crashed (${details.reason || 'crashed'})`, 'warning');
    });
    return;
  }

  // If a child process crashes during an active recording, report as error
  if (isRecording) {
    Sentry.withScope(scope => {
      scope.setLevel('error');
      scope.setTag('source', 'child-process');
      scope.setTag('process_type', details.type || 'unknown');
      if (details.serviceName) scope.setTag('service_name', details.serviceName);
      if (details.exitCode !== undefined) scope.setTag('exit_code', String(details.exitCode));
      scope.setTag('recording_active', 'true');
      scope.setExtra('details', details);
      Sentry.captureMessage(`Child process crashed during recording: ${details.serviceName || details.type || 'unknown'} (${details.reason})`, 'error');
    });
    return;
  }

  // Idle background utility / worker restart that Chromium handles
  Sentry.withScope(scope => {
    scope.setLevel('warning');
    scope.setTag('source', 'child-process');
    scope.setTag('process_type', details.type || 'unknown');
    if (details.serviceName) scope.setTag('service_name', details.serviceName);
    if (details.exitCode !== undefined) scope.setTag('exit_code', String(details.exitCode));
    scope.setTag('recording_active', 'false');
    scope.setExtra('details', details);
    Sentry.captureMessage(`Child process gone: ${details.serviceName || details.type || 'unknown'} (${details.reason})`, 'warning');
  });
});

// === SSO Custom Protocol (suissenotes://) ===
// The system browser hits /api/auth/microsoft/login?client=desktop; the backend
// callback redirects to suissenotes://auth/callback?token=...&user=<b64>. The
// OS routes that URL to this app via either argv (Win/Linux) or 'open-url' (Mac).
const SSO_PROTOCOL = 'suissenotes';

if (process.env.SUISSE_E2E_HOOKS === '1') {
  // Test runs (harness, unpacked build) never take over the suissenotes://
  // links: on 06.10.2026 a local test run re-registered them for its dev
  // Electron, and the installed app's SSO callback would have opened the test
  // build. Tests deliver SSO results via the second-instance argv instead.
} else if (process.defaultApp) {
  // Dev mode: pass execPath + script path so the OS knows how to relaunch us
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(SSO_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(SSO_PROTOCOL);
}

// The last SSO result is kept by the session authority until the renderer
// confirms it has it (auth:takePendingSSO). A result pushed while the renderer
// is still booting (cold start by the suissenotes:// URL, a reload) used to be
// lost: the push arrived before any listener existed.
let ssoDeliverySeq = 0;

ipcMain.handle('auth:takePendingSSO', () => (sessionAuthority ? sessionAuthority.takePending() : null));

const ssoFlow = require('./sso-flow');
const { createSessionAuthority, fileRecordStore, configUserStore, configMarkStore, tokenUserId: sessionTokenUserId, RECORD_FILE } = require('./session-authority');
// Created below, after configStore: the pending flow lives in configStore
// (survives a restart: the browser sign-in may come back to a cold start).
let ssoFlows = null;
let sessionAuthority = null;
// Background scopes (session-scope.js); created once the stores exist.
let scopes = null;
let handleSsoCallback = null;

// Exchange a one-time SSO code for the session (PKCE, newer server contract).
async function exchangeSsoCode(authCode, verifier, state) {
  try {
    const response = await axios.post(`${API_BASE_URL}/api/auth/sso/exchange`,
      { authCode, codeVerifier: verifier, state },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    const data = response.data || {};
    if (data.token && data.user && typeof data.user === 'object') return { token: data.token, user: data.user };
  } catch (error) {
    log.warn(`SSO: code exchange failed (${error?.response?.status || error?.code || 'error'})`);
  }
  return { error: 'invalid_callback' };
}

// Buffer first, push second: the renderer acknowledges a push by taking the
// buffer (deliveryId lets it ignore the same result arriving both ways).
function deliverSsoResult(payload) {
  payload.deliveryId = ++ssoDeliverySeq;
  if (!sessionAuthority.setPending(payload)) return;
  log.info(`SSO: callback received (${payload.applied ? 'signed in' : `error code=${payload.code || '-'}`}), delivery ${payload.deliveryId}`);
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    sendToRenderer('auth:ssoCallback', payload);
  }
  if (payload.applied) afterSessionApplied();
}

async function handleSSOUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith(`${SSO_PROTOCOL}://`)) return;
  // SECURITY: applied only through the session authority with the ticket of
  // a flow this app started (state binding); see sso-flow.js.
  if (!handleSsoCallback) return;
  await handleSsoCallback(url);
}

// === Single Instance Lock ===
// Prevent multiple app instances from corrupting shared electron-store files
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  log.warn('Another instance is already running — quitting');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Win/Linux deliver the deep-link URL via argv on the second instance
    const ssoUrl = argv.find(a => typeof a === 'string' && a.startsWith(`${SSO_PROTOCOL}://`));
    if (ssoUrl) handleSSOUrl(ssoUrl).catch(() => {});
  });
}

// macOS deep-link handoff
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleSSOUrl(url).catch(() => {});
});

// Cold-start case (Win/Linux): the URL in our own argv is handled once
// configStore (and with it the persisted SSO flow) exists, see below.

// Configure auto-updater logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('Auto-updater initialized - v2 silent background updates enabled');

// Silent auto-update settings
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowDowngrade = false;

// Flag to skip auto-update when app is on a read-only volume (macOS DMG / Downloads)
let skipAutoUpdate = false;

// Note: Code signing is not yet configured. Existing users who installed a build
// with publisherName set will see a signature verification error and be prompted
// to manually download the latest version. New builds don't set publisherName,
// so future auto-updates will work without signatures.

// Note: For private GitHub repos, GH_TOKEN must be set during build
// electron-builder will automatically include it in app-update.yml

// === E2E test hooks (DEV ONLY — hard-gated on !app.isPackaged) ===============
// Used by tests/e2e-harness to run the REAL app against controlled conditions:
// - SUISSE_TEST_FAKE_AUDIO=<wav>  feeds a WAV file as the microphone through
//   Chromium's fake capture device — the genuine getUserMedia → MediaRecorder
//   → chunk → combine → upload pipeline runs against known ground-truth audio.
// - SUISSE_TEST_USERDATA=<dir>    isolates userData so harness runs can never
//   touch a real profile (recordings, tokens, queues) on the dev machine.
// - SUISSE_TEST_CDP_PORT=<port>   opens the DevTools protocol so the harness
//   can drive the UI like a user (click record, navigate, crash the renderer).
//
// Normally hard-gated on !app.isPackaged. The ENDURANCE test must run the
// PACKAGED build (the `quasar dev` server's HMR/websocket can detach the frame
// under load and invalidate a long run), so SUISSE_E2E_HOOKS=1 additionally
// enables these hooks in a packaged build. The shipped release NEVER sets that
// env var, so real users are unaffected; and the hooks themselves are benign
// (feed a WAV as the mic, isolate userData, open a local CDP port).
if (!app.isPackaged || process.env.SUISSE_E2E_HOOKS === '1') {
  if (process.env.SUISSE_TEST_NETWORK_ISOLATION === '1') {
    const loopback = value => {
      try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); }
      catch (_) { return false; }
    };
    if (process.env.SUISSE_E2E_HOOKS !== '1' || !process.env.SUISSE_TEST_USERDATA || !loopback(process.env.API_BASE_URL)) {
      throw new Error('Synthetic network isolation requires a test profile and loopback API');
    }
    app.on('session-created', testSession => {
      testSession.webRequest.onBeforeRequest((details, callback) => {
        const remote = /^(https?|wss?):/.test(details.url) && !loopback(details.url);
        if (remote) console.warn('Synthetic test blocked remote request:', new URL(details.url).origin);
        callback({ cancel: remote });
      });
    });
  }
  if (process.env.SUISSE_TEST_USERDATA) {
    app.setPath('userData', process.env.SUISSE_TEST_USERDATA);
  }
  if (process.env.SUISSE_TEST_FAKE_AUDIO) {
    app.commandLine.appendSwitch('use-fake-device-for-media-stream');
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.SUISSE_TEST_FAKE_AUDIO);
    // Skip the OS permission prompt for the fake device
    app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  }
  if (process.env.SUISSE_TEST_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.SUISSE_TEST_CDP_PORT);
  }
}

// Environment-aware API configuration
// Uses config.js for environment detection
const { getApiUrl, getEnvironmentInfo } = require('./config');
const API_BASE_URL = getApiUrl();
log.info('Environment:', getEnvironmentInfo());
// Backend restarts answer 502-504 for a few seconds: idempotent requests are
// retried, and an HTML page in place of JSON becomes a transient error.
require('./api-resilience').installApiResilience({ axios, log, getApiBaseUrl: () => API_BASE_URL });

// Disk space utilities for recording safety
const { canStartRecording, shouldForceStopRecording, canFinalizeRecording, getAvailableSpaceDetailed, formatBytes } = require('./disk-utils');

// Signal forensics for the macOS system-audio PCM stream (see pcm-signal.js):
// AudioTee only captures audio going to the DEFAULT output device, so a capture
// can be live and completely silent. Nothing measured it before.
const { createSystemAudioMonitor, createLevelMeter, meterPercent } = require('./pcm-signal');
const { evaluateTruncation } = require('./recording-integrity');

// Configuration store for persistent settings
const configStore = new Store({
  name: 'config',
  defaults: {
    authToken: '',
    deviceId: '',
    userInfo: null,  // Store user info for session restoration
    systemAudioEnabled: false  // System audio capture (off by default)
  }
});

// Session token: encrypted by the OS keystore only, never plaintext on disk
// (see token-vault.js; a legacy plaintext token is deleted, never adopted).
const tokenVault = createTokenVault({
  safeStorage,
  store: configStore,
  warn: (msg) => log.warn(msg),
  // E6: nothing is returned while the session authority says signed out.
  isAllowed: () => !!sessionAuthority && sessionAuthority.tokenAllowed()
});

ssoFlows = ssoFlow.createSsoFlowStore({ storage: configStore });

// Session authority: the one writer of token and user, and the sign-out
// tombstone that every main path honours (session-authority.js).
sessionAuthority = createSessionAuthority({
  recordStore: fileRecordStore(path.join(app.getPath('userData'), RECORD_FILE)),
  vault: tokenVault,
  userStore: configUserStore(configStore),
  // One-time migration of the previous version's session (E1 addendum).
  migrationMark: configMarkStore(configStore),
  flows: ssoFlows,
  // R-S3 (round 9): every epoch change ends every background scope.
  abortRequests: () => { if (scopes) scopes.abortAll(); },
  warn: (msg) => log.warn(msg)
});
// Also the one-time migration of the previous version's session (record
// missing): main alone, before any renderer exists. Held (RAM lock, nothing
// deleted) while the OS keystore is not open yet - see app.whenReady.
sessionAuthority.startup();

handleSsoCallback = ssoFlow.createSsoCallbackHandler({
  authority: sessionAuthority,
  flows: ssoFlows,
  exchange: exchangeSsoCode,
  deliver: deliverSsoResult,
  // Rollout stop signal: an open flow got a callback without the state echo
  // (backend without «SSO state echo»). No URL, no user data.
  countMissingState: () => Sentry.captureMessage('sso_missing_state', { level: 'warning', fingerprint: ['sso_missing_state'] }),
  log: (msg) => log.warn(msg)
});

// Cold-start case (Win/Linux): URL is in our own argv
{
  const ssoUrl = process.argv.find(a => typeof a === 'string' && a.startsWith(`${SSO_PROTOCOL}://`));
  if (ssoUrl) handleSSOUrl(ssoUrl).catch(() => {});
}

// Restore Sentry user context from stored session (so crash reports identify the user)
try {
  const storedUser = sessionAuthority.getUser();
  if (storedUser) {
    // Opaque account id only (no e-mail/name to telemetry).
    if (storedUser.id) Sentry.setUser({ id: String(storedUser.id) });
  }
} catch (e) { /* ignore */ }

// History store for recording history
const historyStore = new Store({
  name: 'recordings-history',
  defaults: {
    recordings: [],
    defaultStoragePreference: 'keep'  // 'keep' or 'delete_after_upload'
  }
});

// Upload queue store for offline persistence
const uploadQueueStore = new Store({
  name: 'upload-queue',
  defaults: {
    pendingUploads: []  // Array of { recordId, filePath, metadata, addedAt, retryCount }
  }
});

// Active recording store for crash recovery
const activeRecordingStore = new Store({
  name: 'active-recording',
  defaults: {
    activeSession: null  // { recordId, startedAt, chunkCount, userId, lastChunkAt }
  }
});

// === Active Recording State Management ===
// Track recording state for crash recovery

function updateActiveRecording(recordId, chunkCount, userId = null) {
  activeRecordingStore.set('activeSession', {
    recordId,
    startedAt: activeRecordingStore.get('activeSession')?.startedAt || new Date().toISOString(),
    chunkCount,
    userId,
    lastChunkAt: new Date().toISOString()
  });
}

function clearActiveRecording() {
  activeRecordingStore.set('activeSession', null);
}

function getActiveRecording() {
  return activeRecordingStore.get('activeSession');
}

// === Upload Queue Management ===
// Sentry throttle: one upload-failure exception per recordId per app session.
// Without it, every automatic retry pass of the same doomed upload produced a
// fresh Sentry event — ELECTRON-27 accumulated 533 events from 3 users.
const reportedUploadFailures = new Set();
function captureUploadFailureOnce(recordId, error, operation, extra = {}) {
  const key = `${operation}:${recordId}`;
  if (reportedUploadFailures.has(key)) {
    log.warn(`[upload] Suppressing repeat Sentry capture for ${key}: ${error?.message}`);
    return;
  }
  reportedUploadFailures.add(key);
  Sentry.captureException(error, { tags: { operation, recordId }, extra });
}

function recordingOwner(recordId) {
  const history = historyStore.get('recordings', []).find(r => r.id === recordId);
  if (history?.userId) return history.userId;
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(getRecordingPath(recordId), 'metadata.json'), 'utf8'));
    if (metadata.userId) return metadata.userId;
  } catch (_) { /* imported file or missing metadata */ }
  return uploadQueueStore.get('pendingUploads', []).find(r => r.recordId === recordId)?.userId || null;
}
function readUploadReceipt(recordId) {
  try { return JSON.parse(fs.readFileSync(path.join(getRecordingPath(recordId), 'upload-receipt.json'), 'utf8')); }
  catch (_) { return null; }
}

// Foreground queue changes (user cancel, remove, upload:start while signed
// out). Background work changes the queue only through its SessionScope.
function addToUploadQueue(recordId, filePath, metadata, userId = recordingOwner(recordId)) {
  uploadQueueStore.set('pendingUploads', queueOps.addToQueue(uploadQueueStore.get('pendingUploads', []), { recordId, filePath, metadata, userId }));
  log.info('Added to upload queue:', recordId);
}

function removeFromUploadQueue(recordId) {
  uploadQueueStore.set('pendingUploads', queueOps.removeFromQueue(uploadQueueStore.get('pendingUploads', []), recordId));
  log.info('Removed from upload queue:', recordId);
}

// === Background work (review round 9, council 3) ===
// Every piece of main's background work (upload queue, upload:start, direct
// and legacy upload, verification, polls, refresh, recovery, clean-up, the
// blob clean-up of a cancel) runs in a SessionScope opened at its entry and
// reaches effects only through it (session-scope.js, background/). The
// authority ends every scope at every epoch change, never at a refresh.
scopes = createScopeRegistry({
  authority: sessionAuthority,
  http: axios,
  stores: { history: historyStore, queue: uploadQueueStore, active: activeRecordingStore },
  send: sendToRenderer,
  // Mixed helpers (docs/security/pr50-senken.md): called only while the
  // scope is alive, inside its publish gate.
  ports: {
    probeAudio: (filePath) => getAudioMetadata(filePath),
    probeDuration: (filePath) => probeDurationSeconds(filePath),
    finalizeForRecovery: (recordId) => withRecordingLock(recordId, () => {
      // The lock queue may run this long after the request: the gate first.
      assertPublishAllowed();
      return inFlightUploads.has(recordId)
        ? { success: false, error: 'This recording is still uploading' }
        : finalizeRecording(recordId, '.webm', 0, { recovery: true });
    }),
  },
  log
});
// In-flight uploads, keyed by (scope, recordId); read side for main.
const inFlightUploads = scopes.inFlight;

const background = createBackground({
  config: { apiBaseUrl: API_BASE_URL, appVersion: app.getVersion(), FINALIZATION_PENDING_MARKER, rescanMs: 120000 },
  // Read-only helpers (no effect; static rule in mainBackgroundStatic.test.js).
  read: {
    getUser: () => sessionAuthority.getUser(),
    getRecordingPath: (recordId) => getRecordingPath(recordId),
    getRecordingsPath: () => getRecordingsPath(),
    recordingOwner: (recordId) => recordingOwner(recordId),
    readUploadReceipt: (recordId) => readUploadReceipt(recordId),
    assessRecordingUpload: (args) => assessRecordingUpload(args),
    recordingState: (recordId) => ({
      unsaved: unsavedRecordingId === recordId,
      locked: recordingLocks.has(recordId),
      live: isRecordingInProgress && getActiveRecording()?.recordId === recordId,
      inFlight: inFlightUploads.has(recordId),
    }),
    recordingInProgress: () => isRecordingInProgress,
    inFlight: (recordId) => inFlightUploads.has(recordId),
    readFinalizedRecording: (dirPath) => readFinalizedRecording(dirPath),
    listSessions: (dirPath) => listSessions(dirPath),
    listChunkBatches: (dirPath) => listChunkBatches(dirPath),
    usesNativeSources: (dirPath) => usesNativeSources(dirPath),
    validateAudioOutput: (filePath) => validateAudioOutput(filePath),
  },
  pure: {
    tokenUserId, sessionTokenUserId, canUploadForUser, verifiedUploadResult, safeParseDuration,
    repairRecoveredHistoryRecord, withCaptureWarnings, calculateUploadTimeout, FormData: require('form-data'),
  },
  report: {
    captureUploadFailureOnce,
    captureMessage: (...args) => Sentry.captureMessage(...args),
    captureException: (...args) => Sentry.captureException(...args),
  },
  hooks: { onBusyChange: () => updateRecordingPowerBlocker() },
  log
});

/** Upload queue run (startup, after sign-in, periodic, manual retry). No session: nothing. */
const processPendingUploads = () => background.startQueue(scopes);

/** R-S4: recovery, then clean-up; only with a released session, once per session. */
const startRecovery = (reason) => background.startRecovery(scopes, reason);

// The renderer waits for a running recovery before it starts a recording.
ipcMain.handle('recording:isRecoveryRunning', () => background.recovery.isRunning());

// Set FFmpeg path (cross-platform)
if (app.isPackaged) {
  // Production: Use bundled FFmpeg
  const isWin = process.platform === 'win32';
  const ffmpegName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const ffprobeName = isWin ? 'ffprobe.exe' : 'ffprobe';
  const ffmpegPath = path.join(process.resourcesPath, 'ffmpeg', ffmpegName);
  const ffprobePath = path.join(process.resourcesPath, 'ffmpeg', ffprobeName);
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
  log.info('FFmpeg path (production):', ffmpegPath);
} else {
  // Development: Use @ffmpeg-installer packages
  try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    ffmpeg.setFfprobePath(ffprobeInstaller.path);
    console.log('FFmpeg path (dev):', ffmpegInstaller.path);
  } catch (e) {
    console.warn('Could not load ffmpeg-installer:', e.message);
  }
}

// Track recordIds that were cancelled so we suppress post-cancel completion events
const cancelledUploads = new Set();

// Track if upload is in progress to prevent window close
let isUploadInProgress = false;
let pendingUploadsCount = 0;
// DRD-2: set while before-quit aborts in-flight uploads, so upload:start keeps
// the aborted recording in the persistent queue (for next-launch resume) rather
// than treating the quit-abort like a user cancel and dropping it.
let isQuittingWithUploads = false;

// Track recording status for close prevention
let isRecordingInProgress = false;
let unsavedRecordingId = null;
let recordingPowerBlocker = null;
function updateRecordingPowerBlocker() {
  const needed = isRecordingInProgress || isProcessingRecording || !!unsavedRecordingId || inFlightUploads.size > 0;
  if (needed && recordingPowerBlocker === null) recordingPowerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!needed && recordingPowerBlocker !== null) {
    powerSaveBlocker.stop(recordingPowerBlocker);
    recordingPowerBlocker = null;
  }
}
let isProcessingRecording = false;

let mainWindow;

// The ONE sink for renderer events (security review 10/2026, round 10): in
// background work of a session that has ended (publish gate of its scope)
// nothing reaches the renderer; the check is synchronous, right before the
// send. Every event of main goes through here (static rule in
// sessionSweep.static.test.js).
function sendToRenderer(channel, payload) {
  assertPublishAllowed();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
let tray = null;
let recordingTrayInterval = null;

// Helper functions
function getRecordingsPath() {
  return path.join(app.getPath('userData'), 'recordings');
}

function getRecordingPath(recordId) {
  return path.join(getRecordingsPath(), recordId);
}

function getChunksPath(recordId) {
  return path.join(getRecordingPath(recordId), 'chunks');
}

// Ensure directory exists
async function ensureDir(dirPath) {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

// === Input Validation Helpers ===
// Prevent path traversal and injection attacks

// Validate UUID format for recordId
function validateRecordId(recordId) {
  if (!recordId || typeof recordId !== 'string') {
    throw new Error('Recording ID is required');
  }
  // Allow UUID v4 format or simple alphanumeric IDs with hyphens/underscores
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const simpleIdRegex = /^[a-zA-Z0-9_-]{1,64}$/;
  if (!uuidRegex.test(recordId) && !simpleIdRegex.test(recordId)) {
    throw new Error('Invalid recording ID format');
  }
  return recordId;
}

// Validate file extension (whitelist approach)
function validateExtension(ext) {
  const allowedExts = ['.webm', '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.aac', '.opus', '.wma', '.amr', '.3gp', '.mov', '.mkv', '.avi'];
  if (!ext || typeof ext !== 'string') {
    throw new Error('File extension is required');
  }
  const normalizedExt = ext.toLowerCase();
  if (!allowedExts.includes(normalizedExt)) {
    throw new Error(`Invalid file extension: ${ext}`);
  }
  return normalizedExt;
}

// Validate file path is within allowed directory (prevents path traversal)
function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('File path is required');
  }
  const resolvedPath = path.resolve(filePath);
  const userDataPath = app.getPath('userData');
  const recordingsPath = path.join(userDataPath, 'recordings');

  // Allow paths within userData/recordings directory
  if (!resolvedPath.startsWith(recordingsPath)) {
    throw new Error('File path is outside allowed directories');
  }
  return resolvedPath;
}

// Validate userId
function validateUserId(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('User ID is required');
  }
  if (userId.length > 128) {
    throw new Error('User ID too long');
  }
  // Prevent injection attacks
  if (!/^[a-zA-Z0-9_@.-]+$/.test(userId)) {
    throw new Error('User ID contains invalid characters');
  }
  return userId;
}

// Validate chunk index
function validateChunkIndex(chunkIndex) {
  if (typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error('Invalid chunk index');
  }
  if (chunkIndex > 100000) { // Reasonable upper limit
    throw new Error('Chunk index too large');
  }
  return chunkIndex;
}

// === Recording Tray Indicator Functions ===
let recordingStartTime = null;

function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function setupRecordingTray() {
  // Tray will be created when recording starts
  log.info('Recording tray system initialized');
}

function createRecordingTray() {
  if (tray) return; // Already exists

  try {
    // Create a simple red circle icon for recording indicator
    // Use a 16x16 or 22x22 image for tray
    const iconPath = path.join(__dirname, 'icons', 'icon.png');

    // Create tray with app icon (we'll update the tooltip to show recording)
    if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath);
    } else {
      // Fallback: create a simple colored icon
      const size = 16;
      const icon = nativeImage.createEmpty();
      tray = new Tray(icon);
    }

    tray.setToolTip('Suisse Meets - Recording...');

    // Context menu for tray
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Recording in progress...',
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Show App',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      }
    ]);
    tray.setContextMenu(contextMenu);

    // Click to show app
    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    // Start updating the tooltip with duration
    recordingStartTime = Date.now();
    recordingTrayInterval = setInterval(() => {
      if (tray && recordingStartTime) {
        const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        const duration = formatDuration(elapsed);
        tray.setToolTip(`Suisse Meets - Recording: ${duration}`);
      }
    }, 1000);

    log.info('Recording tray indicator created');
  } catch (error) {
    log.error('Error creating recording tray:', error);
  }
}

function destroyRecordingTray() {
  if (recordingTrayInterval) {
    clearInterval(recordingTrayInterval);
    recordingTrayInterval = null;
  }

  if (tray) {
    tray.destroy();
    tray = null;
  }

  recordingStartTime = null;
  log.info('Recording tray indicator removed');
}

// Resolve preload path - use environment variable in dev, or relative path in prod
const preloadPath = process.env.QUASAR_ELECTRON_PRELOAD
  ? path.resolve(process.env.QUASAR_ELECTRON_PRELOAD)
  : path.join(__dirname, 'preload', 'electron-preload.cjs');

// Create the main window
function createWindow() {
  // Set window icon (for Windows taskbar and title bar)
  // Use nativeImage to load from asar archive
  const iconPath = path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const appIcon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1020,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    icon: appIcon.isEmpty() ? undefined : appIcon,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // CRITICAL: Prevent background throttling to keep recording active when app loses focus
      backgroundThrottling: false
    }
  });

  // A hung window, a failed preload and a window that never loads are all
  // invisible from main otherwise — they produce no exception anywhere.
  windowReporting.attachWindow(mainWindow, { isRecording: () => isRecordingInProgress });

  // Load the app
  // In dev mode, load from Vite dev server; in production, load the bundled file
  if (process.env.DEV) {
    mainWindow.loadURL(process.env.APP_URL);
    if (process.env.DEBUGGING) {
      mainWindow.webContents.openDevTools();
    }
  } else {
    mainWindow.loadFile('index.html');
  }

  // If the app was cold-started by a suissenotes:// URL, the SSO payload was
  // buffered before the window existed. The renderer collects it itself
  // (auth:takePendingSSO from src/boot/sso.js) once its handler exists:
  // pushing it at did-finish-load raced the renderer's async boot and lost it.

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prevent close during recording, processing, or upload
  mainWindow.on('close', (e) => {
    // Allow close if we already flushed recording data during shutdown
    if (app._quitFlushed) return;

    const shouldPreventClose = !!unsavedRecordingId || isRecordingInProgress ||
                                isProcessingRecording ||
                                isUploadInProgress ||
                                pendingUploadsCount > 0 || inFlightUploads.size > 0;

    if (shouldPreventClose) {
      e.preventDefault();

      // Determine the appropriate message
      let title = 'Cannot Close';
      let message = 'Please wait...';

      if (unsavedRecordingId) {
        title = 'Audio Is Not Saved';
        message = 'Some recorded audio is still only in memory. Retry saving or explicitly discard the recording before closing the app.';
      } else if (isRecordingInProgress) {
        title = 'Recording in Progress';
        message = 'A recording is in progress. Please stop the recording before closing the app.';
      } else if (isProcessingRecording) {
        title = 'Processing Recording';
        message = 'Your recording is being processed. Please wait for it to complete before closing the app.';
      } else if (isUploadInProgress || pendingUploadsCount > 0 || inFlightUploads.size > 0) {
        title = 'Upload in Progress';
        message = 'A recording is being uploaded. Please wait for the upload to complete before closing the app.';
      }

      // Show dialog to user
      const { dialog } = require('electron');
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title,
        message,
        buttons: ['OK'],
        defaultId: 0
      });
    }
  });
}

// App ready
app.whenReady().then(() => {
  // Windows and Linux open the OS keystore (safeStorage) only at ready: a
  // migration held at module load runs now, before the window and before any
  // background upload. Still not possible: held, the next start tries again.
  if (sessionAuthority.state().migrationPending) {
    const migrated = sessionAuthority.startup();
    if (migrated.signedOut === false) afterSessionApplied();
  }

  // Set the App User Model ID for Windows notifications
  // This ensures notifications show "Suisse Meets" instead of "electron.app.electron".
  // The AUMID must keep matching appId (com.suisse-notes.desktop) — it is an
  // identifier, not a display string, and changing it breaks the NSIS shortcut link.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.suisse-notes.desktop');
  }

  // Probe the bundled ffmpeg/ffprobe binaries in the background. Don't await:
  // a slow/missing binary must not block app startup. Every downstream call
  // site consults `binaryHealth` and falls back gracefully if either is broken.
  probeBundledBinaries().catch(err => {
    log.error('Binary health probe threw:', err);
  });

  // Remove the default menu bar (File, Edit, View, etc.)
  Menu.setApplicationMenu(null);

  // Register custom protocol for serving local audio files
  // Security: Only allow access to files within the recordings directory
  protocol.registerFileProtocol('local-audio', (request, callback) => {
    // Extract and decode the file path from the URL
    const url = request.url.replace('local-audio://', '');
    const filePath = decodeURIComponent(url);

    // Validate that the path is within the allowed recordings directory
    const recordingsPath = path.join(app.getPath('userData'), 'recordings');
    const resolvedPath = path.resolve(filePath);

    if (!resolvedPath.startsWith(recordingsPath)) {
      log.warn('local-audio protocol: Blocked access to path outside recordings directory:', resolvedPath);
      callback({ error: -10 }); // net::ERR_ACCESS_DENIED
      return;
    }

    // Return the file
    callback({ path: resolvedPath });
  });

  createWindow();

  // === Recording Tray Indicator ===
  // Shows a persistent tray icon with recording duration when recording is active
  setupRecordingTray();

  // === P0 Data Loss Fix: Power/Suspend Handlers ===
  // Handle laptop lid close, sleep, and suspend to protect active recordings

  powerMonitor.on('suspend', async () => {
    log.info('System suspend detected');

    if (isRecordingInProgress) {
      log.info('Recording in progress during suspend - flushing data');

      // Request renderer to flush current data and wait for acknowledgment
      if (mainWindow && !mainWindow.isDestroyed()) {
        const flushComplete = new Promise((resolve) => {
          const timeout = setTimeout(() => {
            log.warn('Suspend flush timed out after 3s');
            resolve();
          }, 3000);

          ipcMain.once('recording:suspend-ack', () => {
            clearTimeout(timeout);
            log.info('Suspend flush acknowledged by renderer');
            resolve();
          });
        });

        sendToRenderer('recording:suspend', {
          reason: 'system_suspend',
          timestamp: Date.now()
        });

        await flushComplete;
      }

      // Save active recording state
      const activeSession = getActiveRecording();
      if (activeSession) {
        recordCaptureWarning(activeSession.recordId, 'system-suspend');
        activeRecordingStore.set('activeSession', {
          ...activeSession,
          suspendedAt: new Date().toISOString(),
          needsRecovery: true
        });
        log.info('Active recording state saved for recovery:', activeSession.recordId);
      }

      // AudioTee is a spawned child that keeps writing WALL-CLOCK PCM through
      // system sleep while the mic timeline is frozen — after a 30-min nap the
      // merge would offset every later word by 30 minutes. Stop it cleanly at
      // suspend; the PCM captured so far merges correctly (padded from start).
      // The renderer is told on resume so the UI reflects that system audio is
      // now off and the user can re-enable it.
      if (activeAudioTee) {
        audioTeeStoppedBySuspend = true;
        log.info('Stopping AudioTee for system suspend (prevents wall-clock PCM desync)');
        await stopSystemAudio().catch(e => log.warn('AudioTee suspend-stop failed:', e?.message));
      }
    }
  });

  powerMonitor.on('resume', async () => {
    log.info('System resume detected');

    // Check if there was an active recording that needs recovery
    const activeSession = getActiveRecording();
    if (activeSession && activeSession.needsRecovery) {
      log.info('Found recording that needs recovery after resume:', activeSession.recordId);

      // Notify renderer about the recovery need
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendToRenderer('recording:resume', {
          recordId: activeSession.recordId,
          suspendedAt: activeSession.suspendedAt,
          needsRecovery: true,
          // System audio was stopped at suspend (see above) — the renderer
          // must flip its toggle/state and tell the user.
          systemAudioStopped: audioTeeStoppedBySuspend
        });
      }
      audioTeeStoppedBySuspend = false;

      // Clear the recovery flag
      activeRecordingStore.set('activeSession', {
        ...activeSession,
        needsRecovery: false
      });
    }
  });

  powerMonitor.on('lock-screen', () => {
    log.info('Screen locked');
    // Optionally notify renderer about screen lock
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToRenderer('system:screen-locked');
    }
  });

  powerMonitor.on('unlock-screen', () => {
    log.info('Screen unlocked');
    // Optionally notify renderer about screen unlock
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToRenderer('system:screen-unlocked');
    }
  });

  // === P0 Data Loss Fix: Graceful Shutdown Handlers ===
  // Flush recording data before app quit (OS shutdown, Force Quit, SIGTERM)

  // Helper: flush recording data with a tight timeout before allowing quit
  const flushBeforeQuit = async (reason) => {
    if (!isRecordingInProgress) return;
    log.info(`Flushing recording data before quit (reason: ${reason})`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      const flushComplete = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          log.warn(`Quit flush timed out after 2s (reason: ${reason})`);
          resolve();
        }, 2000);

        ipcMain.once('recording:suspend-ack', () => {
          clearTimeout(timeout);
          log.info(`Quit flush acknowledged by renderer (reason: ${reason})`);
          resolve();
        });
      });

      sendToRenderer('recording:suspend', {
        reason,
        timestamp: Date.now()
      });

      await flushComplete;
    }

    // Persist active recording state for recovery on next launch
    const activeSession = getActiveRecording();
    if (activeSession) {
      activeRecordingStore.set('activeSession', {
        ...activeSession,
        shutdownAt: new Date().toISOString(),
        needsRecovery: true
      });
      log.info('Active recording state saved before quit:', activeSession.recordId);
    }
  };

  const protectUnsavedAudio = (e) => {
    if (!unsavedRecordingId) return false;
    e.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Audio Is Not Saved',
        message: 'Some recorded audio is still only in memory. Retry saving or explicitly discard the recording before quitting.', buttons: ['OK'] });
    }
    return true;
  };
  app.on('before-quit', async (e) => {
    if (app._quitFlushed) return;
    if (protectUnsavedAudio(e)) return;
    if (isRecordingInProgress) {
      e.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Recording in Progress',
          message: 'Stop and save the recording before quitting the app.', buttons: ['OK'] });
      }
      return;
    }
    const hasUpload = isUploadInProgress || pendingUploadsCount > 0 || inFlightUploads.size > 0;
    // Stress-audit fix (2026-07-26): the guard omitted isProcessingRecording,
    // so a quit arriving during the post-stop FFmpeg combine (auto-install on
    // quit, OS quit, or a fast stop→quit) tore down FFmpeg mid-concat. The
    // manual quitAndInstall guard already covers processing; align this path.
    if (!isRecordingInProgress && !isProcessingRecording && !hasUpload) return;

    e.preventDefault();

    // Let an in-flight combine finish (bounded) rather than killing FFmpeg
    // mid-concat and leaving an unvalidated partial. Chunks survive either way
    // (launch recovery re-combines), but finishing cleanly avoids the churn.
    if (isProcessingRecording) {
      const combineDeadline = Date.now() + 60_000;
      while (isProcessingRecording && Date.now() < combineDeadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // DRD-2: the previous handler ignored in-flight uploads, so quitting
    // mid-upload severed the socket with no clean cancellation. Abort the
    // active upload controllers instead: SAS block commits are atomic (an
    // uncommitted blob is invisible to the server) and a truncated legacy POST
    // is rejected on Content-Length mismatch, so no partial recording can
    // persist server-side. The recording stays in the persistent upload queue
    // (added in upload:start) and resumes on next launch via
    // processPendingUploads.
    if (hasUpload && scopes.uploadCount > 0) {
      isQuittingWithUploads = true; // keep aborted uploads queued for resume
      log.info(`Aborting ${scopes.uploadCount} in-flight upload(s) before quit`);
      scopes.abortUploadsForQuit();
      // Brief grace so the abort can unwind the upload promises before exit.
      await new Promise((r) => setTimeout(r, 300));
    }

    if (protectUnsavedAudio(e)) return;
    app._quitFlushed = true;
    app.quit();
  });

  // Windows-specific: fires when OS is shutting down / restarting
  powerMonitor.on('shutdown', async () => {
    await flushBeforeQuit('system_shutdown');
  });

  // Handle SIGTERM (kill, systemctl stop, etc.)
  process.on('SIGTERM', async () => {
    log.info('SIGTERM received');
    await flushBeforeQuit('sigterm');
    app.quit();
  });

  // === macOS: Prompt user to move app to Applications if needed ===
  if (process.platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder()) {
    log.warn('App is not in Applications folder — auto-update will not work');
    skipAutoUpdate = true;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Move to Applications',
      message: 'Suisse Meets works best from the Applications folder.',
      detail: 'Move it there now so updates install automatically and everything runs smoothly.',
      buttons: ['Move to Applications', 'Not Now'],
      defaultId: 0
    }).then(result => {
      if (result.response === 0) {
        app.moveToApplicationsFolder();
      }
    });
  }

  // === Auto-Update: Check for updates silently ===
  // Only check in production (packaged app), skip if on read-only volume.
  // Also skip during E2E runs — a test build must not self-update to a newer
  // release mid-run (it downloads + quitAndInstalls and kills the test app).
  if (app.isPackaged && !skipAutoUpdate && process.env.SUISSE_E2E_HOOKS !== '1') {
    // At launch, every hour, and shortly after the computer wakes (see
    // update-checks.js): the prompt can only appear once the download is done.
    updateChecks.request('startup');
    setInterval(() => updateChecks.request('interval'), UPDATE_CHECK_INTERVAL_MS);
    powerMonitor.on('resume', () => {
      for (const delay of UPDATE_CHECK_AFTER_WAKE_MS) {
        setTimeout(() => updateChecks.request('wake', { minGapMs: UPDATE_CHECK_MIN_GAP_MS }), delay);
      }
    });
  }

  // === Recover Orphaned Recordings, then clean up old empty folders ===
  // 5 seconds after startup, only with a released session (R-S4, round 9):
  // signed out, tombstone or held - nothing; afterSessionApplied starts it.
  setTimeout(() => { startRecovery('startup'); }, 5000);

  // === Process Pending Uploads ===
  // Wait 15 seconds after startup to process pending uploads
  // This gives time for recovery and user login
  setTimeout(() => {
    processPendingUploads().catch(err => {
      log.error('Error processing pending uploads:', err);
    });

    // Periodic retry every 5 minutes for failed desktop uploads
    setInterval(() => {
      processPendingUploads().catch(err => {
        log.error('Periodic upload retry failed:', err);
      });
    }, 5 * 60 * 1000);
  }, 15000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// === Auto-Update Event Handlers ===
autoUpdater.on('checking-for-update', () => {
  log.info('Checking for updates...');
});

// An update that is still downloading. The renderer shows "update loading
// (NN %)" from the moment it is found, instead of staying silent until the
// whole installer has arrived.
let updateDownload = null;
let signatureDialogShown = false;

autoUpdater.on('update-available', (info) => {
  log.info('Update available:', info.version);
  // A check that straddled the end of the download: the update is already here.
  if (pendingUpdateInfo) return;
  // A newer release found mid-download does not relabel the running download.
  if (!updateDownload) updateDownload = { version: info.version, percent: 0 };
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendToRenderer('update:available', { version: updateDownload.version });
  }
});

autoUpdater.on('update-not-available', (info) => {
  log.info('Update not available. Current version is up-to-date.');
});

autoUpdater.on('download-progress', (progressObj) => {
  log.info(`Download progress: ${progressObj.percent.toFixed(1)}%`);
  if (!pendingUpdateInfo && updateDownload) updateDownload.percent = progressObj.percent;
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendToRenderer('update:progress', { version: updateDownload?.version || null, percent: progressObj.percent });
  }
});

// Update-ready prompt: the downloaded update is remembered here so the
// renderer can ask for it at any time (the update-downloaded event usually
// fires before login / before the Vue app is listening). The renderer shows a
// translated "update now?" dialog; "update now" calls updater:quitAndInstall.
let pendingUpdateInfo = null;

// A failed download (signature, disk, network) rejects the check's download
// promise; a failed check during a running download does not stop it and is
// only logged by the error handler below.
function handleUpdateDownloadFailure(error) {
  if (!updateDownload) return; // already handled for this download
  const persistent = isPersistentDownloadError(error);
  log.warn(`Update ${updateDownload.version} download failed (${persistent ? 'retry in 4 h' : 'retry at next check'}): ${error?.message || error}`);
  if (persistent) updateChecks.downloadFailed();
  if (mainWindow && !mainWindow.isDestroyed()) sendToRenderer('update:failed', { version: updateDownload.version });
  updateDownload = null;
}

const updateChecks = createUpdateChecks({
  check: async () => {
    const result = await autoUpdater.checkForUpdates();
    result?.downloadPromise?.catch(handleUpdateDownloadFailure);
    return result;
  },
  isEnabled: () => app.isPackaged && !skipAutoUpdate && process.env.SUISSE_E2E_HOOKS !== '1',
  isDownloaded: () => Boolean(pendingUpdateInfo),
  log,
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('Update downloaded:', info.version);
  pendingUpdateInfo = info;
  updateDownload = null;
  updateChecks.downloadSucceeded();
  // A check still in flight must not start a second download or a second
  // Squirrel staging (macOS) of the update that is already here.
  autoUpdater.autoDownload = false;
  // Will auto-install on app quit due to autoInstallOnAppQuit = true
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendToRenderer('update:downloaded', { version: info.version });
  }
});

ipcMain.handle('updater:getStatus', () => ({
  updateDownloaded: Boolean(pendingUpdateInfo),
  version: pendingUpdateInfo?.version || null,
  downloading: updateDownload ? { ...updateDownload } : null,
  currentVersion: app.getVersion()
}));

ipcMain.handle('updater:quitAndInstall', () => {
  if (!pendingUpdateInfo) {
    return { success: false, error: 'No update downloaded' };
  }
  // Never restart out from under an active capture, COMBINE, or upload — the
  // renderer gates the dialog on idle, but guard here too (defense in depth).
  // isProcessingRecording covers the post-stop combine window: killing FFmpeg
  // mid-concat on a multi-hour recording leaves an unvalidated partial file.
  if (unsavedRecordingId || isRecordingInProgress || isProcessingRecording || isUploadInProgress || pendingUploadsCount > 0 || inFlightUploads.size > 0) {
    log.warn('updater:quitAndInstall refused — recording, processing or upload in progress');
    return { success: false, error: 'Recording or upload in progress' };
  }
  log.info(`Installing update ${pendingUpdateInfo.version} on user request`);
  // Defer so the IPC response reaches the renderer before teardown begins.
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(true, true); // silent install, relaunch app
    } catch (err) {
      log.error('quitAndInstall failed:', err);
    }
  });
  return { success: true };
});

autoUpdater.on('error', (err) => {
  log.error('Auto-update error:', err);

  // Detect signature verification failure (common when app is not code-signed)
  const errMsg = err.message || err.toString();
  if (errMsg.includes('not signed') || errMsg.includes('signature') || errMsg.includes('publisherNames')) {
    log.warn('Update failed due to signature verification. App needs code signing or manual reinstall.');

    // Show dialog to user explaining they need to manually update (once per
    // session: the failed download is retried, and the dialog is modal)
    if (mainWindow && !mainWindow.isDestroyed() && !signatureDialogShown) {
      signatureDialogShown = true;
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: 'A new version is available but cannot be installed automatically.',
        detail: 'Please download the latest version from our website to get the newest features and fixes. After this one-time reinstall, future updates will work automatically.',
        buttons: ['Download Now', 'Later'],
        defaultId: 0
      }).then(result => {
        if (result.response === 0) {
          shell.openExternal('https://github.com/xicoarm/suisse-notes-desktop/releases/latest');
        }
      });
    }
  }

  // Detect read-only volume error (macOS: app in Downloads or mounted DMG)
  if (process.platform === 'darwin' &&
      (errMsg.includes('read-only') || errMsg.includes('EROFS') || errMsg.includes('EACCES'))) {
    log.warn('Update failed: app is on a read-only volume — skipping future update checks');
    skipAutoUpdate = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Move to Applications',
        message: 'Suisse Meets works best from the Applications folder.',
        detail: 'Move it there now so updates install automatically and everything runs smoothly.',
        buttons: ['Move to Applications', 'Not Now'],
        defaultId: 0
      }).then(result => {
        if (result.response === 0) {
          app.moveToApplicationsFolder();
        }
      });
    }
  }
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ==================== IPC HANDLERS ====================

// --- Configuration ---
// Simplified: No configurable URLs, just device info
ipcMain.handle('config:get', async () => {
  return {
    deviceId: getDeviceId(),
    apiUrl: API_BASE_URL  // Read-only, for display purposes
  };
});

// The renderer's getApiUrl() (src/services/api.js, Electron path) calls this to
// inherit the main process's resolved API base. Without it the call fell
// through to the PRODUCTION fallback, so in dev-electron the renderer silently
// talked to production for minutes/history/templates while the main process
// used its configured backend — a real environment split, and the reason the
// E2E harness (which points main at a local mock) still saw production data.
ipcMain.handle('config:getApiUrl', async () => API_BASE_URL);

// --- Authentication ---

// Helper: Get unique device ID (for DesktopAppUser tracking)
// Uses hardware-based machine ID that persists across reinstalls
function getDeviceId() {
  try {
    // Get hardware-based machine ID (persists across reinstalls)
    const hardwareId = machineIdSync();
    return `hw_${hardwareId}`;
  } catch (error) {
    log.warn('Failed to get hardware machine ID, falling back to stored ID:', error.message);
    // Fallback to stored ID if hardware ID fails
    let deviceId = configStore.get('deviceId');
    if (!deviceId) {
      deviceId = `device_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      configStore.set('deviceId', deviceId);
    }
    return deviceId;
  }
}

// SSO: open the system browser at the backend's IdP login route. The backend
// redirects through Microsoft/Google and ultimately back to suissenotes://
// auth/callback, which the OS routes to handleSSOUrl() above. Actual login
// completion arrives asynchronously via the 'auth:ssoCallback' event.
async function openSSOBrowser(provider) {
  try {
    // A signed-in app never starts an SSO flow (its result would be dropped).
    if (!sessionAuthority.state().signedOut) return { success: false, error: 'already_signed_in' };
    // Bind the callback to this sign-in (state + PKCE + session epoch, see sso-flow.js).
    const flow = ssoFlows.begin(provider, sessionAuthority.state().epoch);
    const url = ssoFlow.withFlowParams(`${API_BASE_URL}/api/auth/${provider}/login?client=desktop`, flow);
    log.info(`SSO: launching system browser for ${provider} login`);
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    log.error(`SSO: failed to open system browser for ${provider}`, error);
    return { success: false, error: error.message || 'Could not open browser' };
  }
}

ipcMain.handle('auth:loginWithMicrosoft', () => openSSOBrowser('microsoft'));
ipcMain.handle('auth:loginWithGoogle', () => openSSOBrowser('google'));

// Authentication - Production only (no demo mode)
/**
 * E2: a password, 2FA or registration success is applied here, with the
 * ticket taken when the request started. A sign-out (or any other session
 * change) meanwhile drops it: { success: false, ignored: true }.
 */
function applySignIn(ticket, success) {
  const applied = sessionAuthority.applySession(ticket, { token: success.token, user: success.user }, { kind: 'login' });
  if (!applied.applied) {
    log.info(`auth: sign-in result dropped (${applied.reason})`);
    return { success: false, ignored: true, reason: applied.reason };
  }
  afterSessionApplied();
  return { ...success, epoch: applied.epoch, persisted: applied.persisted };
}

/**
 * E7 (round 8): a sign-in answer (also a 2FA challenge or an error) that
 * arrives after the session changed is dropped - the same shape as a result
 * applySession refused.
 */
function signInDropped() {
  return { success: false, ignored: true, reason: 'session_changed' };
}

/** A new session is in place: uploads and the recovery waiting for a sign-in may run. */
function afterSessionApplied() {
  try {
    const user = sessionAuthority.getUser();
    // Opaque account id only (no e-mail/name to telemetry).
    if (user && user.id) Sentry.setUser({ id: String(user.id) });
  } catch { /* telemetry optional */ }
  setImmediate(() => {
    processPendingUploads().catch(err => {
      log.error('Error processing pending uploads after login:', err);
    });
    // R-S4 (round 9): recovery waits for a released session; once per session.
    startRecovery('sign-in');
  });
}

ipcMain.handle('auth:login', async (event, email, password) => {
  const ticket = sessionAuthority.ticket();
  try {
    // Suisse Notes API authentication. `twoFactor: "supported"` tells the
    // backend this app can ask for the second factor (src-electron/auth-two-factor.js).
    const response = await axios.post(`${API_BASE_URL}/api/auth/desktop`, twoFactorAuth.buildLoginBody({
      email,
      password,
      deviceId: getDeviceId(),
      platform: process.platform,
      appVersion: app.getVersion()
    }), {
      timeout: 30000,
      // Safe to resend: a gateway answer means the backend was restarting.
      retryGateway: true,
      headers: {
        'Content-Type': 'application/json',
        'X-Desktop-App-Version': app.getVersion()
      }
    });
    if (sessionEndedFor(ticket)) return signInDropped();

    // Check for successful response
    if (response.data && response.data.success) {
      const success = twoFactorAuth.loginSuccessFrom(response.data);
      if (success) return applySignIn(ticket, success);
    }
    // 2FA account: the renderer asks for the code (no token yet).
    const challenge = twoFactorAuth.twoFactorChallengeFrom(response.data);
    if (challenge) {
      log.info(`auth:login: second factor required (${challenge.twoFactorMethod})`);
      return challenge;
    }
    // A 2xx without a token: an answer the app cannot use.
    return { success: false, status: response.status, nonJson: true, code: authErrorCode(response.data) };
  } catch (error) {
    if (sessionEndedFor(ticket)) return signInDropped();
    // The renderer (src/utils/authErrors.js) turns this into a translated
    // text: never show the server's sentence or an English transport string.
    const failure = authFailureFromAxiosError(error);

    // Report network/server errors to Sentry (not user auth failures)
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND' || (error.response && error.response.status >= 500)) {
      Sentry.captureException(error, {
        tags: { operation: 'login' },
        extra: { errorCode: error.code, httpStatus: error.response?.status },
      });
    }

    return failure;
  }
});

// Second factor of the password sign-in: the code the user typed. Inputs are
// validated in auth-two-factor.js before any request; the URL comes from the
// configured API base only. Success has the shape of an auth:login success.
ipcMain.handle('auth:verifyTwoFactor', async (event, tempToken, code, isBackupCode) => {
  const ticket = sessionAuthority.ticket();
  const request = twoFactorAuth.buildVerifyRequest(API_BASE_URL, tempToken, code, isBackupCode);
  if (!request.ok) return request.failure;
  try {
    const response = await axios.post(request.url, request.body, {
      timeout: 30000,
      // A gateway answer never reached the backend: resending cannot count twice.
      retryGateway: true,
      headers: { 'Content-Type': 'application/json', 'X-Desktop-App-Version': app.getVersion() }
    });
    if (sessionEndedFor(ticket)) return signInDropped();
    const success = twoFactorAuth.loginSuccessFrom(response.data);
    if (success) return applySignIn(ticket, success);
    return { success: false, status: response.status, nonJson: true, code: authErrorCode(response.data) };
  } catch (error) {
    if (sessionEndedFor(ticket)) return signInDropped();
    const failure = authFailureFromAxiosError(error);
    // Wrong or expired codes are the user's; outages are ours.
    const line = `auth:verifyTwoFactor failed: status=${failure.status || '-'} code=${failure.code || '-'} network=${failure.networkCode || '-'}${failure.nonJson ? ' non-json' : ''}`;
    if (failure.networkError || failure.nonJson || failure.status >= 500) log.warn(line);
    else log.info(line);
    return failure;
  }
});

// E-mail second factor: send a new code (the renderer enforces the 60 s cooldown).
ipcMain.handle('auth:resendTwoFactorEmail', async (event, tempToken) => {
  const request = twoFactorAuth.buildResendRequest(API_BASE_URL, tempToken);
  if (!request.ok) return request.failure;
  try {
    const response = await axios.post(request.url, request.body, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'X-Desktop-App-Version': app.getVersion() }
    });
    if (response.data && response.data.success === true) return { success: true };
    return { success: false, status: response.status, nonJson: true, code: authErrorCode(response.data) };
  } catch (error) {
    const failure = authFailureFromAxiosError(error);
    const line = `auth:resendTwoFactorEmail failed: status=${failure.status || '-'} code=${failure.code || '-'} network=${failure.networkCode || '-'}`;
    if (failure.networkError || failure.nonJson || failure.status >= 500) log.warn(line);
    else log.info(line);
    return failure;
  }
});

// Registration - Create new account
ipcMain.handle('auth:register', async (event, email, password, name) => {
  const ticket = sessionAuthority.ticket();
  try {
    const response = await axios.post(`${API_BASE_URL}/api/auth/register`, {
      email,
      password,
      name,
      deviceId: getDeviceId(),
      platform: process.platform,
      appVersion: app.getVersion()
    }, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-Desktop-App-Version': app.getVersion()
      }
    });
    if (sessionEndedFor(ticket)) return signInDropped();

    // Check for successful response (register endpoint returns { user, token })
    if (response.data && response.data.token) {
      return applySignIn(ticket, {
        success: true,
        token: response.data.token,
        user: response.data.user
      });
    }
    log.warn(`auth:register: answer without a token (HTTP ${response.status})`);
    return { success: false, status: response.status, nonJson: true, code: authErrorCode(response.data) };
  } catch (error) {
    if (sessionEndedFor(ticket)) return signInDropped();
    const failure = authFailureFromAxiosError(error);
    // Until 4.7.15 a failed registration left no trace anywhere: no log line,
    // no Sentry event (08.10.2026: a prospect failed for 15 minutes). The
    // log hook (sentry-reporting.js) turns this warning into a Sentry event.
    // Status and codes only - never the e-mail, name or password. Refusals
    // the customer can fix (400 invalid input, 409 account exists, 429 too
    // many attempts) stay in the local log (info = breadcrumb); server and
    // network failures become Sentry warnings.
    const line = `auth:register failed: status=${failure.status || '-'} code=${failure.code || '-'} network=${failure.networkCode || '-'}${failure.nonJson ? ' non-json' : ''}`;
    if (isCustomerFixableRegisterRefusal(failure)) log.info(line);
    else log.warn(line);
    return failure;
  }
});

/** 400/409/429 with a JSON answer: the customer's input or pace, not an outage. */
function isCustomerFixableRegisterRefusal(failure) {
  return !failure.nonJson && [400, 409, 429].includes(failure.status);
}

/** The backend's machine error code (contract 10/2026), when the body has one. */
function authErrorCode(data) {
  return data && typeof data === 'object' && typeof data.code === 'string' && /^[a-z_]{1,40}$/.test(data.code)
    ? data.code
    : undefined;
}

/**
 * axios failure of an auth request -> the structured failure the renderer
 * maps to a translated text (src/utils/authErrors.js). The server's English
 * sentence travels only as `serverError` for the legacy-sentence matching.
 */
function authFailureFromAxiosError(error) {
  if (error?.response) {
    const data = error.response.data;
    const isObject = data && typeof data === 'object';
    return {
      success: false,
      status: error.response.status,
      code: authErrorCode(data),
      provider: isObject && (data.provider === 'google' || data.provider === 'microsoft') ? data.provider : undefined,
      nonJson: !!error.nonJson || !isObject,
      serverError: isObject && typeof data.error === 'string' ? data.error.slice(0, 200) : undefined
    };
  }
  return {
    success: false,
    networkCode: typeof error?.code === 'string' ? error.code : 'unknown',
    networkError: true
  };
}

// Token and user are written only by the session authority (applySession):
// there is no IPC that stores a token or a user without a ticket (E2).

ipcMain.handle('auth:getToken', async () => {
  try {
    return sessionAuthority.getToken();
  } catch (error) {
    console.error('Error getting token:', error);
    return null;
  }
});

ipcMain.handle('auth:getUserInfo', async () => {
  try {
    return sessionAuthority.getUser();
  } catch (error) {
    console.error('Error getting user info:', error);
    return null;
  }
});

// Start of the renderer: the stored session, or signed out (E6).
ipcMain.handle('auth:restoreSession', () => {
  try {
    return sessionAuthority.restore();
  } catch (error) {
    log.warn(`auth:restoreSession failed (${error?.message || error})`);
    return { signedOut: true };
  }
});

// The session as main holds it now (after an SSO result was applied).
ipcMain.handle('auth:currentSession', () => {
  const state = sessionAuthority.state();
  if (state.signedOut) return { signedOut: true, epoch: state.epoch };
  return { signedOut: false, epoch: state.epoch, token: sessionAuthority.getToken(), user: sessionAuthority.getUser() };
});

// E5 steps 1-3 (the renderer does the BLE clean-up afterwards).
ipcMain.handle('auth:signOut', () => {
  let result;
  try {
    result = sessionAuthority.signOut();
  } catch (error) {
    log.warn(`auth:signOut failed (${error?.message || error})`);
    result = { success: false, error: 'sign_out_incomplete', epoch: sessionAuthority.state().epoch };
  }
  Sentry.setUser(null);  // Clear Sentry user context on logout
  return result;
});

// Paths of the web app the signed-in user may be handed into from the app.
// Everything else is refused: the hand-off signs the browser in as this user.
const WEB_HANDOFF_PATHS = [/^\/meeting\/audio\/[A-Za-z0-9_-]{1,128}$/, /^\/settings\/integrations$/];
const WEB_HANDOFF_ORIGIN = 'https://app.suisse-meets.ch';

// Open a page of the web app in the system browser, signed in as the current
// user. The session/hand-off value is created and used here only: it is never
// returned to the renderer, copied, or logged (the renderer's «copy link»
// copies the plain meeting URL).
ipcMain.handle('auth:openWebWithSession', async (_event, pagePath) => {
  const path = typeof pagePath === 'string' ? pagePath : '';
  if (!WEB_HANDOFF_PATHS.some((re) => re.test(path))) {
    return { success: false, error: 'path_not_allowed' };
  }
  const plainUrl = `${WEB_HANDOFF_ORIGIN}${path}`;
  let target = plainUrl;
  try {
    // Bound hand-off (server contract 10/2026): single-use 60 s token in the
    // query, PKCE verifier in the fragment (#hv=, never sent to a server).
    const verifier = require('crypto').randomBytes(32).toString('base64url');
    const session = await createWebSessionInMain(ssoFlow.pkceChallenge(verifier));
    if (session.success) {
      target = `${plainUrl}?session=${encodeURIComponent(session.sessionToken)}#hv=${encodeURIComponent(verifier)}`;
    }
  } catch (error) {
    log.warn(`Web hand-off could not be created: ${error?.message || 'unknown'}`);
  }
  try {
    await shell.openExternal(target);
    return { success: true, signedIn: target !== plainUrl };
  } catch (error) {
    log.warn(`Could not open the browser: ${error?.message || 'unknown'}`);
    return { success: false, error: 'open_failed' };
  }
});

// Create web session token for seamless web login (main process only).
// SECURITY: Verifies token matches stored user to prevent authentication as wrong user
async function createWebSessionInMain(codeChallenge) {
  try {
    const authToken = await getAuthToken();
    if (!authToken) {
      return { success: false, error: 'Not authenticated' };
    }

    // CRITICAL SECURITY CHECK: Verify the token belongs to the expected user
    // This prevents authenticating as a stale/wrong user if token storage got out of sync
    const storedUserInfo = sessionAuthority.getUser();
    if (storedUserInfo && storedUserInfo.id) {
      try {
        // Decode JWT to check the userId (without verifying signature - server will verify)
        const tokenParts = authToken.split('.');
        if (tokenParts.length === 3) {
          const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
          if (payload.userId && payload.userId !== storedUserInfo.id) {
            log.error('CRITICAL SECURITY: Token user mismatch!', {
              tokenUserId: payload.userId,
              storedUserId: storedUserInfo.id,
              storedEmail: storedUserInfo.email
            });
            // Sign out to force re-login (the renderer follows on auth:expired)
            sessionAuthority.signOut();
            if (mainWindow && !mainWindow.isDestroyed()) {
              sendToRenderer('auth:expired', { message: 'Session mismatch detected. Please log in again for security.' });
            }
            return {
              success: false,
              error: 'Session mismatch detected. Please log in again for security.'
            };
          }
        }
      } catch (decodeError) {
        log.warn('Could not decode token for verification:', decodeError.message);
        // Continue anyway - server will validate
      }
    }

    const response = await axios.post(`${API_BASE_URL}/api/auth/desktop/create-web-session`, { codeChallenge, codeChallengeMethod: 'S256' }, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    // Single-use 60 s token bound to codeChallenge (400 HANDOFF_BINDING_REQUIRED
    // from servers that refuse it ends up in catch: the plain URL is opened).
    // `bound: true` confirms the challenge was stored; an older server's 200
    // with an unbound, reusable token is not used (plain URL instead).
    const sessionToken = ssoFlow.boundHandoffToken(response.data);
    if (sessionToken) {
      return { success: true, sessionToken };
    }

    return { success: false, error: 'Failed to create web session' };
  } catch (error) {
    log.warn(`Create web session failed: ${error?.response?.status || error?.code || 'error'}`);
    return {
      success: false,
      error: 'Failed to create web session'
    };
  }
}

// --- Token Refresh ---

// The renderer asks; the refresh runs in a scope of the current session.
ipcMain.handle('auth:refreshToken', async () => {
  const scope = scopes.open();
  if (!scope) return { success: false, error: 'Not authenticated' };
  return background.uploads.refreshMainAuthToken(scope);
});

// --- Minutes / Credits ---

ipcMain.handle('minutes:fetch', async () => {
  try {
    const authToken = await getAuthToken();
    if (!authToken) {
      return { success: false, error: 'Not authenticated' };
    }

    const response = await axios.get(`${API_BASE_URL}/api/desktop/minutes`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      timeout: 15000
    });

    if (response.data) {
      const remaining = response.data.remaining ?? response.data.remainingMinutes ?? 0;
      const total = response.data.total ?? response.data.totalMinutes ?? 0;
      return {
        success: true,
        minutes: {
          remaining,
          unlimited: response.data.unlimited || remaining === -1 || total === -1
            || (response.data.freeMinutes != null && response.data.freeMinutes === -1),
          total,
          used: response.data.used ?? response.data.usedMinutes ?? 0
        }
      };
    }

    return { success: false, error: 'Invalid response' };
  } catch (error) {
    console.error('Fetch minutes error:', error.message);
    return {
      success: false,
      error: error.response?.data?.error || error.message || 'Failed to fetch minutes'
    };
  }
});

// --- Recording (chunked, synchronous writes) ---

// Per-recording mutex. Serializes saveChunk, createSessionFile, and combineChunks
// for a given recordId so their async await points cannot interleave on disk.
// Without this, a late saveChunk can land mid-way through createSessionFile's
// readdir->combine->cleanup pipeline and survive the cleanup, producing a phantom
// chunk gap on the next validation pass.
const recordingLocks = new Map();

function withRecordingLock(recordId, fn) {
  const previous = recordingLocks.get(recordId) || Promise.resolve();
  // Swallow the previous link's error so a failure in one handler doesn't
  // poison the next one's run.
  // R-S7.4: the queue runs fn long after the request, from whatever context the
  // previous link ended in.
  const current = previous.catch(() => {}).then(bindSession(fn));
  recordingLocks.set(recordId, current);
  current.finally(() => {
    if (recordingLocks.get(recordId) === current) {
      recordingLocks.delete(recordId);
    }
  }).catch(() => {});
  return current;
}

// Helper: Get sessions path
function getSessionsPath(recordId) {
  return path.join(getRecordingPath(recordId), 'sessions');
}

// Helper: Sort chunks numerically
function sortChunksNumerically(chunks, ext) {
  return chunks.sort((a, b) => {
    const numA = parseInt(a.replace('chunk_', '').replace(ext, ''), 10);
    const numB = parseInt(b.replace('chunk_', '').replace(ext, ''), 10);
    return numA - numB;
  });
}

// Helper: Safely parse duration from ffprobe metadata (guards against Infinity/NaN)
function safeParseDuration(metadata) {
  const d = parseFloat(metadata?.format?.duration);
  return isFinite(d) ? Math.round(d) : 0;
}

// Duration for the direct upload's init (seconds; 0 when unknown). Port of
// the background upload: runs only while its session is alive.
function probeDurationSeconds(filePath) {
  return new Promise((resolve) => {
    try {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err || !metadata) return resolve(0);
        const d = Number(metadata?.format?.duration);
        if (!Number.isFinite(d) || d <= 0) return resolve(0);
        resolve(d);
      });
    } catch {
      resolve(0);
    }
  });
}

// Helper: Get audio metadata via ffprobe
function getAudioMetadata(filePath) {
  // Background work (recovery port) starts no child process after its session ended.
  assertPublishAllowed();
  // Fast-fail if ffprobe binary is known to be broken (startup probe or earlier call)
  if (binaryHealth.ffprobe.available === false) {
    return Promise.reject(new Error(`ffprobe binary unavailable (${binaryHealth.ffprobe.error || 'spawn failed'})`));
  }
  return new Promise((resolve, reject) => {
    require('child_process').execFile(resolveBundledBinaryPaths().ffprobe,
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
      { timeout: 30000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          if (isSpawnError(err)) markBinaryUnavailable('ffprobe', err, 'getAudioMetadata');
          reject(err);
          return;
        }
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
  });
}

// Helper: Validate chunk sequence is continuous (0, 1, 2, 3...).
// Walks parsed indices pairwise so each gap is recorded exactly once.
function validateChunkSequence(chunks, ext) {
  if (!chunks || chunks.length === 0) {
    return { valid: true, missingChunks: [], chunkCount: 0, expectedCount: 0, firstIndex: null, lastIndex: null, message: '' };
  }

  const indices = chunks
    .map(f => parseInt(f.replace('chunk_', '').replace(ext, ''), 10))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (indices.length === 0) {
    return { valid: true, missingChunks: [], chunkCount: 0, expectedCount: 0, firstIndex: null, lastIndex: null, message: '' };
  }

  const missingChunks = [];
  // Sequence must start at 0
  for (let g = 0; g < indices[0]; g++) missingChunks.push(g);
  // Fill gaps between adjacent indices
  for (let i = 0; i < indices.length - 1; i++) {
    for (let g = indices[i] + 1; g < indices[i + 1]; g++) missingChunks.push(g);
  }

  const firstIndex = indices[0];
  const lastIndex = indices[indices.length - 1];
  const expectedCount = lastIndex + 1;

  return {
    valid: missingChunks.length === 0,
    missingChunks,
    chunkCount: indices.length,
    expectedCount,
    firstIndex,
    lastIndex,
    message: missingChunks.length > 0
      ? `${missingChunks.length} missing (${indices.length}/${expectedCount} present; first missing: ${missingChunks.slice(0, 10).join(', ')}${missingChunks.length > 10 ? '...' : ''}). Audio may have gaps.`
      : ''
  };
}

// Helper: Durable, atomic file write. Writes to a sibling .tmp file, fsyncs on a
// write-capable handle, then renames into place. Rename is atomic on NTFS/APFS/ext4,
// so readers never see a partial write and the final filename avoids AV flush races.
//
// Windows note: fsync maps to FlushFileBuffers(), which requires GENERIC_WRITE on
// the handle — the previous 'r'-mode open produced "EPERM: operation not permitted,
// fsync" on every Windows machine. The temp-then-rename pattern also sidesteps
// transient AV/EDR locks on the final path, with bounded retries as a belt.
function writeFileWithSync(filePath, data) {
  return writeFileAtomicSync(filePath, data);
}

// Helper: Recursive remove with retries that tolerate Windows transient locks.
//
// fs.promises.rm({ recursive: true, force: true }) defaults to maxRetries:0 and
// does NOT retry ENOTEMPTY/EBUSY/EPERM errors. On Windows those fire routinely
// when antivirus, Windows Defender, or Windows Search Indexer is holding a
// transient read handle on a file we just wrote — the parent rmdir observes
// "not empty" because the child handle hasn't been closed yet.
//
// maxRetries=5 with linear retryDelay=500ms gives 500+1000+1500+2000+2500 =
// 7.5s total worst case, which covers typical AV scan windows while staying
// well under IPC timeouts.
async function rmDirSafe(dirPath) {
  dirPath = require('./durable-files').assertManagedRecordingDirectory(getRecordingsPath(), dirPath);
  return fs.promises.rm(dirPath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 500
  });
}

// Helper: Combine chunks using streaming to avoid memory issues with large files
async function combineChunksStreaming(chunksPath, sortedChunks, outputPath) {
  return concatenateFiles(sortedChunks.map(name => path.join(chunksPath, name)), outputPath);
}

// WebM element magics used for init-segment handling
const EBML_HEADER_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const WEBM_CLUSTER_MAGIC = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

// Path of the persisted init segment for a recording (written by saveChunk
// from the very first blob — the only blob that carries the WebM header).
function getInitSegmentPath(recordId) {
  return path.join(getRecordingPath(recordId), 'init_segment.bin');
}

/**
 * Make a raw chunk concatenation parseable when it starts mid-stream.
 *
 * Only the very first MediaRecorder blob of a recording contains the WebM init
 * segment (EBML header + Segment info + Tracks). At the 4h55m auto-split the
 * chunk index is reset while the SAME recorder keeps running, so every
 * post-split chunk set begins with a header-less continuation cluster. A raw
 * concat of such a set is unreadable by ffprobe/ffmpeg — before this fix the
 * session roll failed at the next split/stop, and combineChunks then deleted
 * the chunks after consuming only the valid sessions: every recording longer
 * than 4h55m silently lost ALL audio after the split point.
 *
 * If the raw file lacks the EBML magic and an init segment was persisted at
 * recording start, prepend it (streamed, replaced in place via temp+rename).
 * Returns the ffprobe-reported start time in seconds — post-split clusters
 * keep their absolute timecodes (~17700s+), so the caller rebases timestamps
 * to 0 during the remux and the final multi-session concat stays gapless.
 */
async function prepareRawSessionFile(recordId, rawPath) {
  let headerless = false;
  try {
    const fd = fs.openSync(rawPath, 'r');
    try {
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      headerless = !head.equals(EBML_HEADER_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    log.warn('Could not inspect raw session head:', e.message);
    return { rebaseSec: 0 };
  }

  if (!headerless) return { rebaseSec: 0 };

  const initSegPath = getInitSegmentPath(recordId);
  if (!fs.existsSync(initSegPath)) {
    log.warn('Raw session is header-less and no init_segment.bin exists — ffprobe will likely reject it');
    telemetry({ message: 'recording: header-less session roll without persisted init segment', context: {
      level: 'warning',
      tags: { operation: 'prepareRawSessionFile' },
      extra: { recordId, rawPath }
    } });
    return { rebaseSec: 0 };
  }

  const tmpPath = `${rawPath}.hdr.tmp`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    const fail = (err) => {
      try { out.destroy(); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
      reject(err);
    };
    out.on('error', bindSession(fail, reject));
    out.on('finish', resolve);
    out.write(fs.readFileSync(initSegPath));
    const src = fs.createReadStream(rawPath);
    src.on('error', bindSession(fail, reject));
    src.pipe(out);
  });
  fs.renameSync(tmpPath, rawPath);
  log.info(`Prepended persisted init segment to header-less session roll (${recordId})`);

  let rebaseSec = 0;
  try {
    const meta = await getAudioMetadata(rawPath);
    const start = parseFloat(meta?.format?.start_time);
    if (Number.isFinite(start) && start > 1) rebaseSec = start;
  } catch (e) {
    log.warn('Could not probe prepended session start time:', e.message);
  }
  return { rebaseSec };
}

// Build the session remux command, optionally rebasing input timestamps to 0
// (rebaseSec > 0 means the input is a post-split continuation whose clusters
// carry absolute timecodes from the original timeline).
function buildSessionRemux(rawPath, finalPath, rebaseSec, reencode) {
  const cmd = ffmpeg(rawPath);
  if (rebaseSec > 0) cmd.inputOptions(['-itsoffset', `-${rebaseSec}`]);
  if (!reencode) cmd.audioCodec('copy');
  cmd.outputOptions(['-avoid_negative_ts', 'make_zero']).output(finalPath);
  return cmd;
}

// Dev/test-only env-var override helper. Honored ONLY when the app is not
// packaged (i.e. `quasar dev` or `electron .`). Packaged installers always use
// the hard-coded fallback regardless of process.env — this prevents a stray
// shell variable from shortening auto-split intervals in production.
//
// Supported overrides (set in .env.local or shell env):
//   SUISSE_FFMPEG_TIMEOUT_MS  — override FFmpeg operation timeout (default 300000)
function envNumDev(key, fallback) {
  if (app.isPackaged) return fallback;
  const raw = process.env[key];
  const n = raw != null ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Minimum file size for valid recording (1KB)
const MIN_RECORDING_SIZE = 1024;

// === P0 Data Loss Fix: Validate audio output before deleting source data (V2, V11) ===
/**
 * Validate that an output audio file exists, meets minimum size, and is readable.
 * MUST be called before deleting any source data (chunks, sessions, raw files).
 * @param {string} outputPath - Path to the output audio file
 * @param {number} minSize - Minimum acceptable file size in bytes (default: MIN_RECORDING_SIZE)
 * @returns {{valid: boolean, error?: string, size?: number}}
 */
/**
 * Truncation guard: does the produced file actually contain the meeting?
 *
 * validateAudioOutput checks that a file exists, is big enough and starts with
 * EBML magic — all of which a recording that silently lost half its chunks
 * passes. Duration was probed for metadata and then never compared against the
 * wall clock, so on-device truncation stayed invisible exactly the way it did in
 * the t.kaufmann case, where a short recording was masked by the wall-clock
 * timer. The backend's audio-duration guard only catches files that are too
 * LONG (duplicated audio); nothing anywhere caught one that was too SHORT.
 *
 * Conservative on purpose: warn, never block. The audio that exists is still the
 * user's audio, and a false positive must not cost them a recording. Only a
 * shortfall of at least five seconds is reported, even in a long meeting.
 */
function checkForTruncation(recordId, producedSec, expectedSec) {
  try {
    const verdict = evaluateTruncation(producedSec, expectedSec);
    // Always log the comparison: a truncation report from the field is only
    // diagnosable if both numbers are on record, not just the alarm.
    log.info(`Recording integrity ${recordId}: produced=${Math.round(producedSec || 0)}s ` +
             `expected=${Math.round(expectedSec || 0)}s verdict=${verdict.truncated ? 'TRUNCATED' : (verdict.reason || 'ok')}`);
    if (!verdict.truncated) return null;
    recordCaptureWarning(recordId, 'recording-truncated');

    const detail = `produced ${Math.round(producedSec)}s but the session recorded ` +
      `${Math.round(expectedSec)}s — ${Math.round(verdict.shortfallSec)}s missing`;
    log.error(`Recording truncated: ${recordId} — ${detail}`);
    telemetry({ message: `recording: combined file is SHORT — ${detail} (recordId=${recordId})`, context: 'error' });
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToRenderer('system:capture-warning', {
        kind: 'recording-truncated',
        recordId,
        producedSeconds: Math.round(producedSec),
        expectedSeconds: Math.round(expectedSec),
        missingSeconds: Math.round(verdict.shortfallSec),
      });
    }
    return verdict;
  } catch (e) {
    log.warn('Truncation check failed (recording unaffected):', e.message);
    return null;
  }
}

function validateAudioOutput(outputPath, minSize = MIN_RECORDING_SIZE) {
  try {
    if (!fs.existsSync(outputPath)) {
      return { valid: false, error: 'Output file does not exist' };
    }
    const stats = fs.statSync(outputPath);
    if (stats.size < minSize) {
      return { valid: false, error: `Output file too small (${stats.size} bytes, minimum ${minSize})`, size: stats.size };
    }
    // Read first and last 1KB to verify file is readable (not corrupted/locked)
    const fd = fs.openSync(outputPath, 'r');
    try {
      const headBuf = Buffer.alloc(Math.min(1024, stats.size));
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      // Verify WebM/EBML magic bytes (0x1A 0x45 0xDF 0xA3)
      const EBML_MAGIC = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);
      if (headBuf.length >= 4 && !headBuf.subarray(0, 4).equals(EBML_MAGIC)) {
        return { valid: false, error: 'File does not have valid WebM/EBML header', size: stats.size };
      }
      if (stats.size > 1024) {
        const tailBuf = Buffer.alloc(1024);
        fs.readSync(fd, tailBuf, 0, tailBuf.length, stats.size - 1024);
      }
    } finally {
      fs.closeSync(fd);
    }
    return { valid: true, size: stats.size };
  } catch (error) {
    return { valid: false, error: `Output validation failed: ${error.message}` };
  }
}

// Calculate dynamic upload timeout based on file size
// Assumes worst-case 100KB/s upload speed with 50% buffer
function calculateUploadTimeout(fileSizeBytes) {
  const minTimeout = 600000; // 10 minutes minimum
  const bytesPerSecond = 100 * 1024; // 100KB/s worst case
  const estimatedTimeMs = (fileSizeBytes / bytesPerSecond) * 1000;
  const timeoutWithBuffer = estimatedTimeMs * 1.5; // 50% buffer
  return Math.max(minTimeout, timeoutWithBuffer);
}

// FFmpeg operation timeout (5 minutes default; overridable in dev via SUISSE_FFMPEG_TIMEOUT_MS)
const FFMPEG_TIMEOUT_MS = envNumDev('SUISSE_FFMPEG_TIMEOUT_MS', 5 * 60 * 1000);

// Stderr-silence watchdog: a healthy ffmpeg job emits progress lines every few
// seconds. If we go this long without any stderr/progress/start signal, the
// process is stuck — kill it instead of waiting out the 5-minute wall clock.
// Hit in production when the binary spawns but stalls (Sentry ec5d511f, 2026-05-27).
const FFMPEG_STDERR_SILENCE_MS = 30 * 1000;
const FFMPEG_STDERR_POLL_MS = 5 * 1000;

// Single source of truth for bundled-binary health. Populated by the startup
// probe (probeBundledBinaries) and updated by any subsequent spawn failure
// surfaced through ffmpegWithTimeout or getAudioMetadata. `available === null`
// means "not probed yet" — code paths should NOT fast-fail on null, only on
// explicit `false`, so they don't reject before the probe runs.
const binaryHealth = {
  ffmpeg: { available: null, errno: null, error: null, path: null, sizeBytes: null, mode: null, versionLine: null },
  ffprobe: { available: null, errno: null, error: null, path: null, sizeBytes: null, mode: null, versionLine: null },
};
let binaryHealthReported = false;

function isSpawnError(err) {
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('spawn') || msg.includes('enoent') || msg.includes('enoexec') || msg.includes('system error -8');
}

// Resolve the same ffmpeg/ffprobe paths that fluent-ffmpeg was configured with
// at module load. We re-derive instead of poking fluent-ffmpeg internals.
function resolveBundledBinaryPaths() {
  const isWin = process.platform === 'win32';
  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, 'ffmpeg');
    return {
      ffmpeg: path.join(dir, isWin ? 'ffmpeg.exe' : 'ffmpeg'),
      ffprobe: path.join(dir, isWin ? 'ffprobe.exe' : 'ffprobe'),
    };
  }
  try {
    return {
      ffmpeg: require('@ffmpeg-installer/ffmpeg').path,
      ffprobe: require('@ffprobe-installer/ffprobe').path,
    };
  } catch (_) {
    return { ffmpeg: null, ffprobe: null };
  }
}

function probeBinary(binPath, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const record = {
      available: false,
      errno: null,
      error: null,
      path: binPath,
      sizeBytes: null,
      mode: null,
      versionLine: null,
    };

    if (!binPath) {
      record.error = 'binary path unresolved';
      return resolve(record);
    }

    try {
      const stat = fs.statSync(binPath);
      record.sizeBytes = stat.size;
      record.mode = (stat.mode & 0o777).toString(8);
    } catch (statErr) {
      record.error = `stat failed: ${statErr.message}`;
      record.errno = statErr.code || null;
      return resolve(record);
    }

    const { spawn } = require('child_process');
    let child;
    try {
      child = spawn(binPath, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (spawnErr) {
      record.error = `spawn threw: ${spawnErr.message}`;
      record.errno = spawnErr.code || null;
      return resolve(record);
    }

    let stdout = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      resolve(record);
    };

    const timer = setTimeout(() => {
      record.available = null; // Timeout is inconclusive; allow real operations to try.
      record.error = `probe timed out after ${timeoutMs}ms`;
      finish();
    }, timeoutMs);

    let stderr = '';
    child.stdout.on('data', (d) => { stdout = (stdout + d.toString()).slice(-65536); });
    if (typeof child.stderr?.on === 'function') {
      child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4096); });
    }
    child.stderr?.resume?.(); // Drain diagnostics so a child cannot block on a full pipe.
    child.on('error', (err) => {
      clearTimeout(timer);
      record.error = err.message;
      record.errno = err.code || null;
      finish();
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      if (code === 0) {
        record.available = true;
        record.versionLine = (stdout.split('\n')[0] || '').slice(0, 200);
      } else {
        const stderrSnippet = stderr.trim().slice(0, 200);
        record.error = `exit ${code}${signal ? ' (' + signal + ')' : ''}${stderrSnippet ? ': ' + stderrSnippet : ''}`;
        record.exitCode = code;
      }
      finish();
    });
  });
}

// Runs once at app.whenReady. Probes both binaries in parallel; results are
// stashed in `binaryHealth` for every downstream call site to consult.
async function probeBundledBinaries() {
  const { ffmpeg: ffmpegPath, ffprobe: ffprobePath } = resolveBundledBinaryPaths();
  const [ffmpegResult, ffprobeResult] = await Promise.all([
    probeBinary(ffmpegPath),
    probeBinary(ffprobePath),
  ]);
  Object.assign(binaryHealth.ffmpeg, ffmpegResult);
  Object.assign(binaryHealth.ffprobe, ffprobeResult);

  log.info('Binary health probe result:', {
    ffmpeg: { available: binaryHealth.ffmpeg.available, errno: binaryHealth.ffmpeg.errno, error: binaryHealth.ffmpeg.error, versionLine: binaryHealth.ffmpeg.versionLine },
    ffprobe: { available: binaryHealth.ffprobe.available, errno: binaryHealth.ffprobe.errno, error: binaryHealth.ffprobe.error, versionLine: binaryHealth.ffprobe.versionLine },
  });

  if (binaryHealth.ffmpeg.available === false || binaryHealth.ffprobe.available === false) {
    reportBinaryHealthOnce('startup-probe');
  }
}

function reportBinaryHealthOnce(triggerSource) {
  if (binaryHealthReported) return;
  binaryHealthReported = true;
  const failedBinaries = [];
  if (binaryHealth.ffmpeg.available === false) failedBinaries.push(`ffmpeg (${binaryHealth.ffmpeg.error || 'unavailable'})`);
  if (binaryHealth.ffprobe.available === false) failedBinaries.push(`ffprobe (${binaryHealth.ffprobe.error || 'unavailable'})`);
  const failureSummary = failedBinaries.join(', ') || 'unknown';

  telemetry({ message: `Bundled media binary unavailable: ${failureSummary}`, context: {
    level: 'warning',
    tags: {
      operation: 'binaryHealth',
      'binary.platform': process.platform,
      'binary.arch': process.arch,
      'binary.ffmpeg_available': String(binaryHealth.ffmpeg.available),
      'binary.ffprobe_available': String(binaryHealth.ffprobe.available),
    },
    extra: {
      trigger: triggerSource,
      ffmpeg: { ...binaryHealth.ffmpeg },
      ffprobe: { ...binaryHealth.ffprobe },
    },
  } });
}

function markBinaryUnavailable(kind, err, triggerSource) {
  const slot = binaryHealth[kind];
  if (!slot || slot.available === false) return;
  slot.available = false;
  slot.error = slot.error || err?.message || 'unknown';
  slot.errno = slot.errno || err?.code || null;
  log.error(`${kind} binary cannot execute (${slot.error}) — all ${kind} operations will be skipped`);
  reportBinaryHealthOnce(triggerSource);
}

// Execute FFmpeg command with timeout + Sentry tracking
function ffmpegWithTimeout(ffmpegCommand, timeoutMs = FFMPEG_TIMEOUT_MS, operationName = 'FFmpeg', { reportToSentry = true } = {}) {
  // Recovery finalization (publish gate of its scope): no new FFmpeg process
  // after the session ended. Foreground (stop) has no gate.
  assertPublishAllowed();
  // Fast-fail if FFmpeg binary is known to be broken (startup probe or earlier call)
  if (binaryHealth.ffmpeg.available === false) {
    return Promise.reject(new Error(`FFmpeg binary unavailable (${binaryHealth.ffmpeg.error || 'spawn failed'}) — skipping ${operationName}`));
  }

  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    let lastStderrAt = Date.now();
    let processStarted = false;

    let wallTimer = null;
    let silenceTimer = null;
    const cleanup = () => {
      if (wallTimer) { clearTimeout(wallTimer); wallTimer = null; }
      if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
    };

    wallTimer = setTimeout(() => {
      cleanup();
      const elapsed = Date.now() - startTime;
      log.warn(`${operationName} operation timed out after ${timeoutMs}ms`);
      // Always report timeouts — they are never expected
      telemetry({ message: `FFmpeg timeout: ${operationName} after ${(elapsed / 1000).toFixed(1)}s`, context: {
        level: 'error',
        tags: { operation: operationName },
        extra: { timeoutMs, elapsedMs: elapsed, processStarted },
      } });
      try {
        ffmpegCommand.kill('SIGKILL');
      } catch (e) {
        log.error('Error killing FFmpeg process:', e);
      }
      reject(new Error(`${operationName} operation timed out`));
    }, timeoutMs);

    // Stderr-silence watchdog: kill stuck processes long before the 5-min wall clock.
    // We accept up to FFMPEG_STDERR_SILENCE_MS of silence after the last signal
    // (start / stderr line / progress event). Healthy jobs send stderr every
    // few seconds; silence means the process is wedged.
    silenceTimer = setInterval(() => {
      const silentFor = Date.now() - lastStderrAt;
      if (silentFor < FFMPEG_STDERR_SILENCE_MS) return;
      cleanup();
      const elapsed = Date.now() - startTime;
      log.warn(`${operationName} stderr silent for ${silentFor}ms — killing process`);
      telemetry({ message: `FFmpeg stalled: ${operationName} silent for ${(silentFor / 1000).toFixed(0)}s`, context: {
        level: 'error',
        tags: { operation: operationName },
        extra: { silentMs: silentFor, elapsedMs: elapsed, timeoutMs, processStarted },
      } });
      try {
        ffmpegCommand.kill('SIGKILL');
      } catch (e) {
        log.error('Error killing stalled FFmpeg process:', e);
      }
      reject(new Error(`${operationName} stalled (no stderr for ${(silentFor / 1000).toFixed(0)}s)`));
    }, FFMPEG_STDERR_POLL_MS);

    ffmpegCommand
      .on('start', () => { processStarted = true; lastStderrAt = Date.now(); })
      .on('stderr', () => { lastStderrAt = Date.now(); })
      .on('progress', () => { lastStderrAt = Date.now(); })
      .on('end', () => {
        cleanup();
        resolve();
      })
      .on('error', bindSession((err) => {
        cleanup();
        // A start refused by the effect gate (session ended): that error, no
        // health change, no report (round 10, F3).
        try { assertPublishAllowed(); } catch (gateError) { reject(gateError); return; }
        // Detect spawn failures and update the unified health record
        if (isSpawnError(err)) {
          markBinaryUnavailable('ffmpeg', err, `ffmpegWithTimeout:${operationName}`);
        }
        if (reportToSentry) {
          telemetry({ exception: err, context: {
            tags: { operation: operationName },
            extra: { elapsedMs: Date.now() - startTime, ffmpegAvailable: binaryHealth.ffmpeg.available, processStarted },
          } });
        }
        reject(err);
      }, reject))
      .run();
  });
}

function recordCaptureWarning(recordId, kind) {
  try {
    const metadataPath = path.join(getRecordingPath(recordId), 'metadata.json');
    const metadata = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : { recordId };
    metadata.captureWarnings = [...new Set([...(metadata.captureWarnings || []), kind])];
    writeFileWithSync(metadataPath, JSON.stringify(metadata, null, 2));
  } catch (error) {
    // The session of this background work ended: never swallowed (round 10, F2).
    if (isSessionEnded(error)) throw error;
    log.error('Could not persist capture warning:', error.message);
  }
}

// Tell the renderer (and Sentry, once) that captured system audio could NOT be
// carried into the final file. Previously this degradation was a main.log-only
// warn — the user uploaded a "complete" meeting whose participants were simply
// missing (field evidence: ELECTRON-1Y, ffmpeg unavailable on 2 machines).
function notifyMergeDegraded(recordId, reason, detail) {
  assertPublishAllowed();
  recordCaptureWarning(recordId, 'merge-degraded');
  log.warn(`System audio merge degraded for ${recordId}: ${reason} (${detail || 'no detail'})`);
  telemetry({ message: `System audio merge degraded: ${reason}`, context: {
    level: 'warning',
    tags: { operation: 'merge-degraded', recordId },
    extra: { detail },
  } });
  sendToRenderer('system:capture-warning', { kind: 'merge-degraded', recordId, reason, detail });
}

// Merge system audio (PCM) with mic recording using FFmpeg amix
async function mergeSystemAudio(micPath, recordId) {
  const recordPath = getRecordingPath(recordId);
  const systemAudioPath = path.join(recordPath, 'system_audio.raw');

  if (!fs.existsSync(systemAudioPath)) return micPath;
  if (fs.statSync(systemAudioPath).size === 0) {
    try { fs.unlinkSync(systemAudioPath); } catch (e) { /* ignore */ }
    return micPath;
  }
  if (binaryHealth.ffmpeg.available === false) {
    notifyMergeDegraded(recordId, 'ffmpeg-unavailable', binaryHealth.ffmpeg.error || 'spawn failed');
    throw Object.assign(new Error('System audio could not be combined because FFmpeg is unavailable; both sources are retained for retry'), { code: 'FFMPEG_UNAVAILABLE' });
  }

  const mergedPath = micPath.replace(/(\.\w+)$/, '_merged$1');
  const pcmBytes = fs.statSync(systemAudioPath).size;
  log.info(`Merging system audio (${pcmBytes} bytes) with mic recording`);

  // The merge re-encodes the FULL meeting. The flat 5-minute FFMPEG_TIMEOUT_MS
  // is plenty for an hour but kills the merge of a 4-5h meeting (PCM alone is
  // ~340 MB/hour) on a slow disk — silently discarding every participant's
  // audio. Scale the budget with input size: 5 min base + 10 min per GB of
  // PCM, capped at 45 min. (Stderr-silence watchdog still catches true hangs.)
  const mergeTimeoutMs = Math.min(
    45 * 60_000,
    FFMPEG_TIMEOUT_MS + Math.ceil(pcmBytes / (1024 * 1024 * 1024)) * 10 * 60_000
  );

  try {
    // Mix mic + system audio at FULL volume for each.
    //
    // The bundled ffmpeg is an old (2018) build whose `amix` filter lacks the
    // `normalize=0` option, so a plain `amix=inputs=2` force-averages the inputs
    // — each source ends up at 50% volume, which made captured system audio
    // (meeting participants) sound faint or inaudible in the transcript. We
    // pre-boost each input by 2.0 to cancel that averaging (net 1.0 = full
    // volume, matching the Windows Web-Audio path which sums both at unity gain),
    // then run an lookahead limiter so simultaneous loud passages can't clip.
    await ffmpegWithTimeout(
      ffmpeg()
        // System audio: raw PCM, 48kHz, mono, 16-bit signed little-endian
        .input(systemAudioPath)
        .inputOptions(['-f', 's16le', '-ar', '48000', '-ac', '1'])
        // Mic recording
        .input(micPath)
        // Keep BOTH mic and system audio audible at full level, then limit.
        .complexFilter([
          '[0:a]volume=2.0[sys]',
          '[1:a]volume=2.0[mic]',
          '[sys][mic]amix=inputs=2:duration=longest:dropout_transition=0[mixed]',
          '[mixed]alimiter=limit=0.95[out]'
        ], ['out'])
        .output(mergedPath),
      mergeTimeoutMs,
      'System audio merge'
    );

    // Validate merged file
    const mergedValidation = validateAudioOutput(mergedPath);
    if (!mergedValidation.valid) {
      throw Object.assign(new Error(mergedValidation.error || 'System audio merge produced an invalid file'), {
        code: 'AUDIO_MERGE_INVALID', mergeReason: 'merged-file-invalid'
      });
    }
    await publishFile(mergedPath, micPath);
    log.info('System audio merged successfully');
  } catch (err) {
    // A session change is not a degraded merge: passed on at once, no warning,
    // no clean-up, no event (round 10, F2).
    if (isSessionEnded(err)) throw err;
    notifyMergeDegraded(recordId, err.mergeReason || 'merge-failed', err.message);
    try { if (fs.existsSync(mergedPath)) fs.unlinkSync(mergedPath); } catch (e) { /* ignore */ }
    // Returning the mic file here lets finalize() publish a success receipt and
    // upload a meeting with every remote participant missing. Keep all sources
    // and the original error code (especially ENOSPC) for the normal retry flow.
    throw err;
  }

  // Keep the original PCM alongside microphone chunks after success too.
  return micPath;
}

// IPC handler for checking disk space before recording
ipcMain.handle('recording:checkDiskSpace', async () => {
  try {
    const recordingsPath = getRecordingsPath();
    return await canStartRecording(recordingsPath);
  } catch (error) {
    log.error('Error checking disk space:', error);
    return { canStart: true, freeSpace: 0, freeSpaceMB: 0, message: '' };
  }
});

// IPC handlers for tracking recording state (for window close protection)
ipcMain.handle('recording:setInProgress', (event, inProgress) => {
  isRecordingInProgress = !!inProgress;
  updateRecordingPowerBlocker();
  log.info('Recording state updated:', { isRecordingInProgress });

  // Show/hide tray indicator based on recording state
  if (inProgress) {
    createRecordingTray();
  } else {
    destroyRecordingTray();
  }

  return { success: true };
});

ipcMain.handle('recording:setUnsavedAudio', (event, recordId) => {
  unsavedRecordingId = recordId == null ? null : validateRecordId(recordId);
  updateRecordingPowerBlocker();
  return { success: true };
});

ipcMain.handle('recording:setProcessing', (event, processing) => {
  isProcessingRecording = !!processing;
  updateRecordingPowerBlocker();
  log.info('Recording processing state updated:', { isProcessingRecording });
  return { success: true };
});

// IPC handlers for recording metadata
ipcMain.handle('recording:saveMetadata', async (event, recordId, metadata) => {
  try {
    const validRecordId = validateRecordId(recordId);
    const recordPath = getRecordingPath(validRecordId);

    // Ensure directory exists
    if (!fs.existsSync(recordPath)) {
      fs.mkdirSync(recordPath, { recursive: true });
    }

    const metadataPath = path.join(recordPath, 'metadata.json');
    // Main-process integrity warnings survive later renderer metadata updates.
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch (_) { /* first save */ }
    const captureWarnings = [...new Set([
      ...(Array.isArray(existing.captureWarnings) ? existing.captureWarnings : []),
      ...(Array.isArray(metadata.captureWarnings) ? metadata.captureWarnings : []),
    ])];
    writeFileWithSync(metadataPath, JSON.stringify({ ...existing, ...metadata, captureWarnings }, null, 2));

    return { success: true };
  } catch (error) {
    console.error('Error saving metadata:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('recording:loadMetadata', async (event, recordId) => {
  try {
    const validRecordId = validateRecordId(recordId);
    const metadataPath = path.join(getRecordingPath(validRecordId), 'metadata.json');

    if (!fs.existsSync(metadataPath)) {
      return { success: false, error: 'Metadata file not found' };
    }

    const content = fs.readFileSync(metadataPath, 'utf8');
    const metadata = JSON.parse(content);

    return { success: true, metadata };
  } catch (error) {
    console.error('Error loading metadata:', error);
    return { success: false, error: error.message };
  }
});

// 1. Create recording session (creates directories)
ipcMain.handle('recording:createSession', async (event, recordId, ext, userId, options = {}) => {
  // Step-timing for Sentry breadcrumbs. Renderer wraps this IPC in a 30s
  // timeout; if it fires, breadcrumbs reveal which step was slow.
  const tStart = Date.now();
  const step = (name, startedAt, extra = {}) => {
    Sentry.addBreadcrumb({
      category: 'recording.createSession',
      message: name,
      level: 'info',
      data: { elapsedMs: Date.now() - startedAt, ...extra }
    });
  };

  try {
    // Validate inputs to prevent path traversal attacks
    const tValidate = Date.now();
    const validRecordId = validateRecordId(recordId);
    const validExt = validateExtension(ext);
    const validUserId = userId ? validateUserId(userId) : null;
    if (options?.captureMode !== undefined && options.captureMode !== NATIVE_CAPTURE_MODE) throw new Error('Unknown recording capture mode');
    step('validated', tValidate, { recordId: validRecordId });

    // Check disk space before creating session (statfs syscall, bounded to 3s
    // with a fail-open fallback in case userData sits on a stalled network share).
    const tDisk = Date.now();
    const recordingsPath = getRecordingsPath();
    const diskCheck = await canStartRecording(recordingsPath);
    step('disk-checked', tDisk, {
      canStart: diskCheck.canStart,
      freeSpaceMB: diskCheck.freeSpaceMB,
      fallback: diskCheck.fallback,
      checkElapsedMs: diskCheck.checkElapsedMs
    });
    if (diskCheck.fallback) {
      log.warn(`Disk space check fell back (${diskCheck.checkError || 'timeout'}); proceeding with recording`);
    }
    if (!diskCheck.canStart) {
      log.warn('Insufficient disk space to start recording:', diskCheck.freeSpaceMB, 'MB available');
      return { success: false, error: diskCheck.message };
    }

    // Create directories synchronously to ensure they exist
    const tDirs = Date.now();
    const recordPath = getRecordingPath(validRecordId);
    const chunksPath = getChunksPath(validRecordId);
    if (!fs.existsSync(recordPath)) {
      fs.mkdirSync(recordPath, { recursive: true });
    }
    if (!fs.existsSync(chunksPath)) {
      fs.mkdirSync(chunksPath, { recursive: true });
    }
    step('dirs-created', tDirs);

    // Persist authority before ANY capture starts, including macOS system-only
    // sessions. A failed native start must never fall back to the live mix.
    if (options?.captureMode === NATIVE_CAPTURE_MODE) await markNativeCaptureSession(recordPath);

    // Write metadata.json for recording persistence and multi-account handling
    const tMeta = Date.now();
    const metadataPath = path.join(recordPath, 'metadata.json');
    const metadata = {
      recordId: validRecordId,
      userId: validUserId,
      startedAt: new Date().toISOString(),
      version: 1
    };
    writeFileWithSync(metadataPath, JSON.stringify(metadata, null, 2));
    step('metadata-written', tMeta);
    log.info('Recording metadata written:', validRecordId, 'userId:', validUserId);

    // Initialize active recording state with userId
    const tActive = Date.now();
    updateActiveRecording(validRecordId, 0, validUserId);
    step('active-state-updated', tActive);

    const totalMs = Date.now() - tStart;
    if (totalMs > 5000) {
      // Succeeded but slow — report so we can keep an eye on this path.
      Sentry.captureMessage(`createSession slow: ${totalMs}ms`, {
        level: 'warning',
        tags: { operation: 'createSession' },
        extra: {
          totalMs,
          recordId: validRecordId,
          diskCheckMs: diskCheck.checkElapsedMs,
          diskCheckFallback: diskCheck.fallback
        }
      });
    }

    console.log(`Recording session created: ${recordId} (${totalMs}ms)`);
    return { success: true, path: chunksPath };
  } catch (error) {
    console.error('Error creating session:', error);
    Sentry.addBreadcrumb({
      category: 'recording.createSession',
      message: 'error',
      level: 'error',
      data: { elapsedMs: Date.now() - tStart, error: error.message }
    });
    return { success: false, error: error.message };
  }
});

// Native source transactions share the same lock as finalization/deletion.
// Every source operation is idempotent after an IPC timeout or lost reply.
for (const operation of ['beginSource', 'markSourceStarted', 'saveSourceChunk', 'endSource']) {
  ipcMain.handle(`recording:${operation}`, async (event, recordId, ...args) => {
    try {
      const id = validateRecordId(recordId);
      return await withRecordingLock(id, async () => {
        if (inFlightUploads.has(id)) throw new Error('This recording is still uploading');
        const recordPath = getRecordingPath(id);
        readNativeCaptureMarker(recordPath);
        return nativeSourcePersistence[operation](recordPath, ...args);
      });
    } catch (error) {
      return { success: false, error: error.message, code: error.code || null, diskFull: error.code === 'ENOSPC' };
    }
  });
}

// 2. Save recording chunk - SYNCHRONOUS write
ipcMain.handle('recording:saveChunk', async (event, recordId, chunkData, chunkIndex, ext, userId) => {
  // Validate first (sync, fail fast without acquiring a lock on bogus IDs)
  let validRecordId, validExt, validChunkIndex, validUserId;
  try {
    validRecordId = validateRecordId(recordId);
    validExt = validateExtension(ext);
    validChunkIndex = validateChunkIndex(chunkIndex);
    validUserId = userId ? validateUserId(userId) : null;
  } catch (error) {
    console.error('saveChunk validation failed:', error);
    return { success: false, error: error.message };
  }

  return withRecordingLock(validRecordId, async () => {
    try {
      const recordPath = getRecordingPath(validRecordId);
      const chunksPath = getChunksPath(validRecordId);

      // Ensure directories exist (sync)
      if (!fs.existsSync(recordPath)) {
        fs.mkdirSync(recordPath, { recursive: true });
      }
      if (!fs.existsSync(chunksPath)) {
        fs.mkdirSync(chunksPath, { recursive: true });
      }

      const buffer = Buffer.from(chunkData);
      const filename = `chunk_${validChunkIndex}${validExt}`;
      const chunkPath = path.join(chunksPath, filename);

      // CRITICAL: Write + fsync to guarantee chunk is persisted to disk, not just OS cache
      // Uses async I/O to avoid blocking the main process event loop
      await writeFileAtomic(chunkPath, buffer);

      // Persist the WebM init segment (everything before the first Cluster)
      // from the very first blob of the recording. Post-auto-split chunk sets
      // start mid-stream (chunk index resets while the same recorder keeps
      // running), so rolling them into a session file needs this prefix to be
      // parseable — see prepareRawSessionFile. Only the true first blob
      // carries the EBML magic, so post-split chunk_0 writes are skipped.
      if (validChunkIndex === 0 && buffer.length > 4 && buffer.subarray(0, 4).equals(EBML_HEADER_MAGIC)) {
        try {
          const clusterIdx = buffer.indexOf(WEBM_CLUSTER_MAGIC);
          if (clusterIdx > 0 && clusterIdx <= 1048576) {
            writeFileWithSync(getInitSegmentPath(validRecordId), buffer.subarray(0, clusterIdx));
          }
        } catch (e) {
          log.warn('Could not persist init segment:', e.message);
        }
      }

      // Update active recording state for crash recovery (with userId)
      updateActiveRecording(validRecordId, validChunkIndex + 1, validUserId);

      console.log(`Chunk ${chunkIndex} saved (${buffer.length} bytes):`, chunkPath);
      return { success: true, chunkIndex, chunkPath };
    } catch (error) {
      console.error('Error saving chunk:', error);
      return { success: false, error: error.message, code: error.code || null };
    }
  });
});

// Rotate source batches only. Expensive remuxing happens AFTER capture stops,
// so a long meeting never pauses for minutes while FFmpeg processes a split.
ipcMain.handle('recording:createSessionFile', async (event, recordId, ext) => {
  try {
    const validRecordId = validateRecordId(recordId);
    const validExt = validateExtension(ext);
    return await withRecordingLock(validRecordId, async () => {
      const batch = await archiveChunkBatch(getRecordingPath(validRecordId), validExt);
      return { success: true, batchId: batch?.id || null };
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Helper function to update metadata.json on recording completion
function updateRecordingMetadataOnCompletion(recordId, duration, hasAudioFile) {
  try {
    const recordPath = getRecordingPath(recordId);
    const metadataPath = path.join(recordPath, 'metadata.json');

    let metadata = {};
    // Read existing metadata if it exists
    if (fs.existsSync(metadataPath)) {
      try {
        const content = fs.readFileSync(metadataPath, 'utf8');
        metadata = JSON.parse(content);
      } catch (e) {
        log.warn('Could not parse existing metadata, creating new:', e.message);
      }
    }

    // Update with completion info
    metadata.completedAt = new Date().toISOString();
    metadata.duration = duration;
    metadata.hasAudioFile = hasAudioFile;
    metadata.version = metadata.version || 1;

    writeFileWithSync(metadataPath, JSON.stringify(metadata, null, 2));
    const recordings = historyStore.get('recordings', []);
    const index = recordings.findIndex(recording => recording.id === recordId);
    if (index !== -1) {
      recordings[index] = withCaptureWarnings(recordings[index], getRecordingsPath());
      historyStore.set('recordings', recordings);
    }
    log.info('Recording metadata updated on completion:', recordId);
  } catch (error) {
    if (isSessionEnded(error)) throw error;
    log.error('Failed to update recording metadata on completion:', error);
    // Don't throw - this is non-critical
  }
}

// Normal stop and crash recovery use the same durable finalization pipeline.
ipcMain.handle('recording:combineChunks', async (event, recordId, ext, expectedDurationSec, options = {}) => {
  try {
    const validRecordId = validateRecordId(recordId);
    const validExt = validateExtension(ext);
    if (inFlightUploads.has(validRecordId)) return { success: false, error: 'This recording is still uploading' };
    return await withRecordingLock(validRecordId, () => inFlightUploads.has(validRecordId)
      ? { success: false, error: 'This recording is still uploading' }
      : finalizeRecording(validRecordId, validExt, expectedDurationSec, { recovery: options?.recovery === true }));
  } catch (error) {
    return { success: false, error: error.message };
  }
});

async function finalizeRecording(recordId, ext, expectedDurationSec = 0, options = {}) {
  const recordPath = getRecordingPath(recordId);
  try {
    if (options.exportRecovery === true) assertExportRecoveryReady(recordPath, isExportRecoveryBusy(recordId));
    // A failed rebuild must not let automatic upload retries send an older
    // audio.webm. Clear this durable gate only after finalization succeeds.
    const pendingPath = path.join(recordPath, FINALIZATION_PENDING_MARKER);
    await writeFileAtomic(pendingPath, JSON.stringify({ version: 1, startedAt: new Date().toISOString() }));
    const spaceCheck = await canFinalizeRecording(recordPath);
    // Capture can start while the disk check awaits. Export recovery must
    // never stop a live AudioTee, even if recording state changed mid-request.
    if (options.exportRecovery === true) assertExportRecoveryReady(recordPath, isExportRecoveryBusy(recordId));
    if (!spaceCheck.canFinalize) {
      return { success: false, diskFull: true, ...spaceCheck, error: 'Insufficient disk space to finalize recording; source audio is preserved' };
    }
    // Ensure all AudioTee stdout and disk writes have finished before merging.
    if (activeAudioTee?.recordId === recordId) {
      const stopped = await stopSystemAudio();
      if (stopped?.success === false) throw Object.assign(new Error(stopped.error || 'System audio did not finish saving; source audio is retained'), { code: 'PCM_CAPTURE_RECOVERY_REQUIRED' });
    }
    const persistence = createRecordingPersistence({
      nativeBuild: (directory, outputPath, nativeOptions) => createNativeSourceFinalization({
        ffmpeg, run: ffmpegWithTimeout, validate: validateNativeMedia,
        ffprobePath: resolveBundledBinaryPaths().ffprobe,
        probe: async file => Number((await getAudioMetadata(file))?.format?.duration) || 0,
        checkSpace: async neededBytes => {
          const available = await getAvailableSpaceDetailed(directory);
          if (!available.fallback && available.free < neededBytes) {
            throw Object.assign(new Error(`Insufficient disk space to finalize native audio: ${Math.ceil(neededBytes / 1048576)} MB needed; original audio is retained`), { code: 'ENOSPC' });
          }
        },
      }).build(directory, outputPath, nativeOptions),
      fromPcm: async (pcmPath, outputPath) => {
        await ffmpegWithTimeout(ffmpeg(pcmPath).inputOptions(['-f', 's16le', '-ar', '48000', '-ac', '1']).output(outputPath), FFMPEG_TIMEOUT_MS, 'Recover system audio');
        recordCaptureWarning(recordId, 'microphone-source-missing');
      },
      prepareRaw: rawPath => prepareRawSessionFile(recordId, rawPath),
      remux: async (rawPath, outputPath, { rebaseSec }) => {
        try {
          await ffmpegWithTimeout(buildSessionRemux(rawPath, outputPath, rebaseSec, false), FFMPEG_TIMEOUT_MS, 'Session remux', { reportToSentry: false });
        } catch (error) {
          await ffmpegWithTimeout(buildSessionRemux(rawPath, outputPath, rebaseSec, true), FFMPEG_TIMEOUT_MS, 'Session re-encode');
        }
      },
      concatSessions: async (sessions, outputPath) => {
        const listPath = path.join(recordPath, 'concat_list.txt');
        // FFmpeg concat files use shell-like single-quote escaping, even on
        // Windows. User profile paths may contain an apostrophe.
        const lines = sessions.map(file => "file '" + file.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n');
        await writeFileAtomic(listPath, lines);
        try {
          const command = copy => {
            const cmd = ffmpeg().input(listPath).inputOptions(['-f', 'concat', '-safe', '0']).output(outputPath);
            return copy ? cmd.audioCodec('copy') : cmd;
          };
          try { await ffmpegWithTimeout(command(true), FFMPEG_TIMEOUT_MS, 'Concat sessions', { reportToSentry: false }); }
          catch (error) { await ffmpegWithTimeout(command(false), FFMPEG_TIMEOUT_MS, 'Concat sessions re-encode'); }
        } finally { await fs.promises.unlink(listPath).catch(() => {}); }
      },
      merge: outputPath => mergeSystemAudio(outputPath, recordId),
      validate: validateAudioOutput,
      probe: async outputPath => Number((await getAudioMetadata(outputPath))?.format?.duration) || 0,
    });
    const result = await persistence.finalize(recordPath, ext, { ...options, expectedDurationSec: Number(expectedDurationSec) || 0 });
    // Other software changed timestamps of fresh recording files while they
    // were read; the bytes were verified unchanged (ELECTRON-6V). Info only:
    // field evidence for which timestamps move, never an alert.
    const encodedTimestampChanges = result.plan?.validation?.encodedPacketEvidence?.codedSampleEvidence?.metadataChanged || [];
    if (encodedTimestampChanges.length || result.sourceTimestampChanges?.length) {
      log.info(`Finalization tolerated timestamp-only changes for ${recordId}: output [${encodedTimestampChanges.join(', ')}], sources [${(result.sourceTimestampChanges || []).join(', ')}]`);
      try {
        telemetry({ message: 'finalization: timestamps of fresh recording files changed while saving (bytes unchanged, tolerated)', context: {
          level: 'info',
          fingerprint: ['finalization-timestamp-only-change'],
          tags: { operation: 'finalization', rebuilt: String(!!result.sourceTimestampChanges?.length) },
          extra: { recordId, encodedTimestampChanges, sourceTimestampChanges: result.sourceTimestampChanges || [] },
        } });
      } catch (_) { /* telemetry never breaks saving */ }
    }
    if (result.supersededScratchLeft) log.warn(`Superseded finalization scratch could not be removed for ${recordId}: ${result.supersededScratchLeft}`);
    for (const warning of result.warnings || []) {
      assertPublishAllowed();
      recordCaptureWarning(recordId, typeof warning === 'string' ? warning : warning.kind || warning.code || 'native-source-recovery');
    }
    // Publishing steps: in recovery (publish gate of the scope) each one only
    // while the session is alive, checked right before it (round 9, R-S4).
    assertPublishAllowed();
    await fs.promises.unlink(pendingPath);
    syncDirectorySync(recordPath);
    assertPublishAllowed();
    updateRecordingMetadataOnCompletion(recordId, result.duration, true);
    assertPublishAllowed();
    checkForTruncation(recordId, result.duration, Number(expectedDurationSec) || 0);
    assertPublishAllowed();
    if (getActiveRecording()?.recordId === recordId) clearActiveRecording();
    return result;
  } catch (error) {
    // The session of the recovery ended: the scope settles it (round 10, F2).
    if (isSessionEnded(error)) throw error;
    log.error('Recording finalization failed; all source batches retained:', error);
    const diskFull = error.code === 'ENOSPC' || /no space left|not enough space|disk full/i.test(error.message || '');
    return { success: false, diskFull, requiresRecovery: error.code === 'PCM_CAPTURE_RECOVERY_REQUIRED', error: error.message, code: error.code || null };
  }
}

// 5. Check for recording chunks/sessions
ipcMain.handle('recording:checkForChunks', async (event, recordId, ext) => {
  try {
    recordId = validateRecordId(recordId);
    ext = validateExtension(ext);
    const chunksPath = getChunksPath(recordId);
    const sessionsPath = getSessionsPath(recordId);

    let chunkCount = 0;
    let sessionCount = 0;
    let lastChunkIndex = -1;

    if (fs.existsSync(chunksPath)) {
      const chunks = fs.readdirSync(chunksPath)
        .filter(f => f.startsWith('chunk_') && f.endsWith(ext));
      chunkCount = chunks.length;

      if (chunks.length > 0) {
        const sorted = sortChunksNumerically(chunks, ext);
        const lastChunk = sorted[sorted.length - 1];
        lastChunkIndex = parseInt(lastChunk.replace('chunk_', '').replace(ext, ''), 10);
      }
    }

    if (fs.existsSync(sessionsPath)) {
      const sessions = fs.readdirSync(sessionsPath)
        .filter(f => f.endsWith(ext) && !f.includes('_raw'));
      sessionCount = sessions.length;
    }

    return {
      hasChunks: chunkCount > 0 || sessionCount > 0 || listChunkBatches(getRecordingPath(recordId)).length > 0 ||
        usesNativeSources(getRecordingPath(recordId)) ||
        (fs.existsSync(path.join(getRecordingPath(recordId), 'system_audio.raw')) && fs.statSync(path.join(getRecordingPath(recordId), 'system_audio.raw')).size > 0),
      chunkCount,
      sessionCount,
      lastChunkIndex
    };
  } catch (error) {
    return { hasChunks: false, chunkCount: 0, sessionCount: 0, lastChunkIndex: -1 };
  }
});

ipcMain.handle('recording:getFilePath', async (event, recordId, ext) => {
  recordId = validateRecordId(recordId);
  ext = validateExtension(ext);
  const recordingDir = getRecordingPath(recordId);
  const filePath = path.join(recordingDir, `audio${ext}`);

  try {
    await fs.promises.access(filePath);
    const stats = await fs.promises.stat(filePath);
    return {
      success: true,
      filePath,
      fileSize: stats.size,
      fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
    };
  } catch (error) {
    return { success: false, error: 'File not found' };
  }
});

ipcMain.handle('recording:deleteRecording', async (event, recordId, options = {}) => {
  try {
    validateRecordId(recordId);
    if (unsavedRecordingId === recordId || inFlightUploads.has(recordId) || (isRecordingInProgress && getActiveRecording()?.recordId === recordId) || recordingLocks.has(recordId)) {
      return { success: false, error: 'Recording is still in use' };
    }
    const recordingDir = getRecordingPath(recordId);
    if (options.requireVerified) {
      // Older receipts and delayed renderer callbacks may still grant deletion
      // from a Meeting status. Enforce retention here as well as in new results.
      return { success: false, error: 'The server has not verified the complete audio file. Automatic deletion is paused; you can delete this local copy manually in History.' };
    }
    await rmDirSafe(recordingDir);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- Upload ---

// Helper: Get auth token
async function getAuthToken() {
  try {
    return sessionAuthority.getToken();
  } catch (e) {
    console.warn('Could not get auth token:', e);
    return null;
  }
}

// Work without a ticket belongs to no session (round 8): never «the current
// one» by default - a default taken late is how a late 401 refreshed the
// next session.
function sessionEndedFor(ticket) {
  return !ticket || !sessionAuthority.isCurrent(ticket);
}

ipcMain.handle('upload:start', async (event, params) => {
  const { filePath, metadata } = params;
  const recordId = validateRecordId(params.recordId);

  if (unsavedRecordingId === recordId) return { success: false, canDelete: false, canRetry: true, error: 'Finish saving the recording before uploading it' };
  // Round 9: the upload is background work of the session it starts in.
  const scope = scopes.open();
  if (!scope) {
    // Signed out: the recording waits in the queue for its owner's sign-in.
    addToUploadQueue(recordId, filePath, metadata);
    return { success: false, status: 401, canDelete: false, canRetry: true, error: 'Not authenticated. Please login first.' };
  }
  // Prevent duplicate concurrent uploads of the same recording.
  // inProgress lets the renderer's retry paths hand off to the running upload
  // instead of misfiling the rejection as a fresh failure.
  if (!scope.claim(recordId)) {
    log.warn(`Upload already in progress for ${recordId}, rejecting duplicate`);
    return { success: false, error: 'Upload already in progress', duplicate: true, inProgress: true };
  }
  updateRecordingPowerBlocker();

  // Mark upload as in progress
  isUploadInProgress = true;
  pendingUploadsCount++;

  try {
    // Clear any previous cancelled state for this recordId (e.g. from a retry)
    cancelledUploads.delete(recordId);
    const result = await background.uploads.runUploadStart(scope, { recordId, filePath, metadata }, {
      cancelled: () => cancelledUploads.has(recordId),
      quitting: () => isQuittingWithUploads,
    });
    // Suppress the completion event of a user cancel only once.
    cancelledUploads.delete(recordId);
    return result;
  } finally {
    scope.release(recordId);
    updateRecordingPowerBlocker();
    pendingUploadsCount--;
    if (pendingUploadsCount <= 0) {
      pendingUploadsCount = 0;
      isUploadInProgress = false;
    }
  }
});

ipcMain.handle('upload:cancel', async (event, recordId) => {
  // Mark as cancelled so upload:start suppresses the completion event
  cancelledUploads.add(recordId);

  // Abort the running upload (its own controller, registered by its scope).
  const cancelled = scopes.cancelUpload(recordId);

  // Best-effort cleanup of staged blob if the cancelled upload used the
  // direct-to-blob flow. Fires asynchronously — we don't make the user wait
  // for blob deletion. Background work of the upload's own session: after a
  // session change it sends nothing.
  if (cancelled?.audioFileId && cancelled.scope.alive()) {
    const scope = cancelled.scope;
    Promise.resolve()
      .then(() => background.abortDirectUpload(scope, { recordId, audioFileId: cancelled.audioFileId }))
      .catch((e) => log.warn(`[upload:cancel] abort cleanup failed for ${recordId}:`, e?.message));
  }

  // Remove from persistent upload queue (the user's own action, any session)
  removeFromUploadQueue(recordId);

  return { success: true };
});

// Get pending uploads in queue
ipcMain.handle('upload:getPendingQueue', async () => {
  return uploadQueueStore.get('pendingUploads', []);
});

// Manually trigger pending uploads retry
ipcMain.handle('upload:retryPending', async () => {
  try {
    await processPendingUploads();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Remove a specific item from upload queue
ipcMain.handle('upload:removeFromQueue', async (event, recordId) => {
  removeFromUploadQueue(recordId);
  return { success: true };
});

ipcMain.handle('meeting:pollStatus', async (event, meetingId) => {
  const scope = scopes.open();
  if (!scope) return { status: 'AUTH_EXPIRED', resolved: false };
  return background.uploads.pollMeetingTranscriptionStatus(scope, meetingId);
});

// --- Utility ---
ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('app:getUserDataPath', () => {
  return app.getPath('userData');
});

// Open external URL in default browser
// Security: Only allow specific trusted domains to prevent malicious URL opening
const ALLOWED_EXTERNAL_DOMAINS = ['app.suisse-notes.ch', 'suisse-notes.ch', 'app.suisse-meets.ch', 'suisse-meets.ch', 'suisse-ai.ch', 'suisse-it.ch'];

ipcMain.handle('shell:openExternal', async (event, url) => {
  try {
    const urlObj = new URL(url);

    // Allow mailto: links
    if (urlObj.protocol === 'mailto:') {
      await shell.openExternal(url);
      return { success: true };
    }

    // Only allow https: protocol
    if (urlObj.protocol !== 'https:') {
      throw new Error('Only HTTPS URLs are allowed');
    }

    // Validate against allowed domains
    const isAllowed = ALLOWED_EXTERNAL_DOMAINS.some(domain =>
      urlObj.hostname === domain || urlObj.hostname.endsWith('.' + domain)
    );

    if (!isAllowed) {
      throw new Error('Domain not allowed');
    }

    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('Error opening external URL:', error);
    return { success: false, error: error.message };
  }
});

// Microphone access denied: open the OS page where the user can allow it.
// Fixed URLs only (no renderer input), so shell:openExternal's domain
// allow-list does not need to admit OS settings schemes.
const MICROPHONE_SETTINGS_URLS = {
  darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  win32: 'ms-settings:privacy-microphone'
};
ipcMain.handle('system:openMicrophoneSettings', async () => {
  const url = MICROPHONE_SETTINGS_URLS[process.platform];
  if (!url) return { success: false, error: 'unsupported_platform' };
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    log.warn(`Could not open the microphone privacy settings: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Show a file in its parent folder in the OS file manager
ipcMain.handle('shell:showItemInFolder', async (event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Invalid file path' };
    }
    // Resolve relative paths against recordings directory
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(getRecordingsPath(), filePath);
    shell.showItemInFolder(resolvedPath);
    return { success: true };
  } catch (error) {
    console.error('Error showing item in folder:', error);
    return { success: false, error: error.message };
  }
});

// Native OS clipboard helper (writes reliably without window focus or active DOM gesture)
ipcMain.handle('clipboard:writeText', async (event, text) => {
  try {
    clipboard.writeText(typeof text === 'string' ? text : String(text || ''));
    return { success: true };
  } catch (error) {
    log.warn('Native clipboard write failed:', error.message);
    return { success: false, error: error.message };
  }
});

// --- History Management ---

// Get all recordings from history (filtered by userId)
ipcMain.handle('history:getAll', async (event, userId) => {
  try {
    const recordings = historyStore.get('recordings', []);
    const hydrated = hydrateHistoryCaptureWarnings(recordings, userId, getRecordingsPath());
    if (hydrated.some((recording, index) => recording !== recordings[index])) {
      try { historyStore.set('recordings', hydrated); }
      catch (error) { log.warn('Could not cache capture warnings in history:', error.message); }
    }
    // CRITICAL: Filter by userId to prevent cross-account data leaks
    const userRecordings = userId
      ? hydrated.filter(r => r.userId === userId)
      : [];
    // Sort by date, newest first
    return userRecordings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (error) {
    console.error('Error getting history:', error);
    return [];
  }
});

// Add recording to history
ipcMain.handle('history:add', async (event, recording) => {
  try {
    // CRITICAL: Validate userId to prevent cross-account data leaks and injection
    const validUserId = validateUserId(recording.userId);

    const recordings = historyStore.get('recordings', []);

    // Create history entry with userId
    const historyEntry = withCaptureWarnings({
      id: recording.id,
      userId: validUserId,  // CRITICAL: Associate with validated user
      createdAt: recording.createdAt || new Date().toISOString(),
      duration: recording.duration || 0,
      fileSize: recording.fileSize || 0,
      filePath: recording.filePath || '',
      uploadStatus: recording.uploadStatus || 'pending',  // pending, uploaded, failed
      storagePreference: recording.storagePreference || 'keep',
      transcriptionId: recording.transcriptionId || null,
      audioFileId: recording.audioFileId || null,
      captureWarnings: recording.captureWarnings
    }, getRecordingsPath());

    recordings.push(historyEntry);
    historyStore.set('recordings', recordings);

    return { success: true, recording: historyEntry };
  } catch (error) {
    console.error('Error adding to history:', error);
    return { success: false, error: error.message };
  }
});

// Update recording in history
ipcMain.handle('history:update', async (event, id, updates, userId) => {
  try {
    // CRITICAL: Validate userId to prevent cross-account modifications
    const validUserId = validateUserId(userId);

    const recordings = historyStore.get('recordings', []);
    const index = recordings.findIndex(r => r.id === id && r.userId === validUserId);

    if (index === -1) {
      return { success: false, error: 'Recording not found' };
    }

    // Don't allow changing userId
    const { userId: _, ...safeUpdates } = updates;
    recordings[index] = withCaptureWarnings({ ...recordings[index], ...safeUpdates }, getRecordingsPath(), recordings[index].captureWarnings);
    historyStore.set('recordings', recordings);

    return { success: true, recording: recordings[index] };
  } catch (error) {
    console.error('Error updating history:', error);
    return { success: false, error: error.message };
  }
});

// Delete recording from history (and optionally delete file)
ipcMain.handle('history:delete', async (event, id, deleteFile = false, userId) => {
  try {
    // CRITICAL: Validate userId to prevent cross-account deletions
    const validUserId = validateUserId(userId);

    const recordings = historyStore.get('recordings', []);
    const recording = recordings.find(r => r.id === id && r.userId === validUserId);

    if (!recording) {
      return { success: false, error: 'Recording not found' };
    }

    // P0 Data Loss Fix: Check file locks before deletion (V3)
    const lockedRecordings = activeRecordingStore.get('lockedRecordings', []);
    if (unsavedRecordingId === id || lockedRecordings.includes(id) || inFlightUploads.has(id) || recordingLocks.has(id) || (isRecordingInProgress && getActiveRecording()?.recordId === id)) {
      log.warn('history:delete blocked - recording is locked for upload:', id);
      return { success: false, error: 'Recording locked - upload in progress' };
    }

    // Delete the file if requested
    if (deleteFile) {
      try {
        // Delete the recording directory
        const recordingDir = getRecordingPath(validateRecordId(recording.id));
        if (fs.existsSync(recordingDir)) {
          await rmDirSafe(recordingDir);
        }
      } catch (e) {
        return { success: false, error: 'Could not delete recording files: ' + e.message };
      }
    }

    // Remove from history (only the user's recording)
    const newRecordings = recordings.filter(r => !(r.id === id && r.userId === validUserId));
    historyStore.set('recordings', newRecordings);

    return { success: true };
  } catch (error) {
    console.error('Error deleting from history:', error);
    return { success: false, error: error.message };
  }
});

// Delete ALL recordings for a user (irreversible!)
ipcMain.handle('history:deleteAll', async (event, userId) => {
  try {
    // CRITICAL: Validate userId to prevent cross-account deletions
    const validUserId = validateUserId(userId);

    const recordings = historyStore.get('recordings', []);
    const userRecordings = recordings.filter(r => r.userId === validUserId);

    // P0 Data Loss Fix: Get locked recordings to skip them (V3)
    const lockedRecordings = activeRecordingStore.get('lockedRecordings', []);

    let deletedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    const removed = new Set();

    // Delete all recording files for this user
    for (const recording of userRecordings) {
      // Skip locked recordings
      if (unsavedRecordingId === recording.id || lockedRecordings.includes(recording.id) || inFlightUploads.has(recording.id) || recordingLocks.has(recording.id) || (isRecordingInProgress && getActiveRecording()?.recordId === recording.id)) {
        log.warn('history:deleteAll skipping locked recording:', recording.id);
        skippedCount++;
        continue;
      }

      if (recording.filePath) {
        try {
          const recordingDir = path.dirname(recording.filePath);
          if (fs.existsSync(recordingDir)) {
            await rmDirSafe(recordingDir);
            deletedCount++;
          }
          removed.add(recording.id);
        } catch (e) {
          console.warn('Could not delete recording file:', recording.id, e);
          errorCount++;
        }
      }
    }

    // Remove all user's recordings from history (except locked ones)
    const newRecordings = recordings.filter(r =>
      r.userId !== validUserId || !removed.has(r.id)
    );
    historyStore.set('recordings', newRecordings);

    console.log(`Deleted ${deletedCount} recordings for user ${validUserId} (${errorCount} errors, ${skippedCount} skipped/locked)`);
    return {
      success: true,
      deletedCount,
      errorCount,
      skippedCount
    };
  } catch (error) {
    console.error('Error deleting all recordings:', error);
    return { success: false, error: error.message };
  }
});

// Get default storage preference
ipcMain.handle('history:getDefaultStoragePreference', async () => {
  return historyStore.get('defaultStoragePreference', 'keep');
});

// Set default storage preference
ipcMain.handle('history:setDefaultStoragePreference', async (event, preference) => {
  try {
    historyStore.set('defaultStoragePreference', preference);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// === P0 Data Loss Fix: Persistent file locks for upload safety (V6) ===

// Lock a recording for upload (persists to disk)
ipcMain.handle('recording:lockForUpload', async (event, recordId) => {
  try {
    const locked = activeRecordingStore.get('lockedRecordings', []);
    if (!locked.includes(recordId)) {
      locked.push(recordId);
      activeRecordingStore.set('lockedRecordings', locked);
    }
    log.info('Recording locked for upload:', recordId);
    return { success: true };
  } catch (error) {
    log.error('Error locking recording:', error);
    return { success: false, error: error.message };
  }
});

// Unlock a recording after upload (or on upload failure)
ipcMain.handle('recording:unlockAfterUpload', async (event, recordId) => {
  try {
    const locked = activeRecordingStore.get('lockedRecordings', []);
    const newLocked = locked.filter(id => id !== recordId);
    activeRecordingStore.set('lockedRecordings', newLocked);
    log.info('Recording unlocked after upload:', recordId);
    return { success: true };
  } catch (error) {
    log.error('Error unlocking recording:', error);
    return { success: false, error: error.message };
  }
});

// Get all locked recording IDs (for store restoration)
ipcMain.handle('recording:getLockedRecordings', async () => {
  return activeRecordingStore.get('lockedRecordings', []);
});

// Get file URL for playback (returns local-audio:// URL for custom protocol)
ipcMain.handle('recording:getFileUrl', async (event, filePath) => {
  try {
    // Validate file path is within allowed recordings directory
    const validPath = validateFilePath(filePath);

    // Check if file exists
    await fs.promises.access(validPath);

    // Use custom protocol for local audio files
    // Encode the path to handle special characters
    const encodedPath = encodeURIComponent(validPath);
    return {
      success: true,
      url: `local-audio://${encodedPath}`
    };
  } catch (error) {
    if (error.message.includes('outside allowed')) {
      log.warn('Security: Attempted to access file outside allowed directories:', filePath);
      Sentry.captureMessage(`Path traversal attempt: ${filePath}`, 'warning');
    }
    return { success: false, error: 'File not found or access denied' };
  }
});

// --- Dialog ---

// Open file dialog for selecting audio/video files
ipcMain.handle('dialog:openFile', async (event, options) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Audio or Video File',
      filters: options?.filters || [
        {
          name: 'Audio/Video Files',
          extensions: ['mp3', 'mp4', 'wav', 'm4a', 'webm', 'ogg', 'flac', 'aac', 'mov', 'm4v', 'mpeg', 'mpga', 'opus', 'oga', 'wma', 'amr', '3gp', 'avi', 'mkv']
        }
      ],
      properties: ['openFile']
    });

    if (result.canceled || !result.filePaths.length) {
      return { success: false, cancelled: true };
    }

    const filePath = result.filePaths[0];
    const stats = await fs.promises.stat(filePath);
    const filename = path.basename(filePath);

    // Try to get duration via ffprobe
    let duration = 0;
    try {
      const metadata = await getAudioMetadata(filePath);
      duration = safeParseDuration(metadata);
    } catch (e) {
      console.warn('Could not get audio duration:', e);
    }

    return {
      success: true,
      filePath,
      filename,
      fileSize: stats.size,
      duration
    };
  } catch (error) {
    console.error('Error opening file dialog:', error);
    return { success: false, error: error.message };
  }
});

function isExportRecoveryBusy(recordId) {
  return isRecordingInProgress || isProcessingRecording || !!unsavedRecordingId || !!activeAudioTee ||
    background.recovery.isRunning() || inFlightUploads.has(recordId) || activeRecordingStore.get('lockedRecordings', []).includes(recordId);
}

const exportRecording = createRecordingExporter({
  recordingsPath: getRecordingsPath, validateRecordId,
  getOwner: id => historyStore.get('recordings', []).find(recording => recording.id === id)?.userId,
  getCurrentUserId: async () => tokenUserId(await getAuthToken()), // Local identity works offline; no token refresh/network.
  isBusy: isExportRecoveryBusy, isLocked: id => recordingLocks.has(id), withRecordingLock,
  finalize: id => finalizeRecording(id, '.webm', 0, { recovery: true, exportRecovery: true }),
  repairHistory: (id, owner, result) => {
    const recordings = historyStore.get('recordings', []);
    const index = recordings.findIndex(recording => recording.id === id && recording.userId === owner);
    if (index < 0) return null;
    recordings[index] = withCaptureWarnings(repairRecoveredHistoryRecord(recordings[index], result), getRecordingsPath());
    historyStore.set('recordings', recordings);
    return recordings[index];
  },
  saveAs: async (source, suggestedName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Audio',
      defaultPath: suggestedName || path.basename(source),
      filters: [
        { name: 'Audio', extensions: ['webm', 'm4a', 'mp3', 'opus', 'ogg', 'wav', 'aac'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }

    await fs.promises.copyFile(source, result.filePath);
    return { success: true, savedPath: result.filePath };
  }
});
ipcMain.handle('dialog:saveFile', (event, srcPath, suggestedName) => exportRecording(srcPath, suggestedName));

// Handle dropped file - get file info from path
ipcMain.handle('dialog:getDroppedFilePath', async (event, filePath) => {
  try {
    const stats = await fs.promises.stat(filePath);
    const filename = path.basename(filePath);

    // Try to get duration via ffprobe
    let duration = 0;
    try {
      const metadata = await getAudioMetadata(filePath);
      duration = safeParseDuration(metadata);
    } catch (e) {
      console.warn('Could not get audio duration:', e);
    }

    return {
      success: true,
      filePath,
      filename,
      fileSize: stats.size,
      duration
    };
  } catch (error) {
    console.error('Error processing dropped file:', error);
    return { success: false, error: error.message };
  }
});

// --- System Audio (AudioTee — macOS 14.2+ Core Audio Taps; sysloopback — Windows) ---

let activeAudioTee = null; // { process, writeStream, filePath, recordId }
// Set when AudioTee was stopped by the system-suspend handler; consumed by the
// resume notification so the renderer can reflect that system audio is off.
let audioTeeStoppedBySuspend = false;

function getAudioTeeBinaryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'audiotee', 'audiotee');
  }
  // Development: use from resources directly
  return path.join(__dirname, '..', 'resources', 'audiotee', 'audiotee');
}

// Windows: the native helper (every app except ours, on every output device).
// Without it the renderer falls back to desktopCapturer, which only hears the
// default output device.
function getSysLoopbackBinaryPath() {
  if (process.platform !== 'win32') return null;
  return resolveSysLoopbackPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    startDirs: [__dirname, app.getAppPath(), process.cwd()],
  });
}

// The capture runs in main (AudioTee/sysloopback → system_audio.raw) rather
// than as a renderer MediaStream.
function usesNativeSystemAudio() {
  if (process.platform === 'darwin') return isSystemAudioSupported();
  // Test builds only: s14 qualifies the desktopCapturer fallback on purpose.
  if (process.env.SUISSE_E2E_HOOKS === '1' && process.env.SUISSE_E2E_SYSTEM_AUDIO_FALLBACK === '1') return false;
  return process.platform === 'win32' && !!getSysLoopbackBinaryPath();
}

function isSystemAudioSupported() {
  // Windows: the native helper, or desktopCapturer as the fallback
  if (process.platform === 'win32') return true;
  // macOS: Core Audio Taps requires macOS 14.2+
  if (process.platform === 'darwin') {
    const ver = process.getSystemVersion?.() || '';
    const [major, minor] = ver.split('.').map(Number);
    return major > 14 || (major === 14 && minor >= 2);
  }
  return false;
}

// Check if system audio capture is supported on this machine
ipcMain.handle('systemAudio:isSupported', () => {
  return {
    supported: isSystemAudioSupported(),
    platform: process.platform,
    macVersion: process.getSystemVersion?.() || 'unknown',
    nativeCapture: usesNativeSystemAudio()
  };
});

// Start system audio capture — writes PCM to file alongside recording chunks.
// offsetMs is the position on the recording timeline (in milliseconds) at which
// this capture begins. When the user toggles system audio mid-recording, we pad
// the PCM file with leading silence so amix at stop-time aligns the captured
// audio with the mic track. Subsequent toggles within the same recording append
// to the existing file with silence padding for the off-gap.
let audioTeeLifecycle = Promise.resolve();
function serializeAudioTee(operation) {
  const current = audioTeeLifecycle.then(operation, operation);
  audioTeeLifecycle = current.catch(() => {});
  return current;
}

ipcMain.handle('systemAudio:start', (event, recordId, offsetMs = 0) => serializeAudioTee(async () => {
  let evidencePath, attemptId;
  const requestStartedAt = require('perf_hooks').performance.now();
  const requestedAt = new Date().toISOString();
  try {
    validateRecordId(recordId);
    await stopSystemAudioInternal();
    const windows = process.platform === 'win32';
    if (!windows && (process.platform !== 'darwin' || !isSystemAudioSupported())) return { success: false, error: 'System audio requires macOS 14.2+' };
    const binaryPath = windows ? getSysLoopbackBinaryPath() : getAudioTeeBinaryPath();
    if (!binaryPath || !fs.existsSync(binaryPath)) return { success: false, error: windows ? 'System audio helper not found' : 'AudioTee binary not found' };
    const recordPath = getRecordingPath(recordId);
    fs.mkdirSync(recordPath, { recursive: true });
    const activeOffsetMs = Math.min(7 * 24 * 3600000, Math.max(0, Number(offsetMs) || 0));
    attemptId = require('crypto').randomUUID();
    await pcmCaptureEvidence.beginPcmAttempt(recordPath, { attemptId, required: true,
      requestOffsetMs: activeOffsetMs, requestedAt });
    evidencePath = recordPath;
    const monitor = createSystemAudioMonitor({ isRecording: () => isRecordingInProgress && !activeAudioTee?.paused });
    monitor.reset(Date.now());
    const report = verdict => {
      if (!verdict) return;
      if (mainWindow && !mainWindow.isDestroyed()) sendToRenderer('system:capture-warning', {
        kind: verdict === 'warn' ? 'system-audio-silent' : 'system-audio-restored',
        recordId, silentSeconds: monitor.state(Date.now()).silentSeconds, platform: process.platform,
      });
    };
    // The Record page's system-audio meter: what the capture really hears, live.
    const sendLevel = level => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendToRenderer('systemAudio:level', { recordId, percent: meterPercent(level.rms) });
      }
    };
    const levelMeter = createLevelMeter({ intervalMs: 150, onLevel: sendLevel });
    // Test builds only: hosted CI's virtual sound card cannot be looped back by device,
    // so the CI call is captured per process there (see windows-system-audio.js).
    const loopbackMode = process.env.SUISSE_E2E_HOOKS === '1' && process.env.SUISSE_E2E_SYSLOOPBACK_MODE === 'process'
      ? 'process' : 'devices';
    const proc = windows
      ? require('child_process').spawn(binaryPath, sysLoopbackArgs(process.pid, loopbackMode), { windowsHide: true })
      : require('child_process').spawn(binaryPath, ['--sample-rate', '48000', '--chunk-duration', '0.2']);
    // A helper that already exited makes a stop line fail with EPIPE; that must
    // never become an uncaught error in main.
    proc.stdin?.on('error', () => {});
    const capture = createPcmCapture({
      process: proc,
      filePath: path.join(recordPath, 'system_audio.raw'),
      offsetMs: activeOffsetMs, requestStartedAt,
      // The Windows helper ends on a "stop" line and flushes its last packet;
      // TerminateProcess (what SIGTERM is on Windows) would drop it.
      requestStop: windows ? () => proc.stdin.end('stop\n') : null,
      onEvent: event => {
        const line = describeHelperEvent(event);
        if (line) log.info(`System audio helper: ${line}`);
      },
      evidence: {
        event: (name, details) => pcmCaptureEvidence.markPcmEvent(recordPath, attemptId, {
          event: name, elapsedMs: details.elapsedMs, activeOffsetMs: details.activeOffsetMs,
          ...(name === 'first-data' ? { byteLength: details.byteLength } : {}),
        }),
        failure: (error, details) => pcmCaptureEvidence.recordPcmFailure(recordPath, attemptId, {
          stage: String(details.stage || 'capture').replace(/\p{Cc}/gu, ' ').slice(0, 64), code: String(error.code || '').replace(/\p{Cc}/gu, ' ').slice(0, 64),
          message: String(error.message || error).replace(/\p{Cc}/gu, ' ').slice(0, 1000), elapsedMs: details.elapsedMs,
        }),
        finish: details => pcmCaptureEvidence.endPcmAttempt(recordPath, attemptId, {
          success: details.success, childClosed: details.childClosed, diskDrained: details.diskDrained,
          endOffsetMs: details.endOffsetMs, elapsedMs: details.elapsedMs, reason: details.reason,
        }),
      },
      onData: bytes => {
        levelMeter.push(bytes, Date.now());
        report(monitor.handleChunk(bytes, Date.now()));
      },
      onFailure: error => {
        log.error('System audio capture failed:', error.message);
        recordCaptureWarning(recordId, 'system-audio-interrupted');
        if (mainWindow && !mainWindow.isDestroyed()) sendToRenderer('system:capture-warning', { kind: 'system-audio-interrupted', recordId });
        capture.stop().catch(err => log.warn('System audio cleanup failed:', err.message));
      },
      onClosed: () => {
        clearInterval(capture.silenceTimer);
        levelMeter.reset(Date.now());
        if (activeAudioTee === capture) activeAudioTee = null;
      },
    });
    capture.recordId = recordId;
    capture.silenceTimer = setInterval(() => {
      if (!capture.paused) report(monitor.tick(Date.now()));
    }, 1000);
    activeAudioTee = capture;
    const result = await capture.started;
    if (!result.success) await stopSystemAudioInternal();
    return result;
  } catch (error) {
    if (evidencePath && attemptId) {
      await pcmCaptureEvidence.recordPcmFailure(evidencePath, attemptId, {
        stage: 'startup', code: String(error.code || '').replace(/\p{Cc}/gu, ' ').slice(0, 64),
        message: String(error.message || error).replace(/\p{Cc}/gu, ' ').slice(0, 1000),
        elapsedMs: Math.max(0, require('perf_hooks').performance.now() - requestStartedAt),
      }).catch(failure => log.error('Could not persist system audio startup failure:', failure.message));
    }
    return { success: false, error: error.message };
  }
}));

// Windows: which apps use each microphone and output device right now. The
// Record page uses it to record the microphone the meeting app is using.
// Best effort and quiet: info only, never a Sentry event.
ipcMain.handle('systemAudio:deviceSessions', async () => {
  const binaryPath = getSysLoopbackBinaryPath();
  if (!binaryPath) return { success: false, devices: [] };
  try {
    const stdout = await new Promise((resolve, reject) => {
      require('child_process').execFile(binaryPath, ['--sessions'],
        { timeout: 4000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (error, out) => (error ? reject(error) : resolve(out)));
    });
    return { success: true, devices: parseDeviceSessions(stdout, { ownApp: path.parse(process.execPath).name }) };
  } catch (error) {
    log.info('Audio device sessions could not be read:', error.message);
    return { success: false, devices: [] };
  }
});

ipcMain.handle('systemAudio:setPaused', (event, paused) => {
  activeAudioTee?.setPaused(paused);
  return { success: true };
});
ipcMain.handle('systemAudio:stop', () => stopSystemAudio());
function stopSystemAudio() {
  return serializeAudioTee(stopSystemAudioInternal);
}
async function stopSystemAudioInternal() {
  const capture = activeAudioTee;
  if (!capture) return { success: true };
  clearInterval(capture.silenceTimer);
  const result = await capture.stop();
  if (activeAudioTee === capture) activeAudioTee = null;
  return result;
}

// Get available desktop capturer sources (used on Windows for system audio).
// Only SCREEN sources carry loopback (system) audio on Windows — window sources
// yield a video-only capture with no audio track — so we fetch screens only and
// log what we found. Silent "no system audio" reports were previously impossible
// to diagnose because this path never logged anything to main.log.
ipcMain.handle('systemAudio:getSources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      fetchWindowIcons: false
    });
    log.info(`System audio: desktopCapturer returned ${sources.length} screen source(s): ${sources.map(s => s.id).join(', ') || '(none)'}`);
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (error) {
    log.error('Error getting desktop sources for system audio:', error);
    return [];
  }
});

// Renderer-side system-audio diagnostics bridge. The Windows capture path runs
// entirely in the renderer (getUserMedia loopback), so its failures never reached
// main.log — making "system audio doesn't work" undiagnosable. Route them here.
ipcMain.handle('systemAudio:diag', (event, level, message) => {
  const line = `System audio (renderer): ${message}`;
  if (level === 'error') log.error(line);
  else if (level === 'warn') log.warn(line);
  else log.info(line);
  return { success: true };
});
ipcMain.handle('systemAudio:checkPermission', () => {
  if (isSystemAudioSupported()) return 'granted';
  if (process.platform === 'darwin') return systemPreferences.getMediaAccessStatus('screen');
  return 'granted';
});
// Return the PERSISTED preference. This handler used to return a hard-coded
// `false`, so the toggle read back OFF on every launch no matter what the user
// had chosen (the setter below persisted it correctly — only the getter lied).
// Users who had switched system audio on saw it silently reset each session.
ipcMain.handle('config:getSystemAudioEnabled', () => configStore.get('systemAudioEnabled', false));
ipcMain.handle('config:setSystemAudioEnabled', (event, enabled) => {
  configStore.set('systemAudioEnabled', enabled);
  return { success: true };
});

// --- Window Controls ---
ipcMain.handle('window:toggleMaximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return { isMaximized: mainWindow.isMaximized() };
  }
  return { isMaximized: false };
});

ipcMain.handle('window:isMaximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.handle('window:toggleFullscreen', () => {
  if (mainWindow) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return { isFullscreen: mainWindow.isFullScreen() };
  }
  return { isFullscreen: false };
});

ipcMain.handle('window:isFullscreen', () => {
  return mainWindow ? mainWindow.isFullScreen() : false;
});

// --- Transcription Settings ---

ipcMain.handle('config:getTranscriptionSettings', () => {
  return configStore.get('transcriptionSettings', {
    vocabulary: [],
    defaultSpeakerCount: null
  });
});

ipcMain.handle('config:setTranscriptionSettings', (event, settings) => {
  configStore.set('transcriptionSettings', settings);
  return { success: true };
});

// --- System: Get Recordings Path ---
ipcMain.handle('system:getRecordingsPath', () => {
  return { path: getRecordingsPath() };
});
