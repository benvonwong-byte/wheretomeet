import type { Venue } from './types';

// Cuisine/type glyph for a venue. Priority: tea classes > fully-vegan >
// activity kind (from name) > cuisine token > category default.
const CUISINE_EMOJI: [RegExp, string][] = [
  [/pizza/, '🍕'],
  [/sushi|japanese/, '🍣'],
  [/ramen|noodle|pho\b/, '🍜'],
  [/chinese|dim_sum|cantonese|szechuan|sichuan/, '🥡'],
  [/korean/, '🍲'],
  [/thai/, '🍛'],
  [/indian|curry/, '🍛'],
  [/mexican|taco|burrito/, '🌮'],
  [/italian|pasta/, '🍝'],
  [/burger/, '🍔'],
  [/sandwich|deli/, '🥪'],
  [/bagel|breakfast|brunch/, '🥯'],
  [/bakery|pastry|cake|donut|doughnut/, '🥐'],
  [/ice_cream|frozen_yogurt|dessert/, '🍦'],
  [/juice|smoothie/, '🥤'],
  [/seafood|fish/, '🦞'],
  [/steak|bbq|barbecue|grill/, '🥩'],
  [/vietnamese/, '🍜'],
  [/mediterranean|greek|falafel|middle_eastern|lebanese|israeli/, '🧆'],
  [/spanish|tapas/, '🥘'],
  [/french/, '🥖'],
  [/ethiopian|african/, '🍲'],
  [/caribbean|jamaican/, '🍗'],
  [/wine|bar\b|pub/, '🍸'],
  [/coffee|espresso/, '☕'],
];

const ACTIVITY_EMOJI: [RegExp, string][] = [
  [/museum/i, '🏛️'],
  [/galler/i, '🖼️'],
  [/theat(re|er)|playhouse|stage/i, '🎭'],
  [/cinema|movie|film/i, '🎬'],
  [/bowl/i, '🎳'],
  [/climb/i, '🧗'],
  [/escape/i, '🗝️'],
  [/arcade|game/i, '🕹️'],
  [/skat|rink/i, '⛸️'],
  [/golf/i, '⛳'],
  [/zoo/i, '🦁'],
  [/aquarium/i, '🐠'],
  [/garden|botanic/i, '🌷'],
  [/librar/i, '📚'],
  [/dance/i, '💃'],
];

export function venueEmoji(v: Venue): string {
  if (v.tea === 1) return '🍵';
  if (v.tea === 2) return '🧋';
  if (v.vegan === 2) return '🌱';
  if (v.cat === 'activity') {
    for (const [re, e] of ACTIVITY_EMOJI) if (re.test(v.name)) return e;
    return '🎟️';
  }
  const cuisine = (v.cuisine || '').toLowerCase();
  for (const [re, e] of CUISINE_EMOJI) if (re.test(cuisine)) return e;
  if (v.cat === 'cafe') return '☕';
  return '🍽️';
}
