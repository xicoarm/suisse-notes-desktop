# Mobile reliability & security audit — iOS / Android (September 2026)

Scope: the Suisse Meets mobile app (Capacitor, `ch.suissenotes.mobile` / `ch.suissenotes.app`),
release 3.9.36 as shipped on 2026-09-02. Method: full read of the mobile code paths
(recording, storage, upload, auth/SSO, BLE device sync, lifecycle, UI), the native
Android/iOS shells, the Capacitor plugin sources actually bundled, the T240 BLE protocol
specification (2025-06-13) and the Sentry `capacitor` project (90 days, **all 461
unresolved issues, each assigned a disposition in §9**, event trails of the top groups).

Round 1 (§1–§3) covered the platform layer; round 2 (§8) covers the user-reported bugs
("delete after upload" inert on the phone, a device recording missing from History),
the recorder protocol, upload retry policy and error wording.

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
- Unit tests: 242/242 pass (31 files; 79 new tests: lifecycle boot, redaction/scrubbing,
  Android directory + legacy fallback + migration, disk-space probe, API timeout, BLE lazy
  init + backoff, locale detection, history day grouping, BLE error wording, upload
  verdict classification, storage preference / delete-all, BLE notification routing and
  unpair framing, device-sync skip/cancel/deterministic ids). Baseline on `main` before
  the change: 159/159.
- ESLint: 0 errors on every changed file.
- `quasar build -m capacitor -T android --skip-pkg`: bundle compiles.
- Native Kotlin/Java changes compile only in CI (no Android SDK on this machine) — see the
  "Mobile Release" run for this branch.

**Not verified on a real device** (must happen before store submission): a full record →
stop → upload on one Android 13+ phone (confirms chunks now list correctly and the
migration of an existing install), one iPhone (confirms the lifecycle listeners register —
background the app mid-recording and check the flush breadcrumb), and one BLE sync with the
Suisse Notes Pro switched off (confirms the backoff and the absence of error events).
Round 2 adds: "delete after upload" on one Android and one iPhone (the audio must be gone
from the history card after the upload is verified), a cancelled device transfer (card stays
as "skipped" with re-sync), a fresh reinstall pairing with a recorder paired by the previous
install (no "already paired" rejection), and one full pair → sync → unpair cycle with the
recorder (unpair flag byte, translated messages).

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
8. **Recorders bound to an app installation that no longer exists** (uninstalled before
   unpairing, on 3.9.36 and earlier): the protocol lets only the bound app release the
   binding (unpair needs a completed handshake). The app now explains this; a device-side
   reset procedure must come from the manufacturer.
9. **Backend: "Audio file could not be located in storage"** after a successful upload
   (3 events) — blob persistence on the backend side, `xicoarm/suisse-notes-v2`.
10. **Recorder health signals** (`capture STALLED`, `mic-health: …`) intentionally remain
    Sentry events; they are the early-warning system for the native-capture item (3).

## 7. Files touched
`src/boot/{lifecycle,sentry,i18n}.js`, `src/services/{storage,api,ssoAuth,export,upload,upload-direct,bleService}.js`,
`src/stores/{recording,recordings-history,device,auth}.js`, `src/pages/{RecordPage,HistoryPage,DevicePage,SettingsPage,LoginPage}.vue`,
`src/components/RecordingHistoryCard.vue`, `src/composables/useLanguage.js`, `src/utils/{redact,bleErrors}.js` (new),
`src-capacitor/android/app/src/main/{AndroidManifest.xml,java/ch/suissenotes/app/{MainActivity.java,BackgroundRecordingPlugin.kt,ForegroundRecordingService.kt}}`,
`tests/unit/*` (12 new/updated files).

## 8. Round 2 — user-reported bugs, recorder protocol, retry policy, wording

### 8.1 "Do not keep recordings on this phone" never deleted anything on mobile
- **Reported:** recordings stay in History with playable audio although the setting says
  the phone should not keep them.
- **Cause:** the deletion after a verified upload ran on Electron only (record page, history
  card, `markAsUploaded`); on the phone the path was nulled after 30 s without deleting the
  file, and BLE device recordings never received the preference at all. "Delete all
  recordings" in Settings called a store action that does not exist on mobile
  (`historyStore.deleteAll is not a function`) — the button silently failed.
- **Fix:** one `applyStoragePreference(id)` in the history store, called from every upload
  success path (record page, history card, auto-retry, upload queue, device sync, device
  retry). It deletes the combined file plus the chunk folder (app recordings) or the device
  file, only when the entry is `uploaded` with an `audioFileId` and not locked by an
  in-flight upload; the history entry stays with its transcript link and is marked "audio
  removed from this phone". Device recordings inherit the global preference at sync time.
  `deleteAll()` exists on mobile now (local files and local-only entries go; cloud-backed
  entries stay without audio). The Settings strings are localized.

### 8.2 History: no missing and no duplicated device recordings
- **Reported:** a user could not find a recording made with the recorder.
- **Causes:** (a) cancelling a transfer deleted the history entry; (b) `source` and
  `deviceFilename` are client-only fields that lived solely in the localStorage history
  cache — once iOS purged it, the entry dropped out of the "Device recordings" section and
  a later re-sync created a second record (and a duplicate meeting on the server).
- **Fix:** a cancelled transfer keeps its entry as "skipped" with re-sync; record ids of
  device files are deterministic (UUID v5 of user + recorder serial + filename), so every
  re-sync of the same file — after a reinstall, a purged cache or from a second phone — lands
  on the same server meeting; a Preferences-backed index `deviceFilename → recordId` restores
  the device identity on every history merge. Empty files and files that keep arriving
  corrupted are skipped with a translated reason instead of being retried on every poll.

### 8.3 Recorder protocol hardening (T240 protocol, 2025-06-13)
- Every command reply is validated against its command echo (`_readResponse`): battery,
  storage, time sync, delete, format, sync-state and file-list reads no longer accept an
  arbitrary next frame. Late replies and the unsolicited toggle-switch (0x6E) / socket (0x0C)
  reports are dropped; audio frames (type 0x02) are discarded outside a download — the
  "handshake step1 … raw=[0x02 0x1c …]" failures.
- Download: frame-index continuity check (fails fast instead of a CRC mismatch after the
  whole file), zero-byte files detected, the cancel flag scoped to the download it belongs
  to (a cancel used to fail every later read until the next connect — the silent auto-sync
  stop), the file list keeps the last known entries on a transport error, "MemoryBusy"
  (card still being scanned) becomes a translated wait message.
- Unpair sends the "keep recordings on the device" flag byte the protocol requires. iOS no
  longer calls the Android-only `requestEnable`.
- Pairing rejected (status 0x01): the app UUID is derived from the user id for new installs
  (stable across reinstalls and phones) and a rejected handshake retries with every UUID the
  user may have paired with before. The "unpair, then re-pair" fallback was dead code (the
  recorder drops the link right after a rejection) and is replaced by a clear message.
- Every Bluetooth/recorder error shown to the user goes through `humanizeBleError`: 13
  translated, actionable messages in en/de/fr/it (device page, settings, history re-sync,
  sync-phase labels). Raw protocol strings no longer reach the screen.

### 8.4 Uploads: final verdicts end the retry storms
- 4xx answers (no speech, too long, out of minutes, too large) now carry their status and
  `canRetry:false` to the auto-retry, the mobile queue and the device sync; they are parked
  as terminal with the server reason on the history card until the user presses Retry.
  A missing local file (404 on read) clears the dead path and offers re-sync / re-upload.
  Uploads without a record id are refused. Offline and timeouts stay retryable with
  backoff. Login, registration, session refresh and the API helpers parse non-JSON
  responses safely and show a translated "no internet" message.
- Expected outcomes (out of minutes, user cancellations, offline) are breadcrumbs or
  warnings, not Sentry errors.

### 8.5 Smaller
- Stop before the first chunk → "too short" instead of a failed entry and an orphan folder.
- Failed and skipped cards show *why* (server reason, "file is empty", "kept arriving
  corrupted", "file no longer on this phone").
- iOS sign-in sheet dismissed = breadcrumb, not an event.

### 8.6 Mobile stack traces were never symbolicated
- **Evidence:** the latest CAPACITOR-N0 event (3.9.36, 2026-09-11) carries the processing
  error `js_no_source: Source code was not found`; its frames point at
  `index-Og8XjKTs.js line 4 col 183611`. Every CI build logged
  `[sentry-vite-plugin] Warning: Didn't find any matching sources for debug ID upload`.
- **Cause:** the source-map glob in `quasar.config.js` was `./dist/capacitor/www/**`, but
  Quasar writes the Capacitor web build to `src-capacitor/www`. Debug IDs were injected
  into the shipped bundles (58 of 61 files in the 3.9.37 AAB), but nothing was ever
  uploaded. Second defect: the plugin named its release after `package.json` — the
  **desktop** version (4.4.1 … 4.6.0, visible in Sentry as mobile releases with zero
  events) — while every mobile event is tagged with the native app version (3.9.x).
- **Fix:** glob → `src-capacitor/www/**`, `.map` files deleted after the upload so they
  can never ship, release name from the Android `versionName` (in lock-step with the iOS
  marketing version). Verified with a local build against the real project: the plugin
  uploads the bundle. 3.9.37 is the first mobile release with readable stack traces —
  confirm on the first real error event (frames must show `src/…` paths).
- Consequence for §9: Sentry's "resolve in next release" bound the issues to the phantom
  4.6.0; they were re-bound explicitly to `ch.suissenotes.mobile@3.9.37`.

## 9. Sentry, one issue at a time
Source: Sentry project `capacitor`, every issue with status *unresolved* seen in the last 90 days, fetched on 2026-09-12 (461 issues, 63,333 events). Each issue was matched to exactly one row below; the issue IDs of every row are listed underneath so the mapping can be checked one by one.

Result: **430 issues** are fixed, handled or expected behaviour (marked *resolved in release ch.suissenotes.mobile@3.9.37* in Sentry: events from older app versions still in the field do not reopen them, any event from 3.9.37 or newer does); **31 issues** stay open on purpose (monitoring signals we want to keep seeing, plus one backend item).

| # | What Sentry showed (most frequent title of the row) | Issues | Events | What it was | Disposition | Sentry |
|---|---|---:|---:|---|---|---|
| 1 | `BLE name-scan: found=[0] all_nearby=[]` | 2 | 16 | Scan found no recorder | FIXED (round 1) — reported as a count-only warning; nearby device names are no longer sent | resolved |
| 2 | `BLE name-scan: found=[0] all_nearby=[<device names>]` | 179 | 191 | Privacy: names of every Bluetooth device around the user were sent to Sentry on each scan | FIXED (round 1) — name list removed, count only | resolved |
| 3 | `upload: readBlob start path=recordings/null/combined.webm` | 2 | 3 | Upload attempted without a record id (the meeting would be unfindable) | FIXED (round 2) — refused with an error event carrying context; the recording stays "failed" with its retry button | resolved |
| 4 | `upload: readBlob fetch returned non-OK status=404` | 2 | 300 | Local audio no longer on disk when the retry ran (404 on read) | FIXED (round 2) — terminal: dead path cleared, card offers re-sync (device) / re-upload instead of retrying forever | resolved |
| 5 | `upload: readBlob fetch URI=capacitor://localhost/_capacitor_file_<container path>` | 125 | 40,762 | Upload progress diagnostics captured as Sentry events (about 8 per upload) | FIXED (round 1) — breadcrumbs | resolved |
| 6 | `upload: uploadViaPresignedSas THREW — transient=true name=TypeError msg=Failed to fetch...` | 13 | 383 | No network / server unreachable during upload or login | HANDLED — queued with exponential backoff (existing); warning-level breadcrumb (round 1); translated "no internet" message and safe JSON parsing (round 2) | resolved |
| 7 | `Error: Device file upload failed: This recording is 1 min but you only have 0 min remai...` | 6 | 52 | Server refused: not enough minutes (HTTP 402) | FIXED (round 2) — terminal (no retry storm), reason shown on the card; the refusal itself is product behaviour | resolved |
| 8 | `Error: History upload failed: In dieser Aufnahme konnte keine Sprache erkannt werden. M...` | 2 | 43 | Server rejected the audio: no speech detected (HTTP 4xx) | FIXED (round 2) — terminal with the server reason on the card; manual Retry re-arms it | resolved |
| 9 | `Error: History upload failed: Audio file could not be located in storage` | 1 | 3 | Server could not find the uploaded blob at transcription time | OPEN (backend) — the client shows the reason; blob persistence must be checked in xicoarm/suisse-notes-v2 | kept open |
| 10 | `upload: legacy POST returned success=false status=401 error=Token expired` | 2 | 12 | Upload hit an expired session token | HANDLED — refresh + retry (existing); event downgraded to a breadcrumb (round 2) | resolved |
| 11 | `upload: legacy POST returned success=false status=- error=Upload cancelled` | 2 | 4 | User cancelled an upload | EXPECTED — breadcrumb only | resolved |
| 12 | `export: source MISSING — File does not exist` | 2 | 55 | Export/share of a recording whose local file is gone | HANDLED — export checks the source first and tells the user; entries without local audio hide export/play; with "delete after upload" now real (round 2) such entries are marked as such | resolved |
| 13 | `export: staged copy uri=file:///data/user/0/ch.suissenotes.app/cache/Recording%20-%2011...` | 27 | 310 | Export progress diagnostics as events | FIXED (round 1) — breadcrumbs | resolved |
| 14 | `sso: SSOAuth.startAuth rejected reason=USER_CANCELED` | 2 | 81 | User dismissed the Google/Microsoft sign-in sheet (USER_CANCELED, iOS WebAuthenticationSession error 1) | FIXED (round 1+2) — cancellation is a breadcrumb, not an event | resolved |
| 15 | `sso: handleSSOPayload entry hasToken=true hasError=false` | 5 | 314 | Identity provider returned an error (consent declined, login failed) | HANDLED — shown on the login page; redacted breadcrumb for support (round 1) | resolved |
| 16 | `sso: openSSO start platform=ios url=https://app.suisse-meets.ch/api/auth/google/login?c...` | 6 | 753 | SSO diagnostics as events — the callback URL contained the session JWT | FIXED (round 1) — breadcrumbs with redacted URLs; beforeSend scrubs tokens | resolved |
| 17 | `BLE handshake step3 rejected: status=0x1 (Device rejected pairing (already paired to an...` | 6 | 265 | Recorder bound to another app installation (reinstall, second phone): handshake status 0x01 | FIXED (round 2) — app UUID derived from the user (stable across reinstalls and phones) + a rejected handshake retries with every UUID the user may have paired with; translated, actionable message. A recorder bound to an installation that no longer exists still needs the old app (or a device reset) to release the binding — the protocol offers no other way | resolved |
| 18 | `Error: Handshake step1 failed after 4 attempts: byte[3]=0x33, raw=[0x02 0x1c 0x00 0x33 ...` | 2 | 28 | Handshake reply polluted by stale audio frames (0x02 0x1C) from an earlier transfer | FIXED (round 2) — audio frames dropped outside a download; every command reply validated by its command echo | resolved |
| 19 | `Error: Handshake failed: BLE response timeout` | 3 | 54 | Device-side 5 s handshake window missed (slow link) | HANDLED — retried (existing); translated message (round 2) | resolved |
| 20 | `Error: Connection timeout` | 12 | 4,299 | Bluetooth link dropped / recorder off or out of range | FIXED (round 1+2) — classified as transport: warning not error, exponential reconnect backoff (15 s to 5 min), Android rediscovery + retry, translated message | resolved |
| 21 | `Error: BLE download cancelled` | 2 | 15 | User cancelled a transfer | FIXED (round 2) — the entry stays in History as "skipped" with re-sync (it used to be deleted); the cancel flag no longer poisons later reads | resolved |
| 22 | `Error: CRC mismatch: expected 0x9bcc, got 0xe9b7` | 3 | 34 | Corrupted transfer (frame lost on the link) | FIXED (round 2) — frame-index gap detection, 3 retries, then skipped with a translated reason | resolved |
| 23 | `Error: 6/7 failed` | 3 | 95 | Batch sync summary thrown as an error (each file already reported) | FIXED (round 1) — warning; per-file causes carry the detail | resolved |
| 24 | `BLE initialize: FAILED — BLE permission denied` | 3 | 348 | Bluetooth permission refused — it was requested on the login screen of every fresh install | FIXED (round 1+2) — Bluetooth initialised only for a paired device / from the device page; translated instruction | resolved |
| 25 | `BLE scan: Bluetooth disabled — requesting enable` | 2 | 12 | Bluetooth switched off; iOS has no "enable" prompt | FIXED (round 2) — iOS no longer calls requestEnable; translated message | resolved |
| 26 | `BLE rediscovery scan starting (target=74141571-D531-2403-EF3C-A66D82B4D560, timeout=120...` | 4 | 8,543 | Reconnect-loop diagnostics as events (one every ~30 s while the recorder was off) | FIXED (round 1) — breadcrumbs; backoff reconnect | resolved |
| 27 | `BLE initialize: SUCCESS — permissions granted` | 10 | 6,029 | Bluetooth init/handshake/scan diagnostics as events | FIXED (round 1) — breadcrumbs | resolved |
| 28 | `Error: Chunk integrity failure: Chunk sequence has 1 gap(s) at indices [0]. Found 4/5 c...` | 1 | 65 | Android: chunk files invisible in the public Documents folder (FUSE/MediaStore listing) | FIXED (round 1) — app-private storage + migration; stop path tolerates gaps with a visible warning | resolved |
| 29 | `Error: No chunks found` | 1 | 9 | Stop pressed before the first 3-second chunk existed | FIXED (round 2) — treated as "too short": no failed entry, no orphan folder, friendly message | resolved |
| 30 | `SyntaxError: JSON Parse error: Unrecognized token ''` | 1 | 2 | Non-JSON server response (proxy/captive-portal page) parsed as JSON | FIXED (round 2) — defensive parsing in auth and API helpers | resolved |
| 31 | `recording: capture STALLED — no chunk persisted for 1362s (savedChunks=2641, mediaState...` | 5 | 117 | Recorder health signal: the WebView recorder stalled or was wedged by the OS | KEEP (signal) — real warnings we want to keep seeing; the saved file carries a capture warning on the card (round 1); the structural fix is native background capture (open item) | kept open |
| 32 | `recording: capture recovery started (reason=mic-track-muted, savedChunks=578)` | 12 | 84 | Recorder recovery telemetry | KEEP (signal) — shared with the desktop recorder, left as-is | kept open |
| 33 | `mic-health: zero-signal episode ended after 33s — signal returned` | 13 | 52 | Microphone health signal (silence / low level / device switch) | KEEP (signal) — mic-health feature working as designed | kept open |

Issue IDs per row:
- **Row 1** (scan-empty): CAPACITOR-2Q, CAPACITOR-59
- **Row 2** (scan-names): CAPACITOR-100, CAPACITOR-101, CAPACITOR-102, CAPACITOR-103, CAPACITOR-104, CAPACITOR-106, CAPACITOR-108, CAPACITOR-109, CAPACITOR-10C, CAPACITOR-10D, CAPACITOR-10H, CAPACITOR-10J, CAPACITOR-10P, CAPACITOR-10Q, CAPACITOR-10R, CAPACITOR-10S, CAPACITOR-117, CAPACITOR-118, CAPACITOR-11A, CAPACITOR-11B, CAPACITOR-11C, CAPACITOR-11D, CAPACITOR-11F, CAPACITOR-11H, CAPACITOR-11J, CAPACITOR-11K, CAPACITOR-F0, CAPACITOR-K9, CAPACITOR-PQ, CAPACITOR-PR, CAPACITOR-PS, CAPACITOR-PV, CAPACITOR-PY, CAPACITOR-PZ, CAPACITOR-Q0, CAPACITOR-Q1, CAPACITOR-Q2, CAPACITOR-Q3, CAPACITOR-Q4, CAPACITOR-Q5, CAPACITOR-Q8, CAPACITOR-QB, CAPACITOR-QE, CAPACITOR-QF, CAPACITOR-QG, CAPACITOR-QN, CAPACITOR-QP, CAPACITOR-QQ, CAPACITOR-QR, CAPACITOR-QS, CAPACITOR-QV, CAPACITOR-QY, CAPACITOR-R8, CAPACITOR-RC, CAPACITOR-RP, CAPACITOR-RR, CAPACITOR-RS, CAPACITOR-RT, CAPACITOR-S1, CAPACITOR-S5, CAPACITOR-S9, CAPACITOR-SA, CAPACITOR-SD, CAPACITOR-SE, CAPACITOR-SG, CAPACITOR-SH, CAPACITOR-SJ, CAPACITOR-SK, CAPACITOR-SP, CAPACITOR-T1, CAPACITOR-T8, CAPACITOR-T9, CAPACITOR-TC, CAPACITOR-TD, CAPACITOR-TE, CAPACITOR-TJ, CAPACITOR-TM, CAPACITOR-TN, CAPACITOR-TP, CAPACITOR-TQ, CAPACITOR-TR, CAPACITOR-TS, CAPACITOR-TT, CAPACITOR-TW, CAPACITOR-V4, CAPACITOR-V7, CAPACITOR-V8, CAPACITOR-V9, CAPACITOR-VA, CAPACITOR-VB, CAPACITOR-VC, CAPACITOR-VD, CAPACITOR-VE, CAPACITOR-VF, CAPACITOR-VG, CAPACITOR-VH, CAPACITOR-VJ, CAPACITOR-VK, CAPACITOR-VM, CAPACITOR-VN, CAPACITOR-VP, CAPACITOR-VX, CAPACITOR-W4, CAPACITOR-W5, CAPACITOR-W6, CAPACITOR-W8, CAPACITOR-WA, CAPACITOR-WC, CAPACITOR-WD, CAPACITOR-WE, CAPACITOR-WF, CAPACITOR-WG, CAPACITOR-WR, CAPACITOR-WS, CAPACITOR-WT, CAPACITOR-WX, CAPACITOR-WY, CAPACITOR-WZ, CAPACITOR-X0, CAPACITOR-X1, CAPACITOR-X3, CAPACITOR-X9, CAPACITOR-XA, CAPACITOR-XB, CAPACITOR-XC, CAPACITOR-XD, CAPACITOR-XE, CAPACITOR-XF, CAPACITOR-XG, CAPACITOR-XH, CAPACITOR-XJ, CAPACITOR-XK, CAPACITOR-XQ, CAPACITOR-XR, CAPACITOR-XS, CAPACITOR-XT, CAPACITOR-XV, CAPACITOR-XW, CAPACITOR-Y0, CAPACITOR-Y1, CAPACITOR-Y2, CAPACITOR-Y4, CAPACITOR-Y5, CAPACITOR-Y6, CAPACITOR-Y7, CAPACITOR-Y9, CAPACITOR-YA, CAPACITOR-YB, CAPACITOR-YC, CAPACITOR-YD, CAPACITOR-YE, CAPACITOR-YH, CAPACITOR-YJ, CAPACITOR-YK, CAPACITOR-YM, CAPACITOR-YP, CAPACITOR-YS, CAPACITOR-YT, CAPACITOR-YW, CAPACITOR-Z0, CAPACITOR-Z1, CAPACITOR-Z8, CAPACITOR-ZA, CAPACITOR-ZF, CAPACITOR-ZG, CAPACITOR-ZJ, CAPACITOR-ZK, CAPACITOR-ZM, CAPACITOR-ZN, CAPACITOR-ZP, CAPACITOR-ZQ, CAPACITOR-ZR, CAPACITOR-ZS, CAPACITOR-ZT, CAPACITOR-ZV, CAPACITOR-ZW, CAPACITOR-ZX, CAPACITOR-ZY, CAPACITOR-ZZ
- **Row 3** (upload-null-record): CAPACITOR-TX, CAPACITOR-TY
- **Row 4** (upload-file-missing): CAPACITOR-N2, CAPACITOR-N3
- **Row 5** (upload-telemetry): CAPACITOR-107, CAPACITOR-10A, CAPACITOR-10E, CAPACITOR-10G, CAPACITOR-10K, CAPACITOR-10M, CAPACITOR-111, CAPACITOR-119, CAPACITOR-11G, CAPACITOR-GM, CAPACITOR-GR, CAPACITOR-GS, CAPACITOR-GT, CAPACITOR-GV, CAPACITOR-GW, CAPACITOR-GX, CAPACITOR-GY, CAPACITOR-H1, CAPACITOR-H2, CAPACITOR-HX, CAPACITOR-HY, CAPACITOR-J8, CAPACITOR-JK, CAPACITOR-JR, CAPACITOR-JY, CAPACITOR-KA, CAPACITOR-KN, CAPACITOR-M1, CAPACITOR-M6, CAPACITOR-ME, CAPACITOR-MH, CAPACITOR-MJ, CAPACITOR-MK, CAPACITOR-MN, CAPACITOR-MT, CAPACITOR-MV, CAPACITOR-MZ, CAPACITOR-N1, CAPACITOR-N5, CAPACITOR-N8, CAPACITOR-N9, CAPACITOR-NW, CAPACITOR-P0, CAPACITOR-P2, CAPACITOR-PD, CAPACITOR-PG, CAPACITOR-PN, CAPACITOR-PP, CAPACITOR-PT, CAPACITOR-PW, CAPACITOR-PX, CAPACITOR-Q6, CAPACITOR-Q7, CAPACITOR-Q9, CAPACITOR-QC, CAPACITOR-QD, CAPACITOR-QH, CAPACITOR-QJ, CAPACITOR-QK, CAPACITOR-QM, CAPACITOR-QT, CAPACITOR-QX, CAPACITOR-QZ, CAPACITOR-R0, CAPACITOR-R5, CAPACITOR-R6, CAPACITOR-R9, CAPACITOR-RB, CAPACITOR-RD, CAPACITOR-RE, CAPACITOR-RF, CAPACITOR-RG, CAPACITOR-RJ, CAPACITOR-RK, CAPACITOR-RQ, CAPACITOR-S0, CAPACITOR-S3, CAPACITOR-S4, CAPACITOR-S6, CAPACITOR-S8, CAPACITOR-SC, CAPACITOR-SF, CAPACITOR-SQ, CAPACITOR-SY, CAPACITOR-TA, CAPACITOR-TF, CAPACITOR-TG, CAPACITOR-TH, CAPACITOR-TV, CAPACITOR-TZ, CAPACITOR-V2, CAPACITOR-VQ, CAPACITOR-VT, CAPACITOR-VV, CAPACITOR-VY, CAPACITOR-W0, CAPACITOR-W2, CAPACITOR-W3, CAPACITOR-W7, CAPACITOR-W9, CAPACITOR-WH, CAPACITOR-WJ, CAPACITOR-WP, CAPACITOR-WV, CAPACITOR-WW, CAPACITOR-X2, CAPACITOR-X4, CAPACITOR-X5, CAPACITOR-X6, CAPACITOR-X7, CAPACITOR-XM, CAPACITOR-XX, CAPACITOR-XY, CAPACITOR-XZ, CAPACITOR-Y3, CAPACITOR-Y8, CAPACITOR-YQ, CAPACITOR-YV, CAPACITOR-YY, CAPACITOR-Z4, CAPACITOR-Z6, CAPACITOR-ZB, CAPACITOR-ZD, CAPACITOR-ZE, CAPACITOR-ZH
- **Row 6** (offline): CAPACITOR-GF, CAPACITOR-GJ, CAPACITOR-KV, CAPACITOR-MX, CAPACITOR-P8, CAPACITOR-PE, CAPACITOR-PF, CAPACITOR-SM, CAPACITOR-SN, CAPACITOR-SS, CAPACITOR-SW, CAPACITOR-SZ, CAPACITOR-WB
- **Row 7** (upload-402): CAPACITOR-JT, CAPACITOR-KM, CAPACITOR-NT, CAPACITOR-R1, CAPACITOR-RH, CAPACITOR-SR
- **Row 8** (upload-nospeech): CAPACITOR-R7, CAPACITOR-RZ
- **Row 9** (upload-server-missing): CAPACITOR-T2
- **Row 10** (upload-token): CAPACITOR-HW, CAPACITOR-RV
- **Row 11** (upload-cancel): CAPACITOR-KP, CAPACITOR-VW
- **Row 12** (export-missing): CAPACITOR-R2, CAPACITOR-R3
- **Row 13** (export-telemetry): CAPACITOR-105, CAPACITOR-10F, CAPACITOR-10N, CAPACITOR-M2, CAPACITOR-M4, CAPACITOR-M5, CAPACITOR-MG, CAPACITOR-NF, CAPACITOR-NG, CAPACITOR-QW, CAPACITOR-R4, CAPACITOR-RA, CAPACITOR-RM, CAPACITOR-RN, CAPACITOR-SB, CAPACITOR-SX, CAPACITOR-T0, CAPACITOR-TK, CAPACITOR-V3, CAPACITOR-VZ, CAPACITOR-W1, CAPACITOR-WK, CAPACITOR-WM, CAPACITOR-WN, CAPACITOR-X8, CAPACITOR-YN, CAPACITOR-YR
- **Row 14** (sso-cancel): CAPACITOR-J0, CAPACITOR-MR
- **Row 15** (sso-error): CAPACITOR-H5, CAPACITOR-NB, CAPACITOR-Z2, CAPACITOR-Z3, CAPACITOR-Z5
- **Row 16** (sso-telemetry): CAPACITOR-H4, CAPACITOR-H6, CAPACITOR-H7, CAPACITOR-HE, CAPACITOR-HF, CAPACITOR-HG
- **Row 17** (ble-paired-elsewhere): CAPACITOR-10B, CAPACITOR-5E, CAPACITOR-VS, CAPACITOR-WQ, CAPACITOR-YF, CAPACITOR-Z9
- **Row 18** (ble-handshake-polluted): CAPACITOR-F2, CAPACITOR-XN
- **Row 19** (ble-handshake-timeout): CAPACITOR-HN, CAPACITOR-J9, CAPACITOR-YG
- **Row 20** (ble-transport): CAPACITOR-11E, CAPACITOR-1G, CAPACITOR-7, CAPACITOR-J5, CAPACITOR-J6, CAPACITOR-MD, CAPACITOR-MW, CAPACITOR-QA, CAPACITOR-S2, CAPACITOR-W, CAPACITOR-YZ, CAPACITOR-Z
- **Row 21** (ble-cancel): CAPACITOR-H9, CAPACITOR-YX
- **Row 22** (ble-crc): CAPACITOR-JQ, CAPACITOR-RY, CAPACITOR-XP
- **Row 23** (ble-aggregate): CAPACITOR-GG, CAPACITOR-J7, CAPACITOR-MY
- **Row 24** (ble-permission): CAPACITOR-AF, CAPACITOR-HS, CAPACITOR-K7
- **Row 25** (ble-bt-off): CAPACITOR-A3, CAPACITOR-NV
- **Row 26** (ble-rediscovery): CAPACITOR-GD, CAPACITOR-GE, CAPACITOR-KY, CAPACITOR-KZ
- **Row 27** (ble-telemetry): CAPACITOR-1B, CAPACITOR-1D, CAPACITOR-1E, CAPACITOR-5B, CAPACITOR-5C, CAPACITOR-A0, CAPACITOR-A1, CAPACITOR-A5, CAPACITOR-DC, CAPACITOR-VR
- **Row 28** (chunks-gap): CAPACITOR-N0
- **Row 29** (chunks-none): CAPACITOR-DM
- **Row 30** (json-parse): CAPACITOR-T7
- **Row 31** (capture-signal): CAPACITOR-MQ, CAPACITOR-MS, CAPACITOR-T6, CAPACITOR-V1, CAPACITOR-ZC
- **Row 32** (capture-telemetry): CAPACITOR-RW, CAPACITOR-RX, CAPACITOR-S7, CAPACITOR-ST, CAPACITOR-SV, CAPACITOR-T3, CAPACITOR-T4, CAPACITOR-T5, CAPACITOR-TB, CAPACITOR-V0, CAPACITOR-V5, CAPACITOR-V6
- **Row 33** (mic-signal): CAPACITOR-10T, CAPACITOR-10V, CAPACITOR-10W, CAPACITOR-10X, CAPACITOR-10Y, CAPACITOR-10Z, CAPACITOR-110, CAPACITOR-112, CAPACITOR-113, CAPACITOR-114, CAPACITOR-115, CAPACITOR-116, CAPACITOR-Z7

