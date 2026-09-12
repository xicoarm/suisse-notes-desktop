/**
 * Virtual "Suisse Notes Pro" recorder (T240 BLE protocol, document 2025-06-13).
 *
 * Runs INSIDE the app's page: it is the native side of the
 * @capacitor-community/bluetooth-le plugin. The real BleClient JS wrapper, the
 * app's bleService.js protocol layer and the device store all run unmodified
 * on top of it. Everything the field devices were observed to do is modelled:
 *
 *  - handshake on notify enable (`01 01 00 00 {uuid}`), app UUID binding with
 *    status 0x01 for a foreign app, the 5 s handshake window;
 *  - time sync / battery / storage / sync-state echoes, unpair (+ disconnect),
 *    delete, format;
 *  - file list as count JSON + N entry JSONs, busy card as the firmware sends
 *    it (`{"AudioFileList":"MemoryBusy"}`);
 *  - download as type-0x02 frames with a BIG-endian frame index (≤ 320 bytes
 *    of payload) followed by 0x1D + CRC16 (nRF variant);
 *  - device-button recording (start JSON / audio stream / stop + CRC), which
 *    also makes the card busy;
 *  - scripted faults: a corrupted frame for the first N attempts of a file,
 *    a dropped link mid-transfer, an empty file, a recorder that is switched off.
 *
 * `window.__harness.recorder` exposes the control surface for scenarios.
 */
'use strict';

function installVirtualRecorder(cfg) {
  const SERVICE = '00001910-0000-1000-8000-00805f9b34fb';
  const WRITE = '00001912-0000-1000-8000-00805f9b34fb';
  const NOTIFY = '00001911-0000-1000-8000-00805f9b34fb';
  const TYPE_CMD = 0x01, TYPE_AUDIO = 0x02;
  const FRAME_PAYLOAD = 320;

  function crc16(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = (((crc >> 8) & 0xFF) | ((crc << 8) & 0xFFFF)) & 0xFFFF;
      crc = (crc ^ data[i]) & 0xFFFF;
      crc = (crc ^ ((crc & 0xFF) >> 4)) & 0xFFFF;
      crc = (crc ^ ((crc << 12) & 0xFFFF)) & 0xFFFF;
      crc = (crc ^ (((crc & 0xFF) << 5) & 0xFFFF)) & 0xFFFF;
    }
    return crc;
  }
  const enc = (s) => Array.from(new TextEncoder().encode(s));
  const dec = (bytes) => new TextDecoder().decode(Uint8Array.from(bytes));
  const toHex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  // BleClient's dataViewToHexString joins bytes with spaces ("01 01 00 …").
  const fromHex = (hex) => { const clean = String(hex).replace(/[^0-9a-f]/gi, ''); const out = []; for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16)); return out; };

  /** Deterministic pseudo-random file bytes (seeded), never mistaken for raw Opus. */
  function makeFileBytes(seed, size) {
    const out = new Uint8Array(size);
    let x = (seed >>> 0) || 1;
    for (let i = 0; i < size; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
      out[i] = x & 0xFF;
    }
    // "OggS" prefix: the app's raw-Opus detector (first byte 0x4B, 80-byte
    // packets) must not "convert" the file, so bytes reach the server intact.
    out[0] = 0x4F; out[1] = 0x67; out[2] = 0x67; out[3] = 0x53;
    return out;
  }

  class VirtualRecorder {
    constructor(config) {
      this.deviceId = config.deviceId || 'AA:BB:CC:DD:EE:01';
      this.name = config.name || 'M1(BLE)';
      this.uuid = config.uuid || '623d289d-0a37-5260-b0f1-976e9bc9ea4e';
      this.sn = config.sn || '352404226020000075';
      this.boundAppUuid = config.boundAppUuid || null; // null = never paired
      this.poweredOn = config.poweredOn !== false;
      this.bluetoothEnabled = config.bluetoothEnabled !== false;
      this.battery = config.battery ?? 87;
      this.busyUntil = 0;
      this.files = [];
      this.faults = { corruptFirstAttempts: {}, dropLinkOnce: {}, ...(config.faults || {}) };
      this.attempts = {};
      this.log = [];
      this.listeners = new Map();   // eventName -> Set(callback)
      this.connected = false;
      this.notifying = false;
      this.handshake = 'none';      // none | step1-sent | done
      this.handshakeTimer = null;
      this.syncState = 0;
      this.recording = null;        // { file, startedAt }
      this.scanning = false;
      this.downloadAbort = false;
      this.stats = { handshakes: 0, rejectedHandshakes: 0, downloads: 0, unpairs: 0, formats: 0, deletes: 0 };
      let seed = 1000;
      // A recorder keeps its state while the APP is relaunched (page reload):
      // binding, files, attempt counters. `fresh: true` starts from the config.
      let restored = null;
      try { restored = config.fresh ? null : JSON.parse(sessionStorage.getItem('__virtual_recorder') || 'null'); } catch { restored = null; }
      if (restored) {
        this.boundAppUuid = restored.boundAppUuid;
        this.attempts = restored.attempts || {};
        this.stats = restored.stats || this.stats;
        for (const f of restored.files || []) this.addFile(f);
        this._log('state restored across app relaunch');
      } else {
        for (const f of config.files || []) this.addFile({ ...f, seed: f.seed || seed++ });
      }
      this._persist();
    }
    _persist() {
      try {
        sessionStorage.setItem('__virtual_recorder', JSON.stringify({
          boundAppUuid: this.boundAppUuid, attempts: this.attempts, stats: this.stats,
          files: this.files.map(f => ({ file: f.file, size: f.size, durationMs: f.duration_ms, creatTime: f.creat_time, seed: f.seed }))
        }));
      } catch { /* storage unavailable */ }
    }

    // ---- scenario control ----------------------------------------------
    addFile({ file, size, durationMs, creatTime, seed }) {
      seed = seed || (Date.now() & 0xFFFF);
      const bytes = size > 0 ? makeFileBytes(seed, size) : new Uint8Array(0);
      const entry = {
        file, size: bytes.length, duration_ms: durationMs ?? Math.round(bytes.length / 4),
        creat_time: creatTime ?? Math.floor(Date.now() / 1000), bytes, seed: seed || (Date.now() & 0xFFFF)
      };
      this.files.push(entry);
      this._persist();
      return entry;
    }
    fileBase64(name) {
      const f = this.files.find(x => x.file === name);
      if (!f) return null;
      let bin = '';
      for (let i = 0; i < f.bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, f.bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    setBusy(ms) { this.busyUntil = Date.now() + ms; }
    powerOff() { this.poweredOn = false; if (this.connected) this._dropLink('power off'); }
    powerOn() { this.poweredOn = true; }
    dropLink() { this._dropLink('scenario'); }
    /** The user presses the record button on the recorder. */
    pressRecord() {
      if (this.recording) return;
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const file = `R${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.opus`;
      this.recording = { file, startedAt: Date.now() };
      this.busyUntil = Infinity; // card busy while recording
      if (this.connected && this.handshake === 'done') {
        this._notify([TYPE_CMD, 0x14, 0x00, ...enc(JSON.stringify({ file, creat_time: Math.floor(Date.now() / 1000), toggle_switch: 0 }))]);
        this._rtStream = setInterval(() => {
          if (!this.connected) return;
          this._notify([TYPE_AUDIO, 0x14, 0x00, 0x00, 0x00, ...Array.from({ length: 40 }, (_, i) => i)]);
        }, 100);
      }
      this._log(`record button: started ${file}`);
    }
    stopRecord({ size = 20480 } = {}) {
      if (!this.recording) return null;
      const { file } = this.recording;
      clearInterval(this._rtStream);
      const entry = this.addFile({ file, size, durationMs: Date.now() - this.recording.startedAt, seed: Date.now() & 0xFFFF });
      this.recording = null;
      this.busyUntil = Date.now() + 1500; // the card finalizes the file
      if (this.connected && this.handshake === 'done') {
        const c = crc16(entry.bytes);
        this._notify([TYPE_CMD, 0x17, 0x00, c & 0xFF, (c >> 8) & 0xFF]);
      }
      this._log(`record button: stopped ${file} (${entry.size} bytes)`);
      return entry;
    }

    // ---- plugin surface (what BleClient calls on the native plugin) -----
    get plugin() {
      const self = this;
      return {
        async initialize() { return {}; },
        async isEnabled() { return { value: self.bluetoothEnabled }; },
        async requestEnable() { self.bluetoothEnabled = true; return { value: true }; },
        async isLocationEnabled() { return { value: true }; },
        async setDisplayStrings() { return {}; },
        async startEnabledNotifications() { return {}; },
        async stopEnabledNotifications() { return {}; },
        async requestLEScan(options) {
          self.scanning = true;
          const wants = !options?.services?.length || options.services.map(s => s.toLowerCase()).includes(SERVICE);
          if (self.poweredOn && wants) {
            setTimeout(() => {
              if (!self.scanning) return;
              self._emit('onScanResult', { device: { deviceId: self.deviceId, name: self.name }, localName: self.name, rssi: -58, uuids: [SERVICE] });
            }, 300);
          }
          return {};
        },
        async stopLEScan() { self.scanning = false; return {}; },
        async getDevices({ deviceIds }) {
          const known = (deviceIds || []).filter(id => id === self.deviceId);
          if (!known.length) throw self._err('Device not found. Call \'requestDevice\', \'requestLEScan\' or \'getDevices\' first.');
          return { devices: known.map(id => ({ deviceId: id, name: self.name })) };
        },
        async getConnectedDevices() { return { devices: self.connected ? [{ deviceId: self.deviceId, name: self.name }] : [] }; },
        async connect({ deviceId, timeout }) {
          if (deviceId !== self.deviceId) throw self._err('Device not found.');
          if (!self.poweredOn) {
            await new Promise(r => setTimeout(r, Math.min(timeout || 10000, 1500)));
            throw self._err('Connection timeout.');
          }
          await new Promise(r => setTimeout(r, 150));
          self.connected = true;
          self.handshake = 'none';
          self.syncState = 0;
          self._log('connected');
          // Protocol §二.1: the app must complete the handshake within 5 s of
          // the connection, otherwise the recorder drops the link.
          clearTimeout(self.handshakeTimer);
          self.handshakeTimer = setTimeout(() => {
            if (self.connected && self.handshake !== 'done') {
              self._notify([TYPE_CMD, 0x01, 0x00, 0x02, 0x04]);
              self._dropLink('handshake timeout (5 s)');
            }
          }, 5000);
          return {};
        },
        async disconnect({ deviceId }) {
          if (deviceId === self.deviceId && self.connected) self._dropLink('app disconnect', { silent: true });
          return {};
        },
        async startNotifications({ deviceId, service, characteristic }) {
          if (!self.connected) throw self._err('Not connected to device.');
          self.notifying = true;
          self.notifyKey = `notification|${deviceId}|${service}|${characteristic}`;
          // Step 1: the recorder announces its UUID once the channel is open.
          setTimeout(() => {
            if (!self.connected) return;
            self.handshake = 'step1-sent';
            self._notify([TYPE_CMD, 0x01, 0x00, 0x00, ...enc(JSON.stringify({ uuid: self.uuid }))]);
          }, 60);
          return {};
        },
        async stopNotifications() { self.notifying = false; return {}; },
        async writeWithoutResponse({ deviceId, characteristic, value }) {
          if (!self.connected || deviceId !== self.deviceId) throw self._err('Not connected to device.');
          if (characteristic.toLowerCase() !== WRITE) throw self._err('Writing descriptor failed.');
          self._onWrite(fromHex(value));
          return {};
        },
        async write(opts) { return this.writeWithoutResponse(opts); },
        async read() { return { value: '' }; },
        async readRssi() { return { value: '-58' }; },
        async requestConnectionPriority() { return {}; },
        async getMtu() { return { value: 517 }; },
        async discoverServices() { return {}; },
        async getServices() { return { services: [{ uuid: SERVICE, characteristics: [{ uuid: WRITE }, { uuid: NOTIFY }] }] }; },
        async createBond() { return {}; },
        async isBonded() { return { value: false }; },
        async openAppSettings() { return {}; },
        async openBluetoothSettings() { return {}; },
        async openLocationSettings() { return {}; },
        async requestDevice() { return { deviceId: self.deviceId, name: self.name }; }
      };
    }

    // ---- listener plumbing (mirrors the native plugin's event names) ----
    addListener(eventName, cb) {
      if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
      this.listeners.get(eventName).add(cb);
      return () => this.listeners.get(eventName)?.delete(cb);
    }
    _emit(eventName, data) {
      const set = this.listeners.get(eventName);
      if (!set) return;
      for (const cb of [...set]) { try { cb(data); } catch (e) { console.error('recorder listener failed', e); } }
    }
    _notify(bytes) {
      if (!this.connected || !this.notifying) return;
      this._emit(this.notifyKey, { value: toHex(bytes) });
    }
    _dropLink(reason, { silent = false } = {}) {
      clearTimeout(this.handshakeTimer);
      clearInterval(this._rtStream);
      this.connected = false;
      this.notifying = false;
      this.handshake = 'none';
      this.syncState = 0;
      this.downloadAbort = true;
      this._log(`link dropped (${reason})`);
      if (!silent) setTimeout(() => this._emit(`disconnected|${this.deviceId}`, { deviceId: this.deviceId }), 20);
    }
    _err(message) { const e = new Error(message); e.code = 'BLE'; return e; }
    _log(msg) { this.log.push({ t: Date.now(), msg }); if (this.log.length > 500) this.log.shift(); }

    // ---- the protocol -----------------------------------------------------
    _onWrite(bytes) {
      if (bytes[0] !== TYPE_CMD) return;
      const cmd = bytes[1];
      const payload = bytes.slice(3);
      const reply = (arr) => setTimeout(() => this._notify(arr), 15);
      if (this.handshake !== 'done' && cmd !== 0x01) {
        reply([TYPE_CMD, 0x01, 0x00, 0x02, 0x03]); // command before handshake
        return;
      }
      switch (cmd) {
        case 0x01: { // handshake step 2: 01 01 00 01 {time, uuid}
          if (payload[0] !== 0x01) return;
          let json = {};
          try { json = JSON.parse(dec(payload.slice(1))); } catch { /* invalid */ }
          this.stats.handshakes++;
          if (this.boundAppUuid && this.boundAppUuid !== json.uuid) {
            this.stats.rejectedHandshakes++;
            this._log(`handshake rejected: bound to ${this.boundAppUuid}, got ${json.uuid}`);
            reply([TYPE_CMD, 0x01, 0x00, 0x02, 0x01]);
            setTimeout(() => this._dropLink('foreign app UUID'), 120);
            return;
          }
          if (!this.boundAppUuid) { this.boundAppUuid = json.uuid; this._log(`bound to app ${json.uuid}`); }
          this._persist();
          clearTimeout(this.handshakeTimer);
          this.handshake = 'done';
          const info = {
            name: this.name, SN: this.sn, uuid: this.uuid, brand: '升迈', model: 'Record Card',
            deviceVerson: '2024-06-06', isAudioRecorded: this.recording ? '1' : '0', screen: 'no', WifiSsid: 'M2(045107968c78)'
          };
          reply([TYPE_CMD, 0x01, 0x00, 0x02, 0x00, ...enc(JSON.stringify(info))]);
          break;
        }
        case 0x04: reply([TYPE_CMD, 0x04, 0x00, ...payload]); break;                 // time sync echo
        case 0x09: reply([TYPE_CMD, 0x09, 0x00, this.battery]); break;               // battery
        case 0x06: reply([TYPE_CMD, 0x06, 0x00, ...enc(JSON.stringify({ unit: 'KBytes', TotalCapacity: 7699520, OpusCapacity: 0, WavCapacity: 0, FreeCapacity: 7698016 - Math.round(this.files.reduce((a, f) => a + f.size, 0) / 1024), OtherCapacity: 0 }))]); break;
        case 0x3D: reply([TYPE_CMD, 0x3D, 0x00, ...enc(JSON.stringify({ Brand: '升迈', Model: 'Record Card', DeviceVerson: '2024-06-06', SoftwareVerson: 12, SoftwareVersonPatch: 4 }))]); break;
        case 0x74: this.syncState = payload[0]; reply([TYPE_CMD, 0x74, 0x00, ...payload]); break; // sync state echo
        case 0x05: { // unpair (+ keep/delete flag), reply, then the recorder disconnects
          this.stats.unpairs++;
          this.boundAppUuid = null;
          this._persist();
          if (payload[0] === 0x01) this.files = [];
          reply([TYPE_CMD, 0x05, 0x00]);
          setTimeout(() => this._dropLink('unpaired'), 80);
          break;
        }
        case 0x68: this.stats.formats++; this.files = []; reply([TYPE_CMD, 0x68, 0x00, 0x00]); break;
        case 0x1E: { // delete file
          const name = dec(payload);
          const idx = this.files.findIndex(f => f.file === name);
          if (idx >= 0) this.files.splice(idx, 1);
          this.stats.deletes++;
          reply([TYPE_CMD, 0x1E, 0x00, idx >= 0 ? 0x01 : 0x02]);
          break;
        }
        case 0x1B: { // file list
          if (Date.now() < this.busyUntil) {
            reply([TYPE_CMD, 0x1B, 0x00, ...enc(JSON.stringify({ AudioFileList: 'MemoryBusy' }))]);
            return;
          }
          const frames = [[TYPE_CMD, 0x1B, 0x00, ...enc(JSON.stringify({ FileNum: this.files.length }))]];
          this.files.forEach((f, i) => frames.push([TYPE_CMD, 0x1B, 0x00, ...enc(JSON.stringify({
            file: f.file, size: f.size, creat_time: f.creat_time, duration_ms: f.duration_ms, type: 3, index: i + 1, delete: 0, toggle_switch: 0
          }))]));
          this._log(`file list: ${this.files.length} entries [${this.files.map(f => f.file).join(', ')}]`);
          frames.forEach((fr, i) => setTimeout(() => this._notify(fr), 15 + i * 8));
          break;
        }
        case 0x1C: this._download(dec(payload)); break;
        case 0x6E: reply([TYPE_CMD, 0x6E, 0x00, 0x00]); break;
        default: this._log(`unknown command 0x${cmd.toString(16)}`);
      }
    }

    _download(name) {
      const f = this.files.find(x => x.file === name);
      this.stats.downloads++;
      this.attempts[name] = (this.attempts[name] || 0) + 1;
      this._persist();
      const attempt = this.attempts[name];
      if (!f) { this._log(`download of unknown file ${name}`); return; }
      this.downloadAbort = false;
      const corrupt = (this.faults.corruptFirstAttempts[name] || 0) >= attempt;
      const dropAt = this.faults.dropLinkOnce[name] && attempt === 1 ? Math.floor(f.bytes.length / 2) : -1;
      const total = Math.ceil(f.bytes.length / FRAME_PAYLOAD);
      this._log(`download ${name} attempt ${attempt} (${f.bytes.length} bytes, ${total} frames${corrupt ? ', CORRUPT' : ''}${dropAt >= 0 ? ', DROP LINK' : ''})`);
      let idx = 0;
      const pump = () => {
        if (!this.connected || this.downloadAbort || this.syncState !== 1) return;
        // ~40 frames per tick keeps a 40 MB file under a minute without starving the page.
        for (let n = 0; n < 40 && idx < total; n++, idx++) {
          const off = idx * FRAME_PAYLOAD;
          if (dropAt >= 0 && off >= dropAt) { this._dropLink('mid-transfer'); return; }
          const chunk = Array.from(f.bytes.subarray(off, off + FRAME_PAYLOAD));
          if (corrupt && idx === Math.floor(total / 2)) chunk[0] ^= 0xFF;
          this._notify([TYPE_AUDIO, 0x1C, 0x00, (idx >> 8) & 0xFF, idx & 0xFF, ...chunk]); // BIG-endian index
        }
        if (idx < total) { setTimeout(pump, 5); return; }
        const c = crc16(f.bytes);
        setTimeout(() => this._notify([TYPE_CMD, 0x1D, 0x00, c & 0xFF, (c >> 8) & 0xFF]), 5);
      };
      setTimeout(pump, 20);
    }
  }

  const recorder = new VirtualRecorder(cfg || {});
  window.__recorder = recorder;
  window.__harness = window.__harness || {};
  window.__harness.recorder = recorder;
}

module.exports = { installVirtualRecorder };
