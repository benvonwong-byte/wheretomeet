import { haversineKm, cellCenter } from './geo';
import { walkMin } from './modes';
import type { Pt, SubwayData, GridSpec, TimeField } from './types';

// NYC subway calibration (best guess, demo-grade).
const TRAIN_SPEED = 32; // km/h average incl. acceleration
const DWELL_MIN = 0.7; // per stop
const WAIT_MIN = 4; // half a typical headway
const TRANSFER_MIN = 4;
const TRANSFER_RADIUS_KM = 0.18;
const ACCESS_RADIUS_KM = 1.6; // max walk to enter the system
const EGRESS_RADIUS_KM = 1.6; // max walk from a station to destination

interface Edge {
  to: number;
  min: number;
}

export interface TransitGraph {
  stations: Pt[];
  adj: Edge[][];
}

export function buildGraph(data: SubwayData): TransitGraph {
  const stations: Pt[] = data.stations.map((s) => ({ lat: s.lat, lng: s.lng }));
  const adj: Edge[][] = stations.map(() => []);

  const addEdge = (a: number, b: number, min: number) => {
    adj[a].push({ to: b, min });
    adj[b].push({ to: a, min });
  };

  for (const route of data.routes) {
    for (let i = 0; i + 1 < route.stops.length; i++) {
      const a = route.stops[i];
      const b = route.stops[i + 1];
      const km = haversineKm(stations[a], stations[b]);
      if (km > 6) continue; // guard against broken relation ordering
      addEdge(a, b, (km / TRAIN_SPEED) * 60 + DWELL_MIN);
    }
  }

  // Transfers between nearby stop nodes (covers direction pairs + passageways).
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      if (Math.abs(stations[i].lat - stations[j].lat) > 0.0025) continue;
      if (Math.abs(stations[i].lng - stations[j].lng) > 0.0033) continue;
      if (haversineKm(stations[i], stations[j]) <= TRANSFER_RADIUS_KM) {
        addEdge(i, j, TRANSFER_MIN);
      }
    }
  }
  return graphDedup({ stations, adj });
}

function graphDedup(g: TransitGraph): TransitGraph {
  // Keep the cheapest parallel edge per (a,b).
  const adj = g.adj.map((edges) => {
    const best = new Map<number, number>();
    for (const e of edges) {
      const cur = best.get(e.to);
      if (cur === undefined || e.min < cur) best.set(e.to, e.min);
    }
    return [...best.entries()].map(([to, min]) => ({ to, min }));
  });
  return { stations: g.stations, adj };
}

/** Dijkstra from an origin point: minutes to reach every station (walk-in + wait included). */
export function stationTimes(graph: TransitGraph, origin: Pt): Float32Array {
  const n = graph.stations.length;
  const dist = new Float32Array(n).fill(Infinity);
  const heap = new MinHeap();

  for (let i = 0; i < n; i++) {
    const km = haversineKm(origin, graph.stations[i]);
    if (km <= ACCESS_RADIUS_KM) {
      const t = walkMin(origin, graph.stations[i]) + WAIT_MIN;
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
  return dist;
}

/**
 * Transit travel-time field over the grid: for each cell,
 * min(direct walk, best station time + walk egress).
 */
export function transitField(graph: TransitGraph, origin: Pt, grid: GridSpec): TimeField {
  const st = stationTimes(graph, origin);
  const field = new Float32Array(grid.rows * grid.cols).fill(Infinity);

  // Spatial hash of stations for egress lookups.
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
