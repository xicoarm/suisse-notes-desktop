// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  installLogReporting, installWindowReporting, createOccurrenceSampler, fingerprintOf, scrub, describe as describeLog,
  MAX_EVENTS_PER_SESSION,
} from '../../src-electron/sentry-reporting.js';

function fakeSentry() {
  const events = [], breadcrumbs = [];
  const scope = {
    level: null, tags: {}, extras: {}, fingerprint: null,
    setLevel(value) { this.level = value; }, setTag(key, value) { this.tags[key] = value; },
    setExtra(key, value) { this.extras[key] = value; }, setFingerprint(value) { this.fingerprint = value; },
  };
  let current = null;
  return {
    events, breadcrumbs,
    addBreadcrumb: crumb => breadcrumbs.push(crumb),
    withScope(run) { current = { ...scope, tags: {}, extras: {} }; run(current); },
    captureMessage(message, level) { events.push({ kind: 'message', message, level, scope: current }); },
    captureException(error) { events.push({ kind: 'exception', error, scope: current }); },
  };
}

// Calls the hooks the way electron-log 5.4.3 does (core/Logger.js,
// processMessage): hook(message, transportFunction, transportName), once per
// transport. Every transport function is named "transport"; only the third
// argument tells the file transport from the console transport.
function fakeLog() {
  const hooks = [];
  const transports = { console: function transport() {}, file: function transport() {} };
  const emitTo = (name, level, ...data) => hooks.reduce(
    (message, hook) => (message ? hook(message, transports[name], name) : message), { level, data });
  return { hooks, transports, emitTo, emit: (level, ...data) => emitTo('file', level, ...data), error: vi.fn() };
}

describe('main-process log reporting', () => {
  let log, Sentry;
  beforeEach(() => { log = fakeLog(); Sentry = fakeSentry(); });

  it('turns a listed error line into an event with its source and fingerprint', () => {
    installLogReporting({ log, Sentry });
    log.emit('error', 'Could not persist capture warning:', 'ENOSPC: no space left on device');
    expect(Sentry.events).toHaveLength(1);
    const [event] = Sentry.events;
    expect(event.kind).toBe('message');
    expect(event.message).toBe('Could not persist capture warning: ENOSPC: no space left on device');
    expect(event.level).toBe('error');
    expect(event.scope.tags.source).toBe('main-log');
    expect(event.scope.fingerprint[0]).toBe('main-log');
    expect(event.scope.extras.occurrence).toBe(1);
    expect(event.scope.extras.sessionEvent).toBe(`1/${MAX_EVENTS_PER_SESSION}`);
  });

  it('acts on the file transport as electron-log names it: by the third argument', () => {
    installLogReporting({ log, Sentry });
    expect(log.transports.file.name).toBe('transport'); // what the old check compared with "file"
    log.emit('error', 'Error locking recording:', new Error('EPERM'));
    expect(Sentry.events).toHaveLength(1);
    // Without the transport's name the hook cannot know which transport runs.
    log.hooks[0]({ level: 'error', data: ['Error locking recording:', new Error('EPERM')] }, { name: 'file' });
    expect(Sentry.events).toHaveLength(1);
  });

  it('keeps the Error so the event carries a stack, with its text and paths scrubbed like the line', () => {
    installLogReporting({ log, Sentry });
    const failure = Object.assign(
      new Error('Unexpected token \'x\', "{"title":"Board meeting Q4","sta"... is not valid JSON in /Users/andreas/Library/metadata.json'),
      { name: 'SyntaxError', code: 'EBADJSON' });
    failure.stack = `SyntaxError: ${failure.message}\n    at finalize (/Users/andreas/app/src-electron/electron-main.js:1:1)`;
    log.emit('error', 'Recording finalization failed; all source batches retained:', failure);
    const [event] = Sentry.events;
    expect(event.kind).toBe('exception');
    expect(event.error).toBeInstanceOf(Error);
    expect(event.error).not.toBe(failure); // the original is never sent, and never changed
    expect(event.error.name).toBe('SyntaxError');
    expect(event.error.code).toBe('EBADJSON');
    expect(event.error.message).toBe("Unexpected token 'x', <text> is not valid JSON in /Users/<user>/Library/metadata.json");
    expect(event.error.stack).toContain('at finalize (/Users/<user>/app/src-electron/electron-main.js:1:1)');
    expect(`${event.error.message}\n${event.error.stack}`).not.toMatch(/Board|andreas/);
    expect(failure.message).toContain('Board meeting Q4');
  });

  it('files a listed warning as a warning and info as a breadcrumb', () => {
    installLogReporting({ log, Sentry });
    log.emit('info', 'Recording metadata written: rec-1');
    log.emit('warn', 'AudioTee suspend-stop failed:', 'timeout');
    expect(Sentry.events).toHaveLength(1);
    expect(Sentry.events[0].level).toBe('warning');
    expect(Sentry.breadcrumbs[0]).toEqual({ category: 'main-log', level: 'info', message: 'Recording metadata written: rec-1' });
  });

  it('leaves every warning and error that is not listed as a breadcrumb with its level', () => {
    installLogReporting({ log, Sentry });
    log.emit('error', 'Auto-update error:', new Error('net::ERR_INTERNET_DISCONNECTED'));
    log.emit('warn', 'Token refresh failed:', 401, 'Request failed with status code 401');
    log.emit('error', 'Error: Cannot download differentially, fallback to full download'); // the updater's own line
    log.emit('error', 'A line somebody adds next year:', new Error('boom'));
    expect(Sentry.events).toHaveLength(0);
    expect(Sentry.breadcrumbs.map(crumb => crumb.level)).toEqual(['error', 'warning', 'error', 'error']);
    expect(Sentry.breadcrumbs[0]).toEqual({
      category: 'main-log', level: 'error', message: 'Auto-update error: Error: net::ERR_INTERNET_DISCONNECTED',
    });
  });

  it('reports a line only where its constant text starts the line', () => {
    installLogReporting({ log, Sentry });
    log.emit('error', 'Retry after: Error locking recording: EPERM');
    log.emit('info', 'Error locking recording: mentioned in an info line');
    expect(Sentry.events).toHaveLength(0);
    expect(Sentry.breadcrumbs).toHaveLength(2);
  });

  it('does not file a second event for lines their own code path already reports', () => {
    // Even if the list is ever widened to match them.
    installLogReporting({ log, Sentry, reported: [/^Renderer process gone/, /^Uncaught Exception/, /^Session remux/] });
    log.emit('error', 'Renderer process gone:', { reason: 'crashed' });
    log.emit('error', 'Uncaught Exception:', new Error('boom'));
    log.emit('warn', 'Session remux operation timed out after 300000ms');
    expect(Sentry.events).toHaveLength(0);
    expect(Sentry.breadcrumbs.map(crumb => crumb.level)).toEqual(['error', 'error', 'warning']);
  });

  it('runs once per line even though electron-log calls every transport', () => {
    installLogReporting({ log, Sentry });
    log.emitTo('console', 'error', 'Error unlocking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(0);
    expect(Sentry.breadcrumbs).toHaveLength(0);
    log.emitTo('file', 'error', 'Error unlocking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(1);
    expect(Sentry.breadcrumbs).toHaveLength(1);
  });

  it('bounds a repeating failure instead of filling the quota', () => {
    installLogReporting({ log, Sentry, limits: { error: 3 } });
    for (let i = 0; i < 40; i++) log.emit('error', 'Could not persist capture warning:', `EBUSY: chunk ${i}`);
    // 3 by the limit, then only the 4th, 8th, 16th and 32nd occurrence.
    expect(Sentry.events).toHaveLength(7);
    expect(Sentry.events.at(-1).scope.extras.occurrence).toBe(32);
    // Every occurrence is in the trail, reported or not.
    expect(Sentry.breadcrumbs).toHaveLength(40);
  });

  it('stops sending events at the cap for the session, whatever is logged', () => {
    const reporting = installLogReporting({ log, Sentry, maxEvents: 3 });
    const lines = ['Error locking recording:', 'Error unlocking recording:', 'Binary health probe threw:',
      'Error checking disk space:', 'quitAndInstall failed:'];
    for (const line of lines) log.emit('error', line, 'EPERM');
    expect(Sentry.events.map(event => event.message)).toEqual(lines.slice(0, 3).map(line => `${line} EPERM`));
    expect(Sentry.events.at(-1).scope.extras.sessionEvent).toBe('3/3');
    expect(reporting.eventsSent()).toBe(3);
    // Past the cap a listed line is a breadcrumb like any other.
    expect(Sentry.breadcrumbs).toHaveLength(5);
    expect(Sentry.breadcrumbs.at(-1)).toEqual({ category: 'main-log', level: 'error', message: 'quitAndInstall failed: EPERM' });
  });

  it('caps a session at 30 events by default, independently of the per-line budget', () => {
    expect(MAX_EVENTS_PER_SESSION).toBe(30);
    installLogReporting({ log, Sentry });
    // 50 different failures of one listed line: each is new to the per-line sampler.
    const words = Array.from({ length: 50 }, (_, i) => `cause-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    for (const word of words) log.emit('warn', `Could not recover recording rec: ${word}`);
    expect(Sentry.events).toHaveLength(30);
    expect(Sentry.breadcrumbs).toHaveLength(50);
  });

  it('groups repeats of one failure and keeps other failures apart', () => {
    installLogReporting({ log, Sentry });
    log.emit('warn', 'Could not persist init segment:', 'disk full while saving chunk 12');
    log.emit('warn', 'Could not persist init segment:', 'disk full while saving chunk 13');
    log.emit('warn', 'Could not inspect raw session head:', 'EACCES');
    const [first, second, third] = Sentry.events;
    expect(second.scope.fingerprint).toEqual(first.scope.fingerprint);
    expect(second.scope.extras.occurrence).toBe(2);
    expect(third.scope.fingerprint).not.toEqual(first.scope.fingerprint);
    expect(third.scope.extras.occurrence).toBe(1);
  });

  it('scrubs user paths, addresses and credentials out of the message', () => {
    installLogReporting({ log, Sentry });
    log.emit('error', 'Failed to write crash metadata:', 'EPERM C:\\Users\\arega\\AppData\\Roaming\\Suisse Notes\\recordings\\metadata.json for user ad@forum4.ch token=abc.def');
    const { message } = Sentry.events[0];
    expect(message).toContain('metadata.json');
    expect(message).not.toContain('arega');
    expect(message).not.toContain('ad@forum4.ch');
    expect(message).not.toContain('abc.def');
    expect(Sentry.breadcrumbs[0].message).toBe(message);
  });

  it('does nothing while reporting is switched off', () => {
    let enabled = false;
    installLogReporting({ log, Sentry, isEnabled: () => enabled });
    log.emit('error', 'Error locking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(0);
    expect(Sentry.breadcrumbs).toHaveLength(0);
    enabled = true;
    log.emit('error', 'Error locking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(1);
  });

  it('never reports its own reporting, and disarms after an internal failure', () => {
    const broken = { ...Sentry, captureMessage() { throw new Error('transport down'); } };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporting = installLogReporting({ log, Sentry: broken });
    expect(() => log.emit('error', 'Error locking recording:', 'first failure')).not.toThrow();
    log.emit('error', 'Error unlocking recording:', 'second failure');
    expect(broken.events).toHaveLength(0);
    expect(reporting.sampler.counts.size).toBe(1); // the second line was not even sampled
    expect(broken.breadcrumbs).toHaveLength(0); // nor noted: the hook is off for the session
    consoleError.mockRestore();
  });

  it('does not report a line that is logged while it reports', () => {
    const reentrant = { ...Sentry, captureMessage(message, level) {
      log.emit('error', 'Error unlocking recording:', 'logged by the reporting itself');
      Sentry.captureMessage(message, level);
    } };
    installLogReporting({ log, Sentry: reentrant });
    log.emit('error', 'Error locking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(1);
    expect(Sentry.events[0].message).toBe('Error locking recording: EPERM');
  });

  it('returns the log message unchanged so logging keeps working', () => {
    installLogReporting({ log, Sentry });
    expect(log.emit('error', 'anything')).toMatchObject({ level: 'error', data: ['anything'] });
    expect(log.emit('error', 'Error locking recording:', 'EPERM')).toMatchObject({ level: 'error', data: ['Error locking recording:', 'EPERM'] });
  });
});

describe('window reporting', () => {
  function fakeWindow() {
    const window = new EventEmitter();
    window.webContents = new EventEmitter();
    window.isDestroyed = () => false;
    return window;
  }

  it('reports a hung window and how long it was hung', () => {
    const Sentry = fakeSentry();
    const { attachWindow } = installWindowReporting({ Sentry });
    const window = fakeWindow();
    attachWindow(window, { isRecording: () => true });
    window.emit('unresponsive');
    window.emit('responsive');
    expect(Sentry.events.map(e => e.message)).toEqual(['window unresponsive', 'window responsive again']);
    expect(Sentry.events[0].scope.extras.recording).toBe(true);
    expect(Sentry.events[1].scope.extras.unresponsiveSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports a failed preload and a window that cannot load, but not an aborted navigation', () => {
    const Sentry = fakeSentry();
    const { attachWindow } = installWindowReporting({ Sentry });
    const window = fakeWindow();
    attachWindow(window);
    window.webContents.emit('preload-error', {}, '/Applications/Suisse Meets.app/Contents/preload/electron-preload.js', new Error('module not found'));
    window.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///index.html', true);
    window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///index.html', true);
    window.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///sub.html', false);
    expect(Sentry.events.map(e => e.message)).toEqual(['preload script failed', 'app window failed to load: ERR_FILE_NOT_FOUND']);
    expect(Sentry.events[0].scope.extras.preload).toBe('electron-preload.js');
  });

  it('files a window failure once: its log line is a breadcrumb, not a second event', () => {
    const log = fakeLog();
    const Sentry = fakeSentry();
    installLogReporting({ log, Sentry });
    log.error = (...data) => log.emit('error', ...data);
    const { attachWindow } = installWindowReporting({ Sentry, log });
    const window = fakeWindow();
    attachWindow(window);
    window.emit('unresponsive');
    expect(Sentry.events.map(e => e.message)).toEqual(['window unresponsive']);
    expect(Sentry.breadcrumbs).toEqual([{ category: 'main-log', level: 'error', message: 'window unresponsive: {"recording":false}' }]);
  });

  it('survives a window that is already gone', () => {
    const Sentry = fakeSentry();
    const { attachWindow } = installWindowReporting({ Sentry });
    expect(() => attachWindow(null)).not.toThrow();
    expect(() => attachWindow({ isDestroyed: () => true })).not.toThrow();
  });
});

describe('helpers', () => {
  it('groups the same failure with different ids, paths and numbers', () => {
    const a = fingerprintOf('Recording 1e0b1a44-0000-4000-8000-0000000c0ffe finalization failed after 12.5s');
    const b = fingerprintOf('Recording 2f1c2b55-1111-4111-8111-1111111dead1 finalization failed after 3s');
    expect(a).toBe(b);
  });

  it('keeps the path but not the account name behind it', () => {
    expect(scrub('/Users/andreas/Library/Logs/Suisse Notes/main.log')).toBe('/Users/<user>/Library/Logs/Suisse Notes/main.log');
    expect(scrub('C:\\Users\\arega\\AppData\\Roaming\\Suisse Notes\\audio.webm')).toBe('C:\\Users\\<user>\\AppData\\Roaming\\Suisse Notes\\audio.webm');
  });

  it('removes the query of a link of any scheme (the sign-in link carries the token and the account)', () => {
    expect(scrub('SSO: ignoring unknown URL path: someapp://auth/other?user=eyJlbWFpbCI6InguQHkuY2gifQ&token=abc.def.ghi'))
      .toBe('SSO: ignoring unknown URL path: someapp://auth/other?<redacted>');
    expect(scrub('GET https://example.invalid/api/x?sig=abc&u=1 failed')).toBe('GET https://example.invalid/api/x?<redacted> failed');
    expect(scrub('no link here: ratio 3:4?')).toBe('no link here: ratio 3:4?');
  });

  it('removes the text a JSON parse error quotes (a metadata file can hold a title)', () => {
    const quoted = 'Could not parse existing metadata, creating new: Unexpected token \'x\', "{"title":"Board meeting Q4","sta"... is not valid JSON';
    expect(scrub(quoted)).toBe("Could not parse existing metadata, creating new: Unexpected token 'x', <text> is not valid JSON");
    expect(scrub(quoted)).not.toContain('Board');
    // Messages without a quoted text stay as they are.
    expect(scrub('Unexpected end of JSON input')).toBe('Unexpected end of JSON input');
    expect(scrub('Unterminated string in JSON at position 12 (line 1 column 13)')).toBe('Unterminated string in JSON at position 12 (line 1 column 13)');
  });

  it('describes mixed log arguments and finds the error among them', () => {
    const error = new Error('ENOSPC');
    expect(describeLog(['Saving failed:', error, { recordId: 'rec-1' }])).toMatchObject({
      error, message: expect.stringContaining('ENOSPC'),
    });
  });

  it('counts occurrences per level and fingerprint', () => {
    const sampler = createOccurrenceSampler({ error: 2, warning: 1 });
    expect([1, 2, 3, 4].map(() => sampler.shouldReport('error', 'a').report)).toEqual([true, true, false, true]);
    expect(sampler.shouldReport('warning', 'a').report).toBe(true);
    expect(sampler.shouldReport('warning', 'a').report).toBe(true); // 2 is a power of two
    expect(sampler.shouldReport('warning', 'a').report).toBe(false);
  });
});
