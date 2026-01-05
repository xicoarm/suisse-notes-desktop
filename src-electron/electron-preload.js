const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Configuration (read-only - no user-configurable URLs)
  config: {
    get: () => ipcRenderer.invoke('config:get')
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
    createWebSession: () => ipcRenderer.invoke('auth:createWebSession')
  },

  // Recording (WhisperTranscribe pattern)
  recording: {
    createSession: (id, ext) =>
      ipcRenderer.invoke('recording:createSession', id, ext),
    saveChunk: (id, chunkData, chunkIndex, ext) =>
      ipcRenderer.invoke('recording:saveChunk', id, chunkData, chunkIndex, ext),
    createSessionFile: (id, ext) =>
      ipcRenderer.invoke('recording:createSessionFile', id, ext),
    combineChunks: (id, ext) =>
      ipcRenderer.invoke('recording:combineChunks', id, ext),
    checkForChunks: (id, ext) =>
      ipcRenderer.invoke('recording:checkForChunks', id, ext),
    getFilePath: (id, ext) =>
      ipcRenderer.invoke('recording:getFilePath', id, ext),
    deleteRecording: (id) =>
      ipcRenderer.invoke('recording:deleteRecording', id),
    getFileUrl: (filePath) =>
      ipcRenderer.invoke('recording:getFileUrl', filePath)
  },

  // History management (all methods require userId for security)
  history: {
    getAll: (userId) => ipcRenderer.invoke('history:getAll', userId),
    add: (recording) => ipcRenderer.invoke('history:add', recording),
    update: (id, updates, userId) => ipcRenderer.invoke('history:update', id, updates, userId),
    delete: (id, deleteFile, userId) => ipcRenderer.invoke('history:delete', id, deleteFile, userId),
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
  }
});

// Log when preload script is loaded
console.log('Electron preload script loaded');
