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
// Five properties matter more than completeness here:
//   - it can never break the app: the hook body is wrapped, and a failure
//     inside reporting is swallowed after being disarmed;
//   - it can never loop: Sentry's own errors are logged, and logging must not
//     produce another event;
//   - one failure cannot flood the quota: a listed line is one failure,
//     whatever its variable text says, and is bounded per session (the same
//     power-of-two escalation the mobile client uses), so a failure that
//     repeats every second still reports its first occurrences and then a
//     logarithmic tail instead of thousands of events;
//   - one session cannot flood it either: this channel sends at most
//     MAX_EVENTS_PER_SESSION events per app session, whatever is logged;
//   - restarting does not refill it: with a store for the budget, an
//     installation sends at most MAX_EVENTS_PER_LINE_PER_DAY events per listed
//     line and MAX_EVENTS_PER_DAY in total per day, across launches. A failure
//     that repeats at every start, or one that hits every installation at
//     once, stays a handful of events.
// Past any of these limits a line is a breadcrumb only.

const os = require('os');
const path = require('path');

const LEVEL_LIMITS = { fatal: 8, error: 8, warning: 4, log: 2, info: 2, debug: 1 };
const MAX_EVENTS_PER_SESSION = 30;
const MAX_EVENTS_PER_LINE_PER_DAY = 3;
const MAX_EVENTS_PER_DAY = 30;

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
// Scrubbing runs on at most this much text, so its patterns cannot run long on
// a huge line and the cut to MAX_MESSAGE never splits something they replace.
const MAX_SCRUB_INPUT = 4000;

function homeDirectory() {
  try { return os.homedir(); } catch (_) { return ''; }
}
function osUserName() {
  try { return os.userInfo().username; } catch (_) { return ''; }
}
const HOME_DIRECTORY = homeDirectory();
const USER_NAME = osUserName();

// What must follow a folder or a name for it to be that one and not a longer
// sibling: a separator, a double quote, a line end or the end of the text.
// Without it, home "C:\Users\Hans" would turn "C:\Users\Hans Muster" into
// "C:\Users\<user> Muster" and keep the general rule below from taking it whole.
// A single quote ends a path too: Node quotes the path of a failed file call (rmdir '...').
const PATH_END = '(?=[\\\\/"\'\\r\\n]|$)';
const literally = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MATCHES_NOTHING = /(?!)/g;

// The places that carry the user's name, as patterns:
//   - the home directory: its last part becomes <user>;
//   - the folders the app is given (userData, appData, documents, downloads,
//     temp): with a redirected AppData or Documents they lie outside the home
//     directory, on a share that is named after the user. Each becomes its
//     name in angle brackets, the rest of the path stays;
//   - any part of a path that is the operating system's user name.
// A folder is matched in the three ways a log line spells it: as it is, with
// every backslash doubled (a path inside a logged object) and with forward
// slashes; the longest first, because userData lies inside appData. The
// patterns are rebuilt only when one of the places changed.
const compiled = source => {
  try { return new RegExp(source, 'giu'); } catch (_) { return null; /* a name no pattern can hold */ }
};
let placePatternsFor = { key: null, patterns: null };
function placePatterns(homeDir, userName, folders) {
  const named = folders && typeof folders === 'object' ? Object.entries(folders) : [];
  const key = [homeDir, userName, ...named.map(([name, folder]) => `${name}=${folder}`)].join('\n');
  if (placePatternsFor.key === key) return placePatternsFor.patterns;
  const literals = [];
  const add = (folder, placeholder) => {
    const plain = typeof folder === 'string' ? folder.replace(/[\\/]+$/, '') : '';
    if (Math.max(plain.lastIndexOf('\\'), plain.lastIndexOf('/')) < 0) return;
    for (const form of new Set([plain, plain.replace(/\\/g, '\\\\'), plain.replace(/\\/g, '/')])) {
      literals.push({ form, put: placeholder(form) });
    }
  };
  add(homeDir, form => `${form.slice(0, Math.max(form.lastIndexOf('\\'), form.lastIndexOf('/')) + 1)}<user>`);
  for (const [name, folder] of named) add(folder, () => `<${name}>`);
  literals.sort((a, b) => b.form.length - a.form.length);
  const places = literals
    .map(({ form, put }) => ({ find: compiled(literally(form) + PATH_END), put }))
    .filter(({ find }) => find);
  // Only a whole part of a path, never the start of a longer one ("hmuster2").
  // It runs after the general profile rules, so a user called "Users" or
  // "home" cannot hide the profile folder behind it from them.
  const name = typeof userName === 'string' ? userName : '';
  const userNamePattern = name.length > 1 ? compiled(`(?<=[\\\\/])${literally(name)}${PATH_END}`) : null;
  placePatternsFor = { key, patterns: { places, userName: userNamePattern } };
  return placePatternsFor.patterns;
}

// A value of these keys in a logged object is a credential. (The look-behinds
// here and below only keep the patterns from retrying inside one long run.)
const SECRET_VALUE = /((?<!\\)\\*"(access_token|refresh_token|token|password|secret|authorization|code)\\*"\s*:\s*)(\\*"(?:\\.|[^"\\])*"?|[^\s,}\]"\\]+)/gi;
// "code" is also where errors carry "ECONNRESET", "invalid_code" or 404: that
// is the diagnosis, not a sign-in code, and stays.
const PLAIN_CODE = /^(?:[A-Z][A-Z0-9_]{1,39}|[a-z_]{1,40}|\d{3})$/;
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu;
const LINK = /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'?#]*)(\?[^\s"'#]*)?(#[^\s"']*)?/gi;

// Local paths, mail addresses and credentials are diagnostics only when they
// are not personal data. Which directory a file lives in matters for triage,
// the account name behind it does not — so only the user name is replaced.
// Where a rule cannot know where a name ends it takes too much rather than
// too little: a profile folder may be "Hans Muster".
function scrub(text, homeDir = HOME_DIRECTORY, { userName = USER_NAME, folders = null } = {}) {
  const patterns = placePatterns(homeDir, userName, folders);
  let result = String(text).slice(0, MAX_SCRUB_INPUT);
  for (const { find, put } of patterns.places) result = result.replace(find, () => put);
  return result
    // Any other profile folder. The name runs to the next separator, double
    // quote or line end, with its spaces and apostrophes ("Hans Muster",
    // "O'Brien"); on Windows also to a character no folder name can have.
    // Backslashes may be doubled or more (paths inside logged objects).
    .replace(/(\\Users\\+)[^\\/":*?<>|\r\n]+/gi, '$1<user>')
    .replace(/(\/(?:Users|home)\/)[^\\/"\r\n]+/gi, '$1<user>')
    .replace(patterns.userName || MATCHES_NOTHING, '<user>')
    .replace(EMAIL, '<email>')
    .replace(SECRET_VALUE, (all, head, key, value) => (
      key.toLowerCase() === 'code' && PLAIN_CODE.test(value.replace(/^\\*"|"$/g, '')) ? all : `${head}"<redacted>"`))
    .replace(/\b(Bearer)\s+[\w.~+/=-]+/gi, '$1 <redacted>')
    .replace(/(Bearer|token|password|secret|sas|sig)[=:]\s*\S+/gi, '$1=<redacted>')
    // A signed token, or any other encoded JSON object, wherever it stands.
    .replace(/\beyJ[\w-]{10,}(?:\.[\w-]+){0,2}/g, '<jwt>')
    // Any scheme, not only http: the app's own sign-in link carries the token
    // and the account in its query, other sign-in answers in the fragment.
    .replace(LINK, (all, base, query, fragment) => `${base}${query ? '?<redacted>' : ''}${fragment ? '#<redacted>' : ''}`)
    // A JSON parse error quotes the text it could not read, which can be a
    // recording's metadata (its title) or a sign-in answer: about twenty
    // characters around the error, in several shapes.
    .replace(/Unexpected token [\s\S]*? is not valid JSON/g, 'Unexpected token <text> is not valid JSON')
    .replace(/"[^"\n]{0,40}" is not valid JSON/g, '<text> is not valid JSON');
}

// The Error behind a reported line travels with its stack. Its own text and
// the paths in its stack get the same scrubbing as the line: an error message
// can quote a file it could not read, and a stack names the user's folder.
function scrubbedError(error, homeDir = HOME_DIRECTORY, places = {}) {
  const copy = new Error(scrub(error.message, homeDir, places));
  copy.name = error.name;
  if (error.stack) copy.stack = scrub(String(error.stack), homeDir, places);
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
function describe(data, homeDir = HOME_DIRECTORY, places = {}) {
  const parts = Array.isArray(data) ? data : [data];
  const error = parts.find(part => part instanceof Error) || null;
  const message = scrub(parts.map(textOf).join(' '), homeDir, places).slice(0, MAX_MESSAGE);
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

// What one installation may still send today. `store` reads and writes one
// small object ({ day, total, lines }); this module does not know where it
// lives. The store is read once, before the first event of a session, and
// written only after an event was sent. It can never break reporting: what
// cannot be read, or is not such an object, counts as an empty budget and is
// replaced by the next write; a write that fails leaves the count in memory.
function createDailyBudget({ store, now = () => new Date(), perLine = MAX_EVENTS_PER_LINE_PER_DAY, total = MAX_EVENTS_PER_DAY }) {
  let state = null;
  const today = () => {
    const date = now(); // the local date: the budget is per day as the user has it
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const current = () => {
    const day = today();
    if (!state) {
      state = { day, total: 0, lines: {} };
      try {
        const stored = store.read();
        if (stored && stored.day === day && Number.isInteger(stored.total) && stored.total >= 0
          && stored.lines && typeof stored.lines === 'object' && !Array.isArray(stored.lines)) {
          state.total = stored.total;
          for (const [line, sent] of Object.entries(stored.lines)) {
            if (Number.isInteger(sent) && sent > 0) state.lines[line] = sent;
          }
        }
      } catch (_) { /* no file yet, unreadable or not JSON: an empty budget */ }
    }
    if (state.day !== day) state = { day, total: 0, lines: {} };
    return state;
  };
  return {
    allows(line) {
      const { total: sent, lines } = current();
      return sent < total && (lines[line] || 0) < perLine;
    },
    spend(line) {
      const budget = current();
      budget.total += 1;
      budget.lines[line] = (budget.lines[line] || 0) + 1;
      try { store.write(budget); } catch (_) { /* counted in memory for this session */ }
    },
  };
}

/**
 * Turn main-process logging into Sentry reporting.
 *
 * `log` is electron-log, `Sentry` is @sentry/electron/main. Both are injected
 * so this module stays unit-testable without Electron. `budgetStore` is
 * `{ read, write }` for the budget that outlives the session; without it only
 * the limits of the session apply. `folders` is a function that gives the
 * app's folders by name ({ userData, appData, … }) for scrubbing; it is asked
 * at every line, because a folder can still be redirected after this is
 * installed. `reported` is the list of lines that become events; `maxEvents`,
 * `limits`, `maxEventsPerDay`, `maxEventsPerLinePerDay`, `now`, `homeDir` and
 * `userName` exist so tests can set them.
 */
function installLogReporting({
  log, Sentry, limits, maxEvents = MAX_EVENTS_PER_SESSION, isEnabled = () => true,
  reported = REPORTED_LINES, alreadyReported = ALREADY_REPORTED,
  budgetStore = null, now, maxEventsPerDay, maxEventsPerLinePerDay,
  homeDir = HOME_DIRECTORY, userName = USER_NAME, folders = null,
} = {}) {
  if (!log || !Sentry) throw new Error('Log reporting needs electron-log and Sentry');
  const sampler = createOccurrenceSampler(limits);
  const dailyBudget = budgetStore
    ? createDailyBudget({ store: budgetStore, now, perLine: maxEventsPerLinePerDay, total: maxEventsPerDay })
    : null;
  let reporting = false; // re-entrancy guard: reporting must never report itself
  let disarmed = false;
  let eventsSent = 0;
  // Folders that cannot be asked for are left to the other rules.
  const places = () => {
    let known = null;
    try { known = folders ? folders() : null; } catch (_) { known = null; }
    return { userName, folders: known };
  };

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
      const where = places();
      const { error, message: text } = describe(message?.data, homeDir, where);
      if (!text) return message;
      const leaveBreadcrumb = () => Sentry.addBreadcrumb({
        category: 'main-log', level: eventLevel || (level === 'info' ? 'info' : 'debug'), message: text,
      });

      const pattern = eventLevel ? reported.find(entry => entry.test(text)) : null;
      if (!pattern || alreadyReported.some(entry => entry.test(text))) { leaveBreadcrumb(); return message; }

      // A listed line is one failure. Its budget and its Sentry issue go by
      // the line, not by its text: an error message or an id in it would
      // otherwise start a new budget and a new issue for every variant. The
      // Error it carries tells real causes apart by name and code.
      const line = pattern.source;
      const group = error
        ? [line, String(error.name).slice(0, 60), String(error.code ?? '').slice(0, 60)]
        : [line];
      const decision = sampler.shouldReport(eventLevel, group.join('|'));
      if (!decision.report || eventsSent >= maxEvents || (dailyBudget && !dailyBudget.allows(line))) {
        leaveBreadcrumb();
        return message;
      }

      eventsSent += 1;
      const scopeFor = scope => {
        scope.setLevel(eventLevel);
        scope.setTag('source', 'main-log');
        scope.setFingerprint(['main-log', ...group]);
        scope.setExtra('logLine', text);
        scope.setExtra('occurrence', decision.occurrence);
        // Which event of this session it is: the last one before the cap says so.
        scope.setExtra('sessionEvent', `${eventsSent}/${maxEvents}`);
        if (message?.scope) scope.setTag('logScope', String(message.scope).slice(0, 60));
      };
      if (error) Sentry.withScope(scope => { scopeFor(scope); Sentry.captureException(scrubbedError(error, homeDir, where)); });
      else Sentry.withScope(scope => { scopeFor(scope); Sentry.captureMessage(text, eventLevel); });
      if (dailyBudget) dailyBudget.spend(line);
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
  installLogReporting, installWindowReporting, createOccurrenceSampler, scrub, describe,
  REPORTED_LINES, MAX_EVENTS_PER_SESSION, MAX_EVENTS_PER_LINE_PER_DAY, MAX_EVENTS_PER_DAY,
};
