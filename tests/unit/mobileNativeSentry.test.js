// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// The mobile app reports its JavaScript errors itself, but a process that dies
// — a native crash, an ANR, a watchdog or out-of-memory kill during a long
// meeting — can only be reported by a native SDK that started before it. These
// checks guard that wiring, including the iOS package entry, which sits in a
// file the Capacitor CLI regenerates.
const manifest = fs.readFileSync('src-capacitor/android/app/src/main/AndroidManifest.xml', 'utf8');
const gradle = fs.readFileSync('src-capacitor/android/app/build.gradle', 'utf8');
const packageSwift = fs.readFileSync('src-capacitor/ios/App/CapApp-SPM/Package.swift', 'utf8');
const appDelegate = fs.readFileSync('src-capacitor/ios/App/App/AppDelegate.swift', 'utf8');

const MOBILE_DSN = 'https://f5f1d2b53d297a64e9b76ca26d2d8397@o4510659364716544.ingest.de.sentry.io/4510958727462992';

describe('Android native crash reporting', () => {
  it('ships the SDK and starts it from the manifest', () => {
    expect(gradle).toMatch(/implementation ["']io\.sentry:sentry-android:\d+\.\d+\.\d+["']/);
    expect(manifest).toContain(`android:name="io.sentry.dsn" android:value="${MOBILE_DSN}"`);
  });

  it('files native crashes under the same release as the WebView layer', () => {
    expect(gradle).toContain('sentryRelease: "ch.suissenotes.mobile@" + versionName');
    expect(gradle).toContain('sentryDist: versionCode.toString()');
    expect(manifest).toContain('android:name="io.sentry.release" android:value="${sentryRelease}"');
    expect(manifest).toContain('android:name="io.sentry.dist" android:value="${sentryDist}"');
  });

  it('reports application-not-responding but leaves sessions to the WebView layer', () => {
    expect(manifest).toContain('android:name="io.sentry.anr.enable" android:value="true"');
    expect(manifest).toContain('android:name="io.sentry.auto-session-tracking.enable" android:value="false"');
  });

  it('never attaches screenshots, view hierarchies or personal data', () => {
    expect(manifest).toContain('android:name="io.sentry.attach-screenshot" android:value="false"');
    expect(manifest).toContain('android:name="io.sentry.attach-view-hierarchy" android:value="false"');
    expect(manifest).toContain('android:name="io.sentry.send-default-pii" android:value="false"');
  });
});

describe('iOS native crash reporting', () => {
  it('keeps the sentry-cocoa package in the app package graph', () => {
    // The Capacitor CLI regenerates this file; this test is what notices.
    expect(packageSwift).toMatch(/\.package\(url: "https:\/\/github\.com\/getsentry\/sentry-cocoa", from: "\d+\.\d+\.\d+"\)/);
    expect(packageSwift).toContain('.product(name: "Sentry", package: "sentry-cocoa")');
  });

  it('starts before the WebView, with the same release name and no screen content', () => {
    expect(appDelegate).toContain('startCrashReporting()');
    expect(appDelegate).toContain('#if canImport(Sentry)');
    expect(appDelegate).toContain(`options.dsn = "${MOBILE_DSN}"`);
    expect(appDelegate).toContain('options.releaseName = "ch.suissenotes.mobile@\\(version)"');
    expect(appDelegate).toContain('options.enableAutoSessionTracking = false');
    expect(appDelegate).toContain('options.enableAppHangTracking = true');
    expect(appDelegate).toContain('options.enableWatchdogTerminationTracking = true');
    expect(appDelegate).toContain('options.attachScreenshot = false');
    expect(appDelegate).toContain('options.attachViewHierarchy = false');
    expect(appDelegate).toContain('options.sendDefaultPii = false');
  });
});

describe('the iOS wiring survives a Capacitor sync', () => {
  const os = require('node:os');
  const path = require('node:path');
  const { patchIosProject } = require('../../scripts/patch-capacitor-ios.cjs');
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  // The release workflow runs `npm run cap:sync` before it builds, and the CLI
  // regenerates both files — so the patch has to run there, not only here.
  it('is applied by the cap:sync script', () => {
    expect(packageJson.scripts['cap:sync']).toContain('scripts/patch-capacitor-ios.cjs');
  });

  it('re-adds the package and the plugin registration a regeneration removed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-sync-'));
    const spm = path.join(root, 'ios', 'App', 'CapApp-SPM');
    const app = path.join(root, 'ios', 'App', 'App');
    fs.mkdirSync(spm, { recursive: true });
    fs.mkdirSync(app, { recursive: true });
    // Exactly what the Capacitor CLI writes: no Sentry, no custom plugin.
    fs.writeFileSync(path.join(spm, 'Package.swift'), [
      'let package = Package(',
      '    dependencies: [',
      '        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "6.2.1"),',
      '        .package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app")',
      '    ],',
      '    targets: [',
      '        .target(',
      '            dependencies: [',
      '                .product(name: "Capacitor", package: "capacitor-swift-pm"),',
      '                .product(name: "Cordova", package: "capacitor-swift-pm")',
      '            ]',
      '        )',
      '    ]',
      ')',
    ].join('\n'));
    fs.writeFileSync(path.join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'ch.suissenotes.app' }, null, '\t'));

    const first = patchIosProject(root);
    const patched = fs.readFileSync(path.join(spm, 'Package.swift'), 'utf8');
    expect(patched).toContain('getsentry/sentry-cocoa');
    expect(patched).toContain('.product(name: "Sentry", package: "sentry-cocoa")');
    expect(JSON.parse(fs.readFileSync(path.join(app, 'capacitor.config.json'), 'utf8')).packageClassList)
      .toContain('BackgroundRecordingPlugin');
    expect(first.every(result => result.changed)).toBe(true);

    // Running it again changes nothing (the sync script runs on every build).
    const second = patchIosProject(root);
    expect(second.every(result => result.changed)).toBe(false);
    expect(fs.readFileSync(path.join(spm, 'Package.swift'), 'utf8')).toBe(patched);
  });
});

describe('native failures that reach the app layer', () => {
  const service = fs.readFileSync('src-capacitor/android/app/src/main/java/ch/suissenotes/app/ForegroundRecordingService.kt', 'utf8');
  const androidPlugin = fs.readFileSync('src-capacitor/android/app/src/main/java/ch/suissenotes/app/BackgroundRecordingPlugin.kt', 'utf8');
  const iosPlugin = fs.readFileSync('src-capacitor/ios/App/App/Plugins/BackgroundRecordingPlugin.swift', 'utf8');

  it('broadcasts recording failures instead of only writing them to Logcat', () => {
    for (const stage of ['"start"', '"resume"', '"pause"', '"stop"', '"chunk"']) {
      expect(service).toContain(`broadcastFailure(${stage}`);
    }
    expect(androidPlugin).toContain('notifyListeners("nativeFailure", data)');
  });

  it('counts chunks the combiner cannot read on both platforms', () => {
    expect(androidPlugin).toContain('put("skippedChunkCount", skippedChunks.size)');
    expect(androidPlugin).toContain('put("expectedChunkCount", chunkFiles.size)');
    expect(iosPlugin).toContain('"skippedChunkCount": skippedChunks.count');
    expect(iosPlugin).toContain('"expectedChunkCount": chunkFiles.count');
  });

  it('gives the app an error code for a failed combine', () => {
    expect(androidPlugin).toContain('"COMBINE_FAILED"');
    expect(androidPlugin).toContain('"COMBINE_NO_READABLE_CHUNKS"');
    expect(iosPlugin).toContain('"COMBINE_EXPORT_FAILED"');
    expect(iosPlugin).toContain('"COMBINE_NO_READABLE_CHUNKS"');
  });

  it('reports an iOS audio session that cannot be reactivated and a background time that ends', () => {
    expect(iosPlugin).toContain('"stage": "resume"');
    expect(iosPlugin).toContain('"stage": "background-expiry"');
  });

  it('reports skipped chunks from the store so the failure leaves the phone', () => {
    const store = fs.readFileSync('src/stores/recording.js', 'utf8');
    expect(store).toContain('Native combine skipped');
    expect(store).toContain('skippedChunkCount,');
  });
});
