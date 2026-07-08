// One-time bake of NYC venues from OSM Overpass into src/data/venues.json.
// Categories: vegan-flagged anything, tea houses, cafes, restaurants, activities.
import { writeFileSync, mkdirSync } from 'node:fs';
import { overpass, NYC_BBOX } from './overpass.mjs';

const B = NYC_BBOX;

const QUERIES = {
  vegan: `[out:json][timeout:180];nwr["diet:vegan"~"yes|only"]["name"](${B});out center tags;`,
  tea: `[out:json][timeout:180];(nwr["shop"="tea"]["name"](${B});nwr["cuisine"~"tea"]["name"](${B});)->.a;.a out center tags;`,
  cafe: `[out:json][timeout:300];nwr["amenity"="cafe"]["name"](${B});out center tags;`,
  restaurant: `[out:json][timeout:600];nwr["amenity"="restaurant"]["name"](${B});out center tags;`,
  activity: `[out:json][timeout:300];(
    nwr["tourism"~"^(museum|gallery|attraction|zoo|aquarium)$"]["name"](${B});
    nwr["amenity"~"^(cinema|theatre|arts_centre)$"]["name"](${B});
    nwr["leisure"~"^(bowling_alley|escape_game|amusement_arcade|climbing|ice_rink|miniature_golf|dance)$"]["name"](${B});
  );out center tags;`,
};

function veganLevel(tags) {
  if (tags['diet:vegan'] === 'only') return 2;
  if (tags['diet:vegan'] === 'yes') return 1;
  return 0;
}

// 0 = not tea, 1 = proper tea house, 2 = bubble tea. Not the same thing.
// Known bubble chains often carry a bare cuisine=tea tag in OSM — force them.
const BOBA_CHAINS =
  /\b(hey\s*tea|heytea|teazzi|gong\s*cha|kung\s*fu\s*tea|yi\s*fang|yifang|machi\s*machi|xing\s*fu\s*tang|tiger\s*sugar|sharetea|chatime|mixue|happy\s*lemon|moge\s*tee|truedan|vivi|tbaar|debutea|joyba|coco\s+(fresh|tea))\b/i;

function teaKind(tags, name) {
  const cuisine = tags.cuisine ?? '';
  const n = name ?? '';
  if (/(^|;)\s*bubble_tea\s*(;|$)/.test(cuisine) || /bubble\s*tea|boba/i.test(n) || BOBA_CHAINS.test(n)) return 2;
  if (tags.shop === 'tea' || /(^|;)\s*tea\s*(;|$)/.test(cuisine) || /tea\s*house|teahouse/i.test(n)) return 1;
  return 0;
}

function isTea(tags) {
  return teaKind(tags, tags.name) > 0;
}

function baseCategory(key, tags) {
  if (key === 'activity') return 'activity';
  if (tags.amenity === 'restaurant') return 'restaurant';
  if (tags.amenity === 'cafe' || tags.shop === 'tea' || isTea(tags)) return 'cafe';
  if (tags.amenity === 'bar' || tags.amenity === 'pub' || tags.amenity === 'fast_food') return 'restaurant';
  return key === 'vegan' ? 'restaurant' : 'cafe';
}

function isClosed(t) {
  // OSM lifecycle markers for defunct places.
  if (t.disused === 'yes' || t.abandoned === 'yes') return true;
  if (t['disused:amenity'] || t['abandoned:amenity'] || t['was:amenity']) return true;
  if (t.opening_hours === 'closed' || t.opening_hours === 'off') return true;
  if (t.closed || t['end_date']) return true;
  return false;
}

function slim(el, key) {
  const t = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;
  if (isClosed(t)) return null;
  const addr = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const v = {
    id: `${el.type[0]}${el.id}`,
    name: t.name,
    lat: +lat.toFixed(6),
    lng: +lng.toFixed(6),
    cat: baseCategory(key, t),
    vegan: veganLevel(t),
    tea: teaKind(t, t.name),
    cuisine: t.cuisine ?? '',
    addr,
  };
  // Optional enrichment fields — only set when present to keep JSON small.
  const web = t.website ?? t['contact:website'];
  if (web) v.web = web;
  const tel = t.phone ?? t['contact:phone'];
  if (tel) v.tel = tel;
  if (t.opening_hours) v.hours = t.opening_hours;
  if (t.description) v.desc = t.description;
  if (t.wikidata) v.wd = t.wikidata;
  return v;
}

const byId = new Map();
for (const [key, q] of Object.entries(QUERIES)) {
  console.log(`Fetching ${key}...`);
  const json = await overpass(q);
  let added = 0;
  for (const el of json.elements ?? []) {
    const v = slim(el, key);
    if (!v) continue;
    const prev = byId.get(v.id);
    if (prev) {
      // Merge: keep strongest flags, prefer 'activity' category from the activity query.
      prev.vegan = Math.max(prev.vegan, v.vegan);
      prev.tea = Math.max(prev.tea, v.tea);
      if (key === 'activity') prev.cat = 'activity';
    } else {
      byId.set(v.id, v);
      added++;
    }
  }
  console.log(`  ${json.elements?.length ?? 0} elements, ${added} new (total ${byId.size})`);
  await new Promise((r) => setTimeout(r, 3000));
}

const venues = [...byId.values()];
mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/venues.json', JSON.stringify({
  attribution: 'Data © OpenStreetMap contributors, ODbL',
  fetched: new Date().toISOString().slice(0, 10),
  venues,
}));
const stats = {
  total: venues.length,
  veganOnly: venues.filter((v) => v.vegan === 2).length,
  veganFriendly: venues.filter((v) => v.vegan === 1).length,
  tea: venues.filter((v) => v.tea).length,
  byCat: Object.fromEntries(['restaurant', 'cafe', 'activity'].map((c) => [c, venues.filter((v) => v.cat === c).length])),
};
console.log('Done:', JSON.stringify(stats, null, 2));
