const { contextBridge, ipcRenderer } = require('electron');

// Timeout wrapper for IPC calls to prevent indefinite blocking
function withTimeout(promise, timeoutMs, operationName) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

// Default timeouts for different operations
const IPC_TIMEOUTS = {
  default: 30000,       // 30 seconds for most operations
  save: 10000,          // 10 seconds for chunk saves
  combine: 300000,      // 5 minutes for combining chunks
  upload: 600000,       // 10 minutes minimum for uploads
  auth: 30000,          // 30 seconds for auth operations
  quick: 5000           // 5 seconds for quick operations
};

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // True only during automated E2E runs (packaged app launched with
  // SUISSE_E2E_HOOKS=1). Lets the renderer route Sentry to the `e2e`
  // environment so synthetic mic-health/recovery telemetry never pollutes the
  // real-user (`production`) issue stream. Read synchronously at preload time.
  isE2E: process.env.SUISSE_E2E_HOOKS === '1',

  // Configuration (read-only - no user-configurable URLs)
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    // Renderer inherits the main process's resolved API base URL (fixes the
    // dev-electron renderer silently using production; see main handler).
    getApiUrl: () => ipcRenderer.invoke('config:getApiUrl'),
    getTranscriptionSettings: () => ipcRenderer.invoke('config:getTranscriptionSettings'),
    setTranscriptionSettings: (settings) => ipcRenderer.invoke('config:setTranscriptionSettings', settings)
  },

  // Authentication (simplified - no URL parameter, uses hardcoded backend)
  auth: {
    login: (username, password) =>
      ipcRenderer.invoke('auth:login', username, password),
    register: (email, password, name) =>
      ipcRenderer.invoke('auth:register', email, password, name),
    saveToken: (token) => ipcRenderer.invoke('auth:saveToken', token),
    getToken: () => ipcRenderer.invoke('auth:getToken'),
    clearToken: () => ipcRenderer.invoke('auth:clearToken'),
    saveUserInfo: (userInfo) => ipcRenderer.invoke('auth:saveUserInfo', userInfo),
    getUserInfo: () => ipcRenderer.invoke('auth:getUserInfo'),
    refreshToken: () => ipcRenderer.invoke('auth:refreshToken'),
    createWebSession: () => ipcRenderer.invoke('auth:createWebSession'),
    // SSO via system browser + suissenotes:// custom protocol
    loginWithMicrosoft: () => ipcRenderer.invoke('auth:loginWithMicrosoft'),
    loginWithGoogle: () => ipcRenderer.invoke('auth:loginWithGoogle'),
    onSSOCallback: (callback) => {
      ipcRenderer.on('auth:ssoCallback', (_event, data) => callback(data));
    },
    removeSSOCallbackListener: () => {
      ipcRenderer.removeAllListeners('auth:ssoCallback');
    },
    // Listen for auth expired events from main process
    onExpired: (callback) => {
      ipcRenderer.on('auth:expired', (event, data) => callback(data));
    },
    removeExpiredListener: () => {
      ipcRenderer.removeAllListeners('auth:expired');
    }
  },

  // Minutes / Credits
  minutes: {
    fetch: () =>
      withTimeout(
        ipcRenderer.invoke('minutes:fetch'),
        IPC_TIMEOUTS.auth,
        'Fetch minutes'
      )
  },

  // Recording (WhisperTranscribe pattern)
  recording: {
    createSession: (id, ext, userId) =>
      withTimeout(
        ipcRenderer.invoke('recording:createSession', id, ext, userId),
        IPC_TIMEOUTS.default,
        'Create session'
      ),
    saveChunk: (id, chunkData, chunkIndex, ext, userId) =>
      withTimeout(
        ipcRenderer.invoke('recording:saveChunk', id, chunkData, chunkIndex, ext, userId),
        IPC_TIMEOUTS.save,
        'Save chunk'
      ),
    createSessionFile: (id, ext) =>
      withTimeout(
        ipcRenderer.invoke('recording:createSessionFile', id, ext),
        IPC_TIMEOUTS.combine,
        'Create session file'
      ),
    // expectedDurationSec: the renderer's wall-clock duration, so main can tell
    // whether the combined file really contains the meeting (truncation guard).
    combineChunks: (id, ext, expectedDurationSec) =>
      withTimeout(
        ipcRenderer.invoke('recording:combineChunks', id, ext, expectedDurationSec),
        IPC_TIMEOUTS.combine,
        'Combine chunks'
      ),
    isRecoveryRunning: () => ipcRenderer.invoke('recording:isRecoveryRunning'),
    checkForChunks: (id, ext) =>
      withTimeout(
        ipcRenderer.invoke('recording:checkForChunks', id, ext),
        IPC_TIMEOUTS.quick,
        'Check for chunks'
      ),
    getFilePath: (id, ext) =>
      withTimeout(
        ipcRenderer.invoke('recording:getFilePath', id, ext),
        IPC_TIMEOUTS.quick,
        'Get file path'
      ),
    deleteRecording: (id) =>
      withTimeout(
        ipcRenderer.invoke('recording:deleteRecording', id),
        IPC_TIMEOUTS.default,
        'Delete recording'
      ),
    getFileUrl: (filePath) =>
      withTimeout(
        ipcRenderer.invoke('recording:getFileUrl', filePath),
        IPC_TIMEOUTS.quick,
        'Get file URL'
      ),
    // Disk space check before recording
    checkDiskSpace: () =>
      withTimeout(
        ipcRenderer.invoke('recording:checkDiskSpace'),
        IPC_TIMEOUTS.quick,
        'Check disk space'
      ),
    // Recording state for window close protection
    setInProgress: (inProgress) =>
      ipcRenderer.invoke('recording:setInProgress', inProgress),
    setProcessing: (processing) =>
      ipcRenderer.invoke('recording:setProcessing', processing),
    // Metadata
    saveMetadata: (recordId, metadata) =>
      ipcRenderer.invoke('recording:saveMetadata', recordId, metadata),
    loadMetadata: (recordId) =>
      ipcRenderer.invoke('recording:loadMetadata', recordId),
    // Persistent file locks for upload safety (V6 fix)
    lockForUpload: (recordId) =>
      ipcRenderer.invoke('recording:lockForUpload', recordId),
    unlockAfterUpload: (recordId) =>
      ipcRenderer.invoke('recording:unlockAfterUpload', recordId),
    getLockedRecordings: () =>
      ipcRenderer.invoke('recording:getLockedRecordings')
  },

  // History management (all methods require userId for security)
  history: {
    getAll: (userId) => ipcRenderer.invoke('history:getAll', userId),
    add: (recording) => ipcRenderer.invoke('history:add', recording),
    update: (id, updates, userId) => ipcRenderer.invoke('history:update', id, updates, userId),
    delete: (id, deleteFile, userId) => ipcRenderer.invoke('history:delete', id, deleteFile, userId),
    deleteAll: (userId) => ipcRenderer.invoke('history:deleteAll', userId),
    getDefaultStoragePreference: () =>
      ipcRenderer.invoke('history:getDefaultStoragePreference'),
    setDefaultStoragePreference: (preference) =>
      ipcRenderer.invoke('history:setDefaultStoragePreference', preference)
  },

  // Upload
  upload: {
    start: (params) => ipcRenderer.invoke('upload:start', params),
    pause: (recordId) => ipcRenderer.invoke('upload:pause', recordId),
    resume: (recordId) => ipcRenderer.invoke('upload:resume', recordId),
    cancel: (recordId) => ipcRenderer.invoke('upload:cancel', recordId),
    // Upload queue methods (for offline persistence)
    getPendingQueue: () => ipcRenderer.invoke('upload:getPendingQueue'),
    retryPending: () => ipcRenderer.invoke('upload:retryPending'),
    removeFromQueue: (recordId) => ipcRenderer.invoke('upload:removeFromQueue', recordId),
    pollMeetingStatus: (meetingId) =>
      withTimeout(
        ipcRenderer.invoke('meeting:pollStatus', meetingId),
        960000, // 16 minutes (slightly more than 15min poll timeout)
        'Poll meeting status'
      ),
    onProgress: (callback) => {
      ipcRenderer.on('upload:progress', (event, data) => callback(data));
    },
    onStarted: (callback) => {
      ipcRenderer.on('upload:started', (event, data) => callback(data));
    },
    onRetry: (callback) => {
      ipcRenderer.on('upload:retry', (event, data) => callback(data));
    },
    onComplete: (callback) => {
      ipcRenderer.on('upload:complete', (event, data) => callback(data));
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('upload:progress');
      ipcRenderer.removeAllListeners('upload:started');
      ipcRenderer.removeAllListeners('upload:retry');
      ipcRenderer.removeAllListeners('upload:complete');
    },
    removeProgressListener: () => {
      ipcRenderer.removeAllListeners('upload:progress');
    }
  },

  // Utility
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getUserDataPath: () => ipcRenderer.invoke('app:getUserDataPath')
  },

  // Auto-update prompt (update-ready dialog)
  updater: {
    getStatus: () => ipcRenderer.invoke('updater:getStatus'),
    quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),
    onUpdateDownloaded: (callback) => {
      const handler = (event, info) => callback(info);
      ipcRenderer.on('update:downloaded', handler);
      return () => ipcRenderer.removeListener('update:downloaded', handler);
    }
  },

  // Shell (for opening external URLs and file locations)
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath)
  },

  // Dialog (for file selection)
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    saveFile: (srcPath, suggestedName) => ipcRenderer.invoke('dialog:saveFile', srcPath, suggestedName),
    getDroppedFilePath: (filePath) => ipcRenderer.invoke('dialog:getDroppedFilePath', filePath)
  },

  // System Audio (AudioTee — macOS 14.2+ Core Audio Taps)
  systemAudio: {
    isSupported: () => ipcRenderer.invoke('systemAudio:isSupported'),
    start: (recordId, offsetMs = 0) => ipcRenderer.invoke('systemAudio:start', recordId, offsetMs),
    stop: () => ipcRenderer.invoke('systemAudio:stop'),
    // Legacy (kept for backward compat)
    getSources: () => ipcRenderer.invoke('systemAudio:getSources'),
    diag: (level, message) => ipcRenderer.invoke('systemAudio:diag', level, message),
    checkPermission: () => ipcRenderer.invoke('systemAudio:checkPermission'),
    getEnabled: () => ipcRenderer.invoke('config:getSystemAudioEnabled'),
    setEnabled: (enabled) => ipcRenderer.invoke('config:setSystemAudioEnabled', enabled)
  },

  // Window Controls
  window: {
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
    isFullscreen: () => ipcRenderer.invoke('window:isFullscreen')
  },

  // P0 Data Loss Fix: System events (power/suspend handling)
  system: {
    // Listen for system suspend (laptop lid close, sleep)
    onSuspend: (callback) => {
      ipcRenderer.on('recording:suspend', (event, data) => callback(data));
    },
    // Acknowledge that suspend flush is complete
    sendSuspendAck: () => {
      ipcRenderer.send('recording:suspend-ack');
    },
    // Listen for system resume (wake from sleep)
    onResume: (callback) => {
      ipcRenderer.on('recording:resume', (event, data) => callback(data));
    },
    // Listen for screen lock/unlock
    onScreenLocked: (callback) => {
      ipcRenderer.on('system:screen-locked', (event) => callback());
    },
    onScreenUnlocked: (callback) => {
      ipcRenderer.on('system:screen-unlocked', (event) => callback());
    },
    // Listen for Audio Service crash (macOS ScreenCaptureKit bug)
    onAudioServiceCrashed: (callback) => {
      ipcRenderer.on('system:audio-service-crashed', (event, data) => callback(data));
    },
    // Capture-quality warnings the user MUST see (ffmpeg missing before a
    // system-audio meeting, system-audio merge degraded to mic-only, …).
    // Deliberately NOT covered by removeAllListeners: the subscriber is the
    // app-level safety net (App.vue), which must survive RecordPage unmounts.
    onCaptureWarning: (callback) => {
      ipcRenderer.on('system:capture-warning', (event, data) => callback(data));
    },
    // Crash/power-loss recovery finished (main process). Like onCaptureWarning,
    // the subscriber is the app-level safety net and this is deliberately NOT
    // cleared by removeAllListeners so it survives page navigation.
    onRecordingRecovered: (callback) => {
      ipcRenderer.on('recording:recovered', (event, data) => callback(data));
    },
    // Remove all system listeners
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('recording:suspend');
      ipcRenderer.removeAllListeners('recording:resume');
      ipcRenderer.removeAllListeners('system:screen-locked');
      ipcRenderer.removeAllListeners('system:screen-unlocked');
      ipcRenderer.removeAllListeners('system:audio-service-crashed');
    },
    // Get recordings path
    getRecordingsPath: () => ipcRenderer.invoke('system:getRecordingsPath')
  }
});

// Log when preload script is loaded
console.log('Electron preload script loaded');
