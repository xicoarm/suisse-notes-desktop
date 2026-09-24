import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const authenticatedRequest = vi.fn();
vi.mock('../../src/services/api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, authenticatedRequest: (...args) => authenticatedRequest(...args) };
});

const { useMinutesStore } = await import('../../src/stores/minutes');

const htmlResponse = (status) => new Response(
  '<html>\r\n<head><title>502 Bad Gateway</title></head><body>nginx</body></html>',
  { status, headers: { 'Content-Type': 'text/html' } }
);

describe('minutes store: fetchMinutes', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    authenticatedRequest.mockReset();
  });

  it('treats an nginx 502 HTML page as transient (warn, no JSON SyntaxError, cached balance kept)', async () => {
    const store = useMinutesStore();
    store.setFromServer({ remaining: 42, total: 100, used: 58, unlimited: false });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    authenticatedRequest.mockResolvedValue(htmlResponse(502));

    const result = await store.fetchMinutes('token', true);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unexpected server response (HTTP 502)');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(store.remaining).toBe(42);
  });

  it('treats a 200 with an HTML body (captive portal) as transient', async () => {
    const store = useMinutesStore();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    authenticatedRequest.mockResolvedValue(htmlResponse(200));

    const result = await store.fetchMinutes('token', true);

    expect(result.success).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('applies a normal JSON response', async () => {
    const store = useMinutesStore();
    authenticatedRequest.mockResolvedValue(new Response(
      JSON.stringify({ remaining: 10, total: 60, used: 50, unlimited: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    const result = await store.fetchMinutes('token', true);

    expect(result.success).toBe(true);
    expect(store.remaining).toBe(10);
  });
});
