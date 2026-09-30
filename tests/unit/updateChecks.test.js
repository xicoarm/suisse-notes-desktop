// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createUpdateChecks, isPersistentDownloadError, UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_AFTER_WAKE_MS, UPDATE_CHECK_MIN_GAP_MS,
  UPDATE_RETRY_AFTER_FAILED_DOWNLOAD_MS } = require('../../src-electron/update-checks');

function setup({ enabled = true, downloaded = false, check = vi.fn(async () => ({})) } = {}) {
  const state = { enabled, downloaded, time: 1000000 };
  const log = { error: vi.fn() };
  const checks = createUpdateChecks({ check, isEnabled: () => state.enabled, isDownloaded: () => state.downloaded, now: () => state.time, log });
  return { checks, check, state, log };
}

describe('when the app looks for updates', () => {
  it('checks hourly and a short moment after waking, instead of every 4 hours', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(UPDATE_CHECK_AFTER_WAKE_MS).toEqual([20 * 1000, 3 * 60 * 1000]);
    expect(UPDATE_CHECK_MIN_GAP_MS).toBe(30 * 60 * 1000);
    expect(UPDATE_RETRY_AFTER_FAILED_DOWNLOAD_MS).toBe(4 * 60 * 60 * 1000);
  });

  it('checks at launch and on every hourly tick', async () => {
    const { checks, check, state } = setup();
    expect(checks.request('startup')).toBe(true);
    state.time += 1000;
    expect(checks.request('interval')).toBe(true);
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('checks once for wake-ups in quick succession', () => {
    const { checks, state } = setup();
    expect(checks.request('startup')).toBe(true);
    state.time += 10 * 60 * 1000;
    expect(checks.request('wake', { minGapMs: UPDATE_CHECK_MIN_GAP_MS })).toBe(false);
    state.time += 25 * 60 * 1000;
    expect(checks.request('wake', { minGapMs: UPDATE_CHECK_MIN_GAP_MS })).toBe(true);
    expect(checks.request('wake', { minGapMs: UPDATE_CHECK_MIN_GAP_MS })).toBe(false);
  });

  it('never checks once an update is downloaded, or while updating is disabled', () => {
    const { checks, check, state } = setup({ downloaded: true });
    expect(checks.request('startup')).toBe(false);
    state.downloaded = false; state.enabled = false; // e.g. app on a read-only volume
    expect(checks.request('interval')).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it('logs a failed check with its reason and never throws', async () => {
    const failure = new Error('offline');
    const { checks, log } = setup({ check: vi.fn(async () => { throw failure; }) });
    expect(() => checks.request('wake')).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(log.error).toHaveBeenCalledWith('Auto-update check failed (wake):', failure);
    const sync = setup({ check: vi.fn(() => { throw failure; }) });
    expect(() => sync.checks.request('startup')).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sync.log.error).toHaveBeenCalledWith('Auto-update check failed (startup):', failure);
  });

  it('lets the second wake-up attempt run when the first could not reach the update server', async () => {
    let calls = 0;
    const { checks, state } = setup({ check: vi.fn(async () => { calls++; if (calls === 1) throw new Error('Wi-Fi not back yet'); }) });
    expect(checks.request('wake', { minGapMs: UPDATE_CHECK_MIN_GAP_MS })).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    state.time += 3 * 60 * 1000;
    expect(checks.request('wake', { minGapMs: UPDATE_CHECK_MIN_GAP_MS })).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(checks.request('wake', { minGapMs: UPDATE_CHECK_MIN_GAP_MS })).toBe(false); // this one reached it
  });

  it('retries a failed download at the old 4-hour pace, not every hour', () => {
    const { checks, state } = setup();
    expect(checks.request('startup')).toBe(true);
    checks.downloadFailed(); // e.g. the installer's signature did not verify
    state.time += 60 * 60 * 1000;
    expect(checks.request('interval')).toBe(false);
    state.time += 3 * 60 * 60 * 1000;
    expect(checks.request('interval')).toBe(true);
    checks.downloadFailed();
    checks.downloadSucceeded();
    state.time += 60 * 60 * 1000;
    expect(checks.request('interval')).toBe(true);
  });

  it('waits 4 hours only for failures the same download will hit again', () => {
    const persistent = [
      new Error('New version 4.7.12 is not signed by the application owner: publisherNames: Suisse IT GmbH'),
      new Error('sha512 checksum mismatch, expected abc, got def'),
      Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }),
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    ];
    const transient = [
      new Error('net::ERR_INTERNET_DISCONNECTED'), new Error('net::ERR_NETWORK_CHANGED'),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), new Error('Request timed out'),
      new Error('HttpError: 503 Service Unavailable'), new Error('aborted'), 'socket hang up',
    ];
    for (const error of persistent) expect(isPersistentDownloadError(error)).toBe(true);
    for (const error of transient) expect(isPersistentDownloadError(error)).toBe(false);
  });
});

