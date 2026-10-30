import { describe, it, expect, beforeEach, vi } from 'vitest';

// «Link kopieren» must never carry a session token: anyone holding such a link
// was signed in as the copying user. Only the user's own «open in browser»
// may hand the session over, and on desktop main keeps that value.

const platform = vi.hoisted(() => ({ electron: false, capacitor: false }));
vi.mock('../../src/utils/platform', () => ({
  isElectron: () => platform.electron,
  isCapacitor: () => platform.capacitor,
  isAndroid: () => false
}));
const notify = vi.fn();
vi.mock('quasar', () => ({ useQuasar: () => ({ notify }) }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }));
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => ({ token: 'jwt-of-the-user' }) }));
const api = vi.hoisted(() => ({ fetchWithTimeout: vi.fn(), parseJsonSafe: vi.fn() }));
vi.mock('../../src/services/api', () => ({
  getApiUrlSync: () => 'https://api.example.test',
  fetchWithTimeout: api.fetchWithTimeout,
  parseJsonSafe: api.parseJsonSafe
}));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));
const browser = vi.hoisted(() => ({ open: vi.fn(async () => {}), close: vi.fn() }));
vi.mock('@capacitor/browser', () => ({ Browser: browser }));

const { useShareLink, buildMeetingUrl, handoffUrl } = await import('../../src/composables/useShareLink');
const { pkceChallenge } = await import('../../src/services/ssoFlow');

describe('buildMeetingUrl', () => {
  it('is the plain meeting URL', () => {
    expect(buildMeetingUrl('abc_123-x')).toBe('https://app.suisse-meets.ch/meeting/audio/abc_123-x');
  });
  it('refuses ids that could change the path or add a query', () => {
    for (const bad of ['', null, undefined, '../x', 'a/b', 'a?session=x', 'a#b', 'a b', 'x'.repeat(129)]) {
      expect(buildMeetingUrl(bad)).toBe('');
    }
  });
});

describe('handoffUrl (bound hand-off, server contract 10/2026)', () => {
  const plain = 'https://app.suisse-meets.ch/meeting/audio/m1';
  it('token in the query, verifier only in the fragment', () => {
    expect(handoffUrl(plain, { success: true, sessionToken: 's/1', bound: true }, 'v1')).toBe(`${plain}?session=s%2F1#hv=v1`);
  });
  it('plain URL on any failure', () => {
    expect(handoffUrl(plain, null, 'v')).toBe(plain);
    expect(handoffUrl(plain, { success: false, sessionToken: 's' }, 'v')).toBe(plain);
    expect(handoffUrl(plain, { success: true }, 'v')).toBe(plain);
    expect(handoffUrl(plain, { success: true, sessionToken: 's', bound: true }, '')).toBe(plain);
  });
  it('legacy 200 (server without binding: unbound, reusable token) -> plain URL', () => {
    expect(handoffUrl(plain, { success: true, sessionToken: 'legacy-5min' }, 'v')).toBe(plain);
    expect(handoffUrl(plain, { success: true, sessionToken: 'legacy-5min', expiresIn: 300 }, 'v')).toBe(plain);
    expect(handoffUrl(plain, { success: true, sessionToken: 's', bound: false }, 'v')).toBe(plain);
    expect(handoffUrl(plain, { success: true, sessionToken: 's', bound: 'true' }, 'v')).toBe(plain);
  });
});

describe('copyLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.electron = false;
    platform.capacitor = false;
  });

  it('desktop: copies the plain URL and never asks for a web session', async () => {
    platform.electron = true;
    const writeText = vi.fn(async () => {});
    const openWebWithSession = vi.fn();
    vi.stubGlobal('window', { electronAPI: { clipboard: { writeText }, auth: { openWebWithSession } } });
    await useShareLink().copyLink('m1');
    expect(writeText).toHaveBeenCalledWith('https://app.suisse-meets.ch/meeting/audio/m1');
    expect(openWebWithSession).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('mobile: copies the plain URL and never calls create-web-session', async () => {
    platform.capacitor = true;
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await useShareLink().copyLink('m2');
    expect(writeText).toHaveBeenCalledWith('https://app.suisse-meets.ch/meeting/audio/m2');
    expect(writeText.mock.calls[0][0]).not.toMatch(/session=|handoff=|token/);
    expect(api.fetchWithTimeout).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('generateTranscriptUrl (old name) is token-free too', async () => {
    platform.capacitor = true;
    expect(await useShareLink().generateTranscriptUrl('m3')).toBe('https://app.suisse-meets.ch/meeting/audio/m3');
    expect(api.fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe('openInBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.electron = false;
    platform.capacitor = false;
  });

  it('desktop: main opens the page; the renderer never sees a token', async () => {
    platform.electron = true;
    const openWebWithSession = vi.fn(async () => ({ success: true, signedIn: true }));
    const openExternal = vi.fn();
    vi.stubGlobal('window', { electronAPI: { auth: { openWebWithSession }, shell: { openExternal } } });
    await useShareLink().openInBrowser('m4');
    expect(openWebWithSession).toHaveBeenCalledWith('/meeting/audio/m4');
    expect(openExternal).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('desktop: falls back to the plain URL when main could not open it', async () => {
    platform.electron = true;
    const openWebWithSession = vi.fn(async () => ({ success: false }));
    const openExternal = vi.fn();
    vi.stubGlobal('window', { electronAPI: { auth: { openWebWithSession }, shell: { openExternal } } });
    await useShareLink().openInBrowser('m5');
    expect(openExternal).toHaveBeenCalledWith('https://app.suisse-meets.ch/meeting/audio/m5');
    vi.unstubAllGlobals();
  });

  it('mobile: bound hand-off — challenge to the server, verifier only in the opened URL\'s fragment', async () => {
    platform.capacitor = true;
    api.fetchWithTimeout.mockResolvedValue({ ok: true });
    api.parseJsonSafe.mockResolvedValue({ success: true, sessionToken: 'one-time', expiresIn: 60, bound: true });
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await useShareLink().openInBrowser('m6');
    const body = JSON.parse(api.fetchWithTimeout.mock.calls[0][1].body);
    expect(body.codeChallengeMethod).toBe('S256');
    const opened = browser.open.mock.calls[0][0].url;
    const m = opened.match(/^https:\/\/app\.suisse-meets\.ch\/meeting\/audio\/m6\?session=one-time#hv=([A-Za-z0-9_-]{43})$/);
    expect(m).not.toBeNull();
    expect(await pkceChallenge(m[1])).toBe(body.codeChallenge);
    expect(JSON.stringify(api.fetchWithTimeout.mock.calls)).not.toContain(m[1]);
    expect(writeText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('mobile: 400 HANDOFF_BINDING_REQUIRED opens the plain URL', async () => {
    // The double-tap guard of the previous open is released after 1.5 s.
    await new Promise((r) => setTimeout(r, 1600));
    platform.capacitor = true;
    api.fetchWithTimeout.mockResolvedValue({ ok: false, status: 400 });
    api.parseJsonSafe.mockResolvedValue({ error: 'HANDOFF_BINDING_REQUIRED' });
    await useShareLink().openInBrowser('m7');
    expect(browser.open).toHaveBeenCalledWith({ url: 'https://app.suisse-meets.ch/meeting/audio/m7' });
  });

  it('mobile: legacy 200 without `bound` (old server) opens the plain URL, token unused', async () => {
    await new Promise((r) => setTimeout(r, 1600));
    platform.capacitor = true;
    api.fetchWithTimeout.mockResolvedValue({ ok: true, status: 200 });
    api.parseJsonSafe.mockResolvedValue({ success: true, sessionToken: 'legacy-reusable' });
    await useShareLink().openInBrowser('m8');
    expect(browser.open).toHaveBeenCalledWith({ url: 'https://app.suisse-meets.ch/meeting/audio/m8' });
    expect(JSON.stringify(browser.open.mock.calls)).not.toContain('legacy-reusable');
  });
});
