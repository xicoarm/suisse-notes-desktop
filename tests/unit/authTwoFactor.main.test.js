// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const tf = require('../../src-electron/auth-two-factor.js');

const BASE = 'https://app.suisse-meets.ch';
const TEMP = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MSIsImlzMkZhVGVtcCI6dHJ1ZX0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';

describe('main process: second factor requests', () => {
  it('the password sign-in announces 2FA support, everything else unchanged', () => {
    expect(tf.buildLoginBody({ email: 'a@b.ch', password: 'pw', deviceId: 'd', platform: 'win32', appVersion: '4.7.17' }))
      .toEqual({ email: 'a@b.ch', password: 'pw', deviceId: 'd', platform: 'win32', appVersion: '4.7.17', twoFactor: 'supported' });
  });

  it('builds the verify request from the configured base only, with the normalised code', () => {
    expect(tf.buildVerifyRequest(BASE, TEMP, ' 123 456 ', false)).toEqual({
      ok: true, url: `${BASE}/api/auth/desktop/verify-2fa`, body: { tempToken: TEMP, code: '123456', isBackupCode: false }
    });
    expect(tf.buildVerifyRequest(BASE, TEMP, 'a1b2-c3d4', true).body).toEqual({ tempToken: TEMP, code: 'A1B2-C3D4', isBackupCode: true });
    // isBackupCode must be exactly true.
    expect(tf.buildVerifyRequest(BASE, TEMP, '123456', 'yes').body.isBackupCode).toBe(false);
  });

  it('refuses malformed input without a request', () => {
    expect(tf.buildVerifyRequest(BASE, TEMP, '12', false)).toEqual({ ok: false, failure: { success: false, code: 'invalid_format' } });
    expect(tf.buildVerifyRequest(BASE, TEMP, 'nope', true)).toEqual({ ok: false, failure: { success: false, code: 'invalid_backup_code' } });
    expect(tf.buildVerifyRequest(BASE, TEMP, { toString: () => '123456' }, false).ok).toBe(false);
    expect(tf.buildVerifyRequest(BASE, TEMP, '1'.repeat(65), false).ok).toBe(false);
    for (const token of ['', 'short', 'has space.in.it.xxxxxxxxxx', 'a'.repeat(5000), 'abc/def../../evil', null, 42]) {
      expect(tf.buildVerifyRequest(BASE, token, '123456', false)).toEqual({ ok: false, failure: { success: false, code: 'session_expired' } });
      expect(tf.buildResendRequest(BASE, token)).toEqual({ ok: false, failure: { success: false, code: 'session_expired' } });
    }
    expect(tf.buildResendRequest(BASE, TEMP)).toEqual({ ok: true, url: `${BASE}/api/auth/resend-2fa-email`, body: { tempToken: TEMP } });
  });

  it('reads a challenge; an old-backend success is unchanged', () => {
    expect(tf.twoFactorChallengeFrom({ requiresTwoFactor: true, twoFactorMethod: 'EMAIL', tempToken: TEMP }))
      .toEqual({ success: false, requiresTwoFactor: true, twoFactorMethod: 'EMAIL', tempToken: TEMP });
    expect(tf.twoFactorChallengeFrom({ requiresTwoFactor: true, tempToken: 'bad token' })).toBeNull();
    expect(tf.twoFactorChallengeFrom({ success: true, token: 'jwt', user: { id: 1 } })).toBeNull();
    expect(tf.loginSuccessFrom({ success: true, token: 'jwt', user: { id: 1 }, minutes: { remaining: 5 } }))
      .toEqual({ success: true, token: 'jwt', user: { id: 1 }, minutes: { remaining: 5 } });
    expect(tf.loginSuccessFrom({ success: true, token: 'jwt', user: { id: 1 } }).minutes).toBeNull();
    expect(tf.loginSuccessFrom({ requiresTwoFactor: true, tempToken: TEMP })).toBeNull();
    expect(tf.loginSuccessFrom('<html>')).toBeNull();
  });

  it('electron-main wires the handlers and the preload exposes only verify and resend', () => {
    const main = fs.readFileSync('src-electron/electron-main.js', 'utf8');
    expect(main).toMatch(/axios\.post\(`\$\{API_BASE_URL\}\/api\/auth\/desktop`, twoFactorAuth\.buildLoginBody\(/);
    expect(main).toMatch(/ipcMain\.handle\('auth:verifyTwoFactor'[\s\S]*?buildVerifyRequest\(API_BASE_URL,/);
    expect(main).toMatch(/ipcMain\.handle\('auth:resendTwoFactorEmail'[\s\S]*?buildResendRequest\(API_BASE_URL,/);
    const preload = fs.readFileSync('src-electron/electron-preload.js', 'utf8');
    expect(preload).toMatch(/verifyTwoFactor: \(tempToken, code, isBackupCode\) =>\s*ipcRenderer\.invoke\('auth:verifyTwoFactor', String\(tempToken \?\? ''\), String\(code \?\? ''\), isBackupCode === true\)/);
    expect(preload).toMatch(/resendTwoFactorEmail: \(tempToken\) =>\s*ipcRenderer\.invoke\('auth:resendTwoFactorEmail', String\(tempToken \?\? ''\)\)/);
  });
});
