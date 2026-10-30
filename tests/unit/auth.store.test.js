import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '../../src/stores/auth';
import { i18n } from '../../src/boot/i18n';

// Sign-in now loads the minutes balance in the background; keep that off the
// network (the real store would call the production API from a test).
const fetchMinutes = vi.fn(async () => ({ success: true }));
vi.mock('../../src/stores/minutes', () => ({
  useMinutesStore: () => ({ fetchMinutes, setFromServer: vi.fn(), reset: vi.fn() })
}));

const en = (key) => i18n.global.getLocaleMessage('en')[key];

// Mock electronAPI
const mockElectronAPI = {
  auth: {
    login: vi.fn(),
    register: vi.fn(),
    getToken: vi.fn(),
    getUserInfo: vi.fn(),
    // Main's session authority applies sign-ins itself (answers carry its
    // epoch); the renderer can only restore, read and sign out.
    restoreSession: vi.fn(),
    currentSession: vi.fn(),
    signOut: vi.fn()
  }
};

// Set up global mock
// performance: vue-i18n marks its message lookups with window.performance;
// without it every translation fails and returns the bare key.
vi.stubGlobal('window', {
  electronAPI: mockElectronAPI,
  performance: globalThis.performance
});

describe('Auth Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    localStorage.clear(); // no sign-out marker from an earlier test
  });

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const store = useAuthStore();
      expect(store.user).toBeNull();
      expect(store.token).toBeNull();
      expect(store.isAuthenticated).toBe(false);
      expect(store.sessionChecked).toBe(false);
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });
  });

  describe('login', () => {
    it('should successfully login and store credentials', async () => {
      const store = useAuthStore();
      const mockUser = { id: '123', email: 'test@example.com', name: 'Test User' };
      const mockToken = 'test-token-123';

      mockElectronAPI.auth.login.mockResolvedValue({
        success: true,
        user: mockUser,
        token: mockToken,
        epoch: 1
      });

      const result = await store.login('test@example.com', 'password123');

      expect(result.success).toBe(true);
      expect(store.user).toEqual(mockUser);
      expect(store.token).toBe(mockToken);
      expect(store.isAuthenticated).toBe(true);
      expect(store.error).toBeNull();
      store.stopTokenRefresh();
    });

    it('a result main dropped (session changed meanwhile) signs nothing in', async () => {
      const store = useAuthStore();
      mockElectronAPI.auth.login.mockResolvedValue({ success: false, ignored: true, reason: 'session_changed' });
      const result = await store.login('test@example.com', 'password123');
      expect(result).toMatchObject({ success: false, ignored: true });
      expect(store.isAuthenticated).toBe(false);
      expect(store.token).toBeNull();
    });

    it('a success without main\'s epoch is never mirrored', async () => {
      const store = useAuthStore();
      mockElectronAPI.auth.login.mockResolvedValue({ success: true, user: { id: 'u1' }, token: 'tok' });
      const result = await store.login('a@b.ch', 'x');
      expect(result).toMatchObject({ success: false, ignored: true });
      expect(store.isAuthenticated).toBe(false);
    });

    it('should handle login failure with a translated text, never the server sentence', async () => {
      const store = useAuthStore();
      i18n.global.locale.value = 'en';

      mockElectronAPI.auth.login.mockResolvedValue({
        success: false,
        status: 401,
        serverError: 'Invalid credentials'
      });

      const result = await store.login('test@example.com', 'wrongpassword');

      expect(result.success).toBe(false);
      expect(result.error).toBe(en('loginInvalidCredentials'));
      expect(result.reason).toBe('status_401');
      expect(store.isAuthenticated).toBe(false);
      expect(store.error).not.toBe('Invalid credentials');
    });

    it('prefers the backend code: use_sso names the provider button', async () => {
      const store = useAuthStore();
      i18n.global.locale.value = 'de';
      mockElectronAPI.auth.login.mockResolvedValue({ success: false, status: 400, code: 'use_sso', provider: 'google' });

      const result = await store.login('a@b.ch', 'x');

      expect(result.error).toBe(i18n.global.getLocaleMessage('de').loginUseSsoGoogle);
      expect(result.reason).toBe('use_sso');
      i18n.global.locale.value = 'en';
    });

    it('treats a gateway page during a restart as "briefly unavailable", not as wrong credentials', async () => {
      const store = useAuthStore();
      i18n.global.locale.value = 'en';
      mockElectronAPI.auth.login.mockResolvedValue({ success: false, status: 502, nonJson: true });

      const result = await store.login('a@b.ch', 'x');

      expect(result.error).toBe(en('authServiceUnavailable'));
      expect(result.error).not.toBe(en('loginInvalidCredentials'));
    });

    it('loads the minutes balance when the login answer has none', async () => {
      const store = useAuthStore();
      mockElectronAPI.auth.login.mockResolvedValue({ success: true, user: { id: 'u1' }, token: 'tok', epoch: 1 });

      await store.login('a@b.ch', 'x');
      store.stopTokenRefresh();
      await vi.waitFor(() => expect(fetchMinutes).toHaveBeenCalledWith('tok', true));
    });

    it('should handle network errors', async () => {
      const store = useAuthStore();

      mockElectronAPI.auth.login.mockRejectedValue(new Error('Network error'));

      const result = await store.login('test@example.com', 'password123');

      expect(result.success).toBe(false);
      // Network failures surface as the translated "no internet" message,
      // not the raw transport error.
      expect(result.error).toMatch(/internet|network|internet/i);
      expect(result.error).not.toBe('Network error');
      expect(store.isAuthenticated).toBe(false);
    });

    it('should set loading state during login', async () => {
      const store = useAuthStore();

      mockElectronAPI.auth.login.mockImplementation(() => {
        expect(store.loading).toBe(true);
        return Promise.resolve({ success: true, user: {}, token: 'token', epoch: 1 });
      });

      await store.login('test@example.com', 'password123');
      expect(store.loading).toBe(false);
    });
  });

  describe('register', () => {
    it('should successfully register and store credentials', async () => {
      const store = useAuthStore();
      const mockUser = { id: '123', email: 'new@example.com', name: 'New User' };
      const mockToken = 'new-token-123';

      mockElectronAPI.auth.register.mockResolvedValue({
        success: true,
        user: mockUser,
        token: mockToken,
        epoch: 1
      });

      const result = await store.register('new@example.com', 'password123', 'New User');

      expect(result.success).toBe(true);
      expect(store.user).toEqual(mockUser);
      expect(store.isAuthenticated).toBe(true);
    });

    it('should handle registration failure: 409 says "account exists" and keeps the reset hint', async () => {
      const store = useAuthStore();
      i18n.global.locale.value = 'en';

      mockElectronAPI.auth.register.mockResolvedValue({
        success: false,
        status: 409,
        serverError: 'User with this email already exists.'
      });

      const result = await store.register('existing@example.com', 'password123', 'User');

      expect(result.success).toBe(false);
      expect(result.error).toBe(en('registerAccountExists'));
      expect(result.error).toMatch(/Forgot Password/);
      expect(result.reason).toBe('status_409');
    });

    it('loads the minutes balance of the new account', async () => {
      const store = useAuthStore();
      mockElectronAPI.auth.register.mockResolvedValue({ success: true, user: { id: 'n1' }, token: 'new-tok', epoch: 1 });

      await store.register('n@b.ch', 'password123', 'N');
      await vi.waitFor(() => expect(fetchMinutes).toHaveBeenCalledWith('new-tok', true));
    });
  });

  describe('logout', () => {
    it('should clear all auth state', async () => {
      const store = useAuthStore();

      // Set up authenticated state
      store.user = { id: '123' };
      store.token = 'test-token';
      store.isAuthenticated = true;

      mockElectronAPI.auth.signOut.mockResolvedValue({ success: true, epoch: 2 });

      // Mock the dynamic import
      vi.mock('../../src/stores/recordings-history', () => ({
        useRecordingsHistoryStore: () => ({
          reset: vi.fn()
        })
      }));

      await store.logout();

      expect(store.user).toBeNull();
      expect(store.token).toBeNull();
      expect(store.isAuthenticated).toBe(false);
      expect(mockElectronAPI.auth.signOut).toHaveBeenCalled();
      expect(store.error).toBeNull();
    });

    it('E5: a sign-out main could not confirm is shown to the user; the state is signed out', async () => {
      const store = useAuthStore();
      i18n.global.locale.value = 'en';
      store.user = { id: '123' };
      store.token = 'test-token';
      store.isAuthenticated = true;
      mockElectronAPI.auth.signOut.mockResolvedValue({ success: false, error: 'sign_out_incomplete', epoch: 3 });
      expect(await store.logout()).toEqual({ success: false });
      expect(store.isAuthenticated).toBe(false);
      expect(store.token).toBeNull();
      expect(store.error).toBe(en('signOutIncomplete'));
    });
  });

  describe('checkSession', () => {
    it('should restore session from stored credentials', async () => {
      const store = useAuthStore();
      const mockUser = { id: '123', email: 'test@example.com' };
      const mockToken = 'stored-token';

      mockElectronAPI.auth.restoreSession.mockResolvedValue({ signedOut: false, epoch: 4, token: mockToken, user: mockUser });

      await store.checkSession();
      store.stopTokenRefresh();

      expect(store.token).toBe(mockToken);
      expect(store.user).toEqual(mockUser);
      expect(store.isAuthenticated).toBe(true);
      expect(store.sessionChecked).toBe(true);
    });

    it('a start main reports as signed out restores nothing', async () => {
      const store = useAuthStore();
      mockElectronAPI.auth.restoreSession.mockResolvedValue({ signedOut: true, epoch: 9 });
      await store.checkSession();
      expect(store.isAuthenticated).toBe(false);
      expect(store.token).toBeNull();
      expect(mockElectronAPI.auth.getToken).not.toHaveBeenCalled();
    });

    it('should not authenticate without stored credentials', async () => {
      const store = useAuthStore();

      mockElectronAPI.auth.restoreSession.mockResolvedValue(null);

      await store.checkSession();

      expect(store.isAuthenticated).toBe(false);
      expect(store.sessionChecked).toBe(true);
    });

    it('signs out when main reports token and user of different accounts', async () => {
      const store = useAuthStore();
      mockElectronAPI.auth.restoreSession.mockResolvedValue({ signedOut: true, mismatch: true });
      mockElectronAPI.auth.signOut.mockResolvedValue({ success: true, epoch: 5 });

      await store.checkSession();

      expect(store.isAuthenticated).toBe(false);
      expect(mockElectronAPI.auth.signOut).toHaveBeenCalled();
    });
  });

  describe('clearError', () => {
    it('should clear the error state', () => {
      const store = useAuthStore();
      store.error = 'Some error';

      store.clearError();

      expect(store.error).toBeNull();
    });
  });
});
