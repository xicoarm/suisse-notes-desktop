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

module.exports = {
  peakFromInt16LE,
  SystemAudioSilenceTracker,
  DEFAULT_SILENCE_PEAK,
  DEFAULT_WARN_AFTER_MS,
};
