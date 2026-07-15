import { describe, it, expect } from 'vitest';
import { groupScore, groupLayer } from './fairness';
import { benefitColor } from './heat';

describe('benefitColor (group heat scale)', () => {
  it('0 = cow purple (tough for some), 0.5 = star yellow, 1 = leafy green (best for everyone)', () => {
    expect(benefitColor(0)).toEqual([123, 44, 191]);
    expect(benefitColor(0.5)).toEqual([255, 205, 20]);
    expect(benefitColor(1)).toEqual([97, 166, 14]);
  });

  it('clamps out-of-range input', () => {
    expect(benefitColor(-2)).toEqual(benefitColor(0));
    expect(benefitColor(9)).toEqual(benefitColor(1));
  });
});

describe('groupScore (3+ people blend)', () => {
  // The design's worked example: balanced spot vs one-far spot.
  const balanced = [24, 26, 28]; // worst 28, mean 26
  const oneFar = [12, 18, 40]; // worst 40, mean 23.3

  it('λ=0 is minimax — the balanced spot (lower worst) wins', () => {
    expect(groupScore(balanced, 0)).toBeGreaterThan(groupScore(oneFar, 0));
  });

  it('λ=1 is efficient — the lower-total spot wins', () => {
    expect(groupScore(oneFar, 1)).toBeGreaterThan(groupScore(balanced, 1));
  });

  it('is monotonic: more minutes for everyone = lower score', () => {
    expect(groupScore([10, 10, 10], 0.5)).toBeGreaterThan(groupScore([30, 30, 30], 0.5));
  });

  it('an unreachable person (Infinity) makes the spot a non-option (score 0)', () => {
    expect(groupScore([10, Infinity, 12], 0.5)).toBe(0);
  });

  it('handles a single person (near-me degenerate) as just their time', () => {
    expect(groupScore([10], 0.3)).toBeGreaterThan(groupScore([25], 0.3));
  });
});

describe('groupLayer', () => {
  it('scores each cell by groupScore over the per-person fields', () => {
    const f1 = new Float32Array([10, 30]);
    const f2 = new Float32Array([20, 10]);
    const f3 = new Float32Array([12, 50]);
    const layer = groupLayer([f1, f2, f3], 0.3);
    expect(layer.times.length).toBe(3);
    expect(layer.scores[0]).toBeCloseTo(groupScore([10, 20, 12], 0.3), 6);
    expect(layer.scores[1]).toBeCloseTo(groupScore([30, 10, 50], 0.3), 6);
    // cell 0 (tighter, closer) should beat cell 1 (one at 50)
    expect(layer.scores[0]).toBeGreaterThan(layer.scores[1]);
  });
});
