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

## Review round 10: one checked sink per kind (lead decision)

Every file, child-process and renderer effect of main's background work now
goes through ONE checked sink per kind, checked synchronously right before
the system call (no await in between). Another single path that bypasses
it is a regression (switch it to the sink, add it to the ban list and the
sweep), not a design question.

| Kind | The sink | Check | Commit |
|---|---|---|---|
| Files (recordings folder) | `src-electron/effect-gate.js`, installed by main before any other module: every write-class call of the `fs` module (sync, callback, promise API) and every FileHandle write (`write`, `writev`, `writeFile`, `appendFile`, `truncate`) on a path, descriptor or handle of the recordings folder | the publish gate of the asynchronous context (`publishGate`, set by the scope for ports and durable writes) right before the call; refused with the scope's `SessionEndedError` | F1 |
| Child processes | the same gate on `child_process.spawn/execFile/exec/fork` and the sync variants (every start in a gated context, also the ones fluent-ffmpeg makes from its own callbacks) | as above; a refused start returns an already-dead child that emits the error | F3 |
| Renderer events | `sendToRenderer(channel, payload)` in main; the registry's `send` is the same function | `assertPublishAllowed()` right before `webContents.send` | F2 |
| Stores (history, queue, active) | `scope.update.*` (commit) in `background/`; in the finalization chain `updateRecordingMetadataOnCompletion` and `clearActiveRecording`, each right after an explicit `assertPublishAllowed()`, synchronously | alive() / publish gate | r9, unchanged |

Allowed after a change, by design: removing an own unpublished temp file
(`<name>.<uuid>.tmp`); the internal calls of an fs call admitted before the
change (rm walking its tree); a child process already running is not
killed (its output is published only through the gate).

### Audit of the mixed helpers of the recovery chain (round 10, F1)

All of them run inside the port `finalizeForRecovery` (publish gate of the
scope). Before round 10 each had direct system calls the gate did not see;
now every one of them is a call at the fs/child_process boundary.

| Helper (module) | Effects | Seen by r9 review | Now |
|---|---|---|---|
| `archiveChunkBatch` (durable-files) | readdir, mkdir(source-chunks), rename, mkdir(chunks) | F1: mkdir after readdir ungated | fs gate |
| `writeFileAtomic`, `publishFile`, `concatenateFiles` (durable-files) | open(wx), handle.writeFile/sync, rename, write stream | handle writes not counted (F4) | fs gate (handle writes included) |
| `createSessions` / `finalize` (recording-persistence) | mkdir(sessions), unlink(source_raw), plan/receipt writes, rm(superseded scratch) | F1: :42, :66 | fs gate |
| `finalizeNative` / `build` (recording-persistence, native-source-finalization) | mkdtemp(scratch), plan writes, publish, ffmpeg via `run` | F3 | fs gate, process gate |
| `inspectEncodedOpus` / `probeLines` (encoded-opus-evidence) | ffprobe spawns (two), reads | F3: second spawn after the first | process gate; `spawn` looked up at call time (no capture at load) |
| `getAudioMetadata`, `probeDurationSeconds`, `ffmpegWithTimeout` (main) | execFile ffprobe, fluent-ffmpeg spawns | explicit assert at entry only, spawn later from callbacks | process gate |
| `prepareRawSessionFile` (main) | write stream, unlinkSync, renameSync | not covered | fs gate |
| `mergeSystemAudio`, `notifyMergeDegraded`, `recordCaptureWarning` (main) | unlink(merged), metadata write, `system:capture-warning` | F2: gate error swallowed, send after the change | `SESSION_ENDED` rethrown at once; send only via `sendToRenderer` |
| `updateRecordingMetadataOnCompletion` (main) | metadata write, history store | error swallowed | rethrows `SESSION_ENDED`; fs gate + explicit assert before the store |
| `finalizeRecording` (main) | pending marker unlink, all of the above | error turned into `{ success: false }` | rethrows `SESSION_ENDED` |

The sweep (`tests/unit/sessionSweep.chain.main.test.js`) runs this whole
chain as it is - only ffmpeg/ffprobe are replaced, at the child_process
boundary - and counts at the module boundaries (`tests/unit/support/globalSinks.js`).

### What keeps the sinks single (round 10, F4)

- Static rules (`tests/unit/sessionSweep.static.test.js`): main installs the
  effect gate before it loads any module other than electron, path and fs;
  no module of main captures fs or child_process functions at load (the
  module object and `fs.promises` only); no `original-fs`, `process.binding`,
  `internalBinding` or worker threads; `webContents.send` exists once, in
  `sendToRenderer`, and the registry's `send` is that function.
- Mutants (`tests/unit/support/mutants.js`, run by
  `tests/unit/sweepMutation.main.test.js`, each in a child process of its
  own, applied when src-electron is loaded): per sink kind «sink off» and
  «bypass» - fs gate off, fs gate not installed, a new write past the gate;
  spawn gate off, a new child process past the gate; send check off, a new
  event past `sendToRenderer`. Each must turn the sweep red with a
  violation of its kind; the controls (unmutated, the same new paths
  through their sinks) stay green and the new paths run in the baseline.

### Retry count of the upload queue (round 10, F5)

Before the upload the queue entry gets `attempt: { epoch, startedAt }`
(`queueOps.startAttempt`, through `scope.update.queue`). The next run of the
same session (same epoch: a crash, the app restarted) counts a marker left
without an outcome as an attempt (`settleAttempt`), so the limit of 10
removes an entry that crashes the app every time (history `failed`, the
source file is kept). A marker of another session is cleared without
counting (R-S3: an attempt ended by a session change is no attempt); an
attempt with an outcome clears it (`bumpRetry`, removal on success).

## Review round 11: the file sink at the system call, the oracle on its own

Same course (one checked sink per effect kind); the file sink now closes
what review round 10 showed at the system call itself (F6, point 3) and
the sweep's oracle no longer shares its blind spot (F7). Fail-first:
`docs/security/pr50-r11-failfirst.txt`.

| Gap (r10 review) | Before | Now | Test |
|---|---|---|---|
| F6 numeric open flags | `writeFlags` read a number as digits: `openSync(p, O_WRONLY \| O_TRUNC)` emptied `metadata.json` after the end; its descriptor/handle was not remembered | flags by their bits (`O_WRONLY`, `O_RDWR`, `O_CREAT`, `O_TRUNC`, `O_APPEND`) or the string table; sync, callback, promise open, write streams (they open through `fs.open`), `readFile` with a writing flag | `effectGate.flags.test.js` (F6 block) |
| F6 `open(path, callback)` | read as writing (the callback's text matched) | read | same, control |
| Point 3 aliases | lexical comparison only | lexical first; otherwise the real path of the nearest existing ancestor (a dangling link to its target; for calls on the name itself - unlink, rename, mkdir, rm, link, symlink, l* - the parent's), letter case folded on macOS and Windows; `link` checked on both names | same, alias block |
| Point 3 provenance | descriptors/handles counted only when opened for writing inside a gated context | every descriptor and handle opened for writing is remembered with its path (any context; removed at close, before the number can be reused); a write to it in a gated context after the end is refused if its path is in the folder | same, provenance block |
| F7 oracle | `classify` used the same string-only flag test | its own reading (Node's string table: only r, rs, sr read; numbers by access mode and O_CREAT/O_TRUNC/O_APPEND; anything else counts); aliases resolved for effects; descriptors remembered before binding | `globalSinks.flags.test.js` |
| F7 independent of the counters | - | every swept run snapshots the recordings folder at the change and compares it before the resumption: no file that existed changed its bytes, no file appeared (own `.uuid.tmp` files and the scratch of a running native child process aside; removals are counted effects) | `support/sweep.js` `contentAfter` |

New mutants (`tests/unit/support/mutants.js`): `fs-open-flags-string-only`
(the gate's round-10 flag test plus a numeric open through the sink - red),
`fs-open-trunc-bypass` (O_WRONLY|O_TRUNC of metadata.json past the gate -
red as a counted effect AND as changed content), `fs-open-creat-bypass`
(O_WRONLY|O_CREAT past the gate - counted AND seen as a new file). The
control `paths-through-sinks` adds a numeric O_WRONLY|O_CREAT|O_TRUNC open
through the sink: it is counted in the baseline and the sweep stays green.

Limits that remain (documented, not a gap of a current caller): a hard link
to a file of the folder made outside the fs module or before the gate (main
makes none; `link` is checked on both names), descriptors from outside the
fs module (static rules: no `original-fs`, bindings or workers in main).

### Windows CI time (round 11)

Windows ran the sweeps about seven times slower per run than Linux (68 min
for lint-and-test, the two sweep files 62 min of it). The sweeps keep every
point on Linux and macOS on every commit; the Windows runner runs a sample
(`SWEEP_SAMPLE=0.15`, fixed seed `r11`, per entry the first two and last two
points always - about 28 % of the points of the main sweep, 18 % of the
chain). The gate is the same JavaScript on all three systems; what is
Windows-specific (paths and letter case, CRLF, rename retries) sits in the
named points, the mutants and the unit probes, which are never sampled. The
mutants of the scope (`sessionSweep.main`, «alive() removed») stop at the
first violation that kills them, on every system.
