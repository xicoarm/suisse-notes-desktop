import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// ---------------------------------------------------------------------------
// The persistent BLE reconnect must back off while the paired recorder is
// unreachable (switched off, left at home): the old fixed 15s loop ran a 12s
// scan + 15s connect attempt continuously for as long as the app was open and
// reported every failure as a Sentry error (CAPACITOR-7, 2308 events/38 users).
// Bluetooth may also only be initialized (= OS permission prompt) when the
// user actually has a paired device.
// ---------------------------------------------------------------------------

const m = vi.hoisted(() => ({
  prefs: new Map(),
  manager: {
    initialize: vi.fn(async () => {}),
    onDisconnect: vi.fn(),
    onRecordingStateChange: vi.fn(),
    connectWithRediscovery: vi.fn(),
    disconnect: vi.fn(async () => {}),
    getBattery: vi.fn(async () => 80),
    getStorage: vi.fn(async () => ({})),
    getFileList: vi.fn(async () => []),
    deviceUuid: 'dev-uuid',
  },
  breadcrumbs: [],
  messages: [],
  exceptions: [],
}));

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  getPlatform: () => 'ios',
}));
vi.mock('../../src/boot/sentry', () => ({
  addBreadcrumb: (b) => m.breadcrumbs.push(b),
  captureException: (e) => m.exceptions.push(e),
  captureMessage: (msg, level) => m.messages.push({ msg, level }),
}));
vi.mock('../../src/boot/i18n', () => ({ i18n: { global: { t: (k) => k } } }));
vi.mock('../../src/utils/rawOpusToOgg', () => ({ isRawOpusPackets: () => false, rawOpusToOgg: (x) => x }));
vi.mock('../../src/services/api', () => ({ getApiUrlSync: () => 'https://api.test' }));
vi.mock('../../src/services/upload', () => ({ uploadWithVerification: vi.fn() }));
vi.mock('../../src/services/storage', () => ({}));
vi.mock('../../src/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true }),
}));
vi.mock('../../src/stores/recordings-history', () => ({
  useRecordingsHistoryStore: () => ({ recordings: [], getRecordingByDeviceFilename: () => null }),
}));
vi.mock('../../src/services/bleService', () => ({ getBleManager: () => m.manager }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }) => ({ value: m.prefs.has(key) ? m.prefs.get(key) : null })),
    set: vi.fn(async ({ key, value }) => { m.prefs.set(key, value); }),
    remove: vi.fn(async ({ key }) => { m.prefs.delete(key); }),
  },
}));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: async () => {} })) } }));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: { checkPermissions: vi.fn(async () => ({ display: 'granted' })), requestPermissions: vi.fn(), schedule: vi.fn() },
}));

import { useDeviceStore, isBleTransportError } from '../../src/stores/device';

describe('device store — lazy BLE init', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    m.prefs.clear();
    vi.clearAllMocks();
    m.breadcrumbs.length = 0; m.messages.length = 0; m.exceptions.length = 0;
  });

  it('does NOT initialize Bluetooth (no permission prompt) when the user has no paired device', async () => {
    const store = useDeviceStore();
    await store.initialize();
    expect(m.manager.initialize).not.toHaveBeenCalled();
  });

  it('initializes Bluetooth at startup when a paired device exists for this user', async () => {
    m.prefs.set('ble_paired_device:uu1', JSON.stringify({ deviceId: 'D1', uuid: 'x', name: 'Pro', sn: '1' }));
    const store = useDeviceStore();
    await store.initialize();
    expect(m.manager.initialize).toHaveBeenCalledTimes(1);
    expect(store.hasPairedDevice).toBe(true);
  });
});

describe('device store — persistent reconnect backoff', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    m.prefs.clear();
    vi.clearAllMocks();
  });

  it('doubles the delay per consecutive failure and caps at 5 minutes', () => {
    const store = useDeviceStore();
    store._persistentFailures = 0;
    expect(store._persistentDelayMs()).toBe(15_000);
    store._persistentFailures = 1;
    expect(store._persistentDelayMs()).toBe(30_000);
    store._persistentFailures = 3;
    expect(store._persistentDelayMs()).toBe(120_000);
    store._persistentFailures = 9;
    expect(store._persistentDelayMs()).toBe(300_000);
  });

  it('counts failed automatic attempts, uses silent connects, and resets on success', async () => {
    vi.useFakeTimers();
    try {
      const store = useDeviceStore();
      store.pairedDevice = { deviceId: 'D1', uuid: 'x', name: 'Pro', sn: '1' };
      store.connectionState = 'disconnected';
      m.manager.connectWithRediscovery.mockRejectedValue(new Error('Connection timeout'));

      store._startPersistentReconnect();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(m.manager.connectWithRediscovery).toHaveBeenCalledTimes(1);
      expect(m.manager.connectWithRediscovery.mock.calls[0][2]).toMatchObject({ silent: true });
      expect(store._persistentFailures).toBe(1);

      // Second attempt only after the doubled delay
      await vi.advanceTimersByTimeAsync(15_000);
      expect(m.manager.connectWithRediscovery).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(m.manager.connectWithRediscovery).toHaveBeenCalledTimes(2);
      expect(store._persistentFailures).toBe(2);

      // Success resets the counter
      m.manager.connectWithRediscovery.mockResolvedValue({ name: 'Pro', SN: '1' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.connectionState).toBe('connected');
      expect(store._persistentFailures).toBe(0);
      store._stopPersistentReconnect();
      store.stopAutoSync();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isBleTransportError', () => {
  it('classifies link/device-state errors as transport (expected) errors', () => {
    for (const msg of ['Connection timeout', 'Connection failed: Connection timeout.', 'BLE disconnected during transfer',
      'Not connected to device.', 'deviceId required.', 'BLE response timeout', "Device not found. Call 'requestDevice'",
      'Device rejected pairing (already paired to another app)']) {
      expect(isBleTransportError(new Error(msg))).toBe(true);
    }
    expect(isBleTransportError(new Error('TypeError: x is not a function'))).toBe(false);
    expect(isBleTransportError(null)).toBe(false);
  });
});
