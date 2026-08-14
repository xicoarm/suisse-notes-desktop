# macOS system-audio check (manual, ~5 min)

**Why this is manual:** there is no Mac in CI and no Mac on the dev machine, so
the AudioTee path ships statically verified. The detection *logic* is covered by
`tests/unit/pcmSignal.test.js` (platform independent, 11 cases); what cannot be
automated here is that the wiring actually fires on a real Mac.

**What is being checked:** AudioTee captures every process but **only audio going
to the default output device** — upstream states "Only the default output device
is currently supported." Meeting apps each carry their own speaker picker, so a
Mac user pointing Zoom/Teams at a headset while the system default is elsewhere
records a full meeting of digital silence. Before v4.5.7 nothing measured that
stream and `mergeSystemAudio` only rejected a zero-*byte* file, so an all-zeros
capture merged silently and the user was never told.

## A. The failure is now visible (the important one)

1. macOS 14.2+, system audio enabled in the app, System Settings → Sound → Output
   set to **the built-in speakers**.
2. Start a recording.
3. Play music from any app whose output you have pinned to a **different** device
   (e.g. a Bluetooth headset). In Music/Spotify/Zoom this is an in-app "output"
   or "speaker" setting; macOS also allows per-app routing in Sound settings.
   Do **not** change the system default.
4. Wait ~95 s.

**Expect:** a persistent warning toast — "No system audio has arrived for … s".
`main.log` shows `AudioTee delivered digital silence for …s`, and one Sentry
event tagged `system-audio:` appears.

**If no warning appears:** the wiring did not fire — check `isRecordingInProgress`
is true and that `system:capture-warning` reaches `recordingSafetyNet`.

## B. It clears when routing is corrected

5. With the recording still running, set the app's output back to the system
   default (or make the headset the default output).

**Expect:** within ~1 s a green "System audio is being captured again" toast, and
the warning is replaced.

## C. No false alarm on a healthy recording

6. Fresh recording, everything playing through the default output, ~3 min with
   normal conversational pauses.

**Expect:** no system-audio warning at any point, and the finished file really
contains the other side's audio.

## D. Detection can never cost audio

7. Confirm the recording from A still finalizes, uploads, and contains the
   microphone track in full — the measurement is wrapped in a try/catch and runs
   *after* `writeStream.write(data)` precisely so a detector bug cannot become a
   data-loss bug. Verify that ordering held.

---

Record the outcome in `FINDINGS.md`. Until A–D have been run on real hardware,
the macOS path should be described as **static-tested only**.
