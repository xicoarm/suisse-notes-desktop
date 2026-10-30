import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import { isElectron, isCapacitor, isAndroid } from '../utils/platform';
import { useAuthStore } from '../stores/auth';
import { getApiUrlSync, fetchWithTimeout, parseJsonSafe } from '../services/api';
import { captureMessage, addBreadcrumb } from '../boot/sentry';
import { randomToken, pkceChallenge } from '../services/ssoFlow';

// Shared across every card/page: one in-app browser open at a time. A second
// launch while one is starting kills the just-opened Custom Tab and, on
// Android, the plugin's helper activity, and the second Browser.open() never
// resolves — the caller's spinner would spin forever.
let browserOpening = false;

/**
 * Detect the @capacitor/browser Android freeze: after the Custom Tab closes,
 * its translucent helper activity can stay on top as an invisible,
 * touch-eating window, so the WebView is visible but never resumes. Report it
 * to Sentry (so the field rate is known) and try to recover by asking the
 * plugin to close, which finishes that activity.
 */
async function watchForStuckBrowser() {
  if (!isAndroid()) return;
  let App;
  try { ({ App } = await import('@capacitor/app')); } catch { return; }
  const deadline = Date.now() + 20000;
  let stuck = 0;
  const timer = setInterval(async () => {
    let active = true;
    try { active = (await App.getState()).isActive !== false; } catch { /* assume active */ }
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    if (active) { clearInterval(timer); return; }          // normal: tab on top, or app resumed
    if (visible && !active) {
      // The app is drawn but not resumed — the classic stray-activity signature.
      if (++stuck >= 3) {
        clearInterval(timer);
        captureMessage('browser: app visible but not resumed after closing the in-app browser (stray Android BrowserControllerActivity)', 'error');
        try { const { Browser } = await import('@capacitor/browser'); await Browser.close(); } catch { /* best-effort recovery */ }
      }
    } else {
      stuck = 0;
    }
    if (Date.now() > deadline) clearInterval(timer);
  }, 1000);
}

const WEB_APP_ORIGIN = 'https://app.suisse-meets.ch';
const AUDIO_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The plain meeting URL: what «Link kopieren» copies and what may be shared.
 * It never carries a session token or a hand-off code — the recipient signs in
 * with their own account (meeting access is checked by the server).
 * @param {string} audioFileId - The server-assigned audio file ID
 * @returns {string} '' for a missing or malformed id
 */
export function buildMeetingUrl(audioFileId) {
  const id = typeof audioFileId === 'string' ? audioFileId : String(audioFileId ?? '');
  if (!AUDIO_ID_PATTERN.test(id)) return '';
  return `${WEB_APP_ORIGIN}/meeting/audio/${encodeURIComponent(id)}`;
}

/**
 * URL for the signed-in user's own «open in browser» action only (server
 * contract of the bound hand-off, 10/2026): the single-use, 60-second session
 * token goes into the query, the PKCE verifier into the fragment (`#hv=`),
 * which the web page posts itself — it never reaches a server, a log or a
 * Referer. A copied URL without the verifier is refused by the server. The
 * result is opened in the browser and never copied, shared, logged or
 * returned to the UI.
 * @param {string} plainUrl - from buildMeetingUrl
 * @param {object} data - create-web-session response body
 * @param {string} verifier - the verifier whose challenge was sent
 * @returns {string} the plain URL when the response holds no bound token
 */
export function handoffUrl(plainUrl, data, verifier) {
  // `bound: true` confirms the server stored the challenge (backend 10/2026).
  // An older server answers 200 with an unbound, reusable token: never put
  // that into a URL - open the plain URL (normal login) instead.
  if (!data || data.success === false || data.bound !== true
    || typeof data.sessionToken !== 'string' || !data.sessionToken || !verifier) {
    return plainUrl;
  }
  return `${plainUrl}?session=${encodeURIComponent(data.sessionToken)}#hv=${encodeURIComponent(verifier)}`;
}

/**
 * Composable for meeting links.
 * - copyLink: the plain meeting URL (no token, ever).
 * - openInBrowser: the signed-in user's own hand-off into the web app.
 */
export function useShareLink() {
  const $q = useQuasar();
  const { t } = useI18n();
  const authStore = useAuthStore();

  /**
   * Plain, shareable meeting URL (kept for callers of the old name).
   * @param {string} audioFileId
   * @returns {Promise<string>}
   */
  const generateTranscriptUrl = async (audioFileId) => buildMeetingUrl(audioFileId);

  /** Mobile: URL with a fresh hand-off for the browser; never leaves this module. */
  const mobileHandoffUrl = async (url) => {
    if (!authStore.token) return url;
    try {
      // Bound hand-off: the server stores the challenge; only the browser
      // we open gets the verifier (in the URL fragment).
      const verifier = randomToken(32);
      const codeChallenge = await pkceChallenge(verifier);
      const response = await fetchWithTimeout(`${getApiUrlSync()}/api/auth/desktop/create-web-session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authStore.token}`
        },
        body: JSON.stringify({ codeChallenge, codeChallengeMethod: 'S256' })
      });
      const data = await parseJsonSafe(response);
      // 400 HANDOFF_BINDING_REQUIRED or any failure: the plain URL.
      return response.ok ? handoffUrl(url, data, verifier) : url;
    } catch (error) {
      console.warn('Could not create web session for mobile:', error?.message || 'unknown');
      return url;
    }
  };

  /**
   * Open a recording in the system's default browser (Safari, Chrome, etc.),
   * signed in as the current user.
   * @param {string} audioFileId - The server-assigned audio file ID
   */
  const openInBrowser = async (audioFileId) => {
    const url = buildMeetingUrl(audioFileId);
    if (!url) return;

    if (isElectron()) {
      // Main creates the hand-off and opens the browser itself: the token
      // never reaches this renderer.
      let opened = null;
      try {
        opened = await window.electronAPI.auth.openWebWithSession(new URL(url).pathname);
      } catch (error) {
        console.warn('Could not open the meeting with a web session:', error?.message || 'unknown');
      }
      if (!opened?.success || !opened?.signedIn) {
        $q.notify({
          type: 'warning',
          message: t('sessionCreationFailed'),
          timeout: 3000
        });
      }
      if (!opened?.success) window.electronAPI.shell.openExternal(url);
    } else if (isCapacitor()) {
      if (browserOpening) return;   // a tap already opened one; ignore the double-tap
      browserOpening = true;
      try {
        const target = await mobileHandoffUrl(url);
        try {
          const { Browser } = await import('@capacitor/browser');
          await Browser.open({ url: target });
          watchForStuckBrowser();
        } catch (e) {
          addBreadcrumb({ category: 'ui', message: `Browser.open failed, falling back to window.open: ${e?.message || e}`, level: 'warning' });
          window.open(target, '_blank');
        }
      } finally {
        // Release shortly after: long enough to swallow a rapid double-tap,
        // short enough that a real second open later still works.
        setTimeout(() => { browserOpening = false; }, 1500);
      }
    }
  };

  /**
   * Copy a recording's shareable link to the clipboard: the plain meeting URL,
   * never a session token (anyone holding a token link was signed in as the
   * copying user).
   * @param {string} audioFileId - The server-assigned audio file ID
   */
  const copyLink = async (audioFileId) => {
    const url = buildMeetingUrl(audioFileId);
    if (!url) return;

    try {
      if (isElectron() && window.electronAPI?.clipboard?.writeText) {
        await window.electronAPI.clipboard.writeText(url);
      } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        throw new Error('Clipboard API unavailable');
      }
      $q.notify({
        type: 'positive',
        message: t('linkCopied'),
        timeout: 2000
      });
    } catch (error) {
      console.warn('Failed to copy URL to clipboard:', error?.message || error);
      $q.notify({
        type: 'negative',
        message: t('linkCopyFailed'),
        timeout: 2000
      });
    }
  };

  return {
    generateTranscriptUrl,
    openInBrowser,
    copyLink
  };
}
