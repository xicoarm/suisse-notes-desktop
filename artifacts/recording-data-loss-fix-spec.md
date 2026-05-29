# Recording silent-data-loss — confirmed root cause + fix spec

Source: 15-agent audit `wf_8b5cf5bf-2a1` (2026-05-30). Full transcript: `tasks/wcr0odsr1.output`.

## CONFIRMED ROOT CAUSE
On EVERY platform the real recorder is the WebView `MediaRecorder` in `src/services/recordingService.js` (driven by `src/composables/useRecorder.js`). `useRecorder.native.js` + the whole native protection apparatus (Android FGS-owns-mic + wake lock; iOS AVAudioSession; the native stale-chunk watchdog) is **DEAD CODE (zero importers)**. On Android the live path is `ACTION_NOTIFICATION_ONLY` (no mic, no wake lock); on iOS `showRecordingNotification` early-returns so no audio session is ever activated.

Silent 3.5h→2.5h loss = a **masking triad** on this OS-killable recorder:
1. **Wall-clock duration** (`recordingService.js:838,844`) — timer/stored duration = `(Date.now()-startTime)/1000`, updated every tick regardless of whether `saveChunk` succeeded.
2. **No chunk-progress watchdog** — only death detector `verifyRecordingState` acts on `state==='inactive'`; a recorder wedged at `'recording'` is invisible. (`lastSuccessfulChunkAt` exists nowhere.)
3. **Dead failure channel** — `chunkSaveFailure` is emitted (`:1242,1250,1278`) but has ZERO listeners → disk-full + exhausted-retries are 100% silent.

Plus **Bug D** (confirmed): `performAutoSplit` never advances the duration baseline, so past MAX_DURATION (4h55m) the auto-split predicate re-fires every 1s, shredding the chunk set (Sentry ELECTRON-1V/122779427, 1570 events).

## STAGED FIX (full detail in tasks/wcr0odsr1.output finalDoc)

### Release 1 — pure-JS, ALL platforms, unit-testable, highest value, lowest regression (MINIMAL HIGH-VALUE SUBSET):
1. **Bug D edge-trigger** — module-level `nextAutoSplitAtSeconds`/`lastAutoSplitChunkIndex`; gate both `:868` and `:1501`; advance only on `createSessionFile` success; ≥60s floor; reset in `stopDurationTracking`. Do NOT `resetChunkIndex()` on a failed split (`:947`).
2. **Chunk-progress watchdog (WARN-ONLY)** — module `lastSuccessfulChunkAt` set in `ondataavailable` success; checked in the 5s `stateVerificationInterval` (`:1371`); emit `captureStalled` gated on `state==='recording' && isRecording && !isPaused && !recordingInterrupted && !isAutoSplitting`; reset `lastSuccessfulChunkAt` on app/visibility resume. NO auto-stop in v1 (auto-split merge can pause up to ~10min).
3. **Honest duration** — two vars: `wallClockElapsed` (drives limit/auto-split, unchanged) and `capturedDurationSec = lastChunkIndex*timeslice`; `updateDuration(captured)`. Never route limit/split through `recordingStore.duration`.
4. **Wire `chunkSaveFailure` + `captureStalled`** in `useRecorder.js:316-328`; persistent banner; emergency stop-with-save on `diskFull` or N≥3 consecutive `retriesExhausted` (route via existing `recordingDead` path `:325`).
5. **Honest duration to backend** — RecordPage.vue stop seeding `finalDuration` with wall-clock (`:1347,:1780`); invert `upload-direct.js:309` probe precedence (probe first, client value only as last resort); fix `recording.js:329` `result.duration||null` collapse → propagate `{duration,durationSource}`.
6. **Remove fake-10GB** disk check (`storage.js:364-400` returns hardcoded 10GB) → `{success:false,unverified:true}`; treat unverified as WARN not block; ENOSPC classification independent of free-space number.
7. **Replace >50% recovery gate** (`recording.js:708`) with **truncate-at-first-gap** (keep all contiguous chunks 0..firstgap), report exact loss.

### Release 2 — Electron combine integrity (integration-tested, desktop auto-update):
8. Salvage validated raw concat on ANY ffmpeg failure (`electron-main.js:2905` catch → rename `rawPath`→final if valid). 9. fsync combine output before deleting chunks. 10. Serialize recovery under `withRecordingLock` (fixes dual-size). 11. Per-RECORDING segment manifest (`segments.json`) — catches a whole lost segment. 12. Bug C: concat-demuxer + `+genpts -avoid_negative_ts`; harden `validateAudioOutput` (probe DTS) before deleting sources. 13. Gate auto-update on active recording. 14. Main-process `shouldForceStopRecording` timer.

### Release 3+ — NATIVE, device-gated (CANNOT be unit-tested here; MUST device-test before production):
15. Native fsync'd mobile chunk writes + real `getFreeDiskSpace` (StatFs / volumeAvailableCapacityForImportantUsage) + ENOSPC→diskFull. 16. iOS codec/extension fix (`.m4a` not `.webm`) + AVMutableComposition combine + real duration + AVAudioSession keep-alive + interruption observer wired to LIVE composable. 17. Android wake-lock/battery-opt + typed-mic FGS that OWNS the mic + heartbeat. 18. **Architectural decision**: move mobile recording off the killable WebView to a native recorder. Biggest prevention win, biggest regression risk — staged device testing only.

## GUARANTEE (honest)
After Release 1+2 (device-verify 3+): **No SILENT loss** — every stall/disk-full/interruption is detected, surfaced, and the partial recording is recoverable with a duration reflecting bytes on disk (never inflated wall-clock to billing). Crash loss bounded to ≤1 timeslice (3s) where fsync'd.
Residual: ≤3s on SIGKILL/power-loss; WebView-as-recorder is OS-killable until native move (detection ≠ prevention); mobile chunk durability is page-cache only until native fsync ships. Until native work ships+device-verified, mobile must surface a "keep app foreground/screen on for long recordings" constraint.
