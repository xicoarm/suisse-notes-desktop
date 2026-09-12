/**
 * Pinia store for BLE recording device state management
 * Handles pairing, connection, file sync, and upload of device recordings
 */

import { defineStore } from 'pinia';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

// Namespace for deterministic (v5) ids of device files: the SAME user syncing
// the SAME file from the SAME recorder always gets the same recordId, so the
// server's dedupe (botSessionId = "desktop:<recordId>") holds across an app
// reinstall, a purged localStorage or a second phone — no duplicate meetings.
const DEVICE_FILE_ID_NAMESPACE = '5f8b7e3a-2c7d-4c5e-9a0f-3d2e1b4c6a71';

export function deviceFileRecordId(userId, deviceKey, filename) {
  const name = `${userId || 'anon'}|${deviceKey || 'device'}|${filename}`;
  return uuidv5(name, DEVICE_FILE_ID_NAMESPACE);
}

// Bluetooth pairing identity of this app for this USER. Deterministic per
// user so a reinstall (or a second phone of the same user) presents the same
// UUID to a recorder that is already bound — the device firmware binds
// exactly one app UUID and only that app can ever unpair it.
const APP_UUID_NAMESPACE = '0c1f7a2e-9b6d-4e3a-8c5f-2d7e4b1a9c63';
export function userAppUuid(userId) {
  if (!userId) return null;
  return uuidv5(`suisse-meets-ble-app|${userId}`, APP_UUID_NAMESPACE);
}
import { isCapacitor } from '../utils/platform';
import { getBleManager } from '../services/bleService';
import { addBreadcrumb, captureException, captureMessage } from '../boot/sentry';
import { uploadWithVerification } from '../services/upload';
import * as storage from '../services/storage';
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
const RECONNECT_INTERVAL_MS = 15_000;  // First persistent-reconnect delay
const RECONNECT_INTERVAL_MAX_MS = 5 * 60_000; // Cap after repeated failures (device off / left at home)
const DISCOVERY_INTERVAL_MS = 15_000;  // Scan for new devices every 15s
const DISCOVERY_SCAN_DURATION = 5000;  // Quick 5s scan for discovery
const MAX_RECONNECT_ATTEMPTS = 10;     // After this, connectionState='lost' — manual retry required
const MAX_CRC_FAILURES = 3;            // Corrupted transfers of one file before it is skipped
// The file list runs inside the recorder's "sync state", which disables its
// physical buttons for the duration (protocol §三.2.1). Fetch it on every
// LIST_EVERY_N_TICKS keepalive tick (20 s each) instead of on every tick, and
// immediately after the recorder reports that a recording stopped.
const LIST_EVERY_N_TICKS = 3;

/**
 * Errors that mean "the Bluetooth link is not there right now" — a device that
 * is switched off, out of range, busy or mid-reboot. They are the normal
 * outcome of automatic reconnect/poll loops and must not be reported as app
 * errors (they were the top error-level issues in Sentry for months).
 */
export function isBleTransportError(err) {
  const msg = ((err && err.code) ? err.code + ' ' : '') + ((err && err.message) || String(err || ''));
  return /connection timeout|connection failed|disconnected during transfer|not connected|deviceId required|response timeout|device not found|BLE download cancelled|rejected pairing|connect(ing)? (failed|error)|writing descriptor|DEVICE_MEMORYBUSY|MemoryBusy|LIST_INCOMPLETE/i.test(msg);
}

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

    // Fresh install: prefer the user-derived UUID so a recorder this user
    // paired on a previous install (or another phone) accepts us again.
    const newUuid = userAppUuid(userId) || uuidv4();
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

/**
 * Transfer order of a sync run: OLDEST recording first.
 *
 * The device page lists newest first, but the queue works the backlog in the
 * order the meetings happened (first in, first out — the dictation-workflow
 * convention): history entries and transcripts arrive chronologically, a
 * steady stream of new recordings can never starve an older one, and an
 * interrupted run always leaves the NEWEST recordings as the pending tail.
 * Key: start time from the file name (R20260904-145146), else the recorder's
 * creat_time; ties and unknown dates fall back to the file name.
 */
export function oldestFirst(files) {
  const startOf = (f) => {
    const m = /R(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(f?.file || '');
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return Number.isFinite(f?.creat_time) && f.creat_time > 0 ? f.creat_time * 1000 : Number.POSITIVE_INFINITY;
  };
  return [...(files || [])]
    .map((f) => ({ f, t: startOf(f) }))
    .sort((a, b) => (a.t === b.t ? String(a.f.file).localeCompare(String(b.f.file)) : (a.t < b.t ? -1 : 1)))
    .map(({ f }) => f);
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
    // Consecutive corrupted transfers per device file (session-scoped); after
    // MAX_CRC_FAILURES the file is skipped instead of retried forever.
    _crcFailures: {},

    // Scan results
    scanResults: [],

    // Auto-sync polling
    _autoSyncTimer: null,
    _pollInProgress: false,       // a slow tick (long list / sync) must not overlap the next one
    _pollTick: 0,
    _listRefreshRequested: false, // set by the recorder's "recording stopped" report

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
    _persistentFailures: 0, // consecutive failed persistent attempts → backoff
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

      // Load user-scoped data FIRST. Bluetooth is only initialized (= the OS
      // permission prompt appears) when this user actually owns a paired
      // recording device. Until 3.9.36 every fresh install was asked for
      // Bluetooth AND notification permission on the login screen, before the
      // user had done anything — 134 iOS users tapped "Don't allow" (Sentry
      // CAPACITOR-HS) and had to dig through Settings later to pair. Scans,
      // pairing and connects initialize BLE lazily and in context.
      // Notification permission is requested by sendLocalNotification the
      // first time a sync actually needs it.
      await this._loadUserData();
      if (this.hasPairedDevice) {
        try {
          await manager.initialize();
        } catch (e) {
          console.warn('BLE init deferred (permission not granted yet):', e?.message);
        }
      }

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

      // Track device recording state from unsolicited BLE notifications.
      // A stop report (0x17) means a new file exists on the card: refresh the
      // list on the next keepalive tick instead of waiting for the periodic
      // refresh. A start error (RecordStartErr) is not a recording.
      manager.onRecordingStateChange((recording, startErr) => {
        this.isRecordingOnDevice = recording;
        if (!recording && !startErr) this._listRefreshRequested = true;
      });

      // Listen for app foreground to reconnect (AirPods-style)
      if (isCapacitor()) {
        const { App } = await import('@capacitor/app');
        this._appStateListener = await App.addListener('appStateChange', async ({ isActive }) => {
          if (isActive && this.pairedDevice && this.connectionState === 'disconnected' && !this._intentionalDisconnect) {
            // Fresh session on foreground — reset counters so user gets full 10 attempts
            this._reconnectAttempts = 0;
            this._persistentFailures = 0;
            addBreadcrumb({ category: 'ble', message: 'App foregrounded — attempting reconnect', level: 'info' });
            this._scheduleReconnect(1500);
          }
          // Intentionally skip auto-retry when connectionState==='lost' — user must tap "Retry"
        });
      }

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
          // The recorder binds exactly ONE app UUID (protocol §1, status 0x01).
          // If it rejects ours, try every UUID this user may have paired with
          // before: the legacy user-scoped one from the migration period and
          // the user-derived one (same user, previous install / other phone).
          if (e.message?.includes('rejected pairing')) {
            const auth = useAuthStore();
            const candidates = [];
            const legacy = await this._findAlternativeAppUuid(appUuid);
            if (legacy) candidates.push({ uuid: legacy, why: 'legacy user-scoped UUID' });
            const derived = userAppUuid(auth.user?.id);
            if (derived && derived !== appUuid && derived !== legacy) candidates.push({ uuid: derived, why: 'user-derived UUID' });

            let paired = false;
            for (const candidate of candidates) {
              addBreadcrumb({ category: 'ble', message: `Retrying handshake with ${candidate.why}`, level: 'info' });
              try {
                await new Promise(r => setTimeout(r, 800)); // the device drops the link after a rejection
                deviceInfo = await manager.connect(bleDeviceId, candidate.uuid);
                if (isCapacitor()) {
                  const { Preferences } = await import('@capacitor/preferences');
                  await Preferences.set({ key: PREF_APP_UUID, value: candidate.uuid });
                }
                appUuid = candidate.uuid;
                paired = true;
                break;
              } catch (retryErr) {
                if (!retryErr.message?.includes('rejected pairing')) throw retryErr;
              }
            }
            if (!paired) {
              // Bound to an app installation we cannot reproduce. Only that
              // installation can release the binding (protocol §6 requires a
              // completed handshake) — say so instead of a raw protocol string.
              const bound = new Error('Device rejected pairing (already paired to another app)');
              bound.code = 'BLE_PAIRED_ELSEWHERE';
              throw bound;
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
        // resolves until the app process is killed. Automatic attempts are
        // `silent`: an unreachable device is their expected outcome.
        const deviceInfo = await manager.connectWithRediscovery(this.pairedDevice.deviceId, appUuid, { silent: true });

        this.deviceName = deviceInfo.name || deviceInfo.model || this.pairedDevice.name;
        this.deviceSN = deviceInfo.SN || this.pairedDevice.sn;
        this.deviceUuid = manager.deviceUuid;
        this.isRecordingOnDevice = deviceInfo.isAudioRecorded === '1';
        this.connectionState = 'connected';
        this._intentionalDisconnect = false;
        this._persistentFailures = 0;
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
        if (/rejected pairing/i.test(e.message || '')) {
          // The recorder is bound to another app installation (handshake
          // status 0x01). Reconnecting every few minutes can never succeed —
          // stop the background loops; the device page shows the actionable
          // message and its Retry button re-arms the loops.
          this.connectionState = 'lost';
          this._stopReconnect();
          this._stopPersistentReconnect();
          addBreadcrumb({ category: 'ble', message: 'Reconnect stopped: recorder is paired to another app installation', level: 'warning' });
        }
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
        if (e.code === 'LIST_INCOMPLETE') {
          // The recorder's list arrived truncated (stale frames of an earlier
          // request in the stream). MERGE what came through into the known
          // list — replacing it would make the missing recordings disappear
          // from the device page and from auto-sync. The next poll retries.
          const byName = new Map(this.deviceFiles.map(f => [f.file, f]));
          for (const f of e.files || []) byName.set(f.file, f);
          this.deviceFiles = [...byName.values()].sort((a, b) => b.creat_time - a.creat_time);
          this.fileListLoaded = true;
          captureMessage(`BLE file list incomplete: ${e.message} — kept ${this.deviceFiles.length} known file(s)`, 'warning');
          throw e;
        }
        if (isBleTransportError(e)) {
          // Link dropped / device busy (card still being scanned) — keep the
          // last known list on screen; the reconnect loop / next poll retries.
          addBreadcrumb({ category: 'ble', message: `getFileList failed (transport): ${e.message}`, level: 'warning' });
          this.fileListLoaded = true;
          throw e;
        }
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

      // Single-file sync is its own prep "run" - bracket it like syncAllNew so
      // an "apply to all" answer can never leak beyond it.
      let prepStoreForFile = null;
      try {
        const { useMeetingPrepStore } = await import('./meeting-prep');
        prepStoreForFile = useMeetingPrepStore();
        prepStoreForFile.beginDeviceSyncRun();
      } catch { /* prep prompt unavailable */ }

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
        prepStoreForFile?.endDeviceSyncRun();
      }
    },

    /**
     * Sync all new (un-synced) files
     */
    async syncAllNew({ auto = false } = {}) {
      const newFiles = oldestFirst(auto ? this._filesForAutoSync() : this.autoSyncableFiles);
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

      // "Apply to all" in the prep prompt is scoped to THIS sync run.
      let prepStoreForRun = null;
      try {
        const { useMeetingPrepStore } = await import('./meeting-prep');
        prepStoreForRun = useMeetingPrepStore();
        prepStoreForRun.beginDeviceSyncRun();
      } catch { /* prep prompt unavailable — sync continues without it */ }

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
        // End of the sync run — "apply to all" answers no longer carry over.
        prepStoreForRun?.endDeviceSyncRun();
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

      // One recordId per DEVICE FILE, not per attempt. The server dedupes
      // meetings by botSessionId = "desktop:<recordId>" (upload route), so
      // minting a fresh UUID on every retry made that dedupe unmatchable and
      // every re-attempt of the same file created — and billed — a brand-new
      // meeting (observed in prod: 210 duplicate meetings / 20 users in 60
      // days). Reuse the record and id from any earlier attempt of this file.
      const existingRec = historyStore.getRecordingByDeviceFilename(file.file);

      if (existingRec && (existingRec.uploadStatus === 'pending_prep' || existingRec.uploadStatus === 'uploading')) {
        // A live pipeline or an open context prompt still owns this file — a
        // second pipeline would double-prompt and double-upload it. The
        // stranded-prep scanner / stale-'uploading' reset releases these
        // states if their owner died, so this is never a permanent skip.
        addBreadcrumb({
          category: 'ble',
          message: `Skipping ${file.file} — existing record is ${existingRec.uploadStatus}`,
          level: 'info'
        });
        return;
      }

      if (existingRec && existingRec.uploadStatus === 'uploaded') {
        // The server already holds this file (e.g. the success response was
        // lost before syncedFiles was written). Heal the bookkeeping instead
        // of re-downloading and re-uploading it.
        await this._addSyncedFile(file.file);
        addBreadcrumb({
          category: 'ble',
          message: `Marked ${file.file} synced — already uploaded as record ${existingRec.id}`,
          level: 'info'
        });
        return;
      }

      const deviceKey = this.deviceSN || this.pairedDevice?.sn || this.deviceUuid || this.pairedDevice?.uuid || 'device';
      const recordId = existingRec?.id || deviceFileRecordId(authStore.user?.id || authStore.user?.userId, deviceKey, file.file);
      const prepAlreadyAnswered = existingRec?.prepAnswered === true;

      // An earlier attempt may have saved the complete file on the phone and
      // failed only at the upload. Re-use that file instead of transferring
      // it over Bluetooth again (40 MB = minutes on BLE). The path is only
      // written to history after a verified write, so its presence means the
      // file is complete; a missing file simply falls back to a download.
      let reusableFilePath = null;
      if (existingRec?.filePath && (existingRec.uploadStatus === 'failed' || existingRec.uploadStatus === 'pending')) {
        try {
          if (await storage.exists(existingRec.filePath)) reusableFilePath = existingRec.filePath;
        } catch { /* re-download */ }
      }
      // The user's "keep / delete after upload" choice applies to device
      // recordings too (it was never recorded for them, so their audio stayed
      // on the phone regardless of the setting).
      const storagePreference = existingRec?.storagePreference || historyStore.defaultStoragePreference || 'keep';

      // Add to history immediately so it's visible in the History tab during
      // transfer. Idempotent: with a reused id this updates the existing
      // record in place instead of inserting a duplicate.
      await historyStore.addRecording({
        id: recordId,
        title,
        duration: durationSec,
        filePath: reusableFilePath, // null until the download is verified on disk
        fileSize: file.size || 0,
        createdAt,
        uploadStatus: reusableFilePath ? 'pending' : 'transferring',
        source: 'device',
        deviceFilename: file.file,
        storagePreference
      });

      // Captures a soft upload failure (uploadWithVerification returned
      // success=false) so we can throw AFTER the try/catch — throwing from
      // inside the try falls into the catch block and clobbers the 'failed'
      // status with 'pending'. Until this is propagated, syncAllNew used to
      // claim "Sync complete" while recordings stayed visibly broken.
      let softUploadError = null;

      let filePath = reusableFilePath;
      try {
        if (filePath) {
          addBreadcrumb({ category: 'ble', message: `Re-using the saved copy of ${file.file} — upload only`, level: 'info' });
        } else {
          // Phase 1: BLE download
          if (this._cancelRequested) throw new Error('cancelled');

          if (!(file.size > 0)) {
            // A zero-byte entry on the card (device-side write failure) can
            // never transfer — skip it with a reason instead of asking the
            // recorder for it on every poll.
            const empty = new Error('Device file is empty');
            empty.code = 'EMPTY_FILE';
            throw empty;
          }

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

          // storage.writeFile owns the directory choice (app-private on Android,
          // sandbox Documents on iOS) and verifies the bytes reached disk.
          const dirPath = 'suissenotes_recordings';
          await storage.createDirectory(dirPath);
          filePath = `${dirPath}/${file.file}`;
          const bytes = saveData instanceof Uint8Array ? saveData : new Uint8Array(saveData);
          const writeResult = await storage.writeFile(
            filePath,
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          );
          if (!writeResult?.success) {
            throw new Error(writeResult?.error || 'Could not save device file');
          }

          await historyStore.updateRecording(recordId, { filePath, uploadStatus: 'pending' });
        }

        // Phase 2b: Ask for pre-meeting context/template (Suisse Meets Pro flow).
        // The file is safely on the phone — we WAIT for the answer (product
        // decision); "skip" is always available and with prompting disabled the
        // saved defaults apply automatically. While waiting the record carries
        // uploadStatus 'pending_prep', which is excluded from auto-retry so no
        // path uploads without the answer. App killed while waiting → the
        // stranded-record scanner in DeviceSyncPrepDialog re-prompts.
        // Asked once per FILE: a re-attempt after a failed upload reuses the
        // stored answer (prepAnswered) instead of prompting the user again.
        if (!prepAlreadyAnswered) {
          try {
            const { useMeetingPrepStore } = await import('./meeting-prep');
            const prepStore = useMeetingPrepStore();
            await prepStore.initialize();
            // Start the request FIRST (registers the recordId as in-flight
            // synchronously) so the stranded-record scanner can never race the
            // status flip below and double-prompt.
            const prepPromise = prepStore.requestDeviceSyncPrep({ recordId, title, fileName: file.file });
            await historyStore.updateRecording(recordId, { uploadStatus: 'pending_prep' });
            const prepFields = await prepPromise;
            const prepUpdates = { prepAnswered: true };
            if (prepFields && Object.keys(prepFields).length > 0) {
              prepUpdates.prep = prepFields;
            }
            await historyStore.updateRecording(recordId, prepUpdates);
          } catch (prepError) {
            console.warn('[DeviceSync] prep prompt failed — continuing without prep:', prepError);
          } finally {
            await historyStore.updateRecording(recordId, { uploadStatus: 'pending' });
          }
        }

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
            filename: file.file,
            ...(historyStore.recordings.find(r => r.id === recordId)?.prep || {})
          },
          onProgress: () => {},
          getAuthStore: () => authStore
        });

        if (result.inProgress) {
          // Revert the optimistic 'uploading' write: stranded 'uploading' is
          // excluded from auto-retry and manual retry, and the guard holder
          // never flips it back on failure. 'pending' stays retry-eligible;
          // the holder writes 'uploaded' itself on success.
          await historyStore.updateRecording(recordId, { uploadStatus: 'pending' });
          addBreadcrumb({
            category: 'ble',
            message: `Device file upload skipped because upload is already in progress: ${file.file}`,
            level: 'info'
          });
          return;
        }

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
          delete this._crcFailures[file.file];
          // "Delete after upload": the cloud copy is verified — drop the local audio.
          try { await historyStore.applyStoragePreference(recordId); } catch (e) { /* best-effort */ }
        } else {
          await historyStore.updateRecording(recordId, {
            uploadStatus: 'failed',
            uploadError: result.error || 'Upload failed'
          });
          // A final server verdict (out of minutes, no speech, …) or an
          // offline phone is not an app defect — warn, don't page.
          const expected = result.canRetry === false || result.insufficientMinutes ||
            /Failed to fetch|Load failed|Network error|min remaining|keine Sprache|no speech/i.test(result.error || '');
          if (expected) {
            captureMessage(`Device file upload declined (expected): ${result.error}`, 'warning');
          } else {
            captureException(new Error(`Device file upload failed: ${result.error}`), {
              tags: { action: 'ble_upload' },
              extra: { filename: file.file, recordId, error: result.error }
            });
          }
          softUploadError = result.error || 'Upload failed';
        }

      } catch (err) {
        const isCancelled = this._cancelRequested ||
          err.message === 'BLE download cancelled' ||
          err.message === 'cancelled';

        // Transfers that can never succeed by retrying: an empty file on the
        // card, or a file that keeps arriving corrupted. Skip them with a
        // translated reason (the user can un-skip from the device page)
        // instead of retrying on every 20-second poll forever.
        const isCrc = /CRC mismatch/i.test(err.message || '');
        if (isCrc) this._crcFailures[file.file] = (this._crcFailures[file.file] || 0) + 1;
        if (!isCancelled && (err.code === 'EMPTY_FILE' || (isCrc && this._crcFailures[file.file] >= MAX_CRC_FAILURES))) {
          const reason = err.code === 'EMPTY_FILE' ? 'EMPTY_FILE' : 'CRC_GAVE_UP';
          await historyStore.updateRecording(recordId, { uploadStatus: 'skipped', filePath: null, uploadError: reason });
          await this._addSkippedFile(file.file);
          captureMessage(`BLE sync skipped ${file.file}: ${reason} (${err.message})`, 'warning');
          const skipErr = new Error(err.message);
          skipErr.code = reason;
          throw skipErr;
        }

        if (isCancelled) {
          // User-chosen semantics: "Delete partial on phone, keep file on device,
          // mark skipped locally." Re-sync is always a full re-download (the
          // protocol has no byte-offset resume — CMD_FILE_DOWNLOAD takes filename only).
          const rec = historyStore.getRecordingById(recordId);

          // 1) Delete any partial file that was saved to phone filesystem
          if (rec?.filePath) {
            try {
              await storage.deleteFile(rec.filePath);
              addBreadcrumb({ category: 'ble', message: `Deleted partial file: ${rec.filePath}`, level: 'info' });
            } catch (delErr) {
              // Best-effort — file may not exist or may fail to delete.
              // Not fatal: the file will be overwritten on next sync.
              addBreadcrumb({ category: 'ble', message: `Partial file delete failed (best-effort): ${delErr.message}`, level: 'warning' });
            }
          }

          // 2) Keep the history record as 'skipped' (no local file) so the
          //    recording stays findable — the card offers "re-sync from
          //    device". Deleting the record here used to make a cancelled
          //    device recording vanish from History entirely.
          try {
            await historyStore.updateRecording(recordId, { uploadStatus: 'skipped', filePath: null, uploadError: null });
          } catch (histErr) {
            addBreadcrumb({ category: 'ble', message: `History skip-mark failed (best-effort): ${histErr.message}`, level: 'warning' });
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
        if (isBleTransportError(err) || /CRC mismatch/i.test(err?.message || '')) {
          // Dropped link or a corrupted transfer: retried on the next sync.
          captureMessage(`BLE sync of ${file.file} interrupted: ${err.message}`, 'warning');
        } else {
          captureException(err, {
            tags: { action: 'ble_upload' },
            extra: { filename: file.file, recordId }
          });
        }
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

      // A manual retry re-arms a record parked after a final server verdict.
      await historyStore.updateRecording(rec.id, { uploadStatus: 'uploading', uploadTerminal: null, retryCount: 0 });

      try {
        const result = await uploadWithVerification({
          filePath: rec.filePath,
          recordId: rec.id,
          apiUrl: getApiUrlSync(),
          authToken: authStore.token,
          metadata: {
            duration: (rec.duration || 0).toString(),
            title: rec.title || '',
            filename,
            ...(rec.prep || {})
          },
          onProgress: () => {},
          getAuthStore: () => authStore
        });

        if (result.inProgress) {
          // Revert the optimistic 'uploading' write (see syncAllNew) — the
          // guard holder owns completion; keep this record retry-eligible.
          await historyStore.updateRecording(rec.id, { uploadStatus: 'pending' });
          return;
        }

        if (result.success) {
          await historyStore.updateRecording(rec.id, {
            uploadStatus: 'uploaded',
            transcriptionId: result.transcriptionId,
            audioFileId: result.audioFileId
          });
          await this._addSyncedFile(filename);
          try { await historyStore.applyStoragePreference(rec.id); } catch (e) { /* best-effort */ }
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

    /**
     * Files the automatic poll should sync. Files that already sit on the
     * phone with a failed/pending upload belong to the history auto-retry
     * (exponential backoff) — or are parked after a final server verdict
     * until the user retries — so the poll must not re-download them over
     * Bluetooth every tick. Manual "Sync all" / per-file sync still takes
     * them (and re-uses the saved copy).
     */
    _filesForAutoSync() {
      const historyStore = useRecordingsHistoryStore();
      return this.autoSyncableFiles.filter(f => {
        const rec = historyStore.getRecordingByDeviceFilename?.(f.file);
        if (!rec) return true;
        const parked = (rec.uploadStatus === 'failed' || rec.uploadStatus === 'pending') && (rec.filePath || rec.uploadTerminal);
        return !parked;
      });
    },

    async _autoSyncPoll() {
      if (!this.isConnected || this.isSyncing) return;
      // A slow tick (long file list, a multi-file sync) must not overlap the
      // next interval tick — the command lock would only queue the second one.
      if (this._pollInProgress) return;
      this._pollInProgress = true;

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

        // The list runs inside the recorder's sync state (buttons disabled):
        // every LIST_EVERY_N_TICKS ticks, or right after a recording stopped.
        this._pollTick += 1;
        const due = this._listRefreshRequested || this._pollTick % LIST_EVERY_N_TICKS === 1;
        if (!due) return;
        this._listRefreshRequested = false;

        try {
          await this.fetchFileList();
        } catch (e) {
          // Busy card (a recording just stopped / the card is still being
          // scanned) or a dropped link: nothing to do this tick. Ask for the
          // list again on the next tick instead of waiting a full cycle.
          this._listRefreshRequested = true;
          addBreadcrumb({ category: 'ble', message: `auto-sync: file list unavailable this tick (${e.message})`, level: 'warning' });
          return;
        }

        // Re-check: recording may have started during file list fetch
        if (this.isRecordingOnDevice) return;

        const newFiles = this._filesForAutoSync();
        if (newFiles.length > 0) {
          addBreadcrumb({
            category: 'ble',
            message: `Auto-sync: ${newFiles.length} new file(s) detected`,
            level: 'info'
          });
          await this.syncAllNew({ auto: true });
        }
      } catch (e) {
        // Per-file failures are reported where they happen and a dropped link
        // ends polling through the disconnect handler — keep polling. Until
        // 3.9.37 ANY error here stopped the poll for the rest of the session
        // (a busy card during a device recording was enough): new recordings
        // were then only picked up after a reconnect.
        console.log('Auto-sync poll error:', e.message);
        if (isBleTransportError(e) || e.failureCount) {
          addBreadcrumb({ category: 'ble', message: `auto-sync tick failed: ${e.message}`, level: 'warning' });
        } else {
          captureException(e, {
            tags: { action: 'auto_sync_poll' },
            extra: { failureCount: e.failureCount, totalCount: e.totalCount }
          });
        }
      } finally {
        this._pollInProgress = false;
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
      this._pollTick = 0;
      this._listRefreshRequested = false;
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
      this._persistentFailures = 0;
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
     * Persistent reconnect — the long-term safety net after the fast backoff
     * loop gave up. Exponential backoff: 15s, 30s, 60s, 2min, 4min, capped at
     * 5min while the device stays unreachable (switched off, left at home);
     * reset to 15s on success, on foreground, or on a manual retry.
     *
     * The previous fixed 15-second interval ran a 12s rediscovery scan plus a
     * 15s connect timeout back-to-back for as long as the app was open — a
     * continuous radio/battery drain producing an error event every ~30s
     * (Sentry CAPACITOR-7: 2308 events from 38 users).
     */
    _persistentDelayMs() {
      const factor = Math.pow(2, Math.min(this._persistentFailures, 5));
      return Math.min(RECONNECT_INTERVAL_MS * factor, RECONNECT_INTERVAL_MAX_MS);
    },

    _startPersistentReconnect() {
      this._stopPersistentReconnect();
      const tick = async () => {
        this._persistentReconnectTimer = null;
        try {
          if (!this.pairedDevice || this._intentionalDisconnect) return;
          if (this.connectionState !== 'disconnected') return;
          if (document.hidden) return; // Only when app is in foreground
          // Cross-timer mutex — if scheduled-reconnect is mid-attempt OR a
          // retryConnect is in flight, skip this safety-net tick.
          if (this._reconnectInProgress) return;
          this._reconnectInProgress = true;
          try {
            addBreadcrumb({ category: 'ble', message: `Persistent reconnect attempt (failures=${this._persistentFailures})`, level: 'info' });
            await this.autoConnect();
            this._persistentFailures = 0;
            addBreadcrumb({ category: 'ble', message: 'Persistent reconnect succeeded', level: 'info' });
          } catch {
            this._persistentFailures++;
          } finally {
            this._reconnectInProgress = false;
          }
        } finally {
          // Re-arm only if nobody stopped/replaced the timer meanwhile.
          if (this._persistentReconnectTimer === null && this.pairedDevice && !this._intentionalDisconnect) {
            this._persistentReconnectTimer = setTimeout(tick, this._persistentDelayMs());
          }
        }
      };
      this._persistentReconnectTimer = setTimeout(tick, this._persistentDelayMs());
    },

    _stopPersistentReconnect() {
      if (this._persistentReconnectTimer) {
        clearTimeout(this._persistentReconnectTimer);
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
