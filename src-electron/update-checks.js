'use strict';

// When the app looks for an update. The "update ready" prompt can only appear
// once the whole installer is downloaded (140-190 MB), so the update has to be
// found early: at launch, every hour while the app runs, and shortly after the
// computer wakes (a laptop that sleeps between meetings kept missing the old
// 4-hour timer and found updates right when a recording started). Once an
// update is downloaded, checking stops: it installs from the prompt or on
// quit, and another check would only re-validate it (Windows) or stage it with
// Squirrel a second time (macOS). A download that fails for a reason that will
// not go away (signature, checksum, disk) is retried at the old 4-hour pace.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_CHECK_AFTER_WAKE_MS = [20 * 1000, 3 * 60 * 1000]; // Wi-Fi/VPN may take a while
const UPDATE_CHECK_MIN_GAP_MS = 30 * 60 * 1000;                // wake-ups in a row check once
const UPDATE_RETRY_AFTER_FAILED_DOWNLOAD_MS = 4 * 60 * 60 * 1000;

// Failures that the same download will hit again: a signature or checksum
// that does not verify, a full disk, missing permissions. Only these wait 4
// hours; a download cut by sleep or a dropped network retries at the next
// wake-up or hourly check, because that is the case the early checks are for.
function isPersistentDownloadError(error) {
  const text = `${error?.code || ''} ${error?.message || error || ''}`;
  return /not signed|signature|publisherName|sha512|checksum|ENOSPC|EACCES|EPERM|EROFS|read-only/i.test(text);
}

function createUpdateChecks({ check, isEnabled, isDownloaded, now = Date.now, log = null }) {
  let lastCheckAt = null;
  let downloadFailedAt = null;
  return {
    // Returns whether a check was started; failures are logged, never thrown.
    request(reason, { minGapMs = 0 } = {}) {
      if (!isEnabled() || isDownloaded()) return false;
      if (downloadFailedAt !== null && now() - downloadFailedAt < UPDATE_RETRY_AFTER_FAILED_DOWNLOAD_MS) return false;
      if (lastCheckAt !== null && now() - lastCheckAt < minGapMs) return false;
      const startedAt = now();
      lastCheckAt = startedAt;
      Promise.resolve().then(check).catch(error => {
        // The update server was not reachable: the next wake-up may try again.
        if (lastCheckAt === startedAt) lastCheckAt = null;
        log?.error?.(`Auto-update check failed (${reason}):`, error);
      });
      return true;
    },
    downloadFailed() { downloadFailedAt = now(); },
    downloadSucceeded() { downloadFailedAt = null; },
  };
}

module.exports = { createUpdateChecks, isPersistentDownloadError, UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_AFTER_WAKE_MS, UPDATE_CHECK_MIN_GAP_MS,
  UPDATE_RETRY_AFTER_FAILED_DOWNLOAD_MS };
