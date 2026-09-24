import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const axiosLib = require('axios');
const { installApiResilience } = require('../../src-electron/api-resilience.js');

const API = 'https://app.suisse-meets.ch';
const NGINX_502 = '<html>\r\n<head><title>502 Bad Gateway</title></head><body>nginx</body></html>';

// Scripted adapter: each call shifts the next answer. Non-2xx answers reject
// the way axios' real adapters do (via validateStatus → AxiosError).
function scriptedAxios(answers) {
  const calls = [];
  const adapter = async (config) => {
    calls.push({ url: config.url, method: config.method });
    const next = answers.shift();
    if (!next) throw new Error('no scripted answer left');
    const response = {
      data: next.data,
      status: next.status,
      statusText: String(next.status),
      headers: new axiosLib.AxiosHeaders(next.headers || {}),
      config,
      request: {},
    };
    if (config.validateStatus(response.status)) return response;
    throw new axiosLib.AxiosError(
      `Request failed with status code ${response.status}`,
      axiosLib.AxiosError.ERR_BAD_RESPONSE,
      config,
      {},
      response
    );
  };
  const instance = axiosLib.create({ adapter });
  return { instance, calls };
}

const htmlAnswer = (status) => ({ status, data: NGINX_502, headers: { 'content-type': 'text/html' } });
const jsonAnswer = (data, status = 200) => ({ status, data, headers: { 'content-type': 'application/json' } });

describe('main-process api-resilience (ELECTRON-6E/6F class)', () => {
  let log;
  let sleep;
  beforeEach(() => {
    log = { info: vi.fn(), warn: vi.fn() };
    sleep = vi.fn(async () => {});
  });

  const install = (instance) => installApiResilience({ axios: instance, log, getApiBaseUrl: () => API, sleep });

  it('retries a GET through a backend restart and returns the JSON answer', async () => {
    const { instance, calls } = scriptedAxios([htmlAnswer(502), htmlAnswer(502), jsonAnswer({ status: 'COMPLETED' })]);
    install(instance);
    const res = await instance.get(`${API}/api/desktop/meeting/abc/status`);
    expect(res.data).toEqual({ status: 'COMPLETED' });
    expect(calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('recovered after 3 attempts'));
  });

  it('gives up after 1+2+4+8 s with a transient error and one warning', async () => {
    const { instance, calls } = scriptedAxios([htmlAnswer(503), htmlAnswer(503), htmlAnswer(503), htmlAnswer(503), htmlAnswer(503)]);
    install(instance);
    const err = await instance.get(`${API}/api/desktop/minutes`).catch((e) => e);
    expect(err.response.status).toBe(503);
    expect(err.transient).toBe(true);
    expect(calls).toHaveLength(5);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000, 8000]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('Backend unavailable: GET /api/desktop/minutes answered HTTP 503 after 5 attempts');
  });

  it('does not resend a POST (upload init/complete) unless the request opts in', async () => {
    const a = scriptedAxios([htmlAnswer(502)]);
    install(a.instance);
    const err = await a.instance.post(`${API}/api/uploads/init`, {}).catch((e) => e);
    expect(err.response.status).toBe(502);
    expect(err.transient).toBe(true);
    expect(a.calls).toHaveLength(1);

    const b = scriptedAxios([htmlAnswer(502), jsonAnswer({ success: true, token: 't' })]);
    install(b.instance);
    const res = await b.instance.post(`${API}/api/auth/desktop`, {}, { retryGateway: true });
    expect(res.data.token).toBe('t');
    expect(b.calls).toHaveLength(2);
  });

  it('turns an HTML page with 2xx into a transient ENONJSON error instead of a string body', async () => {
    const { instance } = scriptedAxios([htmlAnswer(200)]);
    install(instance);
    const err = await instance.get(`${API}/api/desktop/upload/x/status`).catch((e) => e);
    expect(err).toMatchObject({ code: 'ENONJSON', nonJson: true, transient: true, status: 200 });
    expect(err.message).toBe('Unexpected server response (HTTP 200, HTML instead of JSON)');
  });

  it('leaves other hosts alone (Azure blob storage, update feed)', async () => {
    const { instance, calls } = scriptedAxios([htmlAnswer(503), htmlAnswer(200)]);
    install(instance);
    const err = await instance.get('https://suissenotes.blob.core.windows.net/c/b').catch((e) => e);
    expect(err.response.status).toBe(503);
    expect(err.transient).toBeUndefined();
    const res = await instance.get('https://github.com/xicoarm/suisse-notes-desktop/releases.atom');
    expect(typeof res.data).toBe('string');
    expect(calls).toHaveLength(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a 500 (backend bug) or a 404 (verdict)', async () => {
    const { instance, calls } = scriptedAxios([jsonAnswer({ error: 'boom' }, 500), jsonAnswer({ error: 'nf' }, 404)]);
    install(instance);
    expect((await instance.get(`${API}/a`).catch((e) => e)).response.status).toBe(500);
    expect((await instance.get(`${API}/b`).catch((e) => e)).response.status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  it('keeps a JSON answer untouched even when the server forgets the content type', async () => {
    const { instance } = scriptedAxios([{ status: 200, data: { ok: true }, headers: {} }]);
    install(instance);
    expect((await instance.get(`${API}/api/desktop/minutes`)).data).toEqual({ ok: true });
  });
});
