# Recording & Upload Robustness Hardening — status, measurement plan, and next steps

**Date shipped:** 2026‑05‑31  ·  **Branch:** `fix/recording-upload-robustness`  ·  **Author:** audit + hardening pass (Claude Opus 4.8)

This is the single source of truth for the recording/upload reliability work. It records (1) what shipped, (2) **exactly what to measure** over the next 1–2 weeks, (3) the **decision gate** for the native‑capture follow‑up, (4) the **native‑capture design sketch + exact steps**, and (5) the deferred backlog. If you are picking this up cold in ~2 weeks, start at **§2 (Measure)** then **§3 (Decision gate)**.

Related: [`BACKGROUND_UPLOAD_NATIVE_DEFERRED.md`](./BACKGROUND_UPLOAD_NATIVE_DEFERRED.md) — the native background **upload** rewrite (distinct but adjacent; see §4.3 — bundle them).

---

## 0. TL;DR

- The apps were already heavily hardened. This pass closed a finite set of **confirmed** gaps across desktop (Electron) and mobile (Capacitor) — recording engine, crash/quit/power‑loss, upload resilience, and BLE — as **one comprehensive change‑set** (7 commits, 12 files, lint‑clean, test‑parity with `main`).
- The **biggest remaining risk is mobile background capture**: the real recorder is the WebView `MediaRecorder`; the native recorders exist but are **dead code**. On iOS especially, backgrounding / screen‑lock / an incoming call suspends the WebView → audio silently stops. This pass shipped a **safety net** (preserve‑prefix + loud gap warning + Android wake lock + atomic chunks). **True background capture is the deliberately‑deferred follow‑up** (§4) — gated on the §2 telemetry.
- **Decision in ~2 weeks:** if the `recording: background capture gap` Sentry signal is frequent on iOS → do the native capture work (§4). If rare → the safety net is sufficient; reprioritize.

---

## 1. What shipped (commits on `fix/recording-upload-robustness`)

| Commit | Area | What it fixes |
|---|---|---|
| `c919680` | Desktop recording engine | `onerror` now **stops** the recorder (was leaving it `recording` → saved corrupt chunks AND blocked the next `startRecording` via the non‑inactive guard, trapping the user). Flush budget 2s→6s + `beforeunload` reorders `preventDefault` first. Mic **disconnect auto‑recovery** via `devicechange` (re‑acquires a live input instead of stranding on a dead device; grace timeouts now cancellable). Auto‑split threshold anchored to wall‑clock elapsed (no drift). |
| `211a0a2` | Desktop upload | `before-quit` now aborts in‑flight uploads **cleanly** and keeps them in the persistent queue to resume next launch (was severing the socket). SAS re‑init verifies `audioFileId` is unchanged before resuming (else restarts clean). `pollServerStatus` treats an **unknown** status enum as persisted/trust‑based (no false "confirmation timeout" → duplicate upload). |
| `5753587` | Mobile recording safety‑net | **Atomic chunk writes** (tmp→verify→rename — a kill mid‑write can't corrupt a chunk). **Background capture‑gap detection** (preserve prefix + raise the capture‑stall banner). Confirmed background flush (no false "done" on the 4s timeout). **Android `PARTIAL_WAKE_LOCK` in the real `NOTIFICATION_ONLY` foreground path** (was none — Doze could silently stall chunk writes), now indefinite. |
| `6d4ebbe` | Mobile upload | **Crash‑resumable uploads** (pre‑queued before any network work → iOS can't lose an in‑flight upload). Queue corruption recovers from the Preferences backup instead of silently returning `[]`. **Cold‑start GC** of redundant chunks (combined file exists → was accumulating GBs on repeat failures). Mobile SAS re‑init `audioFileId` safety. |
| `c049a55` | BLE | Disconnect **aborts the in‑flight transfer immediately** (was a ~50‑min hang of 30s‑per‑chunk timeouts) and keeps the file retryable. 15s connect timeout. `unpair` aborts before disconnect. |
| `d7ac886` | Backend‑coordinated | Verified deployed `master`: legacy `POST /api/desktop/upload` dedupes by `botSessionId = desktop:${recordId}` (so retries can't double‑bill — client already sends `recordId`) and caps at **500MB → 413**. Made **mobile** treat 413 as terminal (was retry‑looping); desktop already did. |
| `505dad4` | Telemetry | Log the mobile background capture‑gap to Sentry so §2 actually produces incidence data. |

**Verification at ship:** full `eslint ./src` = 0 errors; `node --check` clean on Electron main + `upload-direct`; `vitest` = **84 passed, 3 pre‑existing failures (identical to `main` — zero regressions)**. Full `quasar build` was **not** run locally (heavy/signing) — run it in CI before tag.

**Verified false alarms (do NOT "fix" — already handled):** desktop auto‑split race & in‑memory lock reset (`withRecordingLock`+fsync), `finally` always firing; mobile missing‑metadata recovery (`checkRecoveryState`); the native dual‑recorder conflict (native capture is never invoked); iOS cold‑start recovery (disk scan). See the audit output if challenged.

---

## 2. Measure (the 1–2 week window) — exact Sentry signals

All in org `suisse-it-gmbh`. Recording/mobile events → project **`capacitor`**; desktop → **`electron`**. Filter by `release:` tag for the build that ships this branch.

| Signal (search string) | Project | What it tells you | Action threshold |
|---|---|---|---|
| `recording: background capture gap` | capacitor | **THE deciding signal.** WebView suspended mid‑recording (call / lock screen / app switch). Split by platform tag (iOS vs Android). | **Frequent on iOS** → green‑light native capture (§4). Rare → safety net is enough. |
| `recording: capture STALLED` | capacitor + electron | The chunk‑progress watchdog fired (no chunk persisted ≥30s while recording). | Spike → investigate a non‑background stall (codec/device). |
| `upload: unknown status enum=` | capacitor | Backend added a status the client doesn't know (DUREC‑1 guard fired). | Any → confirm the new enum is post‑persistence; add it to `PERSISTED_STATES` in both `src/services/upload.js` and `src-electron/electron-main.js`. |
| `upload queue: main+tmp keys unreadable` | capacitor | Upload‑queue corruption hit the Preferences fallback (DMOB‑5). | Frequent → investigate the write path / device storage. |
| `Upload status unknown enum` | electron | Desktop equivalent of the above. | Same as capacitor. |
| Android `service_destroyed` / `recordingDead` rate | capacitor | Should **drop** after the wake‑lock fix (`5753587`). | Still high → OEM killer; escalates §4 Android urgency. |

**Also watch:** support tickets mentioning "recording cut short / shorter than the meeting", and the Play/TestFlight crash‑free rate for the mobile build.

> If `release:` filtering shows ~zero events, first confirm the mobile build that contains `505dad4` actually shipped and that Sentry DSN is live in that build — otherwise the window produced no data and the decision must wait.

---

## 3. Decision gate (run this in ~2 weeks)

1. Pull the §2 `recording: background capture gap` count, **split by platform**, over the window. Normalize by active recording sessions if you have that metric.
2. Decide:
   - **iOS gaps are common** (users genuinely background / get calls mid‑record) → **do §4 (native capture)**, iOS first. This is the only thing that *prevents* (vs. warns about) the loss.
   - **iOS gaps are rare** → safety net is sufficient. Close this out; reprioritize to the §5 backlog or §4.3 native upload.
   - **Android `service_destroyed` still high** → prioritize the Android half of §4 / battery‑optimization prompt independently of iOS.
3. Record the decision + numbers at the bottom of this doc (§6 log) so it's not re‑litigated.

---

## 4. Native background‑capture follow‑up — design sketch + exact steps

**Goal:** keep audio actually being captured while the app is backgrounded / screen‑locked / interrupted by a call — not just warn about the gap. The native recorders already exist; they are **not wired in**.

### 4.0 Why it's a rewrite, not a patch
The live recorder is the WebView `MediaRecorder` (`src/composables/useRecorder.js` → `src/services/recordingService.js`, `mediaRecorder.start(3000)`). The OS suspends the WebView in background regardless of the `UIBackgroundModes: audio` entitlement (that entitlement only protects a **native** audio session). The fix is to hand capture to native code while backgrounded.

### 4.1 What already exists (and is currently dead code)
- iOS: `src-capacitor/ios/App/App/Plugins/BackgroundRecordingPlugin.swift` — a full `AVAudioRecorder` chunker with `handleInterruption` (call begin/end), `handleRouteChange`, background‑task protection, 5s chunk rotation, `combineChunks`. **Only `combineChunks` is invoked today** (via `recording.js:combineChunksNative`); `startRecording` is never called.
- Android: `src-capacitor/android/app/src/main/java/ch/suissenotes/app/ForegroundRecordingService.kt` — full `MediaRecorder` chunker with audio‑focus pause/resume, wake lock, `START_STICKY`. In production the service runs only in `ACTION_NOTIFICATION_ONLY` mode (no capture). `BackgroundRecordingPlugin.kt` exposes `startRecording`/`pause`/`resume`/`combineChunks`/`getStatus`.
- JS: `src/composables/useRecorder.native.js` — a complete native‑driven composable, **imported nowhere** (`RecordPage.vue:785` imports the WebView `useRecorder.js`).

So most of the code exists; the work is **wiring + handoff + reconciliation + device QA**, not greenfield.

### 4.2 Recommended approach — "native owns background, WebView owns foreground"
Keep the WebView recorder as the primary (it produces the unified mic+system mix on desktop and is well‑tested), and hand off to native capture **only while backgrounded**:

1. **Detect background entry** in `useRecorder.js handleVisibilityChange` / `lifecycle.js onBackground` (mobile branch). The `hiddenSnapshot` logic from `5753587` is already the hook.
2. **On background (active recording):** `flushRecordingData()` (already done) → `mediaRecorder.pause()` the WebView → call native `BackgroundRecording.startRecording({ recordId })`. Native captures m4a chunks into the **same** `recordings/<recordId>/chunks/` dir.
3. **On foreground:** call native `stopRecording`/`getStatus`, reconcile the native chunk index into the store (`recordingStore.chunkIndex`), resume the WebView recorder.
4. **Chunk‑index reconciliation (critical):** native must write chunk indices that don't collide with the WebView's. Either (a) native writes into a `recordings/<recordId>/native/` subdir and the combiner concatenates `chunks/` + `native/` in time order, or (b) native continues the monotonic index from `getStatus().chunkIndex`. **(a) is safer** (no shared counter race). The combiner (`combineChunksNative` → `BackgroundRecordingPlugin.{kt,swift}`) already accepts both `.webm` and `.m4a` and sorts by filename — extend it to merge both dirs by start‑time.
5. **iOS interruption handling comes for free** once native capture is active: `handleInterruption` (call begin → pause, end → resume + post‑resume 0‑byte verification) and `handleRouteChange` already exist in the Swift plugin. Wire the plugin's `interrupted`/`resumed`/`chunkSaveFailure` events to the JS `captureStalled`/`chunkSaveError` channels (the listeners already exist in `useRecorder.native.js`).

### 4.3 Bundle with native background **upload**
The native **upload** rewrite ([`BACKGROUND_UPLOAD_NATIVE_DEFERRED.md`](./BACKGROUND_UPLOAD_NATIVE_DEFERRED.md)) shares the expensive prerequisites with native capture: iOS App Group entitlement + shared container, Android `foregroundServiceType` + storage migration. If you green‑light one, **scope both as a single mobile‑reliability push** — the QA matrix and the entitlement/manifest work are largely shared.

### 4.4 Exact step list (when green‑lit)
1. **iOS Info.plist** — already has `UIBackgroundModes: [audio, bluetooth-central]`; add `processing`+`fetch` if also doing native upload (§4.3). Create `App.entitlements` (currently missing) + App Group if sharing files with native upload.
2. **iOS wiring** — in the mobile branch of `useRecorder.js` (or revive `useRecorder.native.js` behind `isIOS()`), call `BackgroundRecording.startRecording` on background, `stopRecording` on foreground; subscribe to `interrupted`/`resumed`/`error`/`chunkStarted`.
3. **Android** — make `BackgroundRecordingPlugin.startRecording` (the `ACTION_START` path) the background‑capture entry; keep `NOTIFICATION_ONLY` + wake lock for the foreground‑WebView case. Add the battery‑optimization prompt (`requestBatteryOptimizationExemption` already exists, unused).
4. **Combiner** — extend `performCombineChunks` (both `.kt` and `.swift`) to merge `chunks/` + `native/` in start‑time order; extend `_validateChunkSequence` (`recording.js`) for the two‑source layout.
5. **Reconciliation** — on foreground, `getStatus()` → advance/merge `recordingStore.chunkIndex`; verify no gap at the handoff boundary.
6. **QA matrix** (real devices, not simulators): iOS 17/18 + Android low‑RAM/OEM (Samsung/Xiaomi). For each: record → lock screen 2 min → unlock; record → incoming phone call → end call; record → switch apps 5 min; record → 3h with screen off; Bluetooth mic → walk out of range. Confirm the combined file has **no silent gap** and duration matches wall‑clock.
7. **Remove the safety‑net banner's "keep app foreground" hint** only after native capture is confirmed on that platform.

**Effort:** ~3–5 days capture + the §4.3 upload bundle (4–7 days) → plan a ~2‑week mobile‑reliability sprint if doing both. Release risk **elevated** (touches both live platforms; native code isn't covered by the JS test suite).

---

## 5. Deferred backlog (lower severity — from the audit, not done in this pass)

| ID | Platform | Item | Notes |
|---|---|---|---|
| BT‑1 | mobile | BLE byte‑offset transfer resume + "resuming from X%" UI | Device firmware has no offset param; app‑level resume state in Preferences is the workaround. |
| BT‑6 | android | Surface Bluetooth‑off / permission‑denied to the caller (not just Sentry) | `bleService.scan` swallows the requestEnable error. |
| BT‑10 | mobile | On CRC mismatch, delete the corrupt file on the device + retry cap | Avoids a stuck re‑download loop. |
| BT‑3/7 | mobile | MTU/flow control + drain scaling for large aborted transfers | Hardening. |
| DMOB‑7 | mobile | Persist per‑block SAS state for true mid‑file resume | Optimization; pre‑queue (`6d4ebbe`) already resumes from block 0. |
| DMOB‑9 | mobile | Surface "recording has gaps" flag on recovered recordings in the History UI | Data exists (`hadGaps`); needs UI wiring. |
| MOBR‑9 | mobile | WebView memory watchdog (`performance.memory`) over 3–4h | Largely solved by native capture (§4); `performance.memory` is unreliable on WKWebView. |
| DMOB‑10 | android | Brief flush to settle codec on Bluetooth route change mid‑recording | Needs native route‑change detection on Android. |
| DREC‑5/DRD‑7 | desktop | Auto‑split drift (fixed) / disk‑full orphan GC | DRD‑7 largely covered by existing 7‑day cleanup + recovery. |

---

## 6. Release & decision log

**Release steps (when ready):**
- Desktop: merge to `main` → `npm run release` (standard‑version) → `git push --follow-tags origin main` → verify the Release Action builds Win+macOS and assets land on the tag.
- Mobile: bump versions by hand; **on‑device smoke test first** (§4.4 QA subset: background‑during‑record, incoming call, BLE walk‑out); then the manual `gh workflow run` for the mobile build (Android AAB → manual Play upload; iOS → auto‑TestFlight). Recording/upload changes here touch the core path — do not ship mobile without the device pass.

**Decision log (append here):**
- _2026‑05‑31:_ Shipped the safety net; native capture deferred pending §2 telemetry. Revisit ~2026‑06‑14.
- _(next):_ … background‑gap incidence = ___ iOS / ___ Android → decision = ___
