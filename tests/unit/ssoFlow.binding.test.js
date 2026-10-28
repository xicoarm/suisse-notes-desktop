import { describe, it, expect, beforeEach } from 'vitest';
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

  it('a success without state or with a foreign state is ignored and the real flow stays pending', async () => {
    const flow = await beginSsoFlow('google');
    expect(consumeSsoFlow(parseSSOCallbackUrl(`suissenotes://auth/callback?token=t&user=${userB64}`)))
      .toEqual({ ok: false, reason: 'missing_state' });
    expect(consumeSsoFlow(parseSSOCallbackUrl(`suissenotes://auth/callback?state=other&token=t&user=${userB64}`)))
      .toEqual({ ok: false, reason: 'state_mismatch' });
    expect(hasPendingSsoFlow()).toBe(true);
    const ok = consumeSsoFlow(parseSSOCallbackUrl(`suissenotes://auth/callback?state=${flow.state}&auth_code=c1`));
    expect(ok).toMatchObject({ ok: true, provider: 'google' });
    expect(ok.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
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

  it('an error/cancel ends a started sign-in even without state', async () => {
    await beginSsoFlow('microsoft');
    expect(consumeSsoFlow({ error: 'canceled' }).ok).toBe(true);
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
    expect(store.consume(mainFlow.parseCallbackUrl(`suissenotes://auth/callback?token=t&user=${userB64}`)))
      .toEqual({ ok: false, reason: 'missing_state' });
    const ok = store.consume(mainFlow.parseCallbackUrl(`suissenotes://auth/callback?state=${flow.state}&token=t&user=${userB64}`));
    expect(ok).toMatchObject({ ok: true, provider: 'microsoft' });
    expect(store.hasPending()).toBe(false);
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
