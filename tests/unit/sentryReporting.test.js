// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  installLogReporting, installWindowReporting, createOccurrenceSampler, scrub, describe as describeLog,
  MAX_EVENTS_PER_SESSION, MAX_EVENTS_PER_LINE_PER_DAY, MAX_EVENTS_PER_DAY,
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

// Fourteen listed lines that need no variable part.
const LISTED = [
  'Error locking recording:', 'Error unlocking recording:', 'Binary health probe threw:', 'Error checking disk space:',
  'quitAndInstall failed:', 'Periodic upload retry failed:', 'Error in recovery re-scan:',
  'Error recovering orphaned recordings:', 'recovery: enqueue failed:', 'recovery: upload processing failed:',
  'restore: upload processing failed:', 'Failed to write crash metadata:', 'Could not persist capture warning:',
  'Could not persist init segment:',
];

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
    expect(event.scope.fingerprint).toEqual(['main-log', '^Could not persist capture warning:']);
    expect(event.scope.extras.logLine).toBe(event.message);
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
    expect(event.error.message).toBe('Unexpected token <text> is not valid JSON in /Users/<user>/Library/metadata.json');
    expect(event.error.stack).toContain('at finalize (/Users/<user>/app/src-electron/electron-main.js:1:1)');
    expect(`${event.error.message}\n${event.error.stack}`).not.toMatch(/Board|andreas/);
    expect(failure.message).toContain('Board meeting Q4');
  });

  it('scrubs the user folder out of the line, the Error and its stack, also where the name has a space', () => {
    installLogReporting({ log, Sentry, homeDir: 'C:\\Users\\Hans Muster' });
    log.emit('info', 'Using bundled ffmpeg:', 'C:\\Users\\Hans Muster\\AppData\\Local\\Programs\\Suisse Meets\\resources\\ffmpeg.exe');
    const failure = new Error("EPERM: operation not permitted, open 'C:\\Users\\Hans Muster\\AppData\\Roaming\\Suisse Notes\\recordings\\r1\\metadata.json'");
    failure.stack = `Error: ${failure.message}\n    at save (C:\\Users\\Hans Muster\\AppData\\Local\\Programs\\Suisse Meets\\resources\\app.asar\\electron-main.js:1:1)`;
    log.emit('error', 'Failed to write crash metadata:', failure);
    log.emit('error', 'Upload attempt 1 failed:', { message: 'timeout', filePath: 'C:\\Users\\Hans Muster\\AppData\\Roaming\\Suisse Notes\\recordings\\r1\\audio.webm' });
    const sent = JSON.stringify([Sentry.breadcrumbs, Sentry.events.map(event => [event.error.message, event.error.stack, event.scope.extras])]);
    expect(sent).not.toMatch(/Hans|Muster/);
    expect(Sentry.breadcrumbs[0].message).toBe('Using bundled ffmpeg: C:\\Users\\<user>\\AppData\\Local\\Programs\\Suisse Meets\\resources\\ffmpeg.exe');
    expect(Sentry.events[0].error.stack).toContain('at save (C:\\Users\\<user>\\AppData\\Local\\Programs\\Suisse Meets\\resources\\app.asar\\electron-main.js:1:1)');
    expect(Sentry.breadcrumbs.at(-1).message).toContain('"filePath":"C:\\\\Users\\\\<user>\\\\AppData\\\\Roaming\\\\Suisse Notes\\\\recordings\\\\r1\\\\audio.webm"');
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

  it('files one event for a failed recovery: its finalization line is the breadcrumb that tells why', () => {
    installLogReporting({ log, Sentry });
    log.emit('warn', 'Recording finalization failed during recovery; all source batches retained:', new Error('ENOSPC: no space left on device'));
    log.emit('warn', 'Could not recover recording 1e0b1a44-0000-4000-8000-0000000c0ffe: ENOSPC: no space left on device');
    expect(Sentry.events.map(event => event.message)).toEqual(['Could not recover recording 1e0b1a44-0000-4000-8000-0000000c0ffe: ENOSPC: no space left on device']);
    expect(Sentry.breadcrumbs[0]).toEqual({
      category: 'main-log', level: 'warning',
      message: 'Recording finalization failed during recovery; all source batches retained: Error: ENOSPC: no space left on device',
    });
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

  it('gives one line one budget and one issue, whatever its variable text says', () => {
    installLogReporting({ log, Sentry });
    // Ids that are no UUIDs and free error texts: every variant used to be a
    // failure of its own, with a fresh budget and a new issue.
    const variants = ['cmh3k2j1x0001abcd: quota exceeded', 'cmh9z8y7w0002efgh: storage unavailable', 'cmq1a2b3c0003ijkl: rejected',
      'cmr4d5e6f0004mnop: checksum mismatch', 'cms7g8h9i0005qrst: unknown', 'cmt0j1k2l0006uvwx: timeout'];
    for (const variant of variants) log.emit('warn', `Could not recover recording ${variant}`);
    expect(Sentry.events).toHaveLength(4); // the budget of a warning, shared by all six
    expect(new Set(Sentry.events.map(event => JSON.stringify(event.scope.fingerprint))).size).toBe(1);
    expect(Sentry.events.map(event => event.scope.extras.occurrence)).toEqual([1, 2, 3, 4]);
    // The event still says which variant it was.
    expect(Sentry.events[1].message).toBe('Could not recover recording cmh9z8y7w0002efgh: storage unavailable');
    expect(Sentry.events[1].scope.extras.logLine).toBe(Sentry.events[1].message);
  });

  it('keeps different lines apart, and the causes of one line by the name and code of its Error', () => {
    installLogReporting({ log, Sentry });
    const failure = (message, code, name = 'Error') => Object.assign(new Error(message), { code, name });
    log.emit('warn', 'Could not persist init segment:', 'disk full while saving chunk 12');
    log.emit('warn', 'Could not inspect raw session head:', 'disk full while saving chunk 12');
    log.emit('error', 'Error locking recording:', failure('EPERM: operation not permitted, rename a', 'EPERM'));
    log.emit('error', 'Error locking recording:', failure('EPERM: operation not permitted, rename b', 'EPERM'));
    log.emit('error', 'Error locking recording:', failure('ENOSPC: no space left on device', 'ENOSPC'));
    log.emit('error', 'Error locking recording:', failure('x is not a function', undefined, 'TypeError'));
    const [init, head, eperm, epermAgain, enospc, typeError] = Sentry.events.map(event => event.scope);
    expect(init.fingerprint).not.toEqual(head.fingerprint);
    expect(eperm.fingerprint).toEqual(['main-log', '^Error locking recording:', 'Error', 'EPERM']);
    expect(epermAgain.fingerprint).toEqual(eperm.fingerprint);
    expect(epermAgain.extras.occurrence).toBe(2);
    expect(enospc.fingerprint).toEqual(['main-log', '^Error locking recording:', 'Error', 'ENOSPC']);
    expect(enospc.extras.occurrence).toBe(1);
    expect(typeError.fingerprint).toEqual(['main-log', '^Error locking recording:', 'TypeError', '']);
    expect(typeError.extras.occurrence).toBe(1);
  });

  it('stops sending events at the cap for the session, whatever is logged', () => {
    const reporting = installLogReporting({ log, Sentry, maxEvents: 3 });
    const lines = LISTED.slice(0, 5);
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
    // Five lines, eight times each: every one is within the budget of its line.
    for (const line of LISTED.slice(0, 5)) for (let i = 0; i < 8; i++) log.emit('error', line, 'EPERM');
    expect(Sentry.events).toHaveLength(30);
    expect(Sentry.breadcrumbs).toHaveLength(40);
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

describe('the budget of an installation per day', () => {
  // What electron-main.js hands in: read and write of one small JSON file.
  function fakeStore(content) {
    const store = { content, reads: 0, writes: 0,
      read() { store.reads += 1; return store.content; },
      write(budget) { store.writes += 1; store.content = JSON.parse(JSON.stringify(budget)); } };
    return store;
  }
  let clock;
  const now = () => clock;
  // One start of the app: a new logger, a new session, the same store.
  function launch(store, options = {}) {
    const log = fakeLog(), Sentry = fakeSentry();
    installLogReporting({ log, Sentry, budgetStore: store, now, ...options });
    return { log, Sentry };
  }
  beforeEach(() => { clock = new Date(2026, 10, 14, 9, 0); });

  it('is 3 events per line and 30 in total', () => {
    expect([MAX_EVENTS_PER_LINE_PER_DAY, MAX_EVENTS_PER_DAY]).toEqual([3, 30]);
  });

  it('is shared by every start of the day: a failure that repeats at every start reports three times', () => {
    const store = fakeStore(undefined);
    const first = launch(store);
    for (let i = 0; i < 5; i++) first.log.emit('warn', `Could not recover recording rec-${i}: ffprobe failed`);
    expect(first.Sentry.events).toHaveLength(3);
    expect(first.Sentry.breadcrumbs).toHaveLength(5);
    expect(store.content).toEqual({ day: '2026-11-14', total: 3, lines: { '^Could not recover recording .+: ': 3 } });

    const second = launch(store);
    second.log.emit('warn', 'Could not recover recording rec-0: ffprobe failed');
    second.log.emit('warn', 'Could not recover recording rec-1: ffprobe failed');
    expect(second.Sentry.events).toHaveLength(0);
    expect(second.Sentry.breadcrumbs).toHaveLength(2); // still context for whatever is reported next
    second.log.emit('error', 'Error locking recording:', 'EPERM'); // another line has its own three
    expect(second.Sentry.events).toHaveLength(1);
    expect(store.content.total).toBe(4);
  });

  it('stops at 30 events a day over all lines and starts', () => {
    const store = fakeStore(undefined);
    const first = launch(store);
    for (const line of LISTED.slice(0, 7)) for (let i = 0; i < 3; i++) first.log.emit('error', line, 'EPERM');
    expect(first.Sentry.events).toHaveLength(21);
    const second = launch(store);
    for (const line of LISTED.slice(7, 14)) for (let i = 0; i < 3; i++) second.log.emit('error', line, 'EPERM');
    expect(second.Sentry.events).toHaveLength(9); // 21 of the day were spent before this start
    expect(second.Sentry.breadcrumbs).toHaveLength(21);
    expect(store.content.total).toBe(30);
  });

  it('reads the store once, before the first event, and writes only when an event was sent', () => {
    const store = fakeStore(undefined);
    const { log } = launch(store);
    log.emit('info', 'Recording metadata written: rec-1');
    log.emit('error', 'Auto-update error:', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect([store.reads, store.writes]).toEqual([0, 0]);
    for (let i = 0; i < 5; i++) log.emit('error', 'Error locking recording:', 'EPERM');
    expect([store.reads, store.writes]).toEqual([1, 3]);
  });

  it('starts again on the next day, by the local date', () => {
    const store = fakeStore(undefined);
    clock = new Date(2026, 10, 14, 23, 58);
    const { log, Sentry } = launch(store);
    for (let i = 0; i < 4; i++) log.emit('error', 'Error locking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(3);
    clock = new Date(2026, 10, 15, 0, 2); // the app ran over midnight
    log.emit('error', 'Error locking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(4);
    expect(store.content).toEqual({ day: '2026-11-15', total: 1, lines: { '^Error locking recording:': 1 } });
    // And a start on a later day does not inherit an older day's count.
    clock = new Date(2026, 10, 16, 8, 0);
    const later = launch(store);
    for (let i = 0; i < 4; i++) later.log.emit('error', 'Error locking recording:', 'EPERM');
    expect(later.Sentry.events).toHaveLength(3);
    expect(store.content.day).toBe('2026-11-16');
  });

  it('keeps reporting when the store cannot be read, and replaces it', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = fakeStore(undefined);
    store.read = () => { throw new Error('EACCES: permission denied'); };
    const { log, Sentry } = launch(store);
    for (let i = 0; i < 5; i++) log.emit('error', 'Error locking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(3); // the day's budget, counted from now
    expect(store.content).toEqual({ day: '2026-11-14', total: 3, lines: { '^Error locking recording:': 3 } });
    expect(consoleError).not.toHaveBeenCalled(); // the hook did not disarm
    consoleError.mockRestore();
  });

  it('keeps reporting when the store cannot be written: the count stays in memory for the session', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = fakeStore(undefined);
    store.write = () => { throw new Error('ENOSPC: no space left on device'); };
    const { log, Sentry } = launch(store);
    for (let i = 0; i < 5; i++) log.emit('error', 'Error locking recording:', 'EPERM');
    log.emit('error', 'Error unlocking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(4);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it.each([
    ['text that is not JSON (the read throws)', () => JSON.parse('{"day":"2026-11-1')],
    ['a string', () => 'budget'],
    ['an array', () => [1, 2, 3]],
    ['an object of something else', () => ({ theme: 'dark', lines: 4 })],
    ['today with a count that is no number', () => ({ day: '2026-11-14', total: '99', lines: {} })],
    ['today without its lines', () => ({ day: '2026-11-14', total: 30, lines: null })],
    ['another day, used up', () => ({ day: '2026-11-13', total: 30, lines: { '^Error locking recording:': 3 } })],
  ])('ignores and replaces a file that holds %s', (_name, read) => {
    const store = fakeStore(undefined);
    store.read = read;
    const { log, Sentry } = launch(store);
    for (let i = 0; i < 5; i++) log.emit('error', 'Error locking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(3);
    expect(store.content).toEqual({ day: '2026-11-14', total: 3, lines: { '^Error locking recording:': 3 } });
  });

  it('takes from a readable file only the counts that are counts', () => {
    const store = fakeStore({ day: '2026-11-14', total: 2,
      lines: { '^Error locking recording:': 2, '^Error unlocking recording:': 'many', '^quitAndInstall failed:': -5 } });
    const { log, Sentry } = launch(store);
    for (const line of ['Error locking recording:', 'Error unlocking recording:', 'quitAndInstall failed:']) {
      for (let i = 0; i < 5; i++) log.emit('error', line, 'EPERM');
    }
    expect(Sentry.events.map(event => event.message.split(':')[0])).toEqual([
      'Error locking recording', 'Error unlocking recording', 'Error unlocking recording', 'Error unlocking recording',
      'quitAndInstall failed', 'quitAndInstall failed', 'quitAndInstall failed',
    ]);
    expect(store.content.total).toBe(9);
  });

  it('applies only the limits of the session when it has no store', () => {
    const log = fakeLog(), Sentry = fakeSentry();
    installLogReporting({ log, Sentry });
    for (let i = 0; i < 8; i++) log.emit('error', 'Error locking recording:', 'EPERM');
    expect(Sentry.events).toHaveLength(8);
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

describe('scrubbing the user folder', () => {
  const NONE = ''; // no home directory known: only the general rules apply

  it('keeps the path but not the account name behind it', () => {
    expect(scrub('/Users/andreas/Library/Logs/Suisse Notes/main.log', NONE)).toBe('/Users/<user>/Library/Logs/Suisse Notes/main.log');
    expect(scrub('C:\\Users\\arega\\AppData\\Roaming\\Suisse Notes\\audio.webm', NONE)).toBe('C:\\Users\\<user>\\AppData\\Roaming\\Suisse Notes\\audio.webm');
    expect(scrub('/home/agent/.config/Suisse Notes/main.log', NONE)).toBe('/home/<user>/.config/Suisse Notes/main.log');
  });

  it('takes the whole name of a profile folder with a space, on Windows and on a Mac', () => {
    expect(scrub("ENOENT: no such file or directory, open 'C:\\Users\\Hans Muster\\AppData\\Roaming\\Suisse Notes\\audio.webm'", NONE))
      .toBe("ENOENT: no such file or directory, open 'C:\\Users\\<user>\\AppData\\Roaming\\Suisse Notes\\audio.webm'");
    expect(scrub('at save (/Users/Hans Muster/Library/Application Support/Suisse Notes/x.js:1:1)', NONE))
      .toBe('at save (/Users/<user>/Library/Application Support/Suisse Notes/x.js:1:1)');
    expect(scrub('file:///C:/Users/Hans%20Muster/AppData/index.html', NONE)).toBe('file:///C:/Users/<user>/AppData/index.html');
  });

  it('takes a name with an apostrophe whole, and rather too much than a part of it', () => {
    expect(scrub("open C:\\Users\\Ann O'Brien\\AppData\\a.webm", NONE)).toBe('open C:\\Users\\<user>\\AppData\\a.webm');
    expect(scrub("open '/Users/ann o'brien/Library/a.webm'", NONE)).toBe("open '/Users/<user>/Library/a.webm'");
    // The folder itself, in quotes: the rest of the line goes with the name.
    expect(scrub("scandir 'C:\\Users\\Ann O'Brien' failed\nnext line", NONE)).toBe("scandir 'C:\\Users\\<user>\nnext line");
    expect(scrub("scandir 'C:\\Users\\Ann O'Brien' failed", "C:\\Users\\Ann O'Brien")).toBe("scandir 'C:\\Users\\<user>' failed");
  });

  it('finds a path inside a logged object, where every backslash is doubled', () => {
    const { message } = describeLog(['Binary health probe result:', {
      ffmpeg: { path: 'C:\\Users\\Hans Muster\\AppData\\Local\\Programs\\Suisse Meets\\resources\\ffmpeg.exe', available: true },
    }], NONE);
    expect(message).toBe('Binary health probe result: {"ffmpeg":{"path":"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Programs\\\\Suisse Meets\\\\resources\\\\ffmpeg.exe","available":true}}');
    // An object logged inside a string: four backslashes.
    expect(scrub('{"detail":"{\\"path\\":\\"C:\\\\\\\\Users\\\\\\\\Hans Muster\\\\\\\\a.webm\\"}"}', NONE)).not.toMatch(/Hans|Muster/);
  });

  it('is not fooled by upper and lower case', () => {
    expect(scrub('c:\\USERS\\Hans Muster\\appdata\\a.webm', NONE)).toBe('c:\\USERS\\<user>\\appdata\\a.webm');
    expect(scrub('/USERS/hans/Library/a.webm and /Home/hans/a.webm', NONE)).toBe('/USERS/<user>/Library/a.webm and /Home/<user>/a.webm');
  });

  it('takes a name that ends the line, and stops at the line end', () => {
    expect(scrub('cwd is C:\\Users\\Hans Muster', NONE)).toBe('cwd is C:\\Users\\<user>');
    expect(scrub('cwd is /Users/Hans Muster\n    at start (main.js:1:1)', NONE)).toBe('cwd is /Users/<user>\n    at start (main.js:1:1)');
    expect(scrub('cwd is C:\\Users\\Hans Muster\r\n    at start (main.js:1:1)', NONE)).toBe('cwd is C:\\Users\\<user>\r\n    at start (main.js:1:1)');
  });

  it('replaces the real home directory in each way a line spells it', () => {
    const home = 'D:\\Profiles\\Hans Muster'; // not under \Users\: no general rule would find it
    expect(scrub('open D:\\Profiles\\Hans Muster\\AppData\\a.webm', home)).toBe('open D:\\Profiles\\<user>\\AppData\\a.webm');
    expect(scrub('{"path":"D:\\\\Profiles\\\\Hans Muster\\\\AppData\\\\a.webm"}', home)).toBe('{"path":"D:\\\\Profiles\\\\<user>\\\\AppData\\\\a.webm"}');
    expect(scrub('file:///D:/Profiles/Hans Muster/AppData/a.webm', home)).toBe('file:///D:/Profiles/<user>/AppData/a.webm');
    expect(scrub('open d:\\profiles\\HANS MUSTER\\appdata\\a.webm', home)).toBe('open D:\\Profiles\\<user>\\appdata\\a.webm');
    expect(scrub('home is D:\\Profiles\\Hans Muster', home)).toBe('home is D:\\Profiles\\<user>');
    expect(scrub('home is D:\\Profiles\\Hans Muster\\', `${home}\\`)).toBe('home is D:\\Profiles\\<user>\\');
    // A Mac or Linux home outside /Users and /home.
    expect(scrub('open /var/lib/kiosk user/Library/a.webm', '/var/lib/kiosk user')).toBe('open /var/lib/<user>/Library/a.webm');
  });

  it('does not take another folder that only starts like the home directory', () => {
    expect(scrub('open D:\\Profiles\\hansjoerg\\a.webm', 'D:\\Profiles\\hans')).toBe('open D:\\Profiles\\hansjoerg\\a.webm');
    expect(scrub('open C:\\Users\\hansjoerg\\a.webm', 'C:\\Users\\hans')).toBe('open C:\\Users\\<user>\\a.webm');
  });

  it('works without a usable home directory', () => {
    for (const home of ['', null, undefined, 'hans', '/', 'C:\\']) {
      expect(scrub('open /Users/hans/a.webm at 3/4', home === undefined ? NONE : home)).toBe('open /Users/<user>/a.webm at 3/4');
    }
  });
});

describe('scrubbing credentials, addresses and quoted text', () => {
  it('removes the query and the fragment of a link of any scheme (sign-in links carry the token and the account)', () => {
    expect(scrub('SSO: ignoring unknown URL path: someapp://auth/other?user=eyJlbWFpbCI6InguQHkuY2gifQ&token=abc.def.ghi'))
      .toBe('SSO: ignoring unknown URL path: someapp://auth/other?<redacted>');
    expect(scrub('GET https://example.invalid/api/x?sig=abc&u=1 failed')).toBe('GET https://example.invalid/api/x?<redacted> failed');
    expect(scrub('opened someapp://auth/callback#code=0.AXoA9d_hj-K&state=k3 now')).toBe('opened someapp://auth/callback#<redacted> now');
    expect(scrub('opened https://example.invalid/cb?state=k3#access_token=abc now')).toBe('opened https://example.invalid/cb?<redacted>#<redacted> now');
    expect(scrub('GET https://example.invalid/api/x failed')).toBe('GET https://example.invalid/api/x failed');
    expect(scrub('no link here: ratio 3:4?')).toBe('no link here: ratio 3:4?');
  });

  it('removes credentials from a logged object', () => {
    const { message } = describeLog(['Sign-in answer:', {
      access_token: 'at-1.secret', refresh_token: 'rt-2.secret', token: 'tk-3.secret', password: 'pw 4 "secret"',
      secret: 'sc-5.secret', Authorization: 'Bearer hd-6.secret', code: '0.AXoA9d_hj-K7.secret', status: 200,
    }]);
    expect(message).not.toMatch(/\.secret|hd-6|pw 4/);
    expect(message).toBe('Sign-in answer: {"access_token":"<redacted>","refresh_token":"<redacted>","token":"<redacted>",'
      + '"password":"<redacted>","secret":"<redacted>","Authorization":"<redacted>","code":"<redacted>","status":200}');
    // The same object logged as a string inside another object.
    expect(scrub('{"responseData":"{\\"token\\":\\"tk-3.secret\\",\\"ok\\":true}"}')).not.toContain('tk-3');
    expect(scrub('{"password": null, "token": 12345678}')).toBe('{"password": "<redacted>", "token": "<redacted>"}');
  });

  it('keeps a code that is an error or machine code, and removes one that is a sign-in code', () => {
    const kept = '{"message":"timeout of 30000ms exceeded","code":"ECONNABORTED","status":504} {"code":"invalid_code"} {"code":404} {"code":"ERR_HTTP2_STREAM_ERROR"}';
    expect(scrub(kept)).toBe(kept);
    expect(scrub('{"code":"123456"} {"code":"4/0AX4XfWh-abc"} {"code":8675309}'))
      .toBe('{"code":"<redacted>"} {"code":"<redacted>"} {"code":"<redacted>"}');
  });

  it('removes a signed token wherever it stands, and a bearer value', () => {
    expect(scrub('session eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1LTEyMyJ9.c2lnbmF0dXJl_-1 expired')).toBe('session <jwt> expired');
    expect(scrub('decoded user eyJlbWFpbCI6InguQHkuY2gifQ from the link')).toBe('decoded user <jwt> from the link');
    expect(scrub('sent Authorization: Bearer abc123.def-456')).toBe('sent Authorization: Bearer <redacted>');
    expect(scrub('the key eyJ is short')).toBe('the key eyJ is short');
  });

  it('removes mail addresses, also with umlauts and other letters', () => {
    expect(scrub('for ad@forum4.ch and Jürg.Müller+meets@bücher-zürich.ch, then')).toBe('for <email> and <email>, then');
    expect(scrub('for josé.núñez@correo.example.es.')).toBe('for <email>.');
    expect(scrub('node_modules/@sentry/electron/main.js and a@b')).toBe('node_modules/@sentry/electron/main.js and a@b');
  });

  // The exact messages of JSON.parse on the build machine (Node 24.22, V8 13.6).
  it.each([
    ['the whole short text', 'Unexpected token \'x\', "x{"title":"Q4"}" is not valid JSON'],
    ['the start of a long text', 'Unexpected token \'x\', "x{"title":"... is not valid JSON'],
    ['the middle of a long text', 'Unexpected token \'x\', ...","status":x,"userId""... is not valid JSON'],
    ['the end of a long text', 'Unexpected token \'x\', ..."ster","s":x}" is not valid JSON'],
    ['a text of several lines, at the start', 'Unexpected token \'x\', "x{\n  "titl"... is not valid JSON'],
    ['a text of several lines, in the middle', 'Unexpected token \'x\', ...""userId": x,\n  "star"... is not valid JSON'],
    ['a path in the text', 'Unexpected token \'x\', ..."webm","s":x,"more":""... is not valid JSON'],
  ])('removes what a JSON parse error quotes: %s', (_name, message) => {
    expect(scrub(`Could not parse existing metadata, creating new: ${message}`))
      .toBe('Could not parse existing metadata, creating new: Unexpected token <text> is not valid JSON');
  });

  it('removes the quoted text of the shape without "Unexpected token", and leaves the other messages alone', () => {
    expect(scrub('"undefined" is not valid JSON')).toBe('<text> is not valid JSON');
    expect(scrub('restore failed: "[object Object]" is not valid JSON')).toBe('restore failed: <text> is not valid JSON');
    for (const message of ['Unexpected end of JSON input', 'Unterminated string in JSON at position 61 (line 1 column 62)',
      'Expected double-quoted property name in JSON at position 85 (line 1 column 86)',
      'Unexpected non-whitespace character after JSON at position 85 (line 1 column 86)',
      'Bad control character in string literal in JSON at position 16 (line 1 column 17)']) {
      expect(scrub(message)).toBe(message);
    }
  });

  it('leaves nothing of the text in whatever JSON.parse of this runtime says', () => {
    const title = 'Board meeting Q4 with Hans Muster';
    const texts = [
      `x{"title":"${title}","status":"interrupted"}`, `{"title":"${title}","status":x,"userId":"u-123","startedAt":"2026-11-14"}`,
      `{"status":"interrupted","userId":"u-123","title":"${title}","s":x}`, `{"title":"${title}"`, `{"title":"${title}",}`,
      JSON.stringify({ status: 'interrupted', title, userId: 'u-123' }, null, 2).replace('"u-123"', 'x'), title, undefined, {},
    ];
    for (const text of texts) {
      let message = null;
      try { JSON.parse(text); } catch (error) { message = error.message; }
      expect(message, `JSON.parse accepted ${text}`).not.toBeNull();
      expect(scrub(message), message).not.toMatch(/Board|meeting|Hans|Muster|title|status|userId|u-123|interrupted/);
    }
  });

  it('scrubs a bounded part of a huge line, and never cuts into what it replaces', () => {
    const huge = `${'x'.repeat(10000)} token=tail.secret C:\\Users\\Hans Muster\\a.webm`;
    expect(scrub(huge)).toHaveLength(4000);
    expect(scrub(huge)).not.toMatch(/secret|Hans/);
    // The cut of the message to 900 characters falls into the folder name.
    const { message } = describeLog([`${'y'.repeat(889)} C:\\Users\\Hans Muster\\AppData\\a.webm`], '');
    expect(message).toHaveLength(900);
    expect(message.slice(889)).toBe(' C:\\Users\\<');
  });
});

describe('helpers', () => {
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
