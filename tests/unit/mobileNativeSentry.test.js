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
