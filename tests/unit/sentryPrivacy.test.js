import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Telemetry carries no personal data: replays mask all text and block media,
// the user is an opaque id, and URLs with tokens are scrubbed in breadcrumbs.
const h = vi.hoisted(() => {
  const calls = { init: null, setUser: [] };
  const sentry = {
    init: (opts) => { calls.init = opts; },
    vueIntegration: (o) => ({ name: 'Vue', o }),
    browserTracingIntegration: (o) => ({ name: 'BrowserTracing', o }),
    captureConsoleIntegration: (o) => ({ name: 'CaptureConsole', o }),
    httpClientIntegration: (o) => ({ name: 'HttpClient', o }),
    eventFiltersIntegration: (o) => ({ name: 'EventFilters', o }),
    replayIntegration: (o) => ({ name: 'Replay', o }),
    captureException: () => {},
    captureMessage: () => {},
    setTag: () => {},
    addBreadcrumb: () => {},
    setUser: (u) => calls.setUser.push(u),
    setContext: () => {}
  };
  return { calls, sentry };
});

vi.mock('@sentry/vue', () => h.sentry);
vi.mock('../../src/utils/platform', () => ({ isCapacitor: () => false, isElectron: () => true, getPlatform: () => 'electron' }));

window.electronAPI = { isE2E: false, app: { getVersion: async () => '4.7.18' } };
const sentry = await import('../../src/boot/sentry');
await sentry.default({ app: {}, router: { onError: vi.fn(), afterEach: vi.fn() } });

describe('telemetry privacy', () => {
  it('desktop session replay masks all text, blocks media and records no network details', () => {
    const replay = h.calls.init.integrations.find(i => i.name === 'Replay').o;
    expect(replay).toMatchObject({ maskAllText: true, maskAllInputs: true, blockAllMedia: true, networkCaptureBodies: false });
    expect(replay.networkDetailAllowUrls).toEqual([]);
  });

  it('component props are not attached to events', () => {
    const vue = h.calls.init.integrations.find(i => i.name === 'Vue').o;
    expect(vue.attachProps).toBe(false);
  });

  it('setUser sends only the opaque id', () => {
    sentry.setUser({ id: 'u1', email: 'a@b.ch', name: 'Anna' });
    expect(h.calls.setUser.at(-1)).toEqual({ id: 'u1' });
    expect(sentry.telemetryUser({ email: 'a@b.ch' })).toBeNull();
  });

  it('beforeSend drops e-mail, name and IP from the event user', () => {
    const event = sentry.scrubSensitiveData({ user: { id: 7, email: 'a@b.ch', username: 'anna', ip_address: '1.2.3.4' } }, {});
    expect(event.user).toEqual({ id: '7' });
  });

  it('breadcrumbs lose session, hand-off and SSO values at creation', () => {
    const bc = sentry.filterBreadcrumbs({
      category: 'navigation',
      message: 'open https://app.suisse-meets.ch/meeting/audio/x?session=abc.def.ghi',
      data: {
        from: '/a?state=s1',
        to: '/meeting?handoff=one-time',
        url: 'suissenotes://auth/callback?auth_code=c1&token=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MSJ9.sig-sig-sig'
      }
    });
    const text = JSON.stringify(bc);
    for (const secret of ['abc.def.ghi', 's1', 'one-time', 'c1', 'eyJhbGciOiJIUzI1NiJ9']) expect(text).not.toContain(secret);
  });

  it('the main process never sends the e-mail to telemetry', () => {
    const main = fs.readFileSync(path.resolve(__dirname, '../../src-electron/electron-main.js'), 'utf8');
    for (const m of main.matchAll(/Sentry\.setUser\(([^)]*)\)/g)) expect(m[1]).not.toMatch(/email|name/);
  });
});
