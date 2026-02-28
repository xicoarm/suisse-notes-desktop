/**
 * Sentry error tracking boot file
 * Loaded only on Capacitor (mobile) builds via quasar.config.js
 * Native crash reporting requires Capacitor 7 upgrade
 * Desktop uses @sentry/electron initialized in electron-main.js
 *
 * Imports are dynamic to avoid resolution failures in test/desktop environments
 * where @sentry/capacitor is not installed in root node_modules.
 */

import { isCapacitor, getPlatform } from '../utils/platform';

let sentryInitialized = false;
let SentryVue = null;

/**
 * Add a breadcrumb (safe — no-op when Sentry is not initialized)
 */
export const addBreadcrumb = (breadcrumb) => {
  if (!sentryInitialized || !SentryVue) return;
  SentryVue.addBreadcrumb(breadcrumb);
};

/**
 * Capture an exception with optional context
 */
export const captureException = (error, context) => {
  if (!sentryInitialized || !SentryVue) return;
  SentryVue.captureException(error, context);
};

/**
 * Capture a message
 */
export const captureMessage = (message, level = 'info') => {
  if (!sentryInitialized || !SentryVue) return;
  SentryVue.captureMessage(message, level);
};

/**
 * Set user context (call after login, clear on logout)
 */
export const setUser = (user) => {
  if (!sentryInitialized || !SentryVue) return;
  if (user) {
    SentryVue.setUser({ id: user.id, email: user.email });
  } else {
    SentryVue.setUser(null);
  }
};

export default async ({ app, router }) => {
  if (!isCapacitor()) {
    return;
  }

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
    // Dynamic imports — these packages are only available in Capacitor builds
    SentryVue = await import('@sentry/vue');
    const SentryCapacitor = await import('@sentry/capacitor');

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
        beforeSend(event) {
          // Scrub auth tokens from request headers
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
        },
        beforeBreadcrumb(breadcrumb) {
          // Filter out noisy console.log breadcrumbs
          if (breadcrumb.category === 'console' && breadcrumb.level === 'log') {
            return null;
          }
          return breadcrumb;
        },
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
};
