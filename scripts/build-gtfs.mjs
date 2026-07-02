// Bake the OFFICIAL MTA subway GTFS into src/data/subway.json:
// real segment run times (median of scheduled trips), real transfer rules,
// and per-daypart headways for time-of-day-aware waits.
//
// Usage: node scripts/build-gtfs.mjs [path/to/gtfs-dir]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2] ?? 'gtfs';

// Minimal CSV parser (handles quoted fields with commas).
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
        field = '';
        row = [];
      }
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

const load = (f) => parseCsv(readFileSync(join(DIR, f), 'utf8'));
const hms = (s) => {
  const [h, m, sec] = s.split(':').map(Number);
  return h * 3600 + m * 60 + (sec || 0);
};

// ── Stops → parent stations ─────────────────────────────────
const stops = load('stops.txt');
const parentOf = new Map(); // any stop_id → parent index
const stations = [];
const parentIdx = new Map(); // parent stop_id → index
for (const s of stops) {
  if (s.location_type === '1' || !s.parent_station) {
    if (!parentIdx.has(s.stop_id)) {
      parentIdx.set(s.stop_id, stations.length);
      stations.push({ name: s.stop_name, lat: +(+s.stop_lat).toFixed(6), lng: +(+s.stop_lon).toFixed(6) });
    }
  }
}
for (const s of stops) {
  const pid = s.parent_station || s.stop_id;
  if (parentIdx.has(pid)) parentOf.set(s.stop_id, parentIdx.get(pid));
}
console.log(`${stations.length} parent stations`);

// ── Service: typical Wednesday ──────────────────────────────
const calendar = load('calendar.txt');
const activeServices = new Set(calendar.filter((c) => c.wednesday === '1').map((c) => c.service_id));

const trips = load('trips.txt');
const tripRoute = new Map();
for (const t of trips) {
  if (activeServices.has(t.service_id)) tripRoute.set(t.trip_id, t.route_id);
}
console.log(`${tripRoute.size} Wednesday trips across ${new Set(tripRoute.values()).size} routes`);

// ── stop_times → segments + headway samples ────────────────
console.log('Parsing stop_times.txt…');
const stopTimes = load('stop_times.txt');
// group by trip
const byTrip = new Map();
for (const st of stopTimes) {
  if (!tripRoute.has(st.trip_id)) continue;
  let arr = byTrip.get(st.trip_id);
  if (!arr) byTrip.set(st.trip_id, (arr = []));
  arr.push(st);
}

const segSamples = new Map(); // `${route}|${a}|${b}` → seconds[]
const routeDeparts = new Map(); // route → first-stop departure seconds[]

for (const [tripId, sts] of byTrip) {
  const route = tripRoute.get(tripId);
  sts.sort((x, y) => +x.stop_sequence - +y.stop_sequence);
  const first = sts[0];
  if (first?.departure_time) {
    let arr = routeDeparts.get(route);
    if (!arr) routeDeparts.set(route, (arr = []));
    arr.push(hms(first.departure_time) % 86400);
  }
  for (let i = 0; i + 1 < sts.length; i++) {
    const a = parentOf.get(sts[i].stop_id);
    const b = parentOf.get(sts[i + 1].stop_id);
    if (a == null || b == null || a === b) continue;
    const dt = hms(sts[i + 1].arrival_time) - hms(sts[i].departure_time);
    if (dt <= 0 || dt > 1800) continue;
    const key = `${route}|${a}|${b}`;
    let arr = segSamples.get(key);
    if (!arr) segSamples.set(key, (arr = []));
    arr.push(dt);
  }
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

// ── Headways per daypart ────────────────────────────────────
// rush 7-10 & 17-20, midday 10-17, evening 20-24, night 0-7
const WINDOWS = {
  rush: [[7, 10], [17, 20]],
  midday: [[10, 17]],
  evening: [[20, 24]],
  night: [[0, 7]],
};

function headways(departs) {
  const out = {};
  for (const [part, wins] of Object.entries(WINDOWS)) {
    const hours = wins.reduce((s, [a, b]) => s + (b - a), 0);
    const n = departs.filter((d) => wins.some(([a, b]) => d >= a * 3600 && d < b * 3600)).length;
    // two directions share a route_id → divide by 2 for per-direction frequency
    const perDir = Math.max(n / 2, 0.5);
    out[part] = Math.round(Math.min(Math.max((hours * 3600) / perDir, 120), 1800));
  }
  return out;
}

// ── Assemble routes ─────────────────────────────────────────
const routesOut = [];
const routeIds = [...new Set(tripRoute.values())].sort();
for (const r of routeIds) {
  const segs = [];
  for (const [key, samples] of segSamples) {
    const [route, a, b] = key.split('|');
    if (route !== r) continue;
    segs.push([+a, +b, median(samples)]);
  }
  if (!segs.length) continue;
  routesOut.push({ ref: r, segs, headway: headways(routeDeparts.get(r) ?? []) });
}

// ── Transfers ───────────────────────────────────────────────
const transfersRaw = load('transfers.txt');
const transfers = [];
const seen = new Set();
for (const t of transfersRaw) {
  const a = parentOf.get(t.from_stop_id);
  const b = parentOf.get(t.to_stop_id);
  if (a == null || b == null || a === b) continue;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  if (seen.has(key)) continue;
  seen.add(key);
  transfers.push([a, b, Math.max(+t.min_transfer_time || 180, 120)]);
}

writeFileSync('src/data/subway.json', JSON.stringify({
  attribution: 'MTA GTFS static feed; © Metropolitan Transportation Authority',
  fetched: new Date().toISOString().slice(0, 10),
  stations,
  routes: routesOut,
  transfers,
}));

const totalSegs = routesOut.reduce((s, r) => s + r.segs.length, 0);
console.log(`Done: ${stations.length} stations, ${routesOut.length} routes, ${totalSegs} segments, ${transfers.length} transfers`);
for (const r of routesOut.slice(0, 6)) {
  console.log(`  ${r.ref}: ${r.segs.length} segs, headway rush ${Math.round(r.headway.rush / 60)}m / midday ${Math.round(r.headway.midday / 60)}m / night ${Math.round(r.headway.night / 60)}m`);
}
