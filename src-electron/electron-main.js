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
Sentry.init({
  dsn: 'https://185912b1585eb5138079ae189a6d41ec@o4510659364716544.ingest.de.sentry.io/4510659366748240',
  environment: app.isPackaged ? 'production' : 'development',
  release: `suisse-notes@${app.getVersion()}`,
  beforeSend(event) {
    // Scrub sensitive data from error reports
    if (event.request?.headers?.authorization) {
      event.request.headers.authorization = '[REDACTED]';
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
  log.error('Unhandled Rejection at:', promise, 'reason:', reason);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

// Handle renderer process crashes
app.on('render-process-gone', (event, webContents, details) => {
  log.error('Renderer process gone:', details);
  Sentry.captureMessage(`Renderer crashed: ${details.reason}`, 'error');
});

app.on('child-process-gone', (event, details) => {
  log.error('Child process gone:', details);
  Sentry.captureMessage(`Child process crashed: ${details.reason}`, 'error');
});

// Configure auto-updater logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// Silent auto-update settings
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowDowngrade = false;

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

async function recoverOrphanedRecordings() {
  try {
    const recordingsPath = getRecordingsPath();
    if (!fs.existsSync(recordingsPath)) {
      log.info('No recordings directory found, skipping recovery');
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
        const hasChunks = fs.existsSync(chunksPath) &&
          fs.readdirSync(chunksPath).filter(f => f.startsWith('chunk_')).length > 0;
        const hasSessions = fs.existsSync(sessionsPath) &&
          fs.readdirSync(sessionsPath).filter(f => f.endsWith('.webm') && !f.includes('_raw')).length > 0;

        if (!hasChunks && !hasSessions) continue;

        log.info(`Attempting to recover orphaned recording: ${dir}`);

        // Try to combine the chunks
        const result = await combineChunksForRecovery(dir);

        if (result.success) {
          recoveredCount++;
          log.info(`Successfully recovered recording: ${dir} (${result.fileSizeMb}MB)`);

          // Add to history with "recovered" status
          // We'll use a default userId if we can't determine the original user
          const recordings = historyStore.get('recordings', []);
          const existingRecording = recordings.find(r => r.id === dir);

          if (!existingRecording) {
            // Create a new history entry for the recovered recording
            const recoveredEntry = {
              id: dir,
              userId: activeSession?.userId || 'unknown',
              createdAt: activeSession?.startedAt || new Date().toISOString(),
              duration: 0, // Unknown duration
              fileSize: parseFloat(result.fileSizeMb) * 1024 * 1024,
              filePath: result.outputPath,
              uploadStatus: 'pending',
              storagePreference: 'keep',
              recovered: true // Mark as recovered
            };
            recordings.push(recoveredEntry);
            historyStore.set('recordings', recordings);
            log.info(`Added recovered recording to history: ${dir}`);
          }
        } else {
          log.warn(`Could not recover recording ${dir}: ${result.error}`);
        }
      } catch (err) {
        log.error(`Error processing directory ${dir} for recovery:`, err);
      }
    }

    // Clear the active recording state after recovery attempt
    clearActiveRecording();

    if (recoveredCount > 0) {
      log.info(`Recovery complete: ${recoveredCount} recording(s) recovered`);
    }
  } catch (error) {
    log.error('Error during orphaned recording recovery:', error);
    Sentry.captureException(error);
  }
}

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
        await fs.promises.rm(sessionsPath, { recursive: true, force: true });
        if (fs.existsSync(chunksPath)) {
          await fs.promises.rm(chunksPath, { recursive: true, force: true });
        }

        const stats = fs.statSync(outputPath);
        return {
          success: true,
          outputPath,
          fileSizeMb: (stats.size / (1024 * 1024)).toFixed(2)
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
        await fs.promises.rm(sessionsPath, { recursive: true, force: true });
        if (fs.existsSync(chunksPath)) {
          await fs.promises.rm(chunksPath, { recursive: true, force: true });
        }

        const stats = fs.statSync(outputPath);
        return {
          success: true,
          outputPath,
          fileSizeMb: (stats.size / (1024 * 1024)).toFixed(2)
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
        await fs.promises.rm(chunksPath, { recursive: true, force: true });

        const stats = fs.statSync(outputPath);
        if (stats.size < MIN_RECORDING_SIZE) {
          fs.unlinkSync(outputPath);
          return { success: false, error: 'Recording too short or empty' };
        }

        return {
          success: true,
          outputPath,
          fileSizeMb: (stats.size / (1024 * 1024)).toFixed(2)
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
            log.info(`Cleaning up old orphaned directory: ${dir} (age: ${Math.round((now - stats.mtimeMs) / (24 * 60 * 60 * 1000))} days)`);
            await fs.promises.rm(dirPath, { recursive: true, force: true });
            cleanedCount++;
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

// Process pending uploads on app startup
async function processPendingUploads() {
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
      }
    } catch (e) {
      log.error(`Failed to upload ${upload.recordId}:`, e.message);
    }

    // Wait 5 seconds between uploads to avoid overwhelming the server
    await new Promise(r => setTimeout(r, 5000));
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

// Track if upload is in progress to prevent window close
let isUploadInProgress = false;
let pendingUploadsCount = 0;

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
  const iconPath = path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1020,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    icon: iconPath,
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prevent close during recording, processing, or upload
  mainWindow.on('close', (e) => {
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
      log.info('Recording in progress during suspend - saving state');

      // Notify renderer to flush current data
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording:suspend', {
          reason: 'system_suspend',
          timestamp: Date.now()
        });
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

  // === Auto-Update: Check for updates silently ===
  // Only check in production (packaged app)
  if (app.isPackaged) {
    // Check for updates on startup
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
      log.error('Auto-update check failed:', err);
    });

    // Re-check every 4 hours while app is running
    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(err => {
        log.error('Periodic auto-update check failed:', err);
      });
    }, 4 * 60 * 60 * 1000);
  }

  // === Recover Orphaned Recordings ===
  // Run 5 seconds after startup to recover any crashed recordings
  setTimeout(() => {
    recoverOrphanedRecordings().catch(err => {
      log.error('Error recovering orphaned recordings:', err);
    });
  }, 5000);

  // === Cleanup Old Orphaned Directories ===
  // Run 10 seconds after startup (after recovery) to clean up old orphans
  setTimeout(() => {
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
      const { dialog, shell } = require('electron');
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
function getDeviceId() {
  let deviceId = configStore.get('deviceId');
  if (!deviceId) {
    deviceId = `device_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    configStore.set('deviceId', deviceId);
  }
  return deviceId;
}

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
  return { success: true };
});

// Save user info (for session restoration)
ipcMain.handle('auth:saveUserInfo', async (event, userInfo) => {
  try {
    configStore.set('userInfo', userInfo);
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
ipcMain.handle('auth:createWebSession', async () => {
  try {
    const authToken = await getAuthToken();
    if (!authToken) {
      return { success: false, error: 'Not authenticated' };
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

// --- Recording (WhisperTranscribe Patterns) ---

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

// Helper: Get audio metadata via ffprobe
function getAudioMetadata(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

// Helper: Validate chunk sequence is continuous (0, 1, 2, 3...)
function validateChunkSequence(chunks, ext) {
  const sorted = sortChunksNumerically(chunks, ext);
  const missingChunks = [];
  for (let i = 0; i < sorted.length; i++) {
    const actualIndex = parseInt(sorted[i].replace('chunk_', '').replace(ext, ''), 10);
    if (actualIndex !== i) {
      // Found a gap - record all missing indices
      for (let missing = i; missing < actualIndex; missing++) {
        missingChunks.push(missing);
      }
    }
  }
  return {
    valid: missingChunks.length === 0,
    missingChunks,
    message: missingChunks.length > 0
      ? `Warning: Missing chunks detected (indices: ${missingChunks.slice(0, 5).join(', ')}${missingChunks.length > 5 ? '...' : ''}). Audio may have gaps.`
      : ''
  };
}

// Helper: Combine chunks using streaming to avoid memory issues with large files
async function combineChunksStreaming(chunksPath, sortedChunks, outputPath) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(outputPath);

    writeStream.on('finish', () => resolve());
    writeStream.on('error', (err) => reject(err));

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
        reject(err);
      }
    })();
  });
}

// Minimum file size for valid recording (1KB)
const MIN_RECORDING_SIZE = 1024;

// Calculate dynamic upload timeout based on file size
// Assumes worst-case 100KB/s upload speed with 50% buffer
function calculateUploadTimeout(fileSizeBytes) {
  const minTimeout = 600000; // 10 minutes minimum
  const bytesPerSecond = 100 * 1024; // 100KB/s worst case
  const estimatedTimeMs = (fileSizeBytes / bytesPerSecond) * 1000;
  const timeoutWithBuffer = estimatedTimeMs * 1.5; // 50% buffer
  return Math.max(minTimeout, timeoutWithBuffer);
}

// FFmpeg operation timeout (5 minutes default)
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;

// Execute FFmpeg command with timeout
function ffmpegWithTimeout(ffmpegCommand, timeoutMs = FFMPEG_TIMEOUT_MS, operationName = 'FFmpeg') {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      log.warn(`${operationName} operation timed out after ${timeoutMs}ms`);
      try {
        ffmpegCommand.kill('SIGKILL');
      } catch (e) {
        log.error('Error killing FFmpeg process:', e);
      }
      reject(new Error(`${operationName} operation timed out`));
    }, timeoutMs);

    ffmpegCommand
      .on('end', () => {
        clearTimeout(timeoutId);
        resolve();
      })
      .on('error', (err) => {
        clearTimeout(timeoutId);
        reject(err);
      })
      .run();
  });
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
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

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
ipcMain.handle('recording:createSession', async (event, recordId, ext) => {
  try {
    // Validate inputs to prevent path traversal attacks
    const validRecordId = validateRecordId(recordId);
    const validExt = validateExtension(ext);

    // Check disk space before creating session
    const recordingsPath = getRecordingsPath();
    const diskCheck = await canStartRecording(recordingsPath);
    if (!diskCheck.canStart) {
      log.warn('Insufficient disk space to start recording:', diskCheck.freeSpaceMB, 'MB available');
      return { success: false, error: diskCheck.message };
    }

    const recordPath = getRecordingPath(validRecordId);
    const chunksPath = getChunksPath(validRecordId);

    // Create directories synchronously to ensure they exist
    if (!fs.existsSync(recordPath)) {
      fs.mkdirSync(recordPath, { recursive: true });
    }
    if (!fs.existsSync(chunksPath)) {
      fs.mkdirSync(chunksPath, { recursive: true });
    }

    console.log('Recording session created:', recordId);
    return { success: true, path: chunksPath };
  } catch (error) {
    console.error('Error creating session:', error);
    return { success: false, error: error.message };
  }
});

// 2. Save recording chunk - SYNCHRONOUS write (WhisperTranscribe pattern)
ipcMain.handle('recording:saveChunk', async (event, recordId, chunkData, chunkIndex, ext) => {
  try {
    // Validate inputs to prevent path traversal and injection attacks
    const validRecordId = validateRecordId(recordId);
    const validExt = validateExtension(ext);
    const validChunkIndex = validateChunkIndex(chunkIndex);

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

    // CRITICAL: Use SYNCHRONOUS write to ensure chunk is saved before returning
    fs.writeFileSync(chunkPath, buffer);

    // Update active recording state for crash recovery
    updateActiveRecording(validRecordId, validChunkIndex + 1);

    console.log(`Chunk ${chunkIndex} saved (${buffer.length} bytes):`, chunkPath);
    return { success: true, chunkIndex, chunkPath };
  } catch (error) {
    console.error('Error saving chunk:', error);
    return { success: false, error: error.message };
  }
});

// 3. Create session file - combines current chunks into a session (intermediate step)
ipcMain.handle('recording:createSessionFile', async (event, recordId, ext) => {
  try {
    // Validate inputs
    const validRecordId = validateRecordId(recordId);
    const validExt = validateExtension(ext);
    const recordPath = getRecordingPath(validRecordId);
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

    // Validate chunk sequence
    const sequenceCheck = validateChunkSequence(chunks, validExt);
    if (!sequenceCheck.valid) {
      log.warn('Chunk sequence validation:', sequenceCheck.message);
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

    // Process with FFmpeg (codec copy, fallback to re-encode) - with timeout
    try {
      await ffmpegWithTimeout(
        ffmpeg(rawPath)
          .audioCodec('copy')
          .output(finalPath),
        FFMPEG_TIMEOUT_MS,
        'Session file (codec copy)'
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

    // Get duration via ffprobe
    let durationMs = 0;
    try {
      const metadata = await getAudioMetadata(finalPath);
      durationMs = parseFloat(metadata.format.duration) * 1000;
    } catch (e) {
      console.warn('Could not get audio duration:', e);
    }

    // Clean up raw file and chunks
    try {
      fs.unlinkSync(rawPath);
      sortedChunks.forEach(f => fs.unlinkSync(path.join(chunksPath, f)));
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

// 4. Combine recording chunks - final combination with multiple fallbacks
ipcMain.handle('recording:combineChunks', async (event, recordId, ext) => {
  try {
    // Validate inputs
    const validRecordId = validateRecordId(recordId);
    const validExt = validateExtension(ext);

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

          // Cleanup
          await fs.promises.rm(sessionsPath, { recursive: true, force: true });
          if (fs.existsSync(chunksPath)) {
            await fs.promises.rm(chunksPath, { recursive: true, force: true });
          }

          // Clear active recording state - successfully combined
          clearActiveRecording();

          const stats = fs.statSync(outputPath);
          return {
            success: true,
            outputPath,
            filename: outputFile,
            fileSizeMb: (stats.size / (1024 * 1024)).toFixed(2)
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
            'Concat sessions (codec copy)'
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
            // Clean up concat list before throwing
            try { fs.unlinkSync(concatListPath); } catch (e) { /* ignore */ }
            throw new Error(`FFmpeg concat failed: ${reencodeErr.message}`);
          }
        }

        // Cleanup
        fs.unlinkSync(concatListPath);
        await fs.promises.rm(sessionsPath, { recursive: true, force: true });
        if (fs.existsSync(chunksPath)) {
          await fs.promises.rm(chunksPath, { recursive: true, force: true });
        }

        // Clear active recording state - successfully combined
        clearActiveRecording();

        const stats = fs.statSync(outputPath);
        return {
          success: true,
          outputPath,
          filename: outputFile,
          fileSizeMb: (stats.size / (1024 * 1024)).toFixed(2)
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

        // Validate chunk sequence
        const sequenceCheck = validateChunkSequence(chunks, validExt);
        if (!sequenceCheck.valid) {
          log.warn('Chunk sequence validation:', sequenceCheck.message);
        }

        // Use streaming concatenation to avoid memory issues
        await combineChunksStreaming(chunksPath, sortedChunks, outputPath);

        // Cleanup
        await fs.promises.rm(chunksPath, { recursive: true, force: true });

        const stats = fs.statSync(outputPath);

        // Validate file is not empty/too small
        if (stats.size < MIN_RECORDING_SIZE) {
          fs.unlinkSync(outputPath);
          return { success: false, error: 'Recording too short or empty' };
        }

        // Clear active recording state - successfully combined
        clearActiveRecording();

        return {
          success: true,
          outputPath,
          filename: outputFile,
          fileSizeMb: (stats.size / (1024 * 1024)).toFixed(2),
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

  // Validate chunk sequence
  const sequenceCheck = validateChunkSequence(chunks, ext);
  if (!sequenceCheck.valid) {
    log.warn('Chunk sequence validation (internal):', sequenceCheck.message);
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

  // Use timeout-wrapped FFmpeg with fallback
  try {
    await ffmpegWithTimeout(
      ffmpeg(rawPath)
        .audioCodec('copy')
        .output(finalPath),
      FFMPEG_TIMEOUT_MS,
      'Create session file (codec copy)'
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
      console.error('Re-encode also failed:', reencodeErr.message);
      // Clean up raw file before returning error
      try { fs.unlinkSync(rawPath); } catch (e) { /* ignore */ }
      return { success: false, error: `FFmpeg processing failed: ${reencodeErr.message}` };
    }
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
    await fs.promises.rm(recordingDir, { recursive: true, force: true });
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

        if (status === 'persisted' || status === 'complete' || status === 'processing') {
          // Server has confirmed file is persisted
          log.info(`Upload verification successful for ${audioFileId}: status=${status}`);
          return { persisted: true, verified: true };
        }

        if (status === 'failed') {
          log.error(`Server reported upload failed for ${audioFileId}:`, response.data.error);
          return { persisted: false, verified: false, error: response.data.error || 'Server processing failed' };
        }

        // Still processing, wait and retry
        log.info(`Upload status for ${audioFileId}: ${status}, waiting...`);
      }

      await sleep(pollInterval);
    } catch (error) {
      // 404 means endpoint doesn't exist yet - fall back to trust-based
      if (error.response && error.response.status === 404) {
        log.warn('Upload status endpoint not available, using trust-based confirmation');
        return { persisted: true, verified: false, fallback: true };
      }

      log.warn(`Status poll attempt ${attempt + 1} failed:`, error.message);
      if (attempt < maxAttempts - 1) {
        await sleep(pollInterval);
      }
    }
  }

  // Timeout - server didn't confirm in time
  log.error(`Upload verification timeout for ${audioFileId} after ${maxAttempts} attempts`);
  return { persisted: false, verified: false, error: 'Server confirmation timeout' };
}

// Helper: Upload with retry logic
async function uploadWithRetry(recordId, filePath, metadata, maxRetries = 3) {
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
        timeout: uploadTimeout  // Dynamic timeout based on file size
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
          message: response.data.message,
          canDelete: true,
          verified: true
        };
      } else {
        stopProgressUpdates();
        throw new Error(response.data?.error || 'Upload failed');
      }
    } catch (error) {
      stopProgressUpdates();
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

      const isRetryable = error.code === 'ECONNREFUSED' ||
                          error.code === 'ETIMEDOUT' ||
                          error.code === 'ECONNABORTED' ||
                          error.code === 'ENOTFOUND' ||
                          error.code === 'ENETUNREACH' ||
                          error.code === 'EAI_AGAIN' ||
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
        } else {
          errorMessage = error.message || 'Unknown error';
        }

        return { success: false, error: errorMessage, status, canRetry: isRetryable };
      }
      // Otherwise continue to next retry attempt
    }
  }

  return { success: false, error: 'Upload failed after all retry attempts', canRetry: true };
}

ipcMain.handle('upload:start', async (event, params) => {
  const { recordId, filePath, metadata } = params;

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

    const result = await uploadWithRetry(recordId, filePath, metadata);

    // Remove from queue on success
    if (result.success) {
      removeFromUploadQueue(recordId);
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
  const upload = activeUploads.get(recordId);
  if (upload) {
    try {
      await upload.abort(true); // true = terminate on server
    } catch (e) {
      console.warn('Error aborting upload:', e);
    }
    activeUploads.delete(recordId);
    return { success: true };
  }
  return { success: false, error: 'Upload not found' };
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

// --- Utility ---
ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('app:getUserDataPath', () => {
  return app.getPath('userData');
});

// Open external URL in default browser
// Security: Only allow specific trusted domains to prevent malicious URL opening
const ALLOWED_EXTERNAL_DOMAINS = ['app.suisse-notes.ch', 'suisse-notes.ch', 'suisse-ai.ch'];

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

    // Delete the file if requested
    if (deleteFile && recording.filePath) {
      try {
        // Delete the recording directory
        const recordingDir = path.dirname(recording.filePath);
        if (fs.existsSync(recordingDir)) {
          await fs.promises.rm(recordingDir, { recursive: true, force: true });
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

    let deletedCount = 0;
    let errorCount = 0;

    // Delete all recording files for this user
    for (const recording of userRecordings) {
      if (recording.filePath) {
        try {
          const recordingDir = path.dirname(recording.filePath);
          if (fs.existsSync(recordingDir)) {
            await fs.promises.rm(recordingDir, { recursive: true, force: true });
            deletedCount++;
          }
        } catch (e) {
          console.warn('Could not delete recording file:', recording.id, e);
          errorCount++;
        }
      }
    }

    // Remove all user's recordings from history
    const newRecordings = recordings.filter(r => r.userId !== validUserId);
    historyStore.set('recordings', newRecordings);

    console.log(`Deleted ${deletedCount} recordings for user ${validUserId} (${errorCount} errors)`);
    return {
      success: true,
      deletedCount,
      errorCount
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
      duration = Math.round(parseFloat(metadata.format.duration) || 0);
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

// Handle dropped file - get file info from path
ipcMain.handle('dialog:getDroppedFilePath', async (event, filePath) => {
  try {
    const stats = await fs.promises.stat(filePath);
    const filename = path.basename(filePath);

    // Try to get duration via ffprobe
    let duration = 0;
    try {
      const metadata = await getAudioMetadata(filePath);
      duration = Math.round(parseFloat(metadata.format.duration) || 0);
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

// --- System Audio ---

// Get available desktop capturer sources
ipcMain.handle('systemAudio:getSources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      fetchWindowIcons: false
    });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (error) {
    console.error('Error getting desktop sources:', error);
    return [];
  }
});

// Check macOS screen recording permission
ipcMain.handle('systemAudio:checkPermission', () => {
  if (process.platform === 'darwin') {
    return systemPreferences.getMediaAccessStatus('screen');
  }
  return 'granted';
});

// Get system audio enabled setting
ipcMain.handle('config:getSystemAudioEnabled', () => {
  return configStore.get('systemAudioEnabled', false);
});

// Set system audio enabled setting
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
