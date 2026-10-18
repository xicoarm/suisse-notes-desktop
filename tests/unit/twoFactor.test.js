import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  normalizeOtp, normalizeBackupCode, isValidOtp, isValidBackupCode, codeFieldProblem, twoFactorChallengeFrom,
  startTwoFactorStep, resendSecondsLeft, twoFactorHintKey, describeTwoFactorFailure, describeResendFailure,
  RESEND_COOLDOWN_MS
} from '../../src/utils/twoFactor';
import { describeLoginFailure } from '../../src/utils/authErrors';
import { buildStepPayload } from '../../src/services/customerTelemetry';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';

const require = createRequire(import.meta.url);
const mainTwoFactor = require('../../src-electron/auth-two-factor.js');

describe('code formats', () => {
  it('six digits; a paste with spaces or a dash is fine', () => {
    expect(normalizeOtp('123456')).toBe('123456');
    expect(normalizeOtp(' 123 456 ')).toBe('123456');
    expect(normalizeOtp('123-456')).toBe('123456');
    for (const bad of ['12345', '1234567', '12a456', '', null, undefined]) expect(normalizeOtp(bad)).toBeNull();
    expect(isValidOtp('123 456')).toBe(true);
  });

  it('backup codes A1B2-C3D4: dash optional, case-insensitive', () => {
    expect(normalizeBackupCode('a1b2-c3d4')).toBe('A1B2-C3D4');
    expect(normalizeBackupCode('A1B2C3D4')).toBe('A1B2C3D4');
    expect(normalizeBackupCode(' a1b2 c3d4 ')).toBe('A1B2C3D4');
    for (const bad of ['A1B2-C3D', 'A1B2--C3D4', 'A1B2_C3D4', '123456', '', null]) expect(normalizeBackupCode(bad)).toBeNull();
    expect(isValidBackupCode('a1b2-c3d4')).toBe(true);
  });

  it('the main process applies exactly the same rules', () => {
    for (const input of ['123456', ' 123 456 ', '123-456', '12345', 'abcdef', '']) {
      expect(mainTwoFactor.normalizeTwoFactorCode(input, false)).toBe(normalizeOtp(input));
    }
    for (const input of ['a1b2-c3d4', 'A1B2C3D4', ' a1b2 c3d4 ', 'A1B2-C3D', '123456']) {
      expect(mainTwoFactor.normalizeTwoFactorCode(input, true)).toBe(normalizeBackupCode(input));
    }
  });

  it('a refused click names the field for telemetry (accepted by the payload builder)', () => {
    expect(codeFieldProblem('12', {})).toBe('code:invalidFormat');
    expect(codeFieldProblem('123456', {})).toBeNull();
    expect(codeFieldProblem('xx', { backup: true })).toBe('backupCode:invalidFormat');
    expect(codeFieldProblem('A1B2-C3D4', { backup: true })).toBeNull();
    const payload = buildStepPayload({ flow: 'login', event: 'blocked', sid: 'abc123def456', fields: ['code:invalidFormat', 'backupCode:invalidFormat'] });
    expect(payload.fields).toEqual(['code:invalidFormat', 'backupCode:invalidFormat']);
  });
});

describe('challenge and code-step state', () => {
  it('reads the challenge of a new backend; nothing from an old backend success', () => {
    expect(twoFactorChallengeFrom({ requiresTwoFactor: true, twoFactorMethod: 'EMAIL', tempToken: 't.k.n' }))
      .toEqual({ requiresTwoFactor: true, twoFactorMethod: 'EMAIL', tempToken: 't.k.n' });
    expect(twoFactorChallengeFrom({ requiresTwoFactor: true, twoFactorMethod: 'SMS', tempToken: 'x' }).twoFactorMethod).toBe('AUTHENTICATOR');
    expect(twoFactorChallengeFrom({ success: true, token: 'jwt', user: {} })).toBeNull();
    expect(twoFactorChallengeFrom({ requiresTwoFactor: true })).toBeNull();
    expect(twoFactorChallengeFrom(null)).toBeNull();
  });

  it('e-mail: "send again" waits 60 s from the first code; authenticator never waits', () => {
    const email = startTwoFactorStep({ twoFactorMethod: 'EMAIL', tempToken: 't' }, 1000);
    expect(email).toEqual({ method: 'EMAIL', tempToken: 't', resendAvailableAt: 1000 + RESEND_COOLDOWN_MS });
    expect(resendSecondsLeft(email, 1000)).toBe(60);
    expect(resendSecondsLeft(email, 1000 + 59001)).toBe(1);
    expect(resendSecondsLeft(email, 1000 + 60000)).toBe(0);
    const app = startTwoFactorStep({ twoFactorMethod: 'AUTHENTICATOR', tempToken: 't' }, 1000);
    expect(resendSecondsLeft(app, 1000)).toBe(0);
    expect(resendSecondsLeft(null, 1000)).toBe(0);
  });

  it('hint per method', () => {
    expect(twoFactorHintKey('AUTHENTICATOR', false)).toBe('twoFactorHintAuthenticator');
    expect(twoFactorHintKey('EMAIL', false)).toBe('twoFactorHintEmail');
    expect(twoFactorHintKey('EMAIL', true)).toBe('twoFactorHintBackup');
  });
});

describe('verify-2fa failures', () => {
  it.each([
    [{ status: 400, code: 'invalid_code' }, 'twoFactorInvalidCode', 'stay', '2fa_invalid_code'],
    [{ status: 400, code: 'invalid_backup_code' }, 'twoFactorInvalidBackupCode', 'stay', '2fa_invalid_backup_code'],
    [{ status: 410, code: 'code_expired' }, 'twoFactorCodeExpired', 'stay', '2fa_code_expired'],
    [{ status: 401, code: 'session_expired' }, 'twoFactorSessionExpired', 'password', '2fa_session_expired'],
    [{ status: 429, code: 'too_many_attempts' }, 'twoFactorTooManyAttempts', 'password', '2fa_too_many_attempts'],
    [{ status: 403, code: 'account_disabled' }, 'accountDisabled', 'password', '2fa_account_disabled'],
    [{ status: 403, code: 'app_update_required' }, 'appUpdateRequired', 'password', '2fa_app_update_required'],
    [{ status: 400, code: 'missing_fields' }, 'twoFactorInvalidCode', 'stay', '2fa_missing_fields'],
    [{ status: 500, code: 'server_error' }, 'authServiceUnavailable', 'stay', '2fa_server_error']
  ])('%j -> %s / %s', (failure, key, next, reason) => {
    expect(describeTwoFactorFailure(failure)).toEqual({ key, next, reason });
  });

  it('a gateway page or network failure is "briefly unavailable", never "wrong code"', () => {
    expect(describeTwoFactorFailure({ status: 502, nonJson: true })).toMatchObject({ key: 'authServiceUnavailable', next: 'stay' });
    expect(describeTwoFactorFailure({ network: 'timeout' })).toMatchObject({ key: 'authConnectionTimedOut', next: 'stay' });
    expect(describeTwoFactorFailure({ networkCode: 'ENOTFOUND' })).toMatchObject({ key: 'networkUnavailable', next: 'stay' });
  });

  it('falls back to the status without a code', () => {
    expect(describeTwoFactorFailure({ status: 400 }, { backup: true }).key).toBe('twoFactorInvalidBackupCode');
    expect(describeTwoFactorFailure({ status: 401 }).next).toBe('password');
    expect(describeTwoFactorFailure({ status: 410 }).key).toBe('twoFactorCodeExpired');
    expect(describeTwoFactorFailure({ status: 429 }).next).toBe('password');
    expect(describeTwoFactorFailure({ status: 418 })).toEqual({ key: 'twoFactorFailedGeneric', reason: '2fa_status_418', next: 'stay' });
  });

  it('resend failures', () => {
    expect(describeResendFailure({ status: 401 })).toMatchObject({ key: 'twoFactorSessionExpired', next: 'password' });
    expect(describeResendFailure({ status: 429 })).toMatchObject({ key: 'twoFactorResendTooSoon', next: 'stay' });
    expect(describeResendFailure({ status: 500 })).toMatchObject({ key: 'twoFactorResendFailed', next: 'stay' });
    expect(describeResendFailure({ network: 'offline' })).toMatchObject({ key: 'networkUnavailable', next: 'stay' });
  });

  it('reasons are telemetry-safe', () => {
    for (const f of [{ code: 'invalid_code' }, { status: 502, nonJson: true }, { networkCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, {}]) {
      expect(describeTwoFactorFailure(f).reason).toMatch(/^[A-Za-z0-9_]{1,40}$/);
    }
  });
});

describe('password sign-in: app update required', () => {
  it('maps the future 403 app_update_required', () => {
    expect(describeLoginFailure({ status: 403, code: 'app_update_required' })).toEqual({ key: 'appUpdateRequired', reason: 'app_update_required' });
  });
});

describe('texts', () => {
  const keys = ['twoFactorHintAuthenticator', 'twoFactorHintEmail', 'twoFactorHintBackup', 'twoFactorCodeLabel',
    'twoFactorBackupCodeLabel', 'twoFactorCodeFormat', 'twoFactorBackupCodeFormat', 'twoFactorVerify', 'twoFactorUseBackupCode',
    'twoFactorUseCode', 'twoFactorResend', 'twoFactorResendIn', 'twoFactorResent', 'twoFactorBackToLogin', 'twoFactorInvalidCode',
    'twoFactorInvalidBackupCode', 'twoFactorCodeExpired', 'twoFactorSessionExpired', 'twoFactorTooManyAttempts',
    'twoFactorResendTooSoon', 'twoFactorResendFailed', 'twoFactorFailedGeneric', 'appUpdateRequired'];

  it.each(SUPPORTED_LOCALES)('every second-factor text exists in %s (German without sharp s)', (locale) => {
    const messages = i18n.global.getLocaleMessage(locale);
    for (const key of keys) {
      expect(typeof messages[key], `${locale}.${key}`).toBe('string');
      if (locale === 'de') expect(messages[key]).not.toMatch(/ß/);
    }
    expect(messages.twoFactorResendIn).toContain('{seconds}');
  });

  it('German wording of the brief', () => {
    const de = i18n.global.getLocaleMessage('de');
    expect(de.twoFactorUseBackupCode).toBe('Backup-Code verwenden');
    expect(de.twoFactorResend).toBe('Code erneut senden');
    expect(de.twoFactorBackToLogin).toBe('Zurück zur Anmeldung');
    expect(de.twoFactorHintAuthenticator).toMatch(/Code aus Ihrer Authenticator-App/);
    expect(de.twoFactorHintEmail).toMatch(/Wir haben Ihnen einen Code per E-Mail gesendet/);
    expect(de.appUpdateRequired).toMatch(/Bitte aktualisieren Sie die App/);
  });
});
