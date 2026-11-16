import { describe, it, expect, afterEach, vi } from 'vitest';

// Phones ask the server over HTTP (no main process): the answer's `apple`
// flag decides whether the Apple button shows.
const api = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  parseJsonSafe: vi.fn(async (response) => response.json)
}));
vi.mock('../../src/services/api', () => api);

const { fetchLoginMode, discoverSignIn } = await import('../../src/services/loginDiscovery');

function answer(status, json) {
  api.apiRequest.mockResolvedValueOnce({ status, json });
}

afterEach(() => {
  delete window.Capacitor;
  vi.clearAllMocks();
});

describe('login mode on phones (HTTP): the Apple flag', () => {
  it('true only when the server says true', async () => {
    answer(200, { mode: 'identifier-first', apple: true });
    await expect(fetchLoginMode()).resolves.toEqual({ mode: 'identifier-first', testOptIn: false, apple: true });
    expect(api.apiRequest).toHaveBeenCalledWith('/api/auth/login-mode', expect.objectContaining({ method: 'GET' }));
  });

  it('an older server without the field, odd values, errors and 404 are false', async () => {
    answer(200, { mode: 'classic' });
    await expect(fetchLoginMode()).resolves.toEqual({ mode: 'classic', testOptIn: false, apple: false });
    answer(200, { mode: 'classic', apple: 'true' });
    await expect(fetchLoginMode()).resolves.toEqual({ mode: 'classic', testOptIn: false, apple: false });
    answer(404, { apple: true });
    await expect(fetchLoginMode()).resolves.toEqual({ mode: 'classic', testOptIn: false, apple: false });
    api.apiRequest.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchLoginMode()).resolves.toEqual({ mode: 'classic', testOptIn: false, apple: false });
  });

  it('discover from the iPhone app: Apple with its start route is a sign-in', async () => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
    answer(200, { next: 'apple', start: '/api/auth/apple/login' });
    await expect(discoverSignIn('Anna@Firma.ch')).resolves.toEqual({ kind: 'sso', provider: 'apple' });
    const [, options] = api.apiRequest.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ email: 'anna@firma.ch', client: 'ios' });
    answer(200, { next: 'apple' });
    await expect(discoverSignIn('anna@firma.ch')).resolves.toEqual({ kind: 'apple' });
  });
});
