const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tone', {
  opts: () => ipcRenderer.invoke('opts'),
  log: (m) => ipcRenderer.invoke('log', m),
  done: (code) => ipcRenderer.invoke('done', code),
});
