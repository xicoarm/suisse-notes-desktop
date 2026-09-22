import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import { isElectron, isCapacitor, isAndroid } from '../utils/platform';
import { useAuthStore } from '../stores/auth';
import { getApiUrlSync, fetchWithTimeout } from '../services/api';
import { captureMessage, addBreadcrumb } from '../boot/sentry';

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

/**
 * Composable for generating shareable meeting links and opening them in the system browser.
 * Session tokens are created on-demand (each call generates a fresh token).
 */
export function useShareLink() {
  const $q = useQuasar();
  const { t } = useI18n();
  const authStore = useAuthStore();

  /**
   * Generate a transcript URL with a fresh session token for seamless login.
   * @param {string} audioFileId - The server-assigned audio file ID
   * @returns {Promise<string>} The full URL with session token
   */
  const generateTranscriptUrl = async (audioFileId) => {
    if (!audioFileId) return '';

    let url = `https://app.suisse-meets.ch/meeting/audio/${audioFileId}`;

    if (isElectron()) {
      try {
        const result = await window.electronAPI.auth.createWebSession();
        if (result.success && result.sessionToken) {
          url += `?session=${encodeURIComponent(result.sessionToken)}`;
        }
      } catch (error) {
        console.warn('Could not create web session:', error);
      }
    } else if (isCapacitor()) {
      try {
        if (authStore.token) {
          const response = await fetchWithTimeout(`${getApiUrlSync()}/api/auth/desktop/create-web-session`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authStore.token}`
            }
          });
          const data = await response.json();
          if (data.success && data.sessionToken) {
            url += `?session=${encodeURIComponent(data.sessionToken)}`;
          }
        }
      } catch (error) {
        console.warn('Could not create web session for mobile:', error);
      }
    }

    return url;
  };

  /**
   * Open a recording in the system's default browser (Safari, Chrome, etc.)
   * @param {string} audioFileId - The server-assigned audio file ID
   */
  const openInBrowser = async (audioFileId) => {
    if (!audioFileId) return;

    const url = await generateTranscriptUrl(audioFileId);

    if (isElectron()) {
      if (!url.includes('session=')) {
        $q.notify({
          type: 'warning',
          message: t('sessionCreationFailed'),
          timeout: 3000
        });
      }
      window.electronAPI.shell.openExternal(url);
    } else if (isCapacitor()) {
      if (browserOpening) return;   // a tap already opened one; ignore the double-tap
      browserOpening = true;
      try {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url });
        watchForStuckBrowser();
      } catch (e) {
        addBreadcrumb({ category: 'ui', message: `Browser.open failed, falling back to window.open: ${e?.message || e}`, level: 'warning' });
        window.open(url, '_blank');
      } finally {
        // Release shortly after: long enough to swallow a rapid double-tap,
        // short enough that a real second open later still works.
        setTimeout(() => { browserOpening = false; }, 1500);
      }
    }
  };

  /**
   * Copy a recording's shareable link to clipboard (generates a fresh session token)
   * @param {string} audioFileId - The server-assigned audio file ID
   */
  const copyLink = async (audioFileId) => {
    if (!audioFileId) return;

    const url = await generateTranscriptUrl(audioFileId);

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
