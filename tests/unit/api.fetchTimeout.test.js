import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  getPlatform: () => 'ios',
}));

import { fetchWithTimeout, apiRequest, API_REQUEST_TIMEOUT_MS } from '../../src/services/api';

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('aborts a request that never answers and rejects with a retryable timeout error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const p = fetchWithTimeout('https://api.test/x', { timeoutMs: 1000 });
    const assertion = expect(p).rejects.toMatchObject({ name: 'TimeoutError', code: 'ETIMEDOUT' });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes a normal response through untouched and clears the timer', async () => {
    const response = { ok: true, status: 200 };
    vi.stubGlobal('fetch', vi.fn(async () => response));
    expect(await fetchWithTimeout('https://api.test/x', { timeoutMs: 1000 })).toBe(response);
  });

  it('honours a caller-provided abort signal', async () => {
    const fetchMock = vi.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const p = fetchWithTimeout('https://api.test/x', { signal: controller.signal, timeoutMs: 60000 });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('apiRequest applies the default 30s deadline and JSON headers', async () => {
    const fetchMock = vi.fn(async (url, opts) => ({ ok: true, url, opts }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await apiRequest('/api/auth/refresh', { method: 'POST' });
    expect(res.url).toBe('https://app.suisse-meets.ch/api/auth/refresh');
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(API_REQUEST_TIMEOUT_MS).toBe(30000);
  });
});
