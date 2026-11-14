'use strict';

// Main-process failure reporting.
//
// Before this, only explicit Sentry calls and uncaught exceptions reached
// Sentry from main. Everything the main process merely logged — a failed
// finalization, a recording that could not be recovered — existed only in the
// user's local main.log, so a customer report could not be diagnosed without
// asking for that file. This module makes the log a reporting channel:
//   - a warning or error whose text is in REPORTED_LINES becomes a Sentry
//     event, at warning or error level;
//   - every other line becomes a breadcrumb with its level, so the next event
//     carries it as context. That is info and below, and every warning and
//     error that is not listed: lines of libraries that log through the same
//     logger (the updater), and any line added later.
//
// "Breadcrumb" is the default on purpose. An installed app cannot be called
// back, so a line that turns out to fire for every offline user must never
// have been an event in a released version. A line is reported only after its
// call site was read and it was put on the list.
//
// Four properties matter more than completeness here:
//   - it can never break the app: the hook body is wrapped, and a failure
//     inside reporting is swallowed after being disarmed;
//   - it can never loop: Sentry's own errors are logged, and logging must not
//     produce another event;
//   - one failure cannot flood the quota: identical messages are bounded per
//     session (the same power-of-two escalation the mobile client uses), so a
//     failure that repeats every second still reports its first occurrences
//     and then a logarithmic tail instead of thousands of events;
//   - one session cannot flood it either: this channel sends at most
//     MAX_EVENTS_PER_SESSION events per app session, whatever is logged. Past
//     that, lines are breadcrumbs only.

const path = require('path');

const LEVEL_LIMITS = { fatal: 8, error: 8, warning: 4, log: 2, info: 2, debug: 1 };
const MAX_EVENTS_PER_SESSION = 30;

// The log lines that become Sentry events. Each pattern is anchored to the
// constant text of exactly one log.warn / log.error call of the main process
// and is tested against the scrubbed line. A unit test reads the sources and
// fails when a pattern no longer matches exactly one call, so a reworded line
// cannot drop out of reporting unnoticed.
//
// Not listed, deliberately: lines whose code path sends its own Sentry event
// (they would be filed twice), and everything that is expected in normal use:
// no network, an expired sign-in, a failed update check, retries, a refused
// user action.
const REPORTED_LINES = [
  // A recording could not be saved, recovered or restored. The audio stays on
  // the computer, but the user has no recording until someone looks at it.
  /^Recording finalization failed; all source batches retained:/,
  /^Could not recover recording .+: /,
  /^Error processing directory .+ for recovery:/,
  /^Error recovering orphaned recordings:/,
  /^Error in recovery re-scan:/,
  /^Restore of .+ failed; originals retained:/,

  // A finished recording did not get into the upload queue, or the queue
  // itself could not run or keep its state: it would stay on the computer
  // without anyone noticing.
  /^recovery: enqueue failed:/,
  /^recovery: upload processing failed:/,
  /^restore: upload processing failed:/,
  /^Error processing pending uploads:/,
  /^Error processing pending uploads after login:/,
  /^Periodic upload retry failed:/,
  /^Error locking recording:/,
  /^Error unlocking recording:/,
  /^\[uploadDirect\] onSession callback threw:/,

  // The server did not keep an upload it had accepted.
  /^Server reported upload failed for .+:/,
  /^Server has not confirmed the recording \(404\); retaining local audio/,

  // What recovery and the history rely on could not be written or read:
  // crash and warning notes, the stream header, the recording's metadata.
  /^Failed to write crash metadata:/,
  /^Could not persist capture warning:/,
  /^Could not persist init segment:/,
  /^Could not parse existing metadata, creating new:/,
  /^Could not inspect raw session head:/,

  // System audio broke during a recording, or capture could not be stopped or
  // flushed when the window crashed, the computer went to sleep or the app quit.
  /^System audio capture failed:/,
  /^Failed to stop AudioTee after renderer crash:/,
  /^AudioTee suspend-stop failed:/,
  /^Suspend flush timed out after 3s/,
  /^Quit flush timed out after 2s \(reason: .+\)/,

  // Checks that are written never to fail.
  /^Binary health probe threw:/,
  /^Error checking disk space:/,

  // Sign-in answers the app cannot use, and a stored token of another account.
  /^CRITICAL SECURITY: Token user mismatch!/,
  /^SSO: failed to parse callback URL/,
  /^auth:register: answer without a token \(HTTP .+\)/,

  // A downloaded update cannot be installed.
  /^quitAndInstall failed:/,
  /^Update failed due to signature verification\. App needs code signing or manual reinstall\./,
];

// Lines whose code path already sends a richer Sentry event of its own. None
// of them is listed above; this second check keeps them breadcrumbs even if a
// pattern above ever matches one, so one failure is not filed twice.
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
    // Any scheme, not only http: the app's own sign-in link carries the token
    // and the account in its query.
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s"']+)\?[^\s"']*/gi, '$1?<redacted>')
    // A JSON parse error quotes the text it could not read, which can be a
    // recording's metadata (its title) or a sign-in answer.
    .replace(/, "[\s\S]*? is not valid JSON/g, ', <text> is not valid JSON');
}

// The Error behind a reported line travels with its stack. Its own text and
// the paths in its stack get the same scrubbing as the line: an error message
// can quote a file it could not read, and a stack names the user's folder.
function scrubbedError(error) {
  const copy = new Error(scrub(error.message));
  copy.name = error.name;
  if (error.stack) copy.stack = scrub(String(error.stack));
  if (error.code !== undefined) copy.code = error.code;
  return copy;
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
 * so this module stays unit-testable without Electron. `reported` is the list
 * of lines that become events, `maxEvents` the cap on events per session and
 * `limits` the per-line budget; tests lower them.
 */
function installLogReporting({
  log, Sentry, limits, maxEvents = MAX_EVENTS_PER_SESSION, isEnabled = () => true,
  reported = REPORTED_LINES, alreadyReported = ALREADY_REPORTED,
} = {}) {
  if (!log || !Sentry) throw new Error('Log reporting needs electron-log and Sentry');
  const sampler = createOccurrenceSampler(limits);
  let reporting = false; // re-entrancy guard: reporting must never report itself
  let disarmed = false;
  let eventsSent = 0;

  // electron-log calls every hook once per transport, as
  // hook(message, transportFunction, transportName). Act for the file
  // transport only, by its name: the function itself is called "transport"
  // for every transport, so it cannot tell them apart.
  const hook = (message, _transport, transportName) => {
    if (disarmed || transportName !== 'file') return message;
    if (reporting || !isEnabled()) return message;
    try {
      reporting = true;
      const level = String(message?.level || '').toLowerCase();
      const eventLevel = EVENT_LEVELS.get(level);
      if (!eventLevel && !BREADCRUMB_LEVELS.has(level)) return message;
      const { error, message: text } = describe(message?.data);
      if (!text) return message;
      const leaveBreadcrumb = () => Sentry.addBreadcrumb({
        category: 'main-log', level: eventLevel || (level === 'info' ? 'info' : 'debug'), message: text,
      });

      const listed = Boolean(eventLevel) && reported.some(pattern => pattern.test(text))
        && !alreadyReported.some(pattern => pattern.test(text));
      if (!listed) { leaveBreadcrumb(); return message; }

      const fingerprint = fingerprintOf(text);
      const decision = sampler.shouldReport(eventLevel, fingerprint);
      if (!decision.report || eventsSent >= maxEvents) { leaveBreadcrumb(); return message; }

      eventsSent += 1;
      const scopeFor = scope => {
        scope.setLevel(eventLevel);
        scope.setTag('source', 'main-log');
        scope.setFingerprint(['main-log', fingerprint]);
        scope.setExtra('logLine', text);
        scope.setExtra('occurrence', decision.occurrence);
        // Which event of this session it is: the last one before the cap says so.
        scope.setExtra('sessionEvent', `${eventsSent}/${maxEvents}`);
        if (message?.scope) scope.setTag('logScope', String(message.scope).slice(0, 60));
      };
      if (error) Sentry.withScope(scope => { scopeFor(scope); Sentry.captureException(scrubbedError(error)); });
      else Sentry.withScope(scope => { scopeFor(scope); Sentry.captureMessage(text, eventLevel); });
      // After its own event the line joins the trail, so a later event shows it.
      leaveBreadcrumb();
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
  return {
    hook, sampler, eventsSent: () => eventsSent,
    remove: () => { log.hooks = log.hooks.filter(entry => entry !== hook); },
  };
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

module.exports = {
  installLogReporting, installWindowReporting, createOccurrenceSampler, fingerprintOf, scrub, describe,
  REPORTED_LINES, MAX_EVENTS_PER_SESSION,
};
