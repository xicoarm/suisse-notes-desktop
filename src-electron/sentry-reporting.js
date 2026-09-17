'use strict';

// Main-process failure reporting.
//
// Before this, only explicit Sentry calls and uncaught exceptions reached
// Sentry from main. Everything the main process merely logged — an AudioTee
// error, a failed finalization, a refused IPC request, a killed child process —
// existed only in the user's local main.log, so a customer report could not be
// diagnosed without asking for that file. This module turns the log itself into
// the reporting channel: every error the main process writes becomes a Sentry
// event, warnings become events at warning level, and the surrounding info
// lines become breadcrumbs so an event carries its context.
//
// Three properties matter more than completeness here:
//   - it can never break the app: every hook body is wrapped, and a failure
//     inside reporting is swallowed after being disarmed;
//   - it can never loop: Sentry's own errors are logged, and logging must not
//     produce another event;
//   - it can never flood the quota: identical messages are bounded per session
//     (the same power-of-two escalation the mobile client uses), so a failure
//     that repeats every second still reports its first occurrences and then
//     a logarithmic tail instead of thousands of events.

const path = require('path');

const LEVEL_LIMITS = { fatal: 8, error: 8, warning: 4, log: 2, info: 2, debug: 1 };
// Lines whose code path already sends a richer Sentry event of its own. They
// stay breadcrumbs here so one failure is not filed twice.
const ALREADY_REPORTED = [
  /^Uncaught Exception/i, /^Unhandled Rejection/i,
  /^Renderer process gone/i, /^Child process gone/i,
  /operation timed out/i, /stderr silent for/i,
];
const BREADCRUMB_LEVELS = new Set(['info', 'log', 'verbose', 'debug', 'silly']);
const EVENT_LEVELS = new Map([['error', 'error'], ['warn', 'warning']]);
const MAX_MESSAGE = 900;

// A log line identifies its failure by its constant text: strip the parts that
// differ per occurrence (ids, paths, numbers, quoted device names) so repeats
// of the same failure group and count together.
function fingerprintOf(text) {
  return String(text)
    .replace(/[A-Za-z]:\\[^\s"']+|\/(?:Users|home)\/[^\s"']+/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    // Every number is per-occurrence detail: sizes, durations, chunk indices,
    // status codes. "chunk_3610" and "chunk_3611" are the same failure.
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

// Local paths, mail addresses and credentials are diagnostics only when they
// are not personal data. Which directory a file lives in matters for triage,
// the account name behind it does not — so only the user name is replaced.
function scrub(text) {
  return String(text)
    .replace(/([A-Za-z]:\\Users\\)[^\\/"'\s]+/gi, '$1<user>')
    .replace(/(\/(?:Users|home)\/)[^/"'\s]+/g, '$1<user>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/(Bearer|token|password|secret|sas|sig)[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/(https?:\/\/[^\s"']+)\?[^\s"']*/g, '$1?<redacted>');
}

function textOf(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

// electron-log passes the original console arguments; keep the error object so
// Sentry gets its stack, and keep the readable line for the title.
function describe(data) {
  const parts = Array.isArray(data) ? data : [data];
  const error = parts.find(part => part instanceof Error) || null;
  const message = scrub(parts.map(textOf).join(' ')).slice(0, MAX_MESSAGE);
  return { error, message };
}

function createOccurrenceSampler(limits = LEVEL_LIMITS) {
  const counts = new Map();
  return {
    shouldReport(level, fingerprint) {
      const key = `${level}|${fingerprint}`;
      const seen = (counts.get(key) || 0) + 1;
      counts.set(key, seen);
      const limit = limits[level] ?? 2;
      if (seen <= limit) return { report: true, occurrence: seen };
      // Past the limit keep only powers of two: the 16th, 32nd, 64th … so a
      // looping failure stays visible without filling the quota.
      const powerOfTwo = (seen & (seen - 1)) === 0;
      return { report: powerOfTwo, occurrence: seen };
    },
    counts,
  };
}

/**
 * Turn main-process logging into Sentry reporting.
 *
 * `log` is electron-log, `Sentry` is @sentry/electron/main. Both are injected
 * so this module stays unit-testable without Electron.
 */
function installLogReporting({ log, Sentry, limits, isEnabled = () => true, alreadyReported = ALREADY_REPORTED } = {}) {
  if (!log || !Sentry) throw new Error('Log reporting needs electron-log and Sentry');
  const sampler = createOccurrenceSampler(limits);
  let reporting = false; // re-entrancy guard: reporting must never report itself
  let disarmed = false;

  const hook = (message, transport) => {
    // electron-log runs hooks once per transport; act on one of them only.
    if (disarmed || !transport || transport.name !== 'file') return message;
    if (reporting || !isEnabled()) return message;
    try {
      reporting = true;
      const level = String(message?.level || '').toLowerCase();
      const { error, message: text } = describe(message?.data);
      if (!text) return message;
      if (BREADCRUMB_LEVELS.has(level)) {
        Sentry.addBreadcrumb({ category: 'main-log', level: level === 'info' ? 'info' : 'debug', message: text });
        return message;
      }
      const eventLevel = EVENT_LEVELS.get(level);
      if (!eventLevel) return message;
      if (alreadyReported.some(pattern => pattern.test(text))) {
        Sentry.addBreadcrumb({ category: 'main-log', level: eventLevel, message: text });
        return message;
      }
      const fingerprint = fingerprintOf(text);
      const decision = sampler.shouldReport(eventLevel, fingerprint);
      if (!decision.report) return message;
      const scopeFor = scope => {
        scope.setLevel(eventLevel);
        scope.setTag('source', 'main-log');
        scope.setFingerprint(['main-log', fingerprint]);
        scope.setExtra('logLine', text);
        scope.setExtra('occurrence', decision.occurrence);
        if (message?.scope) scope.setTag('logScope', String(message.scope).slice(0, 60));
      };
      if (error) Sentry.withScope(scope => { scopeFor(scope); Sentry.captureException(error); });
      else Sentry.withScope(scope => { scopeFor(scope); Sentry.captureMessage(text, eventLevel); });
    } catch (failure) {
      // Reporting must never take the app down, and a broken hook must not run
      // on every log line for the rest of the session.
      disarmed = true;
      try { console.error('Sentry log reporting disabled after an error:', failure?.message); } catch (_) { /* ignore */ }
    } finally {
      reporting = false;
    }
    return message;
  };

  log.hooks.push(hook);
  return { hook, sampler, remove: () => { log.hooks = log.hooks.filter(entry => entry !== hook); } };
}

/**
 * Report the window-level failures Electron surfaces as events rather than
 * exceptions: a window that stops answering (a hung renderer during a meeting
 * looks exactly like a working one from main), a preload that fails to load,
 * and a renderer document that never loads. Crashes of the renderer and of
 * Chromium's child processes are reported by their own handlers in
 * electron-main.js, which carry recording state this module does not have.
 */
function installWindowReporting({ Sentry, log = null } = {}) {
  if (!Sentry) throw new Error('Window reporting needs Sentry');
  const report = (title, level, extra) => {
    try {
      Sentry.withScope(scope => {
        scope.setLevel(level);
        scope.setTag('source', 'process');
        scope.setFingerprint(['process', title]);
        for (const [key, value] of Object.entries(extra || {})) scope.setExtra(key, value);
        Sentry.captureMessage(title, level);
      });
      log?.error?.(`${title}: ${JSON.stringify(extra || {})}`);
    } catch (_) { /* reporting is best effort */ }
  };

  const attachWindow = (window, { isRecording = () => false } = {}) => {
    if (!window || window.isDestroyed?.()) return;
    let unresponsiveSince = null;
    window.on('unresponsive', () => {
      unresponsiveSince = Date.now();
      report('window unresponsive', 'error', { recording: isRecording() });
    });
    window.on('responsive', () => {
      if (unresponsiveSince === null) return;
      const seconds = Math.round((Date.now() - unresponsiveSince) / 1000);
      unresponsiveSince = null;
      report('window responsive again', 'warning', { unresponsiveSeconds: seconds, recording: isRecording() });
    });
    window.webContents?.on?.('preload-error', (_event, preloadPath, error) => {
      report('preload script failed', 'fatal', { preload: path.basename(String(preloadPath || '')), message: scrub(error?.message || '') });
    });
    window.webContents?.on?.('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // -3 is an aborted navigation
      report(`app window failed to load: ${errorDescription || errorCode}`, 'fatal',
        { errorCode, url: scrub(String(validatedURL || '')) });
    });
  };

  return { report, attachWindow };
}

module.exports = { installLogReporting, installWindowReporting, createOccurrenceSampler, fingerprintOf, scrub, describe };
