import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { beginSsoFlow, withFlowParams, consumeSsoFlow, hasPendingSsoFlow, clearSsoFlow, pkceChallenge, FLOW_TTL_MS } from '../../src/services/ssoFlow';
import { parseSSOCallbackUrl } from '../../src/utils/ssoCallback';

const require = createRequire(import.meta.url);
const mainFlow = require('../../src-electron/sso-flow.js');

const userB64 = Buffer.from(JSON.stringify({ id: 'u1' })).toString('base64url');

describe('mobile SSO flow (state + PKCE)', () => {
  beforeEach(() => clearSsoFlow());

  it('adds state and an S256 challenge to the login URL', async () => {
    const flow = await beginSsoFlow('microsoft');
    const url = new URL(withFlowParams('https://api.example/api/auth/microsoft/login?client=android', flow));
    expect(url.searchParams.get('client')).toBe('android');
    expect(url.searchParams.get('app_state')).toBe(flow.state);
    expect(url.searchParams.get('code_challenge')).toBe(flow.codeChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('RFC 7636 appendix B test vector', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('a crafted callback without a started sign-in is ignored', () => {
    const payload = parseSSOCallbackUrl(`suissenotes://auth/callback?token=t&user=${userB64}`);
    expect(consumeSsoFlow(payload)).toEqual({ ok: false, reason: 'no_pending_flow' });
  });

  it('a foreign state is ignored and the real flow stays pending', async () => {
    const flow = await beginSsoFlow('google');
    expect(consumeSsoFlow(parseSSOCallbackUrl(`suissenotes://auth/callback?state=other&token=t&user=${userB64}`)))
      .toEqual({ ok: false, reason: 'state_mismatch' });
    expect(consumeSsoFlow(parseSSOCallbackUrl('suissenotes://auth/callback?state=other&error=canceled')))
      .toEqual({ ok: false, reason: 'state_mismatch' });
    expect(hasPendingSsoFlow()).toBe(true);
    const ok = consumeSsoFlow(parseSSOCallbackUrl(`suissenotes://auth/callback?state=${flow.state}&auth_code=c1`));
    expect(ok).toEqual({ ok: true, provider: 'google', verifier: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/) });
  });

  it('a callback without state is never accepted (success or error), the flow keeps waiting', async () => {
    const flow = await beginSsoFlow('google');
    expect(consumeSsoFlow(parseSSOCallbackUrl(`suissenotes://auth/callback?token=t&user=${userB64}`)))
      .toEqual({ ok: false, reason: 'missing_state' });
    expect(consumeSsoFlow(parseSSOCallbackUrl('suissenotes://auth/callback?auth_code=c')))
      .toEqual({ ok: false, reason: 'missing_state' });
    expect(consumeSsoFlow(parseSSOCallbackUrl('suissenotes://auth/callback?error=canceled')))
      .toEqual({ ok: false, reason: 'missing_state' });
    expect(consumeSsoFlow(parseSSOCallbackUrl('suissenotes://auth/callback?code=sso_cancelled')))
      .toEqual({ ok: false, reason: 'missing_state' });
    expect(hasPendingSsoFlow()).toBe(true);
    expect(consumeSsoFlow({ token: 't', user: {}, state: flow.state }).ok).toBe(true);
  });

  it('Android process restart during SSO: the restored flow accepts the echoed state', async () => {
    const flow = await beginSsoFlow('microsoft');
    vi.resetModules();
    const restarted = await import('../../src/services/ssoFlow');
    expect(restarted.hasPendingSsoFlow()).toBe(true);
    // A crafted stateless link after the restart is still ignored ...
    expect(restarted.consumeSsoFlow({ token: 't', user: {}, state: '' })).toEqual({ ok: false, reason: 'missing_state' });
    // ... the real callback with the echoed state completes the sign-in.
    const ok = restarted.consumeSsoFlow(parseSSOCallbackUrl(`suissenotes://auth/callback?state=${flow.state}&token=t&user=${userB64}`));
    expect(ok).toEqual({ ok: true, provider: 'microsoft', verifier: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/) });
    expect(restarted.hasPendingSsoFlow()).toBe(false);
  });

  it('Android process restart: an echoed error ends the restored flow', async () => {
    const flow = await beginSsoFlow('google');
    vi.resetModules();
    const restarted = await import('../../src/services/ssoFlow');
    expect(restarted.consumeSsoFlow(parseSSOCallbackUrl(`suissenotes://auth/callback?state=${flow.state}&code=sso_cancelled`)).ok).toBe(true);
    expect(restarted.hasPendingSsoFlow()).toBe(false);
  });

  it('a flow is single-use', async () => {
    const flow = await beginSsoFlow('google');
    const payload = parseSSOCallbackUrl(`suissenotes://auth/callback?state=${flow.state}&token=t&user=${userB64}`);
    expect(consumeSsoFlow(payload).ok).toBe(true);
    expect(consumeSsoFlow(payload)).toEqual({ ok: false, reason: 'no_pending_flow' });
  });

  it('a flow expires', async () => {
    const t0 = Date.now();
    const flow = await beginSsoFlow('google', t0);
    const payload = { token: 't', user: { id: 'u1' }, state: flow.state };
    expect(consumeSsoFlow(payload, t0 + FLOW_TTL_MS + 1)).toEqual({ ok: false, reason: 'no_pending_flow' });
  });

  it('a local browser abort (set by the app, never by a URL) ends the flow', async () => {
    await beginSsoFlow('microsoft');
    expect(consumeSsoFlow({ error: 'canceled', local: true }).ok).toBe(true);
    expect(hasPendingSsoFlow()).toBe(false);
  });

  it('a URL cannot claim to be a local abort', () => {
    expect(parseSSOCallbackUrl('suissenotes://auth/callback?error=canceled&local=true')).toEqual({ error: 'canceled', state: '' });
  });

  it('an error with the matching state ends the flow', async () => {
    const flow = await beginSsoFlow('microsoft');
    expect(consumeSsoFlow(parseSSOCallbackUrl(`suissenotes://auth/callback?state=${flow.state}&error=x&code=sso_cancelled`)).ok).toBe(true);
    expect(hasPendingSsoFlow()).toBe(false);
  });

  it('a newer sign-in replaces the older one', async () => {
    const first = await beginSsoFlow('microsoft');
    await beginSsoFlow('google');
    expect(consumeSsoFlow({ token: 't', user: {}, state: first.state })).toEqual({ ok: false, reason: 'state_mismatch' });
  });
});

describe('callback parsing', () => {
  it('reads the one-time code and the state', () => {
    expect(parseSSOCallbackUrl('suissenotes://auth/callback?state=s&auth_code=c')).toEqual({ authCode: 'c', state: 's' });
  });
  it('keeps the error code contract', () => {
    expect(parseSSOCallbackUrl('suissenotes://auth/callback?code=sso_cancelled&state=s')).toEqual({ error: 'sso_cancelled', code: 'sso_cancelled', state: 's' });
  });
  it('refuses a non-object user', () => {
    const arr = Buffer.from('[1]').toString('base64url');
    expect(parseSSOCallbackUrl(`suissenotes://auth/callback?token=t&user=${arr}`)).toEqual({ error: 'invalid_callback', state: '' });
  });
  it('ignores other URLs', () => {
    expect(parseSSOCallbackUrl('suissenotes://other/callback?token=t')).toBeNull();
    expect(parseSSOCallbackUrl('https://evil.example/sso/x?token=t')).toBeNull();
  });
});

describe('desktop main SSO flow (src-electron/sso-flow.js)', () => {
  it('binds the callback to the flow main started', () => {
    let t = 1000;
    const store = mainFlow.createSsoFlowStore({ now: () => t });
    expect(store.consume(mainFlow.parseCallbackUrl(`suissenotes://auth/callback?token=t&user=${userB64}`)))
      .toEqual({ ok: false, reason: 'no_pending_flow' });
    const flow = store.begin('microsoft');
    const url = new URL(mainFlow.withFlowParams('https://api.example/api/auth/microsoft/login?client=desktop', flow));
    expect(url.searchParams.get('app_state')).toBe(flow.state);
    expect(store.consume(mainFlow.parseCallbackUrl(`suissenotes://auth/callback?state=bad&token=t&user=${userB64}`)))
      .toEqual({ ok: false, reason: 'state_mismatch' });
    const ok = store.consume(mainFlow.parseCallbackUrl(`suissenotes://auth/callback?state=${flow.state}&token=t&user=${userB64}`));
    expect(ok).toEqual({ ok: true, provider: 'microsoft', verifier: expect.any(String) });
    expect(store.hasPending()).toBe(false);
  });

  it('a callback without state is never accepted; a foreign error cannot abort the sign-in', () => {
    const store = mainFlow.createSsoFlowStore();
    const flow = store.begin('microsoft');
    for (const url of [
      `suissenotes://auth/callback?token=t&user=${userB64}`,
      'suissenotes://auth/callback?auth_code=c',
      'suissenotes://auth/callback?error=canceled',
      'suissenotes://auth/callback?code=sso_cancelled'
    ]) {
      expect(store.consume(mainFlow.parseCallbackUrl(url))).toEqual({ ok: false, reason: 'missing_state' });
    }
    expect(store.consume(mainFlow.parseCallbackUrl('suissenotes://auth/callback?state=x&error=canceled')))
      .toEqual({ ok: false, reason: 'state_mismatch' });
    expect(store.hasPending()).toBe(true);
    expect(store.consume(mainFlow.parseCallbackUrl(`suissenotes://auth/callback?state=${flow.state}&error=canceled`)).ok).toBe(true);
    expect(store.hasPending()).toBe(false);
  });

  it('S2: the flow survives a restart of the main process (same store), once, within 15 minutes', () => {
    // electron-store stand-in: survives the "restart" (a new flow store instance).
    const data = new Map();
    const disk = { get: (k) => (data.has(k) ? JSON.parse(data.get(k)) : undefined), set: (k, v) => { data.set(k, JSON.stringify(v)); }, delete: (k) => { data.delete(k); } };
    let t = 5000;
    const flow = mainFlow.createSsoFlowStore({ now: () => t, storage: disk }).begin('microsoft');
    // Cold start by the callback URL: a new instance on the same store.
    const restarted = mainFlow.createSsoFlowStore({ now: () => t, storage: disk });
    expect(restarted.hasPending()).toBe(true);
    expect(restarted.consume({ token: 't' })).toEqual({ ok: false, reason: 'missing_state' });
    expect(restarted.consume({ state: 'foreign', token: 't' })).toEqual({ ok: false, reason: 'state_mismatch' });
    expect(restarted.consume({ state: flow.state, auth_code: 'c' })).toEqual({ ok: true, provider: 'microsoft', verifier: expect.any(String) });
    // Consumed synchronously: gone from the store, a second consume (also after another restart) is refused.
    expect(data.size).toBe(0);
    expect(restarted.consume({ state: flow.state, token: 't' })).toEqual({ ok: false, reason: 'no_pending_flow' });
    expect(mainFlow.createSsoFlowStore({ now: () => t, storage: disk }).consume({ state: flow.state, token: 't' }))
      .toEqual({ ok: false, reason: 'no_pending_flow' });
    // Expired after a restart.
    const late = mainFlow.createSsoFlowStore({ now: () => t, storage: disk }).begin('google');
    t += mainFlow.FLOW_TTL_MS + 1;
    expect(mainFlow.createSsoFlowStore({ now: () => t, storage: disk }).consume({ state: late.state, error: 'canceled' }))
      .toEqual({ ok: false, reason: 'no_pending_flow' });
    expect(data.size).toBe(0);
  });

  it('S2: a new flow replaces the old one (also across a restart)', () => {
    const data = new Map();
    const disk = { get: (k) => data.get(k), set: (k, v) => { data.set(k, v); }, delete: (k) => { data.delete(k); } };
    const first = mainFlow.createSsoFlowStore({ storage: disk }).begin('microsoft');
    const second = mainFlow.createSsoFlowStore({ storage: disk }).begin('google');
    const restarted = mainFlow.createSsoFlowStore({ storage: disk });
    expect(restarted.consume({ state: first.state, token: 't' })).toEqual({ ok: false, reason: 'state_mismatch' });
    expect(restarted.consume({ state: second.state, token: 't' })).toMatchObject({ ok: true, provider: 'google' });
  });

  it('web hand-off: only a token the server confirms as bound is used', () => {
    expect(mainFlow.boundHandoffToken({ success: true, sessionToken: 's', expiresIn: 60, bound: true })).toBe('s');
    expect(mainFlow.boundHandoffToken({ success: true, sessionToken: 'legacy' })).toBeNull();
    expect(mainFlow.boundHandoffToken({ success: true, sessionToken: 'legacy', bound: false })).toBeNull();
    expect(mainFlow.boundHandoffToken({ success: true, bound: true })).toBeNull();
    expect(mainFlow.boundHandoffToken(null)).toBeNull();
  });

  it('expires flows', () => {
    let t = 0;
    const store = mainFlow.createSsoFlowStore({ now: () => t });
    const flow = store.begin('google');
    t = mainFlow.FLOW_TTL_MS + 1;
    expect(store.consume({ state: flow.state, token: 't' })).toEqual({ ok: false, reason: 'no_pending_flow' });
  });

  it('parses the PKCE callback', () => {
    expect(mainFlow.parseCallbackUrl('suissenotes://auth/callback?state=s&auth_code=c')).toEqual({ state: 's', authCode: 'c' });
    expect(mainFlow.parseCallbackUrl('suissenotes://x/y')).toBeNull();
  });

  it('challenge matches the RFC 7636 vector', () => {
    expect(mainFlow.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
