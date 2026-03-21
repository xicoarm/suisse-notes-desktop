import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import { isElectron, isCapacitor } from '../utils/platform';
import { useAuthStore } from '../stores/auth';
import { getApiUrlSync } from '../services/api';

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

    let url = `https://app.suisse-notes.ch/meeting/audio/${audioFileId}`;

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
          const response = await fetch(`${getApiUrlSync()}/api/auth/desktop/create-web-session`, {
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
      // Open in the actual system browser (Safari/Chrome), not the in-app browser
      window.open(url, '_blank');
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
      await navigator.clipboard.writeText(url);
      $q.notify({
        type: 'positive',
        message: t('linkCopied'),
        timeout: 2000
      });
    } catch (error) {
      console.error('Failed to copy URL:', error);
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
