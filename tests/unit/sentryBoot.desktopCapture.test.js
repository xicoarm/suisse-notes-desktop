import { describe, it, expect, beforeEach, vi } from 'vitest';

// The desktop renderer must capture what the mobile client already captures:
// console errors and warnings (where the app logs its handled failures), failed
// HTTP answers, errors from before init, and router errors. Until 4.7.1 the
// desktop init had none of them, so a failed recording start or a refused IPC
// call never left the user's machine.
const h = vi.hoisted(() => {
  const calls = { init: null, captureException: [], captureMessage: [], tags: {} };
  const sentry = {
    init: (opts) => { calls.init = opts; },
    vueIntegration: (o) => ({ name: 'Vue', o }),
    browserTracingIntegration: (o) => ({ name: 'BrowserTracing', o }),
    captureConsoleIntegration: (o) => ({ name: 'CaptureConsole', o }),
    httpClientIntegration: (o) => ({ name: 'HttpClient', o }),
    eventFiltersIntegration: (o) => ({ name: 'EventFilters', o }),
    replayIntegration: (o) => ({ name: 'Replay', o }),
    captureException: (e, ctx) => calls.captureException.push({ e, ctx }),
    captureMessage: (m, ctx) => calls.captureMessage.push({ m, ctx }),
    setTag: (k, v) => { calls.tags[k] = v; },
    addBreadcrumb: () => {},
    setUser: () => {},
    setContext: () => {}
  };
  return { calls, sentry };
});

vi.mock('@sentry/vue', () => h.sentry);
vi.mock('../../src/utils/platform', () => ({ isCapacitor: () => false, isElectron: () => true, getPlatform: () => 'electron' }));

async function boot({ isE2E = false } = {}) {
  vi.resetModules();
  h.calls.init = null;
  h.calls.captureException.length = 0;
  window.electronAPI = { isE2E, app: { getVersion: async () => '4.7.1' } };
  const module = await import('../../src/boot/sentry');
  const router = { onError: vi.fn(), afterEach: vi.fn() };
  await module.default({ app: {}, router });
  return { module, router };
}

describe('desktop renderer Sentry init', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('captures console errors and warnings, failed HTTP answers and keeps no default ignore list', async () => {
    await boot();
    const options = h.calls.init;
    expect(options).toBeTruthy();
    const byName = Object.fromEntries(options.integrations.map(i => [i.name, i.o]));
    expect(byName.CaptureConsole.levels).toEqual(['error', 'warn']);
    expect(byName.HttpClient.failedRequestStatusCodes).toBeTruthy();
    expect(byName.EventFilters.disableErrorDefaults).toBe(true);
    expect(byName.Replay).toBeTruthy();
    expect(options.release).toBe('suisse-notes@4.7.1');
    // Under vitest import.meta.env.DEV is true; the packaged app reports 'production'.
    expect(options.environment).toBe('development');
    expect(options.sendClientReports).toBe(true);
    expect(options.maxBreadcrumbs).toBe(200);
    expect(h.calls.tags.process).toBe('renderer');
  });

  it('downgrades transient browser fetch and network errors to warning', async () => {
    await boot();
    const beforeSend = h.calls.init.beforeSend;

    // Chromium Failed to fetch
    const fetchEvent = beforeSend({
      level: 'error',
      exception: { values: [{ type: 'TypeError', value: 'Failed to fetch (app.suisse-meets.ch)' }] }
    }, { originalException: new TypeError('Failed to fetch') });
    expect(fetchEvent.level).toBe('warning');
    expect(fetchEvent.tags.transient_network).toBe('true');

    // Safari Load failed
    const safariEvent = beforeSend({
      level: 'error',
      exception: { values: [{ type: 'TypeError', value: 'Load failed' }] }
    }, { originalException: new TypeError('Load failed') });
    expect(safariEvent.level).toBe('warning');
    expect(safariEvent.tags.transient_network).toBe('true');

    // TimeoutError
    const timeoutErr = new Error('Request timed out after 30s');
    timeoutErr.name = 'TimeoutError';
    const timeoutEvent = beforeSend({
      level: 'error',
      exception: { values: [{ type: 'TimeoutError', value: 'Request timed out after 30s (network error)' }] }
    }, { originalException: timeoutErr });
    expect(timeoutEvent.level).toBe('warning');
    expect(timeoutEvent.tags.transient_network).toBe('true');
  });

  it('scrubs, tags and samples repeats through beforeSend', async () => {
    await boot();
    const beforeSend = h.calls.init.beforeSend;
    const event = beforeSend({ level: 'error', exception: { values: [{ type: 'Error', value: 'upload failed https://app.suisse-meets.ch/cb?token=secret123' }] } }, {});
    expect(event.exception.values[0].value).not.toContain('secret123');
    let delivered = 0;
    for (let i = 0; i < 40; i++) if (beforeSend({ level: 'warning', logger: 'console', message: 'chunk save retry failed' }, {})) delivered++;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(40);
  });

  it('replays errors raised before init and reports router errors', async () => {
    vi.resetModules();
    window.electronAPI = { isE2E: false, app: { getVersion: async () => '4.7.1' } };
    const module = await import('../../src/boot/sentry');
    // An error thrown while the app was still booting, before init ran.
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boot-time failure'), message: 'boot-time failure' }));
    const router = { onError: vi.fn(), afterEach: vi.fn() };
    await module.default({ app: {}, router });
    expect(h.calls.captureException.some(c => c.e?.message === 'boot-time failure' && c.ctx?.tags?.phase === 'boot')).toBe(true);
    expect(router.onError).toHaveBeenCalledTimes(1);
    const routerError = new Error('Failed to fetch dynamically imported module');
    router.onError.mock.calls[0][0](routerError);
    expect(h.calls.captureException.some(c => c.e === routerError && c.ctx?.tags?.source === 'router')).toBe(true);
  });

  it('stays silent in E2E runs so synthetic faults never reach production', async () => {
    await boot({ isE2E: true });
    expect(h.calls.init).toBeNull();
  });
});
