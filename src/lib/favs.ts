import type { Pt } from './types';

// Favorites are scoped to the A↔B pair: the same two people (wherever each
// starts from, to ~110 m) share one list, in either direction.
const snap = (p: Pt) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;

export function pairKey(a: Pt, b: Pt): string {
  return [snap(a), snap(b)].sort().join('|');
}

function storageKey(a: Pt, b: Pt): string {
  return `w2m:favs:${pairKey(a, b)}`;
}

function read(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function loadFavs(a: Pt, b: Pt): Set<string> {
  return read(storageKey(a, b));
}

/** Union venue ids (e.g. from a shared link) into the pair's favorites. */
export function seedFavs(a: Pt, b: Pt, ids: string[]): Set<string> {
  const key = storageKey(a, b);
  const favs = read(key);
  for (const id of ids) favs.add(id);
  try {
    localStorage.setItem(key, JSON.stringify([...favs]));
  } catch {
    /* non-persistent */
  }
  return favs;
}

/** Toggle a venue id; returns the updated set. */
export function toggleFav(a: Pt, b: Pt, venueId: string): Set<string> {
  const key = storageKey(a, b);
  const favs = read(key);
  if (favs.has(venueId)) favs.delete(venueId);
  else favs.add(venueId);
  try {
    localStorage.setItem(key, JSON.stringify([...favs]));
  } catch {
    /* storage full/blocked — favorites just won't persist */
  }
  return favs;
}
