/**
 * Upload failure (raw message from the upload pipeline) -> i18n key.
 *
 * The Record and Upload pages showed the pipeline's English text in their
 * error card ("Upload failed with status 502", "Request timed out after
 * 30s (network error)"). The raw text stays in the history entry for
 * diagnostics; the user sees what it means and that the recording is safe.
 */

/** @returns {'insufficientMinutesUpload'|'uploadFailedNoInternet'|'uploadTooLarge'|'uploadFailedServer'} */
export function uploadErrorKey(rawMessage, { online = true } = {}) {
  const text = String(rawMessage || '');
  if (/insufficient|minutes|credit|balance|\b402\b/i.test(text)) return 'insufficientMinutesUpload';
  if (/\b413\b|too large|entity too large|payload too large|file size/i.test(text)) return 'uploadTooLarge';
  if (!online || /network|timeout|timed out|fetch|ERR_INTERNET|ENOTFOUND|ECONNRESET|EAI_AGAIN|offline/i.test(text)) {
    return 'uploadFailedNoInternet';
  }
  return 'uploadFailedServer';
}
