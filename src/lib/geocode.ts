import type { Pt } from './types';

export interface GeoHit {
  pt: Pt;
  label: string;
}

// NYC metro bounds for filtering results.
const BOX = { latMin: 40.49, latMax: 40.95, lngMin: -74.27, lngMax: -73.65 };
const inNYC = (pt: Pt) => pt.lat >= BOX.latMin && pt.lat <= BOX.latMax && pt.lng >= BOX.lngMin && pt.lng <= BOX.lngMax;

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    housenumber?: string;
    street?: string;
    district?: string;
    city?: string;
    state?: string;
    osm_value?: string;
  };
}

function photonLabel(p: PhotonFeature['properties']): string {
  const line = p.name ?? [p.housenumber, p.street].filter(Boolean).join(' ');
  const area = p.district && p.district !== line ? p.district : p.city ?? '';
  return [line, area].filter(Boolean).join(', ');
}

/** As-you-type suggestions via Photon (komoot) — typo-tolerant, CORS, no key. */
export async function suggest(query: string, signal?: AbortSignal): Promise<GeoHit[]> {
  const url =
    'https://photon.komoot.io/api?limit=8&lat=40.73&lon=-73.98' + `&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const json = (await res.json()) as { features: PhotonFeature[] };
  const seen = new Set<string>();
  const hits: GeoHit[] = [];
  for (const f of json.features ?? []) {
    const pt = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
    if (!inNYC(pt)) continue;
    const label = photonLabel(f.properties);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    hits.push({ pt, label });
    if (hits.length >= 5) break;
  }
  return hits;
}

/** Precise single-shot geocode via Nominatim (Enter with no suggestion picked). */
export async function geocode(query: string): Promise<GeoHit | null> {
  const viewbox = `${BOX.lngMin},${BOX.latMin},${BOX.lngMax},${BOX.latMax}`;
  const q = /new york|brooklyn|queens|bronx|manhattan|staten|nyc|, ny/i.test(query)
    ? query
    : `${query}, New York City`;
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&bounded=1' +
    `&viewbox=${viewbox}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const results = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (!results.length) return null;
  const r = results[0];
  const pt = { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
  if (!inNYC(pt)) return null;
  return { pt, label: r.display_name.split(',').slice(0, 2).join(',') };
}

/** Debounced suggestion runner with an LRU cache and stale-response cancellation. */
export function makeSuggester(onResults: (hits: GeoHit[]) => void): (query: string) => void {
  let timer = 0;
  let ctrl: AbortController | null = null;
  const cache = new Map<string, GeoHit[]>(); // insertion-ordered → LRU
  const CACHE_MAX = 120;

  return (query: string) => {
    window.clearTimeout(timer);
    ctrl?.abort();
    const q = query.trim().toLowerCase();
    if (q.length < 3) {
      onResults([]);
      return;
    }
    const hit = cache.get(q);
    if (hit) {
      onResults(hit); // instant on backspace/retype
      return;
    }
    timer = window.setTimeout(async () => {
      ctrl = new AbortController();
      try {
        const hits = await suggest(q, ctrl.signal);
        cache.delete(q);
        cache.set(q, hits);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
        onResults(hits);
      } catch {
        /* aborted or offline — keep quiet */
      }
    }, 140);
  };
}
