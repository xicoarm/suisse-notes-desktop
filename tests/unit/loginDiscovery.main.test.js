// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ld = require('../../src-electron/login-discovery.js');

const BASE = 'https://app.suisse-meets.ch';

describe('main process: system-browser sign-in with login hint', () => {
  it('adds a valid address url-encoded, drops anything else', () => {
    expect(ld.buildSsoLoginUrl(BASE, 'microsoft', 'Anna+x@Firma.ch'))
      .toBe(`${BASE}/api/auth/microsoft/login?client=desktop&login_hint=anna%2Bx%40firma.ch`);
    expect(ld.buildSsoLoginUrl(BASE, 'google')).toBe(`${BASE}/api/auth/google/login?client=desktop`);
    for (const bad of ['a@b.ch&client=web', 'a@b.ch#x', 'javascript:alert(1)', { toString: () => 'a@b.ch' }, 42]) {
      expect(ld.buildSsoLoginUrl(BASE, 'google', bad)).toBe(`${BASE}/api/auth/google/login?client=desktop`);
    }
  });

  it('only Microsoft and Google', () => {
    expect(() => ld.buildSsoLoginUrl(BASE, 'apple', 'a@b.ch')).toThrow();
    expect(() => ld.buildSsoLoginUrl(BASE, '../x', null)).toThrow();
  });

  it('electron-main uses it for both providers and registers discover + login mode', () => {
    const main = fs.readFileSync('src-electron/electron-main.js', 'utf8');
    expect(main).toMatch(/loginDiscovery\.buildSsoLoginUrl\(API_BASE_URL, provider, loginHint\)/);
    expect(main).toMatch(/ipcMain\.handle\('auth:loginWithMicrosoft', \(event, loginHint\) => openSSOBrowser\('microsoft', loginHint\)\)/);
    expect(main).toMatch(/ipcMain\.handle\('auth:loginWithGoogle', \(event, loginHint\) => openSSOBrowser\('google', loginHint\)\)/);
    expect(main).toMatch(/ipcMain\.handle\('auth:discover'/);
    expect(main).toMatch(/ipcMain\.handle\('auth:loginMode'/);
    const preload = fs.readFileSync('src-electron/electron-preload.js', 'utf8');
    expect(preload).toMatch(/discover: \(email\) => ipcRenderer\.invoke\('auth:discover', String\(email \?\? ''\)\)/);
  });
});

describe('main process: discover request', () => {
  it('sends the normalised address with client desktop to the configured base only', async () => {
    const axios = { post: vi.fn(async () => ({ status: 200, data: { next: 'microsoft', start: '/api/auth/microsoft/login?login_hint=x' } })) };
    await expect(ld.discover(axios, BASE, ' Anna@Firma.ch ')).resolves.toEqual({ status: 200, next: 'microsoft' });
    expect(axios.post).toHaveBeenCalledWith(`${BASE}/api/auth/discover`, { email: 'anna@firma.ch', client: 'desktop' }, expect.objectContaining({ timeout: 10000 }));
  });

  it('an invalid address is refused without a request', async () => {
    const axios = { post: vi.fn() };
    await expect(ld.discover(axios, BASE, 'nope')).resolves.toEqual({ status: 400, error: 'invalid_email' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('only contract fields pass; 404, errors and odd answers are status 0 or the plain status', async () => {
    const answer = async (status, data) => ld.discover({ post: async () => ({ status, data }) }, BASE, 'a@b.ch');
    await expect(answer(200, { next: 'password', name: 'Anna', mfa: true })).resolves.toEqual({ status: 200, next: 'password' });
    await expect(answer(200, { next: 'saml' })).resolves.toEqual({ status: 0 });
    await expect(answer(404, '<html>')).resolves.toEqual({ status: 404 });
    await expect(answer(429, { error: 'rate_limited', retryAfter: 30 })).resolves.toEqual({ status: 429, error: 'rate_limited', retryAfter: 30 });
    await expect(answer(429, null)).resolves.toEqual({ status: 429, error: 'rate_limited', retryAfter: 60 });
    await expect(answer(400, { error: 'invalid_email' })).resolves.toEqual({ status: 400, error: 'invalid_email' });
    await expect(ld.discover({ post: async () => { throw new Error('ECONNREFUSED'); } }, BASE, 'a@b.ch')).resolves.toEqual({ status: 0 });
  });
});

describe('main process: login mode (server switch)', () => {
  const get = (status, data) => ({ get: vi.fn(async () => ({ status, data })) });

  it('reads the mode; a server without the endpoint is classic', async () => {
    await expect(ld.loginMode(get(200, { mode: 'identifier-first' }), BASE, { argv: [], env: {} })).resolves.toEqual({ mode: 'identifier-first', testOptIn: false });
    await expect(ld.loginMode(get(404, 'not found'), BASE, { argv: [], env: {} })).resolves.toEqual({ mode: 'classic', testOptIn: false });
    await expect(ld.loginMode(get(200, { mode: 'all' }), BASE, { argv: [], env: {} })).resolves.toEqual({ mode: 'classic', testOptIn: false });
    await expect(ld.loginMode({ get: async () => { throw new Error('offline'); } }, BASE, { argv: [], env: {} })).resolves.toEqual({ mode: 'classic', testOptIn: false });
  });

  it('test opt-in by start argument or environment', async () => {
    await expect(ld.loginMode(get(200, { mode: 'test' }), BASE, { argv: ['app', '--login-discovery'], env: {} })).resolves.toEqual({ mode: 'test', testOptIn: true });
    await expect(ld.loginMode(get(200, { mode: 'test' }), BASE, { argv: [], env: { SUISSE_MEETS_LOGIN_DISCOVERY: '1' } })).resolves.toEqual({ mode: 'test', testOptIn: true });
    expect(ld.testOptIn([], { SUISSE_MEETS_LOGIN_DISCOVERY: 'yes' })).toBe(false);
  });
});
