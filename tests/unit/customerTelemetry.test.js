import { describe, it, expect, vi } from 'vitest';
import {
  buildStepPayload, createStepTracker, newStepSid, sendCustomerStep, TELEMETRY_PATH
} from '../../src/services/customerTelemetry';
import { loginFieldProblems, registerFieldProblems } from '../../src/utils/entryForms';

const SID = 'abc123def456';

describe('buildStepPayload (POST /api/telemetry/customer-step contract)', () => {
  it('builds the minimal payload', () => {
    expect(buildStepPayload({ flow: 'signup', event: 'view', sid: SID })).toEqual({ flow: 'signup', event: 'view', sid: SID });
  });

  it('rejects unknown flows, events and malformed sids', () => {
    expect(buildStepPayload({ flow: 'register', event: 'view', sid: SID })).toBeNull();
    expect(buildStepPayload({ flow: 'login', event: 'clicked', sid: SID })).toBeNull();
    expect(buildStepPayload({ flow: 'login', event: 'view', sid: 'ABC123' })).toBeNull();
    expect(buildStepPayload({ flow: 'login', event: 'view', sid: 'abc' })).toBeNull();
    expect(buildStepPayload({ flow: 'login', event: 'view', sid: 'a'.repeat(25) })).toBeNull();
  });

  it('keeps only contract-shaped optional parts - never anything that could be user input', () => {
    const payload = buildStepPayload({
      flow: 'login',
      event: 'blocked',
      sid: SID,
      attempts: 2,
      fields: ['email:missing', 'email:missing', 'jane@example.com', 'password:too short', 'password:missing'],
      reason: 'status_401'
    });
    expect(payload).toEqual({ flow: 'login', event: 'blocked', sid: SID, attempts: 2, fields: ['email:missing', 'password:missing'], reason: 'status_401' });
    expect(buildStepPayload({ flow: 'login', event: 'rejected', sid: SID, reason: 'Invalid credentials' })).not.toHaveProperty('reason');
    expect(buildStepPayload({ flow: 'login', event: 'sent', sid: SID, attempts: -1 })).not.toHaveProperty('attempts');
    expect(buildStepPayload({ flow: 'login', event: 'sent', sid: SID, attempts: 1.5 })).not.toHaveProperty('attempts');
  });
});

describe('newStepSid', () => {
  it('matches /^[a-z0-9]{6,24}$/ and differs per visit', () => {
    const a = newStepSid();
    const b = newStepSid();
    expect(a).toMatch(/^[a-z0-9]{6,24}$/);
    expect(a).not.toBe(b);
    expect(newStepSid(8, () => 0.5)).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe('createStepTracker', () => {
  const tracker = () => {
    const send = vi.fn();
    return { t: createStepTracker('signup', { send, sid: SID }), send, events: () => send.mock.calls.map(c => c[0].event) };
  };

  it('reports view once, blocked with fields, sent, rejected, done', () => {
    const { t, send, events } = tracker();
    t.view(); t.view();
    t.noteInput();
    t.blocked(['email:invalid']);
    t.sent();
    t.rejected('status_409');
    t.sent();
    t.done();
    t.left();
    expect(events()).toEqual(['view', 'blocked', 'sent', 'rejected', 'sent', 'done']);
    expect(send.mock.calls[1][0]).toEqual({ flow: 'signup', event: 'blocked', sid: SID, attempts: 1, fields: ['email:invalid'] });
    expect(send.mock.calls[3][0]).toEqual({ flow: 'signup', event: 'rejected', sid: SID, attempts: 2, reason: 'status_409' });
    expect(send.mock.calls[5][0]).toEqual({ flow: 'signup', event: 'done', sid: SID, attempts: 3 });
  });

  it('reports "left" only after typing or a refused attempt, and only once', () => {
    const quiet = tracker();
    quiet.t.view();
    quiet.t.left();
    expect(quiet.events()).toEqual(['view']);

    const typed = tracker();
    typed.t.view();
    typed.t.noteInput();
    typed.t.left();
    typed.t.left();
    expect(typed.events()).toEqual(['view', 'left']);

    const refused = tracker();
    refused.t.blocked(['name:missing']);
    refused.t.left();
    expect(refused.events()).toEqual(['blocked', 'left']);
  });

  it('never throws when sending fails', () => {
    const t = createStepTracker('login', { send: () => { throw new Error('offline'); }, sid: SID });
    expect(() => t.view()).not.toThrow();
    const rejecting = createStepTracker('login', { send: () => Promise.reject(new Error('offline')), sid: SID });
    expect(() => rejecting.view()).not.toThrow();
  });
});

describe('sendCustomerStep', () => {
  it('POSTs JSON to the API base URL, keepalive, without credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const payload = buildStepPayload({ flow: 'login', event: 'view', sid: SID });
    await expect(sendCustomerStep(payload, { fetchImpl, baseUrl: 'https://app.example.ch' })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(`https://app.example.ch${TELEMETRY_PATH}`, expect.objectContaining({
      method: 'POST', keepalive: true, credentials: 'omit', body: JSON.stringify(payload)
    }));
  });

  it('swallows network failures and refuses invalid payloads', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(sendCustomerStep({ flow: 'login' }, { fetchImpl, baseUrl: 'https://x' })).resolves.toBe(true);
    await expect(sendCustomerStep(null, { fetchImpl, baseUrl: 'https://x' })).resolves.toBe(false);
  });
});

describe('field problems (telemetry words, no values)', () => {
  it('login', () => {
    expect(loginFieldProblems({ email: ' ', password: '' })).toEqual(['email:missing', 'password:missing']);
    expect(loginFieldProblems({ email: 'a@b.ch', password: 'x' })).toEqual([]);
  });

  it('registration', () => {
    expect(registerFieldProblems({})).toEqual(['name:missing', 'email:missing', 'password:missing', 'confirmPassword:missing']);
    expect(registerFieldProblems({ name: 'A', email: 'nope', password: 'short', confirmPassword: 'other' }))
      .toEqual(['email:invalid', 'password:too_short', 'confirmPassword:mismatch']);
    expect(registerFieldProblems({ name: 'A', email: 'a@b.ch', password: 'longenough', confirmPassword: 'longenough' })).toEqual([]);
    for (const field of registerFieldProblems({ name: 'x', email: 'jane@', password: 'a', confirmPassword: 'b' })) {
      expect(buildStepPayload({ flow: 'signup', event: 'blocked', sid: SID, fields: [field] }).fields).toEqual([field]);
    }
  });
});
