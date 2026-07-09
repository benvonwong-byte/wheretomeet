import type { GridSpec, TimeField } from './types';

// Thyme & Place advantage scale — culinary earth tones, no default-AI violet:
// juniper teal = A reaches this ground sooner, paprika = B does, saffron = even.
const A_RGB: [number, number, number] = [14, 124, 116]; // juniper teal — person A
const B_RGB: [number, number, number] = [192, 90, 53]; // paprika — person B
const MID_RGB: [number, number, number] = [217, 154, 43]; // saffron — balanced

const GAP_RANGE = 25; // minutes of advantage for a full-strength hue

/** Diverging advantage color: gap = tA - tB minutes. Negative → teal (A's turf). */
export function advantageColor(gap: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, gap / GAP_RANGE));
  const [c0, c1, f] = t < 0 ? [A_RGB, MID_RGB, t + 1] : [MID_RGB, B_RGB, t];
  return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
}

// Closeness bands: quantized +5-minute steps of combined travel time from the
// best meeting zone. Brightest = quickest for both; fades stepwise outward.
const BAND_MIN = 5; // minutes per band
const BAND_ALPHA = [120, 96, 72, 52, 34, 20, 10]; // one entry per band, then 0
const WARM_CORE: [number, number, number] = [240, 186, 89]; // saffron glow

export function renderBands(total: TimeField, gap: TimeField, grid: GridSpec): HTMLCanvasElement {
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
      const band = Math.floor((total[i] - minTotal) / BAND_MIN);
      if (band >= BAND_ALPHA.length) continue;
      const [ar, ag, ab] = advantageColor(gap[i]);
      // saffron closeness glow, leaning toward the closer person's hue
      img.data[o] = WARM_CORE[0] * 0.6 + ar * 0.4;
      img.data[o + 1] = WARM_CORE[1] * 0.6 + ag * 0.4;
      img.data[o + 2] = WARM_CORE[2] * 0.6 + ab * 0.4;
      img.data[o + 3] = BAND_ALPHA[band];
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
