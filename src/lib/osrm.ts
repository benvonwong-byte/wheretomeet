import type { Pt, Mode } from './types';
import { MODE_PARAMS } from './modes';

// Exact street-network travel times from the public OSRM instances
// (routing.openstreetmap.de) — real pathing, not straight-line estimates.
const PROFILE: Partial<Record<Mode, string>> = {
  bike: 'routed-bike',
  car: 'routed-car',
  walk: 'routed-foot',
};

const VALHALLA_COSTING: Partial<Record<Mode, string>> = {
  bike: 'bicycle',
  car: 'auto',
  walk: 'pedestrian',
};

async function osrmTable(origin: Pt, dests: Pt[], mode: Mode, signal?: AbortSignal): Promise<(number | null)[] | null> {
  const profile = PROFILE[mode];
  if (!profile) return null;
  const coords = [origin, ...dests].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `https://routing.openstreetmap.de/${profile}/table/v1/driving/${coords}?sources=0&annotations=duration`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const json = (await res.json()) as { code: string; durations?: (number | null)[][] };
  if (json.code !== 'Ok' || !json.durations?.[0]) return null;
  return json.durations[0].slice(1).map((sec) => (sec == null ? null : sec / 60));
}

async function valhallaTable(origin: Pt, dests: Pt[], mode: Mode, signal?: AbortSignal): Promise<(number | null)[] | null> {
  const costing = VALHALLA_COSTING[mode];
  if (!costing) return null;
  const res = await fetch('https://valhalla1.openstreetmap.de/sources_to_targets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      sources: [{ lat: origin.lat, lon: origin.lng }],
      targets: dests.map((p) => ({ lat: p.lat, lon: p.lng })),
      costing,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { sources_to_targets?: { time: number | null }[][] };
  const row = json.sources_to_targets?.[0];
  if (!row) return null;
  return row.map((c) => (c?.time == null ? null : c.time / 60));
}

/**
 * One matrix request: origin → each destination via real street pathing.
 * Tries OSRM, falls back to Valhalla. Minutes include the mode's fixed
 * overhead (parking etc.). Null on total failure — caller keeps model times.
 */
export async function routedMinutes(
  origin: Pt,
  dests: Pt[],
  mode: Mode,
  signal?: AbortSignal,
): Promise<(number | null)[] | null> {
  if (dests.length === 0 || !(mode in PROFILE)) return null;
  let mins: (number | null)[] | null = null;
  try {
    mins = await osrmTable(origin, dests, mode, signal);
  } catch {
    /* fall through */
  }
  if (!mins) {
    try {
      mins = await valhallaTable(origin, dests, mode, signal);
    } catch {
      return null;
    }
  }
  if (!mins) return null;
  const overhead = mode in MODE_PARAMS ? MODE_PARAMS[mode as keyof typeof MODE_PARAMS].overhead : 0;
  return mins.map((m) => (m == null ? null : m + overhead));
}
