/**
 * SASIG (macOS): AudioTee PCM silence detection.
 *
 * AudioTee captures every process but ONLY audio going to the default output
 * device ("Only the default output device is currently supported" — upstream).
 * Meeting apps carry their own speaker picker, so a Mac user can record a full
 * meeting of digital silence with a capture that looks healthy. Before this,
 * the PCM went to disk unmeasured and mergeSystemAudio only rejected a
 * zero-BYTE file, so an all-zeros hour merged silently.
 *
 * These tests pin the detector, and matter more than usual: there is no Mac in
 * CI, so this logic is deliberately platform-independent so it CAN be tested.
 */
import { describe, expect, it } from 'vitest';
import {
  peakFromInt16LE,
  SystemAudioSilenceTracker,
  createSystemAudioMonitor,
} from '../../src-electron/pcm-signal.js';

/** Mono int16 LE buffer of a sine at the given peak amplitude (0..1). */
function tone(frames, amplitude, freq = 440, rate = 48000) {
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / rate));
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

const silence = (frames) => Buffer.alloc(frames * 2);
const CHUNK_FRAMES = 9600; // AudioTee's 200 ms at 48 kHz

describe('peakFromInt16LE', () => {
  it('reads digital silence as exactly zero', () => {
    expect(peakFromInt16LE(silence(1000))).toBe(0);
  });

  it('recovers the amplitude of a real signal', () => {
    expect(peakFromInt16LE(tone(4800, 0.5))).toBeCloseTo(0.5, 2);
    expect(peakFromInt16LE(tone(4800, 0.02))).toBeCloseTo(0.02, 2);
  });

  it('handles negative excursions and full scale', () => {
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(-32768, 0);
    buf.writeInt16LE(0, 2);
    expect(peakFromInt16LE(buf)).toBeCloseTo(1.0, 3);
  });

  it('tolerates an odd trailing byte (chunks need not align to frames)', () => {
    const odd = Buffer.concat([tone(100, 0.5), Buffer.from([0x7f])]);
    expect(() => peakFromInt16LE(odd)).not.toThrow();
    expect(peakFromInt16LE(odd)).toBeCloseTo(0.5, 2);
  });

  it('is safe on empty/short input', () => {
    expect(peakFromInt16LE(Buffer.alloc(0))).toBe(0);
    expect(peakFromInt16LE(Buffer.from([1]))).toBe(0);
    expect(peakFromInt16LE(null)).toBe(0);
  });
});

describe('SystemAudioSilenceTracker', () => {
  it('warns once, only after the threshold, on an all-silent stream', () => {
    const t = new SystemAudioSilenceTracker({ warnAfterMs: 90_000 });
    let now = 0;
    const verdicts = [];
    // 200 ms chunks for 3 minutes of pure silence — the incident shape.
    for (let i = 0; i < 900; i++) {
      const v = t.push(silence(CHUNK_FRAMES), now);
      if (v) verdicts.push({ v, at: now });
      now += 200;
    }
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].v).toBe('warn');
    // First chunk starts the clock, so the warning lands just after 90s.
    expect(verdicts[0].at).toBeGreaterThanOrEqual(90_000);
    expect(verdicts[0].at).toBeLessThan(92_000);
    expect(t.sawSignal).toBe(false);
  });

  it('never warns while real audio is flowing', () => {
    const t = new SystemAudioSilenceTracker({ warnAfterMs: 90_000 });
    let now = 0;
    for (let i = 0; i < 3000; i++) {           // 10 minutes
      expect(t.push(tone(CHUNK_FRAMES, 0.3), now)).toBeNull();
      now += 200;
    }
    expect(t.sawSignal).toBe(true);
  });

  it('does not warn on natural conversational pauses', () => {
    const t = new SystemAudioSilenceTracker({ warnAfterMs: 90_000 });
    let now = 0;
    // 60s quiet then speech, repeatedly — nobody should be warned about this.
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 300; i++) { expect(t.push(silence(CHUNK_FRAMES), now)).toBeNull(); now += 200; }
      expect(t.push(tone(CHUNK_FRAMES, 0.2), now)).toBeNull();
      now += 200;
    }
  });

  it('clears once signal returns, and can warn again on a later episode', () => {
    const t = new SystemAudioSilenceTracker({ warnAfterMs: 90_000 });
    let now = 0;
    let warned = null;
    for (let i = 0; i < 500; i++) { warned = t.push(silence(CHUNK_FRAMES), now) || warned; now += 200; }
    expect(warned).toBe('warn');

    // User switches their Mac's output device mid-meeting.
    expect(t.push(tone(CHUNK_FRAMES, 0.4), now)).toBe('clear');
    now += 200;
    expect(t.push(tone(CHUNK_FRAMES, 0.4), now)).toBeNull();
    now += 200;

    let second = null;
    for (let i = 0; i < 500; i++) { second = t.push(silence(CHUNK_FRAMES), now) || second; now += 200; }
    expect(second).toBe('warn');
  });

  it('treats dither-level noise as silence, not as signal', () => {
    // A dead tap can still carry ±1-LSB noise; that must not mask the failure.
    const t = new SystemAudioSilenceTracker({ warnAfterMs: 90_000 });
    const dither = Buffer.alloc(CHUNK_FRAMES * 2);
    for (let i = 0; i < CHUNK_FRAMES; i++) dither.writeInt16LE(i % 2 === 0 ? 1 : -1, i * 2);
    let now = 0;
    let verdict = null;
    for (let i = 0; i < 500; i++) { verdict = t.push(dither, now) || verdict; now += 200; }
    expect(verdict).toBe('warn');
  });

  it('reports how long the silence has lasted', () => {
    const t = new SystemAudioSilenceTracker();
    t.push(silence(CHUNK_FRAMES), 0);
    expect(t.silentSeconds(95_000)).toBe(95);
    t.push(tone(CHUNK_FRAMES, 0.5), 95_200);
    expect(t.silentSeconds(95_400)).toBe(0);
  });
});

describe('createSystemAudioMonitor — the wiring, not just the arithmetic', () => {
  const CH = 9600; // 200 ms at 48 kHz
  const mk = (over = {}) => {
    let recording = true;
    const m = createSystemAudioMonitor({
      isRecording: () => recording,
      ...over,
    });
    return { m, setRecording: (v) => { recording = v; } };
  };

  it('warns when AudioTee delivers NOTHING at all (no chunks ever)', () => {
    // The failure mode that cannot be observed without a Mac: if tapping a
    // non-default output yields no buffers rather than zero-filled ones, a
    // chunk-driven detector would never fire. The timer must cover it.
    const { m } = mk();
    m.reset(0);
    let warned = null;
    for (let now = 1000; now <= 200_000; now += 1000) {
      warned = m.tick(now) || warned;
    }
    expect(warned).toBe('warn');
    expect(m.state(200_000).receivedData).toBe(false);
  });

  it('warns only once for a no-data episode', () => {
    const { m } = mk();
    m.reset(0);
    let count = 0;
    for (let now = 1000; now <= 300_000; now += 1000) if (m.tick(now) === 'warn') count++;
    expect(count).toBe(1);
  });

  it('does not warn on no-data before the threshold', () => {
    const { m } = mk();
    m.reset(0);
    for (let now = 1000; now < 89_000; now += 1000) expect(m.tick(now)).toBeNull();
  });

  it('a healthy stream keeps the no-data timer quiet', () => {
    const { m } = mk();
    m.reset(0);
    let warned = null;
    for (let now = 200; now <= 300_000; now += 200) {
      m.handleChunk(tone(CH, 0.3), now);
      if (now % 1000 === 0) warned = m.tick(now) || warned;
    }
    expect(warned).toBeNull();
    expect(m.state(300_000).sawSignal).toBe(true);
  });

  it('a stream that stops mid-recording is caught by the timer', () => {
    const { m } = mk();
    m.reset(0);
    let now = 0;
    for (let i = 0; i < 50; i++) { now += 200; m.handleChunk(tone(CH, 0.3), now); }
    const stoppedAt = now;
    let warned = null;
    for (now = stoppedAt + 1000; now < stoppedAt + 200_000; now += 1000) warned = m.tick(now) || warned;
    expect(warned).toBe('warn');
  });

  it('never warns while the recording is paused', () => {
    const { m, setRecording } = mk();
    m.reset(0);
    setRecording(false);
    let warned = null;
    for (let now = 1000; now <= 600_000; now += 1000) warned = m.tick(now) || warned;
    expect(warned).toBeNull();
  });

  it('a pause does not carry a stale silence episode into the resume', () => {
    const { m, setRecording } = mk();
    m.reset(0);
    let now = 0;
    setRecording(false);
    // 10 minutes paused, chunks still flowing as silence
    for (let i = 0; i < 3000; i++) { now += 200; m.handleChunk(silence(CH), now); }
    setRecording(true);
    let warned = null;
    for (let i = 0; i < 300; i++) { now += 200; warned = m.handleChunk(silence(CH), now) || warned; }
    expect(warned).toBeNull(); // only 60s of real silence so far
    for (let i = 0; i < 200; i++) { now += 200; warned = m.handleChunk(silence(CH), now) || warned; }
    expect(warned).toBe('warn');
  });

  it('reports silent seconds for the payload the UI renders', () => {
    const { m } = mk();
    m.reset(0);
    m.handleChunk(silence(CH), 200);
    expect(m.state(95_200).silentSeconds).toBeGreaterThanOrEqual(90);
  });
});
