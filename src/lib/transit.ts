import { haversineKm, cellCenter } from './geo';
import { walkMin } from './modes';
import type { Pt, SubwayData, GridSpec, TimeField, Daypart } from './types';

// Station access parameters (walking legs remain estimates; ride times and
// waits come from the real MTA GTFS schedule).
const ACCESS_RADIUS_KM = 1.6;
const EGRESS_RADIUS_KM = 1.6;
const BOARD_OVERHEAD_MIN = 0.75; // fare gates, stairs to platform
const ALIGHT_MIN = 1.0; // platform to street
const MAX_WAIT_MIN = 15; // schedule-aware cap: nobody waits out a full 30-min headway blind
const NEARBY_TRANSFER_KM = 0.16; // walk transfer between stations lacking a transfers.txt rule
const NEARBY_TRANSFER_MIN = 4;

interface Edge {
  to: number;
  min: number;
}

/**
 * Time-expanded graph: nodes 0..S-1 are "street" nodes (one per station);
 * each (route, station) pair gets a "platform" node. Boarding edges charge
 * the daypart's headway/2 wait, so waits are per-boarding — including at
 * transfers — exactly like a real trip.
 */
export interface TransitGraph {
  stations: Pt[];
  /** Total node count (streets + platforms). */
  n: number;
  adj: Edge[][];
}

export function buildGraph(data: SubwayData, daypart: Daypart = 'midday'): TransitGraph {
  const S = data.stations.length;
  const stations: Pt[] = data.stations.map((s) => ({ lat: s.lat, lng: s.lng }));

  // Assign platform node ids per (route, station).
  let n = S;
  const platformId = new Map<string, number>();
  const platform = (routeIdx: number, station: number) => {
    const key = `${routeIdx}:${station}`;
    let id = platformId.get(key);
    if (id === undefined) {
      id = n++;
      platformId.set(key, id);
    }
    return id;
  };
  for (let r = 0; r < data.routes.length; r++) {
    for (const [a, b] of data.routes[r].segs) {
      platform(r, a);
      platform(r, b);
    }
  }

  const adj: Edge[][] = Array.from({ length: n }, () => []);

  for (let r = 0; r < data.routes.length; r++) {
    const route = data.routes[r];
    const waitMin = Math.min(route.headway[daypart] / 2 / 60, MAX_WAIT_MIN);
    const touched = new Set<number>();
    for (const [a, b, sec] of route.segs) {
      // ride edge (directed, real scheduled run time)
      adj[platform(r, a)].push({ to: platform(r, b), min: sec / 60 });
      touched.add(a);
      touched.add(b);
    }
    for (const st of touched) {
      const p = platform(r, st);
      adj[st].push({ to: p, min: waitMin + BOARD_OVERHEAD_MIN }); // board
      adj[p].push({ to: st, min: ALIGHT_MIN }); // alight
    }
  }

  // GTFS transfer rules (street to street, both directions).
  for (const [a, b, sec] of data.transfers) {
    const min = sec / 60;
    adj[a].push({ to: b, min });
    adj[b].push({ to: a, min });
  }

  // Fallback walk transfers between physically-adjacent stations.
  const ruled = new Set(data.transfers.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  for (let i = 0; i < S; i++) {
    for (let j = i + 1; j < S; j++) {
      if (Math.abs(stations[i].lat - stations[j].lat) > 0.002) continue;
      if (Math.abs(stations[i].lng - stations[j].lng) > 0.0027) continue;
      if (ruled.has(`${i}|${j}`)) continue;
      if (haversineKm(stations[i], stations[j]) <= NEARBY_TRANSFER_KM) {
        adj[i].push({ to: j, min: NEARBY_TRANSFER_MIN });
        adj[j].push({ to: i, min: NEARBY_TRANSFER_MIN });
      }
    }
  }

  return { stations, n, adj };
}

/** Dijkstra from an origin point: minutes to each STREET node (walk-in included). */
export function stationTimes(graph: TransitGraph, origin: Pt): Float32Array {
  const dist = new Float32Array(graph.n).fill(Infinity);
  const heap = new MinHeap();

  for (let i = 0; i < graph.stations.length; i++) {
    const km = haversineKm(origin, graph.stations[i]);
    if (km <= ACCESS_RADIUS_KM) {
      const t = walkMin(origin, graph.stations[i]);
      if (t < dist[i]) {
        dist[i] = t;
        heap.push(i, dist[i]); // push the float32-rounded value to keep staleness check exact
      }
    }
  }

  while (heap.size > 0) {
    const [u, d] = heap.pop();
    if (d > dist[u]) continue;
    for (const e of graph.adj[u]) {
      const nd = d + e.min;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        heap.push(e.to, dist[e.to]);
      }
    }
  }
  return dist.slice(0, graph.stations.length);
}

/**
 * Transit travel-time field over the grid: for each cell,
 * min(direct walk, best station time + walk egress).
 */
export function transitField(graph: TransitGraph, origin: Pt, grid: GridSpec): TimeField {
  const st = stationTimes(graph, origin);
  const field = new Float32Array(grid.rows * grid.cols).fill(Infinity);

  const CELL_DEG = 0.02;
  const bins = new Map<string, number[]>();
  const key = (lat: number, lng: number) => `${Math.floor(lat / CELL_DEG)},${Math.floor(lng / CELL_DEG)}`;
  graph.stations.forEach((s, i) => {
    const k = key(s.lat, s.lng);
    let arr = bins.get(k);
    if (!arr) bins.set(k, (arr = []));
    arr.push(i);
  });

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const p = cellCenter(grid, r, c);
      let best = walkMin(origin, p);
      const kr = Math.floor(p.lat / CELL_DEG);
      const kc = Math.floor(p.lng / CELL_DEG);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const arr = bins.get(`${kr + dr},${kc + dc}`);
          if (!arr) continue;
          for (const i of arr) {
            if (st[i] === Infinity) continue;
            const km = haversineKm(graph.stations[i], p);
            if (km > EGRESS_RADIUS_KM) continue;
            const t = st[i] + walkMin(graph.stations[i], p);
            if (t < best) best = t;
          }
        }
      }
      field[r * grid.cols + c] = best;
    }
  }
  return field;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.vals[p] <= this.vals[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.keys[0], this.vals[0]];
    const lastK = this.keys.pop()!;
    const lastV = this.vals.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastK;
      this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.vals.length && this.vals[l] < this.vals[m]) m = l;
        if (r < this.vals.length && this.vals[r] < this.vals[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(i: number, j: number): void {
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
    [this.vals[i], this.vals[j]] = [this.vals[j], this.vals[i]];
  }
}
