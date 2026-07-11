// Google Places (New) enrichment: stars, rating counts, price level, open/closed,
// photos, and (with --desc) editorial descriptions.
//
// Setup: put GOOGLE_PLACES_API_KEY=... in .env.local, then:
//   node scripts/enrich-google.mjs           # vegan + tea subset (~850 calls, inside free Pro tier)
//   node scripts/enrich-google.mjs --all     # every venue (12k+ calls — will cost money)
//   node scripts/enrich-google.mjs --desc    # also fetch descriptions (Enterprise SKU, 1k/mo free)
//
// Permanently-closed venues are removed from venues.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const KEY = process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;
if (!KEY) {
  console.error('No GOOGLE_PLACES_API_KEY in .env.local — get one at https://console.cloud.google.com (enable "Places API (New)").');
  process.exit(1);
}

const ALL = process.argv.includes('--all');
const WANT_DESC = process.argv.includes('--desc');
const FILE = process.argv.find((a) => a.startsWith('--file='))?.slice('--file='.length) || 'src/data/venues.json';
const data = JSON.parse(readFileSync(FILE, 'utf8'));

const subset = data.venues.filter((v) => (ALL ? true : v.vegan > 0 || v.tea));
console.log(`Enriching ${subset.length} venues via Google Places…`);

const baseFields = ['places.id', 'places.businessStatus', 'places.rating', 'places.userRatingCount', 'places.priceLevel', 'places.photos'];
if (WANT_DESC) baseFields.push('places.editorialSummary');

const PRICE = { PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };

async function lookup(v) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': baseFields.join(','),
    },
    body: JSON.stringify({
      textQuery: `${v.name} ${v.addr || ''} New York`,
      locationBias: { circle: { center: { latitude: v.lat, longitude: v.lng }, radius: 250 } },
      maxResultCount: 1,
    }),
  });
  if (!res.ok) throw new Error(`searchText HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.places?.[0] ?? null;
}

async function photoUrl(photoName) {
  const res = await fetch(
    `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=480&skipHttpRedirect=true&key=${KEY}`,
  );
  if (!res.ok) return null;
  return (await res.json()).photoUri ?? null;
}

let enriched = 0;
let closed = 0;
let failed = 0;
const closedIds = new Set();

for (let i = 0; i < subset.length; i++) {
  const v = subset[i];
  try {
    const p = await lookup(v);
    if (!p) continue;
    if (p.businessStatus === 'CLOSED_PERMANENTLY' || p.businessStatus === 'CLOSED_TEMPORARILY') {
      closedIds.add(v.id);
      closed++;
      continue;
    }
    if (p.rating) {
      v.rating = p.rating;
      v.ratings = p.userRatingCount ?? 0;
    }
    if (p.priceLevel && PRICE[p.priceLevel]) v.price = PRICE[p.priceLevel];
    if (p.editorialSummary?.text && !v.desc) v.desc = p.editorialSummary.text;
    if (p.photos?.[0]?.name && !v.img) {
      const url = await photoUrl(p.photos[0].name);
      if (url) v.img = url;
    }
    enriched++;
  } catch (err) {
    failed++;
    if (failed <= 3) console.error(`  ${v.name}: ${err.message}`);
    if (failed > 25) {
      console.error('Too many failures — aborting to protect quota.');
      break;
    }
  }
  if (i % 50 === 49) console.log(`  ${i + 1}/${subset.length} (${enriched} enriched, ${closed} closed)`);
  await new Promise((r) => setTimeout(r, 120)); // stay under QPS limits
}

data.venues = data.venues.filter((v) => !closedIds.has(v.id));
writeFileSync(FILE, JSON.stringify(data));
console.log(`Done: ${enriched} enriched, ${closed} permanently/temporarily closed removed, ${failed} failed.`);
