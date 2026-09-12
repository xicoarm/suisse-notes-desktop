import { describe, it, expect } from 'vitest';
import { redactSecrets, redactUrl } from '../../src/utils/redact';
import { scrubSensitiveData } from '../../src/boot/sentry';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJhYmMiLCJlbWFpbCI6ImFAYi5jaCJ9.s1gn4tur3s1gn4tur3';

describe('redactSecrets / redactUrl', () => {
  it('hides token/user query values in a custom-scheme SSO callback', () => {
    const url = `suissenotes://auth/callback?token=${JWT}&user=eyJpZCI6InUxIn0`;
    const out = redactUrl(url);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('eyJpZCI6InUxIn0');
    expect(out).toMatch(/token=(%5B|\[)REDACTED(%5D|\])/);
    expect(out.startsWith('suissenotes://auth/callback')).toBe(true);
  });

  it('keeps non-secret query parameters', () => {
    expect(redactUrl('https://app.suisse-meets.ch/api/auth/google/login?client=ios'))
      .toBe('https://app.suisse-meets.ch/api/auth/google/login?client=ios');
  });

  it('redacts bare JWTs and token= fragments inside free text', () => {
    const text = `sso: startAuth returned url=suissenotes://auth/callback?token=${JWT}&user=abc and also ${JWT}`;
    const out = redactSecrets(text);
    expect(out).not.toContain(JWT);
    expect(out).toContain('token=[REDACTED]');
    expect(out).toContain('user=[REDACTED]');
  });

  it('never throws on garbage input', () => {
    expect(redactUrl('not a url ?token=abc')).toBe('not a url ?token=[REDACTED]');
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets('')).toBe('');
  });
});

describe('Sentry beforeSend scrubbing', () => {
  it('scrubs message, exception values, breadcrumbs and request url', () => {
    const event = {
      message: `appUrlOpen fired url=suissenotes://auth/callback?token=${JWT}`,
      request: { url: `https://x/?session=${JWT}`, headers: { authorization: 'Bearer x' } },
      exception: { values: [{ value: `boom ${JWT}` }] },
      breadcrumbs: [
        { message: `nav token=${JWT}`, data: { url: `https://x/?token=${JWT}`, headers: { Authorization: 'Bearer y' } } },
      ],
    };
    const out = scrubSensitiveData(event, {});
    const text = JSON.stringify(out);
    expect(text).not.toContain(JWT);
    expect(out.request.headers.authorization).toBe('[REDACTED]');
    expect(out.breadcrumbs[0].data.headers.Authorization).toBe('[REDACTED]');
  });
});
