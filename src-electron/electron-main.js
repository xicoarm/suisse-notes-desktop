const { app, BrowserWindow, ipcMain, safeStorage, protocol, shell, dialog, Menu, desktopCapturer, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const axios = require('axios');
const Store = require('electron-store');
const ffmpeg = require('fluent-ffmpeg');
const { Upload } = require('tus-js-client');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Configure auto-updater logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// Silent auto-update settings
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// HARDCODED API URL - Suisse Notes production server
// No user configuration needed
const API_BASE_URL = 'https://app.suisse-notes.ch';

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

// Set FFmpeg path
if (app.isPackaged) {
  // Production: Use bundled FFmpeg
  const ffmpegPath = path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  const ffprobePath = path.join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe');
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
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

let mainWindow;

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

// Resolve preload path - use environment variable in dev, or relative path in prod
const preloadPath = process.env.QUASAR_ELECTRON_PRELOAD
  ? path.resolve(process.env.QUASAR_ELECTRON_PRELOAD)
  : path.join(__dirname, 'preload', 'electron-preload.cjs');

// Create the main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
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

  // Prevent close during upload
  mainWindow.on('close', (e) => {
    if (isUploadInProgress || pendingUploadsCount > 0) {
      e.preventDefault();

      // Show dialog to user
      const { dialog } = require('electron');
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Upload in Progress',
        message: 'A recording is being uploaded. Please wait for the upload to complete before closing the app.',
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
  protocol.registerFileProtocol('local-audio', (request, callback) => {
    // Extract and decode the file path from the URL
    const url = request.url.replace('local-audio://', '');
    const filePath = decodeURIComponent(url);

    // Return the file
    callback({ path: filePath });
  });

  createWindow();

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
    // Suisse-Notes API authentication
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
      errorMessage = 'Could not connect to Suisse-Notes server';
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
      errorMessage = 'Could not connect to Suisse-Notes server';
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

// 1. Create recording session (creates directories)
ipcMain.handle('recording:createSession', async (event, recordId, ext) => {
  try {
    const recordPath = getRecordingPath(recordId);
    const chunksPath = getChunksPath(recordId);

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
    const recordPath = getRecordingPath(recordId);
    const chunksPath = getChunksPath(recordId);

    // Ensure directories exist (sync)
    if (!fs.existsSync(recordPath)) {
      fs.mkdirSync(recordPath, { recursive: true });
    }
    if (!fs.existsSync(chunksPath)) {
      fs.mkdirSync(chunksPath, { recursive: true });
    }

    const buffer = Buffer.from(chunkData);
    const filename = `chunk_${chunkIndex}${ext}`;
    const chunkPath = path.join(chunksPath, filename);

    // CRITICAL: Use SYNCHRONOUS write to ensure chunk is saved before returning
    fs.writeFileSync(chunkPath, buffer);

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
    const recordPath = getRecordingPath(recordId);
    const chunksPath = getChunksPath(recordId);
    const sessionsPath = getSessionsPath(recordId);

    // Check if chunks directory exists
    if (!fs.existsSync(chunksPath)) {
      return { success: false, error: 'No chunks directory found' };
    }

    // Get and sort chunks
    const allFiles = fs.readdirSync(chunksPath);
    const chunks = allFiles.filter(f => f.startsWith('chunk_') && f.endsWith(ext));

    if (chunks.length === 0) {
      return { success: false, error: 'No chunks found' };
    }

    const sortedChunks = sortChunksNumerically(chunks, ext);

    // Create sessions directory
    if (!fs.existsSync(sessionsPath)) {
      fs.mkdirSync(sessionsPath, { recursive: true });
    }

    const timestamp = Date.now();
    const rawPath = path.join(sessionsPath, `session_${timestamp}_raw${ext}`);
    const finalPath = path.join(sessionsPath, `session_${timestamp}${ext}`);

    // Read and concatenate all chunks (sync)
    const buffers = sortedChunks.map(f => fs.readFileSync(path.join(chunksPath, f)));
    const combined = Buffer.concat(buffers);
    fs.writeFileSync(rawPath, combined);

    console.log(`Combined ${sortedChunks.length} chunks into raw session (${combined.length} bytes)`);

    // Process with FFmpeg (codec copy, fallback to re-encode)
    await new Promise((resolve, reject) => {
      ffmpeg(rawPath)
        .audioCodec('copy')
        .output(finalPath)
        .on('end', () => {
          console.log('Session file created with codec copy');
          resolve();
        })
        .on('error', (err) => {
          console.warn('Codec copy failed, trying re-encode:', err.message);
          // Fallback: re-encode if codec copy fails
          ffmpeg(rawPath)
            .output(finalPath)
            .on('end', () => {
              console.log('Session file created with re-encode');
              resolve();
            })
            .on('error', reject)
            .run();
        })
        .run();
    });

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
    const recordPath = getRecordingPath(recordId);
    const chunksPath = getChunksPath(recordId);
    const sessionsPath = getSessionsPath(recordId);
    const outputFile = `audio${ext}`;
    const outputPath = path.join(recordPath, outputFile);

    console.log('Combining chunks for recording:', recordId);

    // Step 1: If there are current chunks, create a session from them first
    if (fs.existsSync(chunksPath)) {
      const chunkFiles = fs.readdirSync(chunksPath)
        .filter(f => f.startsWith('chunk_') && f.endsWith(ext));

      if (chunkFiles.length > 0) {
        console.log(`Found ${chunkFiles.length} chunks, creating session file...`);
        const sessionResult = await ipcMain.emit('recording:createSessionFile', event, recordId, ext);
        // Note: We call the handler directly below instead
        const result = await createSessionFileInternal(recordId, ext);
        if (!result.success) {
          console.warn('Could not create session from chunks:', result.error);
        }
      }
    }

    // Step 2: Check for session files
    if (fs.existsSync(sessionsPath)) {
      const sessionFiles = fs.readdirSync(sessionsPath)
        .filter(f => f.endsWith(ext) && !f.includes('_raw'))
        .sort((a, b) => {
          // Sort by timestamp in filename
          const tsA = parseInt(a.replace('session_', '').replace(ext, ''), 10);
          const tsB = parseInt(b.replace('session_', '').replace(ext, ''), 10);
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

        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(concatListPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .audioCodec('copy')
            .output(outputPath)
            .on('end', resolve)
            .on('error', (err) => {
              console.warn('FFmpeg concat failed, trying re-encode:', err.message);
              // Fallback: re-encode
              ffmpeg()
                .input(concatListPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .output(outputPath)
                .on('end', resolve)
                .on('error', reject)
                .run();
            })
            .run();
        });

        // Cleanup
        fs.unlinkSync(concatListPath);
        await fs.promises.rm(sessionsPath, { recursive: true, force: true });
        if (fs.existsSync(chunksPath)) {
          await fs.promises.rm(chunksPath, { recursive: true, force: true });
        }

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
        .filter(f => f.startsWith('chunk_') && f.endsWith(ext));

      if (chunks.length > 0) {
        console.log(`Fallback: Direct concatenation of ${chunks.length} chunks`);
        const sortedChunks = sortChunksNumerically(chunks, ext);
        const buffers = sortedChunks.map(f => fs.readFileSync(path.join(chunksPath, f)));
        const combined = Buffer.concat(buffers);
        fs.writeFileSync(outputPath, combined);

        // Cleanup
        await fs.promises.rm(chunksPath, { recursive: true, force: true });

        const stats = fs.statSync(outputPath);
        return {
          success: true,
          outputPath,
          filename: outputFile,
          fileSizeMb: (stats.size / (1024 * 1024)).toFixed(2)
        };
      }
    }

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

  if (!fs.existsSync(sessionsPath)) {
    fs.mkdirSync(sessionsPath, { recursive: true });
  }

  const timestamp = Date.now();
  const rawPath = path.join(sessionsPath, `session_${timestamp}_raw${ext}`);
  const finalPath = path.join(sessionsPath, `session_${timestamp}${ext}`);

  const buffers = sortedChunks.map(f => fs.readFileSync(path.join(chunksPath, f)));
  const combined = Buffer.concat(buffers);
  fs.writeFileSync(rawPath, combined);

  await new Promise((resolve, reject) => {
    ffmpeg(rawPath)
      .audioCodec('copy')
      .output(finalPath)
      .on('end', resolve)
      .on('error', (err) => {
        ffmpeg(rawPath)
          .output(finalPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      })
      .run();
  });

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

// Helper: Upload with retry logic
async function uploadWithRetry(recordId, filePath, metadata, maxRetries = 3) {
  const retryDelays = [0, 2000, 5000, 10000]; // Exponential backoff

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      let progressInterval = null;

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

      const stopProgressUpdates = () => {
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }
      };

      startProgressUpdates();

      const uploadUrl = `${API_BASE_URL}/api/desktop/upload`;
      console.log('Uploading to:', uploadUrl);
      console.log('Auth token (first 20 chars):', authToken ? authToken.substring(0, 20) + '...' : 'NO TOKEN');

      const response = await axios.post(uploadUrl, formData, {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${authToken}`,
          'X-Desktop-App-Version': app.getVersion()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 600000
      });

      // Stop progress updates
      stopProgressUpdates();

      // Log full response for debugging
      console.log('Upload response status:', response.status);
      console.log('Upload response data:', JSON.stringify(response.data, null, 2));

      if (response.data && response.data.success) {
        console.log('Upload successful:', response.data);
        return {
          success: true,
          audioFileId: response.data.audioFileId,
          transcriptionId: response.data.transcriptionId,
          message: response.data.message
        };
      } else {
        stopProgressUpdates();
        throw new Error(response.data?.error || 'Upload failed');
      }
    } catch (error) {
      stopProgressUpdates();
      console.error(`Upload attempt ${attempt + 1} failed:`, error.message);

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
        if (error.response) {
          errorMessage = error.response.data?.error || `Server error: ${error.response.status}`;
        } else if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Could not connect to server. Please check your internet connection.';
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
          errorMessage = 'Upload timed out. Please try again.';
        } else if (error.code === 'ENOTFOUND' || error.code === 'ENETUNREACH') {
          errorMessage = 'No internet connection. Please check your network.';
        } else {
          errorMessage = error.message || 'Unknown error';
        }

        return { success: false, error: errorMessage, canRetry: isRetryable };
      }
      // Otherwise continue to next retry attempt
    }
  }

  return { success: false, error: 'Upload failed after all retry attempts', canRetry: true };
}

ipcMain.handle('upload:start', async (event, params) => {
  const { recordId, filePath, metadata } = params;

  // Mark upload as in progress
  isUploadInProgress = true;
  pendingUploadsCount++;

  try {
    // Notify renderer that upload started
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload:started', { recordId });
    }

    const result = await uploadWithRetry(recordId, filePath, metadata);

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

// --- Utility ---
ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('app:getUserDataPath', () => {
  return app.getPath('userData');
});

// Open external URL in default browser
ipcMain.handle('shell:openExternal', async (event, url) => {
  try {
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
    // CRITICAL: userId is required to prevent cross-account data leaks
    if (!recording.userId) {
      console.error('SECURITY: Attempted to add recording without userId');
      return { success: false, error: 'userId is required' };
    }

    const recordings = historyStore.get('recordings', []);

    // Create history entry with userId
    const historyEntry = {
      id: recording.id,
      userId: recording.userId,  // CRITICAL: Associate with user
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
    // CRITICAL: userId is required to prevent cross-account modifications
    if (!userId) {
      console.error('SECURITY: Attempted to update recording without userId');
      return { success: false, error: 'userId is required' };
    }

    const recordings = historyStore.get('recordings', []);
    const index = recordings.findIndex(r => r.id === id && r.userId === userId);

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
    // CRITICAL: userId is required to prevent cross-account deletions
    if (!userId) {
      console.error('SECURITY: Attempted to delete recording without userId');
      return { success: false, error: 'userId is required' };
    }

    const recordings = historyStore.get('recordings', []);
    const recording = recordings.find(r => r.id === id && r.userId === userId);

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
    const newRecordings = recordings.filter(r => !(r.id === id && r.userId === userId));
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
    // CRITICAL: userId is required to prevent cross-account deletions
    if (!userId) {
      console.error('SECURITY: Attempted to delete all recordings without userId');
      return { success: false, error: 'userId is required' };
    }

    const recordings = historyStore.get('recordings', []);
    const userRecordings = recordings.filter(r => r.userId === userId);

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
    const newRecordings = recordings.filter(r => r.userId !== userId);
    historyStore.set('recordings', newRecordings);

    console.log(`Deleted ${deletedCount} recordings for user ${userId} (${errorCount} errors)`);
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
    // Check if file exists
    await fs.promises.access(filePath);

    // Use custom protocol for local audio files
    // Encode the path to handle special characters
    const encodedPath = encodeURIComponent(filePath);
    return {
      success: true,
      url: `local-audio://${encodedPath}`
    };
  } catch (error) {
    return { success: false, error: 'File not found' };
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
