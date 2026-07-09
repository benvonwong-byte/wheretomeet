// Merge diet:gluten_free tags from Overpass into src/data/venues.json by OSM id.
// In-place merge — never re-fetches venues, so Google enrichment (ratings,
// prices, photos) survives untouched.
import { readFileSync, writeFileSync } from 'node:fs';
import { overpass, NYC_BBOX } from './overpass.mjs';

const q = `[out:json][timeout:300];nwr["diet:gluten_free"~"yes|only"]["name"](${NYC_BBOX});out ids tags;`;
const json = await overpass(q);
const gfById = new Map();
for (const el of json.elements ?? []) {
  gfById.set(`${el.type[0]}${el.id}`, el.tags?.['diet:gluten_free'] === 'only' ? 2 : 1);
}

const FILE = 'src/data/venues.json';
const data = JSON.parse(readFileSync(FILE, 'utf8'));
let matched = 0;
for (const v of data.venues) {
  const lv = gfById.get(v.id);
  if (lv) {
    v.gf = lv;
    matched++;
  }
}
writeFileSync(FILE, JSON.stringify(data));
const gfVegan = data.venues.filter((v) => v.gf && v.vegan > 0).length;
console.log(`GF-tagged in OSM: ${gfById.size}; matched in venues.json: ${matched}; of those also vegan: ${gfVegan}`);
