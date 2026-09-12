/**
 * BLE Service for T240 Recording Device Communication
 * Implements the binary protocol for scanning, pairing, file listing,
 * and file download over Bluetooth Low Energy.
 *
 * Protocol: Custom binary over GATT
 * - Service: 00001910-0000-1000-8000-00805f9b34fb
 * - Write:   00001912-0000-1000-8000-00805f9b34fb (WRITE_WITHOUT_RESPONSE)
 * - Notify:  00001911-0000-1000-8000-00805f9b34fb (NOTIFY)
 */

import { isCapacitor, isAndroid, isIOS } from '../utils/platform';
import { addBreadcrumb, captureException, captureMessage } from '../boot/sentry';

// BLE GATT UUIDs
const BLE_SERVICE_UUID = '00001910-0000-1000-8000-00805f9b34fb';
const BLE_WRITE_CHAR = '00001912-0000-1000-8000-00805f9b34fb';
const BLE_NOTIFY_CHAR = '00001911-0000-1000-8000-00805f9b34fb';

// Protocol type bytes
const TYPE_CMD = 0x01;
const TYPE_AUDIO = 0x02;

// Command bytes [cmdLo, cmdHi]
const CMD_HANDSHAKE = [0x01, 0x00];
const CMD_TIME_SYNC = [0x04, 0x00];
const CMD_BATTERY = [0x09, 0x00];
const CMD_STORAGE = [0x06, 0x00];
const CMD_FILE_LIST = [0x1B, 0x00];
const CMD_FILE_DOWNLOAD = [0x1C, 0x00];
const CMD_FILE_DONE = [0x1D, 0x00];
const CMD_DELETE_FILE = [0x1E, 0x00];
const CMD_DEVICE_INFO = [0x3D, 0x00];
const CMD_FORMAT = [0x68, 0x00];      // Format device storage (FAT) — wipes all files
const CMD_SYNC_STATE = [0x74, 0x00];
const CMD_UNPAIR = [0x05, 0x00];

/**
 * CRC16 computation matching device firmware (CRC-CCITT variant, nRF SDK)
 * @param {Uint8Array} data
 * @returns {number} 16-bit CRC
 */
export function crc16Compute(data) {
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

/**
 * Parse JSON from a protocol response buffer starting at a given offset
 */
function parseJsonFromBuffer(data, offset) {
  const jsonBytes = data.slice(offset);
  const jsonStr = new TextDecoder().decode(jsonBytes);
  return JSON.parse(jsonStr);
}

/**
 * Build a command packet: [TYPE_CMD, cmdLo, cmdHi, ...payload]
 */
function buildCmd(cmd, payload = []) {
  return new Uint8Array([TYPE_CMD, cmd[0], cmd[1], ...payload]);
}

/**
 * BLE Device Manager - handles all communication with the recording device
 */
export class BleDeviceManager {
  constructor() {
    this.ble = null;
    this.deviceId = null;       // BLE adapter device ID (platform-specific)
    this.deviceUuid = null;     // Protocol device UUID
    this.deviceInfo = null;     // Device info from handshake
    this.connected = false;
    this.isRecording = false;  // Live recording state from device notifications

    // Notification queue for async response handling
    this._notifyQueue = [];
    this._notifyWaiter = null;
    // Timestamp of the last _readNotification timeout. If a notification
    // arrives shortly after a timeout (the device's response in flight
    // when we gave up), it's stale data for a command we already abandoned
    // — queueing it would poison the next command's read. _onNotify drops
    // notifications inside this window.
    this._lastReadTimeoutAt = 0;
    this._onDisconnectCallback = null;
    this._recordingStateCallback = null;
    this._downloadAborted = false;
    // True only while downloadFile() is consuming audio frames. Outside a
    // download, TYPE_AUDIO frames (real-time recording stream 0x14, or a
    // stale 0x1C stream the device kept sending after a dropped link) are
    // discarded in _onNotify instead of poisoning the next command's reply —
    // the "handshake step1 byte[3]=0x33 raw=[0x02 0x1c …]" failures.
    this._downloadInProgress = false;

    // Command lock: prevents concurrent BLE commands from interleaving responses.
    // Without this, auto-sync keepalive (getBattery) can fire during getFileList,
    // causing response bytes to be read by the wrong command.
    this._commandLock = Promise.resolve();
  }

  /**
   * Acquire exclusive access to the BLE command channel.
   * All public commands must go through this to prevent interleaving.
   */
  _acquireLock() {
    let release;
    const prev = this._commandLock;
    this._commandLock = new Promise(resolve => { release = resolve; });
    return prev.then(() => release);
  }

  /**
   * Initialize the BLE client
   */
  async initialize() {
    if (!isCapacitor()) {
      throw new Error('BLE is only available on mobile devices');
    }
    const { BleClient } = await import('@capacitor-community/bluetooth-le');
    this.ble = BleClient;
    const neverForLocation = true;
    addBreadcrumb({ category: 'ble', message: `BLE initialize: androidNeverForLocation=${neverForLocation}, platform=${isAndroid() ? 'android' : 'ios'}`, level: 'info' });
    try {
      await this.ble.initialize({ androidNeverForLocation: neverForLocation });
      this._initialized = true;
      addBreadcrumb({ category: 'ble', message: 'BLE initialize: SUCCESS — permissions granted', level: 'info' });
    } catch (e) {
      this._initialized = false;
      // A denied Bluetooth permission is a user decision, not a defect —
      // record it as a warning so it stays visible in aggregate without
      // paging anyone (it was the #3 error-level issue in Sentry).
      captureMessage(`BLE initialize: FAILED — ${e.message}`, 'warning');
      throw new Error('Bluetooth permissions are required. Please enable Bluetooth and Location permissions in your device settings.');
    }
  }

  /**
   * Scan for recording devices
   * @param {number} duration - Scan duration in ms
   * @param {Function} onFound - Callback for each device found
   * @returns {Promise<void>}
   */
  async scan(duration = 7000, onFound = null) {
    if (!this.ble || !this._initialized) await this.initialize();

    // Check Bluetooth is enabled — prompt user to turn it on if not
    try {
      const bleEnabled = await this.ble.isEnabled();
      addBreadcrumb({ category: 'ble', message: `BLE scan pre-check: bluetooth=${bleEnabled}`, level: 'info' });
      if (!bleEnabled) {
        addBreadcrumb({ category: 'ble', message: 'BLE scan: Bluetooth disabled — requesting enable', level: 'warning' });
        // requestEnable exists on Android only; iOS users switch Bluetooth on
        // in Control Center / Settings.
        let rechecked = false;
        if (isAndroid()) {
          await this.ble.requestEnable();
          rechecked = await this.ble.isEnabled();
        }
        if (!rechecked) {
          const err = new Error('Bluetooth is required for device scanning. Please enable Bluetooth.');
          err.code = 'BLE_DISABLED';
          throw err;
        }
      }
    } catch (e) {
      if (e.message?.includes('Bluetooth is required')) throw e;
      captureMessage(`BLE scan: bluetooth check error — ${e.message}`, 'warning');
    }

    // Note: with androidNeverForLocation=true + BLUETOOTH_SCAN neverForLocation,
    // Android 12+ does not require Location Services for BLE scanning.
    // Android ≤11 uses ACCESS_FINE_LOCATION (maxSdkVersion=30) which covers it.

    let devicesFound = 0;
    const seen = new Set();
    const allSeen = [];

    addBreadcrumb({
      category: 'ble',
      message: `BLE scan starting (${duration}ms)`,
      level: 'info'
    });

    const handleDevice = (result, source) => {
      if (!onFound || !result.device) return;
      const id = result.device.deviceId;
      if (seen.has(id)) return;
      seen.add(id);

      const name = result.device.name || result.localName || null;
      devicesFound++;

      addBreadcrumb({
        category: 'ble',
        message: `BLE device found (${source}): ${name || 'unnamed'} [${id}]`,
        data: { rssi: result.rssi },
        level: 'info'
      });

      onFound({ deviceId: id, name, rssi: result.rssi });
    };

    // Step 1: Scan WITH service UUID filter (finds devices advertising our service)
    try {
      await this.ble.requestLEScan(
        { services: [BLE_SERVICE_UUID], allowDuplicates: false },
        (result) => handleDevice(result, 'service-filter')
      );
      await new Promise(r => setTimeout(r, duration));
      await this.stopScan();
    } catch (e) {
      addBreadcrumb({ category: 'ble', message: `Service-filtered scan error: ${e.message}`, level: 'error' });
      await this.stopScan();
    }

    // Step 2: If no devices found, retry service UUID scan with a longer duration.
    // All protocol-compatible devices MUST advertise our service UUID.
    // Step 2: If no devices found via service UUID, retry with name-based filter.
    // Many BLE devices don't advertise service UUIDs in their advertisement packets.
    if (devicesFound === 0) {
      addBreadcrumb({
        category: 'ble',
        message: 'No devices with service UUID, trying name-based scan',
        level: 'warning'
      });

      await this.ble.requestLEScan(
        { allowDuplicates: false },
        (result) => {
          if (!result.device) return;
          const name = result.device.name || result.localName || null;
          if (name) allSeen.push(name);

          // Filter by known recording device name patterns
          if (name && /M\d+\(BLE\)|T240|MeCho|Record.?Card/i.test(name)) {
            handleDevice(result, 'name-filter');
          }
        }
      );
      await new Promise(r => setTimeout(r, duration));
      await this.stopScan();

      // Only counts leave the device: the names of nearby Bluetooth devices
      // are the user's environment (people's headphones, cars, TVs).
      addBreadcrumb({ category: 'ble', message: `BLE name-scan: found=${[...seen].length} nearby_named=${allSeen.length}`, level: 'info' });
    }

    addBreadcrumb({
      category: 'ble',
      message: `BLE scan complete: ${devicesFound} device(s) found`,
      level: 'info'
    });

    if (devicesFound === 0) {
      captureMessage(`BLE scan: 0 recording devices found (${allSeen.length} other named devices nearby)`, 'warning');
    }
  }

  /**
   * Stop scanning
   */
  async stopScan() {
    try {
      await this.ble.stopLEScan();
    } catch {
      // Ignore if not scanning
    }
  }

  /**
   * Connect to a device and perform handshake
   * @param {string} bleDeviceId - Platform BLE device ID
   * @param {string} appUuid - App's UUID for pairing
   * @param {Object} [opts]
   * @param {boolean} [opts.silent] - automatic reconnect: an unreachable device
   *   is the expected outcome, so failures are breadcrumbs, not Sentry errors
   * @returns {Promise<Object>} Device info from handshake
   */
  async connect(bleDeviceId, appUuid, { silent = false } = {}) {
    if (!this.ble) await this.initialize();
    const report = (e, action, extra) => {
      if (silent) {
        addBreadcrumb({ category: 'ble', message: `${action} failed (auto): ${e?.message}`, level: 'warning' });
      } else {
        captureException(e, { tags: { action }, extra });
      }
    };

    addBreadcrumb({
      category: 'ble',
      message: `BLE connecting to device ${bleDeviceId}`,
      level: 'info'
    });

    this.deviceId = bleDeviceId;
    this._notifyQueue = [];
    this._notifyWaiter = null;
    // Clear any leftover cancel flag from a previous session — without this,
    // a user who cancelled a download cannot reconnect until force-quit because
    // _readNotification rejects every handshake read with "BLE download
    // cancelled".
    this._downloadAborted = false;

    // Ensure the BLE plugin knows about this device (needed for reconnection
    // to previously paired devices without a fresh scan)
    let knownToPlugin = true;
    try {
      await this.ble.getDevices([bleDeviceId]);
      addBreadcrumb({ category: 'ble', message: 'BLE getDevices OK', level: 'info' });
    } catch (e) {
      knownToPlugin = false;
      addBreadcrumb({ category: 'ble', message: `BLE getDevices failed: ${e.message}, will try connect anyway`, level: 'warning' });
    }

    const onDisconnect = (deviceId) => {
      this.connected = false;
      this.deviceId = null;
      addBreadcrumb({ category: 'ble', message: `BLE disconnected: ${deviceId}`, level: 'warning' });
      // BT-2: immediately fail any in-flight notification read so an active
      // download/getFileList doesn't block for the full 30s-per-chunk timeout
      // — a lost device could otherwise hang a multi-chunk transfer for ~50
      // minutes. Uses a disconnect error (NOT the cancel sentinel) so the
      // caller retries the file on reconnect instead of skipping it.
      this._failInflightOnDisconnect();
      if (this._onDisconnectCallback) {
        this._onDisconnectCallback(deviceId);
      }
    };

    // Connect (BT-4: bound the attempt so an unreachable device can't hang indefinitely)
    try {
      try {
        await this.ble.connect(bleDeviceId, onDisconnect, { timeout: 15000 });
      } catch (e) {
        // Android: after a process restart the plugin may have forgotten a
        // paired peripheral it never scanned in this process ("Device not
        // found. Call requestDevice, requestLEScan or getDevices first").
        // A short service-filtered scan re-registers it; retry once.
        if (isAndroid() && (!knownToPlugin || /not found/i.test(e?.message || ''))) {
          addBreadcrumb({ category: 'ble', message: 'Android connect: device unknown to plugin — rediscovery scan + retry', level: 'info' });
          const seen = await this._rediscover(bleDeviceId, 6000);
          if (!seen) throw e;
          await this.ble.connect(bleDeviceId, onDisconnect, { timeout: 15000 });
        } else {
          throw e;
        }
      }
      addBreadcrumb({ category: 'ble', message: 'BLE connected, starting notifications', level: 'info' });
    } catch (e) {
      this.deviceId = null;
      report(e, 'ble_connect', { bleDeviceId });
      throw new Error(`Connection failed: ${e.message}`);
    }

    // Start notifications — device will automatically send its UUID
    try {
      await this.ble.startNotifications(
        bleDeviceId,
        BLE_SERVICE_UUID,
        BLE_NOTIFY_CHAR,
        (value) => this._onNotify(value)
      );
      addBreadcrumb({ category: 'ble', message: 'BLE notifications started, waiting for device handshake', level: 'info' });
    } catch (e) {
      report(e, 'ble_notifications', { bleDeviceId });
      throw new Error(`Notification setup failed: ${e.message}`);
    }

    // Perform handshake
    try {
      const deviceInfo = await this._handshake(appUuid);
      this.connected = true;
      this.deviceInfo = deviceInfo;
      addBreadcrumb({ category: 'ble', message: `BLE handshake OK: ${deviceInfo.name || 'unknown'}`, level: 'info' });

      // Sync phone time to device
      await this.syncTime();

      // Best-effort: clear any stale sync-state left by a crashed prior session.
      // If the device was in sync state (0x01) when last disconnected, its queue
      // may still be waiting for an exit command — the next getFileList/downloadFile
      // would hit stale-response cascades. We send [0x00] as a fresh-start signal.
      // Devices already out of sync-state may simply not ack — that's fine.
      try {
        const release = await this._acquireLock();
        try {
          await this._write(buildCmd(CMD_SYNC_STATE, [0x00]));
          await this._readResponse(CMD_SYNC_STATE, 2000);
          addBreadcrumb({ category: 'ble', message: 'Cleared potential stale sync-state after connect', level: 'info' });
        } finally {
          release();
        }
      } catch {
        // No ack or timeout is non-fatal — device was likely already clean
      }

      return deviceInfo;
    } catch (e) {
      // "already paired to another app" and response timeouts are device
      // states, not app defects: keep them visible as warnings.
      if (silent || /rejected pairing|response timeout/i.test(e?.message || '')) {
        captureMessage(`BLE handshake failed: ${e?.message}`, 'warning');
      } else {
        captureException(e, { tags: { action: 'ble_handshake' }, extra: { bleDeviceId } });
      }
      await this.disconnect();
      throw new Error(`Handshake failed: ${e.message}`);
    }
  }

  /**
   * Run a short service-UUID-filtered scan and report whether `bleDeviceId`
   * advertised. Repopulates the platform's peripheral cache as a side effect
   * (what makes a subsequent connect() resolve on iOS after a long suspension
   * and on Android after a process restart).
   * @returns {Promise<boolean>} true if the device was seen
   */
  async _rediscover(bleDeviceId, timeoutMs) {
    let found = false;
    const scanStart = Date.now();
    try {
      await this.ble.requestLEScan(
        { services: [BLE_SERVICE_UUID], allowDuplicates: false },
        (result) => {
          if (result?.device?.deviceId === bleDeviceId) found = true;
        }
      );
      while (!found && Date.now() - scanStart < timeoutMs) {
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (e) {
      addBreadcrumb({ category: 'ble', message: `rediscovery scan error: ${e.message}`, level: 'warning' });
    } finally {
      try { await this.ble.stopLEScan(); } catch { /* ignore */ }
    }
    addBreadcrumb({
      category: 'ble',
      message: `rediscovery: target ${found ? 'located' : 'NOT located'} in ${Date.now() - scanStart}ms`,
      level: found ? 'info' : 'warning'
    });
    return found;
  }

  /**
   * Reconnect to a previously paired device with iOS rediscovery first.
   *
   * On iOS, centralManager.connect() against a cached CBPeripheral hangs
   * indefinitely (until the plugin's 10s timeout) when the peripheral has
   * aged out of the system discovery cache — which happens after multi-day
   * app suspension. The fix is to run an active service-UUID-filtered scan
   * so iOS rediscovers the peripheral; the subsequent connect then resolves
   * via cached discovery state.
   *
   * Android's connect() handles known peripherals natively, so we skip the
   * scan there to avoid extra latency.
   */
  async connectWithRediscovery(bleDeviceId, appUuid, { rediscoveryTimeoutMs = 12000, silent = false } = {}) {
    if (!this.ble) await this.initialize();

    if (!isIOS()) {
      return this.connect(bleDeviceId, appUuid, { silent });
    }

    // Deliberately falls through to connect() even when the scan did not see
    // the device: iOS can connect to a peripheral that is connectable but not
    // advertising. The caller (device store) backs off between attempts.
    await this._rediscover(bleDeviceId, rediscoveryTimeoutMs);
    return this.connect(bleDeviceId, appUuid, { silent });
  }

  /**
   * Disconnect from the device
   */
  async disconnect() {
    if (!this.deviceId || !this.ble) return;
    try {
      await this.ble.stopNotifications(this.deviceId, BLE_SERVICE_UUID, BLE_NOTIFY_CHAR);
    } catch { /* ignore */ }
    try {
      await this.ble.disconnect(this.deviceId);
    } catch { /* ignore */ }
    this.connected = false;
    this.deviceId = null;
    // Belt-and-suspenders: any cancel flag from this session should not
    // outlive the disconnect. connect() also resets this, but clearing here
    // protects any reconnect path that skips the early reset.
    this._downloadAborted = false;
  }

  /**
   * Format device storage (wipes all files). Per protocol §9:
   * Returns 0x00 on success, other value on failure.
   * Device won't accept commands until format completes.
   */
  async formatDevice() {
    const release = await this._acquireLock();
    try {
      await this._write(buildCmd(CMD_FORMAT));
      // Format can take a while on large storage — use generous timeout
      const resp = await this._readResponse(CMD_FORMAT, 30000);
      const status = resp[3];
      addBreadcrumb({ category: 'ble', message: `Format device: status=0x${status.toString(16)}`, level: 'info' });
      return status === 0x00;
    } finally {
      release();
    }
  }

  /**
   * Unpair (tell device to forget this app, then disconnect)
   */
  async unpair() {
    if (this.connected && this.deviceId) {
      // BT-5: abort any in-flight download BEFORE tearing down, so a concurrent
      // transfer can't proceed into the disconnected state and corrupt history.
      this.abortDownload();
      const release = await this._acquireLock();
      try {
        await this._write(buildCmd(CMD_UNPAIR, [0x00])); // 0x00 = keep the recordings on the device
        await this._readResponse(CMD_UNPAIR, 3000);
      } catch { /* ignore */ }
      finally { release(); }
      await this.disconnect();
    }
  }

  /**
   * Set disconnect callback
   */
  onDisconnect(callback) {
    this._onDisconnectCallback = callback;
  }

  /**
   * Set recording state change callback (fired on device-initiated start/stop)
   */
  onRecordingStateChange(callback) {
    this._recordingStateCallback = callback;
  }

  // ========== Device Commands ==========

  /**
   * Get battery level (0-100)
   */
  async getBattery() {
    const release = await this._acquireLock();
    try {
      await this._write(buildCmd(CMD_BATTERY));
      // Response: 0x01 0x09 0x00 <level> — unsolicited frames are skipped
      const resp = await this._readResponse(CMD_BATTERY, 5000);
      if (resp.length < 4) return -1; // Signal invalid reading — caller should ignore
      const level = resp[3];
      return (level >= 0 && level <= 100) ? level : -1;
    } finally {
      release();
    }
  }

  /**
   * Get storage info
   * @returns {Object} { unit, totalCapacity, freeCapacity }
   */
  async getStorage() {
    const release = await this._acquireLock();
    try {
      await this._write(buildCmd(CMD_STORAGE));
      const resp = await this._readResponse(CMD_STORAGE, 5000);
      return parseJsonFromBuffer(resp, 3);
    } finally {
      release();
    }
  }

  /**
   * Sync phone time to device
   */
  async syncTime() {
    const release = await this._acquireLock();
    try {
      const now = new Date();
      const timeStr = now.getFullYear().toString() +
        (now.getMonth() + 1).toString().padStart(2, '0') +
        now.getDate().toString().padStart(2, '0') +
        now.getHours().toString().padStart(2, '0') +
        now.getMinutes().toString().padStart(2, '0') +
        now.getSeconds().toString().padStart(2, '0');
      const timeBytes = new TextEncoder().encode(timeStr);
      await this._write(buildCmd(CMD_TIME_SYNC, [...timeBytes]));
      await this._readResponse(CMD_TIME_SYNC, 3000);
    } finally {
      release();
    }
  }

  /**
   * Get device info (brand, model, versions, etc.)
   */
  async getDeviceInfo() {
    const release = await this._acquireLock();
    try {
      await this._write(buildCmd(CMD_DEVICE_INFO));
      const resp = await this._readResponse(CMD_DEVICE_INFO, 5000);
      return parseJsonFromBuffer(resp, 3);
    } finally {
      release();
    }
  }

  /**
   * Get file list from device
   * @returns {Promise<Array>} Array of file info objects
   */
  async getFileList() {
    const release = await this._acquireLock();

    // Hoisted so the finally block can scale drain by expected stream size.
    let fileCount = 0;
    let inSyncState = false;

    try {
      // Drain any stale notifications from previous operations
      await this._drainNotifyQueue();

      // Enter sync state
      await this._write(buildCmd(CMD_SYNC_STATE, [0x01]));
      await this._readResponse(CMD_SYNC_STATE, 5000);
      inSyncState = true;

      // Request file list
      await this._write(buildCmd(CMD_FILE_LIST));

      // The count frame and every entry frame look identical on the wire
      // (0x01 0x1B 0x00 + JSON), so the stream is parsed by JSON SHAPE, never
      // by position: {"FileNum":N} is the count (and a restart marker if it
      // arrives again), {"file":…} is an entry, {"…FileList":"Memory…"} is a
      // device error. Trusting the order made ONE leftover frame desynchronize
      // every later request — files then disappeared from the list entirely.
      const files = [];
      const seen = new Set();
      let skipped = 0;
      let sawCount = false;
      let reads = 0;
      // Enough reads for the whole list plus the stale frames of one
      // abandoned list request, so a shifted stream still completes.
      const maxReads = () => (sawCount ? fileCount * 2 + 8 : 8);

      while (reads < maxReads() && (!sawCount || files.length < fileCount)) {
        reads++;
        let resp;
        try {
          resp = await this._readResponse(CMD_FILE_LIST, 10000);
        } catch (readErr) {
          if (!sawCount) throw readErr;              // no list at all — real failure
          addBreadcrumb({ category: 'ble', message: `getFileList: stream ended after ${files.length}/${fileCount} entries (${readErr.message})`, level: 'warning' });
          break;
        }
        let json;
        try {
          json = parseJsonFromBuffer(resp, 3);
        } catch (parseErr) {
          skipped++;
          addBreadcrumb({ category: 'ble', message: `getFileList: unparsable frame skipped (${parseErr.message})`, level: 'warning' });
          continue;
        }

        // Device-side error instead of a list. The document shows
        // {"FileList":"MemoryBusy"}; the shipped firmware actually sends
        // {"AudioFileList":"MemoryBusy"} (Sentry CAPACITOR-RY breadcrumbs,
        // while the recorder was recording) — that case used to read as
        // "0 files". Surface a code the UI translates; the next poll retries
        // once the card is free again.
        const deviceStatus = Object.entries(json)
          .find(([k, v]) => typeof v === 'string' && (/FileList$/i.test(k) || /^Memory(Busy|Err|Full)$/i.test(v)));
        if (deviceStatus) {
          const err = new Error(String(deviceStatus[1]));
          err.code = 'DEVICE_' + String(deviceStatus[1]).toUpperCase();
          throw err;
        }

        if (typeof json.FileNum === 'number') {
          // The count frame. Seeing it again means the frames so far belonged
          // to an earlier request — start the collection over.
          if (sawCount && files.length) {
            addBreadcrumb({ category: 'ble', message: `getFileList: second count frame — discarding ${files.length} stale entr(ies)`, level: 'warning' });
            files.length = 0;
            seen.clear();
          }
          sawCount = true;
          fileCount = json.FileNum;
          addBreadcrumb({ category: 'ble', message: `getFileList fileCount=${fileCount}`, level: 'info' });
          continue;
        }
        if (json.file) {
          if (seen.has(json.file)) {
            // The same name twice can only be a stale frame of an earlier
            // request — never two recordings (the name carries the timestamp).
            skipped++;
            addBreadcrumb({ category: 'ble', message: `getFileList: duplicate entry ${json.file} ignored (stale frame)`, level: 'warning' });
            continue;
          }
          seen.add(json.file);
          files.push(json);
          continue;
        }
        skipped++;
        addBreadcrumb({ category: 'ble', message: `getFileList: frame without filename skipped: ${JSON.stringify(json).slice(0, 120)}`, level: 'warning' });
      }

      const complete = sawCount && files.length >= fileCount;
      addBreadcrumb({ category: 'ble', message: `getFileList done: ${files.length}/${fileCount} files, ${skipped} skipped, ${reads} reads, complete=${complete}`, level: 'info' });
      if (!complete) {
        // A partial list must never REPLACE what the app already knows —
        // that is how a recording silently disappears from the device page.
        const err = new Error(`Incomplete file list: ${files.length} of ${fileCount} entries`);
        err.code = 'LIST_INCOMPLETE';
        err.files = files;
        throw err;
      }
      return files;
    } finally {
      // Always exit sync state — even on error/timeout. Without this, the
      // device stays locked in "transferring" mode permanently.
      if (inSyncState) {
        try {
          await this._write(buildCmd(CMD_SYNC_STATE, [0x00]));
          await this._readResponse(CMD_SYNC_STATE, 3000);
        } catch { /* best effort */ }
      }
      // If the read loop bailed early (stream timeout / corrupt entry), the
      // device may still be streaming the remaining file entries. Drain them
      // so they don't poison the next command's response. Scale by fileCount
      // so large lists get enough time.
      if (fileCount > 0) {
        try {
          await this._drainNotifyQueue(300, 5000, fileCount);
        } catch { /* best effort */ }
      }
      release();
    }
  }

  /**
   * Download a file from the device
   * @param {string} filename - e.g. "R20250311-093012.opus"
   * @param {Function} onProgress - Progress callback (0-100)
   * @param {number} totalSize - Expected file size in bytes (for progress)
   * @returns {Promise<Uint8Array>} File data
   */
  /**
   * Abort an in-progress download. Causes downloadFile() to reject.
   *
   * Cancellation protocol:
   *   1. Set _downloadAborted = true. _readNotification() checks this
   *      synchronously at entry and immediately rejects with
   *      "BLE download cancelled" — so any subsequent reads short-circuit.
   *   2. If a _readNotification() is already in flight (the 30s wait inside
   *      downloadFile's chunk loop, or a similar wait in the sync-state
   *      cleanup), it has registered _notifyWaiter. We reject that waiter
   *      directly, which clearTimeout's its internal timer and rejects its
   *      promise — the in-flight await throws within a microtask.
   *   3. Null out _notifyWaiter BEFORE invoking reject so a notification
   *      racing through _onNotify can't find a stale reference.
   *
   * downloadFile()'s outer catch then sees err.message === 'BLE download
   * cancelled', runs the cancel cleanup (delete partial file, mark skipped),
   * and re-throws 'cancelled' to the caller.
   */
  abortDownload() {
    // Outside a download there is nothing to abort. Setting the flag anyway
    // used to make EVERY later read (keepalive battery poll, file list) fail
    // with "BLE download cancelled" until the next connect — the auto-sync
    // then stopped silently (Sentry CAPACITOR-H9/YX).
    if (!this._downloadInProgress) return;
    this._downloadAborted = true;
    if (this._notifyWaiter && this._notifyWaiter.reject) {
      const waiter = this._notifyWaiter;
      this._notifyWaiter = null;
      waiter.reject(new Error('BLE download cancelled'));
    }
  }

  /**
   * BT-2: called when the underlying BLE link drops. Rejects any in-flight
   * _readNotification right away so downloadFile/getFileList unwind in a
   * microtask instead of waiting out the per-read timeout. Deliberately does
   * NOT set _downloadAborted (that is the user-cancel sentinel) and uses a
   * distinct "disconnected" error so the caller treats the file as retryable
   * (resumes on reconnect) rather than user-cancelled (skipped).
   */
  _failInflightOnDisconnect() {
    if (this._notifyWaiter && this._notifyWaiter.reject) {
      const waiter = this._notifyWaiter;
      this._notifyWaiter = null;
      waiter.reject(new Error('BLE disconnected during transfer'));
    }
    // Any notification that lands right after the drop is stale — drop it.
    this._lastReadTimeoutAt = Date.now();
  }

  async downloadFile(filename, onProgress = null, totalSize = 0) {
    const release = await this._acquireLock();
    this._downloadAborted = false;
    this._downloadInProgress = true;

    // Track whether the device is in sync state so we only exit it when needed.
    // Declared here so the catch block can reference it.
    let inSyncState = false;
    const chunks = [];
    let receivedBytes = 0;
    let expectedIndex = 0;
    let staleFramesDropped = 0;

    try {
      // Drain any stale notifications from previous operations
      await this._drainNotifyQueue();

      // Enter sync state
      await this._write(buildCmd(CMD_SYNC_STATE, [0x01]));
      await this._readResponse(CMD_SYNC_STATE, 5000);
      inSyncState = true;

      // Send download command with filename
      const filenameBytes = new TextEncoder().encode(filename);
      await this._write(buildCmd(CMD_FILE_DOWNLOAD, [...filenameBytes]));

      // Receive audio frames until transfer complete
      let transferring = true;
      while (transferring) {
        const data = await this._readNotification(30000);

        if (data[0] === TYPE_AUDIO) {
          // Audio data frame: type(1) + cmd(2) + index(2) + audio(N). Only the
          // local-sync stream (cmd 0x1C) belongs to this download; the
          // real-time stream (0x14) is dropped in _onNotify.
          if (!(data[1] === CMD_FILE_DOWNLOAD[0] && data[2] === CMD_FILE_DOWNLOAD[1])) continue;
          // The 2-byte frame index is BIG-endian on the wire. The protocol
          // document does not state the byte order; consecutive frames
          // recorded in the field read 0x02 0xb7, 0x02 0xb8, 0x02 0xb9 —
          // the SECOND byte increments (Sentry CAPACITOR-XN breadcrumbs).
          const frameIndex = (data[3] << 8) | data[4];
          const wanted = expectedIndex & 0xFFFF;
          if (frameIndex !== wanted) {
            // Frames the device was still streaming for an ABORTED transfer
            // (cancel, CRC mismatch, dropped link) can arrive after the next
            // download has started: their index is behind ours — and before
            // frame 0 of this file, anything non-zero is stale by definition.
            // Dropping them is what makes the retry of a failed file work at
            // all; treating them as a gap failed every retry until the file
            // was skipped (found by the mobile harness, m5).
            const stale = expectedIndex === 0
              ? frameIndex !== 0
              : ((wanted - frameIndex) & 0xFFFF) < 0x8000;
            if (stale) {
              staleFramesDropped++;
              continue;
            }
            // A real hole in the sequence can only end in a CRC mismatch
            // after the whole file — fail fast instead.
            throw new Error(`CRC mismatch: frame ${frameIndex} received, expected ${wanted} (frame gap)`);
          }
          expectedIndex++;
          const audioData = data.slice(5);
          chunks.push(audioData);
          receivedBytes += audioData.length;

          if (onProgress && totalSize > 0) {
            onProgress({
              percent: Math.min(99, Math.round((receivedBytes / totalSize) * 100)),
              bytesReceived: receivedBytes,
              bytesTotal: totalSize
            });
          }
        } else if (data[0] === TYPE_CMD && data[1] === CMD_FILE_DONE[0] && data[2] === CMD_FILE_DONE[1]) {
          // Transfer complete: 0x01 0x1D 0x00 crcL crcH
          const expectedCrc = data[3] | (data[4] << 8);

          if (receivedBytes === 0) {
            // A zero-length recording on the card (device-side write failure).
            // Retrying it every poll can never succeed — the caller skips it.
            const empty = new Error('Device file is empty');
            empty.code = 'EMPTY_FILE';
            throw empty;
          }

          // Concatenate all chunks
          const fileData = new Uint8Array(receivedBytes);
          let offset = 0;
          for (const chunk of chunks) {
            fileData.set(chunk, offset);
            offset += chunk.length;
          }

          // Verify CRC — on mismatch, let the catch block clean up
          const actualCrc = crc16Compute(fileData);
          if (actualCrc !== expectedCrc) {
            throw new Error(`CRC mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`);
          }

          if (onProgress) onProgress({ percent: 100, bytesReceived: receivedBytes, bytesTotal: totalSize });
          if (staleFramesDropped) {
            addBreadcrumb({ category: 'ble', message: `downloadFile ${filename}: dropped ${staleFramesDropped} stale frame(s) of an earlier transfer`, level: 'warning' });
          }

          // Success path: exit sync state cleanly
          await this._write(buildCmd(CMD_SYNC_STATE, [0x00]));
          await this._readResponse(CMD_SYNC_STATE, 3000);
          inSyncState = false;

          return fileData;
        }
      }
    } catch (err) {
      // Always exit sync state on failure/abort AND drain any in-flight frames.
      // Without the drain, stale audio notifications sent by the device after
      // we stopped reading get consumed by the next command's _readNotification,
      // causing the cascade documented in docs/BLE_DEVICE_SYNC_BUG_REPORT.md
      // (Bug 3). Scales drain wait by estimated stale frames so large-file
      // aborts don't truncate prematurely.
      if (inSyncState) {
        // The cancel flag would make this exit-sync-state read fail too.
        this._downloadAborted = false;
        try {
          await this._write(buildCmd(CMD_SYNC_STATE, [0x00]));
          await this._readResponse(CMD_SYNC_STATE, 3000);
        } catch { /* best effort */ }
      }
      try {
        // At ~500 bytes per audio frame, partially-received bytes approximate
        // the number of stale frames the device may still be emitting.
        const estimatedStale = Math.max(200, Math.round(receivedBytes / 500));
        await this._drainNotifyQueue(300, 5000, estimatedStale);
      } catch { /* best effort */ }
      throw err;
    } finally {
      // The cancel sentinel belongs to THIS download only.
      this._downloadAborted = false;
      this._downloadInProgress = false;
      release();
    }
  }

  /**
   * Delete a file on the device
   * @param {string} filename
   * @returns {Promise<boolean>} true if deleted
   */
  async deleteFile(filename) {
    const release = await this._acquireLock();
    try {
      const filenameBytes = new TextEncoder().encode(filename);
      await this._write(buildCmd(CMD_DELETE_FILE, [...filenameBytes]));
      const resp = await this._readResponse(CMD_DELETE_FILE, 5000);
      // 0x01 = success, 0x02 = failure
      return resp[3] === 0x01;
    } finally {
      release();
    }
  }

  // ========== Internal Methods ==========

  /**
   * Perform the 3-step handshake with the device
   */
  async _handshake(appUuid) {
    // Helper to format bytes for logging
    const hexDump = (data, maxLen = 20) => {
      const bytes = Array.from(data.slice(0, maxLen)).map(b => '0x' + b.toString(16).padStart(2, '0'));
      return `[${bytes.join(' ')}]${data.length > maxLen ? `... (${data.length} bytes total)` : ''}`;
    };

    // Step 1: Device automatically sends its UUID after notifications are started.
    // Per protocol: "app opens notification channel, device responds and sends device UUID"
    // We do NOT send a command — just wait for the device's notification.
    //
    // DO NOT drain here — connect() already cleared _notifyQueue, and the device's
    // step 1 UUID is the first legitimate notification. Draining would discard it,
    // causing the device to timeout waiting for step 2 (error 0x04).
    //
    // On reconnection, native BLE stack may flush 1-2 stale cached notifications
    // before the real UUID arrives. The loop below skips those.
    const step1Deadline = Date.now() + 8000;
    let step1;
    let step1Attempts = 0;
    const maxStep1Attempts = 4;

    while (true) { // eslint-disable-line no-constant-condition
      const remaining = step1Deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('BLE response timeout waiting for handshake step1');
      }

      step1 = await this._readNotification(Math.min(remaining, 5000));
      step1Attempts++;

      addBreadcrumb({ category: 'ble', message: `handshake step1 raw (attempt ${step1Attempts}): ${hexDump(step1, 30)}`, level: 'info' });

      // Valid step 1: 0x01 0x01 0x00 0x00 + JSON with the device UUID
      // (protocol §二.1.1). Checking only byte[3] let a late reply of another
      // command (e.g. battery 0 % = 0x01 0x09 0x00 0x00) pass as step 1 and
      // fail in JSON.parse with a confusing error.
      if (step1.length >= 5 && step1[0] === TYPE_CMD && step1[1] === CMD_HANDSHAKE[0] &&
          step1[2] === CMD_HANDSHAKE[1] && step1[3] === 0x00) {
        break;
      }

      // Not a valid step 1 — likely a stale native-stack flush or device error
      addBreadcrumb({
        category: 'ble',
        message: `Skipping non-step1 notification (byte[3]=0x${step1[3]?.toString(16)}, len=${step1.length}), attempt ${step1Attempts}/${maxStep1Attempts}`,
        level: 'warning'
      });

      if (step1Attempts >= maxStep1Attempts) {
        const err = new Error(`Handshake step1 failed after ${step1Attempts} attempts: byte[3]=0x${step1[3]?.toString(16)}, raw=${hexDump(step1, 30)}`);
        captureException(err, { tags: { action: 'ble_handshake_step1' }, extra: { rawHex: hexDump(step1, 50) } });
        throw err;
      }
    }
    const deviceJson = parseJsonFromBuffer(step1, 4);
    this.deviceUuid = deviceJson.uuid;

    addBreadcrumb({ category: 'ble', message: `handshake step1 OK: uuid=${deviceJson.uuid}`, level: 'info' });

    // Step 2: Send app UUID + timestamp
    const timestamp = Math.floor(Date.now() / 1000);
    const appJson = JSON.stringify({ time: timestamp, uuid: appUuid });
    const appJsonBytes = new TextEncoder().encode(appJson);
    await this._write(new Uint8Array([TYPE_CMD, CMD_HANDSHAKE[0], CMD_HANDSHAKE[1], 0x01, ...appJsonBytes]));

    // Step 3: Wait for the device's verdict — the frame echoing the
    // handshake command; any other frame is skipped (bounded to 5 s).
    const step3 = await this._readResponse(CMD_HANDSHAKE, 5000);

    addBreadcrumb({ category: 'ble', message: `handshake step3 raw: ${hexDump(step3, 30)}`, level: 'info' });

    // Response: 0x01 0x01 0x00 0x02 <status> [json if status=0x00]
    if (step3.length < 5 || step3[3] !== 0x02) {
      const err = new Error(`Unexpected handshake step3: byte[3]=0x${step3[3].toString(16)}, raw=${hexDump(step3, 30)}`);
      captureException(err, { tags: { action: 'ble_handshake_step3' }, extra: { rawHex: hexDump(step3, 50) } });
      throw err;
    }
    const status = step3[4];
    if (status !== 0x00) {
      const errors = {
        0x01: 'Device rejected pairing (already paired to another app)',
        0x02: 'Data length error',
        0x03: 'Handshake not initiated',
        0x04: 'Handshake timeout'
      };
      const errMsg = errors[status] || `Handshake failed with code 0x${status.toString(16)}`;
      addBreadcrumb({ category: 'ble', message: `handshake step3 rejected: status=0x${status.toString(16)} (${errMsg})`, level: 'warning' });
      throw new Error(errMsg);
    }

    // Parse device info from successful handshake
    const info = parseJsonFromBuffer(step3, 5);
    addBreadcrumb({ category: 'ble', message: `handshake OK: name=${info.name}, SN=${info.SN}, model=${info.model}`, level: 'info' });
    return info;
  }

  /**
   * Write data to the BLE write characteristic
   */
  async _write(data) {
    if (!this.deviceId) {
      // The link dropped (the disconnect callback nulls deviceId) while a
      // command was queued. Fail with the transport error the callers already
      // classify as retryable instead of the plugin's "deviceId required."
      throw new Error('BLE disconnected during transfer');
    }
    const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    await this.ble.writeWithoutResponse(
      this.deviceId,
      BLE_SERVICE_UUID,
      BLE_WRITE_CHAR,
      dataView
    );
  }

  /**
   * Handle incoming BLE notification.
   * Filters unsolicited device-initiated recording notifications so they
   * don't corrupt the command/response queue used by getFileList/downloadFile.
   */
  _onNotify(dataView) {
    const data = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);

    if (data.length >= 3) {
      // Real-time audio from device-initiated recording (TYPE_AUDIO, cmd 0x14 0x00)
      // These stream continuously while the device records — discard them
      if (data[0] === TYPE_AUDIO && data[1] === 0x14 && data[2] === 0x00) {
        return;
      }

      // Any other audio frame is only meaningful inside downloadFile(). A
      // device that kept streaming a file after a dropped link, or a stale
      // stream on reconnect, must not become "the reply" of a command.
      if (data[0] === TYPE_AUDIO && !this._downloadInProgress) {
        if (!this._strayAudioWarned) {
          this._strayAudioWarned = true;
          addBreadcrumb({ category: 'ble', message: 'Dropping stray audio frames outside a download', level: 'warning' });
        }
        return;
      }
      if (data[0] === TYPE_AUDIO) this._strayAudioWarned = false;

      // Unsolicited state reports the device pushes at any time: toggle
      // switch position (0x6E, protocol §15) and WiFi socket state (0x0C,
      // §24). Never a command reply — keep them out of the queue.
      if (data[0] === TYPE_CMD && data[2] === 0x00 && (data[1] === 0x6E || data[1] === 0x0C)) {
        addBreadcrumb({ category: 'ble', message: `Unsolicited device report cmd=0x${data[1].toString(16)} dropped`, level: 'info' });
        return;
      }

      // Recording started via device button (TYPE_CMD, cmd 0x14 0x00 + JSON
      // {file, creat_time, toggle_switch}). The same frame with
      // {"RecordStartErr":"MemoryErr"|"MemoryFull"} means the recording did
      // NOT start (protocol §三.1.1) — card missing / unsupported / full.
      if (data[0] === TYPE_CMD && data[1] === 0x14 && data[2] === 0x00) {
        let startErr = null;
        try {
          const json = data.length > 3 ? parseJsonFromBuffer(data, 3) : {};
          if (json && json.RecordStartErr) startErr = String(json.RecordStartErr);
        } catch { /* no / partial JSON — treat as started */ }
        if (startErr) {
          this.isRecording = false;
          this.lastRecordStartError = startErr;
          addBreadcrumb({ category: 'ble', message: `Device could not start recording: ${startErr}`, level: 'warning' });
          if (this._recordingStateCallback) this._recordingStateCallback(false, startErr);
          return;
        }
        this.isRecording = true;
        addBreadcrumb({ category: 'ble', message: 'Device started recording (button)', level: 'info' });
        if (this._recordingStateCallback) this._recordingStateCallback(true);
        return;
      }

      // Recording stopped via device button (TYPE_CMD, cmd 0x17 0x00)
      if (data[0] === TYPE_CMD && data[1] === 0x17 && data[2] === 0x00) {
        this.isRecording = false;
        addBreadcrumb({ category: 'ble', message: 'Device stopped recording (button)', level: 'info' });
        if (this._recordingStateCallback) this._recordingStateCallback(false);
        return;
      }
    }

    // Normal protocol response — deliver to waiter or queue
    if (this._notifyWaiter) {
      const waiter = this._notifyWaiter;
      this._notifyWaiter = null;
      waiter.resolve(data);
    } else {
      // No waiter. If we just timed out a _readNotification within the
      // last 5 s, this notification is almost certainly the late-arriving
      // response for that abandoned command. Queueing it would poison the
      // next command's _readNotification with stale bytes — exactly the
      // kind of corruption that produced the "stale-response cascade"
      // bug. Drop instead.
      if (Date.now() - this._lastReadTimeoutAt < 5000) {
        addBreadcrumb({
          category: 'ble',
          message: `Dropped late notification (within 5s of prior timeout, ${data.length} bytes)`,
          level: 'warning'
        });
        return;
      }
      this._notifyQueue.push(data);
    }
  }

  /**
   * Drain stale notifications, waiting until the device goes quiet.
   * After an interrupted getFileList, the device may still be streaming
   * hundreds of file entries. A single queue clear misses notifications
   * that arrive between the clear and the next command.
   * This method drains repeatedly until no new notifications arrive
   * for `quietMs` milliseconds.
   *
   * @param {number} quietMs - how long the queue must stay empty to stop draining
   * @param {number} maxWaitMs - absolute upper bound; ignored if too small for expectedCount
   * @param {number} expectedCount - optional hint: if caller knows the device may stream
   *   N stale notifications, scale the upper bound to give time for them all to arrive
   *   (approximated at 50ms per entry based on observed file-list streaming rate).
   */
  async _drainNotifyQueue(quietMs = 300, maxWaitMs = 5000, expectedCount = 0) {
    const effectiveMaxWait = expectedCount > 0
      ? Math.max(maxWaitMs, Math.min(expectedCount * 50, 60000))
      : maxWaitMs;
    let totalDrained = 0;
    const startTime = Date.now();

    while (Date.now() - startTime < effectiveMaxWait) {
      const count = this._notifyQueue.length;
      if (count > 0) {
        totalDrained += count;
        this._notifyQueue = [];
      }
      // Wait and check if more arrive
      await new Promise(r => setTimeout(r, quietMs));
      if (this._notifyQueue.length === 0) {
        // Device went quiet
        break;
      }
    }

    // Final drain
    totalDrained += this._notifyQueue.length;
    this._notifyQueue = [];

    if (totalDrained > 0) {
      addBreadcrumb({ category: 'ble', message: `Drained ${totalDrained} stale BLE notification(s) in ${Date.now() - startTime}ms (expectedCount=${expectedCount})`, level: 'warning' });
    }
  }

  /**
   * Read the next notification that is the reply to `cmd` (TYPE_CMD followed
   * by the two command bytes). Frames that are not that reply — a late reply
   * to an abandoned command, a device report — are skipped, so a caller
   * never parses the wrong frame as its answer. Bounded by `timeout` overall.
   * @param {number[]} cmd
   * @param {number} timeout
   * @returns {Promise<Uint8Array>}
   */
  async _readResponse(cmd, timeout = 10000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('BLE response timeout');
      const resp = await this._readNotification(remaining);
      if (resp.length >= 3 && resp[0] === TYPE_CMD && resp[1] === cmd[0] && resp[2] === cmd[1]) {
        return resp;
      }
      addBreadcrumb({
        category: 'ble',
        message: `skipped frame while waiting for cmd 0x${cmd[0].toString(16)}: [${Array.from(resp.slice(0, 5)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}]`,
        level: 'warning'
      });
    }
  }

  /**
   * Wait for the next notification with timeout
   */
  _readNotification(timeout = 10000) {
    // Check abort flag first
    if (this._downloadAborted) {
      return Promise.reject(new Error('BLE download cancelled'));
    }

    // Check queue first
    if (this._notifyQueue.length > 0) {
      return Promise.resolve(this._notifyQueue.shift());
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._notifyWaiter = null;
        // Record the timeout so _onNotify drops any late-arriving response
        // for the now-abandoned command within the next 5 s window.
        this._lastReadTimeoutAt = Date.now();
        reject(new Error('BLE response timeout'));
      }, timeout);

      this._notifyWaiter = {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      };
    });
  }
}

// Singleton instance
let _instance = null;

/**
 * Get the singleton BLE device manager
 */
export function getBleManager() {
  if (!_instance) {
    _instance = new BleDeviceManager();
  }
  return _instance;
}
