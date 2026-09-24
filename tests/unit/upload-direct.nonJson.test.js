import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../../src/services/storage', () => ({ getFileUri: vi.fn(), statFile: vi.fn(), readFile: vi.fn() }));
vi.mock('../../src/utils/platform', () => ({ isCapacitor: () => true, isElectron: () => false, getPlatform: () => 'android' }));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { convertFileSrc: (u) => u } }));

import { uploadViaPresignedSas, isTransientUploadError } from '../../src/services/upload-direct';

const API = 'https://app.suisse-meets.ch';
const PORTAL = '<html><head><title>Hotel WiFi</title></head><body>Please log in</body></html>';
const html = (status) => new Response(PORTAL, { status, headers: { 'Content-Type': 'text/html' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const baseOpts = () => ({
  apiBaseUrl: API,
  authToken: 'tok',
  recordId: 'rec-1',
  file: new File([new Uint8Array(1024)], 'rec.m4a', { type: 'audio/mp4' }),
  metadata: { duration: 12 },
});

describe('uploadViaPresignedSas — HTML instead of JSON is transient, never final', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => vi.clearAllMocks());

  it('init answered by a captive portal (200 HTML) throws a retryable error instead of "invalid init response"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => html(200)));
    const err = await uploadViaPresignedSas(baseOpts()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Unexpected server response (HTTP 200)');
    expect(err.status).toBe(200);
    expect(isTransientUploadError(err)).toBe(true);
  });

  it('init answered by an nginx 502 page throws a retryable 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => html(502)));
    const err = await uploadViaPresignedSas(baseOpts()).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toBe('Unexpected server response (HTTP 502)');
    expect(isTransientUploadError(err)).toBe(true);
  });

  it('complete answered by HTML throws a retryable error instead of success:false/verified:true', async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/uploads/init')) {
        return json({ mode: 'azure', sasUrl: 'https://blob.test/c/b?sig=x', audioFileId: 'af-1', blobName: 'b', blockSize: 4 * 1024 * 1024 });
      }
      if (u.startsWith('https://blob.test/')) return new Response('', { status: 201 });
      if (u.endsWith('/api/uploads/complete')) return html(200);
      throw new Error(`unexpected url ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const err = await uploadViaPresignedSas(baseOpts()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Unexpected server response (HTTP 200)');
    expect(isTransientUploadError(err)).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/api/uploads/complete'))).toBe(true);
  });
});
