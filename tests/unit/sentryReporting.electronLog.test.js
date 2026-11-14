// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installLogReporting } from '../../src-electron/sentry-reporting.js';

// The hook was dead for two months because its test called it with a made-up
// transport object. This test lets the installed electron-log call it: outside
// Electron the package loads its Node logger, which shares the Logger class
// and the console and file transports with the main-process logger.
const electronLog = createRequire(import.meta.url)('electron-log');

function fakeSentry() {
  const events = [], breadcrumbs = [];
  return {
    events, breadcrumbs,
    addBreadcrumb: crumb => breadcrumbs.push(crumb),
    withScope(run) { run({ setLevel() {}, setTag() {}, setExtra() {}, setFingerprint() {} }); },
    captureMessage(message, level) { events.push({ kind: 'message', message, level }); },
    captureException(error) { events.push({ kind: 'exception', error }); },
  };
}

describe('log reporting on the installed electron-log', () => {
  let directory, logFile, log, Sentry, consoleLines;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'main-log-reporting-'));
    logFile = path.join(directory, 'main.log');
    log = electronLog.create({ logId: `reporting-test-${path.basename(directory)}` });
    log.transports.file.resolvePathFn = () => logFile;
    consoleLines = [];
    log.transports.console.writeFn = ({ message }) => { consoleLines.push(message.level); };
    Sentry = fakeSentry();
  });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it('files one event for a listed error line and breadcrumbs for the rest', () => {
    const calls = [];
    log.hooks.push((message, transport, transportName) => {
      calls.push(`${transportName}:${typeof transport}:${transport?.name}`);
      return message;
    });
    installLogReporting({ log, Sentry });

    log.info('Recovery complete: 1 recording(s) recovered');
    log.error('Could not persist capture warning:', 'ENOSPC: no space left on device');
    log.error('Auto-update error:', new Error('net::ERR_INTERNET_DISCONNECTED'));
    log.warn('Token refresh failed:', 401, 'Request failed with status code 401');

    expect(Sentry.events).toEqual([
      { kind: 'message', message: 'Could not persist capture warning: ENOSPC: no space left on device', level: 'error' },
    ]);
    expect(Sentry.breadcrumbs).toEqual([
      { category: 'main-log', level: 'info', message: 'Recovery complete: 1 recording(s) recovered' },
      { category: 'main-log', level: 'error', message: 'Could not persist capture warning: ENOSPC: no space left on device' },
      { category: 'main-log', level: 'error', message: 'Auto-update error: Error: net::ERR_INTERNET_DISCONNECTED' },
      { category: 'main-log', level: 'warning', message: 'Token refresh failed: 401 Request failed with status code 401' },
    ]);

    // What the library really passes: one call per transport, the transport as
    // a function called "transport", its name as the third argument.
    expect(new Set(calls)).toEqual(new Set(['console:function:transport', 'file:function:transport']));
    expect(calls.filter(call => call.startsWith('file:'))).toHaveLength(4);

    // Logging itself is untouched: every line reached the file and the console.
    const written = fs.readFileSync(logFile, 'utf8');
    expect(written).toContain('[error] Could not persist capture warning: ENOSPC: no space left on device');
    expect(written).toContain('[error] Auto-update error:');
    expect(written).toContain('[warn]  Token refresh failed: 401 Request failed with status code 401');
    expect(written).toContain('[info]  Recovery complete: 1 recording(s) recovered');
    expect(consoleLines).toEqual(['info', 'error', 'error', 'warn']);
  });

  it('keeps the Error of a listed line and still reports with the file transport at its usual level', () => {
    log.transports.file.level = 'info'; // as electron-main.js sets it
    installLogReporting({ log, Sentry });
    const failure = new Error('ENOSPC: no space left on device');
    log.error('Recording finalization failed; all source batches retained:', failure);
    log.debug('below the file level: the library does not call the hook for the file transport');
    expect(Sentry.events).toEqual([{ kind: 'exception', error: failure }]);
    expect(Sentry.breadcrumbs).toHaveLength(1);
  });

  it('keeps the daily budget in a file, as the main process wires it, over starts and a damaged file', () => {
    const budgetFile = path.join(directory, 'main-log-reporting.json');
    const budgetStore = {
      read: () => JSON.parse(fs.readFileSync(budgetFile, 'utf8')),
      write: budget => fs.writeFileSync(budgetFile, JSON.stringify(budget)),
    };
    const start = () => {
      const logger = electronLog.create({ logId: `reporting-test-${path.basename(directory)}-${Math.random()}` });
      logger.transports.file.resolvePathFn = () => logFile;
      logger.transports.console.writeFn = () => {};
      const sentry = fakeSentry();
      installLogReporting({ log: logger, Sentry: sentry, budgetStore });
      for (let i = 0; i < 5; i++) logger.warn(`Could not recover recording rec-${i}: ffprobe failed`);
      return sentry.events.length;
    };
    expect(fs.existsSync(budgetFile)).toBe(false); // the first start of an installation: nothing to read
    expect(start()).toBe(3);
    expect(JSON.parse(fs.readFileSync(budgetFile, 'utf8'))).toMatchObject({ total: 3, lines: { '^Could not recover recording .+: ': 3 } });
    expect(start()).toBe(0); // the next start: this line has had its three of the day
    fs.writeFileSync(budgetFile, '{"day":"20'); // cut off while it was written
    expect(start()).toBe(3);
    expect(JSON.parse(fs.readFileSync(budgetFile, 'utf8')).total).toBe(3); // replaced by a whole one
  });
});
