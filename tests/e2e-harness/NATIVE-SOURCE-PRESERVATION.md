# Native source preservation: implementation and qualification status

The release remains blocked by confirmed audio discarded in the live WebAudio
recording-input FIFO on Intel macOS. A correct upload cannot recover audio that
never reached the recorded stream. The existing five-hour failures remain open.

## Implemented foundation, not yet the application capture path

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

The coordinator and disk implementation are tested together, including a lost IPC
reply after a successful disk write. **They are not connected to the production
recording service or IPC yet.** No native-source-backed final output is produced
by the app at this stage; the FIFO bug is not fixed by these modules alone.

Before activation, implement and test all of the following together:

- Wire start, stop, pause, mute, replacement, system-audio toggles, suspend,
  cancellation, backpressure and app-level emergency stop to the coordinator.
- Reconstruct the final file from independent native microphone/Windows system
  epochs, or native microphone plus macOS AudioTee PCM. Never add native mic to
  the already mixed recording, or silently publish the mixed fallback as complete.
- Establish and test source alignment and replacement overlap cuts. Start-call
  offsets remove reservation-write delay; they do not establish the exact first
  device sample timestamp. Packet timestamp gaps cannot be called recovered speech.
- Include every native source in crash discovery, disk-space accounting and the
  finalization receipt. Current upload eligibility deliberately blocks native
  archives because existing final receipts do not prove their incorporation.

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
