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
const { addToMobileUploadQueue, getMobileUploadQueue, processMobileUploadQueue, queueItemOwnership, getHeldMobileUploads, claimUnownedMobileUploads, uploadWithVerification, tokenUserId } = upload;

const jwtFor = (userId) => `h.${Buffer.from(JSON.stringify({ userId, type: 'session' })).toString('base64url')}.s`;

const store = (id) => ({ user: id ? { id } : null, token: id ? jwtFor(id) : null, isAuthenticated: !!id, isTokenExpiringSoon: () => false, handleAuthError: vi.fn(async () => ({ success: false })) });
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
    addToMobileUploadQueue('mine', '/p/mine.m4a', {}, 'bob');
    addToMobileUploadQueue('alices', '/p/a.m4a', {}, 'alice');
    const result = await processMobileUploadQueue(store('bob'), 'https://api.example');
    expect(result.held).toEqual(['alices']);
    expect(networkCalls()).toBeGreaterThan(0);
  });

  it('items queued by older versions get the owner from the recording history, never the signed-in user', async () => {
    localStorage.setItem('recordings_history_cache_alice', JSON.stringify([{ id: 'alices-old' }]));
    localStorage.setItem('recordings_history_cache_bob', JSON.stringify([{ id: 'bobs-old' }]));
    localStorage.setItem('mobile_upload_queue', JSON.stringify([
      { recordId: 'alices-old', filePath: '/p/a.m4a', metadata: {}, retries: 0, addedAt: Date.now() },
      { recordId: 'bobs-old', filePath: '/p/b.m4a', metadata: {}, retries: 0, addedAt: Date.now() + 1 },
      { recordId: 'nobodys', filePath: '/p/n.m4a', metadata: {}, retries: 0, addedAt: Date.now() + 2 }
    ]));
    const before = networkCalls();
    const result = await processMobileUploadQueue(store('bob'), 'https://api.example');
    const owners = Object.fromEntries(getMobileUploadQueue().map(i => [i.recordId, i.ownerUserId]));
    expect(owners).toEqual({ 'alices-old': 'alice', 'bobs-old': 'bob', nobodys: null });
    // Alice's recording and the unresolved one are held, not uploaded with Bob's token.
    expect(result.held.sort()).toEqual(['alices-old', 'nobodys']);
    expect(networkCalls()).toBeGreaterThan(before); // only bobs-old was attempted
    const tokensUsed = JSON.stringify(net.fetchWithTimeout.mock.calls) + JSON.stringify(net.uploadViaPresignedSas.mock.calls);
    expect(tokensUsed).not.toContain('/p/a.m4a');
    expect(tokensUsed).not.toContain('/p/n.m4a');
  });

  it('a recording in two accounts\' histories stays unknown (held until claimed)', async () => {
    localStorage.setItem('recordings_history_cache_alice', JSON.stringify([{ id: 'shared' }]));
    localStorage.setItem('recordings_history_cache_bob', JSON.stringify([{ id: 'shared' }]));
    localStorage.setItem('mobile_upload_queue', JSON.stringify([{ recordId: 'shared', filePath: '/p/s.m4a', metadata: {}, retries: 0, addedAt: Date.now() }]));
    const before = networkCalls();
    const result = await processMobileUploadQueue(store('bob'), 'https://api.example');
    expect(result.held).toEqual(['shared']);
    expect(getMobileUploadQueue()[0].ownerUserId).toBeNull();
    expect(networkCalls()).toBe(before);
  });

  it('nothing is assigned while signed out', async () => {
    localStorage.setItem('mobile_upload_queue', JSON.stringify([{ recordId: 'old', filePath: '/p/o.m4a', metadata: {}, retries: 0, addedAt: Date.now() }]));
    const result = await processMobileUploadQueue(store(null), 'https://api.example');
    expect(result.held).toEqual(['old']);
    expect(getMobileUploadQueue()[0].ownerUserId).toBeNull();
  });

  it('central upload path: the first enqueue already carries the owner (token user); retry flow stays with that account', async () => {
    const res = await uploadWithVerification({ filePath: '/p/rec.m4a', recordId: 'rec', apiUrl: 'https://api.example', authToken: jwtFor('bob'), metadata: {} });
    expect(res.success).toBe(false);
    expect(getMobileUploadQueue().map(i => [i.recordId, i.ownerUserId])).toEqual([['rec', 'bob']]);
    // A later caller adding the same recording does not change it.
    addToMobileUploadQueue('rec', '/p/rec.m4a', {}, 'alice');
    expect(getMobileUploadQueue()[0].ownerUserId).toBe('bob');
    // Retry under another account: held, no network.
    let before = networkCalls();
    expect((await processMobileUploadQueue(store('alice'), 'https://api.example')).held).toEqual(['rec']);
    expect(networkCalls()).toBe(before);
    // Retry under the owner: attempted.
    before = networkCalls();
    await processMobileUploadQueue(store('bob'), 'https://api.example');
    expect(networkCalls()).toBeGreaterThan(before);
  });

  it('central upload path: an explicit owner must match the token; a missing owner is completed only for items of this process', async () => {
    await uploadWithVerification({ filePath: '/p/x.m4a', recordId: 'x', apiUrl: 'https://api.example', authToken: 'not-a-jwt', metadata: {} });
    expect(getMobileUploadQueue()[0].ownerUserId).toBeNull();
    addToMobileUploadQueue('x', '/p/x.m4a', {}, 'bob');
    expect(getMobileUploadQueue()[0].ownerUserId).toBe('bob');
    await uploadWithVerification({ filePath: '/p/y.m4a', recordId: 'y', apiUrl: 'https://api.example', authToken: jwtFor('carol'), metadata: {}, ownerUserId: 'carol' });
    expect(getMobileUploadQueue().find(i => i.recordId === 'y').ownerUserId).toBe('carol');
    // An explicit owner that is not the token's account is refused, nothing queued.
    const refused = await uploadWithVerification({ filePath: '/p/z.m4a', recordId: 'z', apiUrl: 'https://api.example', authToken: jwtFor('bob'), metadata: {}, ownerUserId: 'carol' });
    expect(refused).toMatchObject({ success: false, held: true, ownership: 'other_account' });
    expect(getMobileUploadQueue().find(i => i.recordId === 'z')).toBeUndefined();
    // An unknown-owner item from an earlier run is never completed by an enqueue.
    localStorage.setItem('mobile_upload_queue', JSON.stringify([{ recordId: 'earlier', filePath: '/p/e.m4a', metadata: {}, retries: 0, addedAt: Date.now(), ownerUserId: null }]));
    addToMobileUploadQueue('earlier', '/p/e.m4a', {}, 'bob');
    expect(getMobileUploadQueue()[0].ownerUserId).toBeNull();
  });

  it('tokenUserId reads the userId claim only', () => {
    expect(tokenUserId(jwtFor('u-1'))).toBe('u-1');
    expect(tokenUserId('garbage')).toBeNull();
    expect(tokenUserId(null)).toBeNull();
  });

  it('an explicit claim takes only items without an owner', () => {
    addToMobileUploadQueue('alices', '/p/a.m4a', {}, 'alice');
    addToMobileUploadQueue('unknown', '/p/u.m4a', {}, null);
    expect(claimUnownedMobileUploads('bob')).toBe(1);
    expect(getMobileUploadQueue().map(i => [i.recordId, i.ownerUserId])).toEqual([['alices', 'alice'], ['unknown', 'bob']]);
  });
});
