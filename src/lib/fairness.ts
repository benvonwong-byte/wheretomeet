import { cellCenter, pointToCell } from './geo';
import { directTimeMin } from './modes';
import type { Pt, Mode, GridSpec, TimeField, ComboLayer } from './types';
import { transitField, type TransitGraph } from './transit';

// Score = shortest TOTAL time first (get together fast), damped by the
// travel-time gap so lopsided spots don't win on speed alone. The hottest
// cell is "minimum combined travel among fair-ish spots" and the score
// radiates outward as combined time grows.
const TOTAL_TIME_SCALE = 45; // combined minutes per e-fold of decay
const EVEN_ALLOWANCE = 8; // minutes around the fair point that cost nothing
const EXCESS_SOFTNESS = 8; // minutes; how quickly score dies past the allowance

/**
 * `bias` shifts WHERE "even" sits, in minutes: negative = person A deserves
 * the advantage (ideal spots have tA ≈ tB + bias, i.e. A travels less);
 * positive favors B; 0 = classic fair split. Gaps within ±EVEN_ALLOWANCE of
 * the shifted fair point cost nothing; only the excess is penalized.
 */
export function fairnessScore(tA: number, tB: number, bias = 0): number {
  if (!isFinite(tA) || !isFinite(tB)) return 0;
  const excess = Math.max(0, Math.abs(tA - tB - bias) - EVEN_ALLOWANCE);
  const total = tA + tB;
  return Math.exp(-total / TOTAL_TIME_SCALE) * Math.exp(-((excess / EXCESS_SOFTNESS) ** 2));
}

export function timeField(graph: TransitGraph, origin: Pt, mode: Mode, grid: GridSpec): TimeField {
  if (mode === 'transit') return transitField(graph, origin, grid);
  const field = new Float32Array(grid.rows * grid.cols);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      field[r * grid.cols + c] = directTimeMin(origin, cellCenter(grid, r, c), mode);
    }
  }
  return field;
}

export function comboLayer(modeA: Mode, modeB: Mode, timesA: TimeField, timesB: TimeField, bias = 0): ComboLayer {
  const scores = new Float32Array(timesA.length);
  for (let i = 0; i < scores.length; i++) {
    scores[i] = fairnessScore(timesA[i], timesB[i], bias);
  }
  return { modeA, modeB, scores, timesA, timesB };
}

/**
 * Best active combo per cell (max score). People ride their best available
 * mode, so a slow toggled-on combo must not drag good cells down — and this
 * keeps the core consistent with the min-based reachability washes.
 */
export function maxLayers(layers: ComboLayer[], cells: number): Float32Array {
  const out = new Float32Array(cells);
  for (const layer of layers) {
    for (let i = 0; i < cells; i++) if (layer.scores[i] > out[i]) out[i] = layer.scores[i];
  }
  return out;
}

/**
 * Per-person aggregate travel-time field across active layers: each cell's
 * best (minimum) time over that person's active modes. Feeds the dual
 * reachability washes in the heat render.
 */
export function minPersonField(layers: ComboLayer[], person: 'A' | 'B', cells: number): Float32Array {
  const out = new Float32Array(cells).fill(Infinity);
  for (const layer of layers) {
    const t = person === 'A' ? layer.timesA : layer.timesB;
    for (let i = 0; i < cells; i++) if (t[i] < out[i]) out[i] = t[i];
  }
  return out;
}

export interface VenueScore {
  score: number;
  /** Per active combo: [modeA, modeB, tA minutes, tB minutes]. */
  combos: { modeA: Mode; modeB: Mode; tA: number; tB: number }[];
}

export function scoreAtPoint(grid: GridSpec, layers: ComboLayer[], p: Pt): VenueScore | null {
  const idx = pointToCell(grid, p);
  if (idx < 0 || layers.length === 0) return null;
  let best = 0;
  const combos = layers.map((l) => {
    if (l.scores[idx] > best) best = l.scores[idx];
    return { modeA: l.modeA, modeB: l.modeB, tA: l.timesA[idx], tB: l.timesB[idx] };
  });
  return { score: best, combos };
}
