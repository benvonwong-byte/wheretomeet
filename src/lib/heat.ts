import type { GridSpec } from './types';

// Advantage-field render: every cell is colored by WHO reaches it sooner.
//  - Solid blue = A's turf (A arrives much sooner) — A/C/E blue
//  - Solid red = B's turf — 1/2/3 red
//  - Gold seam between them = balanced ground (N/Q/R/W yellow)
// Alpha = usability (combined travel time), so the seam glows brightest where
// meeting is balanced AND fast, and the field fades where nobody should go.
const A_RGB: [number, number, number] = [79, 99, 210]; // indigo — person A
const B_RGB: [number, number, number] = [210, 96, 74]; // terracotta — person B
const MID_RGB: [number, number, number] = [232, 181, 74]; // honey seam
const HOT_RGB: [number, number, number] = [255, 244, 205]; // warm cream core

const GAP_RANGE = 25; // minutes of advantage for a full-strength hue
const TOTAL_VIS_SCALE = 55; // combined minutes per e-fold of field fade
const BASE_ALPHA = 150;
const CORE_THRESHOLD = 0.7; // score fraction where the sweet-spot ignition starts

/** Diverging advantage color: gap = tA - tB minutes. Negative → blue (A's turf). */
export function advantageColor(gap: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, gap / GAP_RANGE));
  const [c0, c1, f] = t < 0 ? [A_RGB, MID_RGB, t + 1] : [MID_RGB, B_RGB, t];
  return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
}

/**
 * Render the advantage field. `timesA`/`timesB` are per-person best-mode
 * minutes; `scores` (tolerance-aware, max over active combos) drive the
 * sweet-spot ignition on top of the diverging field.
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

  // Fade relative to the best combined time on the map, so the field stays
  // vivid whether the two people are 2 km or 20 km apart.
  let minTotal = Infinity;
  for (let i = 0; i < timesA.length; i++) {
    const t = timesA[i] + timesB[i];
    if (t < minTotal) minTotal = t;
  }
  if (!isFinite(minTotal)) minTotal = 0;

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      const tA = timesA[i];
      const tB = timesB[i];
      const o = ((grid.rows - 1 - r) * grid.cols + c) * 4; // grid row 0 is south

      if (!isFinite(tA) || !isFinite(tB)) {
        img.data[o + 3] = 0;
        continue;
      }

      let [cr, cg, cb] = advantageColor(tA - tB);
      let alpha = Math.exp(-(tA + tB - minTotal) / TOTAL_VIS_SCALE) * BASE_ALPHA;

      // Sweet-spot ignition: blend toward white-gold and brighten.
      const s = max > 0 ? scores[i] / max : 0;
      if (s > CORE_THRESHOLD) {
        const k = (s - CORE_THRESHOLD) / (1 - CORE_THRESHOLD);
        cr += (HOT_RGB[0] - cr) * k;
        cg += (HOT_RGB[1] - cg) * k;
        cb += (HOT_RGB[2] - cb) * k;
        alpha = Math.max(alpha, 120 + 115 * k);
      }

      img.data[o] = cr;
      img.data[o + 1] = cg;
      img.data[o + 2] = cb;
      img.data[o + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
