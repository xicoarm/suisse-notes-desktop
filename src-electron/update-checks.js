'use strict';

// When the app looks for an update. The "update ready" prompt can only appear
// once the whole installer is downloaded (140-190 MB), so the update has to be
// found early: at launch, every hour while the app runs, and shortly after the
// computer wakes (a laptop that sleeps between meetings kept missing the old
// 4-hour timer and found updates right when a recording started). Once an
// update is downloaded, checking stops: it installs from the prompt or on
// quit, and another check would only re-validate it (Windows) or stage it with
// Squirrel a second time (macOS).
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_CHECK_AFTER_WAKE_MS = 20 * 1000;       // Wi-Fi reconnects first
const UPDATE_CHECK_MIN_GAP_MS = 30 * 60 * 1000;     // wake-ups in a row check once

function createUpdateChecks({ check, isEnabled, isDownloaded, now = Date.now, log = null }) {
  let lastCheckAt = null;
  return {
    // Returns whether a check was started; failures are logged, never thrown.
    request(reason, { minGapMs = 0 } = {}) {
      if (!isEnabled() || isDownloaded()) return false;
      if (lastCheckAt !== null && now() - lastCheckAt < minGapMs) return false;
      lastCheckAt = now();
      Promise.resolve().then(check).catch(error => log?.error?.(`Auto-update check failed (${reason}):`, error));
      return true;
    },
  };
}

module.exports = { createUpdateChecks, UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_AFTER_WAKE_MS, UPDATE_CHECK_MIN_GAP_MS };
