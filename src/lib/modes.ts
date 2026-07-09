import { haversineKm } from './geo';
import type { Pt } from './types';

// Best-guess NYC calibration. Speeds in km/h, overheads in minutes.
// Detour factor converts straight-line to street-network distance.
//
// Car and bike speeds are DISTANCE-DEPENDENT: short hops crawl through city
// streets, longer trips shift onto arterials/highways. Calibrated against
// OSRM street routing (e.g. Paterson→Chelsea, 25 km straight-line: real ≈ 34′;
// a flat 22 km/h said 100′ and painted the whole city one color).
export const MODE_PARAMS = {
  walk: { speedNear: 4.8, speedFar: 4.8, rampKm: 1, detour: 1.3, overhead: 0 },
  bike: { speedNear: 13, speedFar: 17, rampKm: 12, detour: 1.35, overhead: 2 }, // unlock/park a Citi Bike
  car: { speedNear: 17, speedFar: 55, rampKm: 20, detour: 1.35, overhead: 7 }, // city crawl → highway + parking
} as const;

/** Effective speed for a trip of `km` straight-line: ramps speedNear → speedFar. */
function effectiveSpeed(mode: keyof typeof MODE_PARAMS, km: number): number {
  const p = MODE_PARAMS[mode];
  const t = Math.min(km / p.rampKm, 1);
  return p.speedNear + (p.speedFar - p.speedNear) * t;
}

export function directTimeMin(a: Pt, b: Pt, mode: keyof typeof MODE_PARAMS): number {
  const p = MODE_PARAMS[mode];
  const km = haversineKm(a, b);
  return p.overhead + ((km * p.detour) / effectiveSpeed(mode, km)) * 60;
}

export function walkMin(a: Pt, b: Pt): number {
  return directTimeMin(a, b, 'walk');
}
