/**
 * Recording integrity checks that must be verifiable without launching Electron.
 *
 * The first version of the truncation guard lived inline in electron-main.js and
 * compared the probed duration against `metadata.duration` — a field that is only
 * written AFTER the combine, by that very probe. It therefore read 0 every time
 * and silently did nothing: a detector for silent failures that failed silently.
 * It was caught only because the logic could not be tested in isolation.
 *
 * So the decision lives here as a pure function, and it is unit tested.
 */
'use strict';

// A shortfall must clear BOTH floors to count. Encoders legitimately trim a
// fraction of a second, and a short meeting must not be judged by percentage
// alone — 10% of 90 s is 9 s, which is noise, not data loss.
const TRUNCATION_MIN_SHORTFALL_SEC = 30;
const TRUNCATION_MIN_SHORTFALL_RATIO = 0.10;

/**
 * Is the produced audio materially shorter than the session that was recorded?
 *
 * @param {number} producedSec  ffprobe duration of the combined file
 * @param {number} expectedSec  wall-clock duration measured while recording
 * @returns {{truncated: boolean, shortfallSec: number, reason?: string}}
 */
function evaluateTruncation(producedSec, expectedSec) {
  const produced = Number(producedSec);
  const expected = Number(expectedSec);

  // Unknown inputs are not evidence of truncation. Never cry wolf on a missing
  // probe — a spurious "your recording is incomplete" is its own kind of damage.
  if (!Number.isFinite(produced) || produced <= 0) {
    return { truncated: false, shortfallSec: 0, reason: 'produced-unknown' };
  }
  if (!Number.isFinite(expected) || expected <= 0) {
    return { truncated: false, shortfallSec: 0, reason: 'expected-unknown' };
  }

  const shortfall = expected - produced;
  if (shortfall <= 0) return { truncated: false, shortfallSec: 0, reason: 'complete' };
  if (shortfall < TRUNCATION_MIN_SHORTFALL_SEC) {
    return { truncated: false, shortfallSec: shortfall, reason: 'below-absolute-floor' };
  }
  if (shortfall < expected * TRUNCATION_MIN_SHORTFALL_RATIO) {
    return { truncated: false, shortfallSec: shortfall, reason: 'below-relative-floor' };
  }
  return { truncated: true, shortfallSec: shortfall };
}

module.exports = {
  evaluateTruncation,
  TRUNCATION_MIN_SHORTFALL_SEC,
  TRUNCATION_MIN_SHORTFALL_RATIO,
};
