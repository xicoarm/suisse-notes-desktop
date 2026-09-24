import { describe, it, expect, vi } from 'vitest';
import {
  HTTP_CAPTURE_STATUS_CODES,
  createEarlyErrorBuffer,
  createOccurrenceSampler,
  errorDetails,
  evaluatePreviousSession,
  eventKey,
  sanitizeConsoleArguments,
  treatHttpClientAsHandled
} from '../../src/utils/sentryCapture';

const inRanges = (status) => HTTP_CAPTURE_STATUS_CODES.some((r) => (Array.isArray(r) ? status >= r[0] && status <= r[1] : status === r));

describe('HTTP capture status codes', () => {
  it('captures client and server failures but not the answers of normal operation', () => {
    for (const s of [400, 403, 404, 405, 408, 410, 413, 422, 429, 500, 501, 505, 599]) expect(inRanges(s), `status ${s}`).toBe(true);
    for (const s of [200, 204, 301, 304, 401, 402, 409, 600]) expect(inRanges(s), `status ${s}`).toBe(false);
  });
  it('leaves gateway answers (backend restarting) to the API retry layer (ELECTRON-6F)', () => {
    for (const s of [502, 503, 504]) expect(inRanges(s), `status ${s}`).toBe(false);
  });
});

describe('eventKey', () => {
  it('masks numbers and ids so one defect keeps one key', () => {
    const a = eventKey({ level: 'warning', logger: 'console', message: 'Upload failed for 3f2b8c1e-1111-4222-8333-944455566677 after 3 retries' });
    const b = eventKey({ level: 'warning', logger: 'console', message: 'Upload failed for 0a0b0c0d-aaaa-4bbb-8ccc-ddddeeeeffff after 12 retries' });
    expect(a).toBe(b);
  });
  it('separates levels, origins and different messages', () => {
    const base = { level: 'error', message: 'x failed' };
    expect(eventKey(base)).not.toBe(eventKey({ ...base, level: 'warning' }));
    expect(eventKey(base)).not.toBe(eventKey({ ...base, logger: 'console' }));
    expect(eventKey(base)).not.toBe(eventKey({ ...base, message: 'y failed' }));
  });
  it('uses the exception type and value when present', () => {
    const e = { level: 'error', exception: { values: [{ type: 'TypeError', value: 'a is undefined', mechanism: { type: 'onerror' } }] } };
    expect(eventKey(e)).toBe('error|onerror|TypeError: a is undefined');
  });
});

describe('createOccurrenceSampler', () => {
  it('always sends a new problem, then only the burst and powers of two', () => {
    const sample = createOccurrenceSampler();
    const sent = [];
    for (let i = 1; i <= 100; i++) {
      const ev = sample({ level: 'error', message: `BLE poll failed (tick ${i})` });
      if (ev) sent.push(ev.extra?.occurrences_this_session || 1);
    }
    expect(sent).toEqual([1, 2, 3, 4, 5, 8, 16, 32, 64]);
  });
  it('uses a smaller burst for warnings and keeps distinct problems independent', () => {
    const sample = createOccurrenceSampler();
    const warnSent = [];
    for (let i = 1; i <= 20; i++) if (sample({ level: 'warning', message: 'keepalive failed' })) warnSent.push(i);
    expect(warnSent).toEqual([1, 2, 3, 4, 8, 16]);
    expect(sample({ level: 'warning', message: 'a completely different problem' })).not.toBeNull();
  });
  it('bounds its memory', () => {
    const sample = createOccurrenceSampler({ maxKeys: 10 });
    for (let i = 0; i < 1000; i++) sample({ level: 'error', message: `distinct problem ${'x'.repeat(i % 50)}` });
    // no throw, still sampling a brand-new message
    expect(sample({ level: 'error', message: 'brand new' })).not.toBeNull();
  });
});

describe('treatHttpClientAsHandled', () => {
  it('flips only http.client mechanisms', () => {
    const ev = { exception: { values: [{ mechanism: { type: 'http.client', handled: false } }, { mechanism: { type: 'onerror', handled: false } }] } };
    treatHttpClientAsHandled(ev);
    expect(ev.exception.values[0].mechanism.handled).toBe(true);
    expect(ev.exception.values[1].mechanism.handled).toBe(false);
  });
});

describe('errorDetails', () => {
  it('keeps whitelisted primitive fields and redacts secrets inside them', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'LIST_INCOMPLETE', status: 503, canRetry: true,
      reason: 'callback suissenotes://auth/callback?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
      config: { headers: { Authorization: 'Bearer secret' } }
    });
    const d = errorDetails(err);
    expect(d).toMatchObject({ code: 'LIST_INCOMPLETE', status: 503, canRetry: true });
    expect(d.reason).not.toMatch(/eyJ/);
    expect(JSON.stringify(d)).not.toMatch(/Bearer|Authorization/);
  });
  it('returns null without details', () => {
    expect(errorDetails(new Error('plain'))).toBeNull();
    expect(errorDetails('text')).toBeNull();
  });
});

describe('sanitizeConsoleArguments', () => {
  it('redacts secret keys, tokens and bounds the payload', () => {
    const axiosLike = Object.assign(new Error('Request failed'), { status: 500, config: { headers: { Authorization: 'Bearer abc' } } });
    const ev = { extra: { arguments: ['Token refresh failed:', axiosLike, { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', nested: { password: 'p', ok: 1 } }] } };
    sanitizeConsoleArguments(ev);
    const text = JSON.stringify(ev.extra.arguments);
    expect(text).not.toMatch(/Bearer|abc|eyJ|"p"/);
    expect(ev.extra.arguments[1]).toMatchObject({ name: 'Error', message: 'Request failed', status: 500 });
    expect(ev.extra.arguments[2]).toMatchObject({ token: '[REDACTED]', nested: { password: '[REDACTED]', ok: 1 } });
  });
});

describe('createEarlyErrorBuffer', () => {
  it('buffers errors and rejections until drained, then detaches', () => {
    const target = new EventTarget();
    const buffer = createEarlyErrorBuffer(target);
    const err = new Error('early');
    const e1 = new Event('error'); e1.error = err;
    target.dispatchEvent(e1);
    const e2 = new Event('unhandledrejection'); e2.reason = 'no reason object';
    target.dispatchEvent(e2);
    const captured = [];
    expect(buffer.drain((item) => captured.push(item))).toBe(2);
    expect(captured[0]).toMatchObject({ kind: 'error', error: err });
    expect(captured[1]).toMatchObject({ kind: 'unhandledrejection', error: 'no reason object' });
    const e3 = new Event('error'); e3.error = new Error('after init');
    target.dispatchEvent(e3);
    expect(buffer.items).toHaveLength(0);
  });
  it('never lets a failing capture break the boot', () => {
    const target = new EventTarget();
    const buffer = createEarlyErrorBuffer(target);
    const ev = new Event('error'); ev.error = new Error('x');
    target.dispatchEvent(ev);
    expect(() => buffer.drain(() => { throw new Error('capture failed'); })).not.toThrow();
  });
  it('caps the buffer', () => {
    const target = new EventTarget();
    const buffer = createEarlyErrorBuffer(target, { max: 3 });
    for (let i = 0; i < 10; i++) { const ev = new Event('error'); ev.error = new Error(String(i)); target.dispatchEvent(ev); }
    const fn = vi.fn();
    expect(buffer.drain(fn)).toBe(3);
  });
});

describe('evaluatePreviousSession', () => {
  const now = Date.parse('2026-09-12T20:00:00Z');
  it('reports a session that never left the screen', () => {
    const v = evaluatePreviousSession({ state: 'foreground', appVersion: '3.9.38', platform: 'ios', startedAt: now - 3600_000, lastSeenAt: now - 600_000, route: 'device', recording: false, bleSync: true }, now);
    expect(v).toMatchObject({ appVersion: '3.9.38', platform: 'ios', route: 'device', bleSync: true, recording: false, minutesSinceLastSeen: 10, sessionMinutes: 50 });
  });
  it('ignores sessions that went to the background and missing state', () => {
    expect(evaluatePreviousSession({ state: 'background', lastSeenAt: now }, now)).toBeNull();
    expect(evaluatePreviousSession(null, now)).toBeNull();
    expect(evaluatePreviousSession('garbage', now)).toBeNull();
  });
});
