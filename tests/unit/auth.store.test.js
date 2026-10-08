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
    saveToken: vi.fn(),
    saveUserInfo: vi.fn(),
    getToken: vi.fn(),
    getUserInfo: vi.fn(),
    clearToken: vi.fn()
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
        token: mockToken
      });
      mockElectronAPI.auth.clearToken.mockResolvedValue({ success: true });
      mockElectronAPI.auth.saveToken.mockResolvedValue({ success: true });
      mockElectronAPI.auth.getToken.mockResolvedValue(mockToken);
      mockElectronAPI.auth.saveUserInfo.mockResolvedValue({ success: true });

      const result = await store.login('test@example.com', 'password123');

      expect(result.success).toBe(true);
      expect(store.user).toEqual(mockUser);
      expect(store.token).toBe(mockToken);
      expect(store.isAuthenticated).toBe(true);
      expect(store.error).toBeNull();
      expect(mockElectronAPI.auth.saveToken).toHaveBeenCalledWith(mockToken);
      expect(mockElectronAPI.auth.saveUserInfo).toHaveBeenCalledWith(mockUser);
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
      mockElectronAPI.auth.login.mockResolvedValue({ success: true, user: { id: 'u1' }, token: 'tok' });
      mockElectronAPI.auth.saveToken.mockResolvedValue({ success: true });
      mockElectronAPI.auth.saveUserInfo.mockResolvedValue({ success: true });

      await store.login('a@b.ch', 'x');
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
        return Promise.resolve({ success: true, user: {}, token: 'token' });
      });
      mockElectronAPI.auth.clearToken.mockResolvedValue({ success: true });
      mockElectronAPI.auth.saveToken.mockResolvedValue({ success: true });
      mockElectronAPI.auth.getToken.mockResolvedValue('token');
      mockElectronAPI.auth.saveUserInfo.mockResolvedValue({ success: true });

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
        token: mockToken
      });
      mockElectronAPI.auth.clearToken.mockResolvedValue({ success: true });
      mockElectronAPI.auth.saveToken.mockResolvedValue({ success: true });
      mockElectronAPI.auth.getToken.mockResolvedValue(mockToken);
      mockElectronAPI.auth.saveUserInfo.mockResolvedValue({ success: true });

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
      mockElectronAPI.auth.register.mockResolvedValue({ success: true, user: { id: 'n1' }, token: 'new-tok' });
      mockElectronAPI.auth.saveToken.mockResolvedValue({ success: true });
      mockElectronAPI.auth.saveUserInfo.mockResolvedValue({ success: true });

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

      mockElectronAPI.auth.clearToken.mockResolvedValue({ success: true });

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
      expect(mockElectronAPI.auth.clearToken).toHaveBeenCalled();
    });
  });

  describe('checkSession', () => {
    it('should restore session from stored credentials', async () => {
      const store = useAuthStore();
      const mockUser = { id: '123', email: 'test@example.com' };
      const mockToken = 'stored-token';

      mockElectronAPI.auth.getToken.mockResolvedValue(mockToken);
      mockElectronAPI.auth.getUserInfo.mockResolvedValue(mockUser);

      await store.checkSession();

      expect(store.token).toBe(mockToken);
      expect(store.user).toEqual(mockUser);
      expect(store.isAuthenticated).toBe(true);
      expect(store.sessionChecked).toBe(true);
    });

    it('should not authenticate without stored credentials', async () => {
      const store = useAuthStore();

      mockElectronAPI.auth.getToken.mockResolvedValue(null);
      mockElectronAPI.auth.getUserInfo.mockResolvedValue(null);

      await store.checkSession();

      expect(store.isAuthenticated).toBe(false);
      expect(store.sessionChecked).toBe(true);
    });

    it('should clear token if user info is missing', async () => {
      const store = useAuthStore();

      mockElectronAPI.auth.getToken.mockResolvedValue('orphan-token');
      mockElectronAPI.auth.getUserInfo.mockResolvedValue(null);
      mockElectronAPI.auth.clearToken.mockResolvedValue({ success: true });

      await store.checkSession();

      expect(store.isAuthenticated).toBe(false);
      expect(mockElectronAPI.auth.clearToken).toHaveBeenCalled();
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
