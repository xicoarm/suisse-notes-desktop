// Entry points for reporting inappropriate AI-generated content. The content
// itself (summaries, documents, chat) lives in the web app, so these helpers
// only build the web URLs the desktop and mobile app open in the browser.

export const WEB_APP_ORIGIN = 'https://app.suisse-meets.ch';

/**
 * General report form (About page). A known recording can be pre-selected.
 * @param {string} [audioFileId]
 * @returns {string}
 */
export function buildReportAiContentUrl(audioFileId) {
  const base = `${WEB_APP_ORIGIN}/report-ai-content`;
  return audioFileId ? `${base}?audioFileId=${encodeURIComponent(audioFileId)}` : base;
}

/**
 * Meeting page URL that opens the report dialog on load.
 * @param {string} audioFileId
 * @returns {string} empty string without an audioFileId
 */
export function buildMeetingReportUrl(audioFileId) {
  if (!audioFileId) return '';
  return withReportAiFlag(`${WEB_APP_ORIGIN}/meeting/audio/${encodeURIComponent(audioFileId)}`);
}

/**
 * Add reportAi=1 to a meeting URL (keeps an existing query such as ?session=).
 * @param {string} url
 * @returns {string}
 */
export function withReportAiFlag(url) {
  if (!url) return '';
  const parsed = new URL(url);
  parsed.searchParams.set('reportAi', '1');
  return parsed.toString();
}
