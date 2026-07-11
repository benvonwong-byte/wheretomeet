import { haversineKm } from './geo';
import type { Venue } from './types';

// Five-boroughs box (a touch looser than the Overpass fetch bbox so Staten
// Island and the Rockaways submit fine).
export const NYC_BOUNDS = { latMin: 40.48, latMax: 40.93, lngMin: -74.28, lngMax: -73.68 };

/**
 * Pull { lat, lng } out of a pasted Google Maps URL or a raw coordinate string.
 * Prefers the place marker (!3d..!4d..) over the viewport center (@lat,lng),
 * since the marker is the actual storefront. Returns null if none is present —
 * e.g. an unexpanded maps.app.goo.gl short link, which has no coords in it.
 */
export function parseMapLink(text: string): { lat: number; lng: number } | null {
  const coord = (a: string, b: string): { lat: number; lng: number } | null => {
    const lat = parseFloat(a);
    const lng = parseFloat(b);
    return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  };
  // The place marker is authoritative — take it wherever it appears.
  const marker = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (marker) return coord(marker[1], marker[2]);
  // A directions/search URL only carries a viewport center or route waypoints,
  // never the venue itself — refuse rather than drop a pin blocks off.
  if (/\/maps\/(dir|search)\//i.test(text) || /\/(dir|search)\//i.test(text)) return null;
  for (const re of [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/, // viewport center (place URL: ~on the venue)
    /[?&]q(?:uery)?=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, // ?q=lat,lng
    /(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/, // raw "lat, lng" paste
  ]) {
    const m = text.match(re);
    const c = m && coord(m[1], m[2]);
    if (c) return c;
  }
  return null;
}

export interface SubmissionInput {
  name: string;
  pt: { lat: number; lng: number };
  vegan: 1 | 2; // vegan-friendly | fully vegan
  cat: Venue['cat'];
  cuisine?: string;
  addr?: string;
}

export type SubmitResult = { ok: true; venue: Venue } | { ok: false; reason: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * The automatic double-check before a submission joins the map: real name,
 * inside NYC, and not already on the map (same storefront, or the same name a
 * few doors down). Returns a ready-to-plot Venue, or a human-readable reason.
 */
export function validateSubmission(input: SubmissionInput, existing: Venue[]): SubmitResult {
  const name = input.name.trim();
  if (name.length < 2) return { ok: false, reason: 'Please enter the place’s name.' };

  const { lat, lng } = input.pt;
  if (!isFinite(lat) || !isFinite(lng)) return { ok: false, reason: 'We couldn’t pin that location — try a full address or a Google Maps link.' };
  if (lat < NYC_BOUNDS.latMin || lat > NYC_BOUNDS.latMax || lng < NYC_BOUNDS.lngMin || lng > NYC_BOUNDS.lngMax)
    return { ok: false, reason: 'That spot is outside NYC — this map only covers the five boroughs for now.' };

  const nn = norm(name);
  for (const e of existing) {
    const meters = haversineKm(input.pt, e) * 1000;
    if (meters < 35) return { ok: false, reason: `“${e.name}” is already on the map right here.` };
    // Fuzzy name-match dedup — but only when both names have real Latin content
    // (norm() empties non-Latin names → "" matches everything) and substring
    // matches use ≥4 chars so a two-letter name isn't "inside" every venue.
    const en = norm(e.name);
    const fuzzy = !!nn && !!en && (en === nn || (nn.length >= 4 && en.includes(nn)) || (en.length >= 4 && nn.includes(en)));
    if (meters < 250 && fuzzy) return { ok: false, reason: `“${e.name}” looks like this spot — it’s already on the map.` };
  }

  const venue: Venue = {
    // +1000 keeps minted ids clear of the curated s1/s2 supplement ids.
    id: 's' + (hashStr(nn + lat.toFixed(4) + lng.toFixed(4)) + 1000),
    name,
    lat: +lat.toFixed(6),
    lng: +lng.toFixed(6),
    cat: input.cat,
    vegan: input.vegan,
    tea: 0,
    cuisine: input.cuisine?.trim() ?? '',
    addr: input.addr?.trim() ?? '',
  };
  return { ok: true, venue };
}
