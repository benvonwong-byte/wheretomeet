import type { Pt, Mode, GridSpec, TimeField } from './types';
import { MODE_PARAMS } from './modes';
import { cellCenter } from './geo';

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
// Dev-only: on a deployed site there is no proxy, so skip straight to the
// public tiers instead of 404ing.
const IS_LOCAL = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const LOCAL_PATH: Partial<Record<Mode, string>> = IS_LOCAL
  ? { bike: '/osrm/bike', car: '/osrm/car', walk: '/osrm/foot' }
  : {};

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
 * Street-routed travel-time FIELD for the heatmap: samples the grid coarsely
 * (every `step`th cell) through the LOCAL OSRM only — ~2k points in ~11 table
 * calls — then bilinearly upsamples to the full grid. Null if the local
 * server is unreachable or any chunk fails; caller keeps the model field.
 */
export async function routedField(origin: Pt, mode: Mode, grid: GridSpec, step = 3): Promise<TimeField | null> {
  if (!(mode in LOCAL_PATH)) return null;
  const overhead = mode in MODE_PARAMS ? MODE_PARAMS[mode as keyof typeof MODE_PARAMS].overhead : 0;

  const cRows = Math.ceil(grid.rows / step);
  const cCols = Math.ceil(grid.cols / step);
  const pts: Pt[] = [];
  for (let r = 0; r < cRows; r++) {
    for (let c = 0; c < cCols; c++) {
      pts.push(cellCenter(grid, Math.min(r * step, grid.rows - 1), Math.min(c * step, grid.cols - 1)));
    }
  }

  const CHUNK = 180; // local osrm-routed runs with --max-table-size 200
  const coarse = new Float32Array(pts.length);
  const jobs: Promise<boolean>[] = [];
  for (let off = 0; off < pts.length; off += CHUNK) {
    const slice = pts.slice(off, off + CHUNK);
    jobs.push(
      localTable(origin, slice, mode).then((mins) => {
        if (!mins) return false;
        mins.forEach((m, i) => {
          coarse[off + i] = m == null ? Infinity : m + overhead;
        });
        return true;
      }).catch(() => false),
    );
  }
  const ok = (await Promise.all(jobs)).every(Boolean);
  if (!ok) return null;

  // Bilinear upsample coarse → full grid.
  const field = new Float32Array(grid.rows * grid.cols);
  for (let r = 0; r < grid.rows; r++) {
    const fr = Math.min(r / step, cRows - 1);
    const r0 = Math.floor(fr);
    const r1 = Math.min(r0 + 1, cRows - 1);
    const wr = fr - r0;
    for (let c = 0; c < grid.cols; c++) {
      const fc = Math.min(c / step, cCols - 1);
      const c0 = Math.floor(fc);
      const c1 = Math.min(c0 + 1, cCols - 1);
      const wc = fc - c0;
      const v00 = coarse[r0 * cCols + c0];
      const v01 = coarse[r0 * cCols + c1];
      const v10 = coarse[r1 * cCols + c0];
      const v11 = coarse[r1 * cCols + c1];
      // Infinity in any corner poisons the blend — take the finite min instead.
      const blend = v00 * (1 - wr) * (1 - wc) + v01 * (1 - wr) * wc + v10 * wr * (1 - wc) + v11 * wr * wc;
      field[r * grid.cols + c] = isFinite(blend) ? blend : Math.min(v00, v01, v10, v11);
    }
  }
  return field;
}

// Google Routes API — the reliable tier: works on the deployed site (the key
// is referrer-locked to it), needs no local servers, free 10k routes/month.
const ROUTES_KEY = import.meta.env.VITE_ROUTES_KEY as string | undefined;
const G_TRAVEL: Partial<Record<Mode, string>> = { car: 'DRIVE', bike: 'BICYCLE', walk: 'WALK' };

async function googleRoutesGeometry(origin: Pt, dest: Pt, mode: Mode, signal?: AbortSignal): Promise<Pt[] | null> {
  const travelMode = G_TRAVEL[mode];
  if (!ROUTES_KEY || !travelMode) return null;
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': ROUTES_KEY,
      'X-Goog-FieldMask': 'routes.polyline.geoJsonLinestring',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
      travelMode,
      polylineEncoding: 'GEO_JSON_LINESTRING',
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { routes?: { polyline?: { geoJsonLinestring?: { coordinates: [number, number][] } } }[] };
  const coords = json.routes?.[0]?.polyline?.geoJsonLinestring?.coordinates;
  return coords?.length ? coords.map(([lng, lat]) => ({ lat, lng })) : null;
}

// Promise-cached so concurrent calls for the same leg share one fetch
// (protects the Google Routes quota); true LRU via delete+re-set on hit.
const geoCache = new Map<string, Promise<Pt[] | null>>();
const GEO_CACHE_MAX = 150;

/**
 * Street route geometry origin → dest for drawing on the map.
 * Tiers: local OSRM → Google Routes → public OSRM. Null → straight estimate.
 */
export async function routedGeometry(origin: Pt, dest: Pt, mode: Mode, signal?: AbortSignal): Promise<Pt[] | null> {
  // 5 decimals ≈ 1m — 4 (~11m) collided for venues in the same building.
  const cacheKey = `${mode}:${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}:${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`;
  const hit = geoCache.get(cacheKey);
  if (hit) {
    geoCache.delete(cacheKey);
    geoCache.set(cacheKey, hit);
    return hit;
  }

  const q =
    `/route/v1/driving/${origin.lng.toFixed(6)},${origin.lat.toFixed(6)};` +
    `${dest.lng.toFixed(6)},${dest.lat.toFixed(6)}?overview=full&geometries=geojson`;

  const osrmTier = async (base: string): Promise<Pt[] | null> => {
    const res = await fetch(base + q, { signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { code: string; routes?: { geometry: { coordinates: [number, number][] } }[] };
    const coords = json.routes?.[0]?.geometry?.coordinates;
    return json.code === 'Ok' && coords?.length ? coords.map(([lng, lat]) => ({ lat, lng })) : null;
  };

  const local = LOCAL_PATH[mode];
  const profile = PROFILE[mode];
  const tiers: (() => Promise<Pt[] | null>)[] = [];
  if (local) tiers.push(() => osrmTier(local));
  tiers.push(() => googleRoutesGeometry(origin, dest, mode, signal));
  if (profile) tiers.push(() => osrmTier(`https://routing.openstreetmap.de/${profile}`));

  const attempt = (async () => {
    for (const tier of tiers) {
      try {
        const path = await tier();
        if (path) return path;
      } catch {
        /* next tier */
      }
    }
    return null;
  })();

  geoCache.set(cacheKey, attempt);
  if (geoCache.size > GEO_CACHE_MAX) geoCache.delete(geoCache.keys().next().value!);
  const path = await attempt;
  if (!path) geoCache.delete(cacheKey); // don't pin failures
  return path;
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
