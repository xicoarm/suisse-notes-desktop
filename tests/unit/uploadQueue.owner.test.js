import { describe, it, expect, beforeEach, vi } from 'vitest';

// SECURITY: a queued recording is uploaded only while the account that
// recorded it is signed in — never under another account.

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false, isCapacitor: () => true, isMobile: () => true,
  PlatformConstants: {}
}));
vi.mock('../../src/boot/sentry', () => ({ addBreadcrumb: vi.fn(), captureMessage: vi.fn() }));
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
vi.mock('../../src/services/api', () => ({ fetchWithTimeout: net.fetchWithTimeout, readJson: vi.fn() }));
vi.mock('../../src/services/storage', () => ({ readFile: vi.fn(async () => ({ success: false, error: 'network down' })), deleteFile: vi.fn() }));
vi.mock('../../src/services/integrity', () => ({ calculateUploadChecksum: vi.fn(async () => 'c'), verifyUploadChecksum: vi.fn() }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { set: vi.fn(async () => {}), get: vi.fn(async () => ({ value: null })) } }));

const upload = await import('../../src/services/upload');
const { addToMobileUploadQueue, getMobileUploadQueue, processMobileUploadQueue, queueItemOwnership, getHeldMobileUploads, claimUnownedMobileUploads } = upload;

const store = (id) => ({ user: id ? { id } : null, token: 't', isAuthenticated: !!id, isTokenExpiringSoon: () => false, handleAuthError: vi.fn(async () => ({ success: false })) });
const networkCalls = () => net.uploadViaPresignedSas.mock.calls.length + net.readBlobFromCapacitorPath.mock.calls.length + net.fetchWithTimeout.mock.calls.length;

describe('upload queue ownership', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('records the owner with every item', () => {
    addToMobileUploadQueue('r1', '/p/r1.m4a', {}, 'alice');
    addToMobileUploadQueue('r2', '/p/r2.m4a', {}, 42);
    addToMobileUploadQueue('r3', '/p/r3.m4a', {});
    expect(getMobileUploadQueue().map(i => i.ownerUserId)).toEqual(['alice', '42', null]);
  });

  it('classifies ownership', () => {
    expect(queueItemOwnership({ ownerUserId: 'a' }, 'a')).toBe('owner');
    expect(queueItemOwnership({ ownerUserId: 'a' }, 'b')).toBe('other_account');
    expect(queueItemOwnership({ ownerUserId: null }, 'b')).toBe('owner_unknown');
    expect(queueItemOwnership({ ownerUserId: 'a' }, null)).toBe('signed_out');
  });

  it('never uploads another account\'s recordings and reports them as held', async () => {
    localStorage.setItem('mobile_upload_queue_owner_migrated', '1');
    addToMobileUploadQueue('mine', '/p/mine.m4a', {}, 'bob');
    addToMobileUploadQueue('alices', '/p/a.m4a', {}, 'alice');
    addToMobileUploadQueue('unknown', '/p/u.m4a', {}, null);
    const before = networkCalls();
    const result = await processMobileUploadQueue(store('mallory'), 'https://api.example');
    expect(result.held.sort()).toEqual(['alices', 'mine', 'unknown']);
    expect(networkCalls()).toBe(before);
    // Still queued for their owner.
    expect(getMobileUploadQueue().map(i => i.recordId).sort()).toEqual(['alices', 'mine', 'unknown']);
    expect(getHeldMobileUploads('mallory')).toEqual({ otherAccount: ['mine', 'alices'], ownerUnknown: ['unknown'] });
  });

  it('uploads the owner\'s own item (attempted), holds the rest', async () => {
    localStorage.setItem('mobile_upload_queue_owner_migrated', '1');
    addToMobileUploadQueue('mine', '/p/mine.m4a', {}, 'bob');
    addToMobileUploadQueue('alices', '/p/a.m4a', {}, 'alice');
    const result = await processMobileUploadQueue(store('bob'), 'https://api.example');
    expect(result.held).toEqual(['alices']);
    expect(networkCalls()).toBeGreaterThan(0);
  });

  it('items queued before the update are claimed once by the account the update found', async () => {
    localStorage.setItem('mobile_upload_queue', JSON.stringify([{ recordId: 'old', filePath: '/p/o.m4a', metadata: {}, retries: 0, addedAt: Date.now() }]));
    await processMobileUploadQueue(store('bob'), 'https://api.example');
    expect(getMobileUploadQueue()[0].ownerUserId).toBe('bob');
    expect(localStorage.getItem('mobile_upload_queue_owner_migrated')).toBe('1');
  });

  it('nothing is claimed while signed out', async () => {
    localStorage.setItem('mobile_upload_queue', JSON.stringify([{ recordId: 'old', filePath: '/p/o.m4a', metadata: {}, retries: 0, addedAt: Date.now() }]));
    const result = await processMobileUploadQueue(store(null), 'https://api.example');
    expect(result.held).toEqual(['old']);
    expect(getMobileUploadQueue()[0].ownerUserId).toBeUndefined();
    expect(localStorage.getItem('mobile_upload_queue_owner_migrated')).toBeNull();
  });

  it('an explicit claim takes only items without an owner', () => {
    addToMobileUploadQueue('alices', '/p/a.m4a', {}, 'alice');
    addToMobileUploadQueue('unknown', '/p/u.m4a', {}, null);
    expect(claimUnownedMobileUploads('bob')).toBe(1);
    expect(getMobileUploadQueue().map(i => [i.recordId, i.ownerUserId])).toEqual([['alices', 'alice'], ['unknown', 'bob']]);
  });
});
