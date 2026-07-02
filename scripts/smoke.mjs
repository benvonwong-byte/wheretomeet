// Sanity-check engine against real subway data with known NYC trip times.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Compile TS lib to a temp ESM bundle via vite-node style: simplest is tsx-less eval through vitest,
// but easiest here: use esbuild via npx to bundle a tiny entry.
const entry = `
import { buildGraph, stationTimes } from '../src/lib/transit';
import { haversineKm } from '../src/lib/geo';
import { walkMin } from '../src/lib/modes';
import subway from '../src/data/subway.json';

const g = buildGraph(subway);
const edges = g.adj.reduce((s, a) => s + a.length, 0);
console.log('graph:', g.stations.length, 'stations,', edges, 'directed edges');

function timeTo(origin, dest) {
  const st = stationTimes(g, origin);
  let best = walkMin(origin, dest);
  for (let i = 0; i < g.stations.length; i++) {
    if (!isFinite(st[i])) continue;
    if (haversineKm(g.stations[i], dest) > 1.6) continue;
    const t = st[i] + walkMin(g.stations[i], dest);
    if (t < best) best = t;
  }
  return best;
}

const unionSq = { lat: 40.7359, lng: -73.9906 };
const timesSq = { lat: 40.758, lng: -73.9855 };
const williamsburg = { lat: 40.7081, lng: -73.9571 };
const astoria = { lat: 40.7643, lng: -73.9235 };
const parkSlope = { lat: 40.6710, lng: -73.9814 };
const jacksonHts = { lat: 40.7475, lng: -73.8912 };

console.log('UnionSq -> TimesSq:', timeTo(unionSq, timesSq).toFixed(0), 'min (real ~12-15)');
console.log('UnionSq -> Williamsburg:', timeTo(unionSq, williamsburg).toFixed(0), 'min (real ~20-25)');
console.log('TimesSq -> Astoria:', timeTo(timesSq, astoria).toFixed(0), 'min (real ~25-30)');
console.log('ParkSlope -> JacksonHts:', timeTo(parkSlope, jacksonHts).toFixed(0), 'min (real ~55-70)');
`;
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('.smoke', { recursive: true });
writeFileSync('.smoke/entry.ts', entry);
execSync('npx esbuild .smoke/entry.ts --bundle --format=esm --platform=node --outfile=.smoke/out.mjs --loader:.json=json', { stdio: 'inherit' });
const out = execSync('node .smoke/out.mjs').toString();
console.log(out);
