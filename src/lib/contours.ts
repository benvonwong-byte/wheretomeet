import { cellCenter } from './geo';
import { advantageColor } from './heat';
import type { GridSpec, Pt, TimeField } from './types';

// Isochrone contour extraction: lines of equal COMBINED travel time, with
// each stretch colored by who reaches it sooner (the "gradient line").
export interface ContourSet {
  /** Minutes of combined travel this ring represents. */
  level: number;
  /** 0 = innermost ring. */
  rank: number;
  /** Segment batches grouped by advantage hue: color + disjoint segments. */
  batches: { color: string; segments: [Pt, Pt][] }[];
}

const GAP_BUCKETS = 7; // advantage quantization along the lines
const BUCKET_SPAN = 50; // minutes of gap covered edge-to-edge (-25..+25)

/**
 * Marching squares over `total` at `level`, tagging each segment with the
 * local A/B gap so callers can draw advantage-colored contour lines.
 */
export function contourAt(
  total: TimeField,
  gap: TimeField,
  grid: GridSpec,
  level: number,
): { color: string; segments: [Pt, Pt][] }[] {
  const buckets: [Pt, Pt][][] = Array.from({ length: GAP_BUCKETS }, () => []);
  const val = (r: number, c: number) => total[r * grid.cols + c];

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

      const segs: [Pt, Pt][] = [];
      switch (idx) {
        case 1:
        case 14:
          segs.push([left(), bottom()]);
          break;
        case 2:
        case 13:
          segs.push([bottom(), right()]);
          break;
        case 3:
        case 12:
          segs.push([left(), right()]);
          break;
        case 4:
        case 11:
          segs.push([top(), right()]);
          break;
        case 5:
          segs.push([left(), top()], [bottom(), right()]);
          break;
        case 6:
        case 9:
          segs.push([top(), bottom()]);
          break;
        case 7:
        case 8:
          segs.push([left(), top()]);
          break;
        case 10:
          segs.push([top(), right()], [left(), bottom()]);
          break;
      }

      const g = gap[r * grid.cols + c];
      const bucket = Math.max(
        0,
        Math.min(GAP_BUCKETS - 1, Math.floor(((g + BUCKET_SPAN / 2) / BUCKET_SPAN) * GAP_BUCKETS)),
      );
      for (const s of segs) buckets[bucket].push(s);
    }
  }

  return buckets
    .map((segments, i) => {
      const midGap = ((i + 0.5) / GAP_BUCKETS) * BUCKET_SPAN - BUCKET_SPAN / 2;
      const [cr, cg, cb] = advantageColor(midGap);
      return { color: `rgb(${Math.round(cr)},${Math.round(cg)},${Math.round(cb)})`, segments };
    })
    .filter((b) => b.segments.length > 0);
}

/** Ring levels: 5-minute increments radiating out from the optimum. */
export function contourLevels(minTotal: number): number[] {
  const base = Math.ceil((minTotal + 2) / 5) * 5; // first 5-min mark past the optimum
  return Array.from({ length: 8 }, (_, i) => base + i * 5);
}

export function buildContours(total: TimeField, gap: TimeField, grid: GridSpec): ContourSet[] {
  let minTotal = Infinity;
  for (let i = 0; i < total.length; i++) if (total[i] < minTotal) minTotal = total[i];
  if (!isFinite(minTotal)) return [];
  return contourLevels(minTotal).map((level, rank) => ({
    level,
    rank,
    batches: contourAt(total, gap, grid, level),
  }));
}
