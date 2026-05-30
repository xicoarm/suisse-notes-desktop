/**
 * Capacitor lifecycle boot file
 * Handles app state changes, battery monitoring, and graceful shutdown on mobile
 * Addresses vulnerability V2: No Graceful Shutdown on Force Quit
 */

import { isCapacitor, isMobile, isAndroid, PlatformConstants } from '../utils/platform';
import { sentryAppBackground, sentryAppForeground, sentryNetworkChange, sentryLowBattery } from '../services/sentryHelpers';
import { captureMessage } from './sentry';

// Module-level state for lifecycle management
let lifecycleInitialized = false;
let appStateListener = null;
let networkListener = null;
let batteryCheckInterval = null;

// P0 Data Loss Fix: Adaptive battery monitoring state (V9)
let isRecordingActiveFlag = false;
let currentBatteryIntervalMs = 60000; // Default: 60s

// P0 Fix: Track background flush completion to retry on foreground if interrupted
let backgroundFlushCompleted = true;

// Callbacks set by recording store
let onAppBackground = null;
let onAppForeground = null;
let onNetworkOnline = null;
let onNetworkOffline = null;
let onLowBattery = null;
let onCriticalBattery = null;

/**
 * Parse a deep-link URL into an SSO callback payload, or null if it isn't one.
 * Accepted shapes:
 *   suissenotes://auth/callback?token=<jwt>&user=<base64url-json>     (Phase 1, custom scheme)
 *   suissenotes://auth/callback?error=<message>
 *   https://app.suisse-notes.ch/sso/handoff?...                       (Phase 2, Universal Link / App Link — same params)
 * Returns: { token, user } | { error } | null
 */
function parseSSOCallbackUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const isCustomScheme = parsed.protocol === 'suissenotes:'
    && parsed.host === 'auth'
    && parsed.pathname.replace(/\/$/, '') === '/callback';
  const isUniversalLink = parsed.protocol === 'https:'
    && parsed.host === 'app.suisse-notes.ch'
    && parsed.pathname.startsWith('/sso/');
  if (!isCustomScheme && !isUniversalLink) return null;

  const error = parsed.searchParams.get('error');
  if (error) return { error };

  const token = parsed.searchParams.get('token');
  const userB64 = parsed.searchParams.get('user');
  if (!token || !userB64) return { error: 'invalid_callback' };

  try {
    // base64url -> JSON. Convert URL-safe chars and pad before atob.
    const std = userB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    const user = JSON.parse(atob(padded));
    return { token, user };
  } catch {
    return { error: 'invalid_callback' };
  }
}

/**
 * Initialize Capacitor lifecycle listeners
 * Should be called from the boot file on mobile platforms only
 */
export const initializeLifecycle = async () => {
  if (!isCapacitor()) {
    console.log('Lifecycle: Skipping initialization (not on Capacitor)');
    return;
  }

  if (lifecycleInitialized) {
    console.log('Lifecycle: Already initialized');
    return;
  }

  try {
    // Enable overlay mode so we control safe area via CSS (both iOS and Android)
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setOverlaysWebView({ overlay: true });
    // Dark icons for light-background pages (authenticated). Login/register pages
    // switch to Style.Dark (white icons) for their purple backgrounds.
    await StatusBar.setStyle({ style: Style.Light });

    // Import Capacitor plugins dynamically
    const { App } = await import('@capacitor/app');
    const { Network } = await import('@capacitor/network');

    // Listen for app state changes (foreground/background)
    appStateListener = await App.addListener('appStateChange', async ({ isActive }) => {
      if (isActive) {
        console.log('Lifecycle: App came to foreground');
        sentryAppForeground();

        // P0 Fix: If background flush was interrupted by iOS suspension, retry now
        if (!backgroundFlushCompleted && onAppBackground) {
          console.warn('Lifecycle: Background flush was interrupted — retrying on foreground');
          try {
            await onAppBackground();
            backgroundFlushCompleted = true;
          } catch (e) {
            console.error('Lifecycle: Retry background flush failed:', e);
          }
        }

        // P0 Fix: Check battery immediately on foreground (may have dropped to critical during background)
        if (isRecordingActiveFlag && onCriticalBattery) {
          try {
            const { Device } = await import('@capacitor/device');
            const info = await Device.getBatteryInfo();
            const batteryPercent = Math.round((info.batteryLevel || 0) * 100);
            if (!info.isCharging && batteryPercent <= PlatformConstants.CRITICAL_BATTERY_PERCENT) {
              console.warn(`Lifecycle: Critical battery on foreground return (${batteryPercent}%)`);
              await onCriticalBattery(batteryPercent);
            }
          } catch (e) {
            console.warn('Lifecycle: Battery check on foreground failed:', e);
          }
        }

        if (onAppForeground) {
          try { await onAppForeground(); } catch (e) { console.error('Lifecycle: onAppForeground error:', e); }
        }
      } else {
        console.log('Lifecycle: App went to background');
        sentryAppBackground();
        if (onAppBackground) {
          // P0 Fix: Track flush completion — iOS may kill us mid-await.
          backgroundFlushCompleted = false;
          try {
            // INT-7: race the flush against a 4s timeout (iOS gives ~5s before
            // suspension) but record WHICH branch won. The previous code set
            // backgroundFlushCompleted=true unconditionally after the race, so a
            // flush still writing when the timeout fired was wrongly treated as
            // done and never retried. Now a timeout leaves the flag false so
            // onForeground re-runs the flush; cold-start recovery also still
            // re-combines because flushCurrentState persists the session with
            // status='recording'.
            const flushDone = Promise.resolve(onAppBackground()).then(() => true);
            const timedOut = new Promise(resolve => setTimeout(() => resolve(false), 4000));
            backgroundFlushCompleted = (await Promise.race([flushDone, timedOut])) === true;
            if (!backgroundFlushCompleted) {
              console.warn('Lifecycle: background flush did not confirm within 4s — will retry on foreground');
            }
          } catch (e) {
            console.error('Lifecycle: onAppBackground error:', e);
            backgroundFlushCompleted = false;
          }
        }
      }
    });

    // Listen for network changes
    networkListener = await Network.addListener('networkStatusChange', async (status) => {
      sentryNetworkChange(status.connected, status.connectionType);
      if (status.connected) {
        console.log('Lifecycle: Network connected', status.connectionType);
        if (onNetworkOnline) {
          try { await onNetworkOnline(status.connectionType); } catch (e) { console.error('Lifecycle: onNetworkOnline error:', e); }
        }
      } else {
        console.log('Lifecycle: Network disconnected');
        if (onNetworkOffline) {
          try { await onNetworkOffline(); } catch (e) { console.error('Lifecycle: onNetworkOffline error:', e); }
        }
      }
    });

    // Start battery monitoring (check every 60 seconds)
    await startBatteryMonitoring();

    // Listen for app URL open (deep links — incl. SSO callback).
    // Diagnostic Sentry breadcrumbs prove the iOS/Android deep-link routing
    // reached the JS layer when SSO seems to "do nothing" after the OAuth
    // round trip.
    await App.addListener('appUrlOpen', (data) => {
      console.log('Lifecycle: App opened via URL', data.url);
      try { captureMessage(`sso: appUrlOpen fired url=${(data.url || '').slice(0, 200)}`, 'info'); } catch { /* sentry not loaded */ }
      const ssoPayload = parseSSOCallbackUrl(data.url);
      try {
        const tag = ssoPayload ? (ssoPayload.error ? 'error:' + ssoPayload.error : 'success+token') : 'null';
        captureMessage(`sso: parseSSOCallbackUrl result=${tag}`, 'info');
      } catch { /* sentry not loaded */ }
      if (ssoPayload) {
        // Hand off to the LoginPage (or wherever it's listened to) via a
        // platform-neutral CustomEvent. Mirrors the Electron auth:ssoCallback
        // IPC channel — payload shape is { token, user } | { error }.
        window.dispatchEvent(new CustomEvent('sso:callback', { detail: ssoPayload }));
      }
    });

    // Listen for back button (Android only — the listener throws
    // "Method not implemented" on iOS and would abort the rest of
    // initializeLifecycle via the surrounding catch).
    if (isAndroid()) {
      await App.addListener('backButton', (event) => {
        console.log('Lifecycle: Back button pressed', event);
        // Let Vue Router handle back navigation by default
      });
    }

    lifecycleInitialized = true;
    console.log('Lifecycle: Initialized successfully');
  } catch (error) {
    console.error('Lifecycle: Failed to initialize', error);
  }
};

/**
 * Start battery monitoring with adaptive intervals (V9 fix)
 * - 60s when idle
 * - 15s during active recording
 * - 10s when battery < 20%
 */
const startBatteryMonitoring = async () => {
  if (batteryCheckInterval) {
    return;
  }

  try {
    const { Device } = await import('@capacitor/device');

    const checkBattery = async () => {
      try {
        const info = await Device.getBatteryInfo();

        // info.batteryLevel is 0-1, convert to percentage
        const batteryPercent = Math.round((info.batteryLevel || 0) * 100);
        const isCharging = info.isCharging || false;

        // P0 Data Loss Fix: Adaptive interval based on state (V9)
        let newInterval;
        if (isCharging) {
          newInterval = 60000; // 60s when charging
        } else if (batteryPercent <= 20) {
          newInterval = 10000; // 10s when low battery
        } else if (isRecordingActiveFlag) {
          newInterval = 15000; // 15s during recording
        } else {
          newInterval = 60000; // 60s idle
        }

        // Adjust interval if it changed
        if (newInterval !== currentBatteryIntervalMs) {
          currentBatteryIntervalMs = newInterval;
          clearInterval(batteryCheckInterval);
          batteryCheckInterval = setInterval(checkBattery, currentBatteryIntervalMs);
        }

        // Skip warnings if charging
        if (isCharging) {
          return;
        }

        if (batteryPercent <= PlatformConstants.CRITICAL_BATTERY_PERCENT && onCriticalBattery) {
          console.warn(`Lifecycle: CRITICAL battery level (${batteryPercent}%)`);
          sentryLowBattery(batteryPercent);
          try { await onCriticalBattery(batteryPercent); } catch (e) { console.error('Lifecycle: onCriticalBattery error:', e); }
        } else if (batteryPercent <= PlatformConstants.LOW_BATTERY_PERCENT && onLowBattery) {
          console.warn(`Lifecycle: Low battery level (${batteryPercent}%)`);
          sentryLowBattery(batteryPercent);
          try { await onLowBattery(batteryPercent); } catch (e) { console.error('Lifecycle: onLowBattery error:', e); }
        }
      } catch (error) {
        console.warn('Lifecycle: Battery check failed', error);
      }
    };

    // Initial check
    await checkBattery();

    // Start with default interval
    batteryCheckInterval = setInterval(checkBattery, currentBatteryIntervalMs);
  } catch (error) {
    console.warn('Lifecycle: Battery monitoring not available', error);
  }
};

/**
 * Set recording active state for adaptive battery monitoring (V9 fix)
 * Called from recording store on start/stop
 * @param {boolean} active - Whether recording is active
 */
export const setRecordingActive = (active) => {
  isRecordingActiveFlag = active;
};

/**
 * Stop battery monitoring
 */
const stopBatteryMonitoring = () => {
  if (batteryCheckInterval) {
    clearInterval(batteryCheckInterval);
    batteryCheckInterval = null;
  }
};

/**
 * Clean up all lifecycle listeners
 */
export const cleanupLifecycle = async () => {
  if (appStateListener) {
    await appStateListener.remove();
    appStateListener = null;
  }

  if (networkListener) {
    await networkListener.remove();
    networkListener = null;
  }

  stopBatteryMonitoring();

  lifecycleInitialized = false;
  console.log('Lifecycle: Cleaned up');
};

/**
 * Set lifecycle callbacks
 * Called by recording store to register handlers for lifecycle events
 * @param {Object} callbacks - Callback functions
 */
export const setLifecycleCallbacks = (callbacks = {}) => {
  onAppBackground = callbacks.onBackground || null;
  onAppForeground = callbacks.onForeground || null;
  onNetworkOnline = callbacks.onOnline || null;
  onNetworkOffline = callbacks.onOffline || null;
  onLowBattery = callbacks.onLowBattery || null;
  onCriticalBattery = callbacks.onCriticalBattery || null;
};

/**
 * Clear lifecycle callbacks
 */
export const clearLifecycleCallbacks = () => {
  onAppBackground = null;
  onAppForeground = null;
  onNetworkOnline = null;
  onNetworkOffline = null;
  onLowBattery = null;
  onCriticalBattery = null;
};

/**
 * Get current network status
 * @returns {Promise<{connected: boolean, connectionType: string}>}
 */
export const getNetworkStatus = async () => {
  if (!isCapacitor()) {
    // On desktop/web, assume online
    return { connected: navigator.onLine, connectionType: 'unknown' };
  }

  try {
    const { Network } = await import('@capacitor/network');
    return await Network.getStatus();
  } catch (error) {
    console.warn('Lifecycle: Could not get network status', error);
    return { connected: true, connectionType: 'unknown' };
  }
};

/**
 * Get current battery info
 * @returns {Promise<{batteryLevel: number, isCharging: boolean}>}
 */
export const getBatteryInfo = async () => {
  if (!isCapacitor()) {
    // On desktop, assume full battery
    return { batteryLevel: 1, isCharging: false };
  }

  try {
    const { Device } = await import('@capacitor/device');
    return await Device.getBatteryInfo();
  } catch (error) {
    console.warn('Lifecycle: Could not get battery info', error);
    return { batteryLevel: 1, isCharging: false };
  }
};

/**
 * Check if app is in foreground
 * @returns {Promise<boolean>}
 */
export const isAppActive = async () => {
  if (!isCapacitor()) {
    return true; // Desktop is always "active"
  }

  try {
    const { App } = await import('@capacitor/app');
    const state = await App.getState();
    return state.isActive;
  } catch (error) {
    console.warn('Lifecycle: Could not get app state', error);
    return true;
  }
};

/**
 * Quasar boot function
 * This is called automatically when the boot file is loaded
 */
export default async ({ app }) => {
  // Only initialize on mobile platforms
  if (isMobile()) {
    await initializeLifecycle();
  }
};
