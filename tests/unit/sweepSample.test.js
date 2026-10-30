// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { sweepPoints } from './support/sweep.js';

// Review round 11 (Windows CI time): the points of a sweep. Full by default
// (Linux, macOS, local); with SWEEP_SAMPLE=<fraction> (the Windows runner)
// a fixed-seed sample that always keeps the first two and the last two
// points. Mutants and named points are never sampled.

const all = (max) => Array.from({ length: max }, (_, i) => i + 1);

describe('sweep points', () => {
  it('full without a sample', () => {
    expect(sweepPoints(81, 'recovery', {})).toEqual(all(81));
    expect(sweepPoints(81, 'recovery', { sample: '1' })).toEqual(all(81));
  });

  it('a sample: the same points for the same seed and entry, the edges always in', () => {
    const a = sweepPoints(81, 'recovery with finalization', { sample: '0.15', seed: 'r11' });
    const b = sweepPoints(81, 'recovery with finalization', { sample: '0.15', seed: 'r11' });
    expect(a).toEqual(b);
    expect(a).toEqual(expect.arrayContaining([1, 2, 80, 81]));
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThan(30);
    expect([...a].sort((x, y) => x - y)).toEqual(a);
    expect(sweepPoints(81, 'recovery re-scan', { sample: '0.15', seed: 'r11' })).not.toEqual(a);
  });

  it('short entries stay complete', () => {
    for (const max of [1, 2, 3, 4]) expect(sweepPoints(max, 'x', { sample: '0.15', seed: 'r11' })).toEqual(all(max));
  });

  it('an invalid sample fails, it does not silently skip the sweep', () => {
    expect(() => sweepPoints(10, 'x', { sample: '0' })).toThrow(/SWEEP_SAMPLE/);
    expect(() => sweepPoints(10, 'x', { sample: 'abc' })).toThrow(/SWEEP_SAMPLE/);
  });
});
