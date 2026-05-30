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
import { isRawOpusPackets, rawOpusToOgg } from '../utils/rawOpusToOgg';
import { i18n } from '../boot/i18n';

// Preferences base keys (scoped per-user at runtime via _userPrefKey)
const PREF_PAIRED_DEVICE = 'ble_paired_device';
const PREF_APP_UUID = 'ble_app_uuid';
const PREF_SYNCED_FILES = 'ble_synced_files';
const PREF_REJECTED_DEVICES = 'ble_rejected_devices';
const PREF_SKIPPED_FILES = 'ble_skipped_files';

/**
 * Scope a preference key to the current user.
 * Returns 'key:uUSERID' when authenticated, 'key' as fallback.
 */
function _userPrefKey(baseKey) {
  const auth = useAuthStore();
  const userId = auth.user?.id;
  return userId ? `${baseKey}:u${userId}` : baseKey;
}

// Background timers
const RECONNECT_INTERVAL_MS = 15_000;  // Try reconnect every 15s
const DISCOVERY_INTERVAL_MS = 15_000;  // Scan for new devices every 15s
const DISCOVERY_SCAN_DURATION = 5000;  // Quick 5s scan for discovery
const MAX_RECONNECT_ATTEMPTS = 10;     // After this, connectionState='lost' — manual retry required

// Notification IDs
const NOTIF_SYNC_PROGRESS = 9001;
const NOTIF_SYNC_COMPLETE = 9002;

/**
 * Send a local notification (fire-and-forget, never blocks sync)
 */
async function sendLocalNotification(id, title, body) {
  if (!isCapacitor()) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted') {
      const result = await LocalNotifications.requestPermissions();
      if (result.display !== 'granted') return;
    }
    await LocalNotifications.schedule({
      notifications: [{ id, title, body, smallIcon: 'ic_stat_icon_config_sample' }]
    });
  } catch {
    // Notifications are best-effort — never fail sync
  }
}

/**
 * Get or create a persistent app UUID for BLE pairing.
 * NOT user-scoped — the device firmware locks to this UUID per phone installation.
 * Changing it per-user would cause "already paired to another app" rejection.
 *
 * Migration: a previous version stored UUIDs per-user under 'ble_app_uuid:uXXX'.
 * If a user-scoped UUID exists but no installation UUID, adopt it so devices
 * paired during that period still recognize this phone.
 */
async function getOrCreateAppUuid() {
  if (isCapacitor()) {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: PREF_APP_UUID });
    if (value) return value;

    // Migration: check if a user-scoped UUID exists from the previous version
    const auth = useAuthStore();
    const userId = auth.user?.id;
    if (userId) {
      const scopedKey = `${PREF_APP_UUID}:u${userId}`;
      const { value: scopedUuid } = await Preferences.get({ key: scopedKey });
      if (scopedUuid) {
        // Adopt the scoped UUID as the installation UUID
        await Preferences.set({ key: PREF_APP_UUID, value: scopedUuid });
        return scopedUuid;
      }
    }

    const newUuid = uuidv4();
    await Preferences.set({ key: PREF_APP_UUID, value: newUuid });
    return newUuid;
  }
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
    connectionState: 'disconnected', // disconnected | scanning | connecting | connected | lost
    error: null,
    // 'lost' = reconnect gave up after MAX_RECONNECT_ATTEMPTS; user must tap "Retry"

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
    syncBytesReceived: 0,
    syncBytesTotal: 0,
    syncPhase: 'idle', // idle | detecting | downloading | saving | uploading
    currentSyncFile: null,
    syncError: null,
    syncErrorPhase: null, // phase in which error occurred: 'downloading' | 'saving' | 'uploading' | 'detecting'

    // Already synced files (persisted)
    syncedFiles: [],

    // Skipped files — cancelled by user, auto-sync ignores these (persisted)
    skippedFiles: [],

    // Cancel flag for in-progress sync
    _cancelRequested: false,

    // Scan results
    scanResults: [],

    // Auto-sync polling
    _autoSyncTimer: null,

    // Auto-reconnect
    _reconnectTimer: null,
    _reconnectAttempts: 0, // counter for current reconnect session; reset on success or manual retry
    _intentionalDisconnect: false,
    _appStateListener: null,
    _initialized: false,
    // Mutex shared between _scheduleReconnect's exponential-backoff loop,
    // _startPersistentReconnect's 15s interval, and retryConnect. Prevents
    // two reconnect paths from racing into autoConnect() simultaneously and
    // sending two concurrent BLE connect requests for the same device. The
    // autoConnect 'connecting' guard only catches double-tap on a single
    // call stack; this catches cross-timer races.
    _reconnectInProgress: false,

    // Persistent reconnect & discovery
    _persistentReconnectTimer: null,
    _discoveryTimer: null,
    _blePermissionsGranted: false,

    // New device discovery
    discoveredDevice: null, // { deviceId, name, rssi } — triggers global popup
    rejectedDeviceIds: []   // Persisted list of rejected device IDs
  }),

  getters: {
    hasPairedDevice: (state) => !!state.pairedDevice,
    isScanning: (state) => state.connectionState === 'scanning',
    isConnecting: (state) => state.connectionState === 'connecting',
    isConnected: (state) => state.connectionState === 'connected',
    isSyncing: (state) => state.syncState === 'syncing',
    newFiles: (state) => state.deviceFiles.filter(f => !state.syncedFiles.includes(f.file)),
    newFilesCount() { return this.newFiles.length; },
    // Files eligible for auto-sync (excludes both synced and skipped)
    autoSyncableFiles: (state) => state.deviceFiles.filter(
      f => !state.syncedFiles.includes(f.file) && !state.skippedFiles.includes(f.file)
    ),
    isFileSkipped: (state) => (filename) => state.skippedFiles.includes(filename)
  },

  actions: {
    /**
     * Initialize BLE hardware and listeners (once per app lifecycle).
     * User-specific data is loaded separately via _loadUserData().
     */
    async initialize() {
      if (!isCapacitor()) return;
      if (this._initialized) return;
      this._initialized = true;

      const manager = getBleManager();
      await manager.initialize();

      // Request notification permissions early so sync notifications work in background
      try {
        const { LocalNotifications } = await import('@capacitor/local-notifications');
        const { display } = await LocalNotifications.checkPermissions();
        if (display !== 'granted') {
          await LocalNotifications.requestPermissions();
        }
      } catch { /* best-effort */ }

      // Set disconnect handler — auto-reconnect unless user explicitly disconnected
      manager.onDisconnect(() => {
        this.stopAutoSync();
        // Only move to 'disconnected' if we weren't already in 'lost' state
        // (user still needs to see 'lost' if they backgrounded the app)
        if (this.connectionState !== 'lost') {
          this.connectionState = 'disconnected';
        }
        this.deviceFiles = [];
        this.fileListLoaded = false;

        if (!this._intentionalDisconnect && this.pairedDevice) {
          // Fresh disconnect → new reconnect session with counter reset
          this._reconnectAttempts = 0;
          addBreadcrumb({ category: 'ble', message: 'Unexpected disconnect — starting reconnect loop', level: 'info' });
          this._scheduleReconnect();
        }
      });

      // Track device recording state from unsolicited BLE notifications
      manager.onRecordingStateChange((recording) => {
        this.isRecordingOnDevice = recording;
      });

      // Listen for app foreground to reconnect (AirPods-style)
      if (isCapacitor()) {
        const { App } = await import('@capacitor/app');
        this._appStateListener = await App.addListener('appStateChange', async ({ isActive }) => {
          if (isActive && this.pairedDevice && this.connectionState === 'disconnected' && !this._intentionalDisconnect) {
            // Fresh session on foreground — reset counter so user gets full 10 attempts
            this._reconnectAttempts = 0;
            addBreadcrumb({ category: 'ble', message: 'App foregrounded — attempting reconnect', level: 'info' });
            this._scheduleReconnect(1500);
          }
          // Intentionally skip auto-retry when connectionState==='lost' — user must tap "Retry"
        });
      }

      // Load user-scoped data (may be empty if no user is authenticated yet)
      await this._loadUserData();

      // Start persistent background timers — reconnect to an ALREADY-paired
      // device only. Background NEW-device discovery + its bottom auto-prompt
      // popup ("Reject / Connect") were removed: pairing a new device is done
      // explicitly from the Settings/Device page, so the unsolicited popup was
      // unwanted (and the 60s background scan it drove wasted battery/BLE).
      this._startPersistentReconnect();
    },

    /**
     * Load user-scoped persisted data (paired device, synced files, etc.)
     */
    async _loadUserData() {
      await this._loadPairedDevice();
      await this._loadSyncedFiles();
      await this._loadSkippedFiles();
      await this._loadRejectedDevices();
    },

    /**
     * Reload device state for the current user (called after login / session restore).
     * Disconnects any active BLE connection, clears in-memory state, and loads
     * the new user's persisted device preferences.
     */
    async reloadForUser() {
      // Disconnect any active connection from previous user
      if (this.connectionState !== 'disconnected') {
        this._intentionalDisconnect = true;
        this.stopAutoSync();
        this._stopReconnect();
        const manager = getBleManager();
        try { await manager.disconnect(); } catch { /* best-effort */ }
      }

      // Clear in-memory device state
      this.connectionState = 'disconnected';
      this.error = null;
      this.pairedDevice = null;
      this.deviceName = '';
      this.deviceSN = '';
      this.deviceUuid = '';
      this.batteryLevel = 0;
      this.freeStorageKB = 0;
      this.totalStorageKB = 0;
      this.isRecordingOnDevice = false;
      this.deviceFiles = [];
      this.fileListLoaded = false;
      this.syncState = 'idle';
      this.syncCurrent = 0;
      this.syncTotal = 0;
      this.syncProgress = 0;
      this.syncBytesReceived = 0;
      this.syncBytesTotal = 0;
      this.syncPhase = 'idle';
      this.currentSyncFile = null;
      this.syncError = null;
      this.syncedFiles = [];
      this.skippedFiles = [];
      this.scanResults = [];
      this.rejectedDeviceIds = [];
      this.discoveredDevice = null;

      // Load the new user's persisted data
      await this._loadUserData();

      // Auto-connect if this user has a paired device
      if (this.hasPairedDevice) {
        this._intentionalDisconnect = false;
        this._startPersistentReconnect();
        this.autoConnect().catch(() => {});
      }
    },

    /**
     * Clean up device state on logout. Disconnects BLE, stops timers,
     * clears in-memory state. Does NOT clear persisted data (it stays
     * scoped to the user who wrote it).
     */
    async onLogout() {
      this._intentionalDisconnect = true;
      this.stopAutoSync();
      this._stopReconnect();
      this._stopPersistentReconnect();
      this._stopBackgroundDiscovery();

      if (this.connectionState !== 'disconnected') {
        const manager = getBleManager();
        try { await manager.disconnect(); } catch { /* best-effort */ }
      }

      this.connectionState = 'disconnected';
      this.error = null;
      this.pairedDevice = null;
      this.deviceName = '';
      this.deviceSN = '';
      this.deviceUuid = '';
      this.batteryLevel = 0;
      this.freeStorageKB = 0;
      this.totalStorageKB = 0;
      this.isRecordingOnDevice = false;
      this.deviceFiles = [];
      this.fileListLoaded = false;
      this.syncState = 'idle';
      this.syncCurrent = 0;
      this.syncTotal = 0;
      this.syncProgress = 0;
      this.syncBytesReceived = 0;
      this.syncBytesTotal = 0;
      this.syncPhase = 'idle';
      this.currentSyncFile = null;
      this.syncError = null;
      this.syncedFiles = [];
      this.skippedFiles = [];
      this.scanResults = [];
      this.rejectedDeviceIds = [];
      this.discoveredDevice = null;
    },

    /**
     * Start scanning for devices
     */
    async startScan() {
      this.connectionState = 'scanning';
      this.scanResults = [];
      this.error = null;
      this._blePermissionsGranted = true; // User initiated scan = permissions granted

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
        let appUuid = await getOrCreateAppUuid();
        let deviceInfo;

        try {
          deviceInfo = await manager.connect(bleDeviceId, appUuid);
        } catch (e) {
          // If device rejects because it's paired to a different UUID (0x01),
          // try user-scoped UUIDs from the migration period
          if (e.message?.includes('rejected pairing')) {
            const altUuid = await this._findAlternativeAppUuid(appUuid);
            if (altUuid) {
              addBreadcrumb({ category: 'ble', message: 'Retrying handshake with alternative UUID (migration recovery)', level: 'info' });
              deviceInfo = await manager.connect(bleDeviceId, altUuid);
              // It worked — adopt this UUID as the installation UUID
              if (isCapacitor()) {
                const { Preferences } = await import('@capacitor/preferences');
                await Preferences.set({ key: PREF_APP_UUID, value: altUuid });
              }
              appUuid = altUuid;
            } else {
              // No alternative UUID found — device is paired to another phone/app.
              // Send unpair command to release the binding, then re-pair with our UUID.
              addBreadcrumb({ category: 'ble', message: 'No alternative UUID — sending unpair to release device binding', level: 'warning' });
              try {
                await manager.unpair();
              } catch { /* unpair best-effort */ }
              await manager.disconnect();
              // Short delay for device to process unpair
              await new Promise(r => setTimeout(r, 1000));
              // Reconnect and pair with our UUID
              deviceInfo = await manager.connect(bleDeviceId, appUuid);
            }
          } else {
            throw e;
          }
        }

        // Store device info
        this.deviceName = deviceInfo.name || deviceInfo.model || 'Recording Device';
        this.deviceSN = deviceInfo.SN || '';
        this.deviceUuid = manager.deviceUuid;
        this.isRecordingOnDevice = deviceInfo.isAudioRecorded === '1';
        this.connectionState = 'connected';
        this._intentionalDisconnect = false;
        this._stopReconnect();
        this._startPersistentReconnect(); // Ensure persistent timer is running for next disconnect

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
        // Use rediscovery-aware reconnect: on iOS, runs a service-UUID-filtered
        // scan first to repopulate the system discovery cache, which fixes the
        // multi-day-suspension hang where centralManager.connect() never
        // resolves until the app process is killed.
        const deviceInfo = await manager.connectWithRediscovery(this.pairedDevice.deviceId, appUuid);

        this.deviceName = deviceInfo.name || deviceInfo.model || this.pairedDevice.name;
        this.deviceSN = deviceInfo.SN || this.pairedDevice.sn;
        this.deviceUuid = manager.deviceUuid;
        this.isRecordingOnDevice = deviceInfo.isAudioRecorded === '1';
        this.connectionState = 'connected';
        this._intentionalDisconnect = false;
        this._stopReconnect();
        this._startPersistentReconnect(); // Ensure persistent timer is running for next disconnect

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
      this._intentionalDisconnect = true;
      this._stopReconnect();
      this._stopPersistentReconnect();
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
    /**
     * Factory reset: delete all files on device, unpair, and clear local state.
     * @returns {Promise<{success: boolean, deletedCount: number, errors: string[]}>}
     */
    async resetDevice() {
      if (!this.isConnected) {
        throw new Error('Device must be connected to reset');
      }

      const manager = getBleManager();

      // Format device storage — single command wipes all files (protocol §9, CMD 0x68)
      const formatted = await manager.formatDevice();
      if (!formatted) {
        throw new Error('Device format failed');
      }

      // Unpair and clear local state
      await this.forgetDevice();

      addBreadcrumb({
        category: 'ble',
        message: 'Device factory reset: format + unpair complete',
        level: 'info'
      });

      return { success: true, deletedCount: 0, errors: [] };
    },

    async forgetDevice() {
      this._intentionalDisconnect = true;
      this._stopReconnect();
      this._stopPersistentReconnect();
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
        await Preferences.remove({ key: _userPrefKey(PREF_PAIRED_DEVICE) });
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
        // Send to Sentry so the diagnostic breadcrumbs from getFileList are captured
        captureException(e, { tags: { action: 'ble_file_list' } });
        this.deviceFiles = [];
        this.fileListLoaded = true;
      }
    },

    /**
     * Download a single file and queue it for upload
     */
    async syncFile(file) {
      if (this.syncedFiles.includes(file.file)) return;

      // Remove from skipped if manually syncing a previously skipped file
      if (this.skippedFiles.includes(file.file)) {
        await this._removeSkippedFile(file.file);
      }

      const t = i18n.global.t;
      this._cancelRequested = false;
      this.syncState = 'syncing';
      this.currentSyncFile = file.file;
      this.syncCurrent = 1;
      this.syncTotal = 1;
      this.syncProgress = 0;
      this.syncBytesReceived = 0;
      this.syncBytesTotal = 0;
      this.syncPhase = 'idle';
      this.syncError = null;
      this.syncErrorPhase = null;

      sendLocalNotification(NOTIF_SYNC_PROGRESS, t('bleTransferBanner'), t('syncProgress', { current: 1, total: 1 }));

      try {
        await this._downloadAndUpload(file);
        this.syncState = 'complete';
        sendLocalNotification(NOTIF_SYNC_COMPLETE, t('syncComplete'), t('bleSyncCompleteBody', { count: 1 }));
      } catch (e) {
        if (e.message === 'cancelled') {
          this.syncState = 'idle';
          this.syncErrorPhase = null;
          return; // Cancellation is intentional, don't throw
        }
        this.syncState = 'error';
        this.syncError = e.message;
        // Capture phase BEFORE finally resets it — UI uses this to render
        // actionable messages like "Download failed" vs "Upload failed".
        this.syncErrorPhase = this.syncPhase;
        throw e;
      } finally {
        this.currentSyncFile = null;
        this.syncPhase = 'idle';
      }
    },

    /**
     * Sync all new (un-synced) files
     */
    async syncAllNew() {
      const newFiles = this.autoSyncableFiles;
      if (newFiles.length === 0) return;
      const t = i18n.global.t;

      this._cancelRequested = false;
      this.syncState = 'syncing';
      this.syncTotal = newFiles.length;
      this.syncCurrent = 0;
      this.syncBytesReceived = 0;
      this.syncBytesTotal = 0;
      this.syncPhase = 'detecting';
      this.syncError = null;
      this.syncErrorPhase = null;

      sendLocalNotification(NOTIF_SYNC_PROGRESS, t('bleTransferBanner'), t('bleTransferDetecting', { count: newFiles.length }));

      // Collect per-file failures across the batch so we can report an
      // accurate result at the end instead of silently completing.
      const failures = [];

      try {
        for (const file of newFiles) {
          if (this._cancelRequested) break;
          this.syncCurrent++;
          this.currentSyncFile = file.file;
          this.syncProgress = 0;
          try {
            await this._downloadAndUpload(file);
          } catch (perFileErr) {
            // Per-file cancel (single-file UI cancel without a full-batch
            // cancel): drop this file and continue to the next.
            if (perFileErr.message === 'cancelled' && !this._cancelRequested) {
              addBreadcrumb({ category: 'ble', message: `Skipped ${file.file} (per-file cancel) — continuing batch`, level: 'info' });
              continue;
            }
            // Full-batch user cancel: stop processing further files but let
            // the outer cancel handler set the final state.
            if (this._cancelRequested) {
              throw perFileErr;
            }
            // Real failure: record it, continue with the next file.
            failures.push({ file: file.file, error: perFileErr.message });
            addBreadcrumb({ category: 'ble', message: `Sync failed for ${file.file}: ${perFileErr.message} — continuing batch`, level: 'warning' });
          }
        }
        if (this._cancelRequested) {
          this.syncState = 'idle';
        } else if (failures.length > 0) {
          this.syncState = 'error';
          this.syncError = `${failures.length}/${newFiles.length} failed`;
          this.syncErrorPhase = this.syncPhase;
          const aggregateErr = new Error(this.syncError);
          aggregateErr.failureCount = failures.length;
          aggregateErr.totalCount = newFiles.length;
          aggregateErr.failures = failures;
          throw aggregateErr;
        } else {
          this.syncState = 'complete';
          sendLocalNotification(NOTIF_SYNC_COMPLETE, t('syncComplete'), t('bleSyncCompleteBody', { count: newFiles.length }));
        }
      } catch (e) {
        if (e.message === 'cancelled') {
          this.syncState = 'idle';
          this.syncErrorPhase = null;
          return;
        }
        // Aggregate (failureCount set) or single hard error — both surface
        // to the UI so the toast can be honest about what happened.
        if (this.syncState !== 'error') {
          this.syncState = 'error';
          this.syncError = e.message;
          this.syncErrorPhase = this.syncPhase;
        }
        throw e;
      } finally {
        this.currentSyncFile = null;
        this.syncPhase = 'idle';
      }
    },

    /**
     * Download file from device and upload to backend
     */
    async _downloadAndUpload(file) {
      const manager = getBleManager();
      const historyStore = useRecordingsHistoryStore();
      const authStore = useAuthStore();

      // Extract metadata early for history entry
      const title = this._formatTitleFromFilename(file.file);
      const createdAt = this._parseDateFromFilename(file.file) || new Date(file.creat_time * 1000).toISOString();
      const durationSec = Math.round((file.duration_ms || 0) / 1000);
      const recordId = uuidv4();

      // Add to history immediately so it's visible in the History tab during transfer
      await historyStore.addRecording({
        id: recordId,
        title,
        duration: durationSec,
        filePath: null, // No local file yet
        fileSize: file.size || 0,
        createdAt,
        uploadStatus: 'transferring',
        source: 'device',
        deviceFilename: file.file
      });

      // Captures a soft upload failure (uploadWithVerification returned
      // success=false) so we can throw AFTER the try/catch — throwing from
      // inside the try falls into the catch block and clobbers the 'failed'
      // status with 'pending'. Until this is propagated, syncAllNew used to
      // claim "Sync complete" while recordings stayed visibly broken.
      let softUploadError = null;

      try {
        // Phase 1: BLE download
        if (this._cancelRequested) throw new Error('cancelled');

        this.syncPhase = 'downloading';
        this.syncBytesTotal = file.size || 0;
        this.syncBytesReceived = 0;
        addBreadcrumb({ category: 'ble', message: `Downloading ${file.file} (${file.size} bytes)`, level: 'info' });
        const fileData = await manager.downloadFile(
          file.file,
          (data) => {
            this.syncProgress = data.percent;
            this.syncBytesReceived = data.bytesReceived;
          },
          file.size
        );
        const header = Array.from(fileData.slice(0, 8)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
        const headerAscii = String.fromCharCode(...fileData.slice(0, 4));
        addBreadcrumb({ category: 'ble', message: `Downloaded ${file.file}: ${fileData.byteLength} bytes, header=[${header}] ascii="${headerAscii}"`, level: 'info' });

        // Phase 2: Save to filesystem
        if (this._cancelRequested) throw new Error('cancelled');

        this.syncPhase = 'saving';
        let saveData = fileData;
        if (isRawOpusPackets(fileData)) {
          saveData = rawOpusToOgg(fileData);
          addBreadcrumb({ category: 'ble', message: `Converted raw Opus to Ogg: ${fileData.byteLength} → ${saveData.byteLength} bytes`, level: 'info' });
        }

        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        let binary = '';
        const len = saveData.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(saveData[i]);
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

        const filePath = `${dirPath}/${file.file}`;
        await historyStore.updateRecording(recordId, { filePath, uploadStatus: 'pending' });

        // Phase 3: Upload to server
        if (this._cancelRequested) throw new Error('cancelled');

        this.syncPhase = 'uploading';
        await historyStore.updateRecording(recordId, { uploadStatus: 'uploading' });

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
            uploadStatus: result.verified === false ? 'pending_verification' : 'uploaded',
            transcriptionId: result.transcriptionId,
            audioFileId: result.audioFileId
          });
          addBreadcrumb({
            category: 'ble',
            message: `Device file uploaded: ${file.file}${result.verified === false ? ' (verification pending)' : ''}`,
            level: 'info'
          });
          // Mark synced only on true success — the BLE file no longer needs
          // re-downloading. On upload failure (soft or hard), DON'T mark synced
          // so the next syncAllNew picks it up and the user isn't forced
          // through per-card retry. The local filePath is preserved so the
          // user's per-card retry button still works without a re-download.
          await this._addSyncedFile(file.file);
        } else {
          await historyStore.updateRecording(recordId, {
            uploadStatus: 'failed',
            uploadError: result.error || 'Upload failed'
          });
          captureException(new Error(`Device file upload failed: ${result.error}`), {
            tags: { action: 'ble_upload' },
            extra: { filename: file.file, recordId, error: result.error }
          });
          softUploadError = result.error || 'Upload failed';
        }

      } catch (err) {
        const isCancelled = this._cancelRequested ||
          err.message === 'BLE download cancelled' ||
          err.message === 'cancelled';

        if (isCancelled) {
          // User-chosen semantics: "Delete partial on phone, keep file on device,
          // mark skipped locally." Re-sync is always a full re-download (the
          // protocol has no byte-offset resume — CMD_FILE_DOWNLOAD takes filename only).
          const rec = historyStore.getRecordingById(recordId);

          // 1) Delete any partial file that was saved to phone filesystem
          if (rec?.filePath) {
            try {
              const { Filesystem, Directory } = await import('@capacitor/filesystem');
              await Filesystem.deleteFile({ path: rec.filePath, directory: Directory.Documents });
              addBreadcrumb({ category: 'ble', message: `Deleted partial file: ${rec.filePath}`, level: 'info' });
            } catch (delErr) {
              // Best-effort — file may not exist or may fail to delete.
              // Not fatal: the file will be overwritten on next sync.
              addBreadcrumb({ category: 'ble', message: `Partial file delete failed (best-effort): ${delErr.message}`, level: 'warning' });
            }
          }

          // 2) Remove the history record entirely — nothing to show the user
          //    since we never completed upload and deleted the local file
          try {
            await historyStore.deleteRecording(recordId, true);
          } catch (histErr) {
            addBreadcrumb({ category: 'ble', message: `History delete failed (best-effort): ${histErr.message}`, level: 'warning' });
          }

          // 3) Mark skipped so auto-sync ignores it (user can re-sync via "Sync again")
          //    Deliberately NOT added to syncedFiles — user should be able to re-download
          await this._addSkippedFile(file.file);

          throw new Error('cancelled');
        }

        // Non-cancel hard error (BLE download, filesystem write, or upload
        // threw). Mark pending so the per-card retry button can drive a fresh
        // attempt, and propagate so the caller knows not to report success.
        // Deliberately NOT calling _addSyncedFile — the BLE file is either
        // not on phone at all (download failed) or is partially written
        // (save failed) or is on phone but unuploaded (upload threw). In
        // every case we want the next syncAllNew to attempt this file again
        // rather than skipping it because the syncedFiles set thinks we're
        // done with it.
        await historyStore.updateRecording(recordId, { uploadStatus: 'pending' });
        captureException(err, {
          tags: { action: 'ble_upload' },
          extra: { filename: file.file, recordId }
        });
        throw err;
      }

      // Soft upload failure (uploadWithVerification returned success=false).
      // History is already marked 'failed'. Propagate so syncAllNew counts it
      // and the UI doesn't show "Sync complete" over a broken result.
      if (softUploadError) {
        throw new Error(softUploadError);
      }
    },

    /**
     * Retry cloud upload for a device file that was downloaded but failed to upload.
     * Finds the recording by deviceFilename and re-uploads from the saved local file.
     */
    async retryUpload(filename) {
      const historyStore = useRecordingsHistoryStore();
      const authStore = useAuthStore();
      const rec = historyStore.getRecordingByDeviceFilename(filename);
      if (!rec || !rec.filePath) return;

      await historyStore.updateRecording(rec.id, { uploadStatus: 'uploading' });

      try {
        const result = await uploadWithVerification({
          filePath: rec.filePath,
          recordId: rec.id,
          apiUrl: getApiUrlSync(),
          authToken: authStore.token,
          metadata: {
            duration: (rec.duration || 0).toString(),
            title: rec.title || '',
            filename
          },
          onProgress: () => {},
          getAuthStore: () => authStore
        });

        if (result.success) {
          await historyStore.updateRecording(rec.id, {
            uploadStatus: 'uploaded',
            transcriptionId: result.transcriptionId,
            audioFileId: result.audioFileId
          });
        } else {
          await historyStore.updateRecording(rec.id, {
            uploadStatus: 'failed',
            uploadError: result.error || 'Upload failed'
          });
          // Propagate so the UI shows the retry actually failed rather than
          // a misleading "Sync complete" toast.
          throw new Error(result.error || 'Upload failed');
        }
      } catch (err) {
        await historyStore.updateRecording(rec.id, {
          uploadStatus: 'failed',
          uploadError: err.message
        });
        throw err;
      }
    },

    /**
     * Cancel a pending/failed upload and mark the file as skipped.
     */
    async cancelUpload(filename) {
      const historyStore = useRecordingsHistoryStore();
      const rec = historyStore.getRecordingByDeviceFilename(filename);
      if (rec) {
        await historyStore.updateRecording(rec.id, { uploadStatus: 'skipped' });
      }
      await this._addSkippedFile(filename);
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
        const level = await manager.getBattery();
        if (level >= 0) this.batteryLevel = level;
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

    /**
     * Cancel the ENTIRE in-progress sync batch. Sets the global cancel flag
     * so `syncAllNew` breaks out of its loop; any remaining queued files are
     * skipped. Called by the "Cancel All" button.
     */
    async cancelSync() {
      if (!this.isSyncing) return;
      this._cancelRequested = true;
      const manager = getBleManager();
      manager.abortDownload();
    },

    /**
     * Cancel ONLY the currently-downloading file, letting `syncAllNew`
     * advance to the next queued file. Does NOT set `_cancelRequested`
     * (which would abort the whole batch). The current file enters the
     * cancel cleanup path (partial file deleted, history record removed,
     * file marked skipped) via `_downloadAndUpload`'s catch handler.
     */
    async cancelCurrentFile() {
      if (!this.isSyncing) return;
      const manager = getBleManager();
      manager.abortDownload();
    },

    // ========== Auto-Sync ==========

    /**
     * Start polling for new files while connected.
     * Polls every 30s: sends a lightweight keepalive (battery request) to
     * prevent the device from disconnecting due to BLE inactivity, and
     * syncs new files when the device is not recording.
     */
    startAutoSync() {
      this.stopAutoSync();
      // Initial delay: let the connection stabilize before polling
      this._autoSyncTimer = setTimeout(() => {
        this._autoSyncPoll();
        this._autoSyncTimer = setInterval(() => {
          this._autoSyncPoll();
        }, 20000);
      }, 5000);
    },

    async _autoSyncPoll() {
      if (!this.isConnected || this.isSyncing) return;

      try {
        // Always send a battery request as BLE keepalive — prevents the
        // device from disconnecting due to inactivity (even during recording)
        const manager = getBleManager();
        try {
          const level = await manager.getBattery();
          if (level >= 0) this.batteryLevel = level; // Ignore invalid readings (-1)
        } catch (e) {
          console.warn('BLE keepalive (battery) failed:', e.message);
        }

        // Don't fetch file list or sync while device is recording —
        // entering sync state disables device buttons
        if (this.isRecordingOnDevice) return;

        await this.fetchFileList();

        // Re-check: recording may have started during file list fetch
        if (this.isRecordingOnDevice) return;

        const newFiles = this.autoSyncableFiles;
        if (newFiles.length > 0) {
          addBreadcrumb({
            category: 'ble',
            message: `Auto-sync: ${newFiles.length} new file(s) detected`,
            level: 'info'
          });
          await this.syncAllNew();
        }
      } catch (e) {
        // Connection may have dropped — stop polling to avoid noise.
        // Capture so we can see WHY auto-sync stopped instead of going dark.
        console.log('Auto-sync poll error:', e.message);
        captureException(e, {
          tags: { action: 'auto_sync_poll' },
          extra: { failureCount: e.failureCount, totalCount: e.totalCount }
        });
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

    // ========== Auto-Reconnect (AirPods-style) ==========

    /**
     * Schedule reconnect attempts with exponential backoff.
     * Tries to reconnect to paired device after unexpected disconnect
     * or when app returns to foreground.
     *
     * Gives up after MAX_RECONNECT_ATTEMPTS attempts (~5 min with backoff),
     * setting connectionState='lost' so the UI can surface a manual retry
     * prompt. The persistent-reconnect timer still runs as a long-term
     * safety net for the 'disconnected' state but deliberately does NOT
     * fire when state==='lost' — that requires explicit user action.
     */
    _scheduleReconnect(initialDelay = 2000) {
      this._stopReconnect();

      const attempt = async () => {
        // Guard: stop if conditions changed
        if (this._intentionalDisconnect || !this.pairedDevice ||
            this.connectionState === 'connected' || this.connectionState === 'connecting' ||
            this.connectionState === 'lost') {
          return;
        }
        // Cross-timer mutex — see _reconnectInProgress comment in state.
        // If the persistent-reconnect timer is mid-attempt, skip this round
        // and let the next scheduled backoff try (we don't burn the
        // _reconnectAttempts counter for a skipped tick).
        if (this._reconnectInProgress) {
          addBreadcrumb({ category: 'ble', message: 'Skipped scheduled reconnect — another path is in progress', level: 'info' });
          // Re-arm at the next backoff slot so we don't dead-end.
          const delay = Math.min(5000 * Math.pow(1.5, Math.max(this._reconnectAttempts - 1, 0)), 30000);
          this._reconnectTimer = setTimeout(attempt, delay);
          return;
        }
        this._reconnectInProgress = true;

        this._reconnectAttempts++;
        addBreadcrumb({
          category: 'ble',
          message: `Reconnect attempt ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
          level: 'info'
        });

        try {
          await this.autoConnect();
          // Success — reset counter for any future disconnect session
          this._reconnectAttempts = 0;
          addBreadcrumb({ category: 'ble', message: 'Auto-reconnect succeeded', level: 'info' });
        } catch {
          if (this._intentionalDisconnect) return;

          if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            // Give up auto-retry; surface "lost" state so the UI can show a
            // user-actionable retry prompt. Persistent-reconnect timer also
            // skips this state (see _startPersistentReconnect guards).
            this.connectionState = 'lost';
            addBreadcrumb({
              category: 'ble',
              message: `Reconnect gave up after ${this._reconnectAttempts} attempts — connectionState=lost`,
              level: 'warning'
            });
            return;
          }

          // Backoff: 5s, 7.5s, 11s, 17s, 25s, 30s (capped)
          const delay = Math.min(5000 * Math.pow(1.5, this._reconnectAttempts - 1), 30000);
          this._reconnectTimer = setTimeout(attempt, delay);
        } finally {
          this._reconnectInProgress = false;
        }
      };

      this._reconnectTimer = setTimeout(attempt, initialDelay);
    },

    /**
     * User-triggered manual retry after auto-reconnect exhausted its budget.
     * Resets the attempt counter and tries once synchronously. If it fails,
     * a fresh background auto-reconnect session is scheduled (giving the user
     * another MAX_RECONNECT_ATTEMPTS worth of retries) and the error is
     * re-thrown so the UI can show an actionable toast.
     * Called from UI when connectionState === 'lost'.
     */
    async retryConnect() {
      if (!this.pairedDevice) return;
      this._reconnectAttempts = 0;
      this.error = null;
      // Transition out of 'lost' so _scheduleReconnect's guard lets attempts through
      if (this.connectionState === 'lost') {
        this.connectionState = 'disconnected';
      }
      this._intentionalDisconnect = false;
      // Honor the cross-timer reconnect mutex — if a background path is
      // already running, the user's manual tap shouldn't race a duplicate
      // BLE connect onto the wire. Wait briefly then proceed.
      if (this._reconnectInProgress) {
        addBreadcrumb({ category: 'ble', message: 'retryConnect: another reconnect in progress, waiting…', level: 'info' });
        // Brief wait — at most one BLE connect round-trip (~12s rediscovery + connect timeout).
        // After 13s, if still locked, proceed anyway (caller's UI feedback matters).
        for (let i = 0; i < 13 && this._reconnectInProgress; i++) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      this._reconnectInProgress = true;
      try {
        return await this.autoConnect();
      } catch (e) {
        // Kick off a background session so the user doesn't have to tap again
        // immediately, but propagate the error so UI can notify the user.
        this._scheduleReconnect(1500);
        throw e;
      } finally {
        this._reconnectInProgress = false;
      }
    },

    /**
     * Stop any pending reconnect attempts
     */
    _stopReconnect() {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
    },

    // ========== Persistent Reconnect ==========

    /**
     * Persistent reconnect timer — runs every 30s as a safety net.
     * Unlike _scheduleReconnect (fast backoff after disconnect), this
     * ensures we always keep trying even if the fast reconnect gave up.
     */
    _startPersistentReconnect() {
      this._stopPersistentReconnect();
      this._persistentReconnectTimer = setInterval(async () => {
        if (!this.pairedDevice || this._intentionalDisconnect) return;
        if (this.connectionState !== 'disconnected') return;
        if (document.hidden) return; // Only when app is in foreground
        // Cross-timer mutex — if scheduled-reconnect is mid-attempt OR a
        // retryConnect is in flight, skip this safety-net tick. The next
        // interval (15s later) will retry.
        if (this._reconnectInProgress) return;
        this._reconnectInProgress = true;

        try {
          addBreadcrumb({ category: 'ble', message: 'Persistent reconnect attempt', level: 'info' });
          await this.autoConnect();
          addBreadcrumb({ category: 'ble', message: 'Persistent reconnect succeeded', level: 'info' });
        } catch {
          // Will try again on next interval
        } finally {
          this._reconnectInProgress = false;
        }
      }, RECONNECT_INTERVAL_MS);
    },

    _stopPersistentReconnect() {
      if (this._persistentReconnectTimer) {
        clearInterval(this._persistentReconnectTimer);
        this._persistentReconnectTimer = null;
      }
    },

    // ========== Background Discovery ==========

    /**
     * Background discovery — scans for new T240 devices every 60s
     * when no device is currently paired. Shows a global popup if found.
     */
    _startBackgroundDiscovery() {
      this._stopBackgroundDiscovery();
      this._discoveryTimer = setInterval(() => {
        this._discoveryPoll();
      }, DISCOVERY_INTERVAL_MS);
    },

    _stopBackgroundDiscovery() {
      if (this._discoveryTimer) {
        clearInterval(this._discoveryTimer);
        this._discoveryTimer = null;
      }
    },

    async _discoveryPoll() {
      // Only discover when no device is paired
      if (this.pairedDevice) return;
      // Only in foreground
      if (document.hidden) return;
      // Don't scan if already scanning or connecting
      if (this.connectionState !== 'disconnected') return;
      // Don't scan if there's already a discovered device pending user action
      if (this.discoveredDevice) return;
      // Don't scan if BLE permissions haven't been granted yet
      if (!this._blePermissionsGranted) return;

      // Lock connectionState to prevent concurrent BLE operations (e.g. reconnect timer)
      this.connectionState = 'scanning';

      try {
        const manager = getBleManager();
        const found = [];

        await manager.scan(DISCOVERY_SCAN_DURATION, (device) => {
          // Only consider devices we haven't rejected
          if (!this.rejectedDeviceIds.includes(device.deviceId)) {
            found.push(device);
          }
        });

        if (found.length > 0) {
          // Show the first discovered device (strongest signal or first found)
          const device = found[0];
          this.discoveredDevice = {
            deviceId: device.deviceId,
            name: device.name || 'Recording Device',
            rssi: device.rssi || null
          };
          addBreadcrumb({
            category: 'ble',
            message: `Background discovery found device: ${device.name || device.deviceId}`,
            level: 'info'
          });
        }
      } catch {
        // Scan failed — silently ignore, will retry next interval
      } finally {
        if (this.connectionState === 'scanning') {
          this.connectionState = 'disconnected';
        }
      }
    },

    /**
     * Mark that BLE permissions have been granted (called after first manual scan
     * or when DevicePage mounts). This prevents background discovery from
     * triggering the system permission prompt unexpectedly.
     */
    markBlePermissionsGranted() {
      this._blePermissionsGranted = true;
    },

    /**
     * Accept a discovered device — connect and pair
     */
    async acceptDiscoveredDevice() {
      if (!this.discoveredDevice) return;
      const deviceId = this.discoveredDevice.deviceId;
      this.discoveredDevice = null;

      try {
        await this.connectAndPair(deviceId);
      } catch (e) {
        this.error = e.message;
        captureException(e, { tags: { action: 'ble_accept_discovered' } });
      }
    },

    /**
     * Reject a discovered device — won't show popup for this device again
     */
    async rejectDiscoveredDevice() {
      if (!this.discoveredDevice) return;
      const deviceId = this.discoveredDevice.deviceId;
      this.discoveredDevice = null;

      if (!this.rejectedDeviceIds.includes(deviceId)) {
        this.rejectedDeviceIds.push(deviceId);
        await this._saveRejectedDevices();
      }
    },

    /**
     * Dismiss popup without rejecting (will show again on next discovery)
     */
    dismissDiscoveredDevice() {
      this.discoveredDevice = null;
    },

    // ========== Persistence ==========

    /**
     * Find an alternative appUuid that a device might be paired to.
     * Checks user-scoped UUIDs from the migration period.
     */
    async _findAlternativeAppUuid(currentUuid) {
      if (!isCapacitor()) return null;
      const auth = useAuthStore();
      const userId = auth.user?.id;
      if (!userId) return null;

      const { Preferences } = await import('@capacitor/preferences');
      const scopedKey = `${PREF_APP_UUID}:u${userId}`;
      const { value } = await Preferences.get({ key: scopedKey });
      if (value && value !== currentUuid) return value;
      return null;
    },

    async _savePairedDevice() {
      if (isCapacitor()) {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.set({
          key: _userPrefKey(PREF_PAIRED_DEVICE),
          value: JSON.stringify(this.pairedDevice)
        });
      }
    },

    async _loadPairedDevice() {
      if (isCapacitor()) {
        const { Preferences } = await import('@capacitor/preferences');
        const { value } = await Preferences.get({ key: _userPrefKey(PREF_PAIRED_DEVICE) });
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
        const { value } = await Preferences.get({ key: _userPrefKey(PREF_SYNCED_FILES) });
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
            key: _userPrefKey(PREF_SYNCED_FILES),
            value: JSON.stringify(this.syncedFiles)
          });
        }
      }
    },

    async _loadSkippedFiles() {
      if (isCapacitor()) {
        const { Preferences } = await import('@capacitor/preferences');
        const { value } = await Preferences.get({ key: _userPrefKey(PREF_SKIPPED_FILES) });
        if (value) {
          try {
            this.skippedFiles = JSON.parse(value);
          } catch {
            this.skippedFiles = [];
          }
        }
      }
    },

    async _addSkippedFile(filename) {
      if (!this.skippedFiles.includes(filename)) {
        this.skippedFiles.push(filename);
        if (isCapacitor()) {
          const { Preferences } = await import('@capacitor/preferences');
          await Preferences.set({
            key: _userPrefKey(PREF_SKIPPED_FILES),
            value: JSON.stringify(this.skippedFiles)
          });
        }
      }
    },

    async _removeSkippedFile(filename) {
      this.skippedFiles = this.skippedFiles.filter(f => f !== filename);
      if (isCapacitor()) {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.set({
          key: _userPrefKey(PREF_SKIPPED_FILES),
          value: JSON.stringify(this.skippedFiles)
        });
      }
    },

    async _loadRejectedDevices() {
      if (isCapacitor()) {
        const { Preferences } = await import('@capacitor/preferences');
        const { value } = await Preferences.get({ key: _userPrefKey(PREF_REJECTED_DEVICES) });
        if (value) {
          try {
            this.rejectedDeviceIds = JSON.parse(value);
          } catch {
            this.rejectedDeviceIds = [];
          }
        }
      }
    },

    async _saveRejectedDevices() {
      if (isCapacitor()) {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.set({
          key: _userPrefKey(PREF_REJECTED_DEVICES),
          value: JSON.stringify(this.rejectedDeviceIds)
        });
      }
    }
  }
});
