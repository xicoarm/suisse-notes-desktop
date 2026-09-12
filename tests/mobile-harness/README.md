# Mobile Reliability Harness

Runs the **real mobile app** (the Capacitor web bundle exactly as it ships in
the APK/IPA) on a **virtual phone** and against a **virtual Suisse Notes Pro
recorder**, and verifies the produced audio forensically instead of by looking.

## How it works

1. **The real bundle.** `npx quasar build -m capacitor -T android --skip-pkg`
   produces `src-capacitor/www` — the same files `cap sync` copies into the
   Android and iOS shells. The device server serves them unchanged (production
   API URL, production CSP). Nothing is rebuilt for the test.
2. **The virtual phone** (`lib/bridge.js`). Injected before the bundle runs, it
   makes `@capacitor/core` see a native platform (`androidBridge` or
   `webkit.messageHandlers.bridge`) and routes every plugin call through the
   same `Capacitor.nativePromise` / `nativeCallback` mechanism the native shells
   use — into JavaScript implementations: the **Filesystem** writes real files
   on disk through the device server (`work/device/<scenario>/fs/<DIRECTORY>/…`),
   **Preferences** persist in the browser profile (survive an app relaunch),
   Device / App / Network / StatusBar / LocalNotifications / Share / Browser
   behave like the phone (the iOS persona rejects `setOverlaysWebView`, exactly
   like the real plugin), **BackgroundRecording** implements the chunk combiner.
   Platform detection, the storage layout (`Directory.External` on Android,
   `Documents` on iOS) and the upload `readBlob` strategy (`convertFileSrc` on
   Android, the base64 fallback on iOS) all run through the production code.
3. **The virtual recorder** (`lib/virtual-recorder.js`). The native side of
   `@capacitor-community/bluetooth-le`; the real `BleClient` wrapper, the app's
   `bleService.js` and the device store run on top of it. It speaks the T240
   protocol as the shipped firmware does: handshake with the 5 s window and
   app-UUID binding (status 0x01 for a foreign app), time/battery/storage/
   sync-state echoes, file list as count + entries with the busy card as
   `{"AudioFileList":"MemoryBusy"}`, downloads as type-0x02 frames with a
   big-endian frame index and 0x1D + CRC16, unpair with disconnect, format,
   delete, device-button recordings. Faults are scripted per file: corrupted
   frame for the first N attempts, dropped link mid-transfer, empty file.
4. **The microphone** is Chromium's fake audio capture fed with the scenario
   WAV from the desktop harness (`tests/e2e-harness/lib/audio.js`): real
   speech on Windows (SAPI), a speech-like synthetic signal on Linux CI, with
   the 4 kHz pilot-pulse oracle underneath.
5. **The backend** is the desktop harness's adversarial mock
   (`tests/e2e-harness/lib/mock-backend.js`), reached through request
   interception of `https://app.suisse-meets.ch` — the bundle keeps its
   production URL. Uploaded audio bodies are captured so the recorder scenarios
   can prove that the bytes on the server equal the bytes on the recorder.
   Sentry ingest is swallowed.
6. **The verifier** is the desktop one (`tests/e2e-harness/lib/verify.js`):
   energy holes decide lost audio, pilot pulses corroborate, duration and level
   checks catch truncation and dead input.

## Running

```bash
npx quasar build -m capacitor -T android --skip-pkg   # once, and after every src change
node tests/mobile-harness/run.js m0-selftest
node tests/mobile-harness/run.js m1-baseline           # 90 s meeting → upload → verify
node tests/mobile-harness/run.js m5-recorder-sync      # pair, sync, cancel, unpair
node tests/mobile-harness/run.js all                    # everything except the endurance run
node tests/mobile-harness/run.js m2-endurance --minutes 20
node tests/mobile-harness/run.js m1-baseline --platform ios --headful
```

Every scenario prints PASS/FAIL with concrete problems and writes
`work/result_<name>_<platform>.json`; screenshots, console logs, captured
uploads and the device file systems stay under `work/` for post-mortems.
`CHROME_PATH` points the runner at a Chrome/Chromium binary if it is not in a
standard location.

## Scenarios

| Name | What it proves |
|---|---|
| m0-selftest | bridge + platform detection, file system semantics, preferences, login |
| m1-baseline | record → stop → combine → upload: no lost audio, one upload, history entry keeps the local file |
| m2-endurance | 5h15 recording (nightly), one combined file with no holes, one upload |
| m3-resilience | upload survives a transient 500, an expired token and a socket cut |
| m4-delete-after-upload | the Settings choice really removes the local audio after the verified upload; the entry stays |
| m5-recorder-sync | pairing, busy card, empty file skipped, corrupted transfer retried, dropped link resumed, bytes identical on the server, button recording picked up, cancelled transfer kept as skipped, unpair |
| m6-crash-recovery | app killed mid-recording → relaunch → recovery combines and uploads |
| m7-repair | reinstall (storage wiped) → the recorder still bound to the user's UUID → pairs again |

## CI

`.github/workflows/mobile-reliability.yml` runs `all` for both personas on
pull requests that touch `src/**`, and the 5h15 endurance run nightly on `main`.
Adding the label **endurance** to a pull request starts the endurance run for
that branch. Evidence (results, screenshots, console logs, captured uploads,
device file systems) is uploaded as a workflow artifact.

## What it does not cover

The operating system itself: background kills and audio-session interruptions
on a real iPhone, Android's foreground service and battery optimisation,
permission dialogs, the Bluetooth stacks (MTU, rediscovery after a long
suspension) and the physical recorder's firmware timing. Those stay on the
device checklist in `RELEASE-RUNBOOK.md`.
