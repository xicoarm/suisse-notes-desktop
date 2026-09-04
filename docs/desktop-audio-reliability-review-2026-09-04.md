# Desktop audio reliability review — 4 September 2026

Status: implementation and evidence are on local branch `fix/desktop-audio-reliability`; latest implementation commit `427a06a`, no release or production deployment. This is not a certification of lossless capture. Physical failure, forced shutdown, a disconnected microphone, and audio that never reaches the capture process cannot be repaired by software after the fact.

## Scope and evidence

Reviewed the Windows and macOS recording paths separately, their shared MediaRecorder/disk/upload lifecycle, device replacement, pause/resume, crash recovery, history and deletion, account changes, background retries, power management, packaging and monitoring. Starting desktop commit: `4272af7134384cf750ae0b18b25754b752834f0f`, version 4.6.0, installed Electron 28.3.3. The initial checkout was clean and synchronized with origin/main.

Read the deployed backend through SSH without modifying it: `/home/ubuntu/Suisse-Notes-V2`, master, commit `838ea462511db7be253bae91f9254b09864f8255`. Reviewed upload and status route implementations. Read relevant Sentry diagnostics without accessing customers’ meeting audio. Automated audio tests use synthetic speech in isolated Electron profiles and a local mock backend.

Production evidence includes ELECTRON-1Y (Apple Silicon, macOS 26.5.2, desktop 4.6.0: both media binary probes timed out at five seconds), ELECTRON-23 (Windows 4.6.0: no persisted chunk for 59 seconds), ELECTRON-47 (Windows 4.6.0: loopback digital silence), and ELECTRON-9 (Windows 4.6.0: child process failure). Device diagnostics mention Jabra Evolve2 75, Jabra Link 380, AI Speakerphone and EPOS IMPACT 860T ANC. Event counts are not incidence estimates and do not establish which hardware model caused a failure.

## Shared recording and storage fixes

| Priority | Failure before this change | Implemented protection |
| --- | --- | --- |
| Critical | A failed final session could be omitted while earlier sessions were combined and source chunks deleted. | Normal stop and recovery share one finalization transaction. Every source batch must be processed; failure preserves the sources. |
| Critical | Async Blob conversion could reorder writes; stop could combine before the last conversion/save completed. | Reserve blob order synchronously. Keep one data handler through the final stop event. Drain every accepted write before finalization. |
| Critical | A failed chunk was dropped and a later blob could reuse its index. | Keep failed blobs in memory in their original position, stop capture after exhausted retries, block a new recording while bytes remain unsaved, and allow an in-place save retry. |
| High | Failed writes retained only in memory could outlive recording state and lose quit protection. | Track unsaved audio in the main process. Refuse closing, quitting, update installation, upload, recovery and deletion until save retry succeeds or the user explicitly discards it. Ordinary quit during capture requires Stop first; forced OS termination remains a physical limit. |
| High | Final files and merged audio were renamed/replaced without a complete durability protocol. A Windows file lock could interrupt replacement. | Write all bytes to a unique temporary file, flush, close, then rename with bounded Windows sharing-violation retries. Never unlink the old destination before replacement. |
| High | Session rotation paused capture during FFmpeg work, and assumed each batch was independently parseable. | Rotation only archives a chunk directory under the recording lock. Capture keeps running, indices remain monotonic, and all retained blobs are joined in original order before one remux. |
| High | Recovery skipped any existing audio.webm, including partial output or a file never added to history. | Publish a finalized receipt with SHA-256, size and source fingerprint. Rebuild interrupted outputs and repair history. A late source chunk invalidates the receipt. |
| High | Header/size validation could hide a missing middle chunk. | Refuse final publication when preserved source indices contain a gap or duplicate. Original audio remains available for recovery. |
| High | A PCM-only interrupted Mac session could be invisible to recovery. | Discover surviving system PCM and support recovering it when no microphone segment exists; retain a warning that the microphone source is missing. |
| High | Truncation checks used a chunk-clamped duration and ignored losses below 30 seconds or 10% of the meeting. | Compare decoded duration with an independent monotonic active-time clock, excluding pauses. Warn at a five-second shortfall even for long meetings; retain audio and sources for review. |
| High | A timed-out final stop could be retried too early or displaced by a new recording; stale errors could stop the next recorder. | Keep pending final audio protected, reject a new start until the old stop completes or is explicitly discarded, and scope data/stop/error callbacks to their recording generation. Persist uncertain-stop warnings and preserve sources. |
| High | Metadata updates could erase processing warnings. | Merge and retain main-process capture warnings when renderer metadata is updated, keeping evidence of interrupted or degraded capture. |
| Critical | History deletion derived a recursive-delete directory from filePath; an imported path could escape app storage. | Restrict recursive deletion to one direct child of the managed recordings folder. Derive it from validated recordId. Keep failed or busy entries in history. |
| High | Idle suspension could interrupt capture or processing. | Hold Electron’s prevent-app-suspension blocker during recording, finalization and in-flight uploads. |

Sources and derived sessions now survive successful finalization and upload until explicit deletion. Automatic local deletion is paused under the current backend contract, including for previously saved receipts that granted deletion. Settings, the recording storage dialog and History explain this policy; the saved preference is preserved. This intentionally uses more disk. A Mac PCM track alone is approximately 346 MB per recorded hour (48,000 mono samples/second × 2 bytes). Saved chunks, derived output and merge working files require additional space; finalization checks free space and retains sources on ENOSPC.

The completion checksum detects local final-file corruption; it is not a server checksum. Source fingerprints detect changed/late files by identity, length and modification time, rather than hashing every source again at each restart.

MediaRecorder guarantees playability for the combined recording, not each timeslice blob. Its final data event precedes stop, and its timeslice is not a scheduling deadline. Those constraints explain the ordered writer and continuous-stream finalization design. [W3C MediaStream Recording](https://www.w3.org/TR/mediastream-recording/)

## Windows review

Capture uses Chromium getUserMedia for the microphone, a Web Audio mix, MediaRecorder WebM/Opus, and desktop capture for loopback system audio. A live track and a moving duration display do not prove that speech is being recorded. Existing signal monitoring is therefore retained alongside persistence monitoring.

Implemented microphone changes:

- Connect a replacement before releasing the working input; if graph creation fails, retain the old microphone.
- Preserve the user’s mute state on replacement.
- Dispose acquisitions that complete after Stop or after another switch supersedes them.
- Bound each device acquisition and dispose late results.
- Same-device recovery relaxes processing constraints while retaining the exact selected device. It cannot silently switch to a room microphone when a headset is muted.
- Trigger recovery from track-ended as well as devicechange, so event ordering does not strand a disconnected microphone.

Implemented loopback changes: invalidate pending starts on Stop; reject stale rebind completions after another composable instance owns capture; remove the previous instance’s monitor when stopping from a remounted page.

Windows Bluetooth Classic can switch from A2DP playback to HFP when a microphone opens. WASAPI loopback captures a rendering endpoint, so the meeting app’s output and the captured endpoint must agree. Opening Teams/Zoom, changing default communications output, reconnecting a dongle, and changing a headset profile must all be tested with an audible reference signal. [Microsoft Bluetooth audio](https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/bluetooth-classic-audio), [Microsoft loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)

Device enumeration and track-ended events are useful signals, but their timing is not a reliable transaction boundary. Signal measurements must verify the replacement. [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)

Remaining Windows validation: physical USB unplug/replug, hub power loss, Bluetooth range/battery/profile changes, hardware mute, endpoint changes during a meeting, screen lock, Modern Standby, lid close, low disk and antivirus contention. Simulated tests exercise application behavior; they do not certify a Windows driver or headset.

## macOS review

The microphone follows the shared Chromium path. On supported Macs, AudioTee captures separate 48 kHz mono signed-16-bit system PCM; FFmpeg merges it with the microphone after capture. This makes lifecycle and timeline alignment especially important.

The startup sequence previously invoked system-audio capture before creating the new recording ID. This could pass null or the previous meeting’s ID to AudioTee. Session creation now precedes helper startup; successful native capture also updates the initial system-audio state. A regression test starts with a previous meeting ID and checks that the helper receives only the new ID. The store keeps session/helper preparation separate from confirmed MediaRecorder capture so preparation does not prematurely show a running recording. Failed starts stop the helper and release recording/power flags.

Implemented AudioTee changes:

- Honor disk backpressure instead of accumulating an unbounded writable queue.
- Surface disk-open/write errors and unexpected helper termination; retain a capture warning and notify the user.
- Wait for a real startup signal and successful file opening, with a startup deadline.
- Parse fragmented stderr JSON correctly.
- Flush during capture and on final close; wait for late stdout and writable completion before merging.
- Send SIGTERM, then escalate to SIGKILL if the child has not closed. Node’s killed flag only means a signal was sent.
- Exclude paused audio at ingress, retaining already accepted pre-pause writes.
- Serialize helper stop/start operations and preserve raw PCM after merging.

The startup media-binary health timeout is now 30 seconds and produces an inconclusive result rather than permanently disabling media processing. Real ffprobe operations have a bounded deadline. The production five-second timeout is verified evidence; Gatekeeper or cold launch is a possible explanation, not an established root cause. [Node child-process lifecycle](https://nodejs.org/api/child_process.html#subprocesskilled), [Node file operations](https://nodejs.org/api/fs.html)

Apple documents that Bluetooth audio quality changes when an app uses the headset microphone. Test both headset input and a separate USB/built-in input with the same meeting output. OS permission prompts, first launch of signed helpers, Intel versus Apple Silicon, sleep/wake and output routing require real Macs. [Apple Bluetooth audio guidance](https://support.apple.com/en-us/102217), [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer)

No Mac was available in this session. AudioTee lifecycle tests run with child-process/stream fixtures on Windows; they are not macOS integration tests or notarized-binary validation.

## Transfer and backend contract

Deployed endpoints `POST /api/desktop/upload` and `GET /api/desktop/upload/{audioFileId}/status` exist. Deployed master does not contain `/api/uploads/init`, `complete` or `abort`. The desktop’s existing 404 fallback therefore remains necessary. This change introduces no new backend HTTP endpoint and does not deploy the separate SAS branch.

The deployed legacy route validates a maximum 500 MiB and five hours, writes the uploaded audio to Azure or local storage, then creates a Meeting. Its deduplication uses authenticated user ID plus the desktop recording ID (botSessionId), including a transaction/advisory-lock check. The status route is scoped to the authenticated owner and can return 404 for a missing recording. A successful status read does not independently read or checksum the blob.

Implemented transfer changes:

- Stop treating 404, exhausted authentication recovery, an unknown enum or UPLOADING as verified storage.
- Persist the server’s accepted audio identifier before confirmation polling. Restart/retry verifies that identifier rather than blindly retransmitting already accepted audio.
- Bind receipts to owner and the source file size/mtime captured before transfer. A changed upload file requires review instead of being silently deduplicated against the wrong content. Both initial and confirmed receipts deny automatic deletion; contentVerified is explicitly false because the existing API does not verify content equality.
- Preserve the main process’s verification and canDelete verdict through the renderer; remove the second, weaker confirmation path.
- Persist success/pending-verification history in the main process, and refresh renderer history after background completion. A failed confirmation now exits the uploading screen into a retryable error; retry keeps the existing history entry.
- Scope queued and retried uploads to the recording’s owner, including each direct-upload attempt. Abort active requests on logout.
- Keep confirmed uploads successful while refusing automatic deletion: a recognized Meeting status is insufficient proof of remote audio integrity. Main-process enforcement also refuses old receipts that granted deletion. Explicit manual deletion remains available, with busy/unsaved-audio and managed-directory protections. Callers must honor a refused deletion before clearing the local path.

Unknown outcomes now retain local audio and the accepted receipt. Explicit server rejection, no credit, unsupported media, and authentication problems still need user-visible resolution. Retrying a transport cannot fix a terminal backend validation failure.

The Azure configuration was checked read-only through the backend’s configured Blob service, without listing or reading meeting blobs: StorageV2, Standard_LRS, blob soft deletion enabled for 30 days, and permanent deletion of soft-deleted snapshots/versions not enabled. LRS replicas stay within one datacenter; they do not provide a second-site recovery copy. Blob soft deletion has a limited recovery window and does not itself protect against deleting a container or storage account. These settings do not establish that a particular meeting arrived intact or that recovery has been tested. [Microsoft redundancy](https://learn.microsoft.com/en-us/azure/storage/common/storage-redundancy), [blob soft deletion](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview)

## Outstanding release blockers and architectural limits

1. **Meetings over five hours:** source capture/rotation is protected, but the deployed backend still rejects a combined file over five hours or 500 MiB. Do not market unlimited recording-to-transcription. A complete solution needs coordinated part uploads/assembly or a validated backend limit change, including charging, idempotency, processing and UI behavior.
2. **No end-to-end storage proof:** status confirms a Meeting row under the current backend contract. Automatic local deletion is now paused to mitigate this gap. Add server-side blob existence/length/checksum verification and persistent upload receipts before enabling automatic deletion or claiming byte-for-byte durable remote custody. The read-only Azure check found StorageV2 with Standard_LRS and 30-day blob soft deletion. Container recovery, versioning and restore policy were not returned by that service API and remain unverified; no restore drill was performed.
3. **Capture still depends on the renderer and OS audio stack:** a renderer crash can lose the current unpersisted timeslice and cannot record subsequent speech until capture resumes. The nominal chunk interval is three seconds; CPU stalls, disk stalls and OS scheduling can extend that interval. A native capture service with a small durable spool would reduce this dependency; independent recording redundancy is required to survive destruction of the sole device while offline.
4. **Unsupported runtime:** Electron 28.3.3 is outside Electron’s supported major-version window. Plan a separate supported-runtime migration with real capture, permission, helper-signing and auto-update regression tests. A blind major bump inside the persistence fix would add unmeasured audio changes. [Electron support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines), [release schedule](https://releases.electronjs.org/schedule)
5. **Hardware and endurance qualification:** Intel Mac, Apple Silicon Mac, physical Windows devices and a true five-plus-hour soak remain unvalidated. Accelerating a timer tests branch logic, not five hours of memory, disk, driver and battery behavior.
6. **Durability has physical boundaries:** filesystem flush reduces crash loss but cannot guarantee a failing drive honors it. Windows Node does not expose directory fsync. A user-forced sleep/shutdown can override an idle-sleep blocker. Audio from a disconnected/muted source never reached the recorder. [Electron power blocker](https://www.electronjs.org/docs/latest/api/power-save-blocker), [power events](https://www.electronjs.org/docs/latest/api/power-monitor)
7. **Unexplained empty capture:** one real-Electron synthetic run persisted no chunks. A subsequent instrumented run succeeded, but cannot establish the earlier cause. Preserve the failed evidence and investigate with recorder-event, WebAudio and disk-progress diagnostics before release.

## Validation and release gate

Automated final full-suite result: 205 tests passed across 23 files (`npx vitest run --maxWorkers=2 --minWorkers=1`). This includes the macOS recording-ID, preparing-state, independent elapsed-time, pause, system-clock-change and failed-write retry/quit-protection, late final-stop, discard, stale-error and successful-upload retention regressions. An earlier full-suite run competing with Electron startup exceeded the existing five-second auth-test timeout; the final run with bounded workers passed without increasing that timeout. Coverage includes delayed final saves, blob order, retained failed writes, failed remux/retry, late source chunks, same-size final-file corruption, chunk gaps, PCM-only recovery, atomic-replacement failures, unsafe deletion paths, device-switch races/mute/graph failures, loopback rebind ownership, AudioTee late stdout/pause/disk failure/termination escalation, verification flags and owner matching. The pre-existing store stop-phase test was corrected to expect the actual completed state, stopped.

Expanded lint over app, Electron and harness/unit sources: zero errors, 50 warnings (unused names and existing Vue formatting/security warnings). Electron production compilation with `npx quasar build -m electron --skip-pkg` passed; publishing was disabled. This is compilation, not a signed installer or macOS build. Shared renderer modules also serve Capacitor; no mobile release or device validation was performed. CI now runs unit tests on Ubuntu, Windows and macOS, but the remote jobs have not run because no branch was pushed.

Windows real-Electron baseline passed: 233.22 seconds decoded, zero sustained energy holes, 21/23 pilot detections, one upload attempt. Two unmatched short pilot pulses are documented by the verifier as codec/jitter diagnostics; this is not proof of sample-perfect recording.

Windows session rotation passed: 475.7 seconds decoded after crossing two accelerated three-minute boundaries; three archived source batches containing 160 chunks remain on disk. The verifier found zero sustained energy holes and 47 pilot detections. It reported one unmatched/one extra short pilot and a decoder timestamp warning, so this is not sample-perfect certification. Windows upload-custody integration passed: unknown status, 404 and 401 preserved local audio and refused automatic deletion. Subsequent confirmation reused the original accepted ID with exactly one upload POST. The multipart audio SHA-256 matched the local file. A local mutation after confirmation invalidated deletion permission. This test validates custody decisions, not acoustic continuity. Windows renderer-crash recovery passed: a forced Page.crash at 90 seconds, whole-app restart, and automatic recovery produced 87.1 seconds with no sustained energy holes in the recovered prefix. The approximately 2.9-second tail difference and one extra pilot pulse are disclosed; this does not demonstrate zero loss at the crash boundary. Recovery repaired the history entry and retained the original source batch. Test data remains in ignored `tests/e2e-harness/work` and `work/reliability-*.log`; customer recordings and secrets are excluded from commits.

Windows network-interruption integration passed all three cases: a temporary HTTP 500, an expired upload token followed by refresh, and a socket cut mid-request. Each succeeded on the second upload attempt. These tests validate retry completion with a synthetic local backend; they do not establish production blob durability or acoustic continuity.

A subsequent upload-custody rerun on 4 September failed before reaching upload: the recorder persisted zero chunks during approximately 46 seconds of recording state, then finalization correctly reported no audio segments. This happened at 23:24:40 local; Windows restarted at 23:25:43. The restart therefore does not explain the earlier failure. Renderer/child diagnostics were not retained by the old harness, so the cause remains unresolved. The failed profile, result and logs were copied into ignored evidence storage before any fresh rerun. The harness now appends renderer console/errors, child stdout/stderr, recorder event counts/sizes, WebAudio context progress, store counters and disk metadata to unique per-run logs, restricted to synthetic audio against local mock APIs. No audio contents are logged. This is an additional release blocker; a successful rerun is not a substitute for resolving it.

The final instrumented upload-custody run passed on implementation commit `427a06a`, at 23:48:37 local. It confirmed one accepted upload with matching multipart/local SHA-256, refusal of automatic deletion after unknown/404/401 and successful status, refusal even for a legacy canDelete=true receipt, and main-process upload/deletion protection while unsaved audio is flagged. Explicit manual deletion succeeded only at the end. The test now verifies unconditional automatic retention; the earlier mutation-based authorization check above describes an intermediate implementation.

That run emitted 13 nonempty blobs totaling 645,798 source bytes; main processing produced a 646,366-byte final file and measured 46 seconds against 47 expected. A later scheduling delay included a 262,900-byte catch-up blob. All three WebAudio contexts remained running and advanced 21.109 seconds over 21.111 wall-clock seconds around the delay. The diagnostic sampler also stalled and three requests timed out. This supports delayed processing/buffering, not a proven loss of audio; acoustic continuity was not decoded by this custody scenario, and its explicit-deletion check removed the output. The earlier zero-chunk failure did not recur and remains unexplained.

Resume evidence: failed profile/results are preserved under `tests/e2e-harness/work/evidence/s10-empty-before-restart-20260904-232945-c470f1f2`; final diagnostics are under `tests/e2e-harness/work/logs/s10-upload-custody-2026-09-04T21-46-41-224Z-G8ejmn`. Final unit/build logs are `work/reliability-final-tests.log` and `work/reliability-final-build.log`. These directories are ignored. Do not run a fresh-profile scenario over a failed profile until preserving it.

Before a release: complete the platform hardware matrix, resolve the long-meeting backend contract, verify signed helpers on both Mac architectures, run a full-duration soak with output decoding and source/remote hash comparison, and pass Windows/macOS release CI from a clean public main SHA. No release tag was created in this review.

## Physical qualification matrix (not yet executed)

Run each applicable case on Apple Silicon macOS, Intel macOS and Windows, with a built-in mic, a USB conference device, Bluetooth directly paired, and a vendor USB Bluetooth dongle. Record a timestamped spoken reference from both the local microphone and remote/system audio. Decode the resulting file and compare the upload hash; listening alone is insufficient.

| Case | Required result |
| --- | --- |
| Fresh install, microphone/system permission denied then granted | Clear state and useful recovery instruction; never show healthy capture before signal arrives. Verify signed helpers on first launch. |
| Rapid start/stop and repeat; restart after prior recording | Every source uses its own recording ID; no prior meeting’s PCM or chunks appear in the next file. |
| USB unplug/replug, hub power loss, sample-rate change | Preserve earlier audio, flag the gap, verify a replacement before reporting recovery. |
| Bluetooth battery exhaustion, range loss, hardware mute, A2DP/HFP switch | Distinguish silence from track termination; never silently undo deliberate mute. |
| Teams/Zoom output differs from default output | Warn when system audio is not reaching the mix; verify actual remote speech after changing routing. |
| User pause for 30 seconds and five minutes, including system audio | No paused conversation in the file; microphone and system audio remain aligned after resume. |
| Lock/unlock, minimize, navigate to History, close recording page | Continuous capture and persistence; monitoring and emergency save still work. |
| Idle sleep versus forced sleep/lid close; reboot | Prevent ordinary idle suspension where allowed; retain the persisted prefix and disclose any interruption. Never claim capture while the machine was asleep. |
| Full disk and sharing violations during chunk write, finalization, receipt write and deletion | Preserve original sources; offer retry; no success or deletion authorization from a partial operation. |
| Kill renderer/main/helper during capture and at every publish boundary | Recover to a visible history entry; no duplicated segments; failed recovery leaves source files intact. |
| Offline for a meeting, network switch, proxy/DNS failure, lost HTTP response | Capture locally; retry for the correct account; deduplicate accepted uploads and preserve local audio until confirmation. |
| Logout/account change while upload is queued, transferring or verifying | Recording stays with its original owner; no upload into the newly signed-in account. |
| Five-plus-hour and overnight soak on battery and AC | Measure maximum time since durable chunk, memory/disk growth, decoded continuity and both channels. Resolve the backend duration/size limit before treating this as an upload acceptance test. |
| Auto-update downloaded during capture/finalization/upload | No forced restart of active capture; interrupted transfer retains a recoverable queue entry. |
