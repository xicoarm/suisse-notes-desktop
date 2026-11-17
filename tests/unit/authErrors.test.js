import { describe, it, expect } from 'vitest';
import { describeLoginFailure, describeRegisterFailure, classifySsoError } from '../../src/utils/authErrors';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';

const REASON_RE = /^[A-Za-z0-9_]{1,40}$/;

describe('describeLoginFailure (POST /api/auth/desktop)', () => {
  it.each([
    [{ status: 401, code: 'invalid_credentials' }, 'loginInvalidCredentials', 'invalid_credentials'],
    [{ status: 400, code: 'use_sso', provider: 'google' }, 'loginUseSsoGoogle', 'use_sso'],
    [{ status: 400, code: 'use_sso', provider: 'microsoft' }, 'loginUseSsoMicrosoft', 'use_sso'],
    [{ status: 400, code: 'use_sso' }, 'loginUseSso', 'use_sso'],
    [{ status: 400, code: 'no_password' }, 'loginNoPassword', 'no_password'],
    [{ status: 403, code: 'account_disabled' }, 'accountDisabled', 'account_disabled'],
    [{ status: 429, code: 'too_many_attempts' }, 'authTooManyAttempts', 'too_many_attempts'],
    [{ status: 400, code: 'missing_fields' }, 'loginMissingFields', 'missing_fields'],
    [{ status: 500, code: 'server_error' }, 'authServiceUnavailable', 'server_error']
  ])('maps the contract code %j', (failure, key, reason) => {
    expect(describeLoginFailure(failure)).toEqual({ key, reason });
  });

  it('falls back to the status when an older backend sends no code', () => {
    expect(describeLoginFailure({ status: 401, serverError: 'Invalid credentials' })).toEqual({ key: 'loginInvalidCredentials', reason: 'status_401' });
    expect(describeLoginFailure({ status: 403 }).key).toBe('accountDisabled');
    expect(describeLoginFailure({ status: 429 }).key).toBe('authTooManyAttempts');
    expect(describeLoginFailure({ status: 400 }).key).toBe('loginMissingFields');
    expect(describeLoginFailure({ status: 418 })).toEqual({ key: 'loginFailedGeneric', reason: 'status_418' });
  });

  it('never calls a restart page or 5xx "invalid credentials"', () => {
    expect(describeLoginFailure({ status: 502, nonJson: true })).toEqual({ key: 'authServiceUnavailable', reason: 'status_502' });
    expect(describeLoginFailure({ status: 503 }).key).toBe('authServiceUnavailable');
    // An HTML body even with a 401 status (proxy page) is not a password problem.
    expect(describeLoginFailure({ status: 401, nonJson: true }).key).not.toBe('loginInvalidCredentials');
    expect(describeLoginFailure({ status: 200, nonJson: true })).toEqual({ key: 'authServiceUnavailable', reason: 'non_json_200' });
  });

  it('names network problems without a server answer', () => {
    expect(describeLoginFailure({ networkCode: 'ENOTFOUND' }).key).toBe('networkUnavailable');
    expect(describeLoginFailure({ network: 'offline' }).key).toBe('networkUnavailable');
    expect(describeLoginFailure({ network: 'timeout' }).key).toBe('authConnectionTimedOut');
    expect(describeLoginFailure({ networkCode: 'ECONNABORTED' }).key).toBe('authConnectionTimedOut');
    expect(describeLoginFailure({ networkCode: 'ECONNREFUSED' }).key).toBe('authServiceUnavailable');
    const tls = describeLoginFailure({ networkCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    expect(tls.key).toBe('authConnectionFailed');
    expect(tls.reason).toMatch(REASON_RE);
  });
});

describe('describeRegisterFailure (POST /api/auth/register)', () => {
  it('409 -> account exists (sign in or reset password)', () => {
    expect(describeRegisterFailure({ status: 409, serverError: 'User with this email already exists.' }))
      .toEqual({ key: 'registerAccountExists', reason: 'status_409' });
  });

  it('maps the legacy 400 sentences and never shows them', () => {
    expect(describeRegisterFailure({ status: 400, serverError: 'Invalid email format' }).key).toBe('registerEmailInvalid');
    expect(describeRegisterFailure({ status: 400, serverError: 'Password must be at least 8 characters' }).key).toBe('registerPasswordTooShort');
    expect(describeRegisterFailure({ status: 400, serverError: 'Email, password, and name are required' }).key).toBe('registerMissingFields');
    expect(describeRegisterFailure({ status: 400, serverError: 'Something else' }).key).toBe('registerFailedGeneric');
  });

  it('server and network problems', () => {
    expect(describeRegisterFailure({ status: 500 }).key).toBe('authServiceUnavailable');
    expect(describeRegisterFailure({ status: 502, nonJson: true }).key).toBe('authServiceUnavailable');
    expect(describeRegisterFailure({ networkCode: 'ETIMEDOUT' }).key).toBe('authConnectionTimedOut');
    expect(describeRegisterFailure({ status: 429 }).key).toBe('authTooManyAttempts');
  });
});

describe('classifySsoError (SSO callback ?error=&code=)', () => {
  it('prefers the contract code over the English sentence', () => {
    expect(classifySsoError({ error: 'Login failed. Please try again.', code: 'sso_admin_consent' }))
      .toEqual({ cancelled: false, key: 'ssoAdminConsent', reason: 'sso_admin_consent' });
    expect(classifySsoError({ error: 'x', code: 'sso_email_unverified' }).key).toBe('ssoEmailUnverified');
    expect(classifySsoError({ error: 'x', code: 'sso_account_exists' }).key).toBe('ssoAccountExists');
    expect(classifySsoError({ error: 'x', code: 'account_disabled' }).key).toBe('accountDisabled');
    expect(classifySsoError({ error: 'x', code: 'sso_failed' }).key).toBe('ssoFailed');
    expect(classifySsoError({ error: 'x', code: 'sso_cancelled' })).toEqual({ cancelled: true, key: null, reason: 'sso_cancelled' });
    expect(classifySsoError({ error: 'x', code: 'brand_new_code' })).toEqual({ cancelled: false, key: 'ssoFailed', reason: 'brand_new_code' });
  });

  it('Sign in with Apple: apple_link_required has its own text in all four languages', () => {
    expect(classifySsoError({
      error: 'An account with this e-mail address already exists. Please sign in the way you usually do (password, Google or Microsoft).',
      code: 'apple_link_required'
    })).toEqual({ cancelled: false, key: 'appleLinkRequired', reason: 'apple_link_required' });
    const text = locale => i18n.global.getLocaleMessage(locale).appleLinkRequired;
    expect(text('en')).toBe('An account with this e-mail address already exists. Please sign in the way you usually do (password, Google or Microsoft).');
    expect(text('de')).toBe('Für diese E-Mail-Adresse gibt es bereits ein Konto. Bitte melden Sie sich wie gewohnt an (Passwort, Google oder Microsoft).');
    expect(text('fr')).toBe('Un compte existe déjà avec cette adresse e-mail. Veuillez vous connecter comme d’habitude (mot de passe, Google ou Microsoft).');
    expect(text('it')).toBe('Esiste già un account con questo indirizzo e-mail. Accedi come di consueto (password, Google o Microsoft).');
  });

  it.each(['sso_cancelled', 'canceled', 'cancelled', 'access_denied',
    'AADSTS65004: User declined to consent to access the app.', 'The user cancelled the sign-in'])(
    'treats %j as a silent cancel', (error) => {
      expect(classifySsoError({ error }).cancelled).toBe(true);
    });

  it('never passes raw AADSTS text through; consent problems get their own text', () => {
    const consent = classifySsoError({ error: 'AADSTS65001: The user or administrator has not consented to use the application with ID 123.' });
    expect(consent).toEqual({ cancelled: false, key: 'ssoAdminConsent', reason: 'AADSTS65001' });
    const other = classifySsoError({ error: "AADSTS700016: Application with identifier 'x' was not found in the directory 'contoso'." });
    expect(other).toEqual({ cancelled: false, key: 'ssoFailed', reason: 'AADSTS700016' });
  });

  it('recognises the English sentences older backends sent to the apps', () => {
    expect(classifySsoError({ error: 'An account with this e-mail address already exists. Please sign in with your password or use "Forgot password?".' }).key).toBe('ssoAccountExists');
    expect(classifySsoError({ error: 'Account is disabled. Please contact your administrator.' }).key).toBe('accountDisabled');
    expect(classifySsoError({ error: 'Google login failed. Please try again.' })).toEqual({ cancelled: false, key: 'ssoFailed', reason: 'legacy_text' });
    expect(classifySsoError({ error: 'invalid_callback' }).reason).toBe('invalid_callback');
    expect(classifySsoError(null).key).toBe('ssoFailed');
  });

  it('reasons are always telemetry/Sentry-safe words', () => {
    for (const input of [{ error: 'jane.doe@example.com could not sign in' }, { error: 'AADSTS50105: user' }, { code: 'x y z' }]) {
      expect(classifySsoError(input).reason).toMatch(REASON_RE);
    }
  });
});

describe('every mapped text exists in all four languages', () => {
  const keys = new Set();
  const failures = [
    ...['invalid_credentials', 'use_sso', 'no_password', 'account_disabled', 'too_many_attempts', 'missing_fields', 'server_error']
      .map(code => describeLoginFailure({ status: 400, code, provider: 'google' })),
    describeLoginFailure({ status: 418 }), describeLoginFailure({ network: 'timeout' }), describeLoginFailure({ networkCode: 'EPROTO' }),
    describeLoginFailure({ status: 400, code: 'use_sso', provider: 'microsoft' }), describeLoginFailure({ status: 400, code: 'use_sso' }),
    describeRegisterFailure({ status: 409 }), describeRegisterFailure({ status: 400, serverError: 'Invalid email format' }),
    describeRegisterFailure({ status: 400, serverError: 'at least 8' }), describeRegisterFailure({ status: 400, serverError: 'required' }),
    describeRegisterFailure({ status: 400 }),
    ...['sso_failed', 'sso_account_exists', 'sso_email_unverified', 'sso_admin_consent', 'account_disabled', 'apple_link_required'].map(code => classifySsoError({ code }))
  ];
  for (const f of failures) if (f.key) keys.add(f.key);

  it.each(SUPPORTED_LOCALES)('%s', (locale) => {
    const messages = i18n.global.getLocaleMessage(locale);
    for (const key of keys) {
      expect(typeof messages[key], `${locale}.${key}`).toBe('string');
      if (locale === 'de') expect(messages[key]).not.toMatch(/ß/);
    }
  });
});

describe('Sign in with Apple: login page texts in all four languages', () => {
  const button = { en: 'Sign in with Apple', de: 'Mit Apple anmelden', fr: 'Se connecter avec Apple', it: 'Accedi con Apple' };

  it('covers exactly the four app languages', () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual(Object.keys(button).sort());
  });

  it.each(SUPPORTED_LOCALES)('%s', (locale) => {
    const messages = i18n.global.getLocaleMessage(locale);
    expect(messages.signInWithApple).toBe(button[locale]);
    // The «below» variants name the button as it reads.
    expect(messages.discoverAppleHintBelow).toContain(button[locale]);
    expect(messages.discoverAppleRelayHintBelow).toContain(button[locale]);
    expect(messages.loginUseSsoApple).toContain(button[locale]);
    // Today's texts stay for an app without the button.
    for (const key of ['discoverAppleHint', 'discoverAppleHintApp', 'discoverAppleRelayHint', 'discoverAppleRelayHintApp']) {
      expect(typeof messages[key], `${locale}.${key}`).toBe('string');
    }
    if (locale === 'de') {
      for (const key of ['signInWithApple', 'discoverAppleHintBelow', 'discoverAppleRelayHintBelow', 'appleLinkRequired', 'loginUseSsoApple']) {
        expect(messages[key]).not.toMatch(/ß/);
      }
    }
  });
});
