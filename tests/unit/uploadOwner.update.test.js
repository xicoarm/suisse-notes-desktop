import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// U1-U4 (review 10/2026):
// - the owner of an upload is fixed before its first request (the token it
//   starts with); a refreshed token of another account is never used and an
//   upload without a provable owner sends nothing;
// - the update from a version that kept the session in plaintext starts
//   signed out, with queue and recordings untouched; the login of A uploads
//   only A's recordings.

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isMobile: () => true, isIOS: () => false, isAndroid: () => true,
  getPlatform: () => 'android', PlatformConstants: {}
}));
vi.mock('../../src/boot/sentry', () => ({ addBreadcrumb: vi.fn(), captureMessage: vi.fn(), captureException: vi.fn(), setUser: vi.fn() }));
vi.mock('../../src/services/sentryHelpers', () => ({ sentryUploadStart: vi.fn(), sentryUploadSuccess: vi.fn(), sentryUploadFail: vi.fn() }));
vi.mock('../../src/stores/device', () => ({ useDeviceStore: () => ({ reloadForUser: vi.fn(async () => {}), onLogout: vi.fn(async () => {}) }) }));
vi.mock('../../src/stores/minutes', () => ({ useMinutesStore: () => ({ fetchMinutes: vi.fn(async () => ({})), setFromServer: vi.fn(), reset: vi.fn() }) }));
vi.mock('../../src/stores/recordings-history', () => ({
  useRecordingsHistoryStore: () => ({ updateRecording: vi.fn(async () => {}), applyStoragePreference: vi.fn(async () => {}), reset: vi.fn(), recordings: [] })
}));
const net = vi.hoisted(() => ({
  uploadViaPresignedSas: vi.fn(async () => { throw new Error('network down'); }),
  readBlobFromCapacitorPath: vi.fn(async () => new Blob(['x'])),
  fetchWithTimeout: vi.fn(async () => { throw new Error('network down'); }),
  deleteFile: vi.fn(async () => ({ success: true }))
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
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(async () => { throw new Error('network down'); }),
  parseJsonSafe: vi.fn(async () => ({})),
  API_ENDPOINTS: { refreshToken: '/api/auth/refresh' },
  ApiResponseError: class extends Error {}
}));
vi.mock('../../src/services/storage', () => ({ readFile: vi.fn(async () => ({ success: false, error: 'network down' })), deleteFile: net.deleteFile }));
vi.mock('../../src/services/integrity', () => ({ calculateUploadChecksum: vi.fn(async () => 'c'), verifyUploadChecksum: vi.fn() }));

// Native storage of the device: keystore (new) and Preferences (old versions).
const ks = new Map();
const prefs = new Map();
const proxy = (impl) => new Proxy({}, {
  get: (_, prop) => (typeof prop === 'string' && typeof impl[prop] === 'function' ? impl[prop] : () => new Promise(() => {}))
});
const keystore = {
  get: async ({ key }) => ({ value: ks.has(key) ? ks.get(key) : null }),
  set: async ({ key, value }) => { ks.set(key, value); },
  remove: async ({ key }) => { ks.delete(key); }
};
const preferences = {
  get: async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null }),
  set: async ({ key, value }) => { prefs.set(key, value); },
  remove: async ({ key }) => { prefs.delete(key); }
};
vi.mock('@capacitor/core', () => ({ registerPlugin: (name) => proxy(name === 'SecureTokenStore' ? keystore : {}) }));
vi.mock('@capacitor/preferences', () => ({ Preferences: proxy(preferences) }));

const upload = await import('../../src/services/upload');
const { useAuthStore } = await import('../../src/stores/auth');
const { getMobileUploadQueue, uploadWithVerification } = upload;

const DAY = 24 * 60 * 60 * 1000;
const EXP = Math.floor((Date.now() + 7 * DAY) / 1000);
const jwtFor = (userId, tag = '') => `h.${Buffer.from(JSON.stringify({ userId, tag, exp: EXP })).toString('base64url')}.s`;
const networkCalls = () => net.uploadViaPresignedSas.mock.calls.length + net.readBlobFromCapacitorPath.mock.calls.length + net.fetchWithTimeout.mock.calls.length;
const tokensSent = () => net.uploadViaPresignedSas.mock.calls.map((c) => c[0].authToken);

beforeEach(() => {
  localStorage.clear();
  ks.clear();
  prefs.clear();
  vi.clearAllMocks();
  net.uploadViaPresignedSas.mockImplementation(async () => { throw new Error('network down'); });
  setActivePinia(createPinia());
});

describe('U1/U2: first upload without a queue item', () => {
  it('A starts, 401, the refresh returns B: no request with B, owner A, recording kept', async () => {
    net.uploadViaPresignedSas.mockResolvedValueOnce({ mode: 'azure', success: false, status: 401, error: 'Token expired' });
    const handleAuthError = vi.fn(async () => ({ success: true, token: jwtFor('b') }));
    const tokenA = jwtFor('a');
    const res = await uploadWithVerification({
      filePath: '/p/new.m4a', recordId: 'new', apiUrl: 'https://api.example', authToken: tokenA, metadata: {},
      getAuthStore: () => ({ handleAuthError })
    });
    expect(res.success).toBe(false);
    expect(res.canDelete).toBe(false);
    expect(handleAuthError).toHaveBeenCalled();
    expect(tokensSent()).toEqual([tokenA]);
    expect(getMobileUploadQueue().map((i) => [i.recordId, i.ownerUserId])).toEqual([['new', 'a']]);
    expect(net.deleteFile).not.toHaveBeenCalled();
  });

  it('an undecodable token cannot fix an owner: no request, held (owner unknown), recording kept', async () => {
    const res = await uploadWithVerification({
      filePath: '/p/x.m4a', recordId: 'x', apiUrl: 'https://api.example', authToken: 'not-a-jwt', metadata: {}
    });
    expect(res).toMatchObject({ success: false, held: true, ownership: 'owner_unknown', canDelete: false });
    expect(networkCalls()).toBe(0);
    expect(getMobileUploadQueue().map((i) => [i.recordId, i.ownerUserId])).toEqual([['x', null]]);
    // A later enqueue (any account) does not assign it (U3): only an explicit claim does.
    upload.addToMobileUploadQueue('x', '/p/x.m4a', {}, 'a');
    expect(getMobileUploadQueue()[0].ownerUserId).toBeNull();
    expect(net.deleteFile).not.toHaveBeenCalled();
  });
});

describe('update from a version with the session in plaintext', () => {
  it('starts signed out with queue and recordings unchanged; the login of A uploads only A', async () => {
    const queue = [
      { recordId: 'rec-a', filePath: '/p/a.m4a', metadata: {}, retries: 0, addedAt: Date.now() - 3000, ownerUserId: 'a' },
      { recordId: 'rec-b', filePath: '/p/b.m4a', metadata: {}, retries: 0, addedAt: Date.now() - 2000, ownerUserId: 'b' },
      { recordId: 'rec-u', filePath: '/p/u.m4a', metadata: {}, retries: 0, addedAt: Date.now() - 1000, ownerUserId: null }
    ];
    localStorage.setItem('mobile_upload_queue', JSON.stringify(queue));
    // The old version's session of A, in plaintext.
    prefs.set('authToken', jwtFor('a', 'old'));
    prefs.set('userInfo', JSON.stringify({ id: 'a', email: 'a@example.com' }));

    const store = useAuthStore();
    await store.checkSession();
    store.stopTokenRefresh();
    expect(store.isAuthenticated).toBe(false);
    expect(store.token).toBeNull();
    expect(getMobileUploadQueue()).toEqual(queue);
    expect(networkCalls()).toBe(0);
    expect(net.deleteFile).not.toHaveBeenCalled();
    expect(prefs.has('authToken')).toBe(false);

    // Login A: the queue resumes for A only.
    net.uploadViaPresignedSas.mockImplementation(async ({ recordId }) => ({ mode: 'azure', success: true, verified: true, audioFileId: `f-${recordId}` }));
    const { sessionTicket } = await import('../../src/services/sessionAuthority');
    await store.loginWithSSO({ token: jwtFor('a', 'new'), user: { id: 'a' } }, sessionTicket());
    store.stopTokenRefresh();
    await vi.waitFor(() => expect(net.uploadViaPresignedSas).toHaveBeenCalled());
    await vi.waitFor(() => expect(getMobileUploadQueue().map((i) => i.recordId)).toEqual(['rec-b', 'rec-u']));
    expect(net.uploadViaPresignedSas.mock.calls.map((c) => c[0].recordId)).toEqual(['rec-a']);
    expect(getMobileUploadQueue().map((i) => [i.recordId, i.ownerUserId])).toEqual([['rec-b', 'b'], ['rec-u', null]]);
    expect(net.deleteFile).not.toHaveBeenCalled();
  });
});

describe('U4: old held entries survive the age cleanup', () => {
  it('8-day-old entries of A, B and unknown owner stay through the banner, the signed-out read and a run under C', async () => {
    const old = Date.now() - 8 * DAY;
    const queue = [
      { recordId: 'old-a', filePath: '/p/a.m4a', metadata: {}, retries: 0, addedAt: old, ownerUserId: 'a' },
      { recordId: 'old-b', filePath: '/p/b.m4a', metadata: {}, retries: 0, addedAt: old + 1, ownerUserId: 'b' },
      { recordId: 'old-u', filePath: '/p/u.m4a', metadata: {}, retries: 0, addedAt: old + 2, ownerUserId: null }
    ];
    localStorage.setItem('mobile_upload_queue', JSON.stringify(queue));
    expect(getMobileUploadQueue()).toEqual(queue); // signed out
    expect(upload.getHeldMobileUploads('c')).toEqual({ otherAccount: ['old-a', 'old-b'], ownerUnknown: ['old-u'] }); // banner
    const asC = { user: { id: 'c' }, token: jwtFor('c'), isAuthenticated: true, isTokenExpiringSoon: () => false, handleAuthError: vi.fn(async () => ({ success: false })) };
    const run = await upload.processMobileUploadQueue(asC, 'https://api.example');
    expect(run.held.sort()).toEqual(['old-a', 'old-b', 'old-u']);
    expect(run.purged).toEqual([]);
    expect(getMobileUploadQueue()).toEqual(queue);
    expect(JSON.parse(localStorage.getItem('mobile_upload_queue'))).toEqual(queue);
    expect(networkCalls()).toBe(0);
    expect(net.deleteFile).not.toHaveBeenCalled();
  });
});
