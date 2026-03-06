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

// Shared beforeSend to scrub auth tokens
function scrubSensitiveData(event) {
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
    // @sentry/electron/renderer provides init + IPC bridge to main process
    // @sentry/vue provides Vue-specific integrations (vueIntegration, etc.)
    const SentryElectron = await import('@sentry/electron/renderer');
    const SentryVue = await import('@sentry/vue');
    SentryModule = SentryElectron;

    SentryElectron.init({
      app,
      dsn,
      environment: import.meta.env.DEV ? 'development' : 'production',
      release: `suisse-notes@${appVersion}`,
      // Let main process handle sessions — avoid double-counting
      autoSessionTracking: false,
      sendClientReports: false,
      integrations: [
        // Bridge renderer scope to main process via Electron IPC
        SentryElectron.scopeToMainIntegration(),
        // Vue-specific error tracking
        SentryVue.vueIntegration({
          app,
          attachProps: true,
          logErrors: true,
          trackComponents: true,
        }),
        // Navigation / network performance
        SentryVue.browserTracingIntegration({ router }),
        // Session Replay — DOM-based replay of user interactions
        SentryVue.replayIntegration({
          maskAllText: false,
          maskAllInputs: true,
          blockAllMedia: false,
          networkDetailAllowUrls: [/suisse-notes\.ch/],
          networkCaptureBodies: false,
        }),
      ],
      // Sample 10% of transactions for performance
      tracesSampleRate: 0.1,
      // Session Replay sample rates
      replaysSessionSampleRate: 0.1,   // 10% of normal sessions
      replaysOnErrorSampleRate: 1.0,   // 100% of sessions with errors
      beforeSend: scrubSensitiveData,
      beforeBreadcrumb: filterBreadcrumbs,
    });

    sentryInitialized = true;

    SentryElectron.setTag('platform', 'electron');
    SentryElectron.setTag('app.version', appVersion);

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
    const SentryCapacitor = await import('@sentry/capacitor');
    SentryModule = SentryVue;

    SentryCapacitor.init(
      {
        app,
        dsn,
        environment: import.meta.env.DEV ? 'development' : 'production',
        release: `ch.suissenotes.mobile@${appVersion}`,
        dist: platform,
        enableNative: false,
        enableNativeCrashHandling: false,
        integrations: [
          SentryVue.vueIntegration({
            app,
            attachProps: true,
            logErrors: true,
            trackComponents: true,
          }),
          SentryVue.browserTracingIntegration({ router }),
        ],
        tracesSampleRate: 0.1,
        beforeSend: scrubSensitiveData,
        beforeBreadcrumb: filterBreadcrumbs,
      },
      SentryVue.init
    );

    sentryInitialized = true;

    SentryVue.setTag('platform', platform);
    SentryVue.setTag('app.version', appVersion);

    console.log(`Sentry: Initialized for ${platform} (v${appVersion})`);
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
