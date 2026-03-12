/**
 * Pinia store for BLE recording device state management
 * Handles pairing, connection, file sync, and upload of device recordings
 */

import { defineStore } from 'pinia';
import { v4 as uuidv4 } from 'uuid';
import { isCapacitor } from '../utils/platform';
import { getBleManager } from '../services/bleService';
import { addBreadcrumb, captureException } from '../boot/sentry';
import { uploadWithVerification } from '../services/upload';
import { getApiUrlSync } from '../services/api';
import { useAuthStore } from './auth';
import { useRecordingsHistoryStore } from './recordings-history';

// Preferences keys
const PREF_PAIRED_DEVICE = 'ble_paired_device';
const PREF_APP_UUID = 'ble_app_uuid';
const PREF_SYNCED_FILES = 'ble_synced_files';

/**
 * Get or create a persistent app UUID for BLE pairing
 */
async function getOrCreateAppUuid() {
  if (isCapacitor()) {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: PREF_APP_UUID });
    if (value) return value;
    const newUuid = uuidv4();
    await Preferences.set({ key: PREF_APP_UUID, value: newUuid });
    return newUuid;
  }
  // Fallback for non-capacitor (shouldn't happen)
  let uuid = localStorage.getItem(PREF_APP_UUID);
  if (!uuid) {
    uuid = uuidv4();
    localStorage.setItem(PREF_APP_UUID, uuid);
  }
  return uuid;
}

export const useDeviceStore = defineStore('device', {
  state: () => ({
    // Connection
    connectionState: 'disconnected', // disconnected | scanning | connecting | connected
    error: null,

    // Paired device (persisted)
    pairedDevice: null, // { deviceId, uuid, name, sn }

    // Device details (live, from connection)
    deviceName: '',
    deviceSN: '',
    deviceUuid: '',
    batteryLevel: 0,
    freeStorageKB: 0,
    totalStorageKB: 0,
    isRecordingOnDevice: false,

    // File list
    deviceFiles: [],
    fileListLoaded: false,

    // Sync
    syncState: 'idle', // idle | syncing | complete | error
    syncCurrent: 0,
    syncTotal: 0,
    syncProgress: 0,
    currentSyncFile: null,
    syncError: null,

    // Already synced files (persisted)
    syncedFiles: [],

    // Scan results
    scanResults: [],

    // Auto-sync polling
    _autoSyncTimer: null
  }),

  getters: {
    hasPairedDevice: (state) => !!state.pairedDevice,
    isScanning: (state) => state.connectionState === 'scanning',
    isConnecting: (state) => state.connectionState === 'connecting',
    isConnected: (state) => state.connectionState === 'connected',
    isSyncing: (state) => state.syncState === 'syncing',
    newFiles: (state) => state.deviceFiles.filter(f => !state.syncedFiles.includes(f.file)),
    newFilesCount() { return this.newFiles.length; }
  },

  actions: {
    /**
     * Initialize BLE and load persisted state
     */
    async initialize() {
      if (!isCapacitor()) return;

      const manager = getBleManager();
      await manager.initialize();

      // Load persisted data
      await this._loadPairedDevice();
      await this._loadSyncedFiles();

      // Set disconnect handler
      manager.onDisconnect(() => {
        this.stopAutoSync();
        this.connectionState = 'disconnected';
        this.deviceFiles = [];
        this.fileListLoaded = false;
      });
    },

    /**
     * Start scanning for devices
     */
    async startScan() {
      this.connectionState = 'scanning';
      this.scanResults = [];
      this.error = null;

      const manager = getBleManager();
      const seen = new Set();

      try {
        await manager.scan(7000, (device) => {
          if (!seen.has(device.deviceId)) {
            seen.add(device.deviceId);
            this.scanResults.push(device);
          }
        });
        addBreadcrumb({
          category: 'ble',
          message: `Scan finished: ${this.scanResults.length} unique device(s)`,
          data: { devices: this.scanResults.map(d => d.name || d.deviceId) },
          level: 'info'
        });
      } catch (e) {
        captureException(e, { tags: { action: 'ble_scan' } });
        this.error = e.message;
        throw e;
      } finally {
        if (this.connectionState === 'scanning') {
          this.connectionState = 'disconnected';
        }
      }
    },

    /**
     * Stop scanning
     */
    async stopScan() {
      const manager = getBleManager();
      await manager.stopScan();
      this.connectionState = 'disconnected';
    },

    /**
     * Connect to a device and pair
     */
    async connectAndPair(bleDeviceId) {
      if (this.connectionState === 'connecting') return; // Prevent double-tap
      this.connectionState = 'connecting';
      this.error = null;

      try {
        const manager = getBleManager();
        const appUuid = await getOrCreateAppUuid();
        const deviceInfo = await manager.connect(bleDeviceId, appUuid);

        // Store device info
        this.deviceName = deviceInfo.name || deviceInfo.model || 'Recording Device';
        this.deviceSN = deviceInfo.SN || '';
        this.deviceUuid = manager.deviceUuid;
        this.isRecordingOnDevice = deviceInfo.isAudioRecorded === '1';
        this.connectionState = 'connected';

        // Save paired device
        this.pairedDevice = {
          deviceId: bleDeviceId,
          uuid: manager.deviceUuid,
          name: this.deviceName,
          sn: this.deviceSN
        };
        await this._savePairedDevice();

        // Fetch battery + storage + file list
        await this._fetchDeviceStatus();
        await this.fetchFileList();

        // Start background auto-sync polling
        this.startAutoSync();

        return deviceInfo;
      } catch (e) {
        captureException(e, { tags: { action: 'ble_pair' }, extra: { bleDeviceId } });
        this.connectionState = 'disconnected';
        this.error = e.message;
        throw e;
      }
    },

    /**
     * Auto-connect to a previously paired device
     */
    async autoConnect() {
      if (!this.pairedDevice) return;
      if (this.connectionState === 'connecting') return; // Prevent double-tap

      this.connectionState = 'connecting';
      this.error = null;

      try {
        const manager = getBleManager();
        const appUuid = await getOrCreateAppUuid();
        const deviceInfo = await manager.connect(this.pairedDevice.deviceId, appUuid);

        this.deviceName = deviceInfo.name || deviceInfo.model || this.pairedDevice.name;
        this.deviceSN = deviceInfo.SN || this.pairedDevice.sn;
        this.deviceUuid = manager.deviceUuid;
        this.isRecordingOnDevice = deviceInfo.isAudioRecorded === '1';
        this.connectionState = 'connected';

        // Update paired device info
        this.pairedDevice.name = this.deviceName;
        this.pairedDevice.sn = this.deviceSN;
        await this._savePairedDevice();

        await this._fetchDeviceStatus();
        await this.fetchFileList();

        // Start background auto-sync polling
        this.startAutoSync();

        return deviceInfo;
      } catch (e) {
        this.connectionState = 'disconnected';
        this.error = e.message;
        throw e;
      }
    },

    /**
     * Disconnect from device
     */
    async disconnect() {
      this.stopAutoSync();
      const manager = getBleManager();
      await manager.disconnect();
      this.connectionState = 'disconnected';
      this.deviceFiles = [];
      this.fileListLoaded = false;
    },

    /**
     * Forget (unpair) the device
     */
    async forgetDevice() {
      this.stopAutoSync();
      const manager = getBleManager();
      await manager.unpair();
      this.connectionState = 'disconnected';
      this.pairedDevice = null;
      this.deviceName = '';
      this.deviceSN = '';
      this.deviceUuid = '';
      this.batteryLevel = 0;
      this.freeStorageKB = 0;
      this.totalStorageKB = 0;
      this.deviceFiles = [];
      this.fileListLoaded = false;
      this.scanResults = [];

      if (isCapacitor()) {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.remove({ key: PREF_PAIRED_DEVICE });
      }
    },

    /**
     * Fetch file list from device
     */
    async fetchFileList() {
      if (!this.isConnected) return;

      try {
        const manager = getBleManager();
        const files = await manager.getFileList();
        this.deviceFiles = files.sort((a, b) => b.creat_time - a.creat_time);
        this.fileListLoaded = true;
      } catch (e) {
        console.warn('Failed to fetch file list:', e.message);
        this.deviceFiles = [];
        this.fileListLoaded = true;
      }
    },

    /**
     * Download a single file and queue it for upload
     */
    async syncFile(file) {
      if (this.syncedFiles.includes(file.file)) return;

      this.syncState = 'syncing';
      this.currentSyncFile = file.file;
      this.syncCurrent = 1;
      this.syncTotal = 1;
      this.syncProgress = 0;
      this.syncError = null;

      try {
        await this._downloadAndUpload(file);
        this.syncState = 'complete';
      } catch (e) {
        this.syncState = 'error';
        this.syncError = e.message;
        throw e;
      } finally {
        this.currentSyncFile = null;
      }
    },

    /**
     * Sync all new (un-synced) files
     */
    async syncAllNew() {
      const newFiles = this.deviceFiles.filter(f => !this.syncedFiles.includes(f.file));
      if (newFiles.length === 0) return;

      this.syncState = 'syncing';
      this.syncTotal = newFiles.length;
      this.syncCurrent = 0;
      this.syncError = null;

      try {
        for (const file of newFiles) {
          this.syncCurrent++;
          this.currentSyncFile = file.file;
          this.syncProgress = 0;
          await this._downloadAndUpload(file);
        }
        this.syncState = 'complete';
      } catch (e) {
        this.syncState = 'error';
        this.syncError = e.message;
        throw e;
      } finally {
        this.currentSyncFile = null;
      }
    },

    /**
     * Download file from device and upload to backend
     */
    async _downloadAndUpload(file) {
      const manager = getBleManager();

      // Download via BLE
      const fileData = await manager.downloadFile(
        file.file,
        (progress) => { this.syncProgress = progress; },
        file.size
      );

      // Save to device filesystem
      const { Filesystem, Directory } = await import('@capacitor/filesystem');

      // Convert Uint8Array to base64
      let binary = '';
      const len = fileData.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(fileData[i]);
      }
      const base64Data = btoa(binary);

      const dirPath = 'suissenotes_recordings';
      try {
        await Filesystem.mkdir({ path: dirPath, directory: Directory.Documents, recursive: true });
      } catch { /* exists */ }

      await Filesystem.writeFile({
        path: `${dirPath}/${file.file}`,
        data: base64Data,
        directory: Directory.Documents
      });

      // Store relative path — readFile uses Directory.Documents as base
      const filePath = `${dirPath}/${file.file}`;

      // Create a recording ID and upload
      const recordId = uuidv4();
      const authStore = useAuthStore();
      const historyStore = useRecordingsHistoryStore();

      // Extract title and date from filename: R20250311-093012.opus → 2025-03-11 09:30
      // Device clock is synced to phone's local time, so filename timestamps are local
      const title = this._formatTitleFromFilename(file.file);
      const createdAt = this._parseDateFromFilename(file.file) || new Date(file.creat_time * 1000).toISOString();
      const durationSec = Math.round((file.duration_ms || 0) / 1000);

      // Add to history
      await historyStore.addRecording({
        id: recordId,
        title,
        duration: durationSec,
        filePath,
        createdAt,
        uploadStatus: 'pending',
        source: 'device'
      });

      // Upload
      try {
        const result = await uploadWithVerification({
          filePath,
          recordId,
          apiUrl: getApiUrlSync(),
          authToken: authStore.token,
          metadata: {
            duration: durationSec.toString(),
            title,
            filename: file.file
          },
          onProgress: () => {},
          getAuthStore: () => authStore
        });

        if (result.success) {
          await historyStore.updateRecording(recordId, {
            uploadStatus: 'uploaded',
            transcriptionId: result.transcriptionId,
            audioFileId: result.audioFileId
          });
          addBreadcrumb({ category: 'ble', message: `Device file uploaded: ${file.file}`, level: 'info' });
        } else {
          captureException(new Error(`Device file upload failed: ${result.error}`), {
            tags: { action: 'ble_upload' },
            extra: { filename: file.file, recordId, error: result.error }
          });
        }
      } catch (uploadErr) {
        captureException(uploadErr, {
          tags: { action: 'ble_upload' },
          extra: { filename: file.file, recordId, filePath }
        });
        // The file is saved locally and in history as 'pending', so it can be retried
      }

      // Mark as synced regardless of upload success (file is on phone now)
      await this._addSyncedFile(file.file);
    },

    /**
     * Format a filename like R20250311-093012.opus into a readable title
     */
    _formatTitleFromFilename(filename) {
      // R20250311-093012.opus → 2025-03-11 09:30
      const match = filename.match(/R(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
      if (match) {
        const [, y, m, d, h, min] = match;
        return `${y}-${m}-${d} ${h}:${min}`;
      }
      return filename.replace(/\.\w+$/, '');
    },

    /**
     * Parse a local-timezone Date from device filename
     * Device clock is synced from phone's local time, so timestamps are local
     */
    _parseDateFromFilename(filename) {
      const match = filename.match(/R(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
      if (match) {
        const [, y, m, d, h, min, sec] = match;
        return new Date(+y, +m - 1, +d, +h, +min, +sec).toISOString();
      }
      return null;
    },

    /**
     * Fetch battery and storage from device
     */
    async _fetchDeviceStatus() {
      const manager = getBleManager();
      try {
        this.batteryLevel = await manager.getBattery();
      } catch (e) {
        console.warn('Failed to get battery:', e.message);
      }
      try {
        const storage = await manager.getStorage();
        this.freeStorageKB = storage.FreeCapacity || 0;
        this.totalStorageKB = storage.TotalCapacity || 0;
      } catch (e) {
        console.warn('Failed to get storage:', e.message);
      }
    },

    // ========== Auto-Sync ==========

    /**
     * Start polling for new files while connected.
     * Waits 30s after connect, then polls every 60s.
     * Only fetches file list (lightweight) — skips battery/storage to avoid
     * overwhelming the BLE device and causing disconnects.
     */
    startAutoSync() {
      this.stopAutoSync();
      // Initial delay: let the connection stabilize before polling
      this._autoSyncTimer = setTimeout(() => {
        this._autoSyncPoll();
        // Then poll every 60 seconds
        this._autoSyncTimer = setInterval(() => {
          this._autoSyncPoll();
        }, 60000);
      }, 30000);
    },

    async _autoSyncPoll() {
      if (!this.isConnected || this.isSyncing) return;

      try {
        await this.fetchFileList();

        // Don't sync while device is actively recording
        if (this.isRecordingOnDevice) return;

        const newFiles = this.deviceFiles.filter(f => !this.syncedFiles.includes(f.file));
        if (newFiles.length > 0) {
          addBreadcrumb({
            category: 'ble',
            message: `Auto-sync: ${newFiles.length} new file(s) detected`,
            level: 'info'
          });
          await this.syncAllNew();
        }
      } catch (e) {
        // Connection may have dropped — stop polling to avoid noise
        console.log('Auto-sync poll error:', e.message);
        this.stopAutoSync();
      }
    },

    /**
     * Stop auto-sync polling
     */
    stopAutoSync() {
      if (this._autoSyncTimer) {
        clearTimeout(this._autoSyncTimer);
        clearInterval(this._autoSyncTimer);
        this._autoSyncTimer = null;
      }
    },

    // ========== Persistence ==========

    async _savePairedDevice() {
      if (isCapacitor()) {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.set({
          key: PREF_PAIRED_DEVICE,
          value: JSON.stringify(this.pairedDevice)
        });
      }
    },

    async _loadPairedDevice() {
      if (isCapacitor()) {
        const { Preferences } = await import('@capacitor/preferences');
        const { value } = await Preferences.get({ key: PREF_PAIRED_DEVICE });
        if (value) {
          try {
            this.pairedDevice = JSON.parse(value);
          } catch { /* invalid */ }
        }
      }
    },

    async _loadSyncedFiles() {
      if (isCapacitor()) {
        const { Preferences } = await import('@capacitor/preferences');
        const { value } = await Preferences.get({ key: PREF_SYNCED_FILES });
        if (value) {
          try {
            this.syncedFiles = JSON.parse(value);
          } catch {
            this.syncedFiles = [];
          }
        }
      }
    },

    async _addSyncedFile(filename) {
      if (!this.syncedFiles.includes(filename)) {
        this.syncedFiles.push(filename);
        if (isCapacitor()) {
          const { Preferences } = await import('@capacitor/preferences');
          await Preferences.set({
            key: PREF_SYNCED_FILES,
            value: JSON.stringify(this.syncedFiles)
          });
        }
      }
    }
  }
});
