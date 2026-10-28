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

const { useShareLink, buildMeetingUrl, handoffQuery } = await import('../../src/composables/useShareLink');

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

describe('handoffQuery', () => {
  it('prefers the bound one-time code over a session token', () => {
    expect(handoffQuery({ success: true, handoffCode: 'c1', sessionToken: 's1' })).toBe('handoff=c1');
  });
  it('falls back to today\'s session token', () => {
    expect(handoffQuery({ success: true, sessionToken: 's/1' })).toBe('session=s%2F1');
  });
  it('is empty for failures', () => {
    expect(handoffQuery(null)).toBe('');
    expect(handoffQuery({ success: false, sessionToken: 's' })).toBe('');
    expect(handoffQuery({ success: true })).toBe('');
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

  it('mobile: the hand-off goes only into the browser it opens', async () => {
    platform.capacitor = true;
    api.fetchWithTimeout.mockResolvedValue({ ok: true });
    api.parseJsonSafe.mockResolvedValue({ success: true, handoffCode: 'one-time' });
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await useShareLink().openInBrowser('m6');
    expect(browser.open).toHaveBeenCalledWith({ url: 'https://app.suisse-meets.ch/meeting/audio/m6?handoff=one-time' });
    expect(writeText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
