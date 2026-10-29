// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// Main process: errors and log lines go to Sentry as raw Error objects
// (sentry-reporting.js -> captureException). The main beforeSend/
// beforeBreadcrumb must redact every part of the event. This drives the real
// SDK send path (client -> beforeSend -> transport) with synthetic secrets
// and inspects the bytes that would leave the device.

const require = createRequire(import.meta.url);
const Sentry = require('@sentry/node');
const { createTransport } = require('@sentry/core');
const reporting = require('../../src-electron/sentry-reporting.js');

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJzeW50aGV0aWMtdXNlciJ9.c3ludGhldGljLXNpZ25hdHVyZQ';
const SECRETS = [
  JWT,
  'synthetic-session-token-0001',
  'synthetic-verifier-0002',
  'synthetic-password-0003',
  'synthetic-state-0004',
  'synthetic-sas-0005',
  'alice.synthetic@example.com',
  'alicesynthuser'
];

const sent = [];
Sentry.init({
  dsn: 'https://public@o0.ingest.example.invalid/1',
  defaultIntegrations: false,
  integrations: [],
  skipOpenTelemetrySetup: true,
  attachStacktrace: true,
  beforeSend: (event) => reporting.redactEvent(event),
  beforeBreadcrumb: (crumb) => reporting.redactBreadcrumb(crumb),
  transport: (options) => createTransport(options, async (request) => {
    sent.push(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8'));
    return { statusCode: 200 };
  })
});
afterAll(() => Sentry.close());

const fakeLog = () => ({ hooks: [] });

describe('main-process Sentry redaction (real send path)', () => {
  it('electron-main wires redactEvent into beforeSend and redactBreadcrumb into beforeBreadcrumb', () => {
    const main = readFileSync('src-electron/electron-main.js', 'utf8');
    const init = main.slice(main.indexOf('Sentry.init({'), main.indexOf('Sentry.init({') + 4000);
    expect(init).toContain('return sentryReporting.redactEvent(event);');
    expect(init).toContain('return sentryReporting.redactBreadcrumb(crumb);');
    expect(main.indexOf("const sentryReporting = require('./sentry-reporting');")).toBeLessThan(main.indexOf('Sentry.init({'));
  });

  it('a logged raw Error with secrets in message, stack, extra and breadcrumbs leaves the device redacted', async () => {
    sent.length = 0;
    const log = fakeLog();
    reporting.installLogReporting({ log, Sentry });
    const hook = log.hooks[0];
    // Breadcrumbs (info log line + direct) carrying secrets.
    hook({ level: 'info', data: [`opened suissenotes://auth/callback?state=synthetic-state-0004&token=${JWT}`] }, { name: 'file' });
    Sentry.addBreadcrumb({ category: 'http', message: 'PUT https://blob.example/x?sig=synthetic-sas-0005', data: { url: 'https://api.example/a?session=synthetic-session-token-0001', authorization: `Bearer ${JWT}` } });
    // An Error whose message and stack carry secrets, plus extra/context data.
    const err = new Error(`hand-off failed for https://app.example/m?session=synthetic-session-token-0001#hv=synthetic-verifier-0002 user alice.synthetic@example.com Bearer ${JWT}`);
    err.stack = `${err.message}\n    at open (/Users/alicesynthuser/app/main.js:1:1)\n    at C:\\Users\\alicesynthuser\\app\\main.js:2:2`;
    Sentry.setExtra('body', JSON.stringify({ sessionToken: 'synthetic-session-token-0001', codeVerifier: 'synthetic-verifier-0002', password: 'synthetic-password-0003' }));
    Sentry.setContext('auth', { token: 'synthetic-session-token-0001', note: `state=synthetic-state-0004` });
    Sentry.setUser({ id: 'u-1', email: 'alice.synthetic@example.com' });
    hook({ level: 'error', data: ['Create web session failed', err] }, { name: 'file' });
    await Sentry.flush(2000);

    expect(sent.length).toBeGreaterThan(0);
    const wire = sent.join('\n');
    expect(wire).toContain('hand-off failed'); // the event itself was sent
    for (const secret of SECRETS) expect(wire).not.toContain(secret);
    expect(wire).toContain('u-1'); // opaque id stays
  });

  it('redactEvent covers exception values, frames, extra, contexts, request and breadcrumbs', () => {
    const event = reporting.redactEvent({
      message: `x?token=${JWT}`,
      exception: { values: [{ value: 'password: synthetic-password-0003', stacktrace: { frames: [{ filename: '/home/alicesynthuser/a.js', vars: { token: 'synthetic-session-token-0001' } }] } }] },
      extra: { nested: { deep: [`code_verifier=synthetic-verifier-0002`] } },
      contexts: { c: { authorization: 'Bearer x' } },
      request: { url: 'https://a.example/?session=synthetic-session-token-0001', headers: { cookie: 'auth-token=x', Authorization: 'Bearer y' } },
      breadcrumbs: [{ message: `state=synthetic-state-0004`, data: { sessionToken: 'synthetic-session-token-0001' } }],
      user: { id: 'u-1', email: 'alice.synthetic@example.com', ip_address: '1.2.3.4' }
    });
    const text = JSON.stringify(event);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain('auth-token=x');
    expect(event.user).toEqual({ id: 'u-1' });
  });
});
