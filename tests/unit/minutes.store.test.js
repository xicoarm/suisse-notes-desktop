import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const authenticatedRequest = vi.fn();
vi.mock('../../src/services/api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, authenticatedRequest: (...args) => authenticatedRequest(...args) };
});

const { useMinutesStore, isKnownOutOfMinutes, isKnownBelow } = await import('../../src/stores/minutes');

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

describe('minutes store: when may the balance block?', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    authenticatedRequest.mockReset();
    try { localStorage.clear(); } catch { /* no storage */ }
  });

  it('an unknown balance (default 0, never fetched) never blocks', () => {
    const store = useMinutesStore();
    expect(store.remaining).toBe(0);
    expect(store.lastFetchedAt).toBeNull();
    expect(store.knownOutOfMinutes).toBe(false);
    expect(isKnownOutOfMinutes({ remaining: 0, unlimited: false, lastFetchedAt: null })).toBe(false);
  });

  it('a cached balance from an earlier session is shown but not trusted to block', () => {
    localStorage.setItem('minutes_cache', JSON.stringify({ remaining: 0, unlimited: false, total: 60, used: 60, cachedAt: Date.now() - 86400000 }));
    const store = useMinutesStore();
    expect(store.remaining).toBe(0);
    expect(store.balanceKnown).toBe(false);
    expect(store.knownOutOfMinutes).toBe(false);
  });

  it('a server-confirmed 0 blocks; unlimited never does', () => {
    const store = useMinutesStore();
    store.setFromServer({ remaining: 0, total: 60, used: 60, unlimited: false });
    expect(store.knownOutOfMinutes).toBe(true);
    store.setFromServer({ remaining: -1, total: -1, used: 5 });
    expect(store.knownOutOfMinutes).toBe(false);
    expect(isKnownBelow({ remaining: 3, unlimited: false, lastFetchedAt: 1 }, 5)).toBe(true);
    expect(isKnownBelow({ remaining: 3, unlimited: false, lastFetchedAt: null }, 5)).toBe(false);
  });

  it('concurrent fetches share one request', async () => {
    const store = useMinutesStore();
    let answer;
    authenticatedRequest.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const a = store.fetchMinutes('token', true);
    const b = store.fetchMinutes('token', true);
    answer(new Response(JSON.stringify({ remaining: 30, total: 60, used: 30 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await Promise.all([a, b]);
    expect(authenticatedRequest).toHaveBeenCalledTimes(1);
    expect(store.remaining).toBe(30);
    expect(store.knownOutOfMinutes).toBe(false);
  });

  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('a different token never shares the request in flight', async () => {
    const store = useMinutesStore();
    const answers = [];
    authenticatedRequest.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const a = store.fetchMinutes('token-A', true);
    const b = store.fetchMinutes('token-B', true);
    expect(authenticatedRequest).toHaveBeenCalledTimes(2);
    expect(authenticatedRequest.mock.calls.map(c => c[1])).toEqual(['token-A', 'token-B']);
    answers[0](json({ remaining: 1, total: 60, used: 59 }));
    answers[1](json({ remaining: 50, total: 60, used: 10 }));
    await Promise.all([a, b]);
  });

  it('after a logout (reset) the previous session\'s late answer is dropped', async () => {
    const store = useMinutesStore();
    let answerA;
    authenticatedRequest.mockReturnValueOnce(new Promise((resolve) => { answerA = resolve; }));
    const a = store.fetchMinutes('token-A', true);
    store.reset();
    authenticatedRequest.mockResolvedValueOnce(json({ remaining: 50, total: 60, used: 10 }));
    await store.fetchMinutes('token-B', true);
    answerA(json({ remaining: 0, total: 60, used: 60 }));
    const lateResult = await a;
    expect(lateResult).toMatchObject({ success: false, stale: true });
    expect(store.remaining).toBe(50);
    expect(store.knownOutOfMinutes).toBe(false);
  });
});
