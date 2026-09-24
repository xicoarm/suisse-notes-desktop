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
import { redactSecrets } from '../utils/redact';
import {
  HTTP_CAPTURE_STATUS_CODES,
  createEarlyErrorBuffer,
  createOccurrenceSampler,
  errorDetails,
  sanitizeConsoleArguments,
  treatHttpClientAsHandled
} from '../utils/sentryCapture';
import { startSessionHealth, noteSessionActivity } from '../services/sessionHealth';

let sentryInitialized = false;
let SentryModule = null;

// Mobile: errors thrown while the app is still starting (module evaluation,
// the boot files, the async SDK import) happen before Sentry's own global
// handlers exist. Buffer them from the first moment this module is evaluated
// and replay them right after init.
// The desktop renderer starts the same way, and its boot failures (a preload
// that did not expose electronAPI, a store that throws while restoring) used to
// be lost as well.
const earlyErrors = (typeof window !== 'undefined' &&
  (window.Capacitor?.isNativePlatform?.() || !!window.electronAPI))
  ? createEarlyErrorBuffer(window)
  : null;

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
 * @param {string} message
 * @param {string} [level]
 * @param {Object} [context] - extra capture context (fingerprint, tags, extra)
 */
export const captureMessage = (message, level = 'info', context = null) => {
  if (!sentryInitialized || !SentryModule) return;
  SentryModule.captureMessage(message, context ? { ...context, level } : level);
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
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true;
  const errMessage = err?.message || '';
  const text = `${typeof message === 'string' ? message : ''} ${errMessage}`;
  if (/failed to fetch/i.test(text)) return true;
  if (/load failed/i.test(text)) return true;
  if (/network error/i.test(text)) return true;
  if (/socket hang up/i.test(text)) return true;
  if (/getaddrinfo/i.test(text)) return true;
  return false;
}

// Shared beforeSend to scrub auth tokens + downgrade transient network errors
function scrubSensitiveData(event, hint) {
  if (event.request?.headers?.authorization) {
    event.request.headers.authorization = '[REDACTED]';
  }
  if (event.request?.url) {
    event.request.url = redactSecrets(event.request.url);
  }
  // Free-text surfaces that have carried the SSO callback URL (and with it the
  // session JWT) in the past: message, exception values, breadcrumb messages
  // and breadcrumb URLs. Redact secret query values and bare JWTs everywhere.
  if (typeof event.message === 'string') {
    event.message = redactSecrets(event.message);
  }
  if (event.logentry?.message) {
    event.logentry.message = redactSecrets(event.logentry.message);
  }
  if (event.exception?.values) {
    event.exception.values.forEach(v => {
      if (typeof v.value === 'string') v.value = redactSecrets(v.value);
    });
  }
  if (event.breadcrumbs) {
    event.breadcrumbs.forEach(bc => {
      if (bc.data?.headers?.Authorization) {
        bc.data.headers.Authorization = '[REDACTED]';
      }
      if (typeof bc.message === 'string') bc.message = redactSecrets(bc.message);
      if (typeof bc.data?.url === 'string') bc.data.url = redactSecrets(bc.data.url);
      if (typeof bc.data?.to === 'string') bc.data.to = redactSecrets(bc.data.to);
      if (typeof bc.data?.from === 'string') bc.data.from = redactSecrets(bc.data.from);
    });
  }
  const message = event.exception?.values?.[0]?.value || event.message || event.logentry?.message || '';
  if (isTransientNetworkError(hint?.originalException, message)) {
    event.level = 'warning';
    event.tags = { ...(event.tags || {}), transient_network: 'true' };
  }
  return event;
}

export { scrubSensitiveData };

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
  if (window.electronAPI?.isE2E) return; // Synthetic faults are retained in local test logs.
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
    const sampler = createOccurrenceSampler();

    // E2E runs drive the packaged app (import.meta.env.DEV === false), so without
    // this guard the synthetic mic-health/recovery/crash telemetry the renderer
    // emits would tag `production` and masquerade as real-user incidents. The
    // preload exposes isE2E (from SUISSE_E2E_HOOKS) — route those to `e2e`.
    const rendererEnvironment = window.electronAPI?.isE2E
      ? 'e2e'
      : (import.meta.env.DEV ? 'development' : 'production');

    SentryVue.init({
      app,
      dsn,
      environment: rendererEnvironment,
      release: `suisse-notes@${appVersion}`,
      // Sessions come from the main process (@sentry/electron/main tracks the
      // app session); a second session per renderer would distort crash-free
      // rates. Client reports stay on: they are free and show what the SDK
      // itself dropped.
      autoSessionTracking: false,
      sendClientReports: true,
      maxBreadcrumbs: 200,
      integrations: [
        SentryVue.vueIntegration({
          app,
          attachProps: true,
          logErrors: true,
          trackComponents: true,
        }),
        SentryVue.browserTracingIntegration({ router }),
        // The desktop UI reports its handled failures the same way the mobile
        // app does: every console.error and console.warn call site becomes an
        // event (sampled per session), and failed HTTP answers are captured.
        // Without this, a failed recording start, a refused IPC call or a
        // dropped upload retry existed only in the user's DevTools console.
        SentryVue.captureConsoleIntegration({ levels: ['error', 'warn'] }),
        SentryVue.httpClientIntegration({ failedRequestStatusCodes: HTTP_CAPTURE_STATUS_CODES }),
        // The default ignore list silently dropped bridge errors; the mobile
        // client removed it for the same reason.
        SentryVue.eventFiltersIntegration({ disableErrorDefaults: true }),
        SentryVue.replayIntegration({
          maskAllText: false,
          maskAllInputs: true,
          blockAllMedia: false,
          networkDetailAllowUrls: [/suisse-(notes|meets)\.ch/],
          networkCaptureBodies: false,
        }),
      ],
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
      beforeSend: (event, hint) => appBeforeSend(event, hint, sampler),
      beforeBreadcrumb: filterBreadcrumbs,
    });

    sentryInitialized = true;

    SentryVue.setTag('platform', 'electron');
    SentryVue.setTag('app.version', appVersion);
    SentryVue.setTag('process', 'renderer');

    // Errors raised before init, in the order they happened.
    earlyErrors?.drain(({ kind, error }) => {
      SentryVue.captureException(error ?? new Error(`${kind} before Sentry init (no reason)`), {
        tags: { phase: 'boot', early_error: kind }
      });
    });

    // A lazy route chunk that fails to load after an update leaves a blank
    // window and never reaches Vue's error handler.
    router?.onError?.((err) => {
      SentryVue.captureException(err, { tags: { source: 'router' } });
    });

    console.log(`Sentry: Initialized desktop renderer (v${appVersion}) with Session Replay`);
  } catch (error) {
    console.error('Sentry: Failed to initialize desktop renderer', error);
  }
}

/**
 * beforeSend for app events on both platforms: scrub secrets, keep failed HTTP
 * answers out of the crash-free-session statistics, attach whitelisted error
 * details and apply the per-session occurrence sampling.
 */
export function appBeforeSend(event, hint, sampler) {
  const scrubbed = scrubSensitiveData(event, hint);
  if (!scrubbed) return null;
  treatHttpClientAsHandled(scrubbed);
  sanitizeConsoleArguments(scrubbed);
  const details = errorDetails(hint?.originalException);
  if (details) {
    scrubbed.contexts = { ...(scrubbed.contexts || {}), error_details: details };
    if (details.code !== undefined) scrubbed.tags = { ...(scrubbed.tags || {}), error_code: String(details.code) };
  }
  return sampler ? sampler(scrubbed) : scrubbed;
}

/**
 * Initialize Sentry for Capacitor (mobile)
 *
 * Capture policy (docs/MOBILE_RELEASE_GUIDE.md, "Sentry capture"):
 * - uncaught errors, unhandled rejections, Vue and router errors;
 * - every console.error AND console.warn call (the app logs its handled
 *   failures there) — sampled per session so a loop cannot flood the project;
 * - failed HTTP answers (400-599 except 401/402/409);
 * - errors raised before init (buffered) and sessions that died on screen
 *   (native crash / WebView kill / out-of-memory, see services/sessionHealth);
 * - events raised offline are stored in IndexedDB and sent when the phone is
 *   back online (until 3.9.37 they were dropped: ~5 per day in Sentry's
 *   client-report statistics);
 * - no default ignore patterns (they silently dropped Android bridge errors
 *   such as "Java exception was raised during method invocation").
 */
async function initCapacitor(app, router) {
  const dsn = 'https://f5f1d2b53d297a64e9b76ca26d2d8397@o4510659364716544.ingest.de.sentry.io/4510958727462992';
  const platform = getPlatform();

  // The release comes from the build (Android versionName, which the iOS
  // MARKETING_VERSION follows in lock-step — the same value the source maps
  // are uploaded under), so init never waits on a native call. Builds without
  // the constant (dev, unit tests) fall back to the native version.
  // Literal `process.env.MOBILE_APP_VERSION`: the build replaces this exact
  // expression (there is no `process` object at runtime — optional chaining or
  // a typeof guard would silently fall back to the native version).
  const buildVersion = process.env.MOBILE_APP_VERSION || '';
  let appVersion = buildVersion || 'unknown';
  if (!buildVersion) {
    try {
      const { App: CapApp } = await import('@capacitor/app');
      const appInfo = await CapApp.getInfo();
      appVersion = appInfo.version || 'unknown';
    } catch (e) {
      console.warn('Sentry: Could not get app version', e);
    }
  }

  try {
    const SentryVue = await import('@sentry/vue');
    SentryModule = SentryVue;
    const sampler = createOccurrenceSampler();

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
      sampleRate: 1.0,
      // attachStacktrace stays off on purpose: with it, message events are
      // grouped by call site instead of by text, which merges distinct
      // problems logged from one helper into a single issue.
      maxBreadcrumbs: 100,
      transport: SentryVue.makeBrowserOfflineTransport(SentryVue.makeFetchTransport),
      transportOptions: { dbName: 'suisse-sentry-offline', maxQueueSize: 100, flushAtStartup: true },
      integrations: [
        SentryVue.vueIntegration({ app, attachProps: true, logErrors: true, trackComponents: true }),
        SentryVue.browserTracingIntegration({ router }),
        SentryVue.captureConsoleIntegration({ levels: ['error', 'warn'] }),
        SentryVue.httpClientIntegration({ failedRequestStatusCodes: HTTP_CAPTURE_STATUS_CODES }),
        SentryVue.eventFiltersIntegration({ disableErrorDefaults: true }),
      ],
      tracesSampleRate: 0.1,
      beforeSend: (event, hint) => appBeforeSend(event, hint, sampler),
      beforeBreadcrumb: filterBreadcrumbs,
    });

    sentryInitialized = true;

    SentryVue.setTag('platform', platform);
    SentryVue.setTag('app.version', appVersion);
    SentryVue.setTag('dist', platform);

    // Errors raised before init, in the order they happened.
    earlyErrors?.drain(({ kind, error }) => {
      SentryVue.captureException(error ?? new Error(`${kind} before Sentry init (no reason)`), {
        tags: { phase: 'boot', early_error: kind }
      });
    });

    // Lazy-loaded route chunks that fail to load never reach Vue's error handler.
    router?.onError?.((err) => {
      SentryVue.captureException(err, { tags: { source: 'router' } });
    });
    router?.afterEach?.((to) => {
      noteSessionActivity({ route: to?.name || to?.matched?.[to.matched.length - 1]?.path || null });
    });

    // Cross-check the build constant against the installed native version.
    if (buildVersion) {
      import('@capacitor/app')
        .then(({ App: CapApp }) => CapApp.getInfo())
        .then((info) => {
          const nativeVersion = info?.version || 'unknown';
          SentryVue.setTag('native.version', nativeVersion);
          SentryVue.setTag('native.build', String(info?.build || 'unknown'));
          if (nativeVersion !== 'unknown' && nativeVersion !== buildVersion) {
            SentryVue.captureMessage(`sentry: bundle version ${buildVersion} differs from native version ${nativeVersion}`, 'warning');
          }
        })
        .catch((e) => console.warn('Sentry: Could not read native app version', e?.message || e));
    }

    // A previous session that died on screen (native crash, WebView kill,
    // out-of-memory, watchdog) is reported once, with what it was doing.
    let isActive = true;
    try {
      const { App: CapApp } = await import('@capacitor/app');
      isActive = (await CapApp.getState())?.isActive !== false;
    } catch { /* assume foreground */ }
    startSessionHealth({
      appVersion,
      platform,
      isActive,
      report: (previous) => {
        SentryVue.captureMessage('app: previous session ended unexpectedly while on screen (native crash, WebView termination, out-of-memory or watchdog kill)', {
          level: 'error',
          fingerprint: ['unclean-exit', platform],
          tags: {
            unclean_exit: 'true',
            'previous.app_version': previous.appVersion,
            'previous.recording': String(previous.recording),
            'previous.ble_sync': String(previous.bleSync)
          },
          contexts: { previous_session: previous }
        });
      }
    }).catch((e) => console.warn('Sentry: session health tracking unavailable', e?.message || e));

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
