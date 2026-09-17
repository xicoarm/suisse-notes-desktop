// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  installLogReporting, installWindowReporting, createOccurrenceSampler, fingerprintOf, scrub, describe as describeLog,
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

function fakeLog() {
  const hooks = [];
  const emit = (level, ...data) => hooks.reduce((message, hook) => hook(message, { name: 'file' }, 'file'), { level, data });
  return { hooks, emit, emitTo: (transport, level, ...data) => hooks.reduce((m, h) => h(m, { name: transport }, transport), { level, data }), error: vi.fn() };
}

describe('main-process log reporting', () => {
  let log, Sentry;
  beforeEach(() => { log = fakeLog(); Sentry = fakeSentry(); });

  it('turns an error log line into an event with its source and fingerprint', () => {
    installLogReporting({ log, Sentry });
    log.emit('error', 'AudioTee error:', 'Failed to create aggregate device');
    expect(Sentry.events).toHaveLength(1);
    const [event] = Sentry.events;
    expect(event.kind).toBe('message');
    expect(event.message).toContain('Failed to create aggregate device');
    expect(event.level).toBe('error');
    expect(event.scope.tags.source).toBe('main-log');
    expect(event.scope.fingerprint[0]).toBe('main-log');
    expect(event.scope.extras.occurrence).toBe(1);
  });

  it('keeps the Error object so the event carries a stack', () => {
    installLogReporting({ log, Sentry });
    const failure = new Error('Recording finalization failed');
    log.emit('error', 'Recording finalization failed; all source batches retained:', failure);
    expect(Sentry.events[0]).toMatchObject({ kind: 'exception', error: failure });
  });

  it('files warnings as warnings and info as breadcrumbs', () => {
    installLogReporting({ log, Sentry });
    log.emit('warn', 'AudioTee suspend-stop failed: timeout');
    log.emit('info', 'Recording metadata written: rec-1');
    expect(Sentry.events).toHaveLength(1);
    expect(Sentry.events[0].level).toBe('warning');
    expect(Sentry.breadcrumbs).toEqual([{ category: 'main-log', level: 'info', message: 'Recording metadata written: rec-1' }]);
  });

  it('does not file a second event for lines their own code path already reports', () => {
    installLogReporting({ log, Sentry });
    log.emit('error', 'Renderer process gone:', { reason: 'crashed' });
    log.emit('error', 'Uncaught Exception:', new Error('boom'));
    expect(Sentry.events).toHaveLength(0);
    expect(Sentry.breadcrumbs).toHaveLength(2);
  });

  it('runs once per line even though electron-log calls every transport', () => {
    installLogReporting({ log, Sentry });
    log.emitTo('console', 'error', 'Upload failed permanently');
    expect(Sentry.events).toHaveLength(0);
    log.emitTo('file', 'error', 'Upload failed permanently');
    expect(Sentry.events).toHaveLength(1);
  });

  it('bounds a repeating failure instead of filling the quota', () => {
    installLogReporting({ log, Sentry, limits: { error: 3 } });
    for (let i = 0; i < 40; i++) log.emit('error', 'Chunk save failed for recording', 'rec-42');
    // 3 by the limit, then only the 4th, 8th, 16th and 32nd occurrence.
    expect(Sentry.events).toHaveLength(7);
    expect(Sentry.events.at(-1).scope.extras.occurrence).toBe(32);
  });

  it('groups repeats of one failure and keeps other failures apart', () => {
    installLogReporting({ log, Sentry });
    log.emit('error', 'Disk full while saving chunk 12');
    log.emit('error', 'Disk full while saving chunk 13');
    log.emit('error', 'Upload rejected by server');
    const [first, second, third] = Sentry.events;
    expect(second.scope.fingerprint).toEqual(first.scope.fingerprint);
    expect(second.scope.extras.occurrence).toBe(2);
    expect(third.scope.fingerprint).not.toEqual(first.scope.fingerprint);
    expect(third.scope.extras.occurrence).toBe(1);
  });

  it('scrubs user paths, addresses and credentials out of the message', () => {
    installLogReporting({ log, Sentry });
    log.emit('error', 'Could not read C:\\Users\\arega\\AppData\\Roaming\\Suisse Notes\\recordings\\audio.webm for user ad@forum4.ch token=abc.def');
    const { message } = Sentry.events[0];
    expect(message).toContain('audio.webm');
    expect(message).not.toContain('arega');
    expect(message).not.toContain('ad@forum4.ch');
    expect(message).not.toContain('abc.def');
  });

  it('never reports its own reporting, and disarms after an internal failure', () => {
    const broken = { ...Sentry, captureMessage() { throw new Error('transport down'); } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporting = installLogReporting({ log, Sentry: broken });
    expect(() => log.emit('error', 'first failure')).not.toThrow();
    log.emit('error', 'second failure');
    expect(broken.events).toHaveLength(0);
    expect(reporting.sampler.counts.size).toBe(1); // the second line was not even sampled
  });

  it('returns the log message unchanged so logging keeps working', () => {
    installLogReporting({ log, Sentry });
    const result = log.emit('error', 'anything');
    expect(result).toMatchObject({ level: 'error', data: ['anything'] });
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
