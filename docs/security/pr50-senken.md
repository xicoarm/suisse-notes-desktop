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

## Review round 12: the alias class, fail-closed

Superseded by round 13 (below): the path, alias and descriptor logic of this
section is gone from the gate and the oracle; kept here as the history.

Same course. Round 12 closes the class «path and descriptor alias», not only
the three cases of the r11 review (F8-F10). Rule in the ended gated context:
a call passes only when it is PROVEN that it does not reach the recordings
folder; when that cannot be proven it is refused. Fail-first:
`docs/security/pr50-r12-failfirst.txt`.

| Gap (r11 review) | Before | Now | Test |
|---|---|---|---|
| F8 link plus «..» | `path.resolve` collapsed «..» before any link was read: `/out/link/../metadata.json` (link -> folder/c1/sub) passed and emptied `c1/metadata.json` | the path is resolved as the system does it, name by name with `lstat`, a link followed where it stands BEFORE a later «..» goes up from its target (at most 40 links); a missing name is appended as it is, «..» after it is not decidable; the parent for calls on the name itself; and, as a second reading, after collapsing «..» first (what Windows and Node there do); macOS/Windows: letter case folded, Windows: the system's own spelling of the existing part (short names), junctions are links | `effectGate.flags.test.js` (round 12 F8), class probe |
| F8 not decidable | resolution errors fell back to the lexical path | a loop (ELOOP, > 40 links), no access, a name that is no folder, «..» after a missing name, an unreadable link, a device or drive-relative path (`\\?\`, `C:x`): refused after the end | same |
| F8 hard links | not resolved (documented limit) | a write to the content or attributes of a file with a second name (`nlink > 1`) is refused after the end; calls on the name (unlink, rename, rm) of a hard link pass | same, class probe |
| F9 provenance | the descriptor/handle kept its path; the decision was made at the first use, by the then current alias | every open (any flags, any context) holds what it found until the close: the file's identity (`fstat` dev/ino), the resolved path and whether it was a file of the folder or not decidable. A call on a descriptor passes only for a pipe, terminal or socket, or for a file its open found outside that is still the same file (dev/ino), still outside and has no second name; an unknown descriptor of a file is refused | same (round 12 F9: alias removed/renamed, after logout and after login B) |
| F10 reading opens, attributes | only writing opens were remembered; fchmod/futimes on a reading descriptor passed | all opens remembered; fchmod, futimes, fchown, handle.chmod/utimes/chown, chmod, utimes, chown, lutimes, lchmod, lchown through the same sink | same (round 12 F10) |
| Oracle F8-F10 | normalized before resolving; descriptors by path | its own resolution (the system's `realpath` of the raw path, missing names appended, a dangling link by its target), descriptors and handles by what their open found, else by identity (a file with the same dev/ino in the folder), FileHandle arguments of `fs.promises.writeFile` | `globalSinks.flags.test.js` (round 12) |
| Oracle attributes | content compared only | the snapshot of every swept run compares bytes, mode and mtime (`attributes changed after the change`) | mutant `fs-attr-bypass` (utimes of metadata.json past the gate: counted AND seen) |

The order of the checks changed: in a gated context the refusal of the
context is asked first and the path examined only after the session ended
(the gate-off mutants follow the new lines). Before the end and outside a
gated context nothing is refused; only the open's findings are recorded.

### Class probe (`tests/unit/effectGate.aliasClass.test.js`)

A generative test, fixed seed `0x5e12` (it picks the writing open flags of
each cell): path form {direct, relative, symlink to a file, symlink to a
folder, symlink plus «..», chain of links, dangling link, hard link, letter
case (macOS, Windows), junction (Windows)} x effect {open sync/callback/
promise, writeFile (existing and new), appendFile, writev, truncate, chmod,
utimes, chown, rename, unlink, link, copyFile, cp, mkdir, rm - each sync,
callback and promise - and a write stream; on a descriptor or handle:
write, writev, ftruncate, fchmod, futimes, fchown, writeFile, appendFile,
write streams, fs.promises.writeFile(handle), fs.writeSync(handle.fd)} x
origin {path call in the ended context; descriptor/handle opened in the
ended context; opened in the foreground for reading or writing, the alias
then removed or renamed}. Each cell: refused, bytes/mode/mtime of every
entry of the folder unchanged, and the same call let through (session
alive) counted by the oracle. Calls on a link itself (unlink, rename, rm,
mkdir of a symlink or hard link outside) pass and are not counted; control
cells outside the folder (log file, its links, a sibling `Recordings-old`,
an update file; path and descriptor effects) pass. On Windows the «..» form
is refused on its POSIX reading only (Node collapses «..» first, the call
lands outside): the oracle has nothing to count there.

Limits that remain: a path changed by another process between the check and
the system call (no current caller; external race), file systems that fold
the letter case on Linux, descriptors from outside the fs module (static
rules as before).

## Review round 13: context, not path (council desktop 4, R-S7)

The class of path, alias and descriptor provenance cannot be closed (rounds
10 to 12), and the normal recording path paid for it. The gate no longer asks
where an effect lands, only in which context it runs. Fail-first:
`docs/security/pr50-r13-failfirst.txt`.

| Rule | Where |
|---|---|
| R-S7.1 effect: the gated `fs` list (sync, callback, promise), FileHandle writes, writing opens, `child_process` starts, `sendToRenderer`. No effect: reading, `close`, `fsync`, reading opens | `effect-gate.js` `NAME_WRITES`, `FD_WRITES`, `HANDLE_WRITES`, `isEffect` |
| R-S7.2 in the context of an ended session every effect is refused, whatever its target, spelling, descriptor or origin | `refusalFor`, `refusalOf` |
| R-S7.3 without a context and in a living session: the direct call, no extra system call, no entry per open | `gateSync`, `gateCallback`, `gatePromise` |
| R-S7.4 the context is created only by `runInSession` (scope's `gated()`); `bindSession` for what fires from a foreign context | inventory below |
| R-S7.5 way out: only `appLog`, `telemetry` (`app-ports.js`), `authorityPersist` (private, `session-authority.js`), each through `sealPort`: fixed destination, no path, no callback | static rules `auditContextExit`, `auditPorts` |
| R-S7.6 an admitted Node operation runs to its end inside; `cp`, `cpSync` and non-binary data for `writeFile`/`appendFile` are refused in every session context, a living one too; process starts ignore `admitted` | `runsForeignCode`, `startRefusal` |
| R-S7.7 an exclusive open remembers its exact string per session context; after the end that allows exactly one unlink of exactly that string. Any other rest stays until a session of its owner clears it | `rememberTemp`, `refusalFor` |
| R-S7.8 running media processes are not killed; no new workers, `utilityProcess`, addons, `original-fs`, `process.dlopen`, bindings, raw `http`/`net`/`shell` in the port chain and `background/` | static rules, `chainModules`, `lockfileFindings` |

«Every context» in R-S7.6 means every session context: without a context (the
foreground) R-S7.3 holds and `cp` or an iterable run as ever. Today's callers of
either: none in `src-electron`.

### Listeners, queues and callbacks of the port chain (R-S7.4)

| Site | Fires from | Effect in the handler | Decision |
|---|---|---|---|
| `withRecordingLock` queue | the previous link's end | the whole finalization | `bindSession(fn)`; a refusal rejects the link |
| `ffmpegWithTimeout` `.on('error')` | fluent-ffmpeg | health record, telemetry, the gate's check | `bindSession(fn, reject)` |
| `ffmpegWithTimeout` `.on('end')`, `start`, `stderr`, `progress` | fluent-ffmpeg | none (local state, resolve) | not bound: no effect |
| `ffmpegWithTimeout` wall and silence timer | own timer of this context | kill of its own process, telemetry | same context |
| `prepareRawSessionFile` `out`/`src` `.on('error')` | its streams | unlink of its temp | `bindSession(fail, reject)` |
| `prepareRawSessionFile` `.on('finish')` | its stream | none (resolve) | not bound |
| `encoded-opus-evidence` `proc.once('close')` | the child | the gate's check | `bindSession(fn, reject)` |
| `encoded-opus-evidence` `proc` `data`, `error` | the child | none (parse, reject) | not bound |
| `native-source-finalization` `.on('stderr')` | fluent-ffmpeg | none (parse) | not bound |
| `probeDurationSeconds`, `getAudioMetadata` callbacks | fluent-ffmpeg | none (resolve) | not bound |

Settings, updates and crash markers are no part of the port chain (static rule on
its closure). No real flow of today loses its context where `bindSession` could
not reach it.

### Oracle and probes

The oracle (`support/globalSinks.js`) has no path logic any more: every effect
counts, whatever its target; the recordings folder only marks suspension points.
After the change any effect is a violation, in the old context or without one
(P3). What code of the caller does inside `cp` or a non-binary write is no part of
that call (no `inside` around them). The removal an exclusive open earned is on
the oracle's own books, by the exact string. The snapshot covers an external
canary folder too. An interval that outlives the session's end is an app service
started in its context (P4).

Class probe (`tests/unit/effectGate.contract.test.js`): argument form {String,
Buffer, URL, FD, Handle} x effect x API x target {recording, external}: in the
ended context all refused, nothing counted, nothing changed; the same matrix alive
and without a context: all through. `tests/unit/sessionSweep.data.main.test.js`
(P5): logout, login B and A at every point, then a restart: sources byte-identical,
recording published, no false receipt, one resumption, no failed attempt, on stub
media. `tests/unit/sessionSweep.media.main.test.js` (P5, round 14, F15): the same
runs at the first, middle and last point of upload, rename retry, finalization,
re-scan, system audio merge and native sources and of a 10-minute recording in 300
chunks, with valid media, the real ffmpeg/ffprobe in the chain and the decoder as
the judge: samples and their hash against the source (recordings encoded again:
length and eight correlated windows), stated duration, and the object of the
accepted upload is the file. Mutants: truncated, corrupted, short from the chain
itself, chunk lost, wrong object. `tests/e2e-harness/qualification.js` (round 15):
native timestamps against the synchronous start() and stop() calls, in both
directions, threshold 0.5 s, and against the numbered frames; a run without both
calls is invalid; the start event measure is an observation only
(`docs/security/pr50-r15-failfirst.txt`).

Round 14 (F16): the snapshot hides nothing by name, not in the recordings folder
and not in the external canary folder. Exempt is only what the run proved: the
exact path of a successful exclusive open, and a file in the exact folder a mkdtemp
of the run returned while a process that was running at the change names it
(`tests/unit/sweepSnapshot.main.test.js`).

Limits that remain (documented, not blocking): a mechanism ruled out statically
without a caller; an external process; an effect already handed to the system.
Path alias, hard link and descriptor provenance are no class of findings any more.

Mobile (R-S7.9) has no gate, no context and no fs patch. The TUS timeout fallback
(`src/services/upload.js`, `uploadFileMobile`) has no caller: not reproducible
today, pinned by a static rule.

Measurement: `.github/workflows/gate-measure.yml`, `scripts/perf/`.
