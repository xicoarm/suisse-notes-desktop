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
  // Configuration (read-only - no user-configurable URLs)
  config: {
    get: () => ipcRenderer.invoke('config:get'),
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
    createWebSession: () => ipcRenderer.invoke('auth:createWebSession'),
    // Listen for auth expired events from main process
    onExpired: (callback) => {
      ipcRenderer.on('auth:expired', (event, data) => callback(data));
    },
    removeExpiredListener: () => {
      ipcRenderer.removeAllListeners('auth:expired');
    }
  },

  // Recording (WhisperTranscribe pattern)
  recording: {
    createSession: (id, ext) =>
      withTimeout(
        ipcRenderer.invoke('recording:createSession', id, ext),
        IPC_TIMEOUTS.default,
        'Create session'
      ),
    saveChunk: (id, chunkData, chunkIndex, ext) =>
      withTimeout(
        ipcRenderer.invoke('recording:saveChunk', id, chunkData, chunkIndex, ext),
        IPC_TIMEOUTS.save,
        'Save chunk'
      ),
    createSessionFile: (id, ext) =>
      withTimeout(
        ipcRenderer.invoke('recording:createSessionFile', id, ext),
        IPC_TIMEOUTS.combine,
        'Create session file'
      ),
    combineChunks: (id, ext) =>
      withTimeout(
        ipcRenderer.invoke('recording:combineChunks', id, ext),
        IPC_TIMEOUTS.combine,
        'Combine chunks'
      ),
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
      ipcRenderer.invoke('recording:loadMetadata', recordId)
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

  // Shell (for opening external URLs)
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },

  // Dialog (for file selection)
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    getDroppedFilePath: (filePath) => ipcRenderer.invoke('dialog:getDroppedFilePath', filePath)
  },

  // System Audio (for capturing system sounds)
  systemAudio: {
    getSources: () => ipcRenderer.invoke('systemAudio:getSources'),
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
    // Remove all system listeners
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('recording:suspend');
      ipcRenderer.removeAllListeners('recording:resume');
      ipcRenderer.removeAllListeners('system:screen-locked');
      ipcRenderer.removeAllListeners('system:screen-unlocked');
    },
    // Get recordings path
    getRecordingsPath: () => ipcRenderer.invoke('system:getRecordingsPath')
  }
});

// Log when preload script is loaded
console.log('Electron preload script loaded');
