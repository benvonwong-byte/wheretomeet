import { cellCenter } from './geo';
import type { GridSpec, Pt, TimeField } from './types';

// Marching-squares isochrone extraction: lines of equal travel time.

/** All segments where `field` crosses `level` (minutes). */
export function contourSegments(field: TimeField, grid: GridSpec, level: number): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  const val = (r: number, c: number) => field[r * grid.cols + c];

  // Interpolated crossing point between two corners.
  const cross = (r0: number, c0: number, r1: number, c1: number): Pt => {
    const v0 = val(r0, c0);
    const v1 = val(r1, c1);
    const t = (level - v0) / (v1 - v0);
    const p0 = cellCenter(grid, r0, c0);
    const p1 = cellCenter(grid, r1, c1);
    return { lat: p0.lat + (p1.lat - p0.lat) * t, lng: p0.lng + (p1.lng - p0.lng) * t };
  };

  for (let r = 0; r + 1 < grid.rows; r++) {
    for (let c = 0; c + 1 < grid.cols; c++) {
      const tl = val(r + 1, c);
      const tr = val(r + 1, c + 1);
      const br = val(r, c + 1);
      const bl = val(r, c);
      if (![tl, tr, br, bl].every(isFinite)) continue;

      let idx = 0;
      if (tl >= level) idx |= 8;
      if (tr >= level) idx |= 4;
      if (br >= level) idx |= 2;
      if (bl >= level) idx |= 1;
      if (idx === 0 || idx === 15) continue;

      // Edge crossings: top (tl-tr), right (tr-br), bottom (bl-br), left (tl-bl)
      const top = () => cross(r + 1, c, r + 1, c + 1);
      const right = () => cross(r + 1, c + 1, r, c + 1);
      const bottom = () => cross(r, c, r, c + 1);
      const left = () => cross(r + 1, c, r, c);

      switch (idx) {
        case 1:
        case 14:
          out.push([left(), bottom()]);
          break;
        case 2:
        case 13:
          out.push([bottom(), right()]);
          break;
        case 3:
        case 12:
          out.push([left(), right()]);
          break;
        case 4:
        case 11:
          out.push([top(), right()]);
          break;
        case 5:
          out.push([left(), top()], [bottom(), right()]);
          break;
        case 6:
        case 9:
          out.push([top(), bottom()]);
          break;
        case 7:
        case 8:
          out.push([left(), top()]);
          break;
        case 10:
          out.push([top(), right()], [left(), bottom()]);
          break;
      }
    }
  }
  return out;
}

export interface RingFamily {
  /** Absolute minutes from this person's door. */
  level: number;
  /** Bold index ring (every 5 minutes) vs 1-minute hairline. */
  index: boolean;
  /** 0 at the person's fastest reachable cell → 1 at the range edge. */
  fade: number;
  segments: [Pt, Pt][];
}

const RING_RANGE_MIN = 40; // how far out (minutes) each person's ripples extend

/** 1-minute isochrone rings radiating from one person's travel-time field. */
export function personRings(field: TimeField, grid: GridSpec): RingFamily[] {
  let minT = Infinity;
  for (let i = 0; i < field.length; i++) if (field[i] < minT) minT = field[i];
  if (!isFinite(minT)) return [];
  const start = Math.ceil(minT + 0.5);
  const rings: RingFamily[] = [];
  for (let level = start; level <= minT + RING_RANGE_MIN; level++) {
    const segments = contourSegments(field, grid, level);
    if (!segments.length) continue;
    rings.push({
      level,
      index: level % 5 === 0,
      fade: (level - minT) / RING_RANGE_MIN,
      segments,
    });
  }
  return rings;
}
