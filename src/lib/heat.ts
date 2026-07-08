import type { GridSpec } from './types';

// Dual-overlay render in complementary hues (all real MTA bullet colors):
//  - Person A's reachability = blue wash (A/C/E blue — A's own bullet)
//  - Person B's reachability = red wash (1/2/3 red)
//  - Fused score core (shortest-total + fair) = golden yellow glow (N/Q/R/W)
// Where only one person is close you read their hue; where both are close the
// washes blend violet and the core ignites in gold.
const A_RGB: [number, number, number] = [45, 100, 235]; // A/C/E blue, brightened for map
const B_RGB: [number, number, number] = [235, 55, 46]; // 1/2/3 red
const WASH_TIME_SCALE = 22; // minutes per e-fold of a person's wash fade
const WASH_MAX_ALPHA = 95; // 0-255

// Core gradient for the fused score (normalized to field max): yellow → glowing gold.
const CORE: [number, [number, number, number, number]][] = [
  [0.0, [252, 204, 10, 0]],
  [0.55, [252, 204, 10, 0]], // core only ignites in the top ~45% of scores
  [0.72, [252, 204, 10, 150]],
  [0.88, [255, 226, 64, 205]],
  [1.0, [255, 246, 170, 240]],
];

function coreAt(t: number): [number, number, number, number] {
  for (let i = 1; i < CORE.length; i++) {
    const [t1, c1] = CORE[i];
    const [t0, c0] = CORE[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return c0.map((v, k) => v + (c1[k] - v) * f) as [number, number, number, number];
    }
  }
  return CORE[CORE.length - 1][1];
}

/** Composite `top` (rgba, alpha 0-255) over `base` in place. */
function over(base: [number, number, number, number], top: [number, number, number, number]): void {
  const ta = top[3] / 255;
  const ba = base[3] / 255;
  const outA = ta + ba * (1 - ta);
  if (outA <= 0) return;
  for (let k = 0; k < 3; k++) {
    base[k] = (top[k] * ta + base[k] * ba * (1 - ta)) / outA;
  }
  base[3] = outA * 255;
}

/**
 * Render the dual-overlay heat canvas: A wash + B wash + fused score core.
 * `timesA`/`timesB` are per-person best-mode minutes; `scores` the averaged
 * combo scores (normalized to their max for the core ramp).
 */
export function renderHeat(
  scores: Float32Array,
  timesA: Float32Array,
  timesB: Float32Array,
  grid: GridSpec,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols;
  canvas.height = grid.rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(grid.cols, grid.rows);

  let max = 0;
  for (let i = 0; i < scores.length; i++) if (scores[i] > max) max = scores[i];

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      const px: [number, number, number, number] = [0, 0, 0, 0];

      const wA = isFinite(timesA[i]) ? Math.exp(-timesA[i] / WASH_TIME_SCALE) : 0;
      const wB = isFinite(timesB[i]) ? Math.exp(-timesB[i] / WASH_TIME_SCALE) : 0;
      over(px, [...A_RGB, wA * WASH_MAX_ALPHA] as [number, number, number, number]);
      over(px, [...B_RGB, wB * WASH_MAX_ALPHA] as [number, number, number, number]);
      if (max > 0) over(px, coreAt(scores[i] / max));

      // canvas y grows downward; grid row 0 is south
      const o = ((grid.rows - 1 - r) * grid.cols + c) * 4;
      img.data[o] = px[0];
      img.data[o + 1] = px[1];
      img.data[o + 2] = px[2];
      img.data[o + 3] = px[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
