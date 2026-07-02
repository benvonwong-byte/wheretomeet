// Enrich venues that carry OSM wikidata tags with free descriptions + Commons photos.
// Mostly hits museums/attractions/landmarks. Idempotent — merges into venues.json.
import { readFileSync, writeFileSync } from 'node:fs';

const UA = 'wheretomeet-demo/0.1 (contact: hi@vonwong.com)';
const FILE = 'src/data/venues.json';

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const withWd = data.venues.filter((v) => v.wd && /^Q\d+$/.test(v.wd));
console.log(`${withWd.length} venues have wikidata ids`);

const CHUNK = 150;
const found = new Map();

for (let i = 0; i < withWd.length; i += CHUNK) {
  const ids = withWd.slice(i, i + CHUNK).map((v) => `wd:${v.wd}`).join(' ');
  const sparql = `
SELECT ?item ?itemDescription ?image WHERE {
  VALUES ?item { ${ids} }
  OPTIONAL { ?item wdt:P18 ?image. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
  const res = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql), {
    headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
  });
  if (!res.ok) {
    console.error(`chunk ${i / CHUNK}: HTTP ${res.status}, skipping`);
    continue;
  }
  const json = await res.json();
  for (const b of json.results.bindings) {
    const qid = b.item.value.split('/').pop();
    const prev = found.get(qid) ?? {};
    const desc = b.itemDescription?.value;
    if (desc && !prev.desc) prev.desc = desc;
    if (b.image?.value && !prev.img) {
      // Commons FilePath with width → stable thumbnail URL, no key needed.
      const file = decodeURIComponent(b.image.value.split('/Special:FilePath/')[1] ?? b.image.value.split('/').pop());
      prev.img = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=480`;
    }
    found.set(qid, prev);
  }
  console.log(`chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(withWd.length / CHUNK)}: ${found.size} enriched so far`);
  await new Promise((r) => setTimeout(r, 1500));
}

let descs = 0;
let imgs = 0;
for (const v of data.venues) {
  const e = v.wd && found.get(v.wd);
  if (!e) continue;
  if (e.desc && !v.desc) {
    v.desc = e.desc[0].toUpperCase() + e.desc.slice(1);
    descs++;
  }
  if (e.img && !v.img) {
    v.img = e.img;
    imgs++;
  }
}
writeFileSync(FILE, JSON.stringify(data));
console.log(`Merged: ${descs} descriptions, ${imgs} images`);
