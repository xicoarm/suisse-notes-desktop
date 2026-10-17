import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { isExpectedHttpAnswer } from '../../src/utils/sentryCapture';
import { describeTwoFactorFailure } from '../../src/utils/twoFactor';
import { describeLoginFailure, describeRegisterFailure } from '../../src/utils/authErrors';

vi.mock('../../src/boot/sentry', () => ({
  addBreadcrumb: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn(), setUser: vi.fn()
}));
vi.mock('../../src/stores/device', () => ({
  useDeviceStore: () => ({ reloadForUser: vi.fn(async () => {}), onLogout: vi.fn(async () => {}) })
}));
vi.mock('../../src/stores/minutes', () => ({
  useMinutesStore: () => ({ fetchMinutes: vi.fn(async () => ({ success: true })), setFromServer: vi.fn(), reset: vi.fn() })
}));
vi.mock('../../src/stores/recordings-history', () => ({ useRecordingsHistoryStore: () => ({ reset: vi.fn() }) }));
vi.mock('../../src/stores/transcription-settings', () => ({ useTranscriptionSettingsStore: () => ({ reset: vi.fn() }) }));

const electronAuth = {
  verifyTwoFactor: vi.fn(),
  saveToken: vi.fn(async () => ({ success: true })),
  saveUserInfo: vi.fn(async () => ({ success: true })),
  clearToken: vi.fn(async () => ({ success: true }))
};
vi.stubGlobal('window', { electronAPI: { auth: electronAuth }, performance: globalThis.performance });

const { useAuthStore } = await import('../../src/stores/auth');

const TEMP = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MSJ9.c2lnbmF0dXJl';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe('review: a late verify answer after "back to sign-in" is ignored', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('a late success does not sign in', async () => {
    const store = useAuthStore();
    store.twoFactor = { method: 'AUTHENTICATOR', tempToken: TEMP, resendAvailableAt: 0 };
    const answer = deferred();
    electronAuth.verifyTwoFactor.mockReturnValue(answer.promise);
    const pending = store.verifyTwoFactor('123456');
    store.cancelTwoFactor();
    answer.resolve({ success: true, token: 'jwt-late', user: { id: 'u1' } });
    const result = await pending;
    expect(result).toMatchObject({ success: false, ignored: true });
    expect(store.isAuthenticated).toBe(false);
    expect(store.token).toBeNull();
    expect(electronAuth.saveToken).not.toHaveBeenCalled();
  });

  it('a late error does not appear on the password form', async () => {
    const store = useAuthStore();
    store.twoFactor = { method: 'AUTHENTICATOR', tempToken: TEMP, resendAvailableAt: 0 };
    const answer = deferred();
    electronAuth.verifyTwoFactor.mockReturnValue(answer.promise);
    const pending = store.verifyTwoFactor('123456');
    store.cancelTwoFactor();
    answer.resolve({ success: false, status: 400, code: 'invalid_code' });
    const result = await pending;
    expect(result.ignored).toBe(true);
    expect(store.error).toBeNull();
    expect(store.loading).toBe(false);
  });

  it('a new step (new password sign-in) is not touched by the old step\'s answer', async () => {
    const store = useAuthStore();
    store.twoFactor = { method: 'AUTHENTICATOR', tempToken: TEMP, resendAvailableAt: 0 };
    const answer = deferred();
    electronAuth.verifyTwoFactor.mockReturnValue(answer.promise);
    const pending = store.verifyTwoFactor('123456');
    const newStep = { method: 'EMAIL', tempToken: `${TEMP}x`, resendAvailableAt: 0 };
    store.twoFactor = newStep;
    answer.resolve({ success: false, status: 401, code: 'session_expired' });
    await pending;
    expect(store.twoFactor).toEqual(newStep); // still the new step (Pinia proxies it)
    expect(store.error).toBeNull();
  });
});

describe('review: logout clears the second-factor step', () => {
  it('drops twoFactor', async () => {
    setActivePinia(createPinia());
    const store = useAuthStore();
    store.twoFactor = { method: 'EMAIL', tempToken: TEMP, resendAvailableAt: 0 };
    await store.logout();
    expect(store.twoFactor).toBeNull();
  });
});

describe('review: nginx 429 page (HTML) is "too many attempts", not "unavailable"', () => {
  it('second factor', () => {
    expect(describeTwoFactorFailure({ status: 429, nonJson: true }))
      .toEqual({ key: 'twoFactorTooManyAttempts', reason: '2fa_status_429', next: 'password' });
    expect(describeTwoFactorFailure({ status: 429, code: 'too_many_attempts' }).reason).toBe('2fa_too_many_attempts');
    expect(describeTwoFactorFailure({ status: 503, nonJson: true }).key).toBe('authServiceUnavailable');
  });

  it('password sign-in and registration', () => {
    expect(describeLoginFailure({ status: 429, nonJson: true })).toEqual({ key: 'authTooManyAttempts', reason: 'status_429' });
    expect(describeRegisterFailure({ status: 429, nonJson: true }).key).toBe('authTooManyAttempts');
    expect(describeLoginFailure({ status: 502, nonJson: true }).key).toBe('authServiceUnavailable');
  });
});

describe('review: expected second-factor answers never become Sentry events', () => {
  const httpEvent = (url, status) => ({
    exception: { values: [{ type: 'Error', value: `HTTP Client Error with status code: ${status}`, mechanism: { type: 'http.client', handled: false } }] },
    request: { url, method: 'POST' },
    contexts: { response: { status_code: status } }
  });

  it('drops 400/410/429 of verify-2fa and 429 of resend', () => {
    for (const status of [400, 410, 429]) {
      expect(isExpectedHttpAnswer(httpEvent('https://app.suisse-meets.ch/api/auth/desktop/verify-2fa', status))).toBe(true);
    }
    expect(isExpectedHttpAnswer(httpEvent('https://app.suisse-meets.ch/api/auth/resend-2fa-email', 429))).toBe(true);
  });

  it('keeps real failures and other endpoints', () => {
    expect(isExpectedHttpAnswer(httpEvent('https://app.suisse-meets.ch/api/auth/desktop/verify-2fa', 500))).toBe(false);
    expect(isExpectedHttpAnswer(httpEvent('https://app.suisse-meets.ch/api/auth/desktop/verify-2fa', 403))).toBe(false);
    expect(isExpectedHttpAnswer(httpEvent('https://app.suisse-meets.ch/api/auth/resend-2fa-email', 400))).toBe(false);
    expect(isExpectedHttpAnswer(httpEvent('https://app.suisse-meets.ch/api/desktop/upload', 400))).toBe(false);
    expect(isExpectedHttpAnswer(httpEvent('https://app.suisse-meets.ch/api/auth/desktop/verify-2fa-other', 400))).toBe(false);
    // Not an HTTP-client event at all.
    expect(isExpectedHttpAnswer({ message: 'x', request: { url: '/api/auth/desktop/verify-2fa' }, contexts: { response: { status_code: 400 } } })).toBe(false);
  });

  it('the app beforeSend drops them', async () => {
    const actual = await vi.importActual('../../src/boot/sentry');
    expect(actual.appBeforeSend(httpEvent('https://app.suisse-meets.ch/api/auth/desktop/verify-2fa', 400), {}, null)).toBeNull();
    expect(actual.appBeforeSend(httpEvent('https://app.suisse-meets.ch/api/auth/desktop/verify-2fa', 500), {}, null)).not.toBeNull();
  });
});
