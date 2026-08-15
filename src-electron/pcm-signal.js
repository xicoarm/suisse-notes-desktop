/**
 * Signal forensics for the macOS system-audio (AudioTee) PCM stream.
 *
 * Why this exists: AudioTee captures every process, but ONLY audio destined for
 * the **default output device** — upstream states "Only the default output device
 * is currently supported." Conferencing apps each carry their own speaker picker
 * (Zoom, Teams, Slack), so a Mac user whose meeting app renders to a headset while
 * the system default is something else gets a perfectly healthy-looking capture
 * containing pure digital silence. That is the macOS twin of the Windows
 * loopback endpoint split (incident 2026-08-14).
 *
 * Until this module, the AudioTee bytes went straight to disk unmeasured —
 * `proc.stdout.on('data', d => writeStream.write(d))` — and `mergeSystemAudio`
 * only rejects a zero-BYTE file, so a file full of zeros merged happily and the
 * user was never told. An hour of "system audio" could contain nothing at all.
 *
 * Kept as a standalone, dependency-free module so the detection logic is unit
 * testable on any platform, which matters: this project has no Mac in CI.
 */
'use strict';

// Below this normalized peak the block is digital silence, not "quiet".
// int16 has a 1/32768 quantization step, so 1e-4 is ~3 counts — comfortably
// above dither/rounding, far below anything audible.
const DEFAULT_SILENCE_PEAK = 1e-4;
const DEFAULT_WARN_AFTER_MS = 90 * 1000;

/**
 * Peak absolute amplitude (0..1) of a mono signed-16-bit little-endian buffer.
 * Odd trailing bytes are ignored — chunk boundaries need not align to frames.
 */
function peakFromInt16LE(buffer) {
  if (!buffer || buffer.length < 2) return 0;
  let peak = 0;
  const usable = buffer.length - (buffer.length % 2);
  for (let i = 0; i < usable; i += 2) {
    // Manual read keeps this allocation-free on the hot path (a chunk arrives
    // every 200 ms for the whole meeting).
    let v = buffer[i] | (buffer[i + 1] << 8);
    if (v & 0x8000) v -= 0x10000;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak / 32768;
}

/**
 * Tracks how long the system-audio capture has been delivering digital silence.
 *
 * push() returns:
 *   'warn'  — silence just crossed the threshold (fires once per episode)
 *   'clear' — signal returned after a warning
 *   null    — nothing to report
 *
 * The caller gates on "is a recording actually running", so a paused session
 * cannot age the episode into a false alarm.
 */
class SystemAudioSilenceTracker {
  constructor(options = {}) {
    this.warnAfterMs = options.warnAfterMs || DEFAULT_WARN_AFTER_MS;
    this.silencePeak = options.silencePeak || DEFAULT_SILENCE_PEAK;
    this.reset();
  }

  reset() {
    this.silentSince = null;
    this.warned = false;
    this.sawSignal = false;
    this.lastPeak = 0;
  }

  /**
   * @param {Buffer} chunk  raw int16 mono PCM as written by AudioTee
   * @param {number} nowMs  current wall clock
   * @returns {'warn'|'clear'|null}
   */
  push(chunk, nowMs) {
    const peak = peakFromInt16LE(chunk);
    this.lastPeak = peak;

    if (peak > this.silencePeak) {
      this.sawSignal = true;
      this.silentSince = null;
      if (this.warned) {
        this.warned = false;
        return 'clear';
      }
      return null;
    }

    if (this.silentSince === null) {
      this.silentSince = nowMs;
      return null;
    }
    if (this.warned) return null;
    if (nowMs - this.silentSince < this.warnAfterMs) return null;

    this.warned = true;
    return 'warn';
  }

  /** Seconds of unbroken silence so far (0 when signal is flowing). */
  silentSeconds(nowMs) {
    if (this.silentSince === null) return 0;
    return Math.round((nowMs - this.silentSince) / 1000);
  }
}

/**
 * Full monitor around the tracker, covering BOTH ways a capture can be silent:
 *
 *   1. chunks arrive but contain digital silence
 *   2. no chunks arrive at all
 *
 * Case 2 matters because it cannot be ruled out from here: whether a Core Audio
 * tap keeps delivering zero-filled buffers when nothing renders to the default
 * output device, or simply stops delivering, is macOS behaviour that this
 * project has no Mac to observe. A detector that only handled case 1 would
 * silently do nothing in case 2 — the exact failure it exists to prevent. So
 * both are treated as the same verdict.
 *
 * Pure and injectable (no Electron, no timers of its own) so the wiring — not
 * just the arithmetic — is testable on any platform.
 *
 * @param {object} opts
 * @param {() => boolean} opts.isRecording  gate; a paused session is legitimately silent
 * @returns {{handleChunk: Function, tick: Function, reset: Function, state: Function}}
 */
function createSystemAudioMonitor(opts = {}) {
  const isRecording = opts.isRecording || (() => true);
  const warnAfterMs = opts.warnAfterMs || DEFAULT_WARN_AFTER_MS;
  const tracker = new SystemAudioSilenceTracker({
    warnAfterMs,
    silencePeak: opts.silencePeak,
  });
  let lastDataAt = null;
  let startedAt = null;

  const reset = (now) => {
    tracker.reset();
    lastDataAt = null;
    startedAt = now ?? null;
  };

  return {
    reset,
    /** @returns {'warn'|'clear'|null} */
    handleChunk(chunk, now) {
      lastDataAt = now;
      if (startedAt === null) startedAt = now;
      if (!isRecording()) {
        // Not recording: keep the stream fresh but never age an episode.
        tracker.silentSince = null;
        return null;
      }
      return tracker.push(chunk, now);
    },
    /**
     * Called on a timer. Detects the "no chunks at all" flavour of silence.
     * @returns {'warn'|null}
     */
    tick(now) {
      if (!isRecording()) return null;
      if (startedAt === null) startedAt = now;
      if (tracker.warned) return null;
      const since = lastDataAt === null ? startedAt : lastDataAt;
      if (now - since < warnAfterMs) return null;
      tracker.warned = true;
      tracker.silentSince = since;
      return 'warn';
    },
    state(now) {
      return {
        silentSeconds: tracker.silentSince === null
          ? Math.round((now - (lastDataAt ?? startedAt ?? now)) / 1000)
          : tracker.silentSeconds(now),
        sawSignal: tracker.sawSignal,
        receivedData: lastDataAt !== null,
      };
    },
  };
}

module.exports = {
  peakFromInt16LE,
  SystemAudioSilenceTracker,
  createSystemAudioMonitor,
  DEFAULT_SILENCE_PEAK,
  DEFAULT_WARN_AFTER_MS,
};
