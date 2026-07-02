// One-time bake of the NYC subway network from OSM route relations into src/data/subway.json.
// Output: stations (deduped stop nodes) + routes as ordered station-index lists.
import { writeFileSync, mkdirSync } from 'node:fs';
import { overpass, NYC_BBOX } from './overpass.mjs';

const q = `[out:json][timeout:300];
rel["route"="subway"](${NYC_BBOX});
out body;
node(r)(${NYC_BBOX});
out body;`;

console.log('Fetching subway route relations + stop nodes...');
const json = await overpass(q);

const nodes = new Map();
const rels = [];
for (const el of json.elements ?? []) {
  if (el.type === 'node') nodes.set(el.id, el);
  else if (el.type === 'relation') rels.push(el);
}
console.log(`${rels.length} route relations, ${nodes.size} member nodes`);

// Collect ordered stop sequences per relation.
const stations = [];
const stationIdxByNode = new Map();
function stationIdx(node) {
  if (stationIdxByNode.has(node.id)) return stationIdxByNode.get(node.id);
  const idx = stations.length;
  stations.push({
    name: node.tags?.name ?? 'Station',
    lat: +node.lat.toFixed(6),
    lng: +node.lon.toFixed(6),
  });
  stationIdxByNode.set(node.id, idx);
  return idx;
}

const routes = [];
for (const rel of rels) {
  const ref = rel.tags?.ref ?? rel.tags?.name ?? '?';
  const stops = [];
  for (const m of rel.members ?? []) {
    if (m.type !== 'node') continue;
    if (!/stop/.test(m.role ?? '')) continue; // roles: stop, stop_entry_only, stop_exit_only
    const node = nodes.get(m.ref);
    if (!node) continue;
    const idx = stationIdx(node);
    if (stops[stops.length - 1] !== idx) stops.push(idx);
  }
  if (stops.length >= 2) routes.push({ ref, stops });
}

mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/subway.json', JSON.stringify({
  attribution: 'Data © OpenStreetMap contributors, ODbL',
  fetched: new Date().toISOString().slice(0, 10),
  stations,
  routes,
}));
console.log(`Done: ${stations.length} stations, ${routes.length} routes`);
console.log('Sample routes:', routes.slice(0, 5).map((r) => `${r.ref} (${r.stops.length} stops)`).join(', '));
