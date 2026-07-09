import type { GridSpec, TimeField } from './types';

// HappyCow-inspired advantage scale — maximally opposed hues:
// leafy green = A gets there sooner, star yellow = even, cow purple = B sooner.
const A_RGB: [number, number, number] = [97, 166, 14]; // leafy green — person A
const B_RGB: [number, number, number] = [123, 44, 191]; // cow purple — person B
const MID_RGB: [number, number, number] = [255, 205, 20]; // star yellow — balanced

const GAP_RANGE = 14; // minutes of advantage for a fully-saturated hue (steep = obvious)

/** Diverging advantage color: gap = tA - tB minutes. Negative → green (A's turf). */
export function advantageColor(gap: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, gap / GAP_RANGE));
  const [c0, c1, f] = t < 0 ? [A_RGB, MID_RGB, t + 1] : [MID_RGB, B_RGB, t];
  return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
}

// Heat focus: alpha follows the SAME fairness score that ranks the venues, so
// the heat sits exactly where recommendations live — and the tolerance dial
// visibly reshapes it. (Keying on raw total time collapsed the zone onto the
// nearer person and hid the even/purple ground: the Paterson regression.)
const ZONE_CUTOFF = 0.3; // of the max score — below this the heat is gone
const MAX_ALPHA = 232;

export function renderHeat(scores: TimeField, gap: TimeField, grid: GridSpec): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols;
  canvas.height = grid.rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(grid.cols, grid.rows);

  let maxScore = 0;
  for (let i = 0; i < scores.length; i++) if (scores[i] > maxScore) maxScore = scores[i];
  if (maxScore <= 0) return canvas;

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      const o = ((grid.rows - 1 - r) * grid.cols + c) * 4; // grid row 0 is south
      const s = scores[i] / maxScore;
      if (!(s > ZONE_CUTOFF)) continue;
      const zone = (s - ZONE_CUTOFF) / (1 - ZONE_CUTOFF);
      const [cr, cg, cb] = advantageColor(gap[i]);
      img.data[o] = cr;
      img.data[o + 1] = cg;
      img.data[o + 2] = cb;
      img.data[o + 3] = MAX_ALPHA * (0.35 + 0.65 * zone ** 0.8);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
