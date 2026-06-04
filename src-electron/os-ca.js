// Inject the operating-system trust store into Node's TLS so that outbound
// HTTPS from the Electron MAIN process (axios uploads, auto-update, Sentry)
// trusts corporate / self-signed roots that the OS already trusts.
//
// WHY: the main process runs on Node, which uses its own bundled Mozilla CA
// list and ignores the Windows/macOS system store. Behind a TLS-inspecting
// corporate proxy the re-signed certificate chains to a corporate root that
// Windows trusts (so Chromium / the renderer is fine) but Node does not — every
// upload then dies with "unable to verify the first certificate".
// See Sentry electron issue 0bbb3c7e (operation=upload-direct, release 4.1.2,
// user @collano.com — a corporate network doing TLS inspection).
//
// win-ca (Windows) patches tls.createSecureContext to add every root from the
// Windows store; mac-ca (macOS) adds the System/login keychain roots to the
// global HTTPS agent. Both keep Node's bundled roots ('+' / addToGlobalAgent),
// ship prebuilt (no native compile step), and no-op on the other platform.
//
// Defensive by design: any failure here must NEVER prevent app startup.
const log = require('electron-log');

function installOsTrustStore() {
  try {
    if (process.platform === 'win32') {
      // '+' = inject OS roots AND keep Node's bundled roots. Runs synchronously
      // (the default) so the trust store is in place before the first outbound
      // TLS handshake (auto-update check, upload, Sentry).
      // NOTE: win-ca shells out to a bundled roots.exe — it is unpacked from
      // app.asar via the `asarUnpack` entry in quasar.config.js.
      require('win-ca')({ inject: '+' });
      log.info('[os-ca] Windows trust store injected into Node TLS');
    } else if (process.platform === 'darwin') {
      require('mac-ca').addToGlobalAgent();
      log.info('[os-ca] macOS trust store added to global HTTPS agent');
    }
  } catch (err) {
    // Non-fatal: fall back to Node's bundled CA list. Users not behind a
    // TLS-inspecting proxy are unaffected; those who are will see the original
    // upload failure, which is no worse than before this change.
    log.warn('[os-ca] Failed to inject OS trust store (continuing with bundled CAs):', err?.message);
  }
}

module.exports = { installOsTrustStore };
