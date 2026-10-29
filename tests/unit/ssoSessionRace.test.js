import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// S4: an SSO result that is still in flight (state binding, code exchange)
// when a password sign-in or a sign-out completes is dropped without any side
// effect - it never replaces or revives a session.

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isMobile: () => true, isIOS: () => false, isAndroid: () => true,
  getPlatform: () => 'android', PlatformConstants: {}
}));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn(), setUser: vi.fn() }));
vi.mock('../../src/stores/device', () => ({ useDeviceStore: () => ({ reloadForUser: vi.fn(async () => {}), onLogout: vi.fn(async () => {}) }) }));
vi.mock('../../src/stores/minutes', () => ({ useMinutesStore: () => ({ fetchMinutes: vi.fn(async () => ({})), setFromServer: vi.fn(), reset: vi.fn() }) }));
vi.mock('../../src/stores/recordings-history', () => ({ useRecordingsHistoryStore: () => ({ reset: vi.fn() }) }));
vi.mock('../../src/stores/transcription-settings', () => ({ useTranscriptionSettingsStore: () => ({ reset: vi.fn() }) }));
vi.mock('../../src/services/upload', () => ({ getMobileUploadQueue: () => [], processMobileUploadQueue: async () => ({}) }));
const exchange = vi.hoisted(() => ({ release: null }));
vi.mock('../../src/services/api', () => ({
  apiRequest: vi.fn(() => new Promise((resolve) => { exchange.release = resolve; })),
  authenticatedRequest: vi.fn(),
  parseJsonSafe: vi.fn(async (r) => r.body),
  getApiUrlSync: () => 'https://api.example',
  API_ENDPOINTS: { refreshToken: '/api/auth/refresh', login: '/api/auth/login' }
}));
const secure = vi.hoisted(() => ({ saved: [] }));
vi.mock('../../src/services/secureStorage', () => ({
  storeToken: vi.fn(async (t) => { secure.saved.push(t); return { success: true }; }),
  storeUserCredentials: vi.fn(async () => ({ success: true })),
  storeSession: vi.fn(async ({ token }) => { secure.saved.push(token); return { success: true, persisted: true }; }),
  loadStoredSession: vi.fn(async () => ({ token: null, userInfo: null })),
  clearAllCredentials: vi.fn(async () => ({ success: true }))
}));

const { useAuthStore } = await import('../../src/stores/auth');
const { beginSsoFlow, clearSsoFlow } = await import('../../src/services/ssoFlow');

const jwt = (userId) => `h.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.s`;
const PASSWORD = { success: true, token: jwt('pw'), user: { id: 'pw' } };

beforeEach(() => {
  setActivePinia(createPinia());
  clearSsoFlow();
  secure.saved.length = 0;
  vi.clearAllMocks();
});

describe('S4: session change while an SSO result is in flight', () => {
  it('legacy callback (token + user): a password sign-in during the state binding wins', async () => {
    const flow = await beginSsoFlow('microsoft');
    const store = useAuthStore();
    store.beginSSO('microsoft');
    const sso = store.completeSSO({ token: jwt('sso'), user: { id: 'sso' }, state: flow.state });
    const pw = store._completePasswordLogin(PASSWORD);
    const result = await sso;
    await pw;
    store.stopTokenRefresh();
    expect(result).toMatchObject({ success: false, ignored: true });
    expect(store.user.id).toBe('pw');
    expect(store.token).toBe(jwt('pw'));
    expect(store.ssoOutcome.seq).toBe(0);
    expect(store.error).toBeNull();
    expect(secure.saved).not.toContain(jwt('sso'));
  });

  it('code exchange: a password sign-in while the exchange runs wins; the exchanged session is never applied', async () => {
    const flow = await beginSsoFlow('google');
    const store = useAuthStore();
    store.beginSSO('google');
    const sso = store.completeSSO({ authCode: 'one-time', state: flow.state });
    await vi.waitFor(() => expect(exchange.release).toBeTypeOf('function'));
    await store._completePasswordLogin(PASSWORD);
    exchange.release({ ok: true, body: { token: jwt('sso'), user: { id: 'sso' } } });
    const result = await sso;
    store.stopTokenRefresh();
    expect(result).toMatchObject({ success: false, ignored: true });
    expect(store.user.id).toBe('pw');
    expect(store.ssoOutcome.seq).toBe(0);
    expect(secure.saved).not.toContain(jwt('sso'));
    exchange.release = null;
  });

  it('code exchange: a sign-in and sign-out meanwhile (signed out again) still drops the result', async () => {
    const flow = await beginSsoFlow('google');
    const store = useAuthStore();
    const sso = store.completeSSO({ authCode: 'one-time', state: flow.state });
    await vi.waitFor(() => expect(exchange.release).toBeTypeOf('function'));
    await store._completePasswordLogin(PASSWORD);
    await store.logout();
    exchange.release({ ok: true, body: { token: jwt('sso'), user: { id: 'sso' } } });
    expect(await sso).toMatchObject({ ignored: true });
    expect(store.isAuthenticated).toBe(false);
    expect(store.error).toBeNull();
    exchange.release = null;
  });
});
