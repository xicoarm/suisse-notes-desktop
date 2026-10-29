import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// S3: an SSO result that is not bound to a sign-in this app started (no or a
// foreign state) has zero side effects in the app-wide handler: the in-app
// browser stays open, the page stays where it is, the store is unchanged.

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isMobile: () => true, isIOS: () => false, isAndroid: () => true,
  getPlatform: () => 'android', PlatformConstants: {}
}));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn(), setUser: vi.fn() }));
vi.mock('../../src/stores/device', () => ({ useDeviceStore: () => ({ reloadForUser: vi.fn(async () => {}), onLogout: vi.fn(async () => {}) }) }));
vi.mock('../../src/stores/minutes', () => ({ useMinutesStore: () => ({ fetchMinutes: vi.fn(async () => ({})), setFromServer: vi.fn(), reset: vi.fn() }) }));

const { useAuthStore } = await import('../../src/stores/auth');
const { createSSOResultHandler } = await import('../../src/boot/sso');
const { beginSsoFlow, hasPendingSsoFlow, clearSsoFlow } = await import('../../src/services/ssoFlow');

const jwt = (userId) => `h.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.s`;

function fakeRouter(name) {
  const router = {
    currentRoute: { value: { name } },
    isReady: vi.fn(async () => {}),
    push: vi.fn(async (path) => { router.currentRoute.value = { name: path.replace('/', '') }; })
  };
  return router;
}

describe('SSO handler: an unbound callback has no side effect (mobile)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearSsoFlow();
    vi.clearAllMocks();
  });

  for (const [label, extra] of [['without state', {}], ['with a foreign state', { state: 'foreign-state' }]]) {
    it(`a success ${label} on /register: no closeBrowser, no navigation, no store change`, async () => {
      await beginSsoFlow('google');
      const store = useAuthStore();
      store.beginSSO('google');
      const before = JSON.stringify(store.$state);
      const router = fakeRouter('register');
      const closeBrowser = vi.fn(async () => {});
      const handle = createSSOResultHandler({ getAuthStore: () => store, router, closeBrowser });
      await handle({ token: jwt('mallory'), user: { id: 'mallory' }, ...extra });
      await handle({ error: 'access_denied', code: 'sso_cancelled', ...extra });
      expect(closeBrowser).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.currentRoute.value.name).toBe('register');
      expect(JSON.stringify(store.$state)).toBe(before);
      expect(store.isAuthenticated).toBe(false);
      expect(hasPendingSsoFlow()).toBe(true);
    });
  }

  it('the echo of the real state is applied (browser closed, error page)', async () => {
    const flow = await beginSsoFlow('google');
    const store = useAuthStore();
    store.beginSSO('google');
    const router = fakeRouter('register');
    const closeBrowser = vi.fn(async () => {});
    const handle = createSSOResultHandler({ getAuthStore: () => store, router, closeBrowser });
    await handle({ error: 'server_error', state: flow.state });
    expect(closeBrowser).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/login');
    expect(hasPendingSsoFlow()).toBe(false);
  });
});
