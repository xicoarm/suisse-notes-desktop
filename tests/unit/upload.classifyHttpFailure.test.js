import { describe, it, expect, vi } from 'vitest';

// Server verdicts on an upload must survive to the retry drivers: a 4xx is
// final (re-sending the same file cannot change the answer) while 401/5xx
// are transient. Before this, every non-2xx was thrown as a bare Error and
// the queue re-uploaded whole files for days (Sentry CAPACITOR-RZ/R7/KM/JT).
vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  isMobile: () => true,
  PlatformConstants: {}
}));
vi.mock('../../src/services/integrity', () => ({
  calculateUploadChecksum: async () => 'sum',
  verifyUploadChecksum: async () => true
}));
vi.mock('../../src/services/storage', () => ({
  readFile: async () => ({ success: false }),
  deleteFile: async () => ({ success: true })
}));
vi.mock('../../src/services/sentryHelpers', () => ({
  sentryUploadStart: () => {},
  sentryUploadSuccess: () => {},
  sentryUploadFail: () => {}
}));
vi.mock('../../src/boot/sentry', () => ({
  addBreadcrumb: () => {},
  captureMessage: () => {}
}));
vi.mock('../../src/services/upload-direct', () => ({
  uploadViaPresignedSas: async () => ({ success: false }),
  isTransientUploadError: () => false,
  readBlobFromCapacitorPath: async () => { throw new Error('n/a'); }
}));
vi.mock('../../src/services/api', () => ({
  fetchWithTimeout: async () => { throw new Error('offline (test)'); }
}));

import { classifyUploadHttpFailure, uploadWithVerification } from '../../src/services/upload';

describe('classifyUploadHttpFailure', () => {
  it('4xx verdicts are terminal and keep the server message', () => {
    const r = classifyUploadHttpFailure(400, JSON.stringify({ error: 'No speech detected in audio' }));
    expect(r).toMatchObject({ success: false, status: 400, canRetry: false, error: 'No speech detected in audio', insufficientMinutes: false });
  });

  it('402 flags insufficient minutes', () => {
    const r = classifyUploadHttpFailure(402, JSON.stringify({ error: 'Not enough minutes', code: 'INSUFFICIENT_MINUTES' }));
    expect(r.canRetry).toBe(false);
    expect(r.insufficientMinutes).toBe(true);
    expect(r.code).toBe('INSUFFICIENT_MINUTES');
  });

  it('413 keeps the size-cap message', () => {
    const r = classifyUploadHttpFailure(413, '<html>nginx</html>');
    expect(r.canRetry).toBe(false);
    expect(r.error).toMatch(/too large/i);
  });

  it('401, 408, 429 and 5xx are transient', () => {
    for (const status of [401, 408, 429, 500, 502, 503]) {
      expect(classifyUploadHttpFailure(status, '').canRetry).toBe(true);
    }
  });

  it('a non-JSON body (proxy error page) does not crash and yields a status message', () => {
    const r = classifyUploadHttpFailure(502, '<html>Bad Gateway</html>');
    expect(r.error).toBe('Upload failed with status 502');
  });
});

describe('uploadWithVerification guards', () => {
  it('refuses to upload without a recordId (would register an unfindable meeting)', async () => {
    const r = await uploadWithVerification({ filePath: '/x.webm', recordId: null, apiUrl: 'https://api.test', authToken: 't' });
    expect(r).toMatchObject({ success: false, canRetry: false, canDelete: false });
  });
});
