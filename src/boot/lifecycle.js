/**
 * Capacitor lifecycle boot file
 * Handles app state changes, battery monitoring, and graceful shutdown on mobile
 * Addresses vulnerability V2: No Graceful Shutdown on Force Quit
 */

import { isCapacitor, isMobile, PlatformConstants } from '../utils/platform';

// Module-level state for lifecycle management
let lifecycleInitialized = false;
let appStateListener = null;
let networkListener = null;
let batteryCheckInterval = null;

// Callbacks set by recording store
let onAppBackground = null;
let onAppForeground = null;
let onNetworkOnline = null;
let onNetworkOffline = null;
let onLowBattery = null;
let onCriticalBattery = null;

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
        if (onAppForeground) {
          try { await onAppForeground(); } catch (e) { console.error('Lifecycle: onAppForeground error:', e); }
        }
      } else {
        console.log('Lifecycle: App went to background');
        if (onAppBackground) {
          try { await onAppBackground(); } catch (e) { console.error('Lifecycle: onAppBackground error:', e); }
        }
      }
    });

    // Listen for network changes
    networkListener = await Network.addListener('networkStatusChange', async (status) => {
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

    // Listen for app URL open (deep links)
    await App.addListener('appUrlOpen', (data) => {
      console.log('Lifecycle: App opened via URL', data.url);
      // Handle deep links here if needed
    });

    // Listen for back button (Android)
    await App.addListener('backButton', (event) => {
      console.log('Lifecycle: Back button pressed', event);
      // Let Vue Router handle back navigation by default
    });

    lifecycleInitialized = true;
    console.log('Lifecycle: Initialized successfully');
  } catch (error) {
    console.error('Lifecycle: Failed to initialize', error);
  }
};

/**
 * Start battery monitoring
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

        // Skip warnings if charging
        if (isCharging) {
          return;
        }

        if (batteryPercent <= PlatformConstants.CRITICAL_BATTERY_PERCENT && onCriticalBattery) {
          console.warn(`Lifecycle: CRITICAL battery level (${batteryPercent}%)`);
          try { await onCriticalBattery(batteryPercent); } catch (e) { console.error('Lifecycle: onCriticalBattery error:', e); }
        } else if (batteryPercent <= PlatformConstants.LOW_BATTERY_PERCENT && onLowBattery) {
          console.warn(`Lifecycle: Low battery level (${batteryPercent}%)`);
          try { await onLowBattery(batteryPercent); } catch (e) { console.error('Lifecycle: onLowBattery error:', e); }
        }
      } catch (error) {
        console.warn('Lifecycle: Battery check failed', error);
      }
    };

    // Initial check
    await checkBattery();

    // Periodic checks (every 60 seconds)
    batteryCheckInterval = setInterval(checkBattery, 60000);
  } catch (error) {
    console.warn('Lifecycle: Battery monitoring not available', error);
  }
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
