import type { Pt } from './types';

// Nominatim, biased to NYC. Polite: single-flight, no autocomplete spam.
const NYC_VIEWBOX = '-74.26,40.49,-73.69,40.92';

export async function geocode(query: string): Promise<{ pt: Pt; label: string } | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&bounded=1' +
    `&viewbox=${NYC_VIEWBOX}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const results = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (!results.length) return null;
  const r = results[0];
  return {
    pt: { lat: parseFloat(r.lat), lng: parseFloat(r.lon) },
    label: r.display_name.split(',').slice(0, 2).join(','),
  };
}
