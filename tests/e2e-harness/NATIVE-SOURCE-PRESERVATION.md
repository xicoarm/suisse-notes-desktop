# Native source preservation: implementation and qualification status

The release remains blocked by confirmed audio discarded in the live WebAudio
recording-input FIFO on Intel macOS. A correct upload cannot recover audio that
never reached the recorded stream. The existing five-hour failures remain open.

## Integrated capture path; qualification is still in progress

`src/services/nativeSourceRecorder.js` records selected native audio tracks in
independent microphone/system source epochs. It shares the actual tracks so the
user's microphone mute applies to every consumer; it never opens another device
or owns/stops the physical tracks. Pause ends epochs, and resume starts new ones.
Each replacement gets a separate container, index sequence and active-time cut.

`src-electron/native-source-persistence.js` reserves a source directory atomically,
then persists its actual recorder-start call offset before accepting chunks.
Exact retries are idempotent; conflicting bytes, gaps and ambiguous metadata are
errors. Final data and durable writes must finish before the terminal marker.
Interrupted sources and unacknowledged reservation staging files remain on disk.

The recording service now creates a durable native capture-mode marker before
starting independent sources. Start/stop, pause/resume, mute, replacement,
system toggles, cancellation, backpressure and app-level emergency saving use
the coordinator. Native final events and pending writes must drain before
combining, and the retry UI goes through that same save path.

`native-source-finalization.js` reconstructs the canonical output from native
epochs and macOS AudioTee PCM. The live mixed chunks remain available as evidence;
they cannot serve as a fallback for a failed native finalization. Version 3
receipts bind all saved source identities/fingerprints, PCM inclusion and output
checksum. Crash discovery, upload eligibility and disk accounting recognize the
archive and its authority marker.

The common one-epoch-per-lane path uses at most two inputs and one Opus encode,
avoiding full-meeting FLAC intermediates. Multiple epochs use sequential lossless
normalization and streamed lane assembly. Disk estimates are checked before the
selected path and before fallback. Original sources and failed scratch are kept.
Real-media tests cover packet gaps, stereo anti-phase inputs, offsets, explicit
replacement cuts, retained tails and failures. Final output is re-encoded; exact
decoded PCM equality with its original Opus is not a valid recovery oracle.
Final encoding explicitly uses 192-kbit/s constant-rate stereo Opus with 20-ms
frames. Its disk estimate includes WebM overhead. Variable-rate output previously
exceeded the nominal bitrate enough to threaten the five-hour upload-size budget;
the bounded policy still needs a real long upload against the deployed backend.

Start-call offsets do not establish exact first-sample alignment. Pause overlap
above 2 ms currently blocks with originals retained. Large internal timestamp
gaps may exceed the bounded allocation policy and require further recovery work.
macOS AudioTee now reserves a durable required-capture attempt before spawning,
records startup/data/failure observations, and publishes its terminal evidence
only after the child closes and accepted PCM drains to disk. A failed or missing
required capture blocks normal completion; Retry Saving recovers available audio
with persistent warnings. Attempt evidence is bound to the final receipt. A
regression covers buffered stdout remaining after child closure, and periodic
file syncing uses monotonic time. Exact active-clock alignment remains open:
helper stream-start/pipe-arrival observations are not sample clocks.
The native path must pass the short preservation test and source-aware lifecycle
and crash tests before another five-hour qualification can establish readiness.

Native output validation counts encoded Opus packet samples minus pre-skip and
final discard padding. Container duration is retained separately. A real capture
previously failed because nominal container padding exceeded the old tolerance,
despite containing exactly the expected decoded samples. That failure retained
the originals and blocked upload; an offline reconstruction is not a passed app
qualification. The next compiled candidate must pass the full recording test.

## Deterministic short reproducer

`native-source-qualification.js` uses one synthetic microphone acquisition, a
direct native witness and the real app. It holds only the identified live mixer
suspended for one second, then compares numbered source identities in the witness
and actual final/uploaded file. This is a causal mixer-failure test; it does not
replicate every detail of the hosted scheduling fault.

Run on Windows or macOS with `SUISSE_E2E_HOOKS=1` and
`SUISSE_TEST_NETWORK_ISOLATION=1`:

```text
node tests/e2e-harness/native-source-qualification.js --seconds 45 --app-dir <unsigned-test-bundle> --bundle-sha <actual-40-character-build-SHA>
```

Default success means **baseline loss was reproduced**, not that the application
passed. `sourcePreservationQualified` remains false. After the capture/output fix
is integrated, add `--expect-preserved`; the final file must retain the native
source content across the fault. The two expectations must never be conflated.

The fixture uses a localhost mock, retains evidence under ignored harness work,
checks bundle/runtime/harness hashes, and supervises its processes for at most ten
minutes. It uses no production upload, physical system capture or playback. Decode
only after capture closes, with no competing local capture/decoder workload.

## Separate finalization fix

The macOS system-audio merge now fails finalization on unavailable FFmpeg, encoder
failure, invalid output or failed publication. Both original sources remain for
retry. Generated-output upload checks now also reject stale output, interrupted
finalization and an invalid source/output receipt before any transfer or resuming
an accepted upload ID. Imported files and source-free legacy recordings retain
their existing handling.

Version 2 final receipts identify whether microphone, system audio, or both were
required. Version 1 receipts beside nonempty system PCM cannot establish that the
participants were included: older merge failure handling could falsely issue
success. Those recordings must be rebuilt from surviving sources. Ambiguous legacy
microphone output plus separate PCM is retained without guessing a merge that
could erase the microphone or duplicate participants. A durable system-only plan
allows replay after output publication but before receipt publication.

## Release qualification still required

A passing short preservation test must be followed by source-switch, pause/mute,
dual-source alignment, process-crash recovery and the real 5h05 Windows/Intel Mac/
Apple Silicon matrix. Physical Bluetooth/USB transitions, sleep and packaged
macOS permissions remain separate coverage. Neither a unit-test count nor a
baseline reproducer proves zero loss or readiness to release.
