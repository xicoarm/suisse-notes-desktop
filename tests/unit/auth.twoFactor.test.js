import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../../src/boot/sentry', () => ({
  addBreadcrumb: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn(), setUser: vi.fn()
}));
// Sign-in only needs the device store's reload hook (the real one is a slow import).
vi.mock('../../src/stores/device', () => ({
  useDeviceStore: () => ({ reloadForUser: vi.fn(async () => {}), onLogout: vi.fn(async () => {}) })
}));
const setFromServer = vi.fn();
vi.mock('../../src/stores/minutes', () => ({
  useMinutesStore: () => ({ fetchMinutes: vi.fn(async () => ({ success: true })), setFromServer, reset: vi.fn() })
}));

const electronAuth = {
  login: vi.fn(),
  verifyTwoFactor: vi.fn(),
  resendTwoFactorEmail: vi.fn(),
  signOut: vi.fn(async () => ({ success: true }))
};
// performance: vue-i18n needs window.performance to translate.
vi.stubGlobal('window', { electronAPI: { auth: electronAuth }, performance: globalThis.performance });

const { useAuthStore } = await import('../../src/stores/auth');
const { i18n } = await import('../../src/boot/i18n');
const en = (key) => i18n.global.getLocaleMessage('en')[key];

const TEMP = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MSJ9.c2lnbmF0dXJl';
// Desktop: main applied the session already; its answer carries the epoch.
const SUCCESS = { success: true, token: 'jwt-1', user: { id: 'u1', email: 'a@b.ch' }, minutes: { remaining: 30 }, epoch: 1 };

describe('password sign-in with the second factor (desktop IPC path)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    i18n.global.locale.value = 'en';
  });

  it('old backend: a success without requiresTwoFactor signs in exactly as before', async () => {
    const store = useAuthStore();
    electronAuth.login.mockResolvedValue(SUCCESS);
    const result = await store.login('a@b.ch', 'pw');
    expect(result).toEqual({ success: true });
    expect(store.isAuthenticated).toBe(true);
    expect(store.twoFactor).toBeNull();
    expect(store.token).toBe('jwt-1');
    expect(setFromServer).toHaveBeenCalledWith({ remaining: 30 });
    expect(electronAuth.verifyTwoFactor).not.toHaveBeenCalled();
    store.stopTokenRefresh();
  });

  it('a 2FA account gets the code step, no session and no error', async () => {
    const store = useAuthStore();
    electronAuth.login.mockResolvedValue({ success: false, requiresTwoFactor: true, twoFactorMethod: 'AUTHENTICATOR', tempToken: TEMP });
    const result = await store.login('a@b.ch', 'pw');
    expect(result).toEqual({ success: false, requiresTwoFactor: true, method: 'AUTHENTICATOR' });
    expect(store.isAuthenticated).toBe(false);
    expect(store.token).toBeNull();
    expect(store.error).toBeNull();
    expect(store.twoFactor).toMatchObject({ method: 'AUTHENTICATOR', tempToken: TEMP });
  });

  it('a correct code continues the normal sign-in (token, minutes)', async () => {
    const store = useAuthStore();
    electronAuth.login.mockResolvedValue({ success: false, requiresTwoFactor: true, twoFactorMethod: 'AUTHENTICATOR', tempToken: TEMP });
    await store.login('a@b.ch', 'pw');
    electronAuth.verifyTwoFactor.mockResolvedValue(SUCCESS);
    const result = await store.verifyTwoFactor(' 123 456 ');
    expect(electronAuth.verifyTwoFactor).toHaveBeenCalledWith(TEMP, '123456', false);
    expect(result).toEqual({ success: true });
    expect(store.isAuthenticated).toBe(true);
    expect(store.twoFactor).toBeNull();
    expect(store.token).toBe('jwt-1');
    expect(setFromServer).toHaveBeenCalledWith({ remaining: 30 });
    store.stopTokenRefresh();
  });

  it('a second-factor success main dropped (sign-out meanwhile) signs nothing in', async () => {
    const store = useAuthStore();
    store.twoFactor = { method: 'AUTHENTICATOR', tempToken: TEMP, resendAvailableAt: 0 };
    electronAuth.verifyTwoFactor.mockResolvedValue({ success: false, ignored: true, reason: 'session_changed' });
    const result = await store.verifyTwoFactor('123456');
    expect(result).toMatchObject({ success: false, ignored: true });
    expect(store.isAuthenticated).toBe(false);
  });

  it('a backup code is sent as such', async () => {
    const store = useAuthStore();
    store.twoFactor = { method: 'EMAIL', tempToken: TEMP, resendAvailableAt: 0 };
    electronAuth.verifyTwoFactor.mockResolvedValue(SUCCESS);
    await store.verifyTwoFactor('a1b2 c3d4', { backup: true });
    expect(electronAuth.verifyTwoFactor).toHaveBeenCalledWith(TEMP, 'A1B2C3D4', true);
  });

  it('a wrong code stays on the step with a translated text', async () => {
    const store = useAuthStore();
    store.twoFactor = { method: 'AUTHENTICATOR', tempToken: TEMP, resendAvailableAt: 0 };
    electronAuth.verifyTwoFactor.mockResolvedValue({ success: false, status: 400, code: 'invalid_code' });
    const result = await store.verifyTwoFactor('111111');
    expect(result).toMatchObject({ success: false, reason: '2fa_invalid_code', next: 'stay' });
    expect(store.error).toBe(en('twoFactorInvalidCode'));
    expect(store.twoFactor).not.toBeNull();
    expect(store.isAuthenticated).toBe(false);
  });

  it.each([
    [{ status: 401, code: 'session_expired' }, 'twoFactorSessionExpired'],
    [{ status: 429, code: 'too_many_attempts' }, 'twoFactorTooManyAttempts']
  ])('%j ends the step: back to the password form with the text', async (failure, key) => {
    const store = useAuthStore();
    store.twoFactor = { method: 'AUTHENTICATOR', tempToken: TEMP, resendAvailableAt: 0 };
    electronAuth.verifyTwoFactor.mockResolvedValue({ success: false, ...failure });
    const result = await store.verifyTwoFactor('222222');
    expect(result.next).toBe('password');
    expect(store.twoFactor).toBeNull();
    expect(store.error).toBe(en(key));
  });

  it('a malformed code never reaches the server', async () => {
    const store = useAuthStore();
    store.twoFactor = { method: 'AUTHENTICATOR', tempToken: TEMP, resendAvailableAt: 0 };
    const result = await store.verifyTwoFactor('12');
    expect(result.success).toBe(false);
    expect(electronAuth.verifyTwoFactor).not.toHaveBeenCalled();
  });

  it('resend: blocked during the 60 s cooldown, then sent and the cooldown restarts', async () => {
    const store = useAuthStore();
    electronAuth.login.mockResolvedValue({ success: false, requiresTwoFactor: true, twoFactorMethod: 'EMAIL', tempToken: TEMP });
    await store.login('a@b.ch', 'pw');
    const early = await store.resendTwoFactorEmail(Date.now());
    expect(early).toMatchObject({ success: false, cooldown: true });
    expect(electronAuth.resendTwoFactorEmail).not.toHaveBeenCalled();

    electronAuth.resendTwoFactorEmail.mockResolvedValue({ success: true });
    const later = await store.resendTwoFactorEmail(Date.now() + 61000);
    expect(later).toEqual({ success: true });
    expect(electronAuth.resendTwoFactorEmail).toHaveBeenCalledWith(TEMP);
    expect(store.twoFactor.resendAvailableAt).toBeGreaterThan(Date.now() + 50000);
  });

  it('resend after the step expired: back to the password form', async () => {
    const store = useAuthStore();
    store.twoFactor = { method: 'EMAIL', tempToken: TEMP, resendAvailableAt: 0 };
    electronAuth.resendTwoFactorEmail.mockResolvedValue({ success: false, status: 401 });
    const result = await store.resendTwoFactorEmail();
    expect(result.next).toBe('password');
    expect(store.twoFactor).toBeNull();
    expect(store.error).toBe(en('twoFactorSessionExpired'));
  });

  it('"back to sign-in" and logout drop the step', async () => {
    const store = useAuthStore();
    store.twoFactor = { method: 'EMAIL', tempToken: TEMP, resendAvailableAt: 0 };
    store.error = 'x';
    store.cancelTwoFactor();
    expect(store.twoFactor).toBeNull();
    expect(store.error).toBeNull();
  });
});

describe('password sign-in with the second factor (mobile/web fetch path)', () => {
  const realWindow = globalThis.window;
  let fetchMock;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    // No electronAPI: the renderer calls the backend itself.
    vi.stubGlobal('window', { performance: globalThis.performance });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.stubGlobal('window', realWindow);
  });

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('announces twoFactor support and handles the challenge, then verify-2fa', async () => {
    const store = useAuthStore();
    fetchMock.mockResolvedValueOnce(json(200, { requiresTwoFactor: true, twoFactorMethod: 'EMAIL', tempToken: TEMP }));
    const login = await store.login('a@b.ch', 'pw');
    expect(login).toEqual({ success: false, requiresTwoFactor: true, method: 'EMAIL' });
    const [loginUrl, loginInit] = fetchMock.mock.calls[0];
    expect(loginUrl).toMatch(/\/api\/auth\/desktop$/);
    expect(JSON.parse(loginInit.body)).toEqual({ email: 'a@b.ch', password: 'pw', twoFactor: 'supported' });

    fetchMock.mockResolvedValueOnce(json(200, { success: true, token: 'jwt-m', user: { id: 'm1' } }));
    const verified = await store.verifyTwoFactor('654321');
    expect(verified).toEqual({ success: true });
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[1];
    expect(verifyUrl).toMatch(/\/api\/auth\/desktop\/verify-2fa$/);
    expect(JSON.parse(verifyInit.body)).toEqual({ tempToken: TEMP, code: '654321', isBackupCode: false });
    expect(store.token).toBe('jwt-m');
  });

  it('old backend success (no requiresTwoFactor) is unchanged', async () => {
    const store = useAuthStore();
    fetchMock.mockResolvedValueOnce(json(200, { success: true, token: 'jwt-old', user: { id: 'o1' } }));
    expect(await store.login('a@b.ch', 'pw')).toEqual({ success: true });
    expect(store.token).toBe('jwt-old');
    expect(store.twoFactor).toBeNull();
  });

  it('code_expired (410) stays on the step; an HTML error page is "briefly unavailable", not "wrong code"', async () => {
    const store = useAuthStore();
    store.twoFactor = { method: 'EMAIL', tempToken: TEMP, resendAvailableAt: 0 };
    fetchMock.mockResolvedValueOnce(json(410, { error: 'expired', code: 'code_expired' }));
    const expired = await store.verifyTwoFactor('123456');
    expect(expired).toMatchObject({ next: 'stay', reason: '2fa_code_expired' });
    expect(store.twoFactor).not.toBeNull();

    // (502-504 are retried by fetchWithTimeout first; a 500 page is not.)
    fetchMock.mockResolvedValueOnce(new Response('<html>500</html>', { status: 500, headers: { 'Content-Type': 'text/html' } }));
    const broken = await store.verifyTwoFactor('123456');
    expect(broken.next).toBe('stay');
    expect(store.error).toBe(i18n.global.t('authServiceUnavailable'));
    expect(store.twoFactor).not.toBeNull();
  });
});
