import { haversineKm } from './geo';
import type { Pt } from './types';

// Best-guess NYC calibration. Speeds in km/h, overheads in minutes.
// Detour factor converts straight-line to street-network distance (Manhattan grid ~1.3-1.4).
export const MODE_PARAMS = {
  walk: { speed: 4.8, detour: 1.3, overhead: 0 },
  bike: { speed: 14, detour: 1.35, overhead: 2 }, // unlock/park a Citi Bike
  car: { speed: 22, detour: 1.4, overhead: 7 }, // NYC traffic avg + parking
} as const;

export function directTimeMin(a: Pt, b: Pt, mode: keyof typeof MODE_PARAMS): number {
  const p = MODE_PARAMS[mode];
  const km = haversineKm(a, b) * p.detour;
  return p.overhead + (km / p.speed) * 60;
}

export function walkMin(a: Pt, b: Pt): number {
  return directTimeMin(a, b, 'walk');
}
