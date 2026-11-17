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
    // Login mode apple flag (store default false = older server / apple:false).
    appleSignIn: false,
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
      usePasswordInstead, applyLoginMode, loginHintForSSO, identifierFirst, showAppleButton };`)(...Object.values(deps));
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

  it('Apple account: password field plus where to sign in (no Apple in this app: login mode apple:false)', async () => {
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

  it('a wrong password shows every way in: SSO hint, Apple relay hint, «Check email» (login mode apple:false)', async () => {
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

describe('login page: Sign in with Apple', () => {
  it('the button follows the server flag (login mode apple:true); older servers: no button', async () => {
    const p = page({ mode: 'classic' });
    expect(p.showAppleButton.value).toBe(false);
    await p.applyLoginMode(Promise.resolve({ mode: 'classic', testOptIn: false, apple: true }));
    expect(p.showAppleButton.value).toBe(true);
    expect(p.authStore.appleSignIn).toBe(true);
    // A separate flag: never mixed into the mode, never stored on the device.
    expect(p.step.value).toBe('classic');
    expect(p.identifierFirst.value).toBe(false);
    expect([...p.local.map.keys(), ...p.local.map.values()].join(' ')).not.toMatch(/apple/i);
    // Also in the classic form, and while the user is typing (no form flips).
    p.password.value = 'typing';
    await p.applyLoginMode(Promise.resolve({ mode: 'identifier-first', testOptIn: false }));
    expect(p.showAppleButton.value).toBe(false);
    expect(p.step.value).toBe('classic');
    await p.applyLoginMode(Promise.resolve({ mode: 'classic', testOptIn: false, apple: 'true' }));
    expect(p.showAppleButton.value).toBe(false);
  });

  it('an Apple sign-in in flight keeps its button', () => {
    const p = page();
    p.authStore.ssoProvider = 'apple';
    expect(p.showAppleButton.value).toBe(true);
  });

  it('discover with the Apple start route: straight to Apple, once per attempt, the Apple button emphasised', async () => {
    const p = page({ discover: async () => ({ kind: 'sso', provider: 'apple' }) });
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).toHaveBeenCalledTimes(1);
    expect(p.deps.startSSOFlow).toHaveBeenCalledWith('apple');
    expect(p.step.value).toBe('choice');
    expect(p.suggestedProvider.value).toBe('apple');
    expect(p.showAppleButton.value).toBe(true);
    expect(p.discoverHints.value).toEqual([{ key: 'discoverSsoHint', params: { provider: 'Apple' } }]);
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).toHaveBeenCalledTimes(1);
    p.usePasswordInstead();
    expect(p.step.value).toBe('password');
  });

  it('Apple account without the start route: the hint says «below» only when the button is there', async () => {
    const p = page({ discover: async () => ({ kind: 'apple' }) });
    await p.applyLoginMode(Promise.resolve({ mode: 'identifier-first', testOptIn: false, apple: true }));
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    expect(p.step.value).toBe('password');
    expect(p.deps.startSSOFlow).not.toHaveBeenCalled();
    expect(hintKeys(p)).toEqual(['discoverAppleHintBelow']);
    const m = page({ desktop: false, mobile: true, discover: async () => ({ kind: 'apple' }) });
    await m.applyLoginMode(Promise.resolve({ mode: 'identifier-first', testOptIn: false, apple: true }));
    m.email.value = 'anna@firma.ch';
    await m.handleSubmit();
    expect(hintKeys(m)).toEqual(['discoverAppleHintBelow']);
    // Without the button: today's texts.
    const q = page({ discover: async () => ({ kind: 'apple' }) });
    q.email.value = 'anna@firma.ch';
    await q.handleSubmit();
    expect(hintKeys(q)).toEqual(['discoverAppleHint']);
  });

  it('a wrong password: the Apple relay hint points to the button when it is there', async () => {
    const p = page({ discover: async () => ({ kind: 'password' }), login: async () => ({ success: false, reason: 'invalid_credentials' }) });
    await p.applyLoginMode(Promise.resolve({ mode: 'identifier-first', testOptIn: false, apple: true }));
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    p.password.value = 'pw';
    await p.handleSubmit();
    expect(hintKeys(p)).toEqual(['discoverFailedPasswordHint', 'discoverAppleRelayHintBelow']);
    const m = page({ desktop: false, mobile: true, discover: async () => ({ kind: 'password' }), login: async () => ({ success: false, reason: 'invalid_credentials' }) });
    m.email.value = 'anna@firma.ch';
    await m.handleSubmit();
    m.password.value = 'pw';
    await m.handleSubmit();
    expect(hintKeys(m)).toEqual(['discoverFailedPasswordHint', 'discoverAppleRelayHintApp']);
  });

  it('use_sso naming Apple: to Apple once per attempt when Apple works here; otherwise as before', async () => {
    const login = async () => ({ success: false, reason: 'use_sso', provider: 'apple' });
    const p = page({ discover: async () => ({ kind: 'password' }), login });
    await p.applyLoginMode(Promise.resolve({ mode: 'identifier-first', testOptIn: false, apple: true }));
    p.email.value = 'anna@firma.ch';
    await p.handleSubmit();
    p.password.value = 'pw';
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).toHaveBeenCalledTimes(1);
    expect(p.deps.startSSOFlow).toHaveBeenCalledWith('apple');
    expect(p.step.value).toBe('choice');
    expect(p.suggestedProvider.value).toBe('apple');
    expect(p.password.value).toBe('');
    expect(p.showAppleButton.value).toBe(true);
    p.usePasswordInstead();
    p.password.value = 'pw';
    await p.handleSubmit();
    expect(p.deps.startSSOFlow).toHaveBeenCalledTimes(1);

    // Login mode apple:false (or an older server): today's behaviour.
    const q = page({ discover: async () => ({ kind: 'password' }), login });
    q.email.value = 'anna@firma.ch';
    await q.handleSubmit();
    q.password.value = 'pw';
    await q.handleSubmit();
    expect(q.deps.startSSOFlow).not.toHaveBeenCalled();
    expect(q.step.value).toBe('password');
    expect(q.suggestedProvider.value).toBeNull();
    expect(q.showAppleButton.value).toBe(false);
  });

  it('the template: Apple after Google, only with showAppleButton, Simple Icons logo in currentColor', () => {
    const source = fs.readFileSync('src/pages/LoginPage.vue', 'utf8').replace(/\r\n/g, '\n');
    const google = source.indexOf('@click="handleGoogleLogin"');
    const apple = source.indexOf('@click="handleAppleLogin"');
    expect(google).toBeGreaterThan(0);
    expect(apple).toBeGreaterThan(google);
    const appleButton = source.slice(source.lastIndexOf('<q-btn', apple), source.indexOf('</q-btn>', apple));
    expect(appleButton).toMatch(/v-if="showAppleButton"/);
    expect(appleButton).toMatch(/'sso-btn--suggested': suggestedProvider === 'apple'/);
    expect(appleButton).toMatch(/v-if="ssoLoading === 'apple'"/);
    expect(appleButton).toMatch(/v-html="appleLogoSvg"/);
    expect(appleButton).toMatch(/\$t\('signInWithApple'\)/);
    expect(source).toMatch(/const appleLogoSvg = '<svg viewBox="0 0 24 24" xmlns="http:\/\/www\.w3\.org\/2000\/svg" fill="currentColor"><path d="M12\.152 6\.896c/);
    expect(source).toMatch(/const handleAppleLogin = \(\) => startSSOFlow\('apple'\);/);
  });

});

// The real start of a browser sign-in (desktop), compiled with narrow dependencies.
function ssoStart({ hint = 'anna@firma.ch', auth } = {}) {
  const source = fs.readFileSync('src/pages/LoginPage.vue', 'utf8').replace(/\r\n/g, '\n');
  const first = source.indexOf('/**\n * Open the IdP login URL');
  const last = source.indexOf('const openForgotPassword', first);
  if (first < 0 || last < first) throw new Error('Missing SSO start block');
  const authStore = { error: null, beginSSO: vi.fn(), abandonSSO: vi.fn() };
  const electronAuth = auth || {
    loginWithMicrosoft: vi.fn(async () => ({ success: true })),
    loginWithGoogle: vi.fn(async () => ({ success: true })),
    loginWithApple: vi.fn(async () => ({ success: true }))
  };
  const deps = {
    authStore,
    tracker: { sent: vi.fn(), rejected: vi.fn() },
    startSSOTimeout: vi.fn(),
    clearSSOTimeoutHandle: vi.fn(),
    loginHintForSSO: vi.fn(() => hint),
    isDesktopApp: true,
    isMobileApp: false,
    window: { electronAPI: { auth: electronAuth } },
    getPlatform: () => 'electron',
    mobileSsoUrl: discovery.mobileSsoUrl,
    t: key => key,
    captureMessage: vi.fn()
  };
  const api = new Function(...Object.keys(deps), source.slice(first, last) + `
    return { startSSOFlow, handleMicrosoftLogin, handleGoogleLogin, handleAppleLogin };`)(...Object.values(deps));
  return { ...api, deps, authStore, electronAuth };
}

describe('login page: starting Sign in with Apple on the desktop', () => {
  it('Apple opens through main without any login hint; Microsoft and Google keep theirs', async () => {
    const s = ssoStart();
    await s.handleAppleLogin();
    expect(s.authStore.beginSSO).toHaveBeenCalledWith('apple');
    expect(s.deps.tracker.sent).toHaveBeenCalledWith('sso_apple');
    expect(s.electronAuth.loginWithApple).toHaveBeenCalledTimes(1);
    expect(s.electronAuth.loginWithApple).toHaveBeenCalledWith();
    expect(s.deps.loginHintForSSO).not.toHaveBeenCalled();
    expect(s.electronAuth.loginWithGoogle).not.toHaveBeenCalled();
    expect(s.electronAuth.loginWithMicrosoft).not.toHaveBeenCalled();
    await s.handleMicrosoftLogin();
    expect(s.electronAuth.loginWithMicrosoft).toHaveBeenCalledWith('anna@firma.ch');
    await s.handleGoogleLogin();
    expect(s.electronAuth.loginWithGoogle).toHaveBeenCalledWith('anna@firma.ch');
    expect(s.authStore.error).toBeNull();
  });

  it('a browser that does not open ends the wait with the text', async () => {
    const s = ssoStart({ auth: { loginWithApple: vi.fn(async () => ({ success: false })) } });
    await s.handleAppleLogin();
    expect(s.authStore.abandonSSO).toHaveBeenCalled();
    expect(s.authStore.error).toBe('ssoOpenFailed');
    expect(s.deps.tracker.rejected).toHaveBeenCalledWith('sso_open_failed');
    expect(s.deps.captureMessage).toHaveBeenCalledWith('auth: SSO sign-in could not be started', 'warning',
      expect.objectContaining({ tags: { sso_provider: 'apple' } }));
  });
});
