import { describe, it, expect, beforeEach, vi } from 'vitest';

// The mobile Sentry init must wire every capture path: offline queue, console
// errors AND warnings, failed HTTP answers, no default ignore patterns, early
// errors, router errors and the unclean-exit report.
const h = vi.hoisted(() => {
  const calls = { init: null, captureException: [], captureMessage: [], tags: {}, offlineWrappedWith: null };
  const makeFetchTransport = () => ({});
  const sentry = {
    init: (opts) => { calls.init = opts; },
    makeFetchTransport,
    makeBrowserOfflineTransport: (inner) => { calls.offlineWrappedWith = inner; return () => ({}); },
    vueIntegration: (o) => ({ name: 'Vue', o }),
    browserTracingIntegration: (o) => ({ name: 'BrowserTracing', o }),
    captureConsoleIntegration: (o) => ({ name: 'CaptureConsole', o }),
    httpClientIntegration: (o) => ({ name: 'HttpClient', o }),
    eventFiltersIntegration: (o) => ({ name: 'EventFilters', o }),
    captureException: (e, ctx) => calls.captureException.push({ e, ctx }),
    captureMessage: (m, ctx) => calls.captureMessage.push({ m, ctx }),
    setTag: (k, v) => { calls.tags[k] = v; },
    addBreadcrumb: () => {},
    setUser: () => {},
    setContext: () => {}
  };
  return { calls, sentry, previousSession: null };
});

vi.mock('@sentry/vue', () => h.sentry);
vi.mock('@capacitor/app', () => ({ App: { getInfo: async () => ({ version: '3.9.38', build: '41' }), getState: async () => ({ isActive: true }) } }));
vi.mock('../../src/utils/platform', () => ({ isCapacitor: () => true, isElectron: () => false, getPlatform: () => 'android' }));
vi.mock('../../src/services/sessionHealth', () => ({
  startSessionHealth: async ({ report }) => { if (h.previousSession) report(h.previousSession); return h.previousSession; },
  noteSessionActivity: () => {}
}));

async function boot() {
  vi.resetModules();
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
  const mod = await import('../../src/boot/sentry');
  return mod;
}

describe('mobile Sentry init — capture wiring', () => {
  beforeEach(() => {
    h.calls.init = null;
    h.calls.captureException.length = 0;
    h.calls.captureMessage.length = 0;
    h.previousSession = null;
  });

  it('configures offline queue, console + HTTP capture and no default ignore list', async () => {
    const mod = await boot();
    const router = { onError: vi.fn(), afterEach: vi.fn() };
    await mod.default({ app: {}, router });
    const o = h.calls.init;
    expect(o).toBeTruthy();
    expect(o.sampleRate).toBe(1.0);
    expect(o.attachStacktrace).toBe(true);
    expect(o.release).toBe('ch.suissenotes.mobile@3.9.38');
    expect(o.dist).toBe('android');
    expect(h.calls.offlineWrappedWith).toBe(h.sentry.makeFetchTransport);
    expect(o.transportOptions).toMatchObject({ flushAtStartup: true, maxQueueSize: 100 });
    const byName = Object.fromEntries(o.integrations.map((i) => [i.name, i.o]));
    expect(byName.CaptureConsole.levels).toEqual(['error', 'warn']);
    expect(byName.HttpClient.failedRequestStatusCodes).toEqual([400, [403, 408], [410, 599]]);
    expect(byName.EventFilters.disableErrorDefaults).toBe(true);
    expect(byName.Vue).toBeTruthy();
    expect(router.onError).toHaveBeenCalledTimes(1);
    // router errors are captured
    router.onError.mock.calls[0][0](new Error('Failed to fetch dynamically imported module'));
    expect(h.calls.captureException.some((c) => c.ctx?.tags?.source === 'router')).toBe(true);
  });

  it('beforeSend scrubs, attaches error details, un-crashes HTTP answers and samples loops', async () => {
    const mod = await boot();
    await mod.default({ app: {}, router: null });
    const beforeSend = h.calls.init.beforeSend;
    const err = Object.assign(new Error('Device busy'), { code: 'DEVICE_MEMORYBUSY' });
    const ev = beforeSend({ level: 'error', exception: { values: [{ type: 'Error', value: 'Device busy https://x.test/cb?token=abc', mechanism: { type: 'http.client', handled: false } }] } }, { originalException: err });
    expect(ev.exception.values[0].value).toBe('Device busy https://x.test/cb?token=[REDACTED]');
    expect(ev.exception.values[0].mechanism.handled).toBe(true);
    expect(ev.contexts.error_details).toMatchObject({ code: 'DEVICE_MEMORYBUSY' });
    expect(ev.tags.error_code).toBe('DEVICE_MEMORYBUSY');
    let sent = 0;
    for (let i = 0; i < 40; i++) if (beforeSend({ level: 'warning', logger: 'console', message: `keepalive failed ${i}` }, {})) sent++;
    expect(sent).toBe(7); // occurrences 1, 2, 3 (burst) + 4, 8, 16, 32 (powers of two)
  });

  it('replays errors raised before init and reports a session that died on screen', async () => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
    vi.resetModules();
    const modPromise = import('../../src/boot/sentry');
    const mod = await modPromise;
    const early = new Event('error'); early.error = new Error('boot-time failure');
    window.dispatchEvent(early);
    h.previousSession = { appVersion: '3.9.38', platform: 'android', route: 'record', recording: true, bleSync: false };
    await mod.default({ app: {}, router: null });
    expect(h.calls.captureException.some((c) => c.e?.message === 'boot-time failure' && c.ctx?.tags?.phase === 'boot')).toBe(true);
    const unclean = h.calls.captureMessage.find((c) => /previous session ended unexpectedly/.test(c.m));
    expect(unclean).toBeTruthy();
    expect(unclean.ctx).toMatchObject({ level: 'error', tags: { unclean_exit: 'true', 'previous.recording': 'true' } });
  });
});
