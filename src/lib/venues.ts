import { venueEmoji } from './emoji';
import type { Venue } from './types';

export interface VenueFilter {
  categories: Set<Venue['cat']>;
  veganOnly: boolean; // fully vegan class (level 2 exactly)
  veganFriendly: boolean; // vegan-friendly class (level 1 exactly — has options, not all-vegan)
  teaHouse: boolean; // proper tea (tea === 1)
  bubbleTea: boolean; // boba (tea === 2) — not the same thing
  emoji?: Set<string>; // venue-type glyphs from the map legend; empty/absent = all
}

export function filterVenues(venues: Venue[], f: VenueFilter): Venue[] {
  return venues.filter((v) => {
    if (!f.categories.has(v.cat)) return false;
    if (f.emoji?.size && !f.emoji.has(venueEmoji(v))) return false;
    // Spotlight filters are additive: if any is on, the venue must match one.
    // Fully-vegan/vegan-friendly and tea-house/bubble-tea are DISJOINT classes.
    if (f.veganOnly || f.veganFriendly || f.teaHouse || f.bubbleTea) {
      const veganHit = (f.veganOnly && v.vegan === 2) || (f.veganFriendly && v.vegan === 1);
      const teaHit = (f.teaHouse && v.tea === 1) || (f.bubbleTea && v.tea === 2);
      return veganHit || teaHit;
    }
    return true;
  });
}
