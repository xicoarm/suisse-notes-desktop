import { describe, it, expect, beforeEach, vi } from 'vitest';

// Native Preferences survive a crash of the app process; emulate them with a
// Map that outlives the module under test (a "relaunch" re-imports it).
const h = vi.hoisted(() => ({ prefs: new Map(), failPrefs: false }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    async get({ key }) { if (h.failPrefs) throw new Error('bridge down'); return { value: h.prefs.has(key) ? h.prefs.get(key) : null }; },
    async set({ key, value }) { if (h.failPrefs) throw new Error('bridge down'); h.prefs.set(key, value); }
  }
}));

async function launch() {
  vi.resetModules();
  return import('../../src/services/sessionHealth');
}

describe('sessionHealth — unclean exit detection', () => {
  beforeEach(() => {
    h.prefs.clear();
    h.failPrefs = false;
    localStorage.clear();
  });

  it('first launch reports nothing', async () => {
    const m = await launch();
    const report = vi.fn();
    expect(await m.startSessionHealth({ appVersion: '3.9.38', platform: 'android', report })).toBeNull();
    expect(report).not.toHaveBeenCalled();
    m._resetSessionHealthForTests();
  });

  it('a session killed while on screen is reported once on the next launch, with what it was doing', async () => {
    let m = await launch();
    await m.startSessionHealth({ appVersion: '3.9.38', platform: 'ios' });
    m.noteSessionActivity({ route: 'device', bleSync: true });
    await new Promise((r) => setTimeout(r, 1100)); // debounced save
    m._resetSessionHealthForTests(); // process dies here — no background transition

    m = await launch();
    const report = vi.fn();
    const verdict = await m.startSessionHealth({ appVersion: '3.9.38', platform: 'ios', report });
    expect(report).toHaveBeenCalledTimes(1);
    expect(verdict).toMatchObject({ appVersion: '3.9.38', platform: 'ios', route: 'device', bleSync: true, recording: false });
    await m.markSessionState(false);
    m._resetSessionHealthForTests();

    // The session after that left the screen normally → nothing to report.
    m = await launch();
    const again = vi.fn();
    expect(await m.startSessionHealth({ appVersion: '3.9.38', platform: 'ios', report: again })).toBeNull();
    expect(again).not.toHaveBeenCalled();
    m._resetSessionHealthForTests();
  });

  it('leaving the screen (home, app switcher, lock) is not an unclean exit', async () => {
    let m = await launch();
    await m.startSessionHealth({ appVersion: '3.9.38', platform: 'android' });
    await m.markSessionState(false);
    m._resetSessionHealthForTests(); // OS kills the app in the background
    m = await launch();
    expect(await m.startSessionHealth({ appVersion: '3.9.38', platform: 'android' })).toBeNull();
    m._resetSessionHealthForTests();
  });

  it('a launch in the background does not arm the detector', async () => {
    let m = await launch();
    await m.startSessionHealth({ appVersion: '3.9.38', platform: 'ios', isActive: false });
    m._resetSessionHealthForTests();
    m = await launch();
    expect(await m.startSessionHealth({ appVersion: '3.9.38', platform: 'ios' })).toBeNull();
    m._resetSessionHealthForTests();
  });

  it('falls back to localStorage when the Preferences bridge fails', async () => {
    h.failPrefs = true;
    let m = await launch();
    await m.startSessionHealth({ appVersion: '3.9.38', platform: 'android' });
    m._resetSessionHealthForTests();
    m = await launch();
    const verdict = await m.startSessionHealth({ appVersion: '3.9.38', platform: 'android' });
    expect(verdict).toMatchObject({ platform: 'android' });
    m._resetSessionHealthForTests();
  });

  it('a throwing reporter never breaks the boot', async () => {
    let m = await launch();
    await m.startSessionHealth({ appVersion: '3.9.38', platform: 'ios' });
    m._resetSessionHealthForTests();
    m = await launch();
    await expect(m.startSessionHealth({ appVersion: '3.9.38', platform: 'ios', report: () => { throw new Error('sentry down'); } })).resolves.toBeTruthy();
    m._resetSessionHealthForTests();
  });
});
