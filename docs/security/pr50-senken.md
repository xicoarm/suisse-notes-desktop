# PR #50, review round 9: effect inventory of the main process (P0)

Base: `7c121955`, `src-electron/electron-main.js` (5569 lines) and its helper
modules. Generated with an AST pass over the top-level statements (every line
with a sink, mapped to its enclosing function or IPC handler), then classified
by hand. Sinks (council 3, R-S2): HTTP, writes/renames/unlinks/rm in the
recordings folder, receipts and recovery markers, `historyStore`,
`uploadQueueStore`, `activeRecordingStore`, `saveUploadOutcome`,
`updateUploadQueueRetry`, `webContents.send`, timers that schedule follow-up
work, the recording-lock queue and `child_process`.

Classes:
- **F foreground**: runs because the user (renderer) asked for it right now, or
  is part of recording/stop. Not rebuilt (council 3, section 2).
- **B background**: runs on its own (timer, startup, after sign-in, queue,
  retry, poll) or keeps running after the user's request returned. Moves to
  `src-electron/background/` and reaches sinks only through its `SessionScope`.
- **M mixed**: a helper that foreground and background share. Gets a port
  (the background caller goes through the scope) instead of being moved.

## Background entries (moved, B)

| Entry (7c121955) | Sinks at 7c121955 | After r9 |
|---|---|---|
| `processPendingUploads` (pending-uploads.js, factory :1095) | queue :1098/1099 via `removeFromUploadQueue`/`updateUploadQueueRetry`, history :1113, send :1117, timer :1120, `finally` inFlight.delete (pending-uploads.js:99) | `background/pending-uploads.js`, `run(scope)`; inFlight per (scope id, recordId) |
| `upload:start` body (:4538) | queue :4561/:4587, send :4564/:4601, `uploadWithRetry` | handler keeps the IPC frame (claim, power blocker); work in `background/upload.js` `runUploadStart(scope, …)` with the scope opened at the entry |
| `uploadWithRetry` (:4027) | `activeAbortControllers` :4061/:4091, receipt via `verifyAcceptedUpload` | `background/upload.js`; cancel handle per (scope id, recordId) in the registry |
| `tryDirectUpload` (:4101) + `upload-direct.js` | send :4116/:4121/:4138, ffprobe :4243, axios (upload-direct.js :154/:219/:321/:458/:574/:653) | `background/upload.js` + `background/upload-direct.js`, `scope.http`, `scope.port.probeDuration` |
| `uploadWithRetryLegacy` (:4271) | send :4292/:4374, interval :4367, axios :4400 | `background/upload.js`, `scope.http`, `scope.interval`, `scope.notify` |
| `verifyAcceptedUpload` (:658) | receipt write :664/:679, mkdir :663, history via `saveUploadOutcome` :669/:681 | `background/upload.js`, `scope.fs.writeFileAtomic` (rename via `commitRename`), `scope.update.history` |
| `pollServerStatus` (:3833) | axios :3863 without signal, sleep, refresh | `background/upload.js`, `scope.http`, `scope.sleep` |
| `pollMeetingTranscriptionStatus` (:3958) | axios :3972, sleep | `background/upload.js` |
| `refreshMainAuthToken` (:2437) | axios :2448, `applySession(refresh)` | `background/upload.js`, `scope.http`, `scope.applyRefresh` |
| `recoverOrphanedRecordings` (:735) | history :899/:924, active :958 + `clearActiveRecording` :746/:949/:956, send :935/:982, queue via `addToUploadQueue` :974, rescan timer :999, ffprobe via `getAudioMetadata` :848, lock+finalize via `combineChunksForRecovery` :1017 | `background/recovery.js`; finalization through the port `scope.port.finalizeForRecovery` |
| `cleanupOldOrphanedDirectories` (:1026) | rm via `rmDirSafeBestEffort` | `background/recovery.js`, `scope.fs.rmRecordingDir` |
| recovery/cleanup start (whenReady timers :1785/:1793) | no session check at all | `background.startRecovery(scopes)`: no scope, no recovery and no clean-up; started at startup and by `afterSessionApplied` (sign-in, SSO, release of a held start), once per session |
| `upload:cancel` blob clean-up (:4744) | axios via `abortDirectUpload` | `background/upload-direct.js` `abortDirectUpload(scope, …)` |
| `upload:startTUS` / `upload:pause` / `upload:resume` (:4626-4725) | tus requests, send :4675, `activeUploads` | **deleted** (no caller: preload exposes no `startTUS`; renderer calls only `start`/`cancel`) |

## Mixed helpers (M, port)

| Helper | Foreground callers | Background callers | Port |
|---|---|---|---|
| `finalizeRecording` (:3611) | `recording:combineChunks` | recovery (`combineChunksForRecovery`) | `finalizeForRecovery` port: runs in the durable-files publish gate of the scope (every rename in `durable-files.js` checks `scope.alive()` synchronously right before `fs.rename`), and the post steps (marker unlink, metadata/history, `clearActiveRecording`) go through `gate.assert()` |
| `withRecordingLock` (:2532) | saveChunk, createSessionFile, combineChunks, export | recovery | inside the `finalizeForRecovery` port: the queued callback asserts the publish gate first (`assertPublishAllowed()`), so it runs only while the scope is alive |
| `getAudioMetadata` / `validateAudioOutput` (:2567/:2854) | stop, import | recovery | `scope.port.probeAudio` (child process only while alive) |
| `addToUploadQueue` / `removeFromUploadQueue` / `updateUploadQueueRetry` (:686/:713/:721) | `upload:cancel`, `upload:removeFromQueue` | queue run, upload:start, recovery | pure mutators in `background/queue-ops.js`; foreground writes the store directly, background only through `scope.update.queue` |
| `saveUploadOutcome` (:639) | none left | verify, queue run | background only (`scope.update.history`) |
| `clearActiveRecording` / `updateActiveRecording` (:603/:593) | recording, power events | recovery | background through `scope.update.active` |
| `recordCaptureWarning` / `updateRecordingMetadataOnCompletion` (:3165/:3561) | stop | recovery (inside finalize) | covered by the finalize gate |

## Foreground (F, unchanged)

Recording and stop (`recording:*`, `systemAudio:*`, `mergeSystemAudio`,
`ffmpegWithTimeout`, `probeBinary`), history IPC (`history:*`), export,
sign-in IPC (`auth:*`, already ticketed in rounds 6-8), `minutes:fetch`,
`createWebSessionInMain`, updater events, tray, power/lock events, crash
handlers (`render-process-gone` :231 writes a crash marker), `ensureDir`.

## Count (Gestalter check, «more than about eight mixed callers»)

Seven mixed helpers, of which two carry real work (`finalizeRecording`,
`withRecordingLock`) and get ports; the queue helpers become pure mutators. So
the background code is moved, and only the mixed helpers get ports.

## New sinks found in P0

- `child_process` in recovery (`getAudioMetadata` → ffprobe) and in the
  direct upload (duration probe): added to the list (port `probeAudio` /
  `probeDuration`).
- The api-resilience retry (`api-resilience.js:119-129`): a request of its
  own after a sleep; checks `config.scope.alive()` before the retry.
- `mkdirSync` of the recording folder before the receipt (:663): gated.
- Progress intervals of the legacy upload (:4367): `scope.interval`.

`grep -rn startTUS src src-electron` is empty after P1.

## After P3-P6 (state of the branch)

- Moved: `src-electron/background/{upload,upload-direct,pending-uploads,recovery,queue-ops,ended,index}.js`.
  Main keeps only the IPC frames and passes the scope (`scopes.open()`) or
  the registry (`background.startQueue/startRecovery(scopes)`).
- Static rule: `tests/unit/mainBackgroundStatic.test.js` (ban list, factory
  keys, every `background.*` call with a scope first, moved names not
  defined in main) with negative mutation tests.
- Dynamic rule: `tests/unit/sessionSweep.main.test.js` (sweep N=1..max).
- Effects after a session change that remain, by design: the own
  unpublished temp file of an interrupted durable write is unlinked
  (`durable-files.js`, `writeFileAtomic` clean-up); nothing is published.
