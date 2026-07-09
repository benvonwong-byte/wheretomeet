import type { GridSpec, TimeField } from './types';

// Advantage color scale for contour lines on the light basemap:
// violet = A reaches this stretch sooner, crimson = B does, orange = even.
const A_RGB: [number, number, number] = [109, 63, 212]; // violet — person A
const B_RGB: [number, number, number] = [214, 60, 68]; // crimson — person B
const MID_RGB: [number, number, number] = [224, 134, 44]; // burnt orange — balanced

const GAP_RANGE = 25; // minutes of advantage for a full-strength hue

/** Diverging advantage color: gap = tA - tB minutes. Negative → blue (A's turf). */
export function advantageColor(gap: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, gap / GAP_RANGE));
  const [c0, c1, f] = t < 0 ? [A_RGB, MID_RGB, t + 1] : [MID_RGB, B_RGB, t];
  return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
}

// Radial glow: a warm bloom centered on the best-combined-time zone, fading
// with a gaussian falloff; hue leans toward whichever person is closer.
const GLOW_GOLD: [number, number, number] = [255, 206, 100];
const GLOW_FALLOFF_MIN = 16; // minutes past the optimum per e-fold² of fade
const GLOW_MAX_ALPHA = 135;

export function renderGlow(total: TimeField, gap: TimeField, grid: GridSpec): HTMLCanvasElement {
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
      const alpha = GLOW_MAX_ALPHA * Math.exp(-((d / GLOW_FALLOFF_MIN) ** 2));
      if (alpha < 2) continue;
      const [ar, ag, ab] = advantageColor(gap[i]);
      // golden core leaning toward the closer person's hue
      img.data[o] = GLOW_GOLD[0] * 0.55 + ar * 0.45;
      img.data[o + 1] = GLOW_GOLD[1] * 0.55 + ag * 0.45;
      img.data[o + 2] = GLOW_GOLD[2] * 0.55 + ab * 0.45;
      img.data[o + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
