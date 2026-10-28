import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn(), setUser: vi.fn() }));
vi.mock('../../src/boot/sentry', () => sentry);
// The real device store (BLE stack) is a slow first import under a loaded
// full-suite run (timed out once); sign-in only needs its reload hook.
vi.mock('../../src/stores/device', () => ({
  useDeviceStore: () => ({ reloadForUser: vi.fn(async () => {}), onLogout: vi.fn(async () => {}) })
}));
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
// A token whose userId claim matches the result's user (sanitizeSsoUser).
const jwt = (userId) => `h.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.s`;

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
    const result = await store.completeSSO({ error: 'User cancelled', code: 'sso_cancelled', bound: true });
    expect(result).toEqual({ success: false, cancelled: true, reason: 'sso_cancelled' });
    expect(store.error).toBeNull();
    expect(store.ssoProvider).toBeNull();
    expect(store.ssoOutcome).toMatchObject({ seq: 1, success: false, cancelled: true });
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('a failure shows the translated text and reports a warning with codes only', async () => {
    const store = useAuthStore();
    store.beginSSO('microsoft');
    await store.completeSSO({ error: 'AADSTS65001: The user or administrator has not consented to use the application.', bound: true });
    expect(store.error).toBe(en('ssoAdminConsent'));
    expect(store.error).not.toMatch(/AADSTS/);
    expect(sentry.captureMessage).toHaveBeenCalledWith('auth: SSO sign-in failed (AADSTS65001)', 'warning',
      expect.objectContaining({ tags: { sso_reason: 'AADSTS65001', sso_provider: 'microsoft' } }));
  });

  it('a success signs in', async () => {
    const store = useAuthStore();
    store.beginSSO('google');
    const result = await store.completeSSO({ token: jwt('u1'), user: { id: 'u1' }, deliveryId: 1, bound: true });
    expect(result.success).toBe(true);
    expect(store.isAuthenticated).toBe(true);
    expect(store.ssoOutcome).toMatchObject({ seq: 1, success: true });
    expect(electronAuth.saveToken).toHaveBeenCalledWith(jwt('u1'));
  });

  it('a success that arrives after the wait was abandoned (2FA in the browser) is still accepted', async () => {
    const store = useAuthStore();
    store.beginSSO('microsoft');
    store.abandonSSO();
    const result = await store.completeSSO({ token: jwt('u2'), user: { id: 'u2' }, bound: true });
    expect(result.success).toBe(true);
    expect(store.token).toBe(jwt('u2'));
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
    await handle({ token: jwt('u1'), user: { id: 'u1' }, deliveryId: 7, bound: true });
    expect(router.isReady).toHaveBeenCalled();
    expect(store.isAuthenticated).toBe(true);
    expect(router.push).toHaveBeenCalledWith('/record');
  });

  it('handles each desktop delivery once (push and buffer can both bring it)', async () => {
    const store = useAuthStore();
    const completeSSO = vi.spyOn(store, 'completeSSO');
    const handle = createSSOResultHandler({ getAuthStore: () => store, router: fakeRouter() });
    await handle({ error: 'x', code: 'sso_failed', deliveryId: 3, bound: true });
    await handle({ error: 'x', code: 'sso_failed', deliveryId: 3, bound: true });
    expect(completeSSO).toHaveBeenCalledTimes(1);
  });

  it('shows an error on the login page (navigating there from Register), stays put on a cancel', async () => {
    const store = useAuthStore();
    const router = fakeRouter('register');
    const handle = createSSOResultHandler({ getAuthStore: () => store, router });
    await handle({ error: 'x', code: 'sso_account_exists', bound: true });
    expect(router.push).toHaveBeenCalledWith('/login');
    expect(store.error).toBe(en('ssoAccountExists'));

    const cancelRouter = fakeRouter('register');
    const cancel = createSSOResultHandler({ getAuthStore: () => store, router: cancelRouter });
    await cancel({ error: 'access_denied', bound: true });
    expect(cancelRouter.push).not.toHaveBeenCalled();
  });

  it('SECURITY: a success result while signed in is ignored - no account switch (crafted link, stale hand-off, late result)', async () => {
    const store = useAuthStore();
    store.isAuthenticated = true;
    store.token = 'current';
    store.user = { id: 'me' };
    store.ssoProvider = 'microsoft';
    const loginWithSSO = vi.spyOn(store, 'loginWithSSO');
    const router = fakeRouter('history');
    const handle = createSSOResultHandler({ getAuthStore: () => store, router });

    await handle({ token: 'attacker', user: { id: 'evil' }, deliveryId: 11, bound: true });

    expect(loginWithSSO).not.toHaveBeenCalled();
    expect(store.token).toBe('current');
    expect(store.user).toEqual({ id: 'me' });
    expect(store.ssoProvider).toBeNull();
    expect(electronAuth.saveToken).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/ignored: already signed in/) }));
  });

  it('SECURITY: an error result while signed in is ignored - no navigation, no error banner', async () => {
    const store = useAuthStore();
    store.isAuthenticated = true;
    store.token = 'current';
    const router = fakeRouter('record');
    const handle = createSSOResultHandler({ getAuthStore: () => store, router });

    await handle({ error: 'Login failed', code: 'sso_failed', bound: true });

    expect(router.push).not.toHaveBeenCalled();
    expect(store.error).toBeNull();
    expect(store.ssoOutcome.seq).toBe(0);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('the store refuses an SSO result for a signed-in session on its own as well', async () => {
    const store = useAuthStore();
    store.isAuthenticated = true;
    store.token = 'current';
    const result = await store.completeSSO({ token: 'other', user: { id: 'x' }, bound: true });
    expect(result).toMatchObject({ success: false, ignored: true });
    expect(store.token).toBe('current');
  });

  it('a password sign-in ends the SSO wait and drops a result main still buffers', async () => {
    const takePendingSSO = vi.fn(async () => ({ token: 'stale', user: { id: 's' } }));
    electronAuth.takePendingSSO = takePendingSSO;
    electronAuth.login = vi.fn(async () => ({ success: true, token: 'pw', user: { id: 'me' }, minutes: { remaining: 5 } }));
    try {
      const store = useAuthStore();
      store.beginSSO('google');
      await store.login('a@b.ch', 'secret');
      expect(store.ssoProvider).toBeNull();
      expect(takePendingSSO).toHaveBeenCalled();
      expect(store.token).toBe('pw');
    } finally {
      delete electronAuth.takePendingSSO;
      delete electronAuth.login;
    }
  });

  it('closes the in-app browser on mobile', async () => {
    const store = useAuthStore();
    const closeBrowser = vi.fn(async () => {});
    const handle = createSSOResultHandler({ getAuthStore: () => store, router: fakeRouter(), closeBrowser });
    await handle({ error: 'x', code: 'sso_failed', bound: true });
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });
});

describe('SECURITY: SSO results are bound to a sign-in this app started', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('desktop: a result main did not bind (crafted link) is ignored while signed out', async () => {
    const store = useAuthStore();
    store.beginSSO('microsoft');
    const result = await store.completeSSO({ token: jwt('evil'), user: { id: 'evil' } });
    expect(result).toMatchObject({ success: false, ignored: true, reason: 'unbound_result' });
    expect(store.isAuthenticated).toBe(false);
    expect(electronAuth.saveToken).not.toHaveBeenCalled();
    // The real result of the sign-in in progress is still awaited.
    expect(store.ssoProvider).toBe('microsoft');
  });

  it('an unbound error result shows nothing', async () => {
    const store = useAuthStore();
    const result = await store.completeSSO({ error: 'x', code: 'sso_failed' });
    expect(result.ignored).toBe(true);
    expect(store.error).toBeNull();
    expect(store.ssoOutcome.seq).toBe(0);
  });

  it('a result whose user is not the token\'s user is refused', async () => {
    const store = useAuthStore();
    const result = await store.completeSSO({ token: jwt('u1'), user: { id: 'someone-else' }, bound: true });
    expect(result.success).toBe(false);
    expect(store.isAuthenticated).toBe(false);
    expect(electronAuth.saveToken).not.toHaveBeenCalled();
  });

  it('only plain profile fields from the URL are kept', async () => {
    const store = useAuthStore();
    await store.completeSSO({ token: jwt('u1'), user: { id: 'u1', email: 'a@b.ch', isAdmin: true, nested: { x: 1 } }, bound: true });
    expect(store.user).toEqual({ id: 'u1', email: 'a@b.ch' });
  });
});

