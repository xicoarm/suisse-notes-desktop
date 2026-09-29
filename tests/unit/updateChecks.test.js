// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createUpdateChecks, UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_AFTER_WAKE_MS, UPDATE_CHECK_MIN_GAP_MS } = require('../../src-electron/update-checks');

function setup({ enabled = true, downloaded = false, check = vi.fn(async () => ({})) } = {}) {
  const state = { enabled, downloaded, time: 1000000 };
  const log = { error: vi.fn() };
  const checks = createUpdateChecks({ check, isEnabled: () => state.enabled, isDownloaded: () => state.downloaded, now: () => state.time, log });
  return { checks, check, state, log };
}

describe('when the app looks for updates', () => {
  it('checks hourly and a short moment after waking, instead of every 4 hours', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(UPDATE_CHECK_AFTER_WAKE_MS).toBe(20 * 1000);
    expect(UPDATE_CHECK_MIN_GAP_MS).toBe(30 * 60 * 1000);
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
});
