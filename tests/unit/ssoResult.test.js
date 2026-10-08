import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn(), setUser: vi.fn() }));
vi.mock('../../src/boot/sentry', () => sentry);
vi.mock('../../src/stores/minutes', () => ({
  useMinutesStore: () => ({ fetchMinutes: vi.fn(async () => ({ success: true })), setFromServer: vi.fn(), reset: vi.fn() })
}));

const electronAuth = {
  saveToken: vi.fn(async () => ({ success: true })),
  saveUserInfo: vi.fn(async () => ({ success: true }))
};
// performance: vue-i18n needs window.performance to translate.
vi.stubGlobal('window', { electronAPI: { auth: electronAuth }, performance: globalThis.performance });

const { useAuthStore } = await import('../../src/stores/auth');
const { createSSOResultHandler } = await import('../../src/boot/sso');
const { i18n } = await import('../../src/boot/i18n');
const en = (key) => i18n.global.getLocaleMessage('en')[key];

function fakeRouter(name = 'login') {
  const router = {
    currentRoute: { value: { name } },
    isReady: vi.fn(async () => {}),
    push: vi.fn(async (path) => { router.currentRoute.value = { name: path.replace('/', '') }; })
  };
  return router;
}

describe('auth store: completeSSO', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    i18n.global.locale.value = 'en';
  });

  it('a cancel is silent and ends the wait', async () => {
    const store = useAuthStore();
    store.beginSSO('microsoft');
    const result = await store.completeSSO({ error: 'User cancelled', code: 'sso_cancelled' });
    expect(result).toEqual({ success: false, cancelled: true, reason: 'sso_cancelled' });
    expect(store.error).toBeNull();
    expect(store.ssoProvider).toBeNull();
    expect(store.ssoOutcome).toMatchObject({ seq: 1, success: false, cancelled: true });
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('a failure shows the translated text and reports a warning with codes only', async () => {
    const store = useAuthStore();
    store.beginSSO('microsoft');
    await store.completeSSO({ error: 'AADSTS65001: The user or administrator has not consented to use the application.' });
    expect(store.error).toBe(en('ssoAdminConsent'));
    expect(store.error).not.toMatch(/AADSTS/);
    expect(sentry.captureMessage).toHaveBeenCalledWith('auth: SSO sign-in failed (AADSTS65001)', 'warning',
      expect.objectContaining({ tags: { sso_reason: 'AADSTS65001', sso_provider: 'microsoft' } }));
  });

  it('a success signs in', async () => {
    const store = useAuthStore();
    store.beginSSO('google');
    const result = await store.completeSSO({ token: 'jwt', user: { id: 'u1' }, deliveryId: 1 });
    expect(result.success).toBe(true);
    expect(store.isAuthenticated).toBe(true);
    expect(store.ssoOutcome).toMatchObject({ seq: 1, success: true });
    expect(electronAuth.saveToken).toHaveBeenCalledWith('jwt');
  });

  it('a success that arrives after the wait was abandoned (2FA in the browser) is still accepted', async () => {
    const store = useAuthStore();
    store.beginSSO('microsoft');
    store.abandonSSO();
    const result = await store.completeSSO({ token: 'late', user: { id: 'u2' } });
    expect(result.success).toBe(true);
    expect(store.token).toBe('late');
  });
});

describe('app-wide SSO result handler (boot/sso.js)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('signs in and opens /record from any page (cold start shows /about)', async () => {
    const store = useAuthStore();
    const router = fakeRouter('about');
    const handle = createSSOResultHandler({ getAuthStore: () => store, router });
    await handle({ token: 'jwt', user: { id: 'u1' }, deliveryId: 7 });
    expect(router.isReady).toHaveBeenCalled();
    expect(store.isAuthenticated).toBe(true);
    expect(router.push).toHaveBeenCalledWith('/record');
  });

  it('handles each desktop delivery once (push and buffer can both bring it)', async () => {
    const store = useAuthStore();
    const completeSSO = vi.spyOn(store, 'completeSSO');
    const handle = createSSOResultHandler({ getAuthStore: () => store, router: fakeRouter() });
    await handle({ error: 'x', code: 'sso_failed', deliveryId: 3 });
    await handle({ error: 'x', code: 'sso_failed', deliveryId: 3 });
    expect(completeSSO).toHaveBeenCalledTimes(1);
  });

  it('shows an error on the login page (navigating there from Register), stays put on a cancel', async () => {
    const store = useAuthStore();
    const router = fakeRouter('register');
    const handle = createSSOResultHandler({ getAuthStore: () => store, router });
    await handle({ error: 'x', code: 'sso_account_exists' });
    expect(router.push).toHaveBeenCalledWith('/login');
    expect(store.error).toBe(en('ssoAccountExists'));

    const cancelRouter = fakeRouter('register');
    const cancel = createSSOResultHandler({ getAuthStore: () => store, router: cancelRouter });
    await cancel({ error: 'access_denied' });
    expect(cancelRouter.push).not.toHaveBeenCalled();
  });

  it('never switches the account under a running recording', async () => {
    const store = useAuthStore();
    store.isAuthenticated = true;
    store.token = 'current';
    const router = fakeRouter('record');
    const handle = createSSOResultHandler({ getAuthStore: () => store, router, isRecordingActive: async () => true });
    await handle({ token: 'other', user: { id: 'u9' } });
    expect(store.token).toBe('current');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('closes the in-app browser on mobile', async () => {
    const store = useAuthStore();
    const closeBrowser = vi.fn(async () => {});
    const handle = createSSOResultHandler({ getAuthStore: () => store, router: fakeRouter(), closeBrowser });
    await handle({ error: 'x', code: 'sso_failed' });
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });
});
