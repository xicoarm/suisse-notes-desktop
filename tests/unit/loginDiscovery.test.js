import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  normalizeLoginEmail, readRememberedEmail, rememberEmail, mayAutoRedirect, markAutoRedirect, clearAutoRedirect,
  AUTO_REDIRECT_TTL_MS, readCachedLoginMode, cacheLoginMode, identifierFirstEnabled, interpretDiscover,
  mobileSsoUrl, discoverSignIn, fetchLoginMode, discoverClient
} from '../../src/services/loginDiscovery';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    map
  };
}

const blocked = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); }
};

afterEach(() => {
  delete window.electronAPI;
  vi.restoreAllMocks();
});

describe('login recognition: address rule', () => {
  it('accepts plain addresses, lower-cased and trimmed', () => {
    expect(normalizeLoginEmail('  Anna.Muster@Firma.CH ')).toBe('anna.muster@firma.ch');
    expect(normalizeLoginEmail('a+tag@sub.firma.ch')).toBe('a+tag@sub.firma.ch');
  });

  it('refuses anything that could change a URL or is no address', () => {
    for (const bad of ['', 'anna', '@firma.ch', 'a@b', 'a@@b.ch', 'a@b.ch&redirect=x', 'a b@c.ch', 'a@b.ch/x', null, 42, `${'a'.repeat(65)}@b.ch`]) {
      expect(normalizeLoginEmail(bad)).toBeNull();
    }
  });
});

describe('login recognition: what the device remembers', () => {
  it('only the address; «Not me» removes it', () => {
    const s = memoryStorage();
    rememberEmail(s, 'Anna@Firma.ch');
    expect(readRememberedEmail(s)).toBe('anna@firma.ch');
    expect([...s.map.values()].join(' ')).not.toMatch(/microsoft|google|apple|password/);
    rememberEmail(s, null);
    expect(readRememberedEmail(s)).toBeNull();
  });

  it('a damaged value is ignored; blocked storage never throws', () => {
    const s = memoryStorage();
    s.setItem('suisse-meets-login-email', 'not an address');
    expect(readRememberedEmail(s)).toBeNull();
    expect(() => rememberEmail(blocked, 'a@b.ch')).not.toThrow();
    expect(readRememberedEmail(blocked)).toBeNull();
    expect(readRememberedEmail(null)).toBeNull();
  });
});

describe('login recognition: at most one automatic redirect per attempt', () => {
  it('the same address is sent on once, another address again', () => {
    const s = memoryStorage();
    expect(mayAutoRedirect(s, 'a@firma.ch', 1000)).toBe(true);
    markAutoRedirect(s, 'A@Firma.ch', 1000);
    expect(mayAutoRedirect(s, 'a@firma.ch', 2000)).toBe(false);
    expect(mayAutoRedirect(s, 'b@firma.ch', 2000)).toBe(true);
  });

  it('the mark expires (sign-in, sign-out, sign-in again in the same window)', () => {
    const s = memoryStorage();
    markAutoRedirect(s, 'a@firma.ch', 1000);
    expect(mayAutoRedirect(s, 'a@firma.ch', 1000 + AUTO_REDIRECT_TTL_MS + 1)).toBe(true);
    // A clock set back does not keep the mark forever either.
    expect(mayAutoRedirect(s, 'a@firma.ch', 500)).toBe(true);
  });

  it('clearing starts a new attempt; invalid address never redirects; blocked storage still allows one', () => {
    const s = memoryStorage();
    markAutoRedirect(s, 'a@firma.ch', 1000);
    clearAutoRedirect(s);
    expect(mayAutoRedirect(s, 'a@firma.ch', 1001)).toBe(true);
    expect(mayAutoRedirect(s, 'nope', 1001)).toBe(false);
    s.setItem('suisse-meets-login-auto-redirect', '{broken');
    expect(mayAutoRedirect(s, 'a@firma.ch', 1001)).toBe(true);
    expect(mayAutoRedirect(blocked, 'a@firma.ch')).toBe(true);
  });
});

describe('login recognition: server switch', () => {
  it('identifier-first for all, test only with the opt-in, otherwise classic', () => {
    expect(identifierFirstEnabled('identifier-first', false)).toBe(true);
    expect(identifierFirstEnabled('test', true)).toBe(true);
    expect(identifierFirstEnabled('test', false)).toBe(false);
    expect(identifierFirstEnabled('classic', true)).toBe(false);
    expect(identifierFirstEnabled(undefined, true)).toBe(false);
  });

  it('the cached position defaults to classic', () => {
    const s = memoryStorage();
    expect(readCachedLoginMode(s)).toBe('classic');
    cacheLoginMode(s, 'identifier-first');
    expect(readCachedLoginMode(s)).toBe('identifier-first');
    cacheLoginMode(s, 'something');
    expect(readCachedLoginMode(s)).toBe('classic');
    expect(readCachedLoginMode(blocked)).toBe('classic');
  });
});

describe('login recognition: discover answer (contract section 6)', () => {
  it('maps every contract answer', () => {
    expect(interpretDiscover(200, { next: 'password' })).toEqual({ kind: 'password' });
    expect(interpretDiscover(200, { next: 'microsoft', start: '/api/auth/microsoft/login?login_hint=a%40b.ch' })).toEqual({ kind: 'sso', provider: 'microsoft' });
    expect(interpretDiscover(200, { next: 'google' })).toEqual({ kind: 'sso', provider: 'google' });
    expect(interpretDiscover(200, { next: 'apple' })).toEqual({ kind: 'apple' });
    expect(interpretDiscover(400, { error: 'invalid_email' })).toEqual({ kind: 'invalid_email' });
    expect(interpretDiscover(429, { error: 'rate_limited', retryAfter: 12.2 })).toEqual({ kind: 'rate_limited', retryAfter: 13 });
    expect(interpretDiscover(429, {})).toEqual({ kind: 'rate_limited', retryAfter: 60 });
  });

  it('404, 5xx, odd bodies and unknown methods fall back to the classic form', () => {
    for (const [status, body] of [[404, {}], [500, null], [502, 'html'], [200, { next: 'saml' }], [200, null], [0, undefined], [400, { error: 'x' }]]) {
      expect(interpretDiscover(status, body)).toEqual({ kind: 'unavailable' });
    }
  });

  it('the server start URL is never used; the app builds its own with the url-encoded hint', () => {
    expect(mobileSsoUrl('https://app.suisse-meets.ch', 'microsoft', 'ios', 'Anna+x@Firma.ch'))
      .toBe('https://app.suisse-meets.ch/api/auth/microsoft/login?client=ios&login_hint=anna%2Bx%40firma.ch');
    expect(mobileSsoUrl('https://app.suisse-meets.ch', 'google', 'android', 'a@b.ch&client=web'))
      .toBe('https://app.suisse-meets.ch/api/auth/google/login?client=android');
    expect(mobileSsoUrl('https://app.suisse-meets.ch', 'google', 'android', null))
      .toBe('https://app.suisse-meets.ch/api/auth/google/login?client=android');
  });
});

describe('login recognition: desktop goes through the main process', () => {
  it('discover and login mode via IPC; an older main without them is classic', async () => {
    window.electronAPI = { auth: {
      discover: vi.fn(async () => ({ status: 200, next: 'google' })),
      loginMode: vi.fn(async () => ({ mode: 'test', testOptIn: true }))
    } };
    expect(discoverClient()).toBe('desktop');
    await expect(discoverSignIn('a@b.ch')).resolves.toEqual({ kind: 'sso', provider: 'google' });
    expect(window.electronAPI.auth.discover).toHaveBeenCalledWith('a@b.ch');
    await expect(fetchLoginMode()).resolves.toEqual({ mode: 'test', testOptIn: true });

    window.electronAPI = { auth: {} };
    await expect(discoverSignIn('a@b.ch')).resolves.toEqual({ kind: 'unavailable' });
    await expect(fetchLoginMode()).resolves.toEqual({ mode: 'classic', testOptIn: false });
  });

  it('a failing IPC is never a dead end', async () => {
    window.electronAPI = { auth: {
      discover: vi.fn(async () => { throw new Error('ipc'); }),
      loginMode: vi.fn(async () => { throw new Error('ipc'); })
    } };
    await expect(discoverSignIn('a@b.ch')).resolves.toEqual({ kind: 'unavailable' });
    await expect(fetchLoginMode()).resolves.toEqual({ mode: 'classic', testOptIn: false });
  });
});
