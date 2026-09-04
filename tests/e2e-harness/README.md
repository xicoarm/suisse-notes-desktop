# E2E Reliability Harness

Runs the **real desktop app** (renderer + Electron main, the genuine
`getUserMedia → MediaRecorder → chunks → combine → upload` pipeline) against
**controlled, realistic conditions** — and verifies the produced audio
forensically instead of by listening.

## Current qualification

`s11-capture-qualification` uses portable generated audio with a unique numbered,
CRC-checked frame every half second. The verifier decodes the actual finalized
file and checks interior frame identity, order, timing, duration and completeness.
It detects equal-duration replacement or silence that a file-length check misses.
Codec padding and partial first/last frames have explicit tolerances; this is not
a sample-perfect comparison. The oracle has regression cases for real Opus
encoding, missing audio, repetition, reordering and planned silence.

The four cases cover baseline capture, a four-second renderer JavaScript freeze,
a fourteen-second Blob conversion delay, and source rotation plus an interrupted
upload. Every case checks the mock's received audio SHA-256 against the local
file and verifies that the local backup remains. Original chunks, files, profiles
and diagnostics survive failures. A successful upload alone is not an audio pass.

`s12-device-qualification` injects two microphone track-ended/reconnect episodes
and a separate thirty-second digital-silence episode. It uses real cloned input
tracks, the application's recovery code and live health UI. It verifies preserved
prefix chunks and coded audio outside the deliberately silent intervals. These
are synthetic application tests; they do not reproduce physical USB/Bluetooth
drivers, radio loss, codec-profile changes or actual permission prompts.

Native Windows, Intel Mac and Apple Silicon Mac CI runs `s11`, `s12` and `s15` on pull requests.
See [hosted qualification](ci/README.md) for exact scope, isolation and artifacts.
A failed hosted capture is a failure to investigate, not a reason to skip an OS.

Use a compiled, unsigned E2E bundle without development hot reload:

```powershell
$env:SUISSE_E2E_HOOKS='1'
$env:API_BASE_URL='http://localhost:3000'
$env:VITE_API_URL='http://localhost:3000'
npx quasar build -m electron --skip-pkg
$env:SUISSE_E2E_APP_DIR=(Resolve-Path dist/electron/UnPackaged).Path
node tests/e2e-harness/run.js s11-capture-qualification
node tests/e2e-harness/run.js s12-device-qualification
```

The strict endurance runner defaults to **five hours and five minutes of actual
capture**. It checks available disk space, samples progress into an append-only
log, streams the mock upload hash, verifies numbered audio across the natural
4h55 rotation, and retains every source chunk. It requires a frozen bundle:

```powershell
$env:SUISSE_ENDURANCE_SECONDS='18300'
node tests/e2e-harness/run.js s13-coded-endurance
```

For harness smoke testing, an explicit duration from 45 to 20,000 seconds is
accepted. A short smoke reports `fiveHourQualificationPassed=false`. The mock
accepts long files to test the client; the production backend still rejects
recordings over five hours, so mock success cannot qualify that contract.
The same full-duration scenario can run independently of the developer laptop
on three native cloud runners through the manual workflow described in
[hosted qualification](ci/README.md). It never runs automatically on a PR.

On a local Windows machine, `s14-system-audio-qualification` plays 48 seconds of
numbered audio through the existing default output and captures it through the
real Chromium desktop-audio path. Hardware microphone requests are replaced with
disabled zero-valued tracks, and app mute is verified before playout. This checks
the actual default output path without changing device defaults or volume.
Because other Windows playback could enter loopback, all evidence stays in
repo-root `work/private-system-audio`, outside the synthetic CI artifact tree;
the scenario refuses CI. It does not qualify the communications endpoint or
physical USB/Bluetooth changes.
The fixture prepares its numbered PCM samples before capture and records
preparation checkpoints. An earlier asynchronous WAV-decoding fixture crashed
Electron 28.3.3 before capture; its failure evidence remains separate from the
passing PCM fixture. This is not a production runtime fix.

`s15-main-crash-qualification` records a numbered signal, hashes the acknowledged
durable chunks, abruptly terminates only its own Electron process tree, and
restarts the same isolated profile. It exercises the real startup recovery scan
without changing file timestamps. Recovery must retain every original hash,
preserve the decoded durable audio exactly, upload matching bytes and show a
recovered History entry. Any tail not yet persisted is measured separately;
no audio can be captured while the process is absent. This differs from the
older renderer-only crash scenario and does not emulate a disk losing power.

Do not rebuild the active bundle, run competing captures, or run unrelated heavy
tests during a baseline. Intentional contention should be a named fault case.
Record the built revision separately if the working tree changes during a run.
Never use these synthetic profiles or mock credentials with production endpoints.

## Legacy speech-and-pilot scenarios

1. **Ground-truth audio** (`lib/audio.js`): real spoken meeting dialogue
   (Windows TTS, alternating voices) assembled into scenario WAVs with
   segments: `speech` (healthy), `zeros` (dead-but-open device — the Insel
   incident phase 1), `quiet` (speech at −30 dB — phase 2), `noise` (room
   tone). A 7 kHz **pilot pulse** fires every 10 s (muted inside `zeros`
   segments, because a dead device delivers nothing).
2. **Fake microphone**: the app is launched with Chromium's
   `use-file-for-fake-audio-capture` (dev-only hook `SUISSE_TEST_FAKE_AUDIO`
   in electron-main.js) so the scenario WAV **is** the microphone.
3. **Adversarial mock backend** (`lib/mock-backend.js`): the app's
   `API_BASE_URL`/`VITE_API_URL` point at a local server that scripts the
   failure of the day (terminal 400, transient 500, expired token, socket cut
   mid-upload, unknown status enums) and records every request.
4. **CDP driver** (`lib/app-driver.js`): drives the app like a human — types
   credentials into the real login form, clicks the real record button
   (`data-test` attributes), navigates, crashes the renderer.
5. **Legacy verifier** (`lib/verify.js`): decodes the output and locates pilot
   pulses and sustained energy holes. Unmatched or mis-spaced pulses require
   investigation; this sparse oracle cannot rule out shorter interior losses.
   Use the stricter numbered-audio qualification for continuity claims.

Everything runs in an **isolated userData profile** (`work/userdata/…`)
against the local mock — no production system, profile or token is touched.
Compiled E2E hooks require explicit test flags. Network isolation additionally
requires a loopback API and isolated profile, disables Sentry, and blocks remote
renderer network requests. Normal release behavior does not enable these hooks.

## Running

```bash
node tests/e2e-harness/run.js selftest       # generator+verifier sanity (no app)
node tests/e2e-harness/run.js s1-baseline    # 4-min realistic meeting, full pipeline
node tests/e2e-harness/run.js s2-angela-bt   # Insel replay: zeros + whisper-quiet phases
node tests/e2e-harness/run.js s3-autosplit   # compressed long-meeting (split every 3 min)
node tests/e2e-harness/run.js s4-storm       # terminal-400 backend: retries must be bounded
node tests/e2e-harness/run.js s5-resilience  # 500-once / 401-once / socket-cut — must survive
node tests/e2e-harness/run.js s6-crash       # renderer crash mid-recording → recovery
```

Each scenario prints PASS/FAIL with concrete problems and writes
`work/result_<name>.json` (incl. the health-UI timeline for s2). Artifacts
(profiles, screenshots, scenario WAVs) stay under `work/` for post-mortems.

## Roadmap (tiers)

- **Endurance execution**: run `s13-coded-endurance` for its full real-time
  duration; a shortened harness smoke is insufficient. Real disk-pressure
  qualification remains separate from injected write-failure unit tests.
- **Tier 3** (needs hardware): real Bluetooth speakerphone kill-test, real
  system sleep/wake mid-recording (scheduled wake timer).
- **Mac system capture** (still unqualified): AudioTee/merge scenarios
  with a second pilot frequency on the system-audio side to measure
  mic-vs-system desync to the millisecond.

## Notes

- First run generates TTS audio into `work/audio-cache/` (slow once, cached).
- `work/` is gitignored; the harness code is committed.
- The mock's control surface: `GET /__control/requests`, `POST /__control/mode`.
