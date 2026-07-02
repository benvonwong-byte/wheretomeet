import { cellCenter, pointToCell } from './geo';
import { directTimeMin } from './modes';
import type { Pt, Mode, GridSpec, TimeField, ComboLayer } from './types';
import { transitField, type TransitGraph } from './transit';

// Fairness = small travel-time GAP first (user's rule), damped by max time so
// "equally miserable 2h trips" don't glow.
const GAP_SCALE = 12; // minutes
const MAX_TIME_SCALE = 50; // minutes

export function fairnessScore(tA: number, tB: number): number {
  if (!isFinite(tA) || !isFinite(tB)) return 0;
  const gap = Math.abs(tA - tB);
  const mx = Math.max(tA, tB);
  return Math.exp(-((gap / GAP_SCALE) ** 2)) * Math.exp(-mx / MAX_TIME_SCALE);
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

export function comboLayer(modeA: Mode, modeB: Mode, timesA: TimeField, timesB: TimeField): ComboLayer {
  const scores = new Float32Array(timesA.length);
  for (let i = 0; i < scores.length; i++) {
    scores[i] = fairnessScore(timesA[i], timesB[i]);
  }
  return { modeA, modeB, scores, timesA, timesB };
}

/** Average the scores of active layers. Returns zeros if none active. */
export function averageLayers(layers: ComboLayer[], cells: number): Float32Array {
  const out = new Float32Array(cells);
  if (layers.length === 0) return out;
  for (const layer of layers) {
    for (let i = 0; i < cells; i++) out[i] += layer.scores[i];
  }
  for (let i = 0; i < cells; i++) out[i] /= layers.length;
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
  let sum = 0;
  const combos = layers.map((l) => {
    sum += l.scores[idx];
    return { modeA: l.modeA, modeB: l.modeB, tA: l.timesA[idx], tB: l.timesB[idx] };
  });
  return { score: sum / layers.length, combos };
}
