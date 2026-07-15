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

// Heat anchored to the RECOMMENDED VENUES: a soft gaussian glow around each
// ranked spot (nothing anywhere else), colored by who reaches that ground
// sooner. Filters and sorting reshape the heat because it follows the list.
const SIGMA_CELLS = 2.4; // ~650m blob softness
const WINDOW = 8; // cells painted around each venue
const MAX_ALPHA = 225;

export function renderHeat(gap: TimeField, venueCells: number[], grid: GridSpec, bias = 0): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols;
  canvas.height = grid.rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(grid.cols, grid.rows);
  if (!venueCells.length) return canvas;

  // Accumulate gaussian weight around each recommended venue.
  const weight = new Float32Array(gap.length);
  for (const cell of venueCells) {
    if (cell < 0) continue;
    const vr = Math.floor(cell / grid.cols);
    const vc = cell % grid.cols;
    for (let r = Math.max(0, vr - WINDOW); r <= Math.min(grid.rows - 1, vr + WINDOW); r++) {
      for (let c = Math.max(0, vc - WINDOW); c <= Math.min(grid.cols - 1, vc + WINDOW); c++) {
        const d2 = (r - vr) ** 2 + (c - vc) ** 2;
        weight[r * grid.cols + c] += Math.exp(-d2 / (2 * SIGMA_CELLS * SIGMA_CELLS));
      }
    }
  }

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      if (!isFinite(gap[i]) || weight[i] < 0.12) continue;
      const o = ((grid.rows - 1 - r) * grid.cols + c) * 4; // grid row 0 is south
      const [cr, cg, cb] = advantageColor(gap[i] - bias); // yellow sits on the shifted fair point
      img.data[o] = cr;
      img.data[o + 1] = cg;
      img.data[o + 2] = cb;
      img.data[o + 3] = MAX_ALPHA * Math.min(1, weight[i]) ** 0.7;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Group mode (3+): ONE benefit axis, like the duo gradient. Green = this
// ground works for everyone (high blend score at the current λ), yellow =
// decent, purple = somebody gets a rough trip. Five distinct person hues
// blended together were unreadable — a single scale answers the actual
// question: "which areas benefit the most people?"
export function benefitColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  const [c0, c1, f] = x < 0.5 ? [B_RGB, MID_RGB, x * 2] : [MID_RGB, A_RGB, (x - 0.5) * 2];
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * f),
    Math.round(c0[1] + (c1[1] - c0[1]) * f),
    Math.round(c0[2] + (c1[2] - c0[2]) * f),
  ];
}

export function renderGroupBenefit(scores: TimeField, venueCells: number[], grid: GridSpec): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols;
  canvas.height = grid.rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(grid.cols, grid.rows);
  if (!venueCells.length) return canvas;

  // Contrast-stretch across the recommended zone: the best venue ground is
  // pure green, the viability-gate edge trails toward yellow/purple.
  let hi = 0;
  let lo = Infinity;
  for (const cell of venueCells) {
    if (cell < 0) continue;
    const s = scores[cell];
    if (s > hi) hi = s;
    if (s < lo) lo = s;
  }
  if (hi <= 0) return canvas;
  const span = Math.max(hi - lo, hi * 0.15); // guard: one venue ≠ all-green flatline

  const weight = new Float32Array(scores.length);
  for (const cell of venueCells) {
    if (cell < 0) continue;
    const vr = Math.floor(cell / grid.cols);
    const vc = cell % grid.cols;
    for (let r = Math.max(0, vr - WINDOW); r <= Math.min(grid.rows - 1, vr + WINDOW); r++) {
      for (let c = Math.max(0, vc - WINDOW); c <= Math.min(grid.cols - 1, vc + WINDOW); c++) {
        const d2 = (r - vr) ** 2 + (c - vc) ** 2;
        weight[r * grid.cols + c] += Math.exp(-d2 / (2 * SIGMA_CELLS * SIGMA_CELLS));
      }
    }
  }

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      if (weight[i] < 0.12 || !isFinite(scores[i])) continue;
      const [cr, cg, cb] = benefitColor((scores[i] - lo) / span);
      const o = ((grid.rows - 1 - r) * grid.cols + c) * 4; // grid row 0 is south
      img.data[o] = cr;
      img.data[o + 1] = cg;
      img.data[o + 2] = cb;
      img.data[o + 3] = MAX_ALPHA * Math.min(1, weight[i]) ** 0.7;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
