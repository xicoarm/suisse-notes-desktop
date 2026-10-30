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
// Real session authority over a fake keystore: what lands in the keystore is
// what a restart would restore.
const ks = vi.hoisted(() => new Map());
vi.mock('@capacitor/core', () => {
  const keystore = {
    get: async ({ key }) => ({ value: ks.has(key) ? ks.get(key) : null }),
    set: async ({ key, value }) => { ks.set(key, value); },
    remove: async ({ key }) => { ks.delete(key); }
  };
  return { registerPlugin: () => new Proxy({}, { get: (_, p) => (typeof keystore[p] === 'function' ? keystore[p] : undefined) }) };
});
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), remove: async () => {}, set: async () => {} } }));

let useAuthStore;
let beginSsoFlow;
let sessionTicket;

const jwt = (userId) => `h.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.s`;
const PASSWORD = { success: true, token: jwt('pw'), user: { id: 'pw' } };

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  ks.clear();
  setActivePinia(createPinia());
  ({ useAuthStore } = await import('../../src/stores/auth'));
  ({ beginSsoFlow } = await import('../../src/services/ssoFlow'));
  ({ sessionTicket } = await import('../../src/services/sessionAuthority'));
  vi.clearAllMocks();
});

describe('S4: session change while an SSO result is in flight', () => {
  it('legacy callback (token + user): a password sign-in during the state binding wins', async () => {
    const flow = await beginSsoFlow('microsoft');
    const store = useAuthStore();
    store.beginSSO('microsoft');
    const sso = store.completeSSO({ token: jwt('sso'), user: { id: 'sso' }, state: flow.state });
    const pw = store._completePasswordLogin(PASSWORD, sessionTicket());
    const result = await sso;
    await pw;
    store.stopTokenRefresh();
    expect(result).toMatchObject({ success: false, ignored: true });
    expect(store.user.id).toBe('pw');
    expect(store.token).toBe(jwt('pw'));
    expect(store.ssoOutcome.seq).toBe(0);
    expect(store.error).toBeNull();
    expect(ks.get('authToken')).toBe(jwt('pw'));
  });

  it('code exchange: a password sign-in while the exchange runs wins; the exchanged session is never applied', async () => {
    const flow = await beginSsoFlow('google');
    const store = useAuthStore();
    store.beginSSO('google');
    const sso = store.completeSSO({ authCode: 'one-time', state: flow.state });
    await vi.waitFor(() => expect(exchange.release).toBeTypeOf('function'));
    await store._completePasswordLogin(PASSWORD, sessionTicket());
    exchange.release({ ok: true, body: { token: jwt('sso'), user: { id: 'sso' } } });
    const result = await sso;
    store.stopTokenRefresh();
    expect(result).toMatchObject({ success: false, ignored: true });
    expect(store.user.id).toBe('pw');
    expect(store.ssoOutcome.seq).toBe(0);
    expect(ks.get('authToken')).toBe(jwt('pw'));
    exchange.release = null;
  });

  it('code exchange: a sign-in and sign-out meanwhile (signed out again) still drops the result', async () => {
    const flow = await beginSsoFlow('google');
    const store = useAuthStore();
    const sso = store.completeSSO({ authCode: 'one-time', state: flow.state });
    await vi.waitFor(() => expect(exchange.release).toBeTypeOf('function'));
    await store._completePasswordLogin(PASSWORD, sessionTicket());
    await store.logout();
    exchange.release({ ok: true, body: { token: jwt('sso'), user: { id: 'sso' } } });
    expect(await sso).toMatchObject({ ignored: true });
    expect(store.isAuthenticated).toBe(false);
    expect(store.error).toBeNull();
    exchange.release = null;
  });
});
