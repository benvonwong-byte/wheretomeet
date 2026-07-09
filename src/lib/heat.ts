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

// Heat focus: fully opaque inside the recommended zone (near the best combined
// time), falling to nothing beyond it so the heat hugs the results.
const ZONE_FULL_MIN = 8; // minutes past the optimum at full strength
const ZONE_EDGE_MIN = 26; // gone entirely by here
const MAX_ALPHA = 232;

export function renderHeat(total: TimeField, gap: TimeField, grid: GridSpec): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols;
  canvas.height = grid.rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(grid.cols, grid.rows);

  let minTotal = Infinity;
  for (let i = 0; i < total.length; i++) if (total[i] < minTotal) minTotal = total[i];
  if (!isFinite(minTotal)) return canvas;

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      const o = ((grid.rows - 1 - r) * grid.cols + c) * 4; // grid row 0 is south
      if (!isFinite(total[i])) {
        img.data[o + 3] = 0;
        continue;
      }
      const d = total[i] - minTotal;
      const zone = Math.max(0, Math.min(1, 1 - (d - ZONE_FULL_MIN) / (ZONE_EDGE_MIN - ZONE_FULL_MIN)));
      if (zone <= 0) continue;
      const [cr, cg, cb] = advantageColor(gap[i]);
      img.data[o] = cr;
      img.data[o + 1] = cg;
      img.data[o + 2] = cb;
      img.data[o + 3] = MAX_ALPHA * zone ** 1.3;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
