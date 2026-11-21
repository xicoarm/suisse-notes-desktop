// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { canUploadForUser, verifiedUploadResult, tokenUserId } = require('../../src-electron/upload-safety');

describe('upload ownership and evidence', () => {
  it('rejects a background upload for another account or an unknown owner', () => {
    expect(canUploadForUser('alice', 'bob')).toBe(false);
    expect(canUploadForUser(null, 'alice')).toBe(false);
    expect(canUploadForUser('unknown', 'unknown')).toBe(false);
    expect(canUploadForUser('alice', 'alice')).toBe(true);
  });
  it('reads the account from the actual token rather than stale cached user info', () => {
    const token = 'header.' + Buffer.from(JSON.stringify({ userId: 'alice' })).toString('base64url') + '.sig';
    expect(tokenUserId(token)).toBe('alice');
    expect(tokenUserId('invalid')).toBeNull();
  });
  it.each([
    { persisted: true, verified: false, fallback: true },
    { persisted: false, verified: false, error: '404' },
    { persisted: false, verified: false, error: '401' },
    { persisted: false, verified: false, error: 'Timeout' },
    { persisted: true },
  ])('never turns uncertain verification into permission to delete: %j', verification => {
    expect(verifiedUploadResult({ success: true, audioFileId: 'remote-id' }, verification))
      .toMatchObject({ success: false, verified: false, canDelete: false, pendingVerification: true, audioFileId: 'remote-id' });
  });
  it('a final server answer is a result, not a pending check, and still never permits deletion', () => {
    const result = verifiedUploadResult({ success: true, audioFileId: 'remote-id', canDelete: true },
      { persisted: false, verified: false, terminal: true, error: 'No speech was recognised' });
    expect(result).toMatchObject({ success: false, verified: false, contentVerified: false, canDelete: false,
      pendingVerification: false, canRetry: false, serverFinal: true, audioFileId: 'remote-id', error: 'No speech was recognised' });
  });
  it.each([
    { persisted: false, verified: false, error: '404' },
    { persisted: false, verified: false, error: 'Timeout' },
    { persisted: false, verified: false, authError: true },
    { persisted: false, verified: false, terminal: false },
    undefined,
  ])('keeps an answer that is not final retryable and pending: %j', verification => {
    const result = verifiedUploadResult({ audioFileId: 'remote-id' }, verification);
    expect(result).toMatchObject({ success: false, pendingVerification: true, canRetry: true, canDelete: false });
    expect(result).not.toHaveProperty('serverFinal');
  });
  it('a confirmed upload stays successful even if the answer also carries the final mark', () => {
    const result = verifiedUploadResult({ audioFileId: 'remote-id' }, { persisted: true, verified: true, terminal: true });
    expect(result).toMatchObject({ success: true, verified: true, pendingVerification: false, canRetry: true, canDelete: false });
    expect(result).not.toHaveProperty('serverFinal');
  });
  it('requires a remote identifier even if the HTTP request succeeded', () => {
    expect(verifiedUploadResult({ success: true }, { persisted: true, verified: true }).canDelete).toBe(false);
  });
  it('marks a confirmed upload successful while retaining local audio without content proof', () => {
    expect(verifiedUploadResult({ audioFileId: 'remote-id' }, { persisted: true, verified: true }))
      .toMatchObject({ success: true, verified: true, contentVerified: false, canDelete: false, pendingVerification: false });
  });
  it('overrides deletion and content-verification claims from an older accepted receipt', () => {
    expect(verifiedUploadResult(
      { success: true, audioFileId: 'remote-id', canDelete: true, contentVerified: true },
      { persisted: true, verified: true, contentVerified: true },
    )).toMatchObject({ success: true, verified: true, contentVerified: false, canDelete: false, pendingVerification: false });
  });
  it('retains source audio after a degraded merge or capture warning', () => {
    expect(verifiedUploadResult({ audioFileId: 'remote-id', captureWarnings: ['degraded-merge'] }, { persisted: true, verified: true }))
      .toMatchObject({ success: true, verified: true, canDelete: false });
  });
});
