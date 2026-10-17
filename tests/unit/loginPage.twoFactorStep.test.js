// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { codeFieldProblem, resendSecondsLeft } from '../../src/utils/twoFactor';

// The real code-step handlers of the login page, compiled with narrow
// dependencies (the approach of recordPage.startGate.test.js).
function codeStep({ verify, resend, step = { method: 'AUTHENTICATOR', tempToken: 't', resendAvailableAt: 0 } } = {}) {
  const source = fs.readFileSync('src/pages/LoginPage.vue', 'utf8').replace(/\r\n/g, '\n');
  const first = source.indexOf('// --- Second factor (2FA accounts');
  const last = source.indexOf('/**\n * Open the IdP login URL', first);
  if (first < 0 || last < first) throw new Error('Missing code-step block');
  const authStore = {
    twoFactor: step,
    twoFactorResending: false,
    verifyTwoFactor: vi.fn(verify || (async () => ({ success: true }))),
    resendTwoFactorEmail: vi.fn(resend || (async () => ({ success: true }))),
    cancelTwoFactor: vi.fn(() => { authStore.twoFactor = null; }),
    clearError: vi.fn()
  };
  const deps = {
    ref: value => ({ value }),
    computed: read => ({ get value() { return read(); } }),
    watch: vi.fn(),
    authStore,
    resendSecondsLeft,
    codeFieldProblem,
    tracker: { blocked: vi.fn(), sent: vi.fn(), rejected: vi.fn(), done: vi.fn() },
    router: { push: vi.fn() },
    $q: { notify: vi.fn() },
    t: key => key
  };
  const api = new Function(...Object.keys(deps), source.slice(first, last) + `
    return { otpCode, backupCode, useBackupCode, handleVerifyCode, onCodeBlocked, toggleBackupCode, handleResendCode, backToPassword, resendWait };`)(
    ...Object.values(deps));
  return { ...api, deps, authStore };
}

describe('login page: second-factor step', () => {
  it('a wrong format is refused with the field named (telemetry), nothing sent', async () => {
    const s = codeStep();
    s.otpCode.value = '12';
    await s.handleVerifyCode();
    expect(s.deps.tracker.blocked).toHaveBeenCalledWith(['code:invalidFormat']);
    expect(s.authStore.verifyTwoFactor).not.toHaveBeenCalled();

    s.toggleBackupCode();
    s.backupCode.value = 'nope';
    await s.handleVerifyCode();
    expect(s.deps.tracker.blocked).toHaveBeenLastCalledWith(['backupCode:invalidFormat']);
  });

  it('a correct code: sent, done, then the Record page', async () => {
    const s = codeStep();
    s.otpCode.value = '123 456';
    await s.handleVerifyCode();
    expect(s.deps.tracker.sent).toHaveBeenCalledWith('2fa_code');
    expect(s.authStore.verifyTwoFactor).toHaveBeenCalledWith('123 456', { backup: false });
    expect(s.deps.tracker.done).toHaveBeenCalled();
    expect(s.deps.router.push).toHaveBeenCalledWith('/record');
  });

  it('a refused code: rejected with 2fa_<code>; the field is cleared for the next try', async () => {
    const s = codeStep({ verify: async () => ({ success: false, reason: '2fa_invalid_code', next: 'stay' }) });
    s.otpCode.value = '111111';
    await s.handleVerifyCode();
    expect(s.deps.tracker.rejected).toHaveBeenCalledWith('2fa_invalid_code');
    expect(s.otpCode.value).toBe('');
    expect(s.deps.router.push).not.toHaveBeenCalled();
  });

  it('a backup code is verified as a backup code', async () => {
    const s = codeStep();
    s.toggleBackupCode();
    s.backupCode.value = 'a1b2-c3d4';
    await s.handleVerifyCode();
    expect(s.deps.tracker.sent).toHaveBeenCalledWith('2fa_backup_code');
    expect(s.authStore.verifyTwoFactor).toHaveBeenCalledWith('a1b2-c3d4', { backup: true });
  });

  it('"send again" waits for the cooldown (the link shows the seconds), then sends', async () => {
    const waiting = codeStep({ step: { method: 'EMAIL', tempToken: 't', resendAvailableAt: Date.now() + 30000 } });
    expect(waiting.resendWait.value).toBeGreaterThan(0);
    await waiting.handleResendCode();
    expect(waiting.authStore.resendTwoFactorEmail).not.toHaveBeenCalled();

    const ready = codeStep({ step: { method: 'EMAIL', tempToken: 't', resendAvailableAt: 0 } });
    await ready.handleResendCode();
    expect(ready.authStore.resendTwoFactorEmail).toHaveBeenCalledTimes(1);
    expect(ready.deps.$q.notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'twoFactorResent' }));
  });

  it('"back to sign-in" drops the step', () => {
    const s = codeStep();
    s.otpCode.value = '123';
    s.backToPassword();
    expect(s.authStore.cancelTwoFactor).toHaveBeenCalled();
    expect(s.otpCode.value).toBe('');
  });

  it('the template has a numeric one-time-code field and no disabled submit', () => {
    const template = fs.readFileSync('src/pages/LoginPage.vue', 'utf8').split('<script')[0];
    expect(template).toMatch(/inputmode="numeric"/);
    expect(template).toMatch(/autocomplete="one-time-code"/);
    expect(template).not.toMatch(/:disable="!/);
  });
});
