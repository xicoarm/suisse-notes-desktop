/**
 * Sentry error tracking boot file
 * Loaded for both Capacitor (mobile) and Electron (desktop) builds via quasar.config.js
 *
 * - Capacitor: uses @sentry/capacitor wrapping @sentry/vue
 * - Electron renderer: uses @sentry/electron/renderer with Session Replay
 * - Desktop main process: initialized separately in electron-main.js
 *
 * Imports are dynamic to avoid resolution failures in environments
 * where platform-specific packages are not installed.
 */

import { isCapacitor, isElectron, getPlatform } from '../utils/platform';

let sentryInitialized = false;
let SentryModule = null;

/**
 * Add a breadcrumb (safe — no-op when Sentry is not initialized)
 */
export const addBreadcrumb = (breadcrumb) => {
  if (!sentryInitialized || !SentryModule) return;
  SentryModule.addBreadcrumb(breadcrumb);
};

/**
 * Capture an exception with optional context
 */
export const captureException = (error, context) => {
  if (!sentryInitialized || !SentryModule) return;
  SentryModule.captureException(error, context);
};

/**
 * Capture a message
 */
export const captureMessage = (message, level = 'info') => {
  if (!sentryInitialized || !SentryModule) return;
  SentryModule.captureMessage(message, level);
};

/**
 * Set user context (call after login, clear on logout)
 */
export const setUser = (user) => {
  if (!sentryInitialized || !SentryModule) return;
  if (user) {
    SentryModule.setUser({ id: user.id, email: user.email });
  } else {
    SentryModule.setUser(null);
  }
};

/**
 * P1 Fix: Set context for crash reports (e.g., active recording state)
 */
export const setContext = (name, context) => {
  if (!sentryInitialized || !SentryModule) return;
  SentryModule.setContext(name, context);
};

// Client-network failure modes that are almost always user-side rather than
// our bug or a backend outage. Downgraded to 'warning' so error-level alerts
// stop firing on user WiFi drops, while aggregate trends stay visible.
const TRANSIENT_NETWORK_CODES = new Set([
  'ENOTFOUND', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN'
]);
const TRANSIENT_NETWORK_STATUSES = new Set([408]);

function isTransientNetworkError(err, message) {
  if (err && TRANSIENT_NETWORK_CODES.has(err.code)) return true;
  if (err?.response?.status && TRANSIENT_NETWORK_STATUSES.has(err.response.status)) return true;
  if (typeof message === 'string') {
    if (/socket hang up/i.test(message)) return true;
    if (/network error/i.test(message)) return true;
    if (/getaddrinfo/i.test(message)) return true;
  }
  return false;
}

// Shared beforeSend to scrub auth tokens + downgrade transient network errors
function scrubSensitiveData(event, hint) {
  if (event.request?.headers?.authorization) {
    event.request.headers.authorization = '[REDACTED]';
  }
  if (event.breadcrumbs) {
    event.breadcrumbs.forEach(bc => {
      if (bc.data?.headers?.Authorization) {
        bc.data.headers.Authorization = '[REDACTED]';
      }
    });
  }
  const message = event.exception?.values?.[0]?.value || '';
  if (isTransientNetworkError(hint?.originalException, message)) {
    event.level = 'warning';
    event.tags = { ...(event.tags || {}), transient_network: 'true' };
  }
  return event;
}

// Shared beforeBreadcrumb filter
function filterBreadcrumbs(breadcrumb) {
  if (breadcrumb.category === 'console' && breadcrumb.level === 'log') {
    return null;
  }
  return breadcrumb;
}

/**
 * Initialize Sentry for Electron desktop renderer
 */
async function initElectronRenderer(app, router) {
  // Desktop renderer uses the same DSN as electron-main.js
  const dsn = 'https://185912b1585eb5138079ae189a6d41ec@o4510659364716544.ingest.de.sentry.io/4510659366748240';

  let appVersion = 'unknown';
  try {
    appVersion = await window.electronAPI?.app?.getVersion?.() || 'unknown';
  } catch (e) {
    console.warn('Sentry: Could not get app version', e);
  }

  try {
    // Use @sentry/vue directly — sends events via HTTPS to Sentry ingest
    // (@sentry/electron/renderer uses sentry-ipc: protocol which fails with contextIsolation)
    const SentryVue = await import('@sentry/vue');
    SentryModule = SentryVue;

    SentryVue.init({
      app,
      dsn,
      environment: import.meta.env.DEV ? 'development' : 'production',
      release: `suisse-notes@${appVersion}`,
      autoSessionTracking: false,
      sendClientReports: false,
      integrations: [
        SentryVue.vueIntegration({
          app,
          attachProps: true,
          logErrors: true,
          trackComponents: true,
        }),
        SentryVue.browserTracingIntegration({ router }),
        SentryVue.replayIntegration({
          maskAllText: false,
          maskAllInputs: true,
          blockAllMedia: false,
          networkDetailAllowUrls: [/suisse-notes\.ch/],
          networkCaptureBodies: false,
        }),
      ],
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
      beforeSend: scrubSensitiveData,
      beforeBreadcrumb: filterBreadcrumbs,
    });

    sentryInitialized = true;

    SentryVue.setTag('platform', 'electron');
    SentryVue.setTag('app.version', appVersion);
    SentryVue.setTag('process', 'renderer');

    console.log(`Sentry: Initialized desktop renderer (v${appVersion}) with Session Replay`);
  } catch (error) {
    console.error('Sentry: Failed to initialize desktop renderer', error);
  }
}

/**
 * Initialize Sentry for Capacitor (mobile)
 */
async function initCapacitor(app, router) {
  const dsn = 'https://f5f1d2b53d297a64e9b76ca26d2d8397@o4510659364716544.ingest.de.sentry.io/4510958727462992';

  let appVersion = 'unknown';
  try {
    const { App: CapApp } = await import('@capacitor/app');
    const appInfo = await CapApp.getInfo();
    appVersion = appInfo.version || 'unknown';
  } catch (e) {
    console.warn('Sentry: Could not get app version', e);
  }

  const platform = getPlatform();

  try {
    const SentryVue = await import('@sentry/vue');
    SentryModule = SentryVue;

    // Use @sentry/vue directly. The @sentry/capacitor 2.4.1 wrapper appeared
    // to silently drop captureMessage / captureException events when the app
    // was built with the iOS 26 SDK on macos-26 — transactions still arrived
    // (those go through pure-JS browserTracingIntegration) but errors and
    // info messages did not. Going through @sentry/vue directly means
    // straight HTTPS to the ingest endpoint, no native bridge. We had
    // enableNative: false already, so we weren't relying on native crash
    // capture anyway. Tag dist explicitly so iOS/Android filtering still
    // works.
    SentryVue.init({
      app,
      dsn,
      environment: import.meta.env.DEV ? 'development' : 'production',
      release: `ch.suissenotes.mobile@${appVersion}`,
      dist: platform,
      integrations: [
        SentryVue.vueIntegration({ app, attachProps: true, logErrors: true, trackComponents: true }),
        SentryVue.browserTracingIntegration({ router }),
      ],
      tracesSampleRate: 0.1,
      beforeSend: scrubSensitiveData,
      beforeBreadcrumb: filterBreadcrumbs,
    });

    sentryInitialized = true;

    SentryVue.setTag('platform', platform);
    SentryVue.setTag('app.version', appVersion);
    SentryVue.setTag('dist', platform);

    console.log(`Sentry: Initialized for ${platform} (v${appVersion}) via @sentry/vue`);
  } catch (error) {
    console.error('Sentry: Failed to initialize', error);
  }
}

export default async ({ app, router }) => {
  if (isElectron()) {
    await initElectronRenderer(app, router);
  } else if (isCapacitor()) {
    await initCapacitor(app, router);
  }
  // Web / test environments: no-op (all exported functions remain safe no-ops)
};
