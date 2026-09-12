# Mobile reliability & security audit — iOS / Android (September 2026)

Scope: the Suisse Meets mobile app (Capacitor, `ch.suissenotes.mobile` / `ch.suissenotes.app`),
release 3.9.36 as shipped on 2026-09-02. Method: full read of the mobile code paths
(recording, storage, upload, auth/SSO, BLE device sync, lifecycle, UI), the native
Android/iOS shells, the Capacitor plugin sources actually bundled, and the Sentry
`capacitor` project (90 days, ~100 issues, event trails of the top error groups).

Every finding below is either **fixed on branch `fix/mobile-reliability-audit`**
(mobile 3.9.37) or listed under *Open* with a concrete next step.

---

## 1. Findings that lose data or break a feature (fixed)

### 1.1 Android: chunks vanish from the recording folder → "Chunk integrity failure"
- **Sentry:** CAPACITOR-N0, 65 events / 29 users, **100 % Android**, all vendors (Pixel,
  Samsung, Xiaomi, Fairphone, OnePlus), releases 3.9.30–3.9.36. Gaps scattered through the
  middle of healthy recordings (e.g. `211 gap(s) … Found 2152/2363 chunks`); no chunk-save
  error ever logged in the trails.
- **Cause:** recordings lived in the public `Documents` folder (`Directory.Documents`). On
  Android 11+ that folder is served through MediaProvider's FUSE layer, whose directory
  listings come from the MediaStore database, not the disk. The tmp-write + rename + async
  media scan of every 3-second chunk left files on disk that `readdir` did not return. The
  stop-time validation saw gaps, refused to combine, the user got "Failed to process
  recording", and the meeting reappeared only after the next launch as a gappy "recovered"
  recording. Side effects: meeting audio readable by any file manager, left behind on
  uninstall, and Android ≤10 could not write there at all without a storage permission the
  app no longer declares.
- **Fix:** Android recordings and device files now live in `Directory.External`
  (`Android/data/<pkg>/files`, app-private, no MediaStore filter, no permission on any API
  level, removed on uninstall). iOS keeps its sandbox `Documents`. All reads resolve the
  primary directory first and fall back to the legacy location; a best-effort idempotent
  migration moves legacy data at startup (rename, else copy + verified delete). The native
  combiner picks whichever base directory holds the chunks.
  `src/services/storage.js`, `BackgroundRecordingPlugin.kt`, `ForegroundRecordingService.kt`.

### 1.2 Stop path hard-failed on any gap
- A single missing chunk at stop time turned into an error toast and a "failed" history
  entry, with the same audio surfacing later anyway. Now the file is combined from the
  chunks that exist, the user sees a persistent warning with the exact loss
  ("N of M segments missing"), and the history card keeps that marker (`captureWarning`).
  `src/stores/recording.js`, `RecordPage.vue`, `RecordingHistoryCard.vue`.

### 1.3 iOS: the whole lifecycle layer never started
- **Sentry trail** on 3.9.36: `Lifecycle: Failed to initialize Error: not implemented`.
- **Cause:** `StatusBar.setOverlaysWebView` is Android-only and rejects with `UNIMPLEMENTED`
  on iOS. It was the first call inside the one try/catch around the entire initializer, so on
  every iPhone none of these were registered: app-state listener (background flush of the
  recorder buffer, foreground recovery scan), network listener (upload-queue resume on
  reconnect), battery monitoring, `appUrlOpen` deep-link listener.
- **Fix:** each step runs in isolation; the overlay call is Android-only. `src/boot/lifecycle.js`.

### 1.4 Disk-space checks never worked on any phone
- `Filesystem.getFreeDiskSpace()` does not exist in `@capacitor/filesystem` 6. The code
  called it anyway, logged an error every 30 s during every recording, and reported the
  space as unknown — so the pre-recording check, the low-storage warning and the disk-full
  emergency stop were all inert.
- **Fix:** `@capacitor/device` `getInfo().realDiskFree` (Apple's
  `volumeAvailableCapacityForImportantUsage`, Android `StatFs`). Unknown stays warn-only.
  Storage messages are localized and no longer squeezed through the disk-error humanizer.

### 1.5 Two startup recovery scans raced each other
- `App.vue` awaited `checkRecoveryState()` while `initializeLifecycle()` scheduled a second
  scan 3 s later; both could combine the same orphaned recording while the chunk GC ran.
  Concurrent callers now share one in-flight run.

## 2. Security findings

| # | Finding | Status |
|---|---|---|
| 2.1 | **Session JWT sent to Sentry** on every SSO login (first 200 chars of the callback URL in info events CAPACITOR-H6/HG). | **Fixed** — URLs redacted before logging, diagnostics demoted to breadcrumbs, `beforeSend` scrubs `token=`/`user=`/bare JWTs everywhere. |
| 2.2 | **Android backups included the JWT**, BLE pairing and upload queue (`allowBackup=true`, no exclusion rules). | **Fixed** — `allowBackup=false`. Users re-login on a new phone. |
| 2.3 | WebView **granted every permission request to any origin** (`onPermissionRequest` → `grant(all)`). | **Fixed** — only `https://localhost` (the bundle origin), only audio/video capture. |
| 2.4 | **Mixed content allowed in release builds** (`MIXED_CONTENT_ALWAYS_ALLOW`). | **Fixed** — debuggable builds only. |
| 2.5 | `usesCleartextTraffic="true"` (ignored while a network-security-config exists, but wrong). | **Fixed** — false. |
| 2.6 | Nearby Bluetooth device **names of the user's environment** were sent to Sentry on scans. | **Fixed** — counts only. |
| 2.7 | Auth token stored in Capacitor `Preferences` (plain SharedPreferences / UserDefaults), 7-day JWT. | **Open** — see §6. With 2.2 the main exfiltration path is closed. |
| 2.8 | SSO token delivered through a custom URL scheme (`suissenotes://`) — hijackable by another app on Android. iOS is safe (ASWebAuthenticationSession binds the callback to the app). | **Open** — backend change needed (short-lived code + exchange, or verified App Links). See §6. |
| 2.9 | Share/"copy link" URLs embed a 5-minute web-session token (by design, for seamless login). | Noted, not changed — product decision. |
| 2.10 | CSP `script-src 'unsafe-eval'` (needed by vue-i18n's runtime message compiler). | Noted, not changed. |

## 3. Reliability / UX findings

| # | Finding | Status |
|---|---|---|
| 3.1 | Every fresh install was asked for **Bluetooth and notification permission on the login screen**; 134 iOS users declined (CAPACITOR-HS, error-level). | **Fixed** — BLE initializes only with a paired device or from the device page/scan; notification permission is requested by the first sync. |
| 3.2 | **BLE persistent reconnect** ran a 12 s scan + 15 s connect attempt back-to-back forever while the recorder was off/out of range, reporting an error every ~30 s (CAPACITOR-7: 2308 events / 38 users; GE/GD ~8500 info events). | **Fixed** — exponential backoff 15 s → 5 min, silent automatic attempts, breadcrumbs. |
| 3.3 | Android: paired device unknown to the plugin after a process restart ("Device not found", CAPACITOR-1G) → connect could never succeed until a manual scan. | **Fixed** — short filtered scan + one retry. |
| 3.4 | "deviceId required." storms after a disconnect (CAPACITOR-W). | **Fixed** — `_write` guards a lost link with the retryable transport error. |
| 3.5 | Disconnects, timeouts, CRC mismatches, "already paired", aggregate sync failures all reported at **error level** (MD, Z, J5, HN, GG, J7, JQ, RY …). | **Fixed** — warnings/breadcrumbs; real defects still `captureException`. |
| 3.6 | Upload diagnostics emitted **~8 Sentry events per upload** (GX 6413, GM 3504, GS 3133 …) — quota burn and an unreadable issue list. | **Fixed** — breadcrumbs; expected network failures are warnings. |
| 3.7 | `fetch()` calls had **no deadline**: login, the boot-time session refresh (awaited by the router for a token in the grace window), history and minutes could hang forever on a black-holed connection. | **Fixed** — 30 s abort in `apiRequest` and history `_serverFetch`. |
| 3.8 | UI language **hard-coded to German** (reviewers on English devices, French/Italian users). | **Fixed** — saved choice → device language (en/de/fr/it) → German. |
| 3.9 | Hard-coded English notifications on History (login required, file missing, uploaded, deleted, progress) and the Record stop path; device-page dates in the WebView locale. | **Fixed** — localized en/de/fr/it. |
| 3.10 | Sign-out possible mid-recording (resets the history store and orphans the in-flight recording's bookkeeping). | **Fixed** — blocked with a message while recording/uploading. |
| 3.11 | `console.error` at every launch when the `recordings` folder does not exist yet. | **Fixed** — missing root lists as empty. |
| 3.12 | History on the phone was a flat list of cards; scanning "which day was that" meant reading every timestamp. | **Fixed** — day groups (Today / Yesterday / localized long date, newest first) inside the device/app sections; desktop unchanged. |

## 4. What was verified as already solid (no change)
- Recording engine: double-start latch + generation guard, honest duration, chunk-progress
  watchdog, INT-2 interruption recovery loop, mic health/zero-signal forensics, atomic
  tmp+rename chunk writes with size verification, serialized chunk saves.
- Upload: write-ahead persistent queue (localStorage + Preferences backup), in-flight guard
  with stale takeover, two-phase server verification, terminal-error classification, stable
  recordId per device file (server dedupe), disk-backed Blob reads (no OOM).
- Auth: token state machine (active/stale/grace/dead), refresh mutex, recording-session gate.
- BLE protocol layer: command lock, notification queue with stale-drain and late-drop,
  CRC16 verification, cancel/disconnect propagation.

## 5. Verification done
- Unit tests: 195/195 pass (26 files; 32 new tests: lifecycle boot, redaction/scrubbing,
  Android directory + legacy fallback + migration, disk-space probe, API timeout, BLE lazy
  init + backoff, locale detection, history day grouping). Baseline on `main` before the
  change: 159/159.
- ESLint: 0 errors on every changed file.
- `quasar build -m capacitor -T android --skip-pkg`: bundle compiles.
- Native Kotlin/Java changes compile only in CI (no Android SDK on this machine) — see the
  "Mobile Release" run for this branch.

**Not verified on a real device** (must happen before store submission): a full record →
stop → upload on one Android 13+ phone (confirms chunks now list correctly and the
migration of an existing install), one iPhone (confirms the lifecycle listeners register —
background the app mid-recording and check the flush breadcrumb), and one BLE sync with the
Suisse Notes Pro switched off (confirms the backoff and the absence of error events).

## 6. Open items (ordered by value)
1. **Keychain / EncryptedSharedPreferences for the JWT** — small native plugin
   (`SecureStorage`: iOS `kSecClassGenericPassword`, Android
   `androidx.security:security-crypto` EncryptedSharedPreferences) with a one-time migration
   from `Preferences`. Native code, so it needs a device test round; kept out of this release.
2. **SSO callback via one-time code** — backend returns `suissenotes://auth/callback?code=…`,
   the app exchanges the code for the JWT over HTTPS; closes the Android scheme-hijack window
   and removes the token from URLs entirely. Backend repo change (`xicoarm/suisse-notes-v2`).
3. **Native iOS background capture (R3)** — the WebView `MediaRecorder` still dies on
   incoming calls/Siri/long backgrounding; the INT-2 loop recovers most cases but
   `capture recovery FAILED — recorder wedged` (CAPACITOR-V1/T6) still hits a few users a
   month. Requires the dormant `BackgroundRecordingPlugin.swift` path to be wired in and
   device-tested.
4. **Server-side truncation signal** — the upload contract carries no wall-clock duration, so
   a 90-minute meeting arriving as 4 minutes raises nothing on the backend.
5. **Backend SAS upload routes** are still undeployed: every upload does a wasted
   `POST /api/uploads/init` (404) before the legacy POST, and uploads cap at 500 MB.
6. **Store screenshots** still show the old "Suisse Notes" UI on both stores.
7. **Legacy Android data** that the migration cannot move (files invisible to the FUSE
   listing) stays readable through the fallback but remains in public `Documents`; a later
   release can drop the fallback once Sentry shows no legacy reads.

## 7. Files touched
`src/boot/{lifecycle,sentry,i18n}.js`, `src/services/{storage,api,ssoAuth,export,upload,upload-direct,bleService}.js`,
`src/stores/{recording,recordings-history,device}.js`, `src/pages/{RecordPage,HistoryPage,DevicePage,SettingsPage,LoginPage}.vue`,
`src/components/RecordingHistoryCard.vue`, `src/composables/useLanguage.js`, `src/utils/redact.js` (new),
`src-capacitor/android/app/src/main/{AndroidManifest.xml,java/ch/suissenotes/app/{MainActivity.java,BackgroundRecordingPlugin.kt,ForegroundRecordingService.kt}}`,
`tests/unit/*` (7 new/updated files).
