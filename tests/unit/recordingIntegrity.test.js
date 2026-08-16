/**
 * Truncation guard.
 *
 * A recording that silently loses chunks produces a file that is short but
 * otherwise perfect: valid WebM, above the minimum size, readable head and tail.
 * It passed validateAudioOutput, upload and two-phase verification looking
 * healthy — which is how the t.kaufmann truncation hid behind the wall-clock
 * timer. The backend's audio-duration guard only catches files that are too
 * LONG (duplicated audio); nothing caught one that was too SHORT.
 *
 * The first version of this guard shipped DEAD: it compared the probe against
 * metadata.duration, which is only written after the combine by that same probe,
 * so it read 0 and did nothing. These tests exist because that fake fix passed
 * review — the logic is now pure, so "does it actually fire" is a fact, not a hope.
 */
import { describe, expect, it } from 'vitest';
import { evaluateTruncation } from '../../src-electron/recording-integrity.js';

describe('evaluateTruncation', () => {
  it('fires on a real truncation (half an hour meeting, half of it missing)', () => {
    const v = evaluateTruncation(900, 1800);
    expect(v.truncated).toBe(true);
    expect(v.shortfallSec).toBe(900);
  });

  it('fires on the incident shape: a 68-minute session that produced 40 minutes', () => {
    const v = evaluateTruncation(2400, 4119);
    expect(v.truncated).toBe(true);
    expect(Math.round(v.shortfallSec)).toBe(1719);
  });

  it('stays silent on a healthy recording (the s1-baseline case)', () => {
    // 235.2s produced against a ~236s wall clock — normal encoder trim.
    expect(evaluateTruncation(235.2, 236).truncated).toBe(false);
  });

  it('stays silent when the file is marginally longer than the wall clock', () => {
    expect(evaluateTruncation(240, 236).truncated).toBe(false);
  });

  it('ignores a shortfall under the absolute floor even in a short meeting', () => {
    // 20s missing from 100s clears 10% but not 30s — noise, not data loss.
    const v = evaluateTruncation(80, 100);
    expect(v.truncated).toBe(false);
    expect(v.reason).toBe('below-absolute-floor');
  });

  it('ignores a shortfall under the relative floor in a long meeting', () => {
    // 40s missing from 4 hours is 0.3% — encoder trim, not loss.
    const v = evaluateTruncation(14360, 14400);
    expect(v.truncated).toBe(false);
    expect(v.reason).toBe('below-relative-floor');
  });

  it('needs BOTH floors cleared', () => {
    // 100s missing from 600s: 100 > 30 absolute AND 100 > 60 relative.
    expect(evaluateTruncation(500, 600).truncated).toBe(true);
    // 50s missing from 1000s: clears absolute, fails relative (needs 100).
    expect(evaluateTruncation(950, 1000).truncated).toBe(false);
  });

  it('never cries wolf when either number is unknown', () => {
    // A missing probe or a missing wall clock must not be read as data loss.
    expect(evaluateTruncation(0, 1800)).toMatchObject({ truncated: false, reason: 'produced-unknown' });
    expect(evaluateTruncation(900, 0)).toMatchObject({ truncated: false, reason: 'expected-unknown' });
    expect(evaluateTruncation(NaN, 1800).truncated).toBe(false);
    expect(evaluateTruncation(900, undefined).truncated).toBe(false);
    expect(evaluateTruncation(null, null).truncated).toBe(false);
    expect(evaluateTruncation(Infinity, 1800).truncated).toBe(false);
  });
});
