// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as discovery from '../../src/services/loginDiscovery';
import { loginFieldProblems } from '../../src/utils/entryForms';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    map
  };
}

// The real login-recognition block of the login page, compiled with narrow
// dependencies (the approach of loginPage.twoFactorStep.test.js).
function page({ mode = 'identifier-first', desktop = true, mobile = false, discover, login, local = memoryStorage(), session = memoryStorage() } = {}) {
  const source = fs.readFileSync('src/pages/LoginPage.vue', 'utf8').replace(/\r\n/g, '\n');
  const first = source.indexOf('// --- Login recognition (identifier-first)');
  const last = source.indexOf('// --- Second factor (2FA accounts', first);
  if (first < 0 || last < first) throw new Error('Missing login-recognition block');
  if (mode !== 'classic') local.setItem(discovery.LOGIN_MODE_CACHE_KEY, mode);
  const authStore = {
    loading: false,
    error: null,
    ssoProvider: null,
    ssoOutcome: { seq: 0, success: false },
    login: vi.fn(login || (async () => ({ success: true }))),
    clearError: vi.fn(() => { authStore.error = null; })
  };
  const deps = {
    ref: value => ({ value }),
    computed: read => ({ get value() { return read(); } }),
    watch: vi.fn(),
    isDesktopApp: desktop,
    isMobileApp: mobile,
    authStore,
    tracker: { blocked: vi.fn(), sent: vi.fn(), rejected: vi.fn(), done: vi.fn(), noteInput: vi.fn() },
    router: { push: vi.fn() },
    t: key => key,
    loginFieldProblems,
    resetCodeInputs: vi.fn(),
    startSSOFlow: vi.fn(),
    cancelSSOLogin: vi.fn(),
    ...discovery,
    browserStorage: kind => (kind === 'localStorage' ? local : session),
    discoverSignIn: vi.fn(discover || (async () => ({ kind: 'password' })))
  };
  const api = new Function(...Object.keys(deps), source.slice(first, last) + `
    return { email, password, step, discoveredStep, suggestedProvider, passwordFailed, discoverHints, showNotMe,
      showEmailField, showPasswordField, rememberedEmail, handleSubmit, useOtherEmail, forgetEmail,
      usePasswordInstead, applyLoginMode, loginHintForSSO, identifierFirst };`)(...Object.values(deps));
  return { ...api, deps, authStore, local, session };
}

const hintKeys = p => p.discoverHints.value.map(h => h.key);

describe('login page: switch keeps the new form dark', () => {
  it('classic (switch off / older server): the form as before, no discover, no hint to the provider', async () => {
    const p = page({ mode: 'classic' });
    expect(p.step.value).toBe('classic');
    expect(p.showEmailField.value && p.showPasswordField.value).toBe(true);
    p.email.value = 'a@firma.ch';
    p.password.value = 'pw';
    await p.handleSubmit();
    expect(p.deps.discoverSignIn).not.toHaveBeenCalled();
    expect(p.authStore.login).toHaveBeenCalledWith('a@firma.ch', 'pw');
    expect(p.loginHintForSSO()).toBeNull();
    expect(p.local.getItem(discovery.REMEMBERED_EMAIL_KEY)).toBeNull();
  });

  it('test: only with the tester opt-in; the web has no own SSO flow here', () => {
    expect(page({ mode: 'test' }).step.value).toBe('classic');
    expect(page({ mode: 'identifier-first', desktop: false, mobile: false }).step.value).toBe('classic');
    expect(page({ mode: 'identifier-first', desktop: false, mobile: true }).step.value).toBe('email');
  });

  it('a switch change never flips a form the user is working in', async () => {
    const p = page({ mode: 'classic' });
    p.password.value = 'typing';
    await p.applyLoginMode(Promise.resolve({ mode: 'identifier-first', testOptIn: false }));
    expect(p.step.value).toBe('classic');
    expect(p.local.getItem(discovery.LOGIN_MODE_CACHE_KEY)).toBe('identifier-first'); // next time
    const q = page({ mode: 'classic' });
    await q.applyLoginMode(Promise.resolve({ mode: 'test', testOptIn: true }));
    expect(q.step.value).toBe('email');
  });
});

describe('login page: e-mail first', () => {
  it('a missing or invalid address is blocked without a request', async () => {
    const p = page();
    await p.handleSubmit();
    expect(p.deps.tracker.blocked).toHaveBeenCalledWith(['email:missing']);
    p.email.value = 'anna';
    await p.handleSubmit();
    expect(p.deps.tracker.blocked).toHaveBeenLastCalledWith(['email:invalid']);
    expect(p.deps.discoverSignIn).not.toHaveBeenCalled();
  });

  it('password account: the password field, the address stays visible and is remembered', async () => {
    const p = page({ discover: async () => ({ kind: 'password' }) });
    p.email.value = ' Anna@Firma.ch ';
    await p.handleSubmit();
    expect(p.deps.discoverSignIn).toHaveBeenCalledWith('anna@firma.ch');
    expect(p.deps.tracker.sent).toHaveBeenCalledWith('discover');
    expect(p.step.value).toBe('password');
    expect(p.showEmailField.value).toBe(false);
    expect(p.showPasswordField.value).toBe(true);
    expect(p.local.getItem(discovery.REMEMBERED_EMAIL_KEY)).toBe('anna@firma.ch');
    expect(p.deps.startSSOFlow).not.toHaveBeenCalled();
    p.password.value = 'pw';
    await p.handleSubmit();
    expect(p.authStore.login).toHaveBeenCalledWith('anna@firma.ch', 'pw');
    expect(p.deps.router.push).toHaveBeenCalledWith('/record');
  });

  it('Microsoft account: straight to Microsoft with the address as hint, once per attempt', async () => {
    const p = page({ discover: async () => ({ kind: 'sso', provider: 'microsoft' }) });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).toHaveBeenCalledTimes(1);
    expect(p.deps.startSSOFlow).toHaveBeenCalledWith('microsoft');
    expect(p.loginHintForSSO()).toBe('anna@firma.ch');
    expect(p.step.value).toBe('choice');
    expect(p.suggestedProvider.value).toBe('microsoft');
    expect(p.discoverHints.value).toEqual([{ key: 'discoverSsoHint', params: { provider: 'Microsoft' } }]);
    // Back from the browser (cancelled, provider error): the choice, no second redirect.
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).toHaveBeenCalledTimes(1);
  });

  it('«Use another email» starts a new attempt; the remembered address shows «Not me»', async () => {
    const p = page({ discover: async () => ({ kind: 'sso', provider: 'google' }) });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    p.useOtherEmail();
    expect(p.step.value).toBe('email');
    expect(p.showNotMe.value).toBe(true);
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).toHaveBeenCalledTimes(2);
    p.forgetEmail();
    expect(p.email.value).toBe('');
    expect(p.showNotMe.value).toBe(false);
    expect(p.local.getItem(discovery.REMEMBERED_EMAIL_KEY)).toBeNull();
  });

  it('never a request about an address when the page opens; a remembered address is only filled in', () => {
    const local = memoryStorage();
    local.setItem(discovery.REMEMBERED_EMAIL_KEY, 'anna@firma.ch');
    const p = page({ local });
    expect(p.email.value).toBe('anna@firma.ch');
    expect(p.step.value).toBe('email');
    expect(p.deps.discoverSignIn).not.toHaveBeenCalled();
    expect(p.deps.startSSOFlow).not.toHaveBeenCalled();
  });

  it('an SSO account with a password can still use it', async () => {
    const p = page({ discover: async () => ({ kind: 'sso', provider: 'google' }) });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    p.usePasswordInstead();
    expect(p.step.value).toBe('password');
  });

  it('Apple account: password field plus where to sign in (no Apple in this app)', async () => {
    const p = page({ discover: async () => ({ kind: 'apple' }) });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    expect(p.step.value).toBe('password');
    expect(hintKeys(p)).toEqual(['discoverAppleHint']);
    const m = page({ desktop: false, mobile: true, discover: async () => ({ kind: 'apple' }) });
    m.email.value = 'anna@firma.ch';
    await m.handleSubmit();
    expect(hintKeys(m)).toEqual(['discoverAppleHintApp']);
  });

  it('rate limited: the password field (never a dead end); 404/offline: the classic form', async () => {
    const p = page({ discover: async () => ({ kind: 'rate_limited', retryAfter: 30 }) });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    expect(p.step.value).toBe('password');
    const q = page({ discover: async () => ({ kind: 'unavailable' }) });
    q.email.value = 'anna@firma.ch';
    await q.handleSubmit();
    expect(q.step.value).toBe('classic');
    expect(q.showEmailField.value && q.showPasswordField.value).toBe(true);
    expect(q.local.getItem(discovery.REMEMBERED_EMAIL_KEY)).toBeNull();
  });

  it('server says invalid address: the text, no step change', async () => {
    const p = page({ discover: async () => ({ kind: 'invalid_email' }) });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    expect(p.authStore.error).toBe('emailInvalid');
    expect(p.step.value).toBe('email');
  });
});

describe('login page: after the password', () => {
  async function atPassword(login) {
    const p = page({ discover: async () => ({ kind: 'password' }), login });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    p.password.value = 'pw';
    await p.handleSubmit();
    return p;
  }

  it('a wrong password shows every way in: SSO hint, Apple relay hint, «Check email»', async () => {
    const p = await atPassword(async () => ({ success: false, reason: 'invalid_credentials' }));
    expect(p.passwordFailed.value).toBe(true);
    expect(hintKeys(p)).toEqual(['discoverFailedPasswordHint', 'discoverAppleRelayHint']);
    expect(p.deps.startSSOFlow).not.toHaveBeenCalled();
    p.useOtherEmail();
    expect(p.passwordFailed.value).toBe(false);
  });

  it('the existing use_sso answer sends on automatically, at most once per attempt', async () => {
    const p = await atPassword(async () => ({ success: false, reason: 'use_sso', provider: 'google' }));
    expect(p.deps.startSSOFlow).toHaveBeenCalledWith('google');
    expect(p.step.value).toBe('choice');
    expect(p.password.value).toBe('');
    p.usePasswordInstead();
    p.password.value = 'pw';
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).toHaveBeenCalledTimes(1);
  });

  it('use_sso in the classic form changes nothing (switch off)', async () => {
    const p = page({ mode: 'classic', login: async () => ({ success: false, reason: 'use_sso', provider: 'google' }) });
    p.email.value = 'anna@firma.ch';
    p.password.value = 'pw';
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).not.toHaveBeenCalled();
    expect(p.passwordFailed.value).toBe(false);
  });

  it('a 2FA account: the code step takes over as before', async () => {
    const p = await atPassword(async () => ({ success: false, requiresTwoFactor: true, method: 'EMAIL' }));
    expect(p.deps.resetCodeInputs).toHaveBeenCalled();
    expect(p.password.value).toBe('');
    expect(p.deps.startSSOFlow).not.toHaveBeenCalled();
    expect(p.deps.router.push).not.toHaveBeenCalled();
  });
});

describe('login page: review round (races, fallback, shared device)', () => {
  it('a button clicked while discover runs: the answer opens no second browser', async () => {
    let p;
    p = page({ discover: async () => { p.authStore.ssoProvider = 'microsoft'; return { kind: 'sso', provider: 'microsoft' }; } });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).not.toHaveBeenCalled();
    expect(p.step.value).toBe('choice');
  });

  it('the address changed while discover ran: the late answer is dropped', async () => {
    let p;
    p = page({ discover: async () => { p.email.value = 'bruno@firma.ch'; return { kind: 'sso', provider: 'google' }; } });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).not.toHaveBeenCalled();
    expect(p.step.value).toBe('email');
    expect(p.email.value).toBe('bruno@firma.ch');
    expect(p.local.getItem(discovery.REMEMBERED_EMAIL_KEY)).toBeNull();
  });

  it('discover unavailable: the classic form behaves exactly as before (no redirect, no hints, no hint to the provider)', async () => {
    const p = page({
      discover: async () => ({ kind: 'unavailable' }),
      login: async () => ({ success: false, reason: 'use_sso', provider: 'google' })
    });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    expect(p.step.value).toBe('classic');
    p.password.value = 'pw';
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).not.toHaveBeenCalled();
    expect(p.discoverHints.value).toEqual([]);
    expect(p.loginHintForSSO()).toBeNull();
  });

  it('a remembered address is not sent as hint by a direct button click on the e-mail step', () => {
    const local = memoryStorage();
    local.setItem(discovery.REMEMBERED_EMAIL_KEY, 'anna@firma.ch');
    const p = page({ local });
    expect(p.step.value).toBe('email');
    expect(p.loginHintForSSO()).toBeNull();
  });

  it('use_sso while a browser sign-in is already open: no second one', async () => {
    const p = page({ discover: async () => ({ kind: 'password' }), login: async () => ({ success: false, reason: 'use_sso', provider: 'microsoft' }) });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    p.authStore.ssoProvider = 'microsoft';
    p.password.value = 'pw';
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).not.toHaveBeenCalled();
  });
});
