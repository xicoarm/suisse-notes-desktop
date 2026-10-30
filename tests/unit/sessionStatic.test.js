import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { createRequire } from 'module';

// Static guards of the session authority (security review 10/2026 round 6).
// E2: token and user are written only by applySession; no other caller of
//     saveToken / storeToken / storeSession, no IPC that stores without a ticket.
// E10: no code path accepts an SSO result without the state.
// Both failed at 2349920b.

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isMobile: () => true, isIOS: () => false, isAndroid: () => true,
  getPlatform: () => 'android', PlatformConstants: {}
}));

const require = createRequire(import.meta.url);
const ROOT = join(__dirname, '..', '..');

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(js|vue|cjs|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const files = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'src-electron'))]
  .map((path) => ({ path: relative(ROOT, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));

const callers = (re) => files.filter((f) => re.test(f.text)).map((f) => f.path).sort();

describe('E2: one writer of token and user', () => {
  it('saveToken( is called only by the desktop session authority (and defined in the vault)', () => {
    expect(callers(/\bsaveToken\s*\(/)).toEqual(['src-electron/session-authority.js', 'src-electron/token-vault.js']);
  });

  it('storeToken / storeSession / storeUserCredentials do not exist any more', () => {
    expect(callers(/\b(storeToken|storeSession|storeUserCredentials|clearAllCredentials)\b/)).toEqual([]);
  });

  it('the auth keystore entries are written only by the mobile session authority', () => {
    expect(callers(/setSecureItem\(\s*(STORAGE_KEYS\.(AUTH_TOKEN|USER_INFO|REFRESH_TOKEN)|'(authToken|userInfo|refreshToken)')/))
      .toEqual(['src/services/sessionAuthority.js']);
  });

  it('desktop: no IPC stores a token or a user without a ticket', () => {
    const main = files.find((f) => f.path === 'src-electron/electron-main.js').text;
    const preload = files.find((f) => f.path === 'src-electron/electron-preload.js').text;
    for (const channel of ['auth:saveToken', 'auth:saveUserInfo', 'auth:clearToken', 'auth:saveRefreshToken']) {
      expect(main).not.toContain(`'${channel}'`);
      expect(preload).not.toContain(`'${channel}'`);
    }
    expect(main).not.toMatch(/configStore\.(set|delete)\('userInfo'/);
    expect(main).not.toMatch(/tokenVault\.(saveToken|clearToken)/);
  });

  it('desktop: applySession without a current ticket is refused', () => {
    const { createSessionAuthority } = require('../../src-electron/session-authority.js');
    const writes = [];
    const authority = createSessionAuthority({
      recordStore: { read: () => null, write: (t) => writes.push(t) },
      vault: { saveToken: (t) => { writes.push(t); return { success: true }; }, clearToken: () => ({ success: true }), getToken: () => null },
      userStore: { get: () => null, set: (u) => { writes.push(u); return true; }, delete: () => true },
      flows: { clear: () => true, peek: () => null }
    });
    for (const ticket of [undefined, null, {}, { epoch: 1 }, { epoch: '0' }]) {
      expect(authority.applySession(ticket, { token: 'h.e30.s', user: { id: 'x' } }, { kind: 'login' }).applied).toBe(false);
    }
    expect(writes).toEqual([]);
  });
});

describe('E10: no stateless fallback', () => {
  const stateless = [
    { token: 't', user: { id: 'u' } },
    { authCode: 'c' },
    { error: 'canceled' },
    { error: 'x', code: 'sso_cancelled' },
    { error: 'canceled', local: true },
    { token: 't', user: { id: 'u' }, local: true },
    { authCode: 'c', state: '' },
    { token: 't', user: { id: 'u' }, state: null },
    { token: 't', user: { id: 'u' }, state: 42 },
    { token: 't', user: { id: 'u' }, state: ['s'] }
  ];

  it('mobile consumeSsoFlow accepts none of them while a flow is open', async () => {
    const { beginSsoFlow, consumeSsoFlow, hasPendingSsoFlow } = await import('../../src/services/ssoFlow');
    await beginSsoFlow('microsoft');
    for (const payload of stateless) expect(consumeSsoFlow(payload).ok).toBe(false);
    expect(hasPendingSsoFlow()).toBe(true);
  });

  it('desktop consume accepts none of them while a flow is open', () => {
    const { createSsoFlowStore } = require('../../src-electron/sso-flow.js');
    const flows = createSsoFlowStore();
    flows.begin('google', 0);
    for (const payload of stateless) expect(flows.consume(payload, 0).ok).toBe(false);
    expect(flows.hasPending(0)).toBe(true);
  });

  it('the source has no branch that accepts a result without its state', () => {
    const mobile = files.find((f) => f.path === 'src/services/ssoFlow.js').text;
    const consume = mobile.slice(mobile.indexOf('export function consumeSsoFlow'));
    expect(consume).not.toMatch(/\.local\b/);
    expect(consume).toMatch(/if \(!state\) return \{ ok: false, reason: 'missing_state' \}/);
    const desktop = files.find((f) => f.path === 'src-electron/sso-flow.js').text;
    expect(desktop).toMatch(/if \(!state\) return \{ ok: false, reason: 'missing_state' \}/);
    // No server or network answer weakens the check: nothing reads a
    // capability or "state supported" flag.
    for (const f of files) expect(f.text).not.toMatch(/stateEcho(Supported|Missing)|sso\/capabilities|skipState|allowStateless/);
  });
});
