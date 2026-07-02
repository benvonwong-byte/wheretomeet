import type { Venue } from './types';

export interface VenueFilter {
  categories: Set<Venue['cat']>;
  veganOnly: boolean; // fully vegan (level 2)
  veganFriendly: boolean; // level >= 1
  tea: boolean;
}

export function filterVenues(venues: Venue[], f: VenueFilter): Venue[] {
  return venues.filter((v) => {
    if (!f.categories.has(v.cat)) return false;
    // Vegan/tea are additive spotlights: if either is on, the venue must match one.
    if (f.veganOnly || f.veganFriendly || f.tea) {
      const veganHit = (f.veganOnly && v.vegan === 2) || (f.veganFriendly && v.vegan >= 1);
      const teaHit = f.tea && v.tea;
      return veganHit || teaHit;
    }
    return true;
  });
}
