/**
 * Navigation while a recording or upload is running.
 *
 * The router keeps the user on the Record (or Upload) page during any
 * recording/processing/upload phase. Until 4.7.15 it did so silently: on
 * phones a tapped tab simply bounced back, on desktop the menu was greyed out
 * without a reason. The guard now says why (a short toast, at most every
 * few seconds), and the desktop menu shows the same text as a tooltip.
 */

/**
 * Where the guard sends a navigation while `isBlocking`, or null to allow it.
 * @param {{name?: string}} to
 * @param {{name?: string}} from
 * @param {boolean} isBlocking - recordingStore.isBlocking
 * @returns {'record'|'upload'|null}
 */
export function blockedNavigationTarget(to, from, isBlocking) {
  if (!isBlocking) return null;
  if (from?.name === 'record' && to?.name !== 'record') return 'record';
  if (from?.name === 'upload' && to?.name !== 'upload') return 'upload';
  if (to?.name === 'upload') return 'record';
  return null;
}

const NOTICE_INTERVAL_MS = 3000;

/**
 * Rate-limited notice: returns a function that calls `show` at most once per
 * interval (a double tap must not stack toasts).
 */
export function createBlockedNotice(show, { intervalMs = NOTICE_INTERVAL_MS, now = () => Date.now() } = {}) {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < intervalMs) return false;
    last = t;
    try { show(); } catch { /* a notice must never break navigation */ }
    return true;
  };
}
