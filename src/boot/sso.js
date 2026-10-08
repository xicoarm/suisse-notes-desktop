/**
 * App-wide SSO result handler (desktop and mobile).
 *
 * WHY: the Microsoft/Google result used to be handled only by the login page.
 * It was lost whenever that page was not mounted when the result arrived:
 * - desktop cold start by the suissenotes:// URL: main pushed the result at
 *   did-finish-load, before the renderer had a listener, and the app opened
 *   /about;
 * - Android cold start: the deep link fired before the login page existed;
 * - the Register page was open;
 * - a sign-in that continued through a 2FA page in the browser and came back
 *   minutes later, after the page had given up waiting.
 *
 * Now one handler, registered at boot, takes every result: the auth store
 * signs in (or maps the error to a translated text) and the router moves to
 * the right page. Desktop results carry a deliveryId (they can arrive both as
 * a push and from main's buffer); each is handled once.
 */

import { useAuthStore } from '../stores/auth';
import { isElectron, isCapacitor } from '../utils/platform';
import { addBreadcrumb } from './sentry';

/**
 * @param {object} deps
 * @param {() => object} deps.getAuthStore
 * @param {object} deps.router - vue-router instance
 * @param {() => boolean|Promise<boolean>} [deps.isRecordingActive] - a recording/upload is running
 * @param {() => Promise<void>} [deps.closeBrowser] - close the in-app browser (Android)
 * @returns {(payload: object) => Promise<void>}
 */
export function createSSOResultHandler({ getAuthStore, router, isRecordingActive = () => false, closeBrowser = null }) {
  const handledDeliveries = new Set();
  let queue = Promise.resolve();

  const process = async (payload) => {
    // The first navigation restores any stored session; signing in before it
    // finishes raced checkSession() (which could clear the fresh token).
    try { await router.isReady(); } catch { /* proceed anyway */ }
    const authStore = getAuthStore();

    let recordingActive = false;
    if (payload.token && authStore.isAuthenticated) {
      try { recordingActive = !!(await isRecordingActive()); } catch { recordingActive = false; }
    }
    if (recordingActive) {
      // Never switch the account under a running recording or upload.
      addBreadcrumb({ category: 'sso', message: 'SSO success ignored: recording or upload in progress', level: 'warning' });
      return;
    }

    const result = await authStore.completeSSO(payload);
    if (closeBrowser) {
      try { await closeBrowser(); } catch { /* already closed */ }
    }

    const current = router.currentRoute?.value?.name;
    try {
      if (result.success) {
        await router.push('/record');
      } else if (!result.cancelled && current !== 'login') {
        // The error text is shown on the login page.
        await router.push('/login');
      }
    } catch { /* navigation refused (guard) - the store state is still right */ }
  };

  return (payload) => {
    if (!payload || typeof payload !== 'object') return queue;
    if (payload.deliveryId != null) {
      if (handledDeliveries.has(payload.deliveryId)) return queue;
      handledDeliveries.add(payload.deliveryId);
    }
    queue = queue.then(() => process(payload)).catch(() => {});
    return queue;
  };
}

export default ({ router, store }) => {
  if (typeof window === 'undefined') return;

  const handle = createSSOResultHandler({
    getAuthStore: () => useAuthStore(store),
    router,
    isRecordingActive: async () => {
      // Lazy: keeps the capture stack out of this boot file's module graph.
      const { useRecordingStore } = await import('../stores/recording');
      return useRecordingStore(store).isBlocking;
    },
    closeBrowser: isCapacitor()
      ? async () => { const { closeSSO } = await import('../services/ssoAuth'); await closeSSO(); }
      : null
  });

  if (isElectron() && window.electronAPI?.auth?.onSSOCallback) {
    const takePending = () => {
      const take = window.electronAPI.auth.takePendingSSO;
      if (typeof take !== 'function') return;
      // Also acknowledges a pushed result; a newer one is handled, the same
      // one is skipped by its deliveryId.
      Promise.resolve(take()).then((pending) => { if (pending) handle(pending); }).catch(() => {});
    };
    window.electronAPI.auth.onSSOCallback((payload) => {
      handle(payload);
      takePending();
    });
    takePending();
  }

  if (isCapacitor()) {
    // Dispatched by boot/lifecycle.js (deep link) and services/ssoAuth.js (iOS).
    window.addEventListener('sso:callback', (event) => handle(event?.detail));
  }
};
