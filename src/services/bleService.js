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

import { isCapacitor, isAndroid } from '../utils/platform';
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
    this._onDisconnectCallback = null;
    this._recordingStateCallback = null;
    this._downloadAborted = false;

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
    captureMessage(`BLE initialize: androidNeverForLocation=${neverForLocation}, platform=${isAndroid() ? 'android' : 'ios'}`, 'info');
    try {
      await this.ble.initialize({ androidNeverForLocation: neverForLocation });
      this._initialized = true;
      captureMessage('BLE initialize: SUCCESS — permissions granted', 'info');
    } catch (e) {
      this._initialized = false;
      captureMessage(`BLE initialize: FAILED — ${e.message}`, 'error');
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
      captureMessage(`BLE scan pre-check: bluetooth=${bleEnabled}`, 'info');
      if (!bleEnabled) {
        captureMessage('BLE scan: Bluetooth disabled — requesting enable', 'warning');
        await this.ble.requestEnable();
        const rechecked = await this.ble.isEnabled();
        if (!rechecked) {
          throw new Error('Bluetooth is required for device scanning. Please enable Bluetooth.');
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

      // Log all nearby names to Sentry so we can identify new device variants
      captureMessage(`BLE name-scan: found=[${[...seen].length}] all_nearby=[${allSeen.join(', ')}]`, 'info');
    }

    addBreadcrumb({
      category: 'ble',
      message: `BLE scan complete: ${devicesFound} device(s) found`,
      level: 'info'
    });

    if (devicesFound === 0) {
      captureMessage(`BLE scan: 0 devices found. All nearby: [${allSeen.join(', ')}]`, 'warning');
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
   * @returns {Promise<Object>} Device info from handshake
   */
  async connect(bleDeviceId, appUuid) {
    if (!this.ble) await this.initialize();

    addBreadcrumb({
      category: 'ble',
      message: `BLE connecting to device ${bleDeviceId}`,
      level: 'info'
    });

    this.deviceId = bleDeviceId;
    this._notifyQueue = [];
    this._notifyWaiter = null;

    // Ensure the BLE plugin knows about this device (needed for reconnection
    // to previously paired devices without a fresh scan)
    try {
      await this.ble.getDevices([bleDeviceId]);
      addBreadcrumb({ category: 'ble', message: 'BLE getDevices OK', level: 'info' });
    } catch (e) {
      addBreadcrumb({ category: 'ble', message: `BLE getDevices failed: ${e.message}, will try connect anyway`, level: 'warning' });
    }

    // Connect
    try {
      await this.ble.connect(bleDeviceId, (deviceId) => {
        this.connected = false;
        this.deviceId = null;
        addBreadcrumb({ category: 'ble', message: `BLE disconnected: ${deviceId}`, level: 'warning' });
        if (this._onDisconnectCallback) {
          this._onDisconnectCallback(deviceId);
        }
      });
      addBreadcrumb({ category: 'ble', message: 'BLE connected, starting notifications', level: 'info' });
    } catch (e) {
      captureException(e, { tags: { action: 'ble_connect' }, extra: { bleDeviceId } });
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
      captureException(e, { tags: { action: 'ble_notifications' }, extra: { bleDeviceId } });
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

      return deviceInfo;
    } catch (e) {
      captureException(e, { tags: { action: 'ble_handshake' }, extra: { bleDeviceId } });
      await this.disconnect();
      throw new Error(`Handshake failed: ${e.message}`);
    }
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
      const resp = await this._readNotification(30000);
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
      const release = await this._acquireLock();
      try {
        await this._write(buildCmd(CMD_UNPAIR));
        await this._readNotification(3000);
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
      const resp = await this._readNotification(5000);
      // Response: 0x01 0x09 0x00 <level>
      // Validate this is actually a battery response before reading the value
      if (resp.length < 4 || resp[0] !== TYPE_CMD || resp[1] !== CMD_BATTERY[0] || resp[2] !== CMD_BATTERY[1]) {
        addBreadcrumb({ category: 'ble', message: `getBattery: unexpected response [${Array.from(resp.slice(0, 6)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`, level: 'warning' });
        return -1; // Signal invalid reading — caller should ignore
      }
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
      const resp = await this._readNotification(5000);
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
      await this._readNotification(3000);
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
      const resp = await this._readNotification(5000);
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
    // Drain any stale notifications from previous operations
    await this._drainNotifyQueue();

    // Enter sync state
    await this._write(buildCmd(CMD_SYNC_STATE, [0x01]));
    await this._readNotification(5000);

    try {
      // Request file list
      await this._write(buildCmd(CMD_FILE_LIST));

      // First response: file count
      const countResp = await this._readNotification(10000);
      addBreadcrumb({ category: 'ble', message: `getFileList countResp raw: [${Array.from(countResp.slice(0, 20)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}...] len=${countResp.length}`, level: 'info' });

      const countJson = parseJsonFromBuffer(countResp, 3);
      addBreadcrumb({ category: 'ble', message: `getFileList countJson: ${JSON.stringify(countJson)}`, level: 'info' });

      // Check for error (device busy)
      if (countJson.FileList) {
        throw new Error(countJson.FileList);
      }

      const fileCount = countJson.FileNum || 0;
      addBreadcrumb({ category: 'ble', message: `getFileList fileCount=${fileCount}`, level: 'info' });
      const files = [];
      let skipped = 0;

      // Read each file info — skip corrupt entries instead of aborting.
      // All fileCount notifications MUST be consumed, otherwise the device
      // keeps streaming and stale data floods subsequent commands.
      for (let i = 0; i < fileCount; i++) {
        try {
          const fileResp = await this._readNotification(10000);

          // Validate: must be a CMD response for FILE_LIST
          if (fileResp.length < 4 || fileResp[0] !== TYPE_CMD ||
              fileResp[1] !== CMD_FILE_LIST[0] || fileResp[2] !== CMD_FILE_LIST[1]) {
            skipped++;
            addBreadcrumb({ category: 'ble', message: `getFileList file[${i}]: skipped non-file-list response (byte[1]=0x${fileResp[1]?.toString(16)})`, level: 'warning' });
            continue;
          }

          const fileJson = parseJsonFromBuffer(fileResp, 3);
          if (fileJson.file) {
            files.push(fileJson);
          } else {
            skipped++;
            addBreadcrumb({ category: 'ble', message: `getFileList file[${i}]: skipped entry without filename: ${JSON.stringify(fileJson)}`, level: 'warning' });
          }
        } catch (entryErr) {
          skipped++;
          addBreadcrumb({ category: 'ble', message: `getFileList file[${i}]: parse error (${entryErr.message}), skipping`, level: 'warning' });
        }
      }

      addBreadcrumb({ category: 'ble', message: `getFileList done: ${files.length} files, ${skipped} skipped out of ${fileCount}`, level: 'info' });
      return files;
    } finally {
      // Always exit sync state — even on error/timeout.
      // Without this, the device stays locked in "transferring" mode permanently.
      try {
        await this._write(buildCmd(CMD_SYNC_STATE, [0x00]));
        await this._readNotification(3000);
      } catch { /* best effort */ }
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
   */
  abortDownload() {
    this._downloadAborted = true;
    if (this._notifyWaiter && this._notifyWaiter.reject) {
      const waiter = this._notifyWaiter;
      this._notifyWaiter = null;
      waiter.reject(new Error('BLE download cancelled'));
    }
  }

  async downloadFile(filename, onProgress = null, totalSize = 0) {
    const release = await this._acquireLock();
    this._downloadAborted = false;

    // Drain any stale notifications from previous operations
    await this._drainNotifyQueue();

    // Enter sync state
    await this._write(buildCmd(CMD_SYNC_STATE, [0x01]));
    await this._readNotification(5000);

    // Send download command with filename
    const filenameBytes = new TextEncoder().encode(filename);
    await this._write(buildCmd(CMD_FILE_DOWNLOAD, [...filenameBytes]));

    // Receive audio frames until transfer complete
    const chunks = [];
    let receivedBytes = 0;

    try {
      let transferring = true;
      while (transferring) {
        const data = await this._readNotification(30000);

        if (data[0] === TYPE_AUDIO) {
          // Audio data frame: type(1) + cmd(2) + index(2) + audio(N)
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

          // Concatenate all chunks
          const fileData = new Uint8Array(receivedBytes);
          let offset = 0;
          for (const chunk of chunks) {
            fileData.set(chunk, offset);
            offset += chunk.length;
          }

          // Verify CRC
          const actualCrc = crc16Compute(fileData);
          if (actualCrc !== expectedCrc) {
            // Exit sync state
            await this._write(buildCmd(CMD_SYNC_STATE, [0x00]));
            await this._readNotification(3000);
            throw new Error(`CRC mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`);
          }

          if (onProgress) onProgress({ percent: 100, bytesReceived: receivedBytes, bytesTotal: totalSize });

          // Exit sync state
          await this._write(buildCmd(CMD_SYNC_STATE, [0x00]));
          await this._readNotification(3000);

          return fileData;
        }
      }
    } catch (err) {
      // Always exit sync state on failure/abort so device buttons work again
      try {
        await this._write(buildCmd(CMD_SYNC_STATE, [0x00]));
        await this._readNotification(3000);
      } catch { /* best effort */ }
      throw err;
    } finally {
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
      const resp = await this._readNotification(5000);
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

      captureMessage(`BLE handshake step1 raw (attempt ${step1Attempts}): ${hexDump(step1, 30)}`, 'info');

      // Valid step 1: byte[3]=0x00, followed by JSON with device UUID
      if (step1.length >= 5 && step1[3] === 0x00) {
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

    captureMessage(`BLE handshake step1 OK: uuid=${deviceJson.uuid}`, 'info');

    // Step 2: Send app UUID + timestamp
    const timestamp = Math.floor(Date.now() / 1000);
    const appJson = JSON.stringify({ time: timestamp, uuid: appUuid });
    const appJsonBytes = new TextEncoder().encode(appJson);
    await this._write(new Uint8Array([TYPE_CMD, CMD_HANDSHAKE[0], CMD_HANDSHAKE[1], 0x01, ...appJsonBytes]));

    // Step 3: Wait for device verification
    const step3 = await this._readNotification(5000);

    captureMessage(`BLE handshake step3 raw: ${hexDump(step3, 30)}`, 'info');

    // Response: 0x01 0x01 0x00 0x02 <status> [json if status=0x00]
    if (step3[3] !== 0x02) {
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
      captureMessage(`BLE handshake step3 rejected: status=0x${status.toString(16)} (${errMsg})`, 'warning');
      throw new Error(errMsg);
    }

    // Parse device info from successful handshake
    const info = parseJsonFromBuffer(step3, 5);
    captureMessage(`BLE handshake OK: name=${info.name}, SN=${info.SN}, model=${info.model}`, 'info');
    return info;
  }

  /**
   * Write data to the BLE write characteristic
   */
  async _write(data) {
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

      // Recording started via device button (TYPE_CMD, cmd 0x14 0x00)
      if (data[0] === TYPE_CMD && data[1] === 0x14 && data[2] === 0x00) {
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
   */
  async _drainNotifyQueue(quietMs = 300, maxWaitMs = 5000) {
    let totalDrained = 0;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
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
      addBreadcrumb({ category: 'ble', message: `Drained ${totalDrained} stale BLE notification(s)`, level: 'warning' });
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
