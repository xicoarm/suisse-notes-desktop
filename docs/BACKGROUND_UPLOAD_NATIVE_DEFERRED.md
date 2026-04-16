# Deferred: Native Background Upload Pipeline (Mobile)

**Status:** Deferred — surfaced during the mobile audit on 2026-04-16, explicitly
paused after the non-native polish work was preferred. Revisit when (a) users
start reporting that uploads die on screen-lock / app-swipe / reboot, or (b)
we decide to invest in a single big mobile-reliability push.

**Scope:** Mobile only (Capacitor — iOS + Android). Desktop (Electron) is
unaffected; it has its own IPC-based upload in the main process which already
survives backgrounding.

---

## The problem

The current mobile upload flow in `src/services/upload.js`
(`uploadFileMobileSimple`) is a plain `XMLHttpRequest` + `FormData` running
inside the Capacitor webview. Both iOS and Android aggressively suspend the
webview as soon as the app stops being the foreground task:

- **iOS**: webview suspended ~30 s after the app goes to background, ~instant
  if the screen locks. An in-flight XHR effectively freezes at that point;
  when the app returns to foreground the XHR may or may not resume depending
  on network timing and the socket's state. In practice: a 100 MB upload at
  60 % completion routinely dies when the user locks the screen.
- **Android**: while the app is foregrounded OR the existing
  `ForegroundRecordingService` is active (only during recording itself) the
  webview stays alive. Once recording stops and the user backgrounds the app,
  Doze / App Standby can kill or throttle the upload. On a low-RAM device the
  OS can reclaim the webview process entirely between upload retries.

Recording has native backing (`BackgroundRecordingPlugin.swift` /
`BackgroundRecordingService` + foreground-service-type=microphone on Android)
so it survives backgrounding — upload does not.

---

## Why a patch doesn't fix it

Keeping the upload in JS and "just making it wait longer" is not a solution on
either platform. The only way the OS will keep an upload running while the app
is backgrounded or killed is if the upload is registered with the OS itself:

- **iOS**: `URLSession` configured with
  `URLSessionConfiguration.background(withIdentifier:)`. The OS manages the
  socket; the app can be killed and relaunched with the upload still making
  progress. Completion / progress / failure are delivered via
  `URLSessionDelegate` methods and the app delegate hook
  `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
- **Android**: `WorkManager` with a `CoroutineWorker` that performs the upload
  (e.g. via OkHttp). WorkManager survives Doze (subject to its constraints),
  process death, and device reboot. Alternatively, extending the existing
  `ForegroundRecordingService` with a second
  `foregroundServiceType="dataSync"` responsibility keeps the upload alive
  while a foreground-service notification is visible.

Both approaches move the actual HTTP request OUT of the JS/webview layer and
INTO native code. That's why this is framed as a rewrite rather than a patch.

---

## What changes

### iOS

- **New Capacitor plugin** (Swift) exposing `uploadFile({ filePath, url, headers, metadata })`.
- Internally uses `URLSession` with `.background(withIdentifier: "ch.suissenotes.mobile.upload")`, creates a `uploadTask(with:fromFile:)` for the audio file.
- `URLSessionDataDelegate` methods:
  - `urlSession(_:task:didSendBodyData:totalBytesSent:totalBytesExpectedToSend:)` — forward to JS as a progress event.
  - `urlSession(_:task:didCompleteWithError:)` — forward success/error to JS.
  - `urlSessionDidFinishEvents(forBackgroundURLSession:)` — call the saved completion handler so iOS knows we're done.
- `AppDelegate.swift` needs to implement `application(_:handleEventsForBackgroundURLSession:completionHandler:)` and save the completion handler for the plugin to call.
- **App Groups entitlement** — required so the native side can read the audio file the JS side wrote. See audit finding A2 (`App.entitlements` is currently missing entirely); this dovetails with that work.
- Shared container (`group.ch.suissenotes.mobile`) used as the staging directory — JS writes files there, native reads from there. Audio files currently go to `Directory.Documents` which is not in any App Group; they'd move to the shared container or be symlinked.

### Android

- **New Capacitor plugin method** that enqueues a one-time `WorkManager` job with the upload parameters, or an extension of the existing `BackgroundRecordingPlugin`.
- **Kotlin `UploadWorker`** (`CoroutineWorker`) that:
  - Reads the file from app-private storage (paired with audit finding A5 — move recordings to `getExternalFilesDir()`).
  - Performs the HTTP request using OkHttp.
  - Emits progress notifications through a `NotificationChannel`.
  - Persists result (success / error) to `SharedPreferences` or a Room DB so JS can pick it up on next foreground.
- Foreground service notification during upload (required by Android 14+ for long-running background work on recent API levels).
- `AndroidManifest.xml` needs a new service entry (or add `foregroundServiceType="dataSync|microphone"` to the existing service) and WorkManager auto-init is already implicit with `androidx.work` dep.
- Battery-optimization exemption prompt at first upload — wires up the `isBatteryOptimized()` / `requestBatteryOptimizationExemption()` helpers that already exist in `BackgroundRecordingPlugin.kt` but are currently unused.

### JS layer

- `src/services/upload.js` gains a native-mobile branch: instead of `XMLHttpRequest`, it calls the new Capacitor plugin.
- Progress / status events flow native → JS via Capacitor's event bus instead of being computed in the XHR `progress` handler.
- Cancel becomes "tell native to cancel session X" instead of `xhr.abort()`.
- The persistent queue in localStorage / `@capacitor/preferences` either (a) stays in JS and the native side is told one job at a time, or (b) moves to the shared container so the native worker can operate without JS being alive. Option (b) is cleaner for reboot-survival; option (a) is simpler for the MVP.
- The error classification (`_isRetryableError`) added in Batch 2 applies to the native-returned error, so keep it.
- The FIFO sort added in Batch 2 still applies, but the queue processor becomes a queue-dispatcher that hands jobs to native one at a time.

---

## Files involved (inventory)

- `src/services/upload.js` — `uploadFileMobileSimple`, `processMobileUploadQueue`, `cancelUpload` all need a native-mobile branch.
- `src/components/UploadProgress.vue` — progress event source changes from XHR-event to plugin-event.
- `src/components/RecordingHistoryCard.vue` — cancel handler changes (Batch 2 already wired `cancelUpload({ removeFromQueue: true })`, that stays).
- `src-capacitor/ios/App/App/Plugins/` — new `BackgroundUploadPlugin.swift`.
- `src-capacitor/ios/App/App/AppDelegate.swift` — add background URL session handler.
- `src-capacitor/ios/App/App/Info.plist` — `UIBackgroundModes` should include `processing` and `fetch` (audit finding, already flagged).
- `src-capacitor/ios/App/App/App.entitlements` — create if missing (audit finding A2), add App Groups.
- `src-capacitor/android/app/src/main/java/**` — new `UploadWorker.kt` and plugin wiring; possibly extend `BackgroundRecordingPlugin.kt`.
- `src-capacitor/android/app/src/main/AndroidManifest.xml` — service entry or `foregroundServiceType` addition; no new permissions needed (INTERNET + FOREGROUND_SERVICE + POST_NOTIFICATIONS already present).
- `package.json` — add `androidx.work:work-runtime-ktx` via Gradle; iOS side is SPM-only with Foundation (no new dep).

---

## Effort estimate

Rough, from someone familiar with the codebase:

- iOS plugin (Swift, delegate wiring, App Group entitlement): **1-2 days**
- Android worker (Kotlin, notification, WorkManager wiring, state persistence): **1-2 days**
- JS plumbing (plugin branch in upload.js, event bus, state sync): **0.5-1 day**
- QA: real-device matrix (low-RAM Android, iOS 17/18, screen-lock / app-kill / reboot / airplane-mode-toggle / backgrounded-for-hours): **1-2 days**
- Release risk: **elevated** — touches two live platforms, native code not reviewable by running the existing JS test suite, no local device build toolchain in CI for iOS native.

Total: **4-7 days of focused work** for the full native rewrite.

---

## Lighter alternative (if full rewrite is too expensive)

Keep the upload in JS but give the webview a short runway when the app goes to background:

- **iOS**: use `BGTaskScheduler` with `BGProcessingTaskRequest` to request
  ~30 seconds of background execution when the app backgrounds. Not
  reboot-survival, but fixes "locked the screen for 30 s mid-upload" — which
  is the most common complaint.
- **Android**: extend the existing `ForegroundRecordingService` to also hold
  a wakelock and keep the webview alive while an upload notification is
  showing. No WorkManager, no process-death survival, but covers the common
  "user swiped to home screen" case.

Effort: **1-2 days** instead of 4-7. Buys maybe 60-70 % of the user value of
the full rewrite. Upload still dies on force-kill / reboot / multi-hour
backgrounding. Decide whether that matters for the product.

---

## Decision points to revisit

1. **Is full reboot-survival a requirement, or is "screen-lock survival" enough?** Answering this picks between the lighter alternative and the full rewrite.
2. **One-at-a-time dispatch vs native-owned queue?** The latter is cleaner but doubles the state-sync complexity; the former is simpler and acceptable if we're OK with the JS process needing to be alive to kick off the next job.
3. **Keep `tus-js-client` for resumable chunked uploads in JS, or move to native multipart?** TUS has partial-upload resume built in; URLSession / OkHttp handle resume differently. If the backend is actually serving TUS, keeping it in JS (even if we lose full background support) may be simpler than implementing TUS-over-native.
4. **Android storage migration.** Moving recordings from `Directory.Documents` (public, backed up) to `getExternalFilesDir()` (app-private) requires a one-time migration for existing users' files. Unrelated to background upload technically, but this work touches the same AndroidManifest and storage paths, so bundling makes sense.

---

## Related audit findings (cross-reference)

From the mobile audit report:

- **B4.1** — no URLSession background config on iOS (this doc's main subject)
- **B4.2** — no WorkManager / foreground-service for uploads on Android (this doc's main subject)
- **B4.3** — auto-sync 20s polling is a foreground timer
- **B4.4** — iOS `UIBackgroundModes` missing `processing` and `fetch`
- **B4.5** — Android battery-optimization exemption never requested
- **A2** — iOS entitlements file missing (blocker for App Groups)
- **A5** — Android recordings in public Documents (needs to move to app-private for clean native read)
- **F3** — Android battery-optimization prompt

Batches 1 and 2 (committed 2026-04-16) deliberately did NOT touch these; they
were scoped to protocol hardening + upload-queue consistency in the JS layer.
