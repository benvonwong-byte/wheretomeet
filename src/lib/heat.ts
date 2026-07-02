import type { GridSpec } from './types';

// Fair-zone gradient: transparent → teal → amber → hot coral/pink.
const STOPS: [number, [number, number, number, number]][] = [
  [0.0, [0, 179, 164, 0]],
  [0.25, [0, 179, 164, 90]],
  [0.5, [173, 203, 60, 140]],
  [0.72, [255, 181, 0, 175]],
  [1.0, [255, 45, 120, 215]],
];

function colorAt(t: number): [number, number, number, number] {
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    const [t0, c0] = STOPS[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return c0.map((v, k) => v + (c1[k] - v) * f) as [number, number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/**
 * Render averaged fairness scores to a canvas (one pixel per grid cell,
 * normalized to the field max so the hottest zone always reads).
 */
export function renderHeat(scores: Float32Array, grid: GridSpec): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols;
  canvas.height = grid.rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(grid.cols, grid.rows);

  let max = 0;
  for (let i = 0; i < scores.length; i++) if (scores[i] > max) max = scores[i];
  if (max <= 0) return canvas;

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const s = scores[r * grid.cols + c] / max;
      const [cr, cg, cb, ca] = colorAt(s);
      // canvas y grows downward; grid row 0 is south
      const y = grid.rows - 1 - r;
      const o = (y * grid.cols + c) * 4;
      img.data[o] = cr;
      img.data[o + 1] = cg;
      img.data[o + 2] = cb;
      img.data[o + 3] = ca;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
