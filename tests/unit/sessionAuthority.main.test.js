import { describe, it, expect } from 'vitest';
import { boot, createDisk, jwt, userB64, ssoFlow } from './support/desktopSession';

// Desktop session authority (src-electron/session-authority.js), security
// review 10/2026 round 6: one record {epoch, signedOut} in main, every
// sign-in applies through applySession(ticket, result), the sign-out
// tombstone wins on every main path. Each test failed at 2349920b.

const callback = (params) => `suissenotes://auth/callback?${params}`;
const legacy = (state, userId) => callback(`${state ? `state=${state}&` : ''}token=${jwt(userId, 'sso')}&user=${userB64({ id: userId })}`);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function signedIn(disk, userId = 'a') {
  const app = boot(disk);
  const { apply } = app.passwordSignIn(userId);
  expect(apply()).toMatchObject({ applied: true, persisted: true });
  return app;
}

describe('R2: desktop - a late SSO result after password sign-in and sign-out never signs in', () => {
  it('a late legacy callback with the valid state', () => {
    const disk = createDisk();
    const app = boot(disk);
    const flow = app.beginSso();
    app.passwordSignIn('pw').apply();
    expect(app.authority.signOut()).toMatchObject({ success: true });
    return app.handleCallback(legacy(flow.state, 'sso')).then((res) => {
      expect(res.ignored).toBeTruthy();
      expect(app.authority.getToken()).toBeNull();
      expect(disk.config.authToken).toBeUndefined();
      expect(app.authority.takePending()).toBeNull();
      expect(app.authority.state().signedOut).toBe(true);
      expect(app.delivered).toEqual([]);
    });
  });

  it('a code exchange answer that arrives after the sign-out', async () => {
    const disk = createDisk();
    const answer = deferred();
    const app = boot(disk, { exchange: () => answer.promise });
    const flow = app.beginSso('google');
    const running = app.handleCallback(callback(`state=${flow.state}&auth_code=one-time`));
    app.passwordSignIn('pw').apply();
    app.authority.signOut();
    answer.resolve({ token: jwt('sso'), user: { id: 'sso' } });
    expect((await running).ignored).toBe('session_changed');
    expect(app.authority.getToken()).toBeNull();
    expect(disk.config.authToken).toBeUndefined();
    expect(app.authority.takePending()).toBeNull();
    expect(app.authority.state().signedOut).toBe(true);
  });

  it('a restart before the callback', async () => {
    const disk = createDisk();
    const first = boot(disk);
    const flow = first.beginSso();
    first.passwordSignIn('pw').apply();
    first.authority.signOut();
    const app = boot(disk);
    expect((await app.handleCallback(legacy(flow.state, 'sso'))).ignored).toBeTruthy();
    expect(app.authority.getToken()).toBeNull();
    expect(disk.config.authToken).toBeUndefined();
    expect(app.authority.takePending()).toBeNull();
    expect(app.authority.restore()).toMatchObject({ signedOut: true });
  });

  it('the flow of the current epoch still works (cold start by the callback)', async () => {
    const disk = createDisk();
    const flow = boot(disk).beginSso();
    const app = boot(disk);
    const res = await app.handleCallback(legacy(flow.state, 'sso'));
    expect(res.delivered).toMatchObject({ bound: true, applied: true });
    expect(app.authority.restore()).toMatchObject({ signedOut: false, user: { id: 'sso' }, token: jwt('sso', 'sso') });
    expect(app.authority.takePending()).toMatchObject({ applied: true });
  });
});

describe('R3: a failing store.delete at sign-out', () => {
  it('getToken is null at once and after a restart; a running refresh writes nothing; a new sign-in frees', async () => {
    const disk = createDisk();
    disk.queue = [{ recordId: 'r1', filePath: '/r1', userId: 'a', retryCount: 0 }];
    const app = signedIn(disk, 'a');
    const refreshTicket = app.authority.ticket({ userId: 'a' });
    disk.failDelete = new Set(['authToken', 'userInfo', 'ssoPendingFlow']);
    expect(app.authority.signOut()).toMatchObject({ success: false });
    expect(disk.config.authToken).toBeTruthy(); // still on disk ...
    expect(app.authority.getToken()).toBeNull(); // ... never used
    expect(app.vault.getToken()).toBeNull();
    // A refresh that was running writes nothing.
    const before = disk.config.authToken;
    expect(app.authority.applySession(refreshTicket, { token: jwt('a', 'refreshed') }, { kind: 'refresh' })).toEqual({ applied: false, reason: 'session_changed' });
    expect(disk.config.authToken).toBe(before);
    await app.processPendingUploads();
    expect(app.requests).toEqual([]);

    const restarted = boot(disk);
    expect(restarted.authority.getToken()).toBeNull();
    expect(restarted.vault.getToken()).toBeNull();
    await restarted.processPendingUploads();
    expect(restarted.requests).toEqual([]);
    expect(disk.queue).toHaveLength(1);

    disk.failDelete = new Set();
    expect(restarted.passwordSignIn('a', 'new').apply()).toMatchObject({ applied: true });
    expect(restarted.authority.getToken()).toBe(jwt('a', 'new'));
  });
});

describe('E1: one record; unreadable = signed out', () => {
  it('an unreadable record with a token on disk: signed out, no request', async () => {
    const disk = createDisk();
    disk.queue = [{ recordId: 'r1', filePath: '/r1', userId: 'a', retryCount: 0 }];
    signedIn(disk, 'a');
    disk.failRecordRead = true;
    const app = boot(disk);
    expect(app.authority.state()).toMatchObject({ signedOut: true, unreadable: true });
    expect(app.authority.getToken()).toBeNull();
    expect(app.authority.restore()).toMatchObject({ signedOut: true });
    await app.processPendingUploads();
    expect(app.requests).toEqual([]);
  });

  it('a corrupt record counts as unreadable', () => {
    const disk = createDisk();
    signedIn(disk, 'a');
    disk.record = '{"epoch":"x"';
    expect(boot(disk).authority.restore()).toMatchObject({ signedOut: true });
  });

  it('the first start after the update (no record) is signed out and deletes the old token', () => {
    const disk = createDisk();
    signedIn(disk, 'a');
    disk.record = null;
    const app = boot(disk);
    expect(app.authority.restore()).toMatchObject({ signedOut: true });
    expect(disk.config.authToken).toBeUndefined();
    expect(disk.config.userInfo).toBeUndefined();
  });
});

describe('E2: token and user only through applySession with a current ticket', () => {
  it('no ticket, a forged or an old ticket: refused, nothing written', () => {
    const disk = createDisk();
    const app = boot(disk);
    const old = app.authority.ticket();
    app.authority.signOut();
    const log = disk.log.length;
    for (const ticket of [undefined, null, {}, { epoch: 999 }, old]) {
      expect(app.authority.applySession(ticket, { token: jwt('x'), user: { id: 'x' } }, { kind: 'login' }).applied).toBe(false);
    }
    expect(disk.log.length).toBe(log);
    expect(app.authority.getToken()).toBeNull();
  });
});

describe('E3: compare-and-set, serialized in main', () => {
  it('applySession is synchronous (nothing runs between compare and write)', () => {
    const app = boot(createDisk());
    const result = app.authority.applySession(app.authority.ticket(), { token: jwt('a'), user: { id: 'a' } }, { kind: 'login' });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.applied).toBe(true);
  });

  it('a password answer A after SSO B: B stays', async () => {
    const disk = createDisk();
    const app = boot(disk);
    const passwordA = app.passwordSignIn('a');
    const flow = app.beginSso();
    expect((await app.handleCallback(legacy(flow.state, 'b'))).delivered).toMatchObject({ applied: true });
    expect(passwordA.apply()).toEqual({ applied: false, reason: 'session_changed' });
    expect(app.authority.restore()).toMatchObject({ user: { id: 'b' }, token: jwt('b', 'sso') });
    expect(boot(disk).authority.restore()).toMatchObject({ user: { id: 'b' } });
  });

  it('an SSO result while a session exists is dropped without side effects', async () => {
    const disk = createDisk();
    const app = boot(disk);
    const flow = app.beginSso();
    app.passwordSignIn('a').apply();
    const log = disk.log.length;
    expect((await app.handleCallback(legacy(flow.state, 'b'))).ignored).toBe('already_signed_in');
    expect(disk.log.length).toBe(log);
    expect(app.authority.restore()).toMatchObject({ user: { id: 'a' } });
  });

  it('a refresh of another user is dropped; the same user in the same epoch applies', () => {
    const disk = createDisk();
    const app = signedIn(disk, 'a');
    const ticket = app.authority.ticket({ userId: 'a' });
    expect(app.authority.applySession(ticket, { token: jwt('b', 'r') }, { kind: 'refresh' })).toEqual({ applied: false, reason: 'user_mismatch' });
    expect(app.authority.getToken()).toBe(jwt('a', 'pw'));
    expect(app.authority.applySession(ticket, { token: jwt('a', 'r') }, { kind: 'refresh' })).toMatchObject({ applied: true });
    expect(app.authority.getToken()).toBe(jwt('a', 'r'));
  });
});

describe('E4: every session change moves the epoch and drops flow and buffer', () => {
  it('a stored flow of an old epoch is refused after a restart', async () => {
    const disk = createDisk();
    const app = boot(disk);
    const flow = app.beginSso();
    disk.failDelete = new Set(['ssoPendingFlow']); // the flow cannot be removed
    app.passwordSignIn('pw').apply();
    app.authority.signOut();
    expect(disk.config.ssoPendingFlow).toBeTruthy();
    const restarted = boot(disk);
    const res = await restarted.handleCallback(legacy(flow.state, 'sso'));
    expect(res.ignored).toBe('stale_flow');
    expect(restarted.authority.getToken()).toBeNull();
  });

  it('a sign-in drops a buffered SSO result', async () => {
    const disk = createDisk();
    const app = boot(disk);
    const flow = app.beginSso();
    await app.handleCallback(callback(`state=${flow.state}&error=x&code=sso_failed`));
    app.passwordSignIn('pw').apply();
    expect(app.authority.takePending()).toBeNull();
  });
});

describe('E5: sign-out order and outcome', () => {
  it('tombstone first (read back), then requests aborted, then deletes', () => {
    const disk = createDisk();
    const app = signedIn(disk, 'a');
    disk.log.length = 0;
    expect(app.authority.signOut()).toMatchObject({ success: true });
    expect(disk.log[0]).toMatch(/^record\.write:.*"signedOut":true/);
    expect(disk.log.slice(1)).toEqual(expect.arrayContaining(['config.delete:authToken', 'config.delete:userInfo']));
    expect(app.counters.aborted).toBe(1);
  });

  it('record not writable and deletes failing: reported, RAM lock holds', () => {
    const disk = createDisk();
    const app = signedIn(disk, 'a');
    disk.failRecordWrite = true;
    disk.failDelete = new Set(['authToken']);
    expect(app.authority.signOut()).toEqual({ success: false, epoch: expect.any(Number), error: 'sign_out_incomplete' });
    expect(app.authority.getToken()).toBeNull();
    expect(app.authority.getUser()).toBeNull();
  });
});

describe('E6: the tombstone wins', () => {
  it('restart with tombstone and a token on disk: nothing restored, no request', async () => {
    const disk = createDisk();
    disk.queue = [{ recordId: 'r1', filePath: '/r1', userId: 'a', retryCount: 0 }];
    const app = signedIn(disk, 'a');
    disk.failDelete = new Set(['authToken']);
    app.authority.signOut();
    const restarted = boot(disk);
    expect(disk.config.authToken).toBeTruthy();
    expect(restarted.authority.restore()).toMatchObject({ signedOut: true });
    expect(restarted.authority.getToken()).toBeNull();
    await restarted.processPendingUploads();
    expect(restarted.requests).toEqual([]);
    expect(disk.queue).toHaveLength(1);
  });
});

describe('E8: no write failure counts as success', () => {
  it('record not writable at sign-in: the session lives in memory, the next start is signed out', () => {
    const disk = createDisk();
    const app = boot(disk);
    disk.failRecordWrite = true;
    expect(app.passwordSignIn('a').apply()).toMatchObject({ applied: true, persisted: false });
    expect(app.authority.getToken()).toBe(jwt('a', 'pw'));
    expect(disk.config.authToken).toBeUndefined();
    disk.failRecordWrite = false;
    const restarted = boot(disk);
    expect(restarted.authority.restore()).toMatchObject({ signedOut: true });
    expect(restarted.authority.getToken()).toBeNull();
  });

  it('a flow consumed without a confirmed delete is refused and never accepted again', async () => {
    const disk = createDisk();
    const app = boot(disk);
    const flow = app.beginSso();
    disk.failDelete = new Set(['ssoPendingFlow']);
    expect((await app.handleCallback(legacy(flow.state, 'sso'))).ignored).toBe('flow_not_cleared');
    disk.failDelete = new Set();
    expect((await app.handleCallback(legacy(flow.state, 'sso'))).ignored).toBe('stale_flow');
    expect((await boot(disk).handleCallback(legacy(flow.state, 'sso'))).ignored).toBeTruthy();
    expect(app.authority.getToken()).toBeNull();
  });
});

describe('R1: desktop - an open flow and a callback without state', () => {
  it('no session, the flow keeps waiting, nothing delivered, sso_missing_state counted', async () => {
    const disk = createDisk();
    const app = boot(disk);
    const flow = app.beginSso();
    for (const url of [legacy('', 'evil'), callback('auth_code=c'), callback('error=access_denied'), callback('code=sso_cancelled')]) {
      expect((await app.handleCallback(url)).ignored).toBe('missing_state');
    }
    expect(app.counters.missingState).toBe(4);
    expect(app.delivered).toEqual([]);
    expect(app.authority.getToken()).toBeNull();
    expect(app.flows.hasPending(app.authority.state().epoch)).toBe(true);
    // Without an open flow nothing is counted.
    expect((await boot(createDisk()).handleCallback(legacy('', 'evil'))).ignored).toBe('no_pending_flow');
    // The real result still completes.
    expect((await app.handleCallback(legacy(flow.state, 'u1'))).delivered).toMatchObject({ applied: true });
  });
});

describe('SSO user of a result (main)', () => {
  it('a user that is not the token\'s user is refused; only plain fields are kept', () => {
    expect(ssoFlow.sanitizeSsoUser({ id: 'other' }, jwt('u1'))).toBeNull();
    expect(ssoFlow.sanitizeSsoUser({ id: 'u1', email: 'a@b.ch', isAdmin: true, nested: { x: 1 } }, jwt('u1'))).toEqual({ id: 'u1', email: 'a@b.ch' });
  });

  it('a callback whose user does not match its token signs nothing in', async () => {
    const app = boot(createDisk());
    const flow = app.beginSso();
    const url = callback(`state=${flow.state}&token=${jwt('u1')}&user=${userB64({ id: 'evil' })}`);
    expect((await app.handleCallback(url)).delivered).toMatchObject({ error: 'invalid_callback' });
    expect(app.authority.getToken()).toBeNull();
  });
});
