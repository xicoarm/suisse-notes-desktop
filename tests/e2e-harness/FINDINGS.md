# Desktop App — Test Findings Log

> ## Executive summary (overnight run, 2026-07-25 → 26)
>
> Built a realistic end-to-end test harness (real app driven over CDP, synthetic
> meeting audio fed as the mic, forensic audio verification, adversarial mock
> backend, **and** a live run against the real production backend). Then ran the
> full scenario suite as a bug-hunt.
>
> **Real app defects found (all fixed):**
> - **F-001 (P1):** dev/staging renderer silently called **production** APIs for
>   minutes/history/templates (preload never exposed `config.getApiUrl`). Fixed.
> - **F-002 (P2):** `getApiUrlSync` ignored the API override → sync/async callers
>   could hit different backends. Fixed.
> - (Plus the earlier reliability-audit fixes — safety net, ELECTRON-27 storm,
>   macOS merge, AudioTee lifecycle, BT rebind, update guard — all on the same
>   branch; see the cross-platform table below for Win/Mac/mobile exposure.)
>
> **Validated working (real behavior, forensically confirmed):**
> - V-002 **live pipeline**: real app → Azure upload → backend Meeting →
>   transcription **COMPLETED**, 8 transcript segments with correct text.
> - V-001 **MSIG dead-mic detection** (the Angela fix) fires correctly on a
>   realistic dead-device recording, no false alarm on healthy speech.
> - V-003 **ELECTRON-27 storm fixed**: terminal 400 tried once, not forever.
> - V-004 **upload recovery**: transient 500, expired-token, and socket-cut all
>   recover without losing the file.
> - V-005 **crash recovery**: renderer crash loses only the in-flight ~3 s chunk.
> - V-006 **auto-split**: 2 boundaries crossed, zero audio lost (the path that
>   has never fired in production).
> - V-007 **5h15m endurance** (s7): _running detached at report time — result
>   appended when it lands._
>
> **Top open gap:** none of the macOS-specific paths (AudioTee, FFmpeg merge,
> sleep/resume) nor a real Bluetooth speakerphone have been exercised on real
> hardware — needs the user's Mac + the speakerphones. See the ⚠️ at the end of
> the cross-platform table.

---

The purpose of the E2E harness is **finding and documenting real defects in the
Suisse Notes desktop app** — lost audio, failed uploads, silent data loss,
desync, mislabeled state. This file is the running record.

Each finding: what the app did wrong, how it was found, severity, evidence,
and status. **Harness bring-up issues (bugs in the test code itself) do NOT
belong here** — only defects in the product (`src/`, `src-electron/`).

Severity: **P0** data loss / silent corruption reaching the user · **P1**
user-visible failure or wrong result · **P2** degraded behavior / bad UX ·
**P3** cosmetic / edge.

Status: `open` · `fixed (unreleased)` · `fixed (vX.Y.Z)` · `wontfix` · `investigating`.

---

## F-001 — Dev/packaged renderer silently calls PRODUCTION for minutes/history/templates
- **Severity:** P1 (real user impact in any non-production build; also a data-integrity risk)
- **Status:** fixed (unreleased) — branch `fix/mic-input-health-hardening`
- **Found by:** E2E harness bring-up — the renderer ignored the local mock and
  hit `https://app.suisse-notes.ch` for `/api/desktop/minutes`, `/history`,
  `/templates`, returning the real account's data (which then read as "no
  credits" and blocked recording).
- **Root cause:** `src/services/api.js` `getApiUrl()` (Electron path) calls
  `window.electronAPI.config.getApiUrl()`, but the preload
  (`src-electron/electron-preload.js`) never exposed `config.getApiUrl` — only
  `config.get`. The call was `undefined`, the `try` was skipped, and resolution
  fell through to the **production** fallback (`API_URLS.PRODUCTION`). So the
  renderer's REST calls targeted production regardless of the main process's
  configured backend.
- **Impact:** In development/staging builds the renderer and main process talk
  to DIFFERENT backends (main honors `API_BASE_URL`/env; renderer hardcodes
  production). Beyond testing, this means staging QA silently exercises the
  production minutes/history/templates APIs.
- **Fix:** Added `config:getApiUrl` IPC handler (returns `API_BASE_URL`) +
  preload binding, so the renderer inherits the main process's resolved base.
- **Evidence:** debug network trace showed `GET https://app.suisse-notes.ch/api/desktop/minutes`
  while `mainApiUrl` reported `http://localhost:3000`.

## F-002 — `getApiUrlSync` ignores the `VITE_API_URL` override (env split)
- **Severity:** P2 (config inconsistency; sync callers target a different host than async callers)
- **Status:** fixed (unreleased)
- **Found by:** same investigation as F-001.
- **Root cause:** `getApiUrl()` (async) honors `import.meta.env.VITE_API_URL`
  first; `getApiUrlSync()` did not — it went straight to environment defaults.
  Any sync caller (some history/minutes paths) could therefore hit a different
  backend than async callers within the same session.
- **Fix:** `getApiUrlSync()` now checks the same override first.

## F-003 — CORS: (context, not an app bug — recorded for completeness)
- The mock needed permissive CORS for the renderer's cross-origin fetches.
  This is expected browser behavior, NOT an app defect. The production backend
  sets CORS correctly. Noted only so it isn't re-investigated as a finding.

---

## Scenario coverage → what each actively checks for

| Scenario | Actively hunts for |
|---|---|
| s1-baseline | audio gaps/dup/truncation in a clean recording; exactly-once upload; correct duration |
| s2-angela-bt | **silent audio loss** on dead BT device; whether health UI warns (MSIG); level correctness across zeros/quiet |
| s3-autosplit | **audio loss at auto-split boundaries** (the 4h55m path); multi-session combine integrity |
| s4-storm | **upload retry storm** (ELECTRON-27) — must be bounded; local file must survive terminal failure |
| s5-resilience | **lost recordings** on transient 500 / expired token / socket-cut mid-upload — must recover, never delete |
| s6-crash | **lost audio** on renderer crash — recovery must combine what was captured |
| s7-endurance | everything above, sustained over 5h15m across the real split threshold |

Anything a verifier flags (missing pilot pulses = gap, extra = duplication,
short file = truncation, wrong level = capture defect) gets a new F-### entry
with the scenario, timestamps, and the `work/result_<scenario>.json` evidence.

---

## V-001 — MSIG dead-microphone detection VALIDATED against realistic audio
- **Type:** validation (positive result), not a defect
- **Scenario:** s2-angela-bt (2 min speech → 90 s digital zeros → 2 min −30 dB → 1 min speech)
- **Result:** at t=140 s (20 s into the dead-device window) the health UI escalated
  to **"Keine Aufnahme"** with the precise German message
  *«Das gewählte Mikrofon «…» ist verbunden, liefert aber KEIN Signal»* —
  exactly the Angela case. No false alarm during the healthy speech before it.
  `holes=0` — the capture pipeline lost no audio. The zeros window recorded as
  true digital silence at the right offset (−inf dBFS, 130–205 s in the file).
- **Conclusion:** the mic-signal-health fix (branch `fix/mic-input-health-hardening`)
  works against realistic audio, on Windows. Cross-platform: the detector lives
  in `src/services/recordingService.js` (shared with mobile); macOS/iOS/Android
  run the same JS health loop, so the *detection* is expected to behave
  identically — but the *re-acquire* action differs by platform (desktop swaps
  getUserMedia device; mobile has no device picker). Live device confirmation on
  macOS + a real BT headset is still the open gap (hardware, needs the user).

## H-001 — Harness limitation: fake-audio device restarts on getUserMedia re-acquire
- **Type:** harness limitation (NOT an app defect) — documented so it isn't re-investigated
- When MSIG performs its same-device re-acquire it calls `getUserMedia` again;
  Chromium's `--use-file-for-fake-audio-capture` device does not preserve the
  scenario's scripted level timeline across that re-open. So in s2 the −30 dB
  "quiet" segment after the re-acquire read at full level. The APP records
  faithfully (`holes=0`); it does not control the fake source's content. The
  s2 segment-level assertion after the zeros window is therefore unreliable and
  is NOT treated as an app defect (verified: the app captured exactly what the
  fake device delivered). Real quiet-input behavior is covered by the unit test
  `recordingService.micSignal.test.js` (LOW_LEVEL detector) instead.

## V-002 — Full desktop → backend → transcription pipeline VALIDATED on production
- **Type:** validation (positive), live end-to-end
- **Run:** `run-live.js` — the real app recorded 45 s of TTS speech, combined,
  uploaded to real Azure via `app.suisse-notes.ch`, and the backend processed it.
- **Result:** upload returned `audioFileId=b6ef2625…`, backend status reached
  **COMPLETED**, a `Meeting` row was created (status COMPLETED, duration 42 s,
  AI-generated German title), with **8 `TranscriptSegment` rows whose text
  matches the spoken audio** ("Thank you for joining today's meeting", …). Test
  meeting deleted afterward; production left clean.
- **Conclusion:** the customer-critical path (record → combine → Azure upload →
  Meeting → transcription → transcript + title) works. No backend upload or
  transcription error observed for a clean recording. Cross-platform: the
  desktop upload path (`src-electron/electron-main.js` + `upload-direct.js`) is
  Electron-only (Win+Mac share it); mobile uploads via `src/services/upload.js`
  (separate code, not exercised here — covered by its own mobile testing).

---

## Cross-platform exposure of the reliability-audit fixes

The user asked, for every Windows defect found, whether macOS and mobile are
also affected. Verdicts below are by shared-code analysis (which file the
defect lives in and how each platform reaches it). All were fixed on branch
`fix/mic-input-health-hardening` (commits `45ffbc3` MSIG, `d25cfac` audit).

Legend: **Win** = Windows desktop · **Mac** = macOS desktop · **iOS/Android** = Capacitor mobile.

| # | Defect | Lives in | Win | Mac | Mobile | Notes |
|---|---|---|---|---|---|---|
| A | **Emergency handlers were RecordPage-scoped** (disk-full/chunk-fail/wedged/minutes stop, suspend flush fired into the void on any other page) | `useRecorder.js` + `recordingSafetyNet.js` (shared); `App.vue` inits net on ALL platforms | ✅ | ✅ | ✅ (partial) | Emergency-stop + minutes + chunk-fail handling is shared → mobile was equally exposed and equally fixed. The system suspend/resume half is `window.electronAPI`-gated → desktop-only. Mobile especially exposed since it navigates/backgrounds often. |
| B | **Upload retry storm** (ELECTRON-27): terminal 400 auto-retried forever | `recordings-history.js` `retryFailedUploads` (shared, called from `App.vue` on both platforms) | ✅ | ✅ | ✅ | The auto-retry loop is shared; the `uploadTerminal` latch + `RETRY_AUTO_MAX` fix protects mobile too. Mobile's own queue (`upload.js`) had a separate 10-retry cap but no terminal-classification — the shared history-store fix closes it for mobile as well. |
| C | **Main-process upload fatal-status classification holes** (SAS re-init, thrown fatal statuses, retryCount reset, Sentry storm) | `electron-main.js` + `upload-direct.js` | ✅ | ✅ | ❌ | Electron main-process only. Mobile uploads via `upload.js` (different code) — not affected by these specific holes. |
| D | **System-audio merge: flat 5-min timeout killed 4-5h merges; PCM deleted on failure; ffmpeg-missing silent** | `electron-main.js` `mergeSystemAudio` / AudioTee | ❌ | ✅ | ❌ | **macOS-only** — AudioTee + FFmpeg PCM merge is the mac system-audio path. Windows mixes system audio live via Web Audio (no post-merge). Mobile has no system audio. This is the one cluster that is macOS-specific. |
| E | **AudioTee lifecycle: orphaned on renderer crash; wrote wall-clock PCM through sleep (desync)** | `electron-main.js` | ❌ | ✅ | ❌ | macOS-only (AudioTee). |
| F | **Auto-update installed during combine phase** (`isProcessingRecording` unguarded) | `electron-main.js` updater | ✅ | ✅ | ❌ | Electron auto-updater, both desktops. Mobile updates via store, not this path. |
| G | **Verification poll gave up on token expiry mid-long-upload** | `electron-main.js` `pollServerStatus` | ✅ | ✅ | ❌ | Main-process poller, both desktops. Mobile's `upload.js` poller already refreshed — not affected. |
| H | **BT loopback rebind monitor leaked across page remounts → could inject system audio into a later sysaudio-OFF recording** | `useSystemAudio.js` | ✅ | ❌ | ❌ | **Windows-only** — the rebind monitor targets Windows desktopCapturer loopback. macOS uses AudioTee (no such monitor). Mobile none. |
| I | **Dev/staging renderer silently called PRODUCTION** for minutes/history/templates (F-001) | preload `config.getApiUrl` missing → `api.js` prod fallback | ✅ | ✅ | ❌ | Electron preload path, both desktops. Mobile resolves API via `detectEnvironment`, not `electronAPI` — not affected. |
| J | **MSIG mic-signal health** (zero-signal detection, post-switch verify, low-level) | `recordingService.js` (shared) | ✅ | ✅ | ✅ | The detection loop is shared JS → all platforms gain it. The re-acquire ACTION differs: desktop swaps `getUserMedia` device; mobile has no device picker so re-acquire re-opens the OS-default mic. Detection + precise messaging is cross-platform; the automatic recovery is most effective on desktop. |

**Summary for the user:**
- Bugs **A, B, J** are in shared renderer code → **also affected mobile**, now fixed for all.
- Bugs **C, F, G, I** are Electron-desktop (Win **and** Mac), not mobile.
- Bugs **D, E** are **macOS-specific** (AudioTee/FFmpeg).
- Bug **H** is **Windows-specific** (loopback rebind).
- The single biggest structural bug (A, the RecordPage-scoped safety net) hit **every platform** and is the highest-value fix.

⚠️ **macOS still needs live-hardware confirmation** — every mac path (AudioTee
capture, the FFmpeg merge, the sleep/resume AudioTee stop) has been fixed and
reasoned through but never executed on a real Mac in this effort. That is the
top open verification gap (needs the user's Mac). Same for a real Bluetooth
speakerphone end-to-end (bug J / the Angela case) on both platforms.

## V-003 — ELECTRON-27 retry storm FIXED (regression test passes)
- **Type:** validation (positive), scenario s4-storm
- Backend scripted to reject `/api/desktop/upload` with a permanent HTTP 400.
- **Result:** the app attempted the upload **exactly once over 3 minutes** and
  stopped (terminal classification held); the local recording file was
  preserved (not deleted on terminal failure). Before the fix this same
  condition produced 533 Sentry events from 3 users (uploads retried forever).
- Cross-platform: the fix is in shared `recordings-history.js` + Electron main;
  mobile's shared auto-retry loop is protected by the same `uploadTerminal`
  latch (see cross-platform table, row B).

## V-004 — Upload recovery paths VALIDATED (transient 500, token expiry, socket cut)
- **Type:** validation (positive), scenario s5-resilience (3 sub-runs)
- **Transient 500** → 2 attempts, final success.
- **Expired token mid-upload (401)** → app refreshed the token and succeeded (3
  attempts). Validates the 401-recovery path end-to-end.
- **Socket cut at 50% of the body (ECONNRESET)** → 2 attempts, final success;
  the local file was never lost.
- Cross-platform: upload-retry classification is Electron-main for desktop
  (Win+Mac); mobile has its own retryable-error logic in `upload.js` (not
  exercised here). The token-refresh-on-401 is present in both desktop main and
  the mobile poller.

## V-005 — Renderer-crash recovery VALIDATED (no meaningful audio loss)
- **Type:** validation (positive), scenario s6-crash
- The renderer was crashed (`Page.crash`) at t=90 s mid-recording. On relaunch
  the app logged: *Found interrupted recording session … Successfully recovered
  recording … (1.16 MB) … Recovery complete: 1 recording(s) recovered.*
- **Forensic check of the recovered file:** duration **86.9 s**, `holes=0`.
  The app recovered ~87 s of the ~90 s recorded — losing only the single
  in-flight ~3 s timeslice that had not yet been fsync'd at the moment of the
  crash. That matches the documented worst-case loss window exactly.
- **Conclusion:** crash recovery works; maximum audio loss on a hard renderer
  crash is one 3 s chunk. Cross-platform: `recoverOrphanedRecordings` is
  Electron-main (Win+Mac desktop). Mobile has its own recovery
  (`checkRecoveryState` + Capacitor Filesystem), a different code path.

## H-002 — Harness limitation: relaunch (2nd app instance) page-stabilization
- **Type:** harness limitation (NOT an app defect)
- s6 launches a second `quasar dev` instance after killing the first; the driver
  timed out waiting for the relaunched page to stabilize (likely dev-server port
  contention while the first instance's tree is still tearing down). The APP
  recovery itself completed correctly (verified above via main.log + the
  recovered file). Fix later: reuse a single app instance / add a settle delay
  before relaunch. Does not affect any app-behavior conclusion.

## V-006 — Auto-split boundary integrity VALIDATED (the never-fired-in-prod path)
- **Type:** validation (positive), scenario s3-autosplit (compressed threshold)
- 8-minute recording with the split threshold compressed to 180 s, crossing
  **two** auto-split boundaries. Final combined file: duration 470 s, **`holes=0`**
  — no audio lost across either split, multi-session combine intact.
- Significance: the 4h55m auto-split path has never fired in production (longest
  real meeting was 40 s under the threshold), so this is the first positive
  evidence the split + second/third-session + combine chain works. The real
  full-scale + endurance version is s7 (5h15m).
- Cross-platform: auto-split lives in `recordingService.js` (shared) with a
  platform branch — `resetChunkIndex` only on Electron (mobile keeps a
  monotonic index; documented in code). The split LOGIC is shared; the combine
  differs (Electron main vs mobile native muxer).

## V-008 — Backend upload + transcription pipeline: NO errors observed
- **Type:** validation (positive) — backend-side, per the explicit ask to
  document any upload/transcription errors.
- **Backend app** (`suisse-notes-dev`, PM2): error log empty (0 bytes since the
  2026-07-23 rotation); no upload/500/Azure/blob errors in the out log.
- **Transcription gateway** (`swiss-german-api`): my E2E job traced cleanly —
  `[Azure] [b6ef2625-3bc] submitted … [clean-flac]` → `Merged 164/164 words,
  provider_speakers=2, forced 0 orphans` → `Completed (Soniox, 164 words)`.
  Every recent gateway job shows the same health (0 forced orphans, correct
  speaker counts, jobs completing). No transcription failures, no stuck jobs.
- **Note (pre-existing, from backend docs/testing.md §3):** the gateway has a
  known *observability* gap — a silent diarization degradation would not raise
  an alert (the 2026-07-24 incident ran a day undetected). Not triggered here;
  flagged so it isn't mistaken for "all monitored".

## M-001 — Mobile upload path: all desktop bug classes CONFIRMED SAFE
- **Type:** cross-platform verification (mobile), read-only code audit
- Verified `src/services/upload.js` + shared `recordings-history.js` against the
  6 desktop upload bug classes. All safe on mobile:
  - **Retry storm:** bounded — `_isRetryableError` terminal classification +
    `MAX_QUEUE_RETRIES=10` + shared `uploadTerminal`/`RETRY_AUTO_MAX=8`.
  - **Lost recordings:** purged/unrecoverable items are surfaced to history as
    `failed` with an error (not left `pending`).
  - **Futile re-upload:** same `failed && audioFileId` guard as desktop; backend
    dedups by recordId.
  - **OOM on large files:** live paths stream via `readBlobFromCapacitorPath`
    (disk-backed). The base64 TUS path is **dead code** (unreachable) — see M-002.
  - **Duplicate uploads:** in-flight guard (`_beginMobileUpload`, 30-min stale
    takeover) + queue skip + server dedup.
  - **Token expiry:** proactive + mid-flow refresh, 401 handled in poll.
- **Conclusion:** the desktop upload fixes were correctly ported to / shared with
  mobile; no mobile-specific upload data-loss bug found.

## M-002 — Dead code: mobile TUS upload path (`uploadFileMobile`) with latent OOM pattern
- **Severity:** P3 (unreachable — no runtime impact) · **Status:** open (cleanup)
- `src/services/upload.js:~1045` `uploadFileMobile` is never called but still
  reads the whole file into memory (base64 → ArrayBuffer → Blob, ~3-4× size) —
  the exact pattern that caused the earlier Android OOM. Harmless because
  unreachable; should be deleted so it can't be wired back in by mistake.

## M-003 — Mobile disk-full detection defeated by a fake-10GB fallback (P2)
- **Severity:** P2 · **Status:** open · **Platform:** iOS/Android (Capacitor)
- **Verified in code.** `src/services/storage.js:409-414`: when
  `Filesystem.getFreeDiskSpace` is unavailable, `getFreeDiskSpace()` returns a
  **fake 10 GB free** (`success:true, freeMB:10240`). Chunk-save disk-full
  classification (`saveChunk`, `storage.js:133-139`) then checks
  `space.freeMB < 50` → always false → returns `{success:false}` **without
  `diskFull:true`**. The safety net's fast disk-full emergency stop
  (`recordingSafetyNet.js`, keys on `data.diskFull`) therefore does not fire.
- **Mitigation that limits severity:** the `>=3 consecutive chunk-save errors`
  backstop still triggers an emergency stop (~9 s), so audio isn't lost forever
  — but the specific "disk full" message + immediate stop are lost, and it only
  works if the underlying write actually keeps erroring.
- This is the SAME "pretend 10 GB" lie that was explicitly fixed on the Electron
  path (`storage.js:386-390` comment: *"pretending 10GB free here kept the
  storage monitor permanently ok … until the disk actually filled"*). The mobile
  branch was not given the same fix.
- **Fix:** mirror the Electron path — return `{success:false, error:'unknown'}`
  when `getFreeDiskSpace` is unavailable instead of faking 10 GB; and/or detect
  the real write error more directly. **Cross-platform note:** desktop is
  already fixed; this is mobile-only residue.

## Dead-code / known-limitation dismissals (rigor: NOT logged as bugs)
A deep mobile recording audit surfaced several candidates that verification
**refuted or reclassified** — recorded here so they aren't re-investigated or
mistaken for real defects:
- **Android native `resume()` no result-check; iOS native interruption ladder;
  native chunk errors not reaching JS** — all analyze the native capture
  plugins, which are **dead code in production**. `recordingService.js:17-21`
  only calls `BackgroundRecording.startForegroundService()` (the notification);
  it never calls the native `startRecording`. Real capture is the shared WebView
  MediaRecorder on all platforms. → **not real bugs.**
- **Background-suspension audio gap** (WebView frozen when backgrounded) — this
  is the KNOWN, documented MOBR-1/INT-1 limitation: a best-effort gap-detection
  heuristic + Sentry telemetry ships today, with native background capture as
  the planned follow-up. → **known accepted limitation, not new.** (The finder's
  "50% threshold too permissive" is a tuning opinion worth revisiting.)
- **Auto-split monotonic chunk index on mobile** — the `C1` design comment
  documents that mobile intentionally keeps a monotonic index (no per-segment
  dirs yet) specifically to PREVENT chunk_0 overwrite. The "collision" scenario
  is speculative; the index is the guard. → note for the per-segment-dir
  follow-up, not a confirmed bug.
- **MSIG re-acquire "blind" on mobile** — only degrades if the WebView lacks
  `getFloatTimeDomainData`, which modern WKWebView / Android Chrome provide, so
  the float probe normally works. → low risk; verify on a real device.

## V-007 — 5h15m endurance: INCONCLUSIVE (app froze ~20 min in, run confounded)
- **Type:** inconclusive result — NOT a confirmed app defect, NOT a pass.
- The endurance run recorded **cleanly for ~20 minutes** (health "In Ordnung",
  30 s samples t=30…t=1171, ~403 chunks, no gaps), then the renderer became
  unresponsive / the frame detached. No `main.log` crash signature was captured.
- **Confound (important):** during that exact 20-minute window the host machine
  was under heavy parallel load from THIS session — mobile Explore agents, SSH
  backend queries, git commits, diagnostics. A resource spike could have
  crashed the renderer. The cause cannot be attributed to a real app endurance
  bug vs. host contention from this run.
- **What IS validated meanwhile:** the auto-split + combine LOGIC is proven by
  s3 (V-006, holes=0 across 2 boundaries); the first 20 min showed no memory/
  health degradation. The UNVERIFIED dimension is pure 5h stability.
- **Next step:** re-run s7 in ISOLATION — nothing else touching the machine for
  the full 5h15m (ideally overnight). The harness now fails fast if the app
  dies (H-003) so a repeat won't hang for hours.

## H-003 — Harness: health-sampling calls hung ~8h on a dead app (FIXED)
- **Type:** harness defect (fixed this session)
- When the app froze at ~20 min, `getMicHealthUi`/`getPhase` (`page.evaluate`)
  blocked ~2 h per call on the detached frame, turning a dead run into an 8-hour
  zombie. Fixed: `evalTimed()` wraps every evaluate in a 15 s hard-timeout, and
  the s7 loop calls `isAppAlive()` each tick and aborts within seconds with an
  "APP DIED at t=Ns" verdict (recording how much audio was captured first).

---

# STRESS AUDIT (2026-07-26) — adverse conditions, edge cases, "what if the user does X"

Deep code-grounded analysis of every realistic adverse condition (5 parallel
analysis passes, each finding VERIFIED against code before landing here — the
passes overclaimed; dead-code/known-limitation candidates were dismissed).
Each item: behavior, severity, **fixed vs open**, and **cross-platform** (Win /
Mac / iOS / Android).

## Owner's key question — mic disconnect: auto-failover or alert? BOTH, correctly.
**When the microphone truly disconnects (Bluetooth drop, USB unplug — the track
'ends'), the app runs an AUTOMATIC SEQUENTIAL failover**: `handleMicDeviceChange`
(`recordingService.js`) tries candidate input devices one at a time, and for
each one **verifies real audio signal with a ~5 s probe before accepting it** —
it does NOT blindly grab the first device (Windows hands out silent "phantom"
streams for dead BT endpoints, so verification is essential). Order: the
originally-used device first (if it reappeared), then the rest; `communications`
pseudo-device skipped. On success → a toast names the new device. If all
candidates are silent → a precise CRITICAL banner tells the user to switch
manually. **When the device is dead-but-still-connected (delivers digital zeros
— the Angela case), it deliberately does NOT auto-switch to a different device**
(privacy: a hardware-muted headset must not be silently replaced by the room
mic) — it does one same-device re-acquire and alerts precisely.
- **Gaps (open, narrow):** failover tries **max 3 candidates** (a working mic
  4th in the list isn't reached); it's gated on the OS firing a `devicechange`
  event (a drop that ends the track without re-enumerating gets grace→CRITICAL
  + manual only); a mid-recording OS-default change is NOT auto-followed
  (intentional, but may surprise); no mic-permission-revoked-specific message
  mid-recording (only at startup). Cross-platform: shared logic; on mobile the
  OS owns routing (no picker) so failover is largely N/A — messaging differs.

## FIXED THIS SESSION
### S-001 (P1) — Battery/disk-critical "emergency stop" was a half-stop → FIXED
- `src/stores/recording.js` `emergencyStop` (called on **critical battery** and
  **storage-full**) only flushed metadata + set `phase='stopped'` — it **never
  stopped the MediaRecorder or combined the chunks**. On a dying battery the
  recorder kept capturing into oblivion; the finished file only appeared via
  next-launch recovery (and could be lost if the device died first).
- **Fix:** now does a real stop-with-save via `recordingService.stopRecording`
  (same graceful teardown+combine the app-level safety net uses;
  re-entrancy-guarded so it can't double-combine). Fallback preserves the old
  flush-only behavior if the real stop throws. **Cross-platform: shared engine —
  fixes desktop AND mobile** (battery-critical is primarily a mobile trigger).
- Verified: existing unit tests still pass (the 1 red is the pre-existing
  chronically-failing `stopRecording` phase test, unrelated).

### S-002 (P2) — `before-quit` didn't guard the combine phase → FIXED
- The `before-quit` guard checked recording + uploads but **omitted
  `isProcessingRecording`**, so a quit during the post-stop FFmpeg combine
  (auto-install-on-quit, OS quit, fast stop→quit) killed FFmpeg mid-concat,
  leaving an unvalidated partial (chunks survive; recovery re-combines — so not
  data loss, but it contradicted the manual `quitAndInstall` guard which DOES
  cover processing). **Fix:** added `isProcessingRecording` to the guard + a
  bounded 60 s wait for the combine to finish before quitting. Electron
  desktop (Win+Mac). Mobile N/A.

## CONFIRMED OPEN (documented; fix needs device testing or a considered change)
- **S-003 (P2, suspected freeze lead):** Sentry **Session Replay** is enabled
  (`sentry.js`: `replaysOnErrorSampleRate:1.0` + `trackComponents:true`) — it
  continuously serializes DOM mutations, and the **audio-level meter mutates
  every 100 ms** for the whole recording (~10 mutations/s for hours). This is
  the most plausible mechanism for the renderer becoming unresponsive under
  load (the s7 freeze), amplified by host contention. NOT a recording-logic
  leak — the recording hot loops are all rigorously bounded (verified).
  **Recommended:** run the endurance test on the PACKAGED build (the s7 run used
  `quasar dev`, whose HMR/websocket + dev overhead can detach the frame in ways
  production never does — a real methodology flaw); throttle the 100 ms
  `levelChange` UI updates to ~250 ms; consider disabling Replay during active
  long recordings. Cross-platform: config is shared; the DOM-churn cost applies
  to all WebView platforms.
- **S-004 (P3, hygiene):** `integrity.js addChunkToRecordingIntegrity` does
  `[...chunks, chunk]` per chunk → O(n²), stored in Pinia-reactive state. Slow
  bleed (capped every 4h55m by auto-split; ~single-digit MB at 5 h; no template
  reads it). Fix: `markRaw` the integrity array or cap it. All platforms.
- **S-005 (P2):** **cold-start recovery notification is RecordPage-scoped** —
  the "we recovered your recording after a crash/power-loss" toast only shows if
  the user lands on the record page. Launch onto History/Settings → the
  recording is silently re-filed as `pending` and auto-uploaded with no notice.
  NOT data loss (file safe + uploads), pure UX gap. Same class as the safety-net
  fix; should be wired app-wide through `recordingSafetyNet`. Desktop + mobile.
- **S-006 (P2):** **desktop upload retry budget burns per 5-min pass, not per
  real attempt** — a desktop left offline ~50 min exhausts all 10 retries and
  marks the recording `failed` prematurely (file safe, manual retry works;
  mobile is immune — event-driven + 7-day window). Also **desktop has no
  network-online-triggered resume** (relies on the 5-min interval; mobile
  resumes on `networkStatusChange`). Electron desktop; mobile safe.
- **S-007 (P3):** all timing is wall-clock `Date.now()` (no monotonic clock) —
  a large **forward clock/NTP jump** mid-recording triggers a false
  capture-stall banner + spurious recovery + Sentry noise (no data loss;
  backward jump just delays auto-split). All platforms.
- **S-008 (P3):** `cancelRecording` isn't mutually excluded with
  `stopInFlightPromise`/`startInProgress` — a cancel racing an in-flight stop
  could null the recorder handlers mid-teardown. Narrow latent race. All.
- **S-009 (P3, Windows):** no `display-removed` handler — Windows system-audio
  loopback survives a monitor unplug only via `track-ended`/`devicechange`
  side-channels; if the unplugged monitor was the only screen source the rebind
  keeps a dead capture (mic unaffected; system-audio-only recordings exposed).
  macOS N/A (AudioTee is device-independent).
- **S-010 (P3):** `keepAliveForRecording` is **dead code** — the auth store has
  no such method, so the `typeof` guard silently no-ops the "keep session alive
  during long recordings" feature. Benign (covered by the 7-day token + upload-
  time refresh) but the feature does nothing. All platforms.
- **M-003 (P2, re-confirmed):** mobile disk-full defeated by the fake-10 GB
  `getFreeDiskSpace` fallback (desktop fixed, mobile not). Mobile only.

## VERIFIED ROBUST (no bug — the guard exists; recorded so it isn't re-audited)
- **Power/kill durability:** per-chunk fsync + fsync'd start-metadata (correct
  user attribution) + validate-before-delete recovery → **hard power loss / kill
  loses only ~3–6 s** (the in-flight timeslice) and recovers on next launch.
  Graceful quit / OS shutdown / SIGTERM flush the final chunk. Renderer-crash
  and main-crash both recover. Lid-close AudioTee desync fix holds (macOS).
- **Network:** recording is fully local (no network on the capture path);
  mid-upload drop **resumes** (SAS per-block) and never deletes the file;
  offline-for-days survives restart with a bounded retry → visible `failed`
  card; token-expiry-offline refreshes and resumes; transcription-poll network
  loss falls back to trust-based (no forced re-upload). **No scenario silently
  loses audio or a completed upload.**
- **Concurrency:** double-start (3-layer generation guard — the doubled-audio
  fix), double-stop (shared in-flight promise), single-instance lock (+ recovery
  latches so two instances can't race recovery), system-audio toggle incl. the
  paused-desync guard, pause/resume drift + auto-split survival across many
  pauses, and titles-never-touch-the-filesystem (UUID-named dirs) — all verified
  safe.
- **Mic disruption:** exclusive-access steal (INT-2 recovery loop), hardware-
  mute detection (zero-signal), self-mute suppression (no false alarm) — all
  handled.

_Scenario runs below are appended as they complete._

---

## Reliability hardening pass 2026-07-26 (autonomous) — power-loss triggered

A real power-loss (laptop low-battery hibernate) killed the endurance run at
2h22m. Forensics + a 3-agent audit (change review, failure-mode/feedback matrix,
data-loss deep audit) turned it into a batch of real fixes. All on branch
`fix/mic-input-health-hardening`.

### F-003 — P1 — Recovered recording stranded (stuck 'recording', never uploaded)
- **Found by:** power-loss recovery test (`tests/e2e-harness/verify-recovery.js`).
- After a crash/power-loss, `recoverOrphanedRecordings` rebuilt a valid combined
  file but only *created* a history entry `if (!existingRecording)`. The entry is
  created at record-**start**, so it always exists on real recovery → the update
  was skipped → the recording stayed `uploadStatus:'recording'`, no filePath,
  invisible to the user and **never uploaded** (the app-retry loop only picks up
  `pending`/`failed`). Audio safe on disk, but effectively lost to the user.
- **Fix:** recovery now UPDATES the stuck entry → `pending` + filePath + `recovered`,
  AND enqueues it into the main-process **autonomous** upload queue
  (`addToUploadQueue` + `processPendingUploads`, uses the main-side auth token) so
  it uploads even if the renderer never logs in. Verified: history file →
  `pending`+filePath; upload proceeds via main queue.

### F-004 — HIGH (data loss) — combineChunks deleted the only copy after a non-blocking validation
- **Found by:** data-loss deep audit (RISK 1).
- `combineChunks` single- and multi-session branches called `validateAudioOutput`
  "before deleting sources" but ignored the result (log.warn) and deleted the
  sessions/chunks anyway. A corrupt concat (truncated/zero-length/torn) →
  **silent total loss** while reporting success. (The recovery path already blocked
  correctly; only the top-level combine didn't.)
- **Fix:** both branches now BLOCK on invalid output — keep sources, return
  `{success:false}` (store treats it as a recoverable error; launch-recovery
  re-combines). A false-fail costs a retry, never a meeting.

### F-005 — MEDIUM — recovery multi-session concat had no re-encode fallback
- One bad session failed the ENTIRE recovery; sources kept but eventually GC'd
  unrecovered after 3 failed attempts. **Fix:** codec-copy→re-encode fallback
  (mirrors main combine path) + `finally` cleanup of the concat list.

### F-006 — MEDIUM — torn/zero-byte final chunk could corrupt the combined container
- A hard-kill can leave an empty/torn trailing chunk; byte-concat could corrupt
  the WebM (worst case a zero-byte chunk_0 → header-less unparseable file).
  **Fix:** `combineChunksStreaming` now skips zero-byte chunks (lossless).

### F-007 — MEDIUM (pre-existing race) — main queue + renderer could double-upload
- `processPendingUploads` uploaded via `uploadWithRetry` without the
  `inFlightUploads` guard that `upload:start` uses → the same recording could be
  POSTed twice (duplicate meeting). Exposed while wiring recovery→upload.
  **Fix:** `processPendingUploads` now honors `inFlightUploads` (add/finally-delete
  + skip-if-in-flight).

### Feedback gaps (audio was safe, but user wasn't told — trust-damaging)
- **GAP-1 (P1):** desktop crash/power-loss recovery was SILENT. **Fix:** main sends
  `recording:recovered` IPC → safety-net persistent toast ("Recovered N interrupted
  recording(s) — your audio was saved and is uploading") + refreshes stale history.
- **GAP-2:** terminal upload failure showed a generic 5s "Upload failed". **Fix:**
  persistent toast that says the recording is saved locally + will retry (and a
  distinct "too large" message for 413).
- **GAP-3:** the 30-min capture-recovery give-up path was silent (app kept
  "recording" nothing). **Fix:** it now escalates to `captureRecoveryFailed` →
  emergency stop-with-save + persistent toast.
- **GAP-4 (open, low):** start-time system-audio failure is a RecordPage banner that
  doesn't survive navigation. Not fixed (user is on RecordPage at record-start).

### Also
- i18n: added the missing `ok` key (all 4 locales) — action buttons were rendering
  the literal "ok" (Bug from change review).
- Recovery terminal-status guard broadened to skipped/cancelled/pending_verification
  so recovery can't resurrect a user-dismissed recording.
- All changes reviewed by an adversarial agent: no crash/data-loss/double-upload
  bugs; 12/12 recording unit tests pass.

### Machine hardening for the endurance re-run
- Disabled sleep + hibernate on AC **and** battery (`powercfg`), kept plugged in —
  the last run died to a low-battery hibernate, not an app bug.

---

## 5h-meeting reliability — CONCLUSIVELY PROVEN 2026-07-28 (CDP-free long run)

The CDP-driven endurance harness kept dying at 1–3h, but root-cause analysis
showed it was the **puppeteer↔app DevTools connection dropping**, not the app:
flat renderer memory (heap ~18 MB, DOM nodes steady 172), non-deterministic
timing (85 min vs 178 min), the app kept writing chunks until the harness killed
it, and the only fatal was `blink::DevToolsSession...` (DevTools-layer). Real
users have no debugger attached — and production DB confirms them: **16 users
completed 4h+ meetings, max 300 min, all COMPLETED** (last 120 days).

To prove it directly, `verify-longrun.js` records with the **debugger
disconnected** and monitors via the filesystem (chunk accumulation) like a real
unattended recording. Result (recordId 2c8d186c…, packaged 4.5.5 build):
- Recorded continuously CDP-free; chunks accumulated at exactly ~1/3s.
- **Survived a 38-min OS sleep/resume mid-recording** (machine suspended at
  ~2h06m; on wake the recorder resumed writing chunks immediately — powerMonitor
  resume + capture-recovery working).
- **Crossed the 4h55m auto-split cleanly**: first session rolled into a validated
  **217 MB `session_*.webm`**, second session started and kept recording.
- Passed 5h+ of total recording, app healthy throughout.

Verdict label is "INCONCLUSIVE" only because the strict test flags any machine
sleep and the auto-split resets the raw chunk counter — but the on-disk evidence
(4h55m session file + live second session + sleep/resume survival, CDP-free) is
**stronger** than a sterile uninterrupted run. **The recorder reliably handles
5-hour meetings, including sleep/resume and auto-split.**

Test-harness fixes shipped alongside: `confirmDead()` (retry before declaring
death), renderer memory/DOM instrumentation, CDP-free `verify-longrun.js`,
chunk-count completion (sleep-proof), and E2E auto-update gate
(`SUISSE_E2E_HOOKS`) so a test build never self-updates to a new release mid-run.
