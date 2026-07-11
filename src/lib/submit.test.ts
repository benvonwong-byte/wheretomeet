import { describe, it, expect } from 'vitest';
import { parseMapLink, validateSubmission } from './submit';
import type { Venue } from './types';

const v = (id: string, name: string, lat: number, lng: number): Venue => ({
  id,
  name,
  lat,
  lng,
  cat: 'restaurant',
  vegan: 2,
  tea: 0,
  cuisine: '',
  addr: '',
});

describe('parseMapLink', () => {
  it('pulls the marker coords from a resolved Google Maps place URL (!3d!4d)', () => {
    const url =
      'https://www.google.com/maps/place/Tenon+Vegan+Sushi/@40.6779809,-73.975292,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d40.6779809!4d-73.9727117';
    // Prefers the place marker (!4d) over the viewport center (@)
    expect(parseMapLink(url)).toEqual({ lat: 40.6779809, lng: -73.9727117 });
  });

  it('falls back to the @lat,lng viewport when there is no marker', () => {
    expect(parseMapLink('https://maps.google.com/@40.703,-73.926,15z')).toEqual({ lat: 40.703, lng: -73.926 });
  });

  it('reads a raw "lat, lng" paste', () => {
    expect(parseMapLink('40.70362, -73.92640')).toEqual({ lat: 40.70362, lng: -73.9264 });
  });

  it('returns null when there are no coordinates', () => {
    expect(parseMapLink('https://maps.app.goo.gl/abc123')).toBeNull(); // unresolved short link
    expect(parseMapLink('just some text')).toBeNull();
  });

  it('refuses directions/search URLs (the @ is a viewport, not the venue)', () => {
    // /dir/ route: the venue is not the map center; don't pin the midpoint
    expect(parseMapLink('https://www.google.com/maps/dir/A/B/@40.72,-73.99,12z/data=!1m5!1d-73.95!2d40.80')).toBeNull();
    // /search/ viewport is blocks from any real venue
    expect(parseMapLink('https://www.google.com/maps/search/vegan/@40.70,-73.92,13z')).toBeNull();
  });
});

describe('validateSubmission', () => {
  const existing = [v('n1', 'Chipotle', 40.6779, -73.9726), v('n2', 'Geido', 40.6785, -73.973)];

  it('rejects a blank name', () => {
    const r = validateSubmission({ name: '  ', pt: { lat: 40.7, lng: -73.9 }, vegan: 2, cat: 'restaurant' }, []);
    expect(r.ok).toBe(false);
  });

  it('rejects a spot outside NYC', () => {
    const r = validateSubmission({ name: 'Vegan LA', pt: { lat: 34.05, lng: -118.24 }, vegan: 2, cat: 'restaurant' }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/NYC|five boroughs/i);
  });

  it('rejects a duplicate that sits on top of an existing venue', () => {
    // 40.67792,-73.97265 is ~10m from Chipotle → same storefront
    const r = validateSubmission({ name: 'Some New Place', pt: { lat: 40.67792, lng: -73.97265 }, vegan: 2, cat: 'restaurant' }, existing);
    expect(r.ok).toBe(false);
  });

  it('rejects a same-named spot a few doors down (fuzzy name + nearby)', () => {
    const r = validateSubmission({ name: 'geido', pt: { lat: 40.6789, lng: -73.9735 }, vegan: 2, cat: 'restaurant' }, existing);
    expect(r.ok).toBe(false);
  });

  it('does not blanket-reject a non-Latin name near existing venues', () => {
    // norm("本店") === "" must NOT match every nearby venue as a duplicate
    const r = validateSubmission({ name: '素食本店', pt: { lat: 40.6788, lng: -73.9732 }, vegan: 2, cat: 'restaurant' }, existing);
    expect(r.ok).toBe(true);
  });

  it('does not treat a short name as a substring duplicate', () => {
    const near = [v('n9', 'Café Bobo', 40.6788, -73.9732)];
    const block = { lat: 40.6798, lng: -73.9732 }; // ~110m away: past the 35m proximity dedup, inside the 250m name window
    // "Bo" normalizes to "bo" which is a substring of "cafebobo" — must NOT dedupe
    expect(validateSubmission({ name: 'Bo', pt: block, vegan: 2, cat: 'cafe' }, near).ok).toBe(true);
    // but the exact same name down the block IS a duplicate
    expect(validateSubmission({ name: 'Café Bobo', pt: block, vegan: 2, cat: 'cafe' }, near).ok).toBe(false);
  });

  it('accepts a genuinely new vegan spot and mints a shareable id', () => {
    const r = validateSubmission(
      { name: 'Tenon Vegan Sushi', pt: { lat: 40.6779809, lng: -73.9727117 }, vegan: 2, cat: 'restaurant', cuisine: 'sushi', addr: '329 Flatbush Ave' },
      [v('n1', 'Chipotle', 40.69, -73.99)], // far away, no conflict
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.venue.name).toBe('Tenon Vegan Sushi');
      expect(r.venue.vegan).toBe(2);
      expect(r.venue.cat).toBe('restaurant');
      expect(r.venue.id).toMatch(/^s\d+$/); // supplement id scheme, survives the share-link fav filter
    }
  });
});
