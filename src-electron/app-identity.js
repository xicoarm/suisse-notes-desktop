/**
 * Pins the app's MACHINE identity to the original "Suisse Notes" name while
 * the DISPLAY identity (productName, window title, installer, shortcuts,
 * tray) says "Suisse Meets".
 *
 * Why this exists — Electron silently derives two invisible-but-critical
 * things from the app name:
 *
 *   1. userData / sessionData:  <appData>/<name> — recordings, the stored
 *      auth session, recording history, upload queue, and crash-recovery
 *      state all live there. A renamed app reads an EMPTY new directory.
 *   2. macOS safeStorage: the encryption key sits in the login Keychain
 *      under the service "<app name> Safe Storage". A renamed app looks up
 *      a service that doesn't exist, mints a fresh key, and every stored
 *      auth token becomes undecryptable → the entire macOS fleet is force
 *      logged out once and queued/recovered uploads stall until re-login.
 *
 * Pinning the internal name keeps both stable forever. Users only ever see
 * the display name. This deliberately REPLACES the earlier migration
 * approach (move %APPDATA%\Suisse Notes → %APPDATA%\Suisse Meets on first
 * launch): the migration could never fix the Keychain half, and moving a
 * directory that may hold an in-flight recording is risk with no user-visible
 * upside. The folder name in %APPDATA% is a machine identifier, like the
 * appId and the suissenotes:// scheme — it must NEVER be "fixed".
 *
 * MUST run before ANYTHING touches userData or safeStorage (Sentry/crashpad,
 * electron-store, electron-log, the single-instance lock) — synchronous, at
 * module top of electron-main.js.
 */
'use strict';

const path = require('path');

// Identifier, not a display string — never rebrand this value.
const INTERNAL_APP_NAME = 'Suisse Notes';

/**
 * Pure path decision, unit-testable without Electron:
 * an explicit test dir (E2E isolation) always wins; otherwise the pinned
 * <appData>/Suisse Notes.
 */
function resolveUserDataDir({ appDataDir, testUserDataDir }) {
  if (testUserDataDir) return testUserDataDir;
  return path.join(appDataDir, INTERNAL_APP_NAME);
}

/**
 * Apply the pin to a (real or fake) Electron `app`. Returns the pinned dir.
 * `env` is injectable for tests.
 */
function pinAppIdentity(app, env = process.env) {
  // app.name feeds the macOS safeStorage Keychain service name
  // ("<name> Safe Storage") and default path derivation. Set it BEFORE the
  // paths so nothing re-derives from the display name in between.
  app.setName(INTERNAL_APP_NAME);

  const dir = resolveUserDataDir({
    appDataDir: app.getPath('appData'),
    testUserDataDir: env.SUISSE_TEST_USERDATA,
  });

  app.setPath('userData', dir);
  // sessionData (Chromium profile: Local Storage, IndexedDB) follows userData
  // by default, but pin it explicitly so renderer storage can never split off.
  try {
    app.setPath('sessionData', dir);
  } catch {
    /* pre-22 Electron: sessionData IS userData */
  }
  return dir;
}

module.exports = { pinAppIdentity, resolveUserDataDir, INTERNAL_APP_NAME };
