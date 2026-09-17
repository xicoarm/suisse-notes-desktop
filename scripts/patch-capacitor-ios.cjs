'use strict';

// Re-apply the two iOS wirings that `npx cap sync` overwrites.
//
// The Capacitor CLI regenerates `CapApp-SPM/Package.swift` and
// `App/capacitor.config.json` on every sync, including the sync the release
// workflow runs before it builds. Without this step the build silently loses:
//
//   1. the BackgroundRecordingPlugin registration (recording stops working);
//   2. the sentry-cocoa package (native crashes, app hangs and watchdog
//      terminations stop being reported — the app cannot report its own death
//      from JavaScript).
//
// The Sentry plugin for Capacitor cannot be used instead: it requires
// capacitor-swift-pm 7 while this app pins 6.2.1.
//
// Both patches are idempotent, and `npm run cap:sync` runs this file.

const fs = require('fs');
const path = require('path');

const SENTRY_PACKAGE = '.package(url: "https://github.com/getsentry/sentry-cocoa", from: "8.56.2"),';
const SENTRY_PRODUCT = '.product(name: "Sentry", package: "sentry-cocoa"),';

function patchPackageSwift(file) {
  if (!fs.existsSync(file)) return { file, changed: false, reason: 'missing' };
  const original = fs.readFileSync(file, 'utf8');
  let updated = original;

  if (!updated.includes('getsentry/sentry-cocoa')) {
    const anchor = /(\n\s*)(\.package\(url: "https:\/\/github\.com\/ionic-team\/capacitor-swift-pm\.git")/;
    if (!anchor.test(updated)) throw new Error('Package.swift has no capacitor-swift-pm dependency to anchor on');
    updated = updated.replace(anchor, (match, indent, rest) =>
      `${indent}// Native crash, app-hang and out-of-memory reporting; re-applied by` +
      `${indent}// scripts/patch-capacitor-ios.cjs after every Capacitor sync.` +
      `${indent}${SENTRY_PACKAGE}${indent}${rest}`);
  }

  if (!updated.includes(SENTRY_PRODUCT)) {
    const anchor = /(\n\s*)(\.product\(name: "Capacitor", package: "capacitor-swift-pm"\),)/;
    if (!anchor.test(updated)) throw new Error('Package.swift has no Capacitor product to anchor on');
    updated = updated.replace(anchor, (match, indent, rest) => `${indent}${SENTRY_PRODUCT}${indent}${rest}`);
  }

  if (updated === original) return { file, changed: false, reason: 'already patched' };
  fs.writeFileSync(file, updated);
  return { file, changed: true, reason: 'sentry-cocoa re-added' };
}

function patchCapacitorConfig(file) {
  if (!fs.existsSync(file)) return { file, changed: false, reason: 'missing' };
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(config.packageClassList)) config.packageClassList = [];
  if (config.packageClassList.includes('BackgroundRecordingPlugin')) return { file, changed: false, reason: 'already patched' };
  config.packageClassList.push('BackgroundRecordingPlugin');
  fs.writeFileSync(file, JSON.stringify(config, null, '\t'));
  return { file, changed: true, reason: 'BackgroundRecordingPlugin re-registered' };
}

function patchIosProject(root = path.resolve(__dirname, '..', 'src-capacitor')) {
  return [
    patchCapacitorConfig(path.join(root, 'ios', 'App', 'App', 'capacitor.config.json')),
    patchPackageSwift(path.join(root, 'ios', 'App', 'CapApp-SPM', 'Package.swift')),
  ];
}

if (require.main === module) {
  for (const result of patchIosProject()) {
    console.log(`${path.basename(result.file)}: ${result.reason}`);
  }
}

module.exports = { patchIosProject, patchPackageSwift, patchCapacitorConfig, SENTRY_PACKAGE, SENTRY_PRODUCT };
