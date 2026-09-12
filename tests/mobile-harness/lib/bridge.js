/**
 * Native-bridge shim — the "phone" side of the Capacitor bridge.
 *
 * Injected before the app bundle runs. It makes @capacitor/core believe it is
 * on a native platform (androidBridge / webkit.messageHandlers.bridge) and
 * routes every plugin call through `Capacitor.nativePromise` /
 * `Capacitor.nativeCallback` — exactly the mechanism the real native shells
 * use — into JavaScript implementations here:
 *
 *   Filesystem       → the harness device server (real files on disk, so the
 *                      forensic verifier can decode what the app produced)
 *   Preferences      → localStorage (survives a page reload = app relaunch)
 *   Device / App / Network / StatusBar / LocalNotifications / Share / Browser
 *   BackgroundRecording (foreground service + chunk combiner) → device server
 *   BluetoothLe      → the virtual recorder (installVirtualRecorder)
 *   SSOAuth          → cancelled sign-in
 *
 * No production code path is bypassed: platform detection, storage layout
 * (Directory.External on Android, Documents on iOS), the upload readBlob
 * strategy (convertFileSrc on Android, base64 fallback on iOS) and every
 * plugin call run through the same code as on a phone.
 */
'use strict';

function installBridge(cfg) {
  const platform = cfg.platform === 'ios' ? 'ios' : 'android';
  const deviceUrl = cfg.deviceUrl;               // http://localhost:<port>
  const state = {
    diskFree: cfg.diskFree ?? 20 * 1024 * 1024 * 1024,
    battery: cfg.battery ?? 0.85,
    charging: false,
    network: { connected: true, connectionType: 'wifi' },
    notifications: [],
    shares: [],
    browserOpens: [],
    events: [],
    appActive: true
  };
  const listeners = new Map(); // `${plugin}|${event}` -> Map(callbackId -> cb)
  let callbackSeq = 0;

  if (platform === 'android') {
    window.androidBridge = { postMessage() { /* never used: nativePromise below */ } };
  } else {
    window.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
  }
  window.WEBVIEW_SERVER_URL = platform === 'android' ? 'http://localhost' : 'capacitor://localhost';

  const err = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  const emit = (plugin, event, data) => {
    const m = listeners.get(`${plugin}|${event}`);
    if (!m) return;
    for (const cb of [...m.values()]) { try { cb(data); } catch (e) { console.error(`[bridge] listener ${plugin}.${event} failed`, e); } }
  };

  // ---- device server (virtual file system) ---------------------------------
  const fsCall = async (op, body) => {
    const res = await fetch(`${deviceUrl}/__device/fs/${op}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    });
    const json = await res.json();
    if (!res.ok || json.error) throw err(json.error || `fs ${op} failed`, json.code);
    return json;
  };
  const fileUri = (directory, path) => (platform === 'android'
    ? `file:///storage/emulated/0/Android/data/ch.suissenotes.app/files/__${directory}__/${path}`
    : `file:///var/mobile/Containers/Data/Application/E2E/__${directory}__/${path}`);

  const Filesystem = {
    writeFile: (o) => fsCall('writeFile', o).then(r => ({ uri: r.uri })),
    appendFile: (o) => fsCall('appendFile', o),
    readFile: (o) => fsCall('readFile', o).then(r => ({ data: r.data })),
    deleteFile: (o) => fsCall('deleteFile', o),
    mkdir: (o) => fsCall('mkdir', o),
    rmdir: (o) => fsCall('rmdir', o),
    readdir: (o) => fsCall('readdir', o).then(r => ({ files: r.files })),
    stat: (o) => fsCall('stat', o),
    rename: (o) => fsCall('rename', o),
    copy: (o) => fsCall('copy', o).then(r => ({ uri: r.uri })),
    getUri: async ({ path, directory }) => ({ uri: fileUri(directory, path) }),
    checkPermissions: async () => ({ publicStorage: 'granted' }),
    requestPermissions: async () => ({ publicStorage: 'granted' })
  };

  const PREFIX = 'CapacitorStorage.';
  const Preferences = {
    configure: async () => ({}),
    get: async ({ key }) => ({ value: localStorage.getItem(PREFIX + key) }),
    set: async ({ key, value }) => { localStorage.setItem(PREFIX + key, value); return {}; },
    remove: async ({ key }) => { localStorage.removeItem(PREFIX + key); return {}; },
    keys: async () => ({ keys: Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length)) }),
    clear: async () => { for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k); return {}; },
    migrate: async () => ({ migrated: [], existing: [] }),
    removeOld: async () => ({})
  };

  const Device = {
    getInfo: async () => ({
      platform, model: platform === 'android' ? 'Pixel 7' : 'iPhone15,2', manufacturer: platform === 'android' ? 'Google' : 'Apple',
      operatingSystem: platform, osVersion: platform === 'android' ? '14' : '17.5', isVirtual: true, webViewVersion: navigator.userAgent,
      memUsed: 128 * 1024 * 1024, realDiskFree: state.diskFree, diskFree: state.diskFree, realDiskTotal: 128 * 1024 ** 3, diskTotal: 128 * 1024 ** 3
    }),
    getId: async () => ({ identifier: 'e2e-device-id' }),
    getBatteryInfo: async () => ({ batteryLevel: state.battery, isCharging: state.charging }),
    getLanguageCode: async () => ({ value: (navigator.language || 'de').split('-')[0] }),
    getLanguageTag: async () => ({ value: navigator.language || 'de-CH' })
  };

  const App = {
    getInfo: async () => ({ name: 'Suisse Meets', id: 'ch.suissenotes.mobile', build: cfg.build || '39', version: cfg.version || '3.9.37' }),
    getState: async () => ({ isActive: state.appActive }),
    getLaunchUrl: async () => ({}),
    exitApp: async () => ({}),
    minimizeApp: async () => ({})
  };
  const Network = { getStatus: async () => ({ ...state.network }) };
  const StatusBar = {
    setStyle: async () => ({}), setBackgroundColor: async () => ({}), show: async () => ({}), hide: async () => ({}), getInfo: async () => ({ visible: true }),
    setOverlaysWebView: async () => {
      // Mirrors the real plugin: implemented on Android only.
      if (platform === 'ios') throw err('not implemented', 'UNIMPLEMENTED');
      return {};
    }
  };
  const LocalNotifications = {
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
    schedule: async ({ notifications }) => { state.notifications.push(...notifications.map(n => ({ ...n, at: Date.now() }))); return { notifications: notifications.map(n => ({ id: n.id })) }; },
    cancel: async () => ({}), getPending: async () => ({ notifications: [] }), createChannel: async () => ({}), registerActionTypes: async () => ({})
  };
  const Share = { canShare: async () => ({ value: true }), share: async (o) => { state.shares.push(o); return { activityType: 'harness' }; } };
  const Browser = { open: async (o) => { state.browserOpens.push(o); return {}; }, close: async () => ({}) };
  const SSOAuth = { startAuth: async () => { throw err('USER_CANCELED'); } };
  const BackgroundRecording = {
    startForegroundService: async () => ({}), stopForegroundService: async () => ({}),
    startRecording: async () => ({}), stopRecording: async () => ({}), pauseRecording: async () => ({}), resumeRecording: async () => ({}),
    getStatus: async () => ({ isRecording: false, isRecorderActive: false, chunkIndex: 0 }),
    isBatteryOptimized: async () => ({ isOptimized: false }), requestBatteryOptimizationExemption: async () => ({}), openAppSettings: async () => ({}),
    combineChunks: async ({ recordId }) => {
      const res = await fetch(`${deviceUrl}/__device/combine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordId }) });
      return res.json();
    }
  };
  const recorder = () => window.__recorder;
  const BluetoothLe = new Proxy({}, { get: (_, method) => (options) => {
    const r = recorder();
    if (!r) throw err('virtual recorder not installed');
    const fn = r.plugin[method];
    if (!fn) throw err(`BluetoothLe.${String(method)} not implemented in the virtual recorder`, 'UNIMPLEMENTED');
    return fn.call(r.plugin, options);
  } });

  const impls = { Filesystem, Preferences, Device, App, Network, StatusBar, LocalNotifications, Share, Browser, SSOAuth, BackgroundRecording, BluetoothLe };
  const methodNames = {
    Filesystem: ['writeFile', 'appendFile', 'readFile', 'deleteFile', 'mkdir', 'rmdir', 'readdir', 'stat', 'rename', 'copy', 'getUri', 'checkPermissions', 'requestPermissions', 'downloadFile'],
    Preferences: ['configure', 'get', 'set', 'remove', 'keys', 'clear', 'migrate', 'removeOld'],
    Device: ['getInfo', 'getId', 'getBatteryInfo', 'getLanguageCode', 'getLanguageTag'],
    App: ['getInfo', 'getState', 'getLaunchUrl', 'exitApp', 'minimizeApp'],
    Network: ['getStatus'],
    StatusBar: ['setStyle', 'setBackgroundColor', 'show', 'hide', 'getInfo', 'setOverlaysWebView'],
    LocalNotifications: ['checkPermissions', 'requestPermissions', 'schedule', 'cancel', 'getPending', 'createChannel', 'registerActionTypes'],
    Share: ['canShare', 'share'],
    Browser: ['open', 'close'],
    SSOAuth: ['startAuth'],
    BackgroundRecording: ['startForegroundService', 'stopForegroundService', 'startRecording', 'stopRecording', 'pauseRecording', 'resumeRecording', 'getStatus', 'isBatteryOptimized', 'requestBatteryOptimizationExemption', 'openAppSettings', 'combineChunks'],
    BluetoothLe: ['initialize', 'isEnabled', 'requestEnable', 'isLocationEnabled', 'setDisplayStrings', 'startEnabledNotifications', 'stopEnabledNotifications', 'requestLEScan', 'stopLEScan', 'getDevices', 'getConnectedDevices', 'connect', 'disconnect', 'startNotifications', 'stopNotifications', 'writeWithoutResponse', 'write', 'read', 'readRssi', 'requestConnectionPriority', 'getMtu', 'discoverServices', 'getServices', 'createBond', 'isBonded', 'openAppSettings', 'openBluetoothSettings', 'openLocationSettings', 'requestDevice']
  };
  const PluginHeaders = Object.entries(methodNames).map(([name, methods]) => ({
    name,
    methods: [
      ...methods.map(m => ({ name: m, rtype: 'promise' })),
      { name: 'addListener', rtype: 'callback' },
      { name: 'removeListener', rtype: 'promise' },
      { name: 'removeAllListeners', rtype: 'promise' }
    ]
  }));

  const nativePromise = (pluginName, method, options) => {
    const impl = impls[pluginName];
    if (!impl) return Promise.reject(err(`"${pluginName}" plugin is not implemented on ${platform}`, 'UNIMPLEMENTED'));
    if (method === 'removeListener') {
      listeners.get(`${pluginName}|${options.eventName}`)?.delete(options.callbackId);
      return Promise.resolve({});
    }
    if (method === 'removeAllListeners') {
      for (const k of [...listeners.keys()]) if (k.startsWith(`${pluginName}|`)) listeners.delete(k);
      return Promise.resolve({});
    }
    const fn = impl[method];
    if (!fn) return Promise.reject(err(`"${pluginName}.${method}()" is not implemented on ${platform}`, 'UNIMPLEMENTED'));
    try { return Promise.resolve(fn(options)); } catch (e) { return Promise.reject(e); }
  };
  const nativeCallback = (pluginName, method, options, callback) => {
    if (method !== 'addListener') { nativePromise(pluginName, method, options).then(callback); return String(++callbackSeq); }
    const key = `${pluginName}|${options.eventName}`;
    if (!listeners.has(key)) listeners.set(key, new Map());
    const id = String(++callbackSeq);
    listeners.get(key).set(id, callback);
    if (pluginName === 'BluetoothLe') {
      // Recorder events use the plugin's native event names verbatim.
      const off = recorder()?.addListener(options.eventName, callback);
      listeners.get(key).set(id, (d) => { callback(d); });
      if (off) listeners.get(key).set(`${id}:off`, off);
    }
    return id;
  };

  window.Capacitor = {
    PluginHeaders,
    nativePromise,
    nativeCallback,
    Plugins: {},
    convertFileSrc: (filePath) => {
      if (!filePath) return filePath;
      if (filePath.startsWith('file://')) {
        // Real bridge: file:///<path> → <server>/_capacitor_file_/<path>. The
        // device server maps the persona's path prefix back onto its VFS.
        return `${window.WEBVIEW_SERVER_URL}/_capacitor_file_${filePath.slice(7)}`;
      }
      return filePath;
    }
  };
  if (platform === 'android') {
    // Android serves http://localhost/_capacitor_file_/… from the WebView's
    // own server; in the harness that server is the device server.
    window.WEBVIEW_SERVER_URL = deviceUrl;
  }

  // ---- scenario control surface --------------------------------------------
  window.__harness = Object.assign(window.__harness || {}, {
    platform,
    state,
    setNetwork(connected, connectionType = 'wifi') {
      state.network = { connected, connectionType: connected ? connectionType : 'none' };
      emit('Network', 'networkStatusChange', { ...state.network });
    },
    setAppActive(isActive) {
      state.appActive = isActive;
      emit('App', 'appStateChange', { isActive });
      emit('App', isActive ? 'resume' : 'pause', {});
    },
    setDiskFree(bytes) { state.diskFree = bytes; },
    setBattery(level, charging = false) { state.battery = level; state.charging = charging; },
    openUrl(url) { emit('App', 'appUrlOpen', { url }); },
    pinia() {
      return window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia || null;
    }
  });
}

module.exports = { installBridge };
