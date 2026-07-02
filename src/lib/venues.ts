import type { Venue } from './types';

export interface VenueFilter {
  categories: Set<Venue['cat']>;
  veganOnly: boolean; // fully vegan class (level 2 exactly)
  veganFriendly: boolean; // vegan-friendly class (level 1 exactly — has options, not all-vegan)
  tea: boolean;
}

export function filterVenues(venues: Venue[], f: VenueFilter): Venue[] {
  return venues.filter((v) => {
    if (!f.categories.has(v.cat)) return false;
    // Vegan/tea are additive spotlights: if any is on, the venue must match one.
    // Fully-vegan and vegan-friendly are DISJOINT classes.
    if (f.veganOnly || f.veganFriendly || f.tea) {
      const veganHit = (f.veganOnly && v.vegan === 2) || (f.veganFriendly && v.vegan === 1);
      const teaHit = f.tea && v.tea;
      return veganHit || teaHit;
    }
    return true;
  });
}
