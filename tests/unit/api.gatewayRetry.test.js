import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  getPlatform: () => 'ios',
}));

const captureMessage = vi.fn();
vi.mock('../../src/boot/sentry', () => ({ captureMessage: (...a) => captureMessage(...a) }));

import {
  fetchWithTimeout,
  apiRequest,
  readJson,
  parseJsonSafe,
  apiErrorFromResponse,
  ApiResponseError,
  isTransientApiError,
  gatewayRetryDelay,
  pathTemplate,
  GATEWAY_RETRY_DELAYS_MS,
} from '../../src/services/api';

const NGINX_502 = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>';
const html = (status, headers = {}) => new Response(NGINX_502, { status, headers: { 'Content-Type': 'text/html', ...headers } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const NO_WAIT = [0, 0, 0, 0];

describe('fetchWithTimeout gateway retries (ELECTRON-6E/6F)', () => {
  beforeEach(() => captureMessage.mockReset());
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('rides out a backend restart: GET 502, 502, then 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(html(502))
      .mockResolvedValueOnce(html(502))
      .mockResolvedValueOnce(json({ remaining: 5 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithTimeout('https://api.test/api/desktop/minutes', { retryDelaysMs: NO_WAIT });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ remaining: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('waits 1, 2, 4, 8 s by default before giving up with the last gateway answer', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => html(503));
    vi.stubGlobal('fetch', fetchMock);
    expect(GATEWAY_RETRY_DELAYS_MS).toEqual([1000, 2000, 4000, 8000]);
    const p = fetchWithTimeout('https://api.test/api/desktop/history?cursor=abc');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);
    const res = await p;
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await vi.waitFor(() => expect(captureMessage).toHaveBeenCalledTimes(1));
    const [message, level, context] = captureMessage.mock.calls[0];
    expect(message).toBe('Backend unavailable: GET /api/desktop/history answered HTTP 503 after 5 attempts');
    expect(level).toBe('warning');
    expect(context.fingerprint).toEqual(['backend-unavailable', '503']);
  });

  it('does not resend a POST unless the caller opts in', async () => {
    const fetchMock = vi.fn(async () => html(502));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithTimeout('https://api.test/api/desktop/recording', { method: 'POST', retryDelaysMs: NO_WAIT });
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(html(502)).mockResolvedValueOnce(json({ token: 't' }));
    const ok = await fetchWithTimeout('https://api.test/api/auth/desktop', { method: 'POST', retryGateway: true, retryDelaysMs: NO_WAIT });
    expect(ok.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries non-gateway answers (500 is a backend bug, 404/401 are verdicts)', async () => {
    for (const status of [500, 404, 401, 429]) {
      const fetchMock = vi.fn(async () => json({ error: 'x' }, status));
      vi.stubGlobal('fetch', fetchMock);
      const res = await fetchWithTimeout('https://api.test/x', { retryDelaysMs: NO_WAIT });
      expect(res.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('can be disabled per request', async () => {
    const fetchMock = vi.fn(async () => html(502));
    vi.stubGlobal('fetch', fetchMock);
    await fetchWithTimeout('https://api.test/x', { retryGateway: false, retryDelaysMs: NO_WAIT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a caller abort cuts the retry wait short and rejects like an aborted fetch', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => html(502));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const p = fetchWithTimeout('https://api.test/x', { signal: controller.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours a short Retry-After and ignores a long one', () => {
    expect(gatewayRetryDelay(html(503, { 'Retry-After': '3' }), 1000)).toBe(3000);
    expect(gatewayRetryDelay(html(503, { 'Retry-After': '120' }), 1000)).toBe(1000);
    expect(gatewayRetryDelay(html(503), 2000)).toBe(2000);
  });

  it('apiRequest (GET) inherits the retries', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(html(504))
      .mockResolvedValueOnce(json({ ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    const p = apiRequest('/api/desktop/minutes');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('masks ids in the reported path so one outage is one issue', () => {
    expect(pathTemplate('https://h/api/desktop/recording/cmu86ebvk0xhr3uo5qe1rgkys?x=1')).toBe('/api/desktop/recording/:id');
    expect(pathTemplate('https://h/api/desktop/upload/3f2b8c1e-1111-4222-8333-944455566677/status')).toBe('/api/desktop/upload/:id/status');
    expect(pathTemplate('https://h/api/desktop/minutes')).toBe('/api/desktop/minutes');
  });
});

describe('readJson / parseJsonSafe / apiErrorFromResponse', () => {
  it('readJson turns an HTML page into a transient ApiResponseError, never a SyntaxError', async () => {
    const err = await readJson(html(200)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).toMatchObject({ status: 200, nonJson: true, transient: true, message: 'Unexpected server response (HTTP 200)' });
    expect(isTransientApiError(err)).toBe(true);
  });

  it('readJson returns parsed JSON, {} for an empty body and {} for a JSON null', async () => {
    expect(await readJson(json({ a: 1 }))).toEqual({ a: 1 });
    expect(await readJson(new Response('', { status: 200 }))).toEqual({});
    expect(await readJson(new Response('null', { status: 200 }))).toEqual({});
    expect(await parseJsonSafe(new Response('null', { status: 200 }))).toEqual({});
  });

  it('apiErrorFromResponse keeps the server message and classifies the status', async () => {
    const e404 = await apiErrorFromResponse(json({ error: 'Recording not found' }, 404), 'fallback');
    expect(e404).toMatchObject({ message: 'Recording not found', status: 404, transient: false, nonJson: false });
    const e502 = await apiErrorFromResponse(html(502), 'Failed to fetch minutes');
    expect(e502).toMatchObject({ message: 'Unexpected server response (HTTP 502)', status: 502, transient: true, nonJson: true });
    const e500 = await apiErrorFromResponse(json({}, 500), 'Failed');
    expect(e500).toMatchObject({ message: 'Failed', transient: true });
  });
});
