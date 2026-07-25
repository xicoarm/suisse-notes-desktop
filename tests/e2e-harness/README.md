# E2E Reliability Harness

Runs the **real desktop app** (renderer + Electron main, the genuine
`getUserMedia → MediaRecorder → chunks → combine → upload` pipeline) against
**controlled, realistic conditions** — and verifies the produced audio
forensically instead of by listening.

## How it works

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
5. **Forensic verifier** (`lib/verify.js`): decodes the app's output file and
   locates every pilot pulse (Goertzel detection). Missing pulse = audio gap;
   extra/mis-spaced pulse = duplication/desync; short file = truncation;
   per-segment RMS validates capture levels. Same methodology that cracked
   the doubled-audio and Insel incidents — codified as a repeatable oracle.

Everything runs in an **isolated userData profile** (`work/userdata/…`)
against the local mock — no production system, profile or token is touched.
All app-side hooks are hard-gated on `!app.isPackaged`.

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

- **Tier 2**: 5-hour real-time endurance run (`s3` plan with real threshold),
  overnight; disk-pressure scenario (filler file → ENOSPC → safety-net stop).
- **Tier 3** (needs hardware): real Bluetooth speakerphone kill-test, real
  system sleep/wake mid-recording (scheduled wake timer).
- **Tier 4** (needs a Mac): same suite on macOS + AudioTee/merge scenarios
  with a second pilot frequency on the system-audio side to measure
  mic-vs-system desync to the millisecond.

## Notes

- First run generates TTS audio into `work/audio-cache/` (slow once, cached).
- `work/` is gitignored; the harness code is committed.
- The mock's control surface: `GET /__control/requests`, `POST /__control/mode`.
