import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Regression: on iOS, StatusBar.setOverlaysWebView is UNIMPLEMENTED and used
// to reject inside the single try/catch that wrapped the whole lifecycle
// initializer — so no iPhone ever registered the app-state / network /
// battery / deep-link listeners (no background flush, no upload-queue resume
// on reconnect). Every step must now be isolated.
// ---------------------------------------------------------------------------

const m = vi.hoisted(() => ({
  platform: { ios: true },
  appListeners: {},
  networkListeners: {},
  setOverlaysWebView: vi.fn(),
  setStyle: vi.fn(),
  breadcrumbs: [],
  messages: [],
}));

vi.mock('../../src/utils/platform', () => ({
  isCapacitor: () => true,
  isMobile: () => true,
  isAndroid: () => !m.platform.ios,
  isIOS: () => m.platform.ios,
  PlatformConstants: { CRITICAL_BATTERY_PERCENT: 5, LOW_BATTERY_PERCENT: 15 },
}));

vi.mock('../../src/boot/sentry', () => ({
  addBreadcrumb: (bc) => m.breadcrumbs.push(bc),
  captureMessage: (msg, level) => m.messages.push({ msg, level }),
}));

vi.mock('../../src/services/sentryHelpers', () => ({
  sentryAppBackground: () => {},
  sentryAppForeground: () => {},
  sentryNetworkChange: () => {},
  sentryLowBattery: () => {},
}));

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setOverlaysWebView: m.setOverlaysWebView, setStyle: m.setStyle },
  Style: { Light: 'LIGHT', Dark: 'DARK' },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (name, handler) => {
      m.appListeners[name] = handler;
      return { remove: async () => { delete m.appListeners[name]; } };
    }),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    addListener: vi.fn(async (name, handler) => {
      m.networkListeners[name] = handler;
      return { remove: async () => {} };
    }),
  },
}));

vi.mock('@capacitor/device', () => ({
  Device: { getBatteryInfo: vi.fn(async () => ({ batteryLevel: 0.8, isCharging: false })) },
}));

import { initializeLifecycle, cleanupLifecycle, isLifecycleInitialized, setLifecycleCallbacks } from '../../src/boot/lifecycle';

describe('lifecycle boot resilience (iOS)', () => {
  beforeEach(async () => {
    await cleanupLifecycle();
    m.platform.ios = true;
    m.breadcrumbs.length = 0;
    m.messages.length = 0;
    for (const k of Object.keys(m.appListeners)) delete m.appListeners[k];
    for (const k of Object.keys(m.networkListeners)) delete m.networkListeners[k];
    m.setOverlaysWebView.mockReset();
    m.setStyle.mockReset();
  });

  it('registers app-state, network and deep-link listeners even though the status bar call is unimplemented on iOS', async () => {
    // On iOS the plugin rejects — but we never call it there any more.
    m.setOverlaysWebView.mockRejectedValue(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
    m.setStyle.mockResolvedValue();

    await initializeLifecycle();

    expect(m.setOverlaysWebView).not.toHaveBeenCalled();
    expect(typeof m.appListeners.appStateChange).toBe('function');
    expect(typeof m.appListeners.appUrlOpen).toBe('function');
    expect(typeof m.networkListeners.networkStatusChange).toBe('function');
    expect(m.appListeners.backButton).toBeUndefined(); // Android-only
    expect(isLifecycleInitialized()).toBe(true);
    expect(m.messages.filter(x => x.level === 'error')).toEqual([]);
  });

  it('keeps going when an earlier step throws (status bar style failure must not block the app-state listener)', async () => {
    m.setStyle.mockRejectedValue(new Error('boom'));

    await initializeLifecycle();

    expect(typeof m.appListeners.appStateChange).toBe('function');
    expect(isLifecycleInitialized()).toBe(true);
    expect(m.breadcrumbs.some(b => /init step failed: statusBar/.test(b.message))).toBe(true);
  });

  it('calls setOverlaysWebView on Android and registers the back button listener', async () => {
    m.platform.ios = false;
    m.setOverlaysWebView.mockResolvedValue();
    m.setStyle.mockResolvedValue();

    await initializeLifecycle();

    expect(m.setOverlaysWebView).toHaveBeenCalledWith({ overlay: true });
    expect(typeof m.appListeners.backButton).toBe('function');
  });

  it('routes the background/foreground callbacks and dispatches the SSO callback without leaking the token', async () => {
    m.setStyle.mockResolvedValue();
    const onBackground = vi.fn(async () => {});
    const onForeground = vi.fn(async () => {});
    setLifecycleCallbacks({ onBackground, onForeground });
    await initializeLifecycle();

    await m.appListeners.appStateChange({ isActive: false });
    expect(onBackground).toHaveBeenCalledTimes(1);
    await m.appListeners.appStateChange({ isActive: true });
    expect(onForeground).toHaveBeenCalledTimes(1);

    const received = [];
    window.addEventListener('sso:callback', (e) => received.push(e.detail));
    const user = btoa(JSON.stringify({ id: 'u1', email: 'a@b.ch' })).replace(/=+$/, '');
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1MSJ9.abcdefghijklmnop';
    m.appListeners.appUrlOpen({ url: `suissenotes://auth/callback?token=${jwt}&user=${user}` });

    expect(received).toHaveLength(1);
    expect(received[0].token).toBe(jwt);
    expect(received[0].user.id).toBe('u1');
    const serialized = JSON.stringify(m.breadcrumbs);
    expect(serialized).not.toContain(jwt);
    expect(serialized).toMatch(/token=(%5B|\[)REDACTED(%5D|\])/);
  });
});
