# Desktop App — Test Findings Log

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

_Findings below are appended as scenarios run._
