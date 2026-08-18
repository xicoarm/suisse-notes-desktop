import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  pinAppIdentity,
  resolveUserDataDir,
  INTERNAL_APP_NAME,
} = require('../../src-electron/app-identity.js');

// ---------------------------------------------------------------------------
// The rebrand ships a new DISPLAY name (productName "Suisse Meets") but the
// MACHINE identity must stay "Suisse Notes": Electron derives the userData
// directory and the macOS safeStorage Keychain service ("<name> Safe
// Storage") from app.name. If either ever changes, existing installs read an
// empty profile (recordings/history/session gone from the app's view) and
// every macOS user is force logged out. These tests pin that contract.
// ---------------------------------------------------------------------------

function fakeApp({ appDataDir = 'C:\\Users\\u\\AppData\\Roaming', sessionDataThrows = false, isPackaged = false } = {}) {
  const calls = { setName: [], setPath: [] };
  return {
    calls,
    isPackaged,
    setName(n) { calls.setName.push(n); },
    getPath(key) {
      if (key === 'appData') return appDataDir;
      throw new Error(`unexpected getPath(${key})`);
    },
    setPath(key, value) {
      if (key === 'sessionData' && sessionDataThrows) throw new Error('unsupported');
      calls.setPath.push([key, value]);
    },
  };
}

describe('app-identity: machine identity survives the rebrand', () => {
  it('the internal name is the ORIGINAL brand and must never change', () => {
    // This is the value the whole contract hangs on. If someone "fixes" it
    // during a future cleanup, this test is the tripwire.
    expect(INTERNAL_APP_NAME).toBe('Suisse Notes');
  });

  it('resolves userData to <appData>/Suisse Notes (the pre-rebrand location)', () => {
    const dir = resolveUserDataDir({ appDataDir: '/Users/u/Library/Application Support' });
    expect(dir).toBe(path.join('/Users/u/Library/Application Support', 'Suisse Notes'));
  });

  it('an explicit E2E test dir always wins (harness isolation)', () => {
    const dir = resolveUserDataDir({
      appDataDir: '/appdata',
      testUserDataDir: '/tmp/e2e-profile',
    });
    expect(dir).toBe('/tmp/e2e-profile');
  });

  it('pinAppIdentity sets name FIRST, then userData and sessionData to the same dir', () => {
    const app = fakeApp();
    const dir = pinAppIdentity(app, {});
    expect(app.calls.setName).toEqual([INTERNAL_APP_NAME]);
    expect(dir).toBe(path.join('C:\\Users\\u\\AppData\\Roaming', INTERNAL_APP_NAME));
    expect(app.calls.setPath).toEqual([
      ['userData', dir],
      ['sessionData', dir],
    ]);
  });

  it('survives Electron versions where sessionData is not a settable path', () => {
    const app = fakeApp({ sessionDataThrows: true });
    const dir = pinAppIdentity(app, {});
    expect(app.calls.setPath).toEqual([['userData', dir]]);
  });

  it('honors SUISSE_TEST_USERDATA in unpackaged (dev/harness) runs', () => {
    const app = fakeApp({ isPackaged: false });
    const dir = pinAppIdentity(app, { SUISSE_TEST_USERDATA: 'X:\\e2e\\profile' });
    expect(dir).toBe('X:\\e2e\\profile');
    expect(app.calls.setPath[0]).toEqual(['userData', 'X:\\e2e\\profile']);
    // Name is still pinned even under test — safeStorage behavior must match prod.
    expect(app.calls.setName).toEqual([INTERNAL_APP_NAME]);
  });

  it('IGNORES SUISSE_TEST_USERDATA in a plain packaged launch (no E2E gate)', () => {
    const app = fakeApp({ isPackaged: true });
    const dir = pinAppIdentity(app, { SUISSE_TEST_USERDATA: 'X:\\evil\\redirect' });
    expect(dir).toBe(path.join('C:\\Users\\u\\AppData\\Roaming', INTERNAL_APP_NAME));
  });

  it('honors SUISSE_TEST_USERDATA in a packaged run WITH the E2E gate open', () => {
    const app = fakeApp({ isPackaged: true });
    const dir = pinAppIdentity(app, {
      SUISSE_TEST_USERDATA: 'X:\\e2e\\profile',
      SUISSE_E2E_HOOKS: '1',
    });
    expect(dir).toBe('X:\\e2e\\profile');
  });
});
