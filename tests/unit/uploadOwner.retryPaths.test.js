import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// SECURITY: the owner check sits in the central upload path
// (uploadWithVerification), so every retry path - queue processor, manual
// retry (HistoryPage), history auto-retry, device sync - uploads a recording
// only with a token of the account that owns it, also after a token refresh.

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isMobile: () => true, getPlatform: () => 'android',
  PlatformConstants: {}
}));
vi.mock('../../src/boot/sentry', () => ({ addBreadcrumb: vi.fn(), captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('../../src/services/sentryHelpers', () => ({ sentryUploadStart: vi.fn(), sentryUploadSuccess: vi.fn(), sentryUploadFail: vi.fn() }));
const net = vi.hoisted(() => ({
  uploadViaPresignedSas: vi.fn(async () => { throw new Error('network down'); }),
  readBlobFromCapacitorPath: vi.fn(async () => new Blob(['x'])),
  fetchWithTimeout: vi.fn(async () => { throw new Error('network down'); })
}));
vi.mock('../../src/services/upload-direct', () => ({
  uploadViaPresignedSas: net.uploadViaPresignedSas,
  isTransientUploadError: () => true,
  readBlobFromCapacitorPath: net.readBlobFromCapacitorPath
}));
vi.mock('../../src/services/api', () => ({
  getApiUrlSync: () => 'https://api.example',
  fetchWithTimeout: net.fetchWithTimeout,
  readJson: vi.fn(),
  ApiResponseError: class extends Error {}
}));
vi.mock('../../src/services/storage', () => ({ readFile: vi.fn(async () => ({ success: false, error: 'network down' })), deleteFile: vi.fn() }));
vi.mock('../../src/services/integrity', () => ({ calculateUploadChecksum: vi.fn(async () => 'c'), verifyUploadChecksum: vi.fn() }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { set: vi.fn(async () => {}), get: vi.fn(async () => ({ value: null })), remove: vi.fn(async () => {}) } }));
vi.mock('../../src/stores/recording', () => ({ useRecordingStore: () => ({}) }));

const jwtFor = (userId) => `h.${Buffer.from(JSON.stringify({ userId, type: 'session' })).toString('base64url')}.s`;
const auth = vi.hoisted(() => ({ store: null }));
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => auth.store }));

const upload = await import('../../src/services/upload');
const { useRecordingsHistoryStore } = await import('../../src/stores/recordings-history');
const { addToMobileUploadQueue, getMobileUploadQueue, uploadWithVerification, uploadOwnershipCheck } = upload;

const networkCalls = () => net.uploadViaPresignedSas.mock.calls.length + net.readBlobFromCapacitorPath.mock.calls.length + net.fetchWithTimeout.mock.calls.length;
const seedQueue = (items) => localStorage.setItem('mobile_upload_queue', JSON.stringify(items.map((i, n) => ({ filePath: `/p/${i.recordId}.m4a`, metadata: {}, retries: 0, addedAt: Date.now() + n, ...i }))));
const signIn = (id) => {
  auth.store = { user: { id }, token: jwtFor(id), isAuthenticated: true, isTokenExpiringSoon: () => false, handleAuthError: vi.fn(async () => ({ success: false })) };
  return auth.store;
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  setActivePinia(createPinia());
});

describe('central upload path: owner check for every caller', () => {
  it('manual retry with another account\'s token is refused before any network work', async () => {
    seedQueue([{ recordId: 'rec-a', ownerUserId: 'alice' }]);
    const res = await uploadWithVerification({ filePath: '/p/rec-a.m4a', recordId: 'rec-a', apiUrl: 'https://api.example', authToken: jwtFor('bob'), metadata: {} });
    expect(res).toMatchObject({ success: false, held: true, ownership: 'other_account', canDelete: false });
    expect(networkCalls()).toBe(0);
    expect(getMobileUploadQueue().map(i => [i.recordId, i.ownerUserId])).toEqual([['rec-a', 'alice']]);
  });

  it('an item of unknown owner from an earlier run is held until claimed', async () => {
    seedQueue([{ recordId: 'rec-u', ownerUserId: null }]);
    const res = await uploadWithVerification({ filePath: '/p/rec-u.m4a', recordId: 'rec-u', apiUrl: 'https://api.example', authToken: jwtFor('bob'), metadata: {} });
    expect(res).toMatchObject({ success: false, held: true, ownership: 'owner_unknown' });
    expect(networkCalls()).toBe(0);
    upload.claimUnownedMobileUploads('bob', ['rec-u']);
    expect(uploadOwnershipCheck({ recordId: 'rec-u', filePath: '/p/rec-u.m4a', authToken: jwtFor('bob') })).toEqual({ ok: true, owner: 'bob' });
  });

  it('a pre-owner item (older version) resolved to another account is refused', async () => {
    localStorage.setItem('recordings_history_cache_alice', JSON.stringify([{ id: 'old-a' }]));
    seedQueue([{ recordId: 'old-a' }]);
    const res = await uploadWithVerification({ filePath: '/p/old-a.m4a', recordId: 'old-a', apiUrl: 'https://api.example', authToken: jwtFor('bob'), metadata: {} });
    expect(res).toMatchObject({ held: true, ownership: 'other_account' });
    expect(networkCalls()).toBe(0);
  });

  it('an explicit owner that does not match the token is refused; an undecodable token cannot prove a known owner', async () => {
    expect((await uploadWithVerification({ filePath: '/p/x.m4a', recordId: 'x', apiUrl: 'https://api.example', authToken: jwtFor('bob'), metadata: {}, ownerUserId: 'alice' })).ownership).toBe('other_account');
    seedQueue([{ recordId: 'y', ownerUserId: 'bob' }]);
    expect((await uploadWithVerification({ filePath: '/p/y.m4a', recordId: 'y', apiUrl: 'https://api.example', authToken: 'not-a-jwt', metadata: {} })).ownership).toBe('other_account');
    expect(networkCalls()).toBe(0);
  });

  it('the owner\'s own token uploads (attempted)', async () => {
    seedQueue([{ recordId: 'rec-b', ownerUserId: 'bob' }]);
    await uploadWithVerification({ filePath: '/p/rec-b.m4a', recordId: 'rec-b', apiUrl: 'https://api.example', authToken: jwtFor('bob'), metadata: {} });
    expect(networkCalls()).toBeGreaterThan(0);
  });

  it('a token refresh that returns another account\'s token is not used (account switched mid-upload)', async () => {
    seedQueue([{ recordId: 'rec-b', ownerUserId: 'bob' }]);
    net.uploadViaPresignedSas.mockResolvedValueOnce({ mode: 'azure', success: false, status: 401, error: 'Token expired' });
    const handleAuthError = vi.fn(async () => ({ success: true, token: jwtFor('alice') }));
    const res = await uploadWithVerification({
      filePath: '/p/rec-b.m4a', recordId: 'rec-b', apiUrl: 'https://api.example', authToken: jwtFor('bob'), metadata: {},
      getAuthStore: () => ({ handleAuthError })
    });
    expect(res.success).toBe(false);
    expect(handleAuthError).toHaveBeenCalled();
    const tokensSent = net.uploadViaPresignedSas.mock.calls.map(c => c[0].authToken);
    expect(tokensSent).not.toContain(jwtFor('alice'));
  });

  it('a token refresh of the same account is used', async () => {
    seedQueue([{ recordId: 'rec-b', ownerUserId: 'bob' }]);
    const fresh = `${jwtFor('bob')}x`;
    net.uploadViaPresignedSas.mockResolvedValueOnce({ mode: 'azure', success: false, status: 401, error: 'Token expired' });
    await uploadWithVerification({
      filePath: '/p/rec-b.m4a', recordId: 'rec-b', apiUrl: 'https://api.example', authToken: jwtFor('bob'), metadata: {},
      getAuthStore: () => ({ handleAuthError: async () => ({ success: true, token: fresh }) })
    });
    expect(net.uploadViaPresignedSas.mock.calls.map(c => c[0].authToken)).toContain(fresh);
  });

  it('queue processor under another account holds the item (no network)', async () => {
    seedQueue([{ recordId: 'rec-a', ownerUserId: 'alice' }]);
    const result = await upload.processMobileUploadQueue(signIn('bob'), 'https://api.example');
    expect(result.held).toEqual(['rec-a']);
    expect(networkCalls()).toBe(0);
  });

  it('history auto-retry under another account parks the recording instead of uploading it', async () => {
    seedQueue([{ recordId: 'rec-a', ownerUserId: 'alice' }]);
    signIn('bob');
    const history = useRecordingsHistoryStore();
    history.recordings.push({ id: 'rec-a', uploadStatus: 'failed', filePath: '/p/rec-a.m4a', userId: 'bob', retryCount: 0 });
    await history.retryFailedUploads();
    // (The history store may PATCH the status; no audio is read or sent.)
    expect(net.uploadViaPresignedSas).not.toHaveBeenCalled();
    expect(net.readBlobFromCapacitorPath).not.toHaveBeenCalled();
    for (const [url, opts] of net.fetchWithTimeout.mock.calls) {
      expect(url).toBe('https://api.example/api/desktop/recording/rec-a');
      expect(opts.method).toBe('PATCH');
    }
    const rec = history.recordings.find(r => r.id === 'rec-a');
    expect(rec.uploadStatus).toBe('failed');
    expect(rec.uploadError).toMatch(/another account/);
    expect(getMobileUploadQueue().map(i => [i.recordId, i.ownerUserId])).toEqual([['rec-a', 'alice']]);
  });

  it('a fresh recording (no queue item yet) is enqueued with the token\'s account', async () => {
    addToMobileUploadQueue('other', '/p/other.m4a', {}, 'carol');
    await uploadWithVerification({ filePath: '/p/new.m4a', recordId: 'new', apiUrl: 'https://api.example', authToken: jwtFor('bob'), metadata: {} });
    expect(getMobileUploadQueue().find(i => i.recordId === 'new').ownerUserId).toBe('bob');
  });
});
