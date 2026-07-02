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

// Local self-hosted OSRM (scripts/routing-servers.sh), proxied by Vite.
const LOCAL_PATH: Partial<Record<Mode, string>> = {
  bike: '/osrm/bike',
  car: '/osrm/car',
  walk: '/osrm/foot',
};

function parseOsrm(json: { code: string; durations?: (number | null)[][] }): (number | null)[] | null {
  if (json.code !== 'Ok' || !json.durations?.[0]) return null;
  return json.durations[0].slice(1).map((sec) => (sec == null ? null : sec / 60));
}

const tableQuery = (origin: Pt, dests: Pt[]) =>
  '/table/v1/driving/' +
  [origin, ...dests].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';') +
  '?sources=0&annotations=duration';

async function localTable(origin: Pt, dests: Pt[], mode: Mode, signal?: AbortSignal): Promise<(number | null)[] | null> {
  const base = LOCAL_PATH[mode];
  if (!base) return null;
  const res = await fetch(base + tableQuery(origin, dests), { signal });
  if (!res.ok) return null;
  return parseOsrm(await res.json());
}

async function osrmTable(origin: Pt, dests: Pt[], mode: Mode, signal?: AbortSignal): Promise<(number | null)[] | null> {
  const profile = PROFILE[mode];
  if (!profile) return null;
  const res = await fetch(`https://routing.openstreetmap.de/${profile}` + tableQuery(origin, dests), { signal });
  if (!res.ok) return null;
  return parseOsrm(await res.json());
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
 * Tier order: local self-hosted OSRM → public OSRM → public Valhalla.
 * Minutes include the mode's fixed overhead (parking etc.).
 * Null on total failure — caller keeps model times.
 */
export async function routedMinutes(
  origin: Pt,
  dests: Pt[],
  mode: Mode,
  signal?: AbortSignal,
): Promise<(number | null)[] | null> {
  if (dests.length === 0 || !(mode in PROFILE)) return null;
  let mins: (number | null)[] | null = null;
  for (const tier of [localTable, osrmTable, valhallaTable]) {
    try {
      mins = await tier(origin, dests, mode, signal);
    } catch {
      mins = null;
    }
    if (mins) break;
  }
  if (!mins) return null;
  const overhead = mode in MODE_PARAMS ? MODE_PARAMS[mode as keyof typeof MODE_PARAMS].overhead : 0;
  return mins.map((m) => (m == null ? null : m + overhead));
}
