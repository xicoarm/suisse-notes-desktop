const { app, BrowserWindow, ipcMain, safeStorage, protocol, shell, dialog, Menu, Tray, nativeImage, desktopCapturer, systemPreferences, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const axios = require('axios');
const Store = require('electron-store');
const ffmpeg = require('fluent-ffmpeg');
const { Upload } = require('tus-js-client');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const Sentry = require('@sentry/electron/main');
const { machineIdSync } = require('node-machine-id');
const { uploadViaPresignedSas, abortDirectUpload } = require('./upload-direct');

// Trust the OS certificate store from the main process. Must run before any
// outbound HTTPS (auto-update, uploads, Sentry) so corporate / TLS-inspection
// roots are honoured. See os-ca.js for the full rationale.
require('./os-ca').installOsTrustStore();

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
  'ENETUNREACH',    // no route to host
  'EAI_AGAIN'       // transient DNS failure
]);
const TRANSIENT_NETWORK_STATUSES = new Set([408]); // Request Timeout — server gave up waiting for client

function isTransientNetworkError(err, message) {
  if (err && TRANSIENT_NETWORK_CODES.has(err.code)) return true;
  if (err?.response?.status && TRANSIENT_NETWORK_STATUSES.has(err.response.status)) return true;
  if (typeof message === 'string') {
    if (/socket hang up/i.test(message)) return true;
    if (/network error/i.test(message)) return true;
    if (/getaddrinfo/i.test(message)) return true;
  }
  return false;
}

Sentry.init({
  dsn: 'https://185912b1585eb5138079ae189a6d41ec@o4510659364716544.ingest.de.sentry.io/4510659366748240',
  environment: app.isPackaged ? 'production' : 'development',
  release: `suisse-notes@${app.getVersion()}`,
  beforeSend(event, hint) {
    // Scrub sensitive data from error reports
    if (event.request?.headers?.authorization) {
      event.request.headers.authorization = '[REDACTED]';
    }
    // Filter out read-only volume errors — handled via UX (move-to-Applications dialog)
    const message = event.exception?.values?.[0]?.value || '';
    if (message.includes('read-only volume') || (message.includes('read-only') && message.includes('move the application'))) {
      return null;
    }
    // Downgrade client-transient network errors to 'warning' so alert rules
    // scoped to error level stop paging on user WiFi drops.
    if (isTransientNetworkError(hint?.originalException, message)) {
      event.level = 'warning';
      event.tags = { ...(event.tags || {}), transient_network: 'true' };
    }
    return event;
  }
});

// === Global Error Handlers ===
// Catch uncaught exceptions in main process
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error);
  Sentry.captureException(error);
  // Don't exit immediately - try to keep app running for upload completion
});

process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message || String(reason);
  // electron-updater's SimpleURLLoaderWrapper leaks unhandled rejections when
  // a download chunk fails mid-transfer (network flicker, VPN reconnect,
  // sleep/wake). The updater retries internally and surfaces a real failure
  // via autoUpdater.on('error') if it gives up — so this rejection is noise.
  if (/net::ERR_NETWORK_CHANGED|net::ERR_NETWORK_IO_SUSPENDED|net::ERR_INTERNET_DISCONNECTED/i.test(msg)) {
    log.warn('Suppressed transient net:: rejection (likely auto-updater during network change):', msg);
    return;
  }
  log.error('Unhandled Rejection at:', promise, 'reason:', reason);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

// Handle renderer process crashes
app.on('render-process-gone', (event, webContents, details) => {
  log.error('Renderer process gone:', details);
  Sentry.captureMessage(`Renderer crashed: ${details.reason}`, 'error');

  // P0 Data Loss Fix: Write crash metadata for active recording (V8)
  // Do NOT clear active recording state - let recoverOrphanedRecordings find it on next launch
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
  log.error('Child process gone:', details);
  Sentry.captureMessage(`Child process crashed: ${details.reason}`, 'error');

  // Detect Audio Service crash (macOS ScreenCaptureKit bug) and notify renderer to recover
  if (details.serviceName === 'audio.mojom.AudioService' && details.reason === 'crashed') {
    log.warn('Audio Service crashed — notifying renderer to recover system audio');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:audio-service-crashed', {
        reason: details.reason,
        exitCode: details.exitCode
      });
    }
  }
});

// === SSO Custom Protocol (suissenotes://) ===
// The system browser hits /api/auth/microsoft/login?client=desktop; the backend
// callback redirects to suissenotes://auth/callback?token=...&user=<b64>. The
// OS routes that URL to this app via either argv (Win/Linux) or 'open-url' (Mac).
const SSO_PROTOCOL = 'suissenotes';

if (process.defaultApp) {
  // Dev mode: pass execPath + script path so the OS knows how to relaunch us
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(SSO_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(SSO_PROTOCOL);
}

let pendingSSOPayload = null;

function handleSSOUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith(`${SSO_PROTOCOL}://`)) return;
  let payload;
  try {
    const parsed = new URL(url);
    if (parsed.host !== 'auth' || parsed.pathname.replace(/\/$/, '') !== '/callback') {
      log.warn('SSO: ignoring unknown URL path:', url);
      return;
    }
    const error = parsed.searchParams.get('error');
    const token = parsed.searchParams.get('token');
    const userB64 = parsed.searchParams.get('user');
    if (error) {
      payload = { error };
    } else if (token && userB64) {
      const userJson = Buffer.from(userB64, 'base64url').toString('utf8');
      payload = { token, user: JSON.parse(userJson) };
    } else {
      payload = { error: 'invalid_callback' };
    }
  } catch (e) {
    log.error('SSO: failed to parse callback URL', e.message);
    payload = { error: 'invalid_callback' };
  }

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('auth:ssoCallback', payload);
  } else {
    // App was launched (or relaunched) by the URL — buffer until window exists
    pendingSSOPayload = payload;
  }
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
    if (ssoUrl) handleSSOUrl(ssoUrl);
  });
}

// macOS deep-link handoff
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleSSOUrl(url);
});

// Cold-start case (Win/Linux): URL is in our own argv
{
  const ssoUrl = process.argv.find(a => typeof a === 'string' && a.startsWith(`${SSO_PROTOCOL}://`));
  if (ssoUrl) handleSSOUrl(ssoUrl);
}

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

// Environment-aware API configuration
// Uses config.js for environment detection
const { getApiUrl, getEnvironmentInfo } = require('./config');
const API_BASE_URL = getApiUrl();
log.info('Environment:', getEnvironmentInfo());

// Disk space utilities for recording safety
const { canStartRecording, shouldForceStopRecording, formatBytes } = require('./disk-utils');

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

// Restore Sentry user context from stored session (so crash reports identify the user)
try {
  const storedUser = configStore.get('userInfo');
  if (storedUser) {
    Sentry.setUser({ id: storedUser.id, email: storedUser.email });
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
// Add upload to persistent queue
function addToUploadQueue(recordId, filePath, metadata) {
  const queue = uploadQueueStore.get('pendingUploads', []);
  // Check if already in queue
  if (!queue.find(u => u.recordId === recordId)) {
    queue.push({
      recordId,
      filePath,
      metadata,
      addedAt: new Date().toISOString(),
      retryCount: 0
    });
    uploadQueueStore.set('pendingUploads', queue);
    log.info('Added to upload queue:', recordId);
  }
}

// Remove upload from queue
function removeFromUploadQueue(recordId) {
  const queue = uploadQueueStore.get('pendingUploads', []);
  const newQueue = queue.filter(u => u.recordId !== recordId);
  uploadQueueStore.set('pendingUploads', newQueue);
  log.info('Removed from upload queue:', recordId);
}

// Update retry count in queue
function updateUploadQueueRetry(recordId) {
  const queue = uploadQueueStore.get('pendingUploads', []);
  const item = queue.find(u => u.recordId === recordId);
  if (item) {
    item.retryCount = (item.retryCount || 0) + 1;
    item.lastRetry = new Date().toISOString();
    uploadQueueStore.set('pendingUploads', queue);
  }
}

// === Auto-Recovery for Orphaned Recordings ===
// Recover recordings that were interrupted by app crash
let isRecoveryRunning = false;

async function recoverOrphanedRecordings() {
  if (isRecoveryRunning) {
    log.warn('Recovery already in progress, skipping');
    return;
  }
  isRecoveryRunning = true;

  try {
    const recordingsPath = getRecordingsPath();
    if (!fs.existsSync(recordingsPath)) {
      log.info('No recordings directory found, skipping recovery');
      clearActiveRecording();
      return;
    }

    // Check if there's an active recording that was interrupted
    const activeSession = getActiveRecording();
    if (activeSession) {
      log.info('Found interrupted recording session:', activeSession.recordId);
    }

    // Scan for directories with chunks that don't have a combined audio file
    const dirs = fs.readdirSync(recordingsPath);
    let recoveredCount = 0;
    let totalAttempted = 0;
    let skippedLive = false;

    for (const dir of dirs) {
      try {
        const dirPath = path.join(recordingsPath, dir);
        const stats = fs.statSync(dirPath);

        if (!stats.isDirectory()) continue;

        const chunksPath = path.join(dirPath, 'chunks');
        const sessionsPath = path.join(dirPath, 'sessions');
        const audioPath = path.join(dirPath, 'audio.webm');

        // Skip if already has a combined audio file
        if (fs.existsSync(audioPath)) continue;

        // Check if there are chunks or sessions to recover
        const chunkFiles = fs.existsSync(chunksPath)
          ? fs.readdirSync(chunksPath).filter(f => f.startsWith('chunk_'))
          : [];
        const hasChunks = chunkFiles.length > 0;
        const hasSessions = fs.existsSync(sessionsPath) &&
          fs.readdirSync(sessionsPath).filter(f => f.endsWith('.webm') && !f.includes('_raw')).length > 0;

        if (!hasChunks && !hasSessions) continue;

        // Never touch a recording that is being written RIGHT NOW. This scan
        // runs ~5s after launch — a recording started inside that window
        // matches the "chunks but no audio.webm" predicate, and recovering it
        // would combine and DELETE its live chunks mid-recording.
        if (isRecordingInProgress && getActiveRecording()?.recordId === dir) {
          log.info(`Recovery: skipping ${dir} — recording is live`);
          skippedLive = true;
          continue;
        }
        // Freshness backstop in case active-session tracking is stale: a chunk
        // written within the last 60s means a recorder is (or was just)
        // writing here — leave it for the next launch.
        if (hasChunks) {
          try {
            const newestChunk = chunkFiles.reduce((best, f) => {
              const n = parseInt(f.replace('chunk_', ''), 10);
              return Number.isFinite(n) && n > best.n ? { n, f } : best;
            }, { n: -1, f: null });
            if (newestChunk.f) {
              const ageMs = Date.now() - fs.statSync(path.join(chunksPath, newestChunk.f)).mtimeMs;
              if (ageMs < 60000) {
                log.info(`Recovery: skipping ${dir} — chunks still being written (${Math.round(ageMs / 1000)}s old)`);
                skippedLive = true;
                continue;
              }
            }
          } catch (e) {
            log.warn(`Recovery: freshness check failed for ${dir}:`, e.message);
          }
        }

        totalAttempted++;
        log.info(`Attempting to recover orphaned recording: ${dir}`);

        // Try to combine the chunks
        const result = await combineChunksForRecovery(dir);

        if (result.success) {
          recoveredCount++;
          log.info(`Successfully recovered recording: ${dir} (${result.fileSizeMb}MB)`);

          // Add to history with "recovered" status
          // Try to read userId from metadata.json first, then fall back to activeSession or 'unknown'
          const recordings = historyStore.get('recordings', []);
          const existingRecording = recordings.find(r => r.id === dir);

          if (!existingRecording) {
            // Try to read metadata.json to get userId and other info
            let metadataUserId = null;
            let metadataStartedAt = null;
            let metadataDuration = 0;
            const metadataPath = path.join(dirPath, 'metadata.json');

            if (fs.existsSync(metadataPath)) {
              try {
                const metadataContent = fs.readFileSync(metadataPath, 'utf8');
                const metadata = JSON.parse(metadataContent);
                metadataUserId = metadata.userId;
                metadataStartedAt = metadata.startedAt;
                metadataDuration = metadata.duration || 0;
                log.info(`Read metadata.json for ${dir}: userId=${metadataUserId}, startedAt=${metadataStartedAt}`);
              } catch (e) {
                log.warn(`Could not read metadata.json for ${dir}:`, e.message);
              }
            }

            // Determine userId: prefer metadata, then activeSession, then 'unknown'
            const userId = metadataUserId || activeSession?.userId || 'unknown';
            const createdAt = metadataStartedAt || activeSession?.startedAt || new Date().toISOString();

            // Create a new history entry for the recovered recording
            const recoveredEntry = {
              id: dir,
              userId: userId,
              createdAt: createdAt,
              duration: metadataDuration, // Use duration from metadata if available
              fileSize: parseFloat(result.fileSizeMb) * 1024 * 1024,
              filePath: result.outputPath,
              uploadStatus: 'pending',
              storagePreference: 'keep',
              recovered: true // Mark as recovered
            };
            recordings.push(recoveredEntry);
            historyStore.set('recordings', recordings);
            log.info(`Added recovered recording to history: ${dir} (userId: ${userId})`);
          }
        } else {
          log.warn(`Could not recover recording ${dir}: ${result.error}`);
        }
      } catch (err) {
        log.error(`Error processing directory ${dir} for recovery:`, err);
      }
    }

    // Only clear active recording state if recovery succeeded or there was nothing to recover.
    // If all attempts failed, preserve state so next startup retries.
    if (skippedLive) {
      // The active session belongs to a recording that is live (or freshly
      // written) right now — leave its crash-recovery state untouched.
    } else if (totalAttempted === 0 || recoveredCount > 0) {
      clearActiveRecording();
    } else {
      // Track failed recovery attempts to avoid infinite retries
      const attempts = (activeSession?.recoveryAttempts || 0) + 1;
      if (attempts >= 3) {
        log.error(`Recovery failed ${attempts} times, giving up on active recording`);
        Sentry.captureMessage(`Recording recovery failed after ${attempts} attempts`, 'error');
        clearActiveRecording();
      } else if (activeSession) {
        activeRecordingStore.set('activeSession', { ...activeSession, recoveryAttempts: attempts });
        log.warn(`Recovery failed (attempt ${attempts}/3), will retry on next startup`);
      }
    }

    if (recoveredCount > 0) {
      log.info(`Recovery complete: ${recoveredCount} recording(s) recovered`);
    }
  } catch (error) {
    log.error('Error during orphaned recording recovery:', error);
    Sentry.captureException(error);
  } finally {
    isRecoveryRunning = false;
  }
}

// Expose recovery state to renderer so it can wait before starting a new recording
ipcMain.handle('recording:isRecoveryRunning', () => isRecoveryRunning);

// Internal function for recovery - similar to combineChunks but without IPC
async function combineChunksForRecovery(recordId) {
  try {
    const recordPath = getRecordingPath(recordId);
    const chunksPath = getChunksPath(recordId);
    const sessionsPath = getSessionsPath(recordId);
    const outputPath = path.join(recordPath, 'audio.webm');

    // First try to create session from chunks if they exist
    if (fs.existsSync(chunksPath)) {
      const chunks = fs.readdirSync(chunksPath)
        .filter(f => f.startsWith('chunk_') && f.endsWith('.webm'));

      if (chunks.length > 0) {
        const result = await createSessionFileInternal(recordId, '.webm');
        if (!result.success) {
          log.warn('Could not create session from chunks during recovery:', result.error);
        }
      }
    }

    // Then check for sessions
    if (fs.existsSync(sessionsPath)) {
      const sessions = fs.readdirSync(sessionsPath)
        .filter(f => f.endsWith('.webm') && !f.includes('_raw'));

      if (sessions.length === 1) {
        fs.copyFileSync(path.join(sessionsPath, sessions[0]), outputPath);

        // P0 Data Loss Fix: Validate output BEFORE deleting sources
        const validation = validateAudioOutput(outputPath);
        if (!validation.valid) {
          log.error('Recovery: Output validation failed after single session copy:', validation.error);
          try { fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
          return { success: false, error: `Output validation failed: ${validation.error}` };
        }

        await rmDirSafeBestEffort(sessionsPath, 'recovery-single');
        if (fs.existsSync(chunksPath)) {
          await rmDirSafeBestEffort(chunksPath, 'recovery-single');
        }

        return {
          success: true,
          outputPath,
          fileSizeMb: (validation.size / (1024 * 1024)).toFixed(2)
        };
      } else if (sessions.length > 1) {
        // Multiple sessions - use FFmpeg concat
        const sortedSessions = sessions.sort((a, b) => {
          const tsA = parseInt(a.replace('session_', '').replace('.webm', ''), 10);
          const tsB = parseInt(b.replace('session_', '').replace('.webm', ''), 10);
          return tsA - tsB;
        });

        const concatListPath = path.join(recordPath, 'concat_list.txt');
        const listContent = sortedSessions.map(f =>
          `file '${sessionsPath.replace(/\\/g, '/')}/${f}'`
        ).join('\n');
        fs.writeFileSync(concatListPath, listContent);

        await ffmpegWithTimeout(
          ffmpeg()
            .input(concatListPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .audioCodec('copy')
            .output(outputPath),
          FFMPEG_TIMEOUT_MS,
          'Recovery concat sessions'
        );

        fs.unlinkSync(concatListPath);

        // P0 Data Loss Fix: Validate output BEFORE deleting sources
        const concatValidation = validateAudioOutput(outputPath);
        if (!concatValidation.valid) {
          log.error('Recovery: Output validation failed after multi-session concat:', concatValidation.error);
          try { fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
          return { success: false, error: `Output validation failed: ${concatValidation.error}` };
        }

        await rmDirSafeBestEffort(sessionsPath, 'recovery-multi');
        if (fs.existsSync(chunksPath)) {
          await rmDirSafeBestEffort(chunksPath, 'recovery-multi');
        }

        return {
          success: true,
          outputPath,
          fileSizeMb: (concatValidation.size / (1024 * 1024)).toFixed(2)
        };
      }
    }

    // Fallback: direct chunk concatenation
    if (fs.existsSync(chunksPath)) {
      const chunks = fs.readdirSync(chunksPath)
        .filter(f => f.startsWith('chunk_') && f.endsWith('.webm'));

      if (chunks.length > 0) {
        const sortedChunks = sortChunksNumerically(chunks, '.webm');
        await combineChunksStreaming(chunksPath, sortedChunks, outputPath);

        // P0 Data Loss Fix: Validate output BEFORE deleting sources
        const fallbackValidation = validateAudioOutput(outputPath);
        if (!fallbackValidation.valid) {
          log.error('Recovery: Output validation failed after direct concatenation:', fallbackValidation.error);
          try { fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
          return { success: false, error: `Output validation failed: ${fallbackValidation.error}` };
        }

        await rmDirSafeBestEffort(chunksPath, 'recovery-direct');

        return {
          success: true,
          outputPath,
          fileSizeMb: (fallbackValidation.size / (1024 * 1024)).toFixed(2)
        };
      }
    }

    return { success: false, error: 'No chunks or sessions found' };
  } catch (error) {
    log.error('Error in combineChunksForRecovery:', error);
    return { success: false, error: error.message };
  }
}

// === Cleanup Old Orphaned Directories ===
// Remove directories that are older than 7 days and have no audio file

async function cleanupOldOrphanedDirectories() {
  try {
    const recordingsPath = getRecordingsPath();
    if (!fs.existsSync(recordingsPath)) {
      return;
    }

    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();
    let cleanedCount = 0;

    const dirs = fs.readdirSync(recordingsPath);
    for (const dir of dirs) {
      try {
        const dirPath = path.join(recordingsPath, dir);
        const stats = fs.statSync(dirPath);

        if (!stats.isDirectory()) continue;

        // Check if this directory has a combined audio file
        const audioPath = path.join(dirPath, 'audio.webm');
        const hasAudioFile = fs.existsSync(audioPath);

        // Check if directory is old enough
        const isOld = (now - stats.mtimeMs) > MAX_AGE_MS;

        // Only clean up old directories without audio files
        if (isOld && !hasAudioFile) {
          // Check if it has chunks or sessions that weren't combined
          const chunksPath = path.join(dirPath, 'chunks');
          const sessionsPath = path.join(dirPath, 'sessions');
          const hasChunks = fs.existsSync(chunksPath);
          const hasSessions = fs.existsSync(sessionsPath);

          if (hasChunks || hasSessions) {
            // Check if there are actual chunk files (user's audio data)
            const chunkFiles = hasChunks ? fs.readdirSync(chunksPath).filter(f => f.startsWith('chunk_')) : [];
            const sessionFiles = hasSessions ? fs.readdirSync(sessionsPath).filter(f => f.endsWith('.webm')) : [];
            if (chunkFiles.length > 0 || sessionFiles.length > 0) {
              // NEVER delete directories with audio data — user might still want it
              log.warn(`Keeping old orphaned directory with ${chunkFiles.length} chunks, ${sessionFiles.length} sessions: ${dir}`);
            } else {
              // Empty chunks/sessions dirs — safe to clean up
              log.info(`Cleaning up old empty orphaned directory: ${dir}`);
              await rmDirSafeBestEffort(dirPath, 'recovery-orphans');
              cleanedCount++;
            }
          }
        }
      } catch (err) {
        log.error(`Error checking directory ${dir} for cleanup:`, err);
      }
    }

    if (cleanedCount > 0) {
      log.info(`Cleaned up ${cleanedCount} old orphaned directory(ies)`);
    }
  } catch (error) {
    log.error('Error during orphaned directory cleanup:', error);
  }
}

// Process pending uploads on app startup or after login
let isProcessingUploads = false;

async function processPendingUploads() {
  if (isProcessingUploads) {
    log.info('Upload processing already in progress, skipping');
    return;
  }
  isProcessingUploads = true;

  try {
  const queue = uploadQueueStore.get('pendingUploads', []);
  if (queue.length === 0) return;

  log.info(`Found ${queue.length} pending uploads, processing...`);

  // Check if we have auth token
  const authToken = await getAuthToken();
  if (!authToken) {
    log.info('No auth token, skipping pending uploads');
    return;
  }

  // Process each pending upload with delay between them
  for (const upload of queue) {
    // Skip if too many retries (max 10)
    if (upload.retryCount >= 10) {
      log.warn(`Upload ${upload.recordId} exceeded max retries, removing from queue`);
      removeFromUploadQueue(upload.recordId);
      continue;
    }

    // Check if file still exists
    try {
      await fs.promises.access(upload.filePath);
    } catch (e) {
      log.warn(`File not found for ${upload.recordId}, removing from queue`);
      removeFromUploadQueue(upload.recordId);
      continue;
    }

    log.info(`Retrying upload for ${upload.recordId} (attempt ${upload.retryCount + 1})`);
    updateUploadQueueRetry(upload.recordId);

    try {
      const result = await uploadWithRetry(upload.recordId, upload.filePath, upload.metadata, 2);

      // If auth expired, stop processing and notify user
      if (!result.success && result.status === 401) {
        log.warn('Token expired - stopping pending uploads processing');
        // Notify renderer to prompt for re-login
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth:expired', {
            message: 'Your session has expired. Please log in again to continue uploading.',
            pendingUploads: queue.length
          });
        }
        break; // Stop processing pending uploads
      }

      if (result.success) {
        removeFromUploadQueue(upload.recordId);
        // Update history status
        const recordings = historyStore.get('recordings', []);
        const recording = recordings.find(r => r.id === upload.recordId);
        if (recording) {
          recording.uploadStatus = 'uploaded';
          recording.transcriptionId = result.transcriptionId;
          recording.audioFileId = result.audioFileId;
          historyStore.set('recordings', recordings);
        }
        log.info(`Successfully uploaded pending recording: ${upload.recordId}`);

        // Notify renderer about background upload success
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('upload:complete', {
            recordId: upload.recordId,
            success: true,
            audioFileId: result.audioFileId,
            background: true
          });
        }
      } else if (result.canRetry === false) {
        // Terminal failure (413, 402, 415, 400, etc.) — drop from queue so we
        // don't keep re-attempting a doomed upload on every app launch.
        log.warn(`[upload] Terminal failure for pending ${upload.recordId} (status=${result.status}): ${result.error} — removing from queue`);
        removeFromUploadQueue(upload.recordId);
        const recordings = historyStore.get('recordings', []);
        const recording = recordings.find(r => r.id === upload.recordId);
        if (recording) {
          recording.uploadStatus = 'failed';
          recording.uploadError = result.error || 'Upload rejected by server';
          historyStore.set('recordings', recordings);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('upload:complete', {
            recordId: upload.recordId,
            success: false,
            error: result.error,
            terminal: true,
            background: true,
          });
        }
      }
    } catch (e) {
      log.error(`Failed to upload ${upload.recordId}:`, e.message);
    }

    // Wait 5 seconds between uploads to avoid overwhelming the server
    await new Promise(r => setTimeout(r, 5000));
  }
  } finally {
    isProcessingUploads = false;
  }
}

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

// Active uploads map for pause/resume/cancel
const activeUploads = new Map();

// AbortControllers for axios-based uploads (used by upload:cancel)
const activeAbortControllers = new Map();
// Track recordIds that were cancelled so we suppress post-cancel completion events
const cancelledUploads = new Set();
// audioFileIds for in-flight direct-blob uploads — used by upload:cancel to
// best-effort clean up the staged blob in Azure when the user cancels.
const activeDirectAudioFileIds = new Map();

// Track if upload is in progress to prevent window close
let isUploadInProgress = false;
let pendingUploadsCount = 0;
// DRD-2: set while before-quit aborts in-flight uploads, so upload:start keeps
// the aborted recording in the persistent queue (for next-launch resume) rather
// than treating the quit-abort like a user cancel and dropping it.
let isQuittingWithUploads = false;

// Track recording status for close prevention
let isRecordingInProgress = false;
let isProcessingRecording = false;

let mainWindow;
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

    tray.setToolTip('Suisse Notes - Recording...');

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
        tray.setToolTip(`Suisse Notes - Recording: ${duration}`);
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
  // buffered before the window existed — deliver it once the renderer is ready.
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingSSOPayload) {
      mainWindow.webContents.send('auth:ssoCallback', pendingSSOPayload);
      pendingSSOPayload = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prevent close during recording, processing, or upload
  mainWindow.on('close', (e) => {
    // Allow close if we already flushed recording data during shutdown
    if (app._quitFlushed) return;

    const shouldPreventClose = isRecordingInProgress ||
                                isProcessingRecording ||
                                isUploadInProgress ||
                                pendingUploadsCount > 0;

    if (shouldPreventClose) {
      e.preventDefault();

      // Determine the appropriate message
      let title = 'Cannot Close';
      let message = 'Please wait...';

      if (isRecordingInProgress) {
        title = 'Recording in Progress';
        message = 'A recording is in progress. Please stop the recording before closing the app.';
      } else if (isProcessingRecording) {
        title = 'Processing Recording';
        message = 'Your recording is being processed. Please wait for it to complete before closing the app.';
      } else if (isUploadInProgress || pendingUploadsCount > 0) {
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
  // Set the App User Model ID for Windows notifications
  // This ensures notifications show "Suisse Notes" instead of "electron.app.electron"
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

        mainWindow.webContents.send('recording:suspend', {
          reason: 'system_suspend',
          timestamp: Date.now()
        });

        await flushComplete;
      }

      // Save active recording state
      const activeSession = getActiveRecording();
      if (activeSession) {
        activeRecordingStore.set('activeSession', {
          ...activeSession,
          suspendedAt: new Date().toISOString(),
          needsRecovery: true
        });
        log.info('Active recording state saved for recovery:', activeSession.recordId);
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
        mainWindow.webContents.send('recording:resume', {
          recordId: activeSession.recordId,
          suspendedAt: activeSession.suspendedAt,
          needsRecovery: true
        });
      }

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
      mainWindow.webContents.send('system:screen-locked');
    }
  });

  powerMonitor.on('unlock-screen', () => {
    log.info('Screen unlocked');
    // Optionally notify renderer about screen unlock
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:screen-unlocked');
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

      mainWindow.webContents.send('recording:suspend', {
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

  app.on('before-quit', async (e) => {
    if (app._quitFlushed) return;
    const hasUpload = isUploadInProgress || pendingUploadsCount > 0;
    if (!isRecordingInProgress && !hasUpload) return;

    e.preventDefault();

    if (isRecordingInProgress) {
      await flushBeforeQuit('before_quit');
    }

    // DRD-2: the previous handler ignored in-flight uploads, so quitting
    // mid-upload severed the socket with no clean cancellation. Abort the
    // active upload controllers instead: SAS block commits are atomic (an
    // uncommitted blob is invisible to the server) and a truncated legacy POST
    // is rejected on Content-Length mismatch, so no partial recording can
    // persist server-side. The recording stays in the persistent upload queue
    // (added in upload:start) and resumes on next launch via
    // processPendingUploads.
    if (hasUpload && activeAbortControllers.size > 0) {
      isQuittingWithUploads = true; // keep aborted uploads queued for resume
      log.info(`Aborting ${activeAbortControllers.size} in-flight upload(s) before quit`);
      for (const controller of activeAbortControllers.values()) {
        try { controller.abort(); } catch (_) { /* ignore */ }
      }
      // Brief grace so the abort can unwind the upload promises before exit.
      await new Promise((r) => setTimeout(r, 300));
    }

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
      message: 'Suisse Notes works best from the Applications folder.',
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
  // Only check in production (packaged app), skip if on read-only volume
  if (app.isPackaged && !skipAutoUpdate) {
    // Check for updates on startup (silent - no notification)
    autoUpdater.checkForUpdates().catch(err => {
      log.error('Auto-update check failed:', err);
    });

    // Re-check every 4 hours while app is running
    setInterval(() => {
      if (!skipAutoUpdate) {
        autoUpdater.checkForUpdates().catch(err => {
          log.error('Periodic auto-update check failed:', err);
        });
      }
    }, 4 * 60 * 60 * 1000);
  }

  // === Recover Orphaned Recordings ===
  // Run 5 seconds after startup to recover any crashed recordings
  let recoveryPromise = null;
  setTimeout(() => {
    recoveryPromise = recoverOrphanedRecordings().catch(err => {
      log.error('Error recovering orphaned recordings:', err);
    });
  }, 5000);

  // === Cleanup Old Orphaned Directories ===
  // Run 10 seconds after startup, but always wait for recovery to finish first
  setTimeout(async () => {
    if (recoveryPromise) await recoveryPromise;
    cleanupOldOrphanedDirectories().catch(err => {
      log.error('Error cleaning up orphaned directories:', err);
    });
  }, 10000);

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

autoUpdater.on('update-available', (info) => {
  log.info('Update available:', info.version);
  // Notify renderer (optional - for UI feedback)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:available', info);
  }
});

autoUpdater.on('update-not-available', (info) => {
  log.info('Update not available. Current version is up-to-date.');
});

autoUpdater.on('download-progress', (progressObj) => {
  log.info(`Download progress: ${progressObj.percent.toFixed(1)}%`);
  // Notify renderer (optional - for UI feedback)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:progress', progressObj);
  }
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('Update downloaded:', info.version);
  // Will auto-install on app quit due to autoInstallOnAppQuit = true
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:downloaded', info);
  }
});

autoUpdater.on('error', (err) => {
  log.error('Auto-update error:', err);

  // Detect signature verification failure (common when app is not code-signed)
  const errMsg = err.message || err.toString();
  if (errMsg.includes('not signed') || errMsg.includes('signature') || errMsg.includes('publisherNames')) {
    log.warn('Update failed due to signature verification. App needs code signing or manual reinstall.');

    // Show dialog to user explaining they need to manually update
    if (mainWindow && !mainWindow.isDestroyed()) {
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
        message: 'Suisse Notes works best from the Applications folder.',
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
    const url = `${API_BASE_URL}/api/auth/${provider}/login?client=desktop`;
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
ipcMain.handle('auth:login', async (event, email, password) => {
  try {
    // Suisse Notes API authentication
    const response = await axios.post(`${API_BASE_URL}/api/auth/desktop`, {
      email,
      password,
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

    // Check for successful response
    if (response.data && response.data.success && response.data.token) {
      return {
        success: true,
        token: response.data.token,
        user: response.data.user,
        minutes: response.data.minutes || null
      };
    } else if (response.data && response.data.error) {
      return {
        success: false,
        error: response.data.error
      };
    } else {
      return {
        success: false,
        error: 'Invalid response from server'
      };
    }
  } catch (error) {
    let errorMessage = 'Login failed';

    if (error.response) {
      // Server responded with error
      errorMessage = error.response.data?.error || error.response.data?.message || `Server error: ${error.response.status}`;
    } else if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Could not connect to Suisse Notes server';
    } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      errorMessage = 'Connection timed out. Please check your internet connection.';
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'Server not found. Please check the API URL.';
    } else {
      errorMessage = error.message || 'Unknown error occurred';
    }

    // Report network/server errors to Sentry (not user auth failures)
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND' || (error.response && error.response.status >= 500)) {
      Sentry.captureException(error, {
        tags: { operation: 'login' },
        extra: { errorCode: error.code, httpStatus: error.response?.status },
      });
    }

    return {
      success: false,
      error: errorMessage
    };
  }
});

// Registration - Create new account
ipcMain.handle('auth:register', async (event, email, password, name) => {
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

    // Check for successful response (register endpoint returns { user, token })
    if (response.data && response.data.token) {
      return {
        success: true,
        token: response.data.token,
        user: response.data.user
      };
    } else if (response.data && response.data.error) {
      return {
        success: false,
        error: response.data.error
      };
    } else {
      return {
        success: false,
        error: 'Invalid response from server'
      };
    }
  } catch (error) {
    let errorMessage = 'Registration failed';

    if (error.response) {
      // Handle specific error codes
      if (error.response.status === 409) {
        errorMessage = 'An account with this email already exists';
      } else if (error.response.status === 400) {
        errorMessage = error.response.data?.error || 'Invalid registration data';
      } else {
        errorMessage = error.response.data?.error || `Server error: ${error.response.status}`;
      }
    } else if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Could not connect to Suisse Notes server';
    } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      errorMessage = 'Connection timed out. Please check your internet connection.';
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'Server not found. Please check your internet connection.';
    } else {
      errorMessage = error.message || 'Unknown error occurred';
    }

    return {
      success: false,
      error: errorMessage
    };
  }
});

ipcMain.handle('auth:saveToken', async (event, token) => {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(token);
      configStore.set('authToken', encrypted.toString('base64'));
    } else {
      // Fallback to plain storage (less secure)
      configStore.set('authToken', token);
    }
    // Trigger pending uploads now that we have auth
    setImmediate(() => {
      processPendingUploads().catch(err => {
        log.error('Error processing pending uploads after login:', err);
      });
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth:getToken', async () => {
  try {
    const stored = configStore.get('authToken');
    if (!stored) return null;

    if (safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(Buffer.from(stored, 'base64'));
      return decrypted;
    } else {
      return stored;
    }
  } catch (error) {
    console.error('Error getting token:', error);
    return null;
  }
});

ipcMain.handle('auth:clearToken', async () => {
  configStore.delete('authToken');
  configStore.delete('userInfo');  // Also clear user info on logout
  Sentry.setUser(null);  // Clear Sentry user context on logout
  return { success: true };
});

// Save user info (for session restoration)
ipcMain.handle('auth:saveUserInfo', async (event, userInfo) => {
  try {
    configStore.set('userInfo', userInfo);
    // Set Sentry user context so main process errors are attributed to this user
    if (userInfo) {
      Sentry.setUser({ id: userInfo.id, email: userInfo.email });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get user info
ipcMain.handle('auth:getUserInfo', async () => {
  try {
    return configStore.get('userInfo', null);
  } catch (error) {
    console.error('Error getting user info:', error);
    return null;
  }
});

// Create web session token for seamless web login
// SECURITY: Verifies token matches stored user to prevent authentication as wrong user
ipcMain.handle('auth:createWebSession', async () => {
  try {
    const authToken = await getAuthToken();
    if (!authToken) {
      return { success: false, error: 'Not authenticated' };
    }

    // CRITICAL SECURITY CHECK: Verify the token belongs to the expected user
    // This prevents authenticating as a stale/wrong user if token storage got out of sync
    const storedUserInfo = configStore.get('userInfo');
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
            // Clear the mismatched token to force re-login
            configStore.delete('authToken');
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

    const response = await axios.post(`${API_BASE_URL}/api/auth/desktop/create-web-session`, {}, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    if (response.data && response.data.success && response.data.sessionToken) {
      return {
        success: true,
        sessionToken: response.data.sessionToken
      };
    }

    return { success: false, error: 'Failed to create web session' };
  } catch (error) {
    console.error('Create web session error:', error);
    return {
      success: false,
      error: error.response?.data?.error || error.message || 'Failed to create web session'
    };
  }
});

// --- Token Refresh ---

ipcMain.handle('auth:refreshToken', async () => {
  try {
    const authToken = await getAuthToken();
    if (!authToken) {
      return { success: false, error: 'Not authenticated' };
    }

    const response = await axios.post(`${API_BASE_URL}/api/auth/refresh`, {}, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      timeout: 15000
    });

    if (response.data?.token) {
      // Save new token to configStore immediately so main process is in sync
      if (safeStorage.isEncryptionAvailable()) {
        configStore.set('authToken', safeStorage.encryptString(response.data.token).toString('base64'));
      } else {
        configStore.set('authToken', response.data.token);
      }
      log.info('Token refreshed successfully via IPC');
      return { success: true, token: response.data.token, user: response.data.user };
    }
    return { success: false, error: 'No token in refresh response' };
  } catch (error) {
    log.warn('Token refresh failed:', error.response?.status, error.message);
    return {
      success: false,
      error: error.response?.data?.error || error.message || 'Token refresh failed'
    };
  }
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

// --- Recording (WhisperTranscribe Patterns) ---

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
  const current = previous.catch(() => {}).then(fn);
  recordingLocks.set(recordId, current);
  current.finally(() => {
    if (recordingLocks.get(recordId) === current) {
      recordingLocks.delete(recordId);
    }
  });
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

// Helper: Get audio metadata via ffprobe
function getAudioMetadata(filePath) {
  // Fast-fail if ffprobe binary is known to be broken (startup probe or earlier call)
  if (binaryHealth.ffprobe.available === false) {
    return Promise.reject(new Error(`ffprobe binary unavailable (${binaryHealth.ffprobe.error || 'spawn failed'})`));
  }
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        if (isSpawnError(err)) {
          markBinaryUnavailable('ffprobe', err, 'getAudioMetadata');
        }
        reject(err);
      } else {
        resolve(metadata);
      }
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
  const retryableCodes = new Set(['EBUSY', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE']);
  const delays = [100, 300, 800];
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let fd = null;
    try {
      fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (e) { /* ignore */ }
        fd = null;
      }
      try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
      if (!retryableCodes.has(err.code) || attempt === delays.length) throw err;
      const until = Date.now() + delays[attempt];
      while (Date.now() < until) { /* short blocking wait — metadata writes only */ }
    }
  }
  throw lastErr;
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
  return fs.promises.rm(dirPath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 500
  });
}

// Variant that never throws. Use in post-success cleanup paths where the
// authoritative data is already written and a stale temp dir is a disk leak,
// not a data-loss. Logs + reports to Sentry so we can track how often this
// fails in the wild.
async function rmDirSafeBestEffort(dirPath, operation) {
  try {
    await rmDirSafe(dirPath);
    return { success: true };
  } catch (err) {
    log.warn(`Cleanup failed for ${dirPath} (${operation}): ${err.code || err.message}`);
    try {
      Sentry.captureMessage(`rmDirSafe failed: ${err.code || 'unknown'}`, {
        level: 'warning',
        tags: { operation: operation || 'cleanup' },
        extra: { dirPath, errorCode: err.code, errorMessage: err.message }
      });
    } catch (sentryErr) { /* never let telemetry break cleanup */ }
    return { success: false, error: err };
  }
}

// Helper: Combine chunks using streaming to avoid memory issues with large files
async function combineChunksStreaming(chunksPath, sortedChunks, outputPath) {
  const tmpPath = outputPath + '.tmp';
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(tmpPath);

    writeStream.on('finish', () => {
      try {
        // Atomic swap: rename temp file to final path (atomic on same filesystem)
        fs.renameSync(tmpPath, outputPath);
        resolve();
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
        reject(err);
      }
    });
    writeStream.on('error', (err) => {
      try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
      reject(err);
    });

    // Process chunks sequentially to maintain order and avoid memory spikes
    (async () => {
      try {
        for (const chunkFile of sortedChunks) {
          const chunkPath = path.join(chunksPath, chunkFile);
          const data = await fs.promises.readFile(chunkPath);
          // Wait for write to complete before reading next chunk
          await new Promise((res, rej) => {
            if (!writeStream.write(data)) {
              writeStream.once('drain', res);
            } else {
              res();
            }
          });
        }
        writeStream.end();
      } catch (err) {
        writeStream.destroy(err);
        try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
        reject(err);
      }
    })();
  });
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

function probeBinary(binPath, timeoutMs = 5000) {
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
      child = spawn(binPath, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
      record.error = `probe timed out after ${timeoutMs}ms`;
      finish();
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      record.error = err.message;
      record.errno = err.code || null;
      finish();
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        record.available = true;
        record.versionLine = (stdout.split('\n')[0] || '').slice(0, 200);
      } else {
        record.error = `exit ${code}${signal ? ' (' + signal + ')' : ''}`;
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
  Sentry.captureMessage('Bundled FFmpeg/ffprobe binary unavailable', {
    level: 'error',
    tags: {
      operation: 'binaryHealth',
      'binary.platform': process.platform,
      'binary.arch': process.arch,
    },
    extra: {
      trigger: triggerSource,
      ffmpeg: { ...binaryHealth.ffmpeg },
      ffprobe: { ...binaryHealth.ffprobe },
    },
  });
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
      Sentry.captureMessage(`FFmpeg timeout: ${operationName} after ${(elapsed / 1000).toFixed(1)}s`, {
        level: 'error',
        tags: { operation: operationName },
        extra: { timeoutMs, elapsedMs: elapsed, processStarted },
      });
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
      Sentry.captureMessage(`FFmpeg stalled: ${operationName} silent for ${(silentFor / 1000).toFixed(0)}s`, {
        level: 'error',
        tags: { operation: operationName },
        extra: { silentMs: silentFor, elapsedMs: elapsed, timeoutMs, processStarted },
      });
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
      .on('error', (err) => {
        cleanup();
        // Detect spawn failures and update the unified health record
        if (isSpawnError(err)) {
          markBinaryUnavailable('ffmpeg', err, `ffmpegWithTimeout:${operationName}`);
        }
        if (reportToSentry) {
          Sentry.captureException(err, {
            tags: { operation: operationName },
            extra: { elapsedMs: Date.now() - startTime, ffmpegAvailable: binaryHealth.ffmpeg.available, processStarted },
          });
        }
        reject(err);
      })
      .run();
  });
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
    log.warn(`FFmpeg unavailable (${binaryHealth.ffmpeg.error || 'spawn failed'}) — skipping system audio merge, keeping mic-only`);
    return micPath;
  }

  const mergedPath = micPath.replace(/(\.\w+)$/, '_merged$1');
  log.info(`Merging system audio (${fs.statSync(systemAudioPath).size} bytes) with mic recording`);

  try {
    await ffmpegWithTimeout(
      ffmpeg()
        // System audio: raw PCM, 48kHz, mono, 16-bit signed little-endian
        .input(systemAudioPath)
        .inputOptions(['-f', 's16le', '-ar', '48000', '-ac', '1'])
        // Mic recording
        .input(micPath)
        // Mix both streams
        .complexFilter('[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0')
        .output(mergedPath),
      FFMPEG_TIMEOUT_MS,
      'System audio merge'
    );

    // Validate merged file
    const mergedValidation = validateAudioOutput(mergedPath);
    if (mergedValidation.valid) {
      // Replace original with merged
      fs.unlinkSync(micPath);
      fs.renameSync(mergedPath, micPath);
      log.info('System audio merged successfully');
    } else {
      log.warn('Merged file validation failed, keeping mic-only recording');
      try { fs.unlinkSync(mergedPath); } catch (e) { /* ignore */ }
    }
  } catch (err) {
    log.warn('System audio merge failed, keeping mic-only recording:', err.message);
    try { if (fs.existsSync(mergedPath)) fs.unlinkSync(mergedPath); } catch (e) { /* ignore */ }
  }

  // Clean up system audio file
  try { fs.unlinkSync(systemAudioPath); } catch (e) { /* ignore */ }
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
  isRecordingInProgress = inProgress;
  log.info('Recording state updated:', { isRecordingInProgress });

  // Show/hide tray indicator based on recording state
  if (inProgress) {
    createRecordingTray();
  } else {
    destroyRecordingTray();
  }

  return { success: true };
});

ipcMain.handle('recording:setProcessing', (event, processing) => {
  isProcessingRecording = processing;
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
    writeFileWithSync(metadataPath, JSON.stringify(metadata, null, 2));

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
ipcMain.handle('recording:createSession', async (event, recordId, ext, userId) => {
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
    step('validated', tValidate, { recordId: validRecordId });

    // Check disk space before creating session (wmic can be slow on Windows;
    // canStartRecording now bounds the shell-out to 3s and falls back safely).
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

// 2. Save recording chunk - SYNCHRONOUS write (WhisperTranscribe pattern)
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
      const fh = await fs.promises.open(chunkPath, 'w');
      try {
        await fh.write(buffer);
        await fh.sync();
      } finally {
        await fh.close();
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

// 3. Create session file - combines current chunks into a session (intermediate step)
ipcMain.handle('recording:createSessionFile', async (event, recordId, ext) => {
  // Validate first (sync, fail fast without acquiring a lock on bogus IDs)
  let validRecordId, validExt;
  try {
    validRecordId = validateRecordId(recordId);
    validExt = validateExtension(ext);
  } catch (error) {
    console.error('createSessionFile validation failed:', error);
    return { success: false, error: error.message };
  }

  return withRecordingLock(validRecordId, async () => {
    try {
      const chunksPath = getChunksPath(validRecordId);
      const sessionsPath = getSessionsPath(validRecordId);

      // Check if chunks directory exists
      if (!fs.existsSync(chunksPath)) {
        return { success: false, error: 'No chunks directory found' };
      }

      // Get and sort chunks
      const allFiles = fs.readdirSync(chunksPath);
      const chunks = allFiles.filter(f => f.startsWith('chunk_') && f.endsWith(validExt));

      if (chunks.length === 0) {
        return { success: false, error: 'No chunks found' };
      }

      const sortedChunks = sortChunksNumerically(chunks, validExt);

      // Validate chunk sequence — fail if chunks are missing
      const sequenceCheck = validateChunkSequence(chunks, validExt);
      if (!sequenceCheck.valid) {
        log.error('Chunk sequence gap detected:', sequenceCheck.message);
        Sentry.captureMessage(`Chunk sequence gap: ${sequenceCheck.message}`, {
          level: 'warning',
          tags: { operation: 'createSessionFile' },
          extra: {
            recordId: validRecordId,
            chunkCount: chunks.length,
            firstIndex: sequenceCheck.firstIndex,
            lastIndex: sequenceCheck.lastIndex,
            expectedCount: sequenceCheck.expectedCount,
            missingCount: sequenceCheck.missingChunks.length,
            missingFirst10: sequenceCheck.missingChunks.slice(0, 10),
          },
        });
        return { success: false, error: `Missing audio chunks: ${sequenceCheck.message}` };
      }

      // Create sessions directory
      if (!fs.existsSync(sessionsPath)) {
        fs.mkdirSync(sessionsPath, { recursive: true });
      }

      const timestamp = Date.now();
      const rawPath = path.join(sessionsPath, `session_${timestamp}_raw${validExt}`);
      const finalPath = path.join(sessionsPath, `session_${timestamp}${validExt}`);

      // Use streaming concatenation to avoid memory issues with large recordings
      await combineChunksStreaming(chunksPath, sortedChunks, rawPath);

      // Verify raw file was created and has content
      const rawStats = fs.statSync(rawPath);
      if (rawStats.size < MIN_RECORDING_SIZE) {
        fs.unlinkSync(rawPath);
        return { success: false, error: 'Recording too short or empty' };
      }

      console.log(`Combined ${sortedChunks.length} chunks into raw session (${rawStats.size} bytes)`);

      // Validate raw file is a readable audio container before FFmpeg processing
      let ffmpegAvailable = true;
      try {
        await getAudioMetadata(rawPath);
      } catch (probeErr) {
        // Distinguish between "ffprobe can't run" vs "file is actually corrupt"
        const isSpawnError = probeErr.message?.includes('spawn') || probeErr.message?.includes('ENOENT') || probeErr.message?.includes('ENOEXEC') || probeErr.message?.includes('system error');
        if (isSpawnError) {
          log.warn('FFmpeg/ffprobe binary cannot execute — skipping FFmpeg processing, using raw concatenation:', probeErr.message);
          ffmpegAvailable = false;
          // Don't fail — raw concatenation is valid WebM, just skip FFmpeg step
        } else {
          log.error('Raw session file is not a valid audio file:', probeErr.message);
          Sentry.captureException(probeErr, {
            tags: { operation: 'Session file (probe validation)' },
            extra: { rawPath, rawSize: rawStats.size, chunksCount: sortedChunks.length },
          });
          // Keep raw file and chunks for recovery — don't delete
          return { success: false, error: 'Raw recording file is corrupt or unreadable' };
        }
      }

      // Process with FFmpeg (codec copy, fallback to re-encode) - with timeout
      // Skip FFmpeg entirely if binary is broken — use raw concatenation as-is
      if (!ffmpegAvailable) {
        log.info('Using raw concatenated file as session (FFmpeg unavailable)');
        fs.renameSync(rawPath, finalPath);
      } else {
      try {
        await ffmpegWithTimeout(
          ffmpeg(rawPath)
            .audioCodec('copy')
            .output(finalPath),
          FFMPEG_TIMEOUT_MS,
          'Session file (codec copy)',
          { reportToSentry: false } // Codec copy failure is an expected fallback, not an error
        );
        console.log('Session file created with codec copy');
      } catch (err) {
        console.warn('Codec copy failed, trying re-encode:', err.message);
        // Fallback: re-encode if codec copy fails
        await ffmpegWithTimeout(
          ffmpeg(rawPath)
            .output(finalPath),
          FFMPEG_TIMEOUT_MS,
          'Session file (re-encode)'
        );
        console.log('Session file created with re-encode');
      }
      } // end ffmpegAvailable else block

      // Get duration via ffprobe
      let durationMs = 0;
      try {
        const metadata = await getAudioMetadata(finalPath);
        durationMs = safeParseDuration(metadata) * 1000;
      } catch (e) {
        console.warn('Could not get audio duration:', e);
      }

      // P0 Data Loss Fix: Validate session file BEFORE deleting source data
      const ipcSessionValidation = validateAudioOutput(finalPath);
      if (!ipcSessionValidation.valid) {
        log.warn('IPC createSessionFile: Output validation warning:', ipcSessionValidation.error);
        // Keep raw file and chunks intact for recovery — don't delete anything
        try { fs.unlinkSync(finalPath); } catch (e) { /* ignore */ }
        return { success: false, error: `Session file validation failed: ${ipcSessionValidation.error}` };
      }

      // Validation passed — nuke the chunks directory entirely (not just the
      // snapshot we read at the top). Under withRecordingLock, saveChunk cannot
      // be racing; but a defensive rm -rf also protects against any historical
      // straggler left over from an older buggy run. rawPath is under sessions/
      // and is removed independently.
      try {
        if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
        await rmDirSafe(chunksPath);
        fs.mkdirSync(chunksPath, { recursive: true });
      } catch (e) {
        console.warn('Could not clean up after session creation:', e);
      }

      return {
        success: true,
        sessionFile: finalPath,
        durationMs,
        sessionTimestamp: timestamp,
        chunksProcessed: sortedChunks.length
      };
    } catch (error) {
      console.error('Error creating session file:', error);
      return { success: false, error: error.message };
    }
  });
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
    log.info('Recording metadata updated on completion:', recordId);
  } catch (error) {
    log.error('Failed to update recording metadata on completion:', error);
    // Don't throw - this is non-critical
  }
}

// 4. Combine recording chunks - final combination with multiple fallbacks
ipcMain.handle('recording:combineChunks', async (event, recordId, ext) => {
  // Validate first (sync, fail fast without acquiring a lock on bogus IDs)
  let validRecordId, validExt;
  try {
    validRecordId = validateRecordId(recordId);
    validExt = validateExtension(ext);
  } catch (error) {
    console.error('combineChunks validation failed:', error);
    return { success: false, error: error.message };
  }

  return withRecordingLock(validRecordId, async () => {
    try {
      const recordPath = getRecordingPath(validRecordId);
      const chunksPath = getChunksPath(validRecordId);
      const sessionsPath = getSessionsPath(validRecordId);
      const outputFile = `audio${validExt}`;
      const outputPath = path.join(recordPath, outputFile);

      console.log('Combining chunks for recording:', validRecordId);

      // Step 1: If there are current chunks, create a session from them first
      if (fs.existsSync(chunksPath)) {
        const chunkFiles = fs.readdirSync(chunksPath)
          .filter(f => f.startsWith('chunk_') && f.endsWith(validExt));

        if (chunkFiles.length > 0) {
          console.log(`Found ${chunkFiles.length} chunks, creating session file...`);
          // Note: We call the internal handler directly
          const result = await createSessionFileInternal(validRecordId, validExt);
          if (!result.success) {
            console.warn('Could not create session from chunks:', result.error);
          }
        }
      }

      // Step 2: Check for session files
      if (fs.existsSync(sessionsPath)) {
        const sessionFiles = fs.readdirSync(sessionsPath)
          .filter(f => f.endsWith(validExt) && !f.includes('_raw'))
          .sort((a, b) => {
            // Sort by timestamp in filename
            const tsA = parseInt(a.replace('session_', '').replace(validExt, ''), 10);
            const tsB = parseInt(b.replace('session_', '').replace(validExt, ''), 10);
            return tsA - tsB;
          });

        if (sessionFiles.length > 0) {
          console.log(`Found ${sessionFiles.length} session file(s)`);

          // Single session - just copy it
          if (sessionFiles.length === 1) {
            fs.copyFileSync(path.join(sessionsPath, sessionFiles[0]), outputPath);

            // P0 Data Loss Fix: Validate output BEFORE deleting sources
            const singleSessionValidation = validateAudioOutput(outputPath);
            if (!singleSessionValidation.valid) {
              log.warn('combineChunks: Single session output validation warning:', singleSessionValidation.error);
              // Continue anyway - audio data may still be usable by the server
            }

            // Cleanup
            await rmDirSafeBestEffort(sessionsPath, 'combineChunks-single');
            if (fs.existsSync(chunksPath)) {
              await rmDirSafeBestEffort(chunksPath, 'combineChunks-single');
            }

            // Get actual audio duration via ffprobe
            let audioDuration = 0;
            try {
              const metadata = await getAudioMetadata(outputPath);
              audioDuration = safeParseDuration(metadata);
            } catch (e) {
              console.warn('Could not get audio duration for single session:', e.message);
            }

            // Merge system audio if it was captured
            await mergeSystemAudio(outputPath, validRecordId);

            // Clear active recording state - successfully combined
            clearActiveRecording();

            // Update metadata.json with completion info
            updateRecordingMetadataOnCompletion(validRecordId, audioDuration, true);

            return {
              success: true,
              outputPath,
              filename: outputFile,
              fileSizeMb: ((fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0) / (1024 * 1024)).toFixed(2),
              duration: audioDuration
            };
          }

          // Multiple sessions - use FFmpeg concat demuxer
          const concatListPath = path.join(recordPath, 'concat_list.txt');
          const listContent = sessionFiles.map(f =>
            `file '${sessionsPath.replace(/\\/g, '/')}/${f}'`
          ).join('\n');
          fs.writeFileSync(concatListPath, listContent);

          // Use timeout-wrapped FFmpeg with fallback
          try {
            await ffmpegWithTimeout(
              ffmpeg()
                .input(concatListPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .audioCodec('copy')
                .output(outputPath),
              FFMPEG_TIMEOUT_MS,
              'Concat sessions (codec copy)',
              { reportToSentry: false } // Codec copy failure is an expected fallback, not an error
            );
          } catch (err) {
            console.warn('FFmpeg concat failed, trying re-encode:', err.message);
            // Fallback: re-encode
            try {
              await ffmpegWithTimeout(
                ffmpeg()
                  .input(concatListPath)
                  .inputOptions(['-f', 'concat', '-safe', '0'])
                  .output(outputPath),
                FFMPEG_TIMEOUT_MS,
                'Concat sessions (re-encode)'
              );
            } catch (reencodeErr) {
              console.error('Re-encode also failed:', reencodeErr.message);
              // Clean up concat list and any partial output before throwing
              try { fs.unlinkSync(concatListPath); } catch (e) { /* ignore */ }
              try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
              throw new Error(`FFmpeg concat failed: ${reencodeErr.message}`);
            }
          }

          // Cleanup
          fs.unlinkSync(concatListPath);

          // P0 Data Loss Fix: Validate output BEFORE deleting sources
          const multiSessionValidation = validateAudioOutput(outputPath);
          if (!multiSessionValidation.valid) {
            log.warn('combineChunks: Multi-session output validation warning:', multiSessionValidation.error);
            // Continue anyway - audio data may still be usable by the server
          }

          // Get actual audio duration via ffprobe
          let multiAudioDuration = 0;
          try {
            const metadata = await getAudioMetadata(outputPath);
            multiAudioDuration = safeParseDuration(metadata);
          } catch (e) {
            console.warn('Could not get audio duration for multi session:', e.message);
          }

          await rmDirSafeBestEffort(sessionsPath, 'combineChunks-multi');
          if (fs.existsSync(chunksPath)) {
            await rmDirSafeBestEffort(chunksPath, 'combineChunks-multi');
          }

          // Merge system audio if it was captured
          await mergeSystemAudio(outputPath, validRecordId);

          // Clear active recording state - successfully combined
          clearActiveRecording();

          // Update metadata.json with completion info
          updateRecordingMetadataOnCompletion(validRecordId, multiAudioDuration, true);

          return {
            success: true,
            outputPath,
            filename: outputFile,
            fileSizeMb: ((fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0) / (1024 * 1024)).toFixed(2),
            duration: multiAudioDuration
          };
        }
      }

      // Step 3: Fallback - direct chunk concatenation (if no sessions exist)
      if (fs.existsSync(chunksPath)) {
        const chunks = fs.readdirSync(chunksPath)
          .filter(f => f.startsWith('chunk_') && f.endsWith(validExt));

        if (chunks.length > 0) {
          console.log(`Fallback: Direct concatenation of ${chunks.length} chunks`);
          const sortedChunks = sortChunksNumerically(chunks, validExt);

          // Validate chunk sequence — fail if chunks are missing
          const sequenceCheck = validateChunkSequence(chunks, validExt);
          if (!sequenceCheck.valid) {
            log.error('Chunk sequence gap detected:', sequenceCheck.message);
            Sentry.captureMessage(`Chunk sequence gap: ${sequenceCheck.message}`, {
              level: 'warning',
              tags: { operation: 'combineChunks' },
              extra: { recordId: validRecordId, chunkCount: chunks.length },
            });
            return { success: false, error: `Missing audio chunks: ${sequenceCheck.message}` };
          }

          // Use streaming concatenation to avoid memory issues
          const rawConcatPath = outputPath + '.raw';
          await combineChunksStreaming(chunksPath, sortedChunks, rawConcatPath);

          // Process with FFmpeg (codec copy, fallback to re-encode) to ensure valid container
          try {
            try {
              await ffmpegWithTimeout(
                ffmpeg(rawConcatPath)
                  .audioCodec('copy')
                  .output(outputPath),
                FFMPEG_TIMEOUT_MS,
                'Direct concat (codec copy)',
                { reportToSentry: false }
              );
            } catch (codecCopyErr) {
              log.warn('Direct concat codec copy failed, trying re-encode:', codecCopyErr.message);
              await ffmpegWithTimeout(
                ffmpeg(rawConcatPath)
                  .output(outputPath),
                FFMPEG_TIMEOUT_MS,
                'Direct concat (re-encode)'
              );
            }
            try { fs.unlinkSync(rawConcatPath); } catch (e) { /* ignore */ }
          } catch (ffmpegErr) {
            log.warn('FFmpeg processing failed for direct concat, using raw file:', ffmpegErr.message);
            // Last resort: use the raw concatenated file as-is
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
            fs.renameSync(rawConcatPath, outputPath);
          }

          // P0 Data Loss Fix: Validate output BEFORE deleting sources
          const directConcatValidation = validateAudioOutput(outputPath);
          if (!directConcatValidation.valid) {
            log.warn('combineChunks: Direct concat output validation failed:', directConcatValidation.error);
            // Don't delete - keep the file even if validation fails, the audio data may still be usable
            log.info('Keeping output file despite validation failure - audio may still be uploadable');
          }

          // Get actual audio duration via ffprobe
          let directAudioDuration = 0;
          try {
            const metadata = await getAudioMetadata(outputPath);
            directAudioDuration = safeParseDuration(metadata);
          } catch (e) {
            console.warn('Could not get audio duration for direct concat:', e.message);
          }

          // Cleanup
          await rmDirSafeBestEffort(chunksPath, 'combineChunks-direct');

          // Merge system audio if it was captured
          await mergeSystemAudio(outputPath, validRecordId);

          // Clear active recording state - successfully combined
          clearActiveRecording();

          // Update metadata.json with completion info
          updateRecordingMetadataOnCompletion(validRecordId, directAudioDuration, true);

          return {
            success: true,
            outputPath,
            filename: outputFile,
            fileSizeMb: ((fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0) / (1024 * 1024)).toFixed(2),
            duration: directAudioDuration,
            warning: sequenceCheck.message || undefined
          };
        }
      }

      // Clear active recording state even on failure (no chunks found)
      clearActiveRecording();

      return { success: false, error: 'No sessions or chunks found to combine' };
    } catch (error) {
      console.error('Error combining chunks:', error);
      return { success: false, error: error.message };
    }
  });
});

// Internal helper for createSessionFile (to avoid IPC recursion)
async function createSessionFileInternal(recordId, ext) {
  const recordPath = getRecordingPath(recordId);
  const chunksPath = getChunksPath(recordId);
  const sessionsPath = getSessionsPath(recordId);

  if (!fs.existsSync(chunksPath)) {
    return { success: false, error: 'No chunks directory found' };
  }

  const allFiles = fs.readdirSync(chunksPath);
  const chunks = allFiles.filter(f => f.startsWith('chunk_') && f.endsWith(ext));

  if (chunks.length === 0) {
    return { success: false, error: 'No chunks found' };
  }

  const sortedChunks = sortChunksNumerically(chunks, ext);

  // Validate chunk sequence — in recovery path, warn but continue (partial audio > no audio)
  const sequenceCheck = validateChunkSequence(chunks, ext);
  if (!sequenceCheck.valid) {
    log.warn('Chunk sequence gap in recovery (continuing with partial audio):', sequenceCheck.message);
    Sentry.captureMessage(`Recovery chunk gap: ${sequenceCheck.message}`, {
      level: 'warning',
      tags: { operation: 'createSessionFileInternal' },
      extra: { recordId, chunkCount: chunks.length, hasGaps: true },
    });
  }

  if (!fs.existsSync(sessionsPath)) {
    fs.mkdirSync(sessionsPath, { recursive: true });
  }

  const timestamp = Date.now();
  const rawPath = path.join(sessionsPath, `session_${timestamp}_raw${ext}`);
  const finalPath = path.join(sessionsPath, `session_${timestamp}${ext}`);

  // Use streaming concatenation to avoid memory issues with large recordings
  await combineChunksStreaming(chunksPath, sortedChunks, rawPath);

  // Verify raw file was created and has content
  const rawStats = fs.statSync(rawPath);
  if (rawStats.size < MIN_RECORDING_SIZE) {
    fs.unlinkSync(rawPath);
    return { success: false, error: 'Recording too short or empty' };
  }

  // Validate raw file is a readable audio container before FFmpeg processing.
  // Skip if either binary is known-broken — raw concatenation is a valid WebM,
  // we just lose the codec-copy/remux pass.
  let ffmpegAvailable = binaryHealth.ffmpeg.available !== false && binaryHealth.ffprobe.available !== false;
  if (ffmpegAvailable) {
    try {
      await getAudioMetadata(rawPath);
    } catch (probeErr) {
      if (isSpawnError(probeErr)) {
        log.warn('ffprobe binary cannot execute — skipping FFmpeg processing, using raw concatenation:', probeErr.message);
        ffmpegAvailable = false;
      } else {
        log.error('Raw session file is not a valid audio file:', probeErr.message);
        Sentry.captureException(probeErr, {
          tags: { operation: 'Create session file (probe validation)' },
          extra: { rawPath, rawSize: rawStats.size, chunksCount: sortedChunks.length },
        });
        try { fs.unlinkSync(rawPath); } catch (e) { /* ignore */ }
        return { success: false, error: 'Raw recording file is corrupt or unreadable' };
      }
    }
  }

  // Process with FFmpeg or fall back to raw concatenation
  if (!ffmpegAvailable) {
    log.info('Using raw concatenated file as session (FFmpeg unavailable)');
    fs.renameSync(rawPath, finalPath);
  } else {
  try {
    await ffmpegWithTimeout(
      ffmpeg(rawPath)
        .audioCodec('copy')
        .output(finalPath),
      FFMPEG_TIMEOUT_MS,
      'Create session file (codec copy)',
      { reportToSentry: false } // Codec copy failure is an expected fallback, not an error
    );
  } catch (err) {
    console.warn('Codec copy failed, trying re-encode:', err.message);
    // Fallback: re-encode
    try {
      await ffmpegWithTimeout(
        ffmpeg(rawPath)
          .output(finalPath),
        FFMPEG_TIMEOUT_MS,
        'Create session file (re-encode)'
      );
    } catch (reencodeErr) {
      console.error('FFmpeg processing failed, using raw file:', reencodeErr.message);
      // Last resort: use raw concatenated file as-is (still valid WebM)
      if (fs.existsSync(rawPath)) {
        fs.renameSync(rawPath, finalPath);
      } else {
        return { success: false, error: `FFmpeg processing failed: ${reencodeErr.message}` };
      }
    }
  }
  }

  // P0 Data Loss Fix: Validate session file BEFORE deleting source chunks
  const sessionValidation = validateAudioOutput(finalPath);
  if (!sessionValidation.valid) {
    log.error('Session file validation failed:', sessionValidation.error);
    try { fs.unlinkSync(finalPath); } catch (e) { /* ignore */ }
    // Keep raw file and chunks intact for recovery
    return { success: false, error: `Session file validation failed: ${sessionValidation.error}` };
  }

  try {
    fs.unlinkSync(rawPath);
    sortedChunks.forEach(f => fs.unlinkSync(path.join(chunksPath, f)));
  } catch (e) {
    console.warn('Cleanup warning:', e);
  }

  return { success: true, sessionFile: finalPath, sessionTimestamp: timestamp };
}

// 5. Check for recording chunks/sessions
ipcMain.handle('recording:checkForChunks', async (event, recordId, ext) => {
  try {
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
      hasChunks: chunkCount > 0 || sessionCount > 0,
      chunkCount,
      sessionCount,
      lastChunkIndex
    };
  } catch (error) {
    return { hasChunks: false, chunkCount: 0, sessionCount: 0, lastChunkIndex: -1 };
  }
});

ipcMain.handle('recording:getFilePath', async (event, recordId, ext) => {
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

ipcMain.handle('recording:deleteRecording', async (event, recordId) => {
  try {
    const recordingDir = getRecordingPath(recordId);
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
    const stored = configStore.get('authToken');
    if (!stored) return null;

    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    }
    return stored;
  } catch (e) {
    console.warn('Could not get auth token:', e);
    return null;
  }
}

// Helper: Sleep for delay
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === Two-Phase Upload Verification (P0 Data Loss Fix) ===
// Poll server to verify file was actually persisted before allowing deletion

/**
 * Poll server to verify upload was persisted
 * @param {string} audioFileId - The audio file ID returned by upload
 * @param {number} maxAttempts - Maximum polling attempts (default 15 = 30 seconds)
 * @returns {Promise<{persisted: boolean, verified: boolean, error?: string}>}
 */
async function pollServerStatus(audioFileId, maxAttempts = 15) {
  const pollInterval = 2000; // 2 seconds between polls
  const authToken = await getAuthToken();

  // Status semantics — keep in lockstep with the renderer copy in
  // src/services/upload.js and the server contract in
  // src/lib/api/desktop-contract.ts (RecordingStatus). The moment the server
  // returns any persisted state, the bytes are on the server and the
  // audioFileId resolves to a Meeting row — we don't need to wait for
  // downstream transcription. Legacy lowercase values are kept for any
  // older endpoint that still echoes them.
  const PERSISTED_STATES = new Set([
    'persisted', 'complete', 'processing',         // legacy
    'UPLOADING', 'PROCESSING', 'COMPLETED',        // contract
  ]);
  const FAILED_STATES = new Set([
    'failed',                                       // legacy
    'FAILED', 'CANCELLED',                          // contract
  ]);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await axios.get(
        `${API_BASE_URL}/api/desktop/upload/${audioFileId}/status`,
        {
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      if (response.data) {
        const status = response.data.status;

        if (PERSISTED_STATES.has(status)) {
          log.info(`Upload verification successful for ${audioFileId}: status=${status}`);
          return { persisted: true, verified: true };
        }

        if (FAILED_STATES.has(status)) {
          const errMsg = response.data.errorMessage || response.data.error || `Server reported status=${status}`;
          log.error(`Server reported upload failed for ${audioFileId}:`, errMsg);
          return { persisted: false, verified: false, error: errMsg };
        }

        // RECORDING means the server is still ingesting — keep polling.
        if (status === 'RECORDING' || status === 'recording') {
          log.info(`Upload status for ${audioFileId}: ${status}, waiting...`);
        } else {
          // DUREC-1: an UNRECOGNIZED status (neither persisted, failed, nor
          // recording) almost certainly means the backend added a new
          // post-persistence state the client doesn't know yet (e.g. QUEUED).
          // The authenticated upload already returned an audioFileId, so the
          // bytes are on the server — treat as persisted (trust-based) rather
          // than polling to a false "confirmation timeout" that makes the user
          // re-upload and burns duplicate minutes. Log so backend enum drift is
          // visible.
          log.warn(`Upload status for ${audioFileId}: unrecognized status "${status}" — treating as persisted (fail-safe)`);
          Sentry.captureMessage(`Upload status unknown enum: ${status}`, {
            level: 'warning',
            tags: { operation: 'upload_verification' },
            extra: { audioFileId, status },
          });
          return { persisted: true, verified: false, fallback: true, unknownStatus: status };
        }
      }

      await sleep(pollInterval);
    } catch (error) {
      // 404 means endpoint doesn't exist yet - fall back to trust-based
      if (error.response && error.response.status === 404) {
        log.warn('Upload status endpoint not available, using trust-based confirmation');
        return { persisted: true, verified: false, fallback: true };
      }

      // 401 on the status endpoint after the authenticated POST already
      // landed the bytes — don't punish the user for a polling-side auth
      // problem. Treat as trust-based, the renderer-side poller does the
      // same. See src/services/upload.js pollServerStatus.
      if (error.response && error.response.status === 401) {
        log.warn('Upload status endpoint returned 401; using trust-based confirmation');
        return { persisted: true, verified: false, fallback: true, authError: true };
      }

      log.warn(`Status poll attempt ${attempt + 1} failed:`, error.message);
      if (attempt < maxAttempts - 1) {
        await sleep(pollInterval);
      }
    }
  }

  // Timeout - server didn't confirm in time
  log.error(`Upload verification timeout for ${audioFileId} after ${maxAttempts} attempts`);
  Sentry.captureMessage(`Upload verification timeout: ${audioFileId}`, {
    level: 'error',
    tags: { operation: 'upload_verification' },
    extra: { audioFileId, maxAttempts },
  });
  return { persisted: false, verified: false, error: 'Server confirmation timeout' };
}

/**
 * Poll meeting transcription status after gateway failure.
 * The transcription webhook may complete the meeting while the desktop shows "pending".
 * Polls GET /api/desktop/meeting/{meetingId}/status every 30s for up to 15 minutes.
 */
async function pollMeetingTranscriptionStatus(meetingId, maxAttempts = 30) {
  const pollInterval = 30000; // 30 seconds between polls

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Re-fetch token each iteration to handle expiry during long polls
      const authToken = await getAuthToken();
      if (!authToken) {
        log.warn(`[MeetingPoll] No auth token available for meeting ${meetingId}`);
        return { status: 'AUTH_EXPIRED', resolved: false };
      }

      const response = await axios.get(
        `${API_BASE_URL}/api/desktop/meeting/${meetingId}/status`,
        {
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      if (response.data) {
        const status = response.data.status;

        if (status === 'COMPLETED') {
          log.info(`[MeetingPoll] Meeting ${meetingId} transcription completed`);
          return { status: 'COMPLETED', resolved: true };
        }

        if (status === 'FAILED') {
          log.warn(`[MeetingPoll] Meeting ${meetingId} transcription failed`);
          return { status: 'FAILED', resolved: true };
        }

        // Still PROCESSING — continue polling
        log.info(`[MeetingPoll] Meeting ${meetingId} still ${status} (attempt ${attempt + 1}/${maxAttempts})`);
      }

      if (attempt < maxAttempts - 1) {
        await sleep(pollInterval);
      }
    } catch (error) {
      if (error.response && error.response.status === 404) {
        log.warn(`[MeetingPoll] Status endpoint not available for meeting ${meetingId}`);
        return { status: 'UNKNOWN', resolved: false };
      }
      log.warn(`[MeetingPoll] Poll attempt ${attempt + 1} failed:`, error.message);
      if (attempt < maxAttempts - 1) {
        await sleep(pollInterval);
      }
    }
  }

  log.warn(`[MeetingPoll] Timeout for meeting ${meetingId} after ${maxAttempts} attempts`);
  return { status: 'TIMEOUT', resolved: false };
}

// Helper: Upload with retry logic.
//
// New flow (direct-to-Azure-Blob via SAS):
//   - POST /api/uploads/init → server returns SAS URL + block size
//   - PUT each block directly to Azure (bypasses our app server)
//   - PUT block list to commit
//   - POST /api/uploads/complete → server creates meeting + dispatches transcription
//
// Legacy flow (formData POST to /api/desktop/upload) is still kept for
// backward compatibility — used when:
//   1. Server is in local-storage mode (returns mode: 'fallback' from init)
//   2. /api/uploads/init returns 404 (older backend without these routes)
//   3. /api/uploads/init returns 400 "durationSeconds is required" — the
//      client's ffprobe duration probe failed (e.g. AV blocking ffprobe.exe
//      on Windows). The legacy POST does its own server-side probe so it
//      doesn't need a client-supplied duration.
async function uploadWithRetry(recordId, filePath, metadata, maxRetries = 3) {
  const abortController = new AbortController();
  activeAbortControllers.set(recordId, abortController);

  try {
    // === Phase 1: Try direct-to-Azure-Blob upload ===
    const directResult = await tryDirectUpload({
      recordId,
      filePath,
      metadata,
      abortController,
      maxRetries,
    });

    if (directResult.handled) {
      // Direct flow either succeeded or failed terminally — do not run legacy.
      return directResult.result;
    }
    log.info(`[upload] Direct flow not available for ${recordId} (${directResult.reason}); falling back to legacy POST`);

    // === Phase 2: Legacy formData POST fallback ===
    return await uploadWithRetryLegacy(recordId, filePath, metadata, maxRetries, abortController);
  } finally {
    activeAbortControllers.delete(recordId);
    activeDirectAudioFileIds.delete(recordId);
  }
}

/**
 * Try the new direct-to-Azure-Blob upload path. Returns:
 *   { handled: true, result } — finished (success or terminal failure)
 *   { handled: false, reason } — caller should run the legacy fallback
 */
async function tryDirectUpload({ recordId, filePath, metadata, abortController, maxRetries }) {
  const authToken = await getAuthToken();
  if (!authToken) {
    return {
      handled: true,
      result: { success: false, error: 'Not authenticated. Please login first.', canRetry: false },
    };
  }

  // Notify renderer that upload started so the UI shows progress immediately
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('upload:started', { recordId });
  }

  const onProgress = ({ progress, bytesUploaded, bytesTotal }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload:progress', {
        recordId,
        progress,
        bytesUploaded,
        bytesTotal,
      });
    }
  };

  let lastTransientError;
  // Outer retry handles transient init/complete failures. Per-block retry
  // is handled inside upload-direct.js — we don't double-retry blocks.
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(15_000, 2000 * Math.pow(2, attempt - 1));
      log.info(`[upload] Direct retry attempt ${attempt}/${maxRetries} after ${delay}ms`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('upload:retry', { recordId, attempt, maxRetries });
      }
      await sleep(delay);
    }

    if (abortController.signal.aborted) {
      return {
        handled: true,
        result: { success: false, error: 'Upload cancelled', cancelled: true, canRetry: false },
      };
    }

    let result;
    try {
      result = await uploadViaPresignedSas({
        apiBaseUrl: API_BASE_URL,
        authToken: await getAuthToken(),
        recordId,
        filePath,
        metadata,
        abortController,
        ffmpeg,
        onProgress,
        onSession: ({ audioFileId }) => {
          // Track for upload:cancel cleanup. Cleared when this function returns.
          if (audioFileId) {
            activeDirectAudioFileIds.set(recordId, audioFileId);
          }
        },
      });
    } catch (err) {
      // Bubbled-up transient error from upload-direct → retry.
      lastTransientError = err;
      log.warn(`[upload] Direct upload transient error attempt ${attempt + 1}: ${err.message}`);
      if (attempt >= maxRetries) {
        Sentry.captureException(err, {
          tags: { operation: 'upload-direct', recordId },
          extra: { attempt: attempt + 1, maxRetries },
        });
        return {
          handled: true,
          result: {
            success: false,
            error: err.message || 'Upload failed after all retry attempts',
            canRetry: true,
          },
        };
      }
      continue;
    }

    if (result.mode === 'fallback') {
      return { handled: false, reason: 'server requested local-storage fallback' };
    }

    if (result.success) {
      return { handled: true, result };
    }

    if (result.cancelled) {
      return { handled: true, result };
    }

    // Direct flow returned a terminal failure — do not retry, do not fall back…
    // …unless the failure indicates the backend simply doesn't speak the SAS
    // protocol or rejects our (sometimes-zero) client-probed duration. In
    // those cases the legacy multipart POST path can still succeed because
    // the server probes duration itself and has no SAS routing requirement.
    if (result.canRetry === false) {
      if (result.status === 404) {
        log.info(
          `[upload] /api/uploads/init returned 404 for ${recordId} — backend lacks SAS routes; falling back to legacy POST`
        );
        return { handled: false, reason: 'init returned 404 (legacy backend)' };
      }
      if (
        result.status === 400 &&
        /durationSeconds.*required/i.test(result.error || '')
      ) {
        log.warn(
          `[upload] /api/uploads/init rejected ${recordId} for missing durationSeconds (likely ffprobe spawn failure on client); falling back to legacy POST so the server can probe`
        );
        return { handled: false, reason: 'init rejected missing durationSeconds' };
      }
      Sentry.captureMessage(`Upload terminal failure: ${result.error}`, {
        level: 'warning',
        tags: { operation: 'upload-direct', recordId, status: String(result.status || 0) },
      });
      return { handled: true, result };
    }

    // Retryable failure — go around the loop.
    log.warn(`[upload] Direct upload retryable failure attempt ${attempt + 1}: ${result.error}`);
  }

  // Exhausted retries on a retryable error
  return {
    handled: true,
    result: {
      success: false,
      error: lastTransientError?.message || 'Upload failed after all retry attempts',
      canRetry: true,
    },
  };
}

// Legacy formData POST upload path — only invoked when the backend
// reports it is in local-storage mode (no Azure SAS available).
async function uploadWithRetryLegacy(recordId, filePath, metadata, maxRetries, abortController) {
  const retryDelays = [0, 2000, 5000, 10000]; // Exponential backoff

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Define progress tracking variables at loop scope so catch block can access them
    let progressInterval = null;
    const stopProgressUpdates = () => {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    };

    try {
      // Wait before retry (except first attempt)
      if (attempt > 0) {
        const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
        console.log(`Upload retry attempt ${attempt}/${maxRetries} after ${delay}ms`);

        // Notify renderer about retry
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('upload:retry', {
            recordId,
            attempt,
            maxRetries
          });
        }

        await sleep(delay);
      }

      const authToken = await getAuthToken();
      if (!authToken) {
        return { success: false, error: 'Not authenticated. Please login first.', canRetry: false };
      }

      const fileStats = await fs.promises.stat(filePath);

      const FormData = require('form-data');
      const formData = new FormData();

      // Detect content type based on file extension
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.webm': 'audio/webm',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
        '.aac': 'audio/aac',
        '.mov': 'video/quicktime',
        '.m4v': 'video/mp4',
        '.mpeg': 'video/mpeg',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
        '.opus': 'audio/opus',
        '.wma': 'audio/x-ms-wma',
        '.amr': 'audio/amr',
        '.3gp': 'video/3gpp'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      // Use stream instead of buffer for efficient memory usage
      const fileStream = fs.createReadStream(filePath);
      formData.append('audio', fileStream, {
        filename: path.basename(filePath),
        contentType: contentType,
        knownLength: fileStats.size
      });

      formData.append('metadata', JSON.stringify({
        recordId,
        duration: metadata?.duration || 0,
        timestamp: new Date().toISOString(),
        ...metadata
      }));

      // Time-based progress estimation for more realistic UX
      const uploadStartTime = Date.now();
      const fileSizeBytes = fileStats.size;
      // Estimate: assume ~1.5 MB/s upload + 10 sec server processing
      const estimatedUploadMs = (fileSizeBytes / (1.5 * 1024 * 1024)) * 1000 + 10000;

      let lastProgress = 0;

      // Update progress based on elapsed time (more realistic than axios progress)
      const startProgressUpdates = () => {
        progressInterval = setInterval(() => {
          const elapsed = Date.now() - uploadStartTime;
          // Calculate progress based on time, cap at 95% until complete
          const timeProgress = Math.min(95, Math.round((elapsed / estimatedUploadMs) * 100));

          if (timeProgress !== lastProgress && mainWindow && !mainWindow.isDestroyed()) {
            lastProgress = timeProgress;
            mainWindow.webContents.send('upload:progress', {
              recordId,
              progress: timeProgress,
              bytesUploaded: Math.round((timeProgress / 100) * fileSizeBytes),
              bytesTotal: fileSizeBytes,
              attempt: attempt + 1,
              maxRetries: maxRetries + 1
            });
          }
        }, 500);
      };

      startProgressUpdates();

      const uploadUrl = `${API_BASE_URL}/api/desktop/upload`;
      const uploadTimeout = calculateUploadTimeout(fileStats.size);
      log.info('Uploading to:', uploadUrl);
      log.info('Upload config:', {
        fileSize: fileStats.size,
        fileSizeMB: (fileStats.size / (1024 * 1024)).toFixed(2),
        timeout: uploadTimeout,
        timeoutMinutes: (uploadTimeout / 60000).toFixed(1),
        hasAuthToken: !!authToken
      });
      // SECURITY: Token logging removed (P0 Security Fix)

      const response = await axios.post(uploadUrl, formData, {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${authToken}`,
          'X-Desktop-App-Version': app.getVersion()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: uploadTimeout,  // Dynamic timeout based on file size
        signal: abortController.signal
      });
      log.info('Upload response received:', response.status);

      // Stop progress updates
      stopProgressUpdates();

      // Log full response for debugging
      console.log('Upload response status:', response.status);
      console.log('Upload response data:', JSON.stringify(response.data, null, 2));

      if (response.data && response.data.success) {
        console.log('Upload HTTP response successful:', response.data);

        // === Two-Phase Verification (P0 Data Loss Fix) ===
        // Don't trust HTTP 200 alone - verify server actually persisted the file
        const audioFileId = response.data.audioFileId;

        if (audioFileId) {
          log.info('Starting two-phase verification for:', audioFileId);

          // Send 100% progress to UI while verifying
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('upload:progress', {
              recordId,
              progress: 100,
              bytesUploaded: fileSizeBytes,
              bytesTotal: fileSizeBytes,
              status: 'verifying'
            });
          }

          const verification = await pollServerStatus(audioFileId);

          if (!verification.persisted) {
            // Server did NOT confirm persistence - DO NOT allow file deletion
            log.error('Server did not confirm file persistence:', verification.error);
            return {
              success: false,
              audioFileId: response.data.audioFileId,
              transcriptionId: response.data.transcriptionId,
              canDelete: false,
              error: verification.error || 'Server did not confirm file persistence'
            };
          }

          log.info('Two-phase verification complete:', {
            audioFileId,
            verified: verification.verified,
            fallback: verification.fallback
          });
        }

        // Verification passed (or fallback mode) - safe to delete
        return {
          success: true,
          audioFileId: response.data.audioFileId,
          transcriptionId: response.data.transcriptionId,
          meetingId: response.data.meetingId,
          message: response.data.message,
          gatewayFailed: response.data.gatewayFailed || false,
          canDelete: true,
          verified: true
        };
      } else {
        stopProgressUpdates();
        throw new Error(response.data?.error || 'Upload failed');
      }
    } catch (error) {
      stopProgressUpdates();

      // If the upload was cancelled via AbortController, exit immediately
      if (abortController.signal.aborted) {
        log.info(`Upload cancelled for ${recordId}`);
        return { success: false, error: 'Upload cancelled', cancelled: true, canRetry: false };
      }

      log.error(`Upload attempt ${attempt + 1} failed:`, {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        statusText: error.response?.statusText,
        responseData: error.response?.data,
        isTimeout: error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED'
      });

      // Check for authentication errors (401) - don't retry these
      if (error.response && error.response.status === 401) {
        const errorMessage = error.response.data?.error || error.response.data?.message || 'Token expired';
        log.warn('Upload failed due to authentication error:', errorMessage);
        return {
          success: false,
          error: errorMessage,
          status: 401,
          canRetry: false
        };
      }

      // Check for insufficient minutes (402/403 with minutes error) - don't retry these
      if (error.response && (error.response.status === 402 ||
          (error.response.data?.error && /insufficient|minutes|credit|balance/i.test(error.response.data.error)))) {
        const errorMessage = error.response.data?.error || 'Insufficient minutes';
        log.warn('Upload failed due to insufficient minutes:', errorMessage);
        return {
          success: false,
          error: errorMessage,
          status: error.response.status,
          canRetry: false,
          insufficientMinutes: true
        };
      }

      const isRetryable = error.code === 'ECONNREFUSED' ||
                          error.code === 'ETIMEDOUT' ||
                          error.code === 'ECONNABORTED' ||
                          error.code === 'ENOTFOUND' ||
                          error.code === 'ENETUNREACH' ||
                          error.code === 'EAI_AGAIN' ||
                          error.code === 'ECONNRESET' ||
                          (error.message && error.message.includes('socket hang up')) ||
                          (error.response && error.response.status >= 500);

      // If we've exhausted retries or error is not retryable
      if (attempt >= maxRetries || !isRetryable) {
        let errorMessage = 'Upload failed';
        let status = 0;
        if (error.response) {
          errorMessage = error.response.data?.error || `Server error: ${error.response.status}`;
          status = error.response.status;
        } else if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Could not connect to server. Please check your internet connection.';
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
          errorMessage = 'Upload timed out. Please try again.';
        } else if (error.code === 'ENOTFOUND' || error.code === 'ENETUNREACH') {
          errorMessage = 'No internet connection. Please check your network.';
        } else if (error.code === 'ECONNRESET' || (error.message && error.message.includes('socket hang up'))) {
          errorMessage = 'Connection was interrupted. Please try again.';
        } else {
          errorMessage = error.message || 'Unknown error';
        }

        // Report upload failure to Sentry (retries exhausted or non-retryable)
        Sentry.captureException(error, {
          tags: { operation: 'upload', recordId },
          extra: {
            attempt: attempt + 1,
            maxRetries,
            errorCode: error.code,
            httpStatus: status,
            isRetryable,
            isTimeout: error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED',
          },
        });

        return { success: false, error: errorMessage, status, canRetry: isRetryable };
      }
      // Otherwise continue to next retry attempt
    }
  }

  return { success: false, error: 'Upload failed after all retry attempts', canRetry: true };
}

const inFlightUploads = new Set();

ipcMain.handle('upload:start', async (event, params) => {
  const { recordId, filePath, metadata } = params;

  // Prevent duplicate concurrent uploads of the same recording
  if (inFlightUploads.has(recordId)) {
    log.warn(`Upload already in progress for ${recordId}, rejecting duplicate`);
    return { success: false, error: 'Upload already in progress', duplicate: true };
  }
  inFlightUploads.add(recordId);

  // Add to persistent upload queue (survives app restart)
  addToUploadQueue(recordId, filePath, metadata);

  // Mark upload as in progress
  isUploadInProgress = true;
  pendingUploadsCount++;

  try {
    // Notify renderer that upload started
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload:started', { recordId });
    }

    // Clear any previous cancelled state for this recordId (e.g. from a retry)
    cancelledUploads.delete(recordId);

    const result = await uploadWithRetry(recordId, filePath, metadata);

    // Remove from queue on success OR on terminal failure (canRetry === false).
    // The old behavior left non-retryable failures in the queue, where they
    // would be re-attempted on every app launch and 413/402/etc forever.
    // DRD-2: a quit-time abort returns { cancelled: true, canRetry: false }.
    // Unlike a user cancel (routed through upload:cancel, which registers the
    // recordId in cancelledUploads), it must NOT be removed from the queue — we
    // want it to resume on next launch.
    const abortedByQuit = result.cancelled && isQuittingWithUploads && !cancelledUploads.has(recordId);
    if ((result.success || result.canRetry === false) && !abortedByQuit) {
      removeFromUploadQueue(recordId);
      if (!result.success) {
        log.warn(`[upload] Removing terminal-failure ${recordId} from queue (status=${result.status}, error=${result.error})`);
      }
    }

    // Suppress completion event if the upload was cancelled by the user
    if (cancelledUploads.has(recordId)) {
      cancelledUploads.delete(recordId);
      return result;
    }

    // Notify renderer of completion
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload:complete', {
        recordId,
        success: result.success,
        error: result.error
      });
    }

    return result;
  } finally {
    inFlightUploads.delete(recordId);
    pendingUploadsCount--;
    if (pendingUploadsCount <= 0) {
      pendingUploadsCount = 0;
      isUploadInProgress = false;
    }
  }
});

// Keep TUS-based upload for backward compatibility (if needed)
ipcMain.handle('upload:startTUS', async (event, params) => {
  const { recordId, filePath, metadata } = params;
  const authToken = await getAuthToken();

  try {
    const fileStats = await fs.promises.stat(filePath);
    const fileStream = fs.createReadStream(filePath);

    return new Promise((resolve, reject) => {
      const upload = new Upload(fileStream, {
        endpoint: `${API_BASE_URL}/upload`,

        // Chunk size: 25MB
        chunkSize: 25 * 1024 * 1024,

        // Retry configuration
        retryDelays: [0, 1000, 3000, 5000],

        // Metadata to send with upload
        metadata: {
          filename: path.basename(filePath),
          filetype: 'audio/webm',
          recordId: recordId,
          duration: metadata?.duration?.toString() || '0',
          ...metadata
        },

        // Auth headers
        headers: authToken ? {
          'Authorization': `Bearer ${authToken}`
        } : {},

        // Upload size
        uploadSize: fileStats.size,

        // Progress callback
        onProgress: (bytesUploaded, bytesTotal) => {
          const progress = Math.round((bytesUploaded / bytesTotal) * 100);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('upload:progress', {
              recordId,
              progress,
              bytesUploaded,
              bytesTotal
            });
          }
        },

        // Success callback
        onSuccess: () => {
          activeUploads.delete(recordId);
          resolve({ success: true, url: upload.url });
        },

        // Error callback
        onError: (error) => {
          activeUploads.delete(recordId);
          reject(error);
        }
      });

      // Store reference for pause/cancel
      activeUploads.set(recordId, upload);

      // Start upload
      upload.start();
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('upload:pause', async (event, recordId) => {
  const upload = activeUploads.get(recordId);
  if (upload) {
    upload.abort();
    return { success: true };
  }
  return { success: false, error: 'Upload not found' };
});

ipcMain.handle('upload:resume', async (event, recordId) => {
  const upload = activeUploads.get(recordId);
  if (upload) {
    upload.start();
    return { success: true };
  }
  return { success: false, error: 'Upload not found' };
});

ipcMain.handle('upload:cancel', async (event, recordId) => {
  // Mark as cancelled so upload:start suppresses the completion event
  cancelledUploads.add(recordId);

  // Abort the axios-based upload (current flow)
  const controller = activeAbortControllers.get(recordId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(recordId);
  }

  // Best-effort cleanup of staged blob if the cancelled upload used the
  // direct-to-Azure flow. Fires asynchronously — we don't make the user
  // wait for blob deletion before the cancel responds.
  const audioFileId = activeDirectAudioFileIds.get(recordId);
  if (audioFileId) {
    activeDirectAudioFileIds.delete(recordId);
    getAuthToken()
      .then((token) => {
        if (!token) return;
        return abortDirectUpload({
          apiBaseUrl: API_BASE_URL,
          authToken: token,
          recordId,
          audioFileId,
        });
      })
      .catch((e) => log.warn(`[upload:cancel] abort cleanup failed for ${recordId}:`, e?.message));
  }

  // Also handle legacy TUS-based uploads
  const upload = activeUploads.get(recordId);
  if (upload) {
    try {
      await upload.abort(true); // true = terminate on server
    } catch (e) {
      console.warn('Error aborting upload:', e);
    }
    activeUploads.delete(recordId);
  }

  // Remove from persistent upload queue
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
  return await pollMeetingTranscriptionStatus(meetingId);
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
const ALLOWED_EXTERNAL_DOMAINS = ['app.suisse-notes.ch', 'suisse-notes.ch', 'suisse-ai.ch', 'suisse-it.ch'];

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

// --- History Management ---

// Get all recordings from history (filtered by userId)
ipcMain.handle('history:getAll', async (event, userId) => {
  try {
    const recordings = historyStore.get('recordings', []);
    // CRITICAL: Filter by userId to prevent cross-account data leaks
    const userRecordings = userId
      ? recordings.filter(r => r.userId === userId)
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
    const historyEntry = {
      id: recording.id,
      userId: validUserId,  // CRITICAL: Associate with validated user
      createdAt: recording.createdAt || new Date().toISOString(),
      duration: recording.duration || 0,
      fileSize: recording.fileSize || 0,
      filePath: recording.filePath || '',
      uploadStatus: recording.uploadStatus || 'pending',  // pending, uploaded, failed
      storagePreference: recording.storagePreference || 'keep',
      transcriptionId: recording.transcriptionId || null,
      audioFileId: recording.audioFileId || null
    };

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
    recordings[index] = { ...recordings[index], ...safeUpdates };
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
    if (lockedRecordings.includes(id)) {
      log.warn('history:delete blocked - recording is locked for upload:', id);
      return { success: false, error: 'Recording locked - upload in progress' };
    }

    // Delete the file if requested
    if (deleteFile && recording.filePath) {
      try {
        // Delete the recording directory
        const recordingDir = path.dirname(recording.filePath);
        if (fs.existsSync(recordingDir)) {
          await rmDirSafe(recordingDir);
        }
      } catch (e) {
        console.warn('Could not delete recording file:', e);
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

    // Delete all recording files for this user
    for (const recording of userRecordings) {
      // Skip locked recordings
      if (lockedRecordings.includes(recording.id)) {
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
        } catch (e) {
          console.warn('Could not delete recording file:', recording.id, e);
          errorCount++;
        }
      }
    }

    // Remove all user's recordings from history (except locked ones)
    const newRecordings = recordings.filter(r =>
      r.userId !== validUserId || lockedRecordings.includes(r.id)
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

// Export/save a recording's audio file to a user-chosen location (Save As).
// srcPath MUST be a recording inside userData/recordings — validateFilePath
// enforces that, so this handler can never copy an arbitrary file off disk.
ipcMain.handle('dialog:saveFile', async (event, srcPath, suggestedName) => {
  try {
    const validated = validateFilePath(srcPath); // throws if outside recordings dir
    await fs.promises.access(validated); // ensure the source still exists on disk

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Audio',
      defaultPath: suggestedName || path.basename(validated),
      filters: [
        { name: 'Audio', extensions: ['webm', 'm4a', 'mp3', 'opus', 'ogg', 'wav', 'aac'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }

    await fs.promises.copyFile(validated, result.filePath);
    return { success: true, savedPath: result.filePath };
  } catch (error) {
    log.warn('Error saving audio file:', error?.message);
    return { success: false, error: error.message };
  }
});

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

// --- System Audio (AudioTee — macOS 14.2+ Core Audio Taps) ---

let activeAudioTee = null; // { process, writeStream, filePath, recordId }

function getAudioTeeBinaryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'audiotee', 'audiotee');
  }
  // Development: use from resources directly
  return path.join(__dirname, '..', 'resources', 'audiotee', 'audiotee');
}

function isSystemAudioSupported() {
  // Windows: desktopCapturer supports system audio capture
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
    macVersion: process.getSystemVersion?.() || 'unknown'
  };
});

// Start system audio capture — writes PCM to file alongside recording chunks.
// offsetMs is the position on the recording timeline (in milliseconds) at which
// this capture begins. When the user toggles system audio mid-recording, we pad
// the PCM file with leading silence so amix at stop-time aligns the captured
// audio with the mic track. Subsequent toggles within the same recording append
// to the existing file with silence padding for the off-gap.
ipcMain.handle('systemAudio:start', async (event, recordId, offsetMs = 0) => {
  try {
    if (activeAudioTee) {
      log.warn('System audio already active, stopping previous session');
      await stopSystemAudio();
    }

    if (!isSystemAudioSupported()) {
      return { success: false, error: 'System audio requires macOS 14.2+' };
    }

    const binaryPath = getAudioTeeBinaryPath();
    if (!fs.existsSync(binaryPath)) {
      return { success: false, error: 'AudioTee binary not found' };
    }

    const recordPath = getRecordingPath(recordId);
    if (!fs.existsSync(recordPath)) {
      fs.mkdirSync(recordPath, { recursive: true });
    }

    const pcmPath = path.join(recordPath, 'system_audio.raw');

    // 48kHz mono Int16 PCM = 2 bytes/sample * 48 samples/ms = 96 bytes/ms
    const BYTES_PER_MS = 96;
    let existingBytes = 0;
    try {
      if (fs.existsSync(pcmPath)) existingBytes = fs.statSync(pcmPath).size;
    } catch (e) { /* treat as no existing data */ }
    const existingMs = Math.floor(existingBytes / BYTES_PER_MS);
    const requestedOffsetMs = Math.max(0, Math.floor(Number(offsetMs) || 0));
    const padMs = Math.max(0, requestedOffsetMs - existingMs);

    const writeStream = fs.createWriteStream(pcmPath, {
      flags: existingBytes > 0 ? 'a' : 'w'
    });

    if (padMs > 0) {
      const totalSilenceBytes = padMs * BYTES_PER_MS;
      const CHUNK = 64 * 1024;
      const fullChunk = Buffer.alloc(Math.min(CHUNK, totalSilenceBytes));
      let written = 0;
      while (written < totalSilenceBytes) {
        const remaining = totalSilenceBytes - written;
        const buf = remaining >= fullChunk.length ? fullChunk : Buffer.alloc(remaining);
        writeStream.write(buf);
        written += buf.length;
      }
      log.info(`System audio: padded ${padMs}ms of silence to align with recording offset ${requestedOffsetMs}ms`);
    }

    // Spawn audiotee: 48kHz mono Int16 PCM, 200ms chunks
    const proc = require('child_process').spawn(binaryPath, [
      '--sample-rate', '48000',
      '--chunk-duration', '0.2'
    ]);

    let started = false;
    let startError = null;

    proc.stdout.on('data', (data) => {
      writeStream.write(data);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString('utf8');
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.message_type === 'stream_start') {
            started = true;
            log.info('System audio capture started (AudioTee)');
          } else if (msg.message_type === 'error') {
            startError = msg.data?.message || 'Unknown error';
            log.error('AudioTee error:', startError);
          }
        } catch (e) { /* non-JSON stderr output */ }
      }
    });

    proc.on('error', (err) => {
      log.error('AudioTee process error:', err);
      startError = err.message;
    });

    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        log.warn(`AudioTee exited with code ${code}`);
      }
      if (activeAudioTee?.process === proc) {
        activeAudioTee.writeStream.end();
        activeAudioTee = null;
      }
    });

    activeAudioTee = { process: proc, writeStream, filePath: pcmPath, recordId };

    // Wait briefly for startup or error
    await new Promise(r => setTimeout(r, 500));

    if (startError) {
      proc.kill('SIGTERM');
      writeStream.end();
      activeAudioTee = null;
      return { success: false, error: startError };
    }

    return { success: true, filePath: pcmPath };
  } catch (error) {
    log.error('Failed to start system audio:', error);
    return { success: false, error: error.message };
  }
});

// Stop system audio capture
ipcMain.handle('systemAudio:stop', async () => {
  return await stopSystemAudio();
});

async function stopSystemAudio() {
  if (!activeAudioTee) return { success: true };
  try {
    const { process: proc, writeStream, filePath } = activeAudioTee;
    activeAudioTee = null;

    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      // Wait for graceful exit
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
          resolve();
        }, 3000);
        proc.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
    writeStream.end();

    // Verify file was written
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      log.info(`System audio saved: ${filePath} (${fs.statSync(filePath).size} bytes)`);
      return { success: true, filePath };
    }
    return { success: true, filePath: null };
  } catch (error) {
    log.error('Error stopping system audio:', error);
    return { success: false, error: error.message };
  }
}

// Get available desktop capturer sources (used on Windows for system audio)
ipcMain.handle('systemAudio:getSources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      fetchWindowIcons: false
    });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (error) {
    log.error('Error getting desktop sources:', error);
    return [];
  }
});
ipcMain.handle('systemAudio:checkPermission', () => {
  if (isSystemAudioSupported()) return 'granted';
  if (process.platform === 'darwin') return systemPreferences.getMediaAccessStatus('screen');
  return 'granted';
});
ipcMain.handle('config:getSystemAudioEnabled', () => false);
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
