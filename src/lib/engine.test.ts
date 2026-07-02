import { describe, it, expect } from 'vitest';
import { haversineKm, NYC_GRID, cellCenter, pointToCell, cellIndex } from './geo';
import { directTimeMin, walkMin } from './modes';
import { buildGraph, stationTimes, transitField } from './transit';
import { fairnessScore, comboLayer, averageLayers, timeField, scoreAtPoint } from './fairness';
import { filterVenues } from './venues';
import type { SubwayData, Venue } from './types';

describe('geo', () => {
  it('haversine: Times Sq to Union Sq ~ 2.5 km straight-line', () => {
    const timesSq = { lat: 40.758, lng: -73.9855 };
    const unionSq = { lat: 40.7359, lng: -73.9906 };
    const km = haversineKm(timesSq, unionSq);
    expect(km).toBeGreaterThan(2.2);
    expect(km).toBeLessThan(2.8);
  });

  it('grid roundtrip: cell center maps back to same cell', () => {
    const p = cellCenter(NYC_GRID, 70, 60);
    expect(pointToCell(NYC_GRID, p)).toBe(cellIndex(NYC_GRID, 70, 60));
  });

  it('point outside grid returns -1', () => {
    expect(pointToCell(NYC_GRID, { lat: 41.5, lng: -73.9 })).toBe(-1);
  });
});

describe('modes', () => {
  const a = { lat: 40.758, lng: -73.9855 };
  const b = { lat: 40.7359, lng: -73.9906 };

  it('bike faster than walk, both include overheads', () => {
    expect(directTimeMin(a, b, 'bike')).toBeLessThan(walkMin(a, b));
  });

  it('car overhead makes short hops slow', () => {
    const near = { lat: 40.7585, lng: -73.984 };
    // ~150m: car should NOT beat walking (parking overhead dominates)
    expect(directTimeMin(a, near, 'car')).toBeGreaterThan(walkMin(a, near));
  });
});

// Tiny synthetic subway: 3 stations on a line, 4th transferable near station 1.
const line: SubwayData = {
  stations: [
    { name: 'S0', lat: 40.7, lng: -74.0 },
    { name: 'S1', lat: 40.72, lng: -74.0 },
    { name: 'S2', lat: 40.74, lng: -74.0 },
    { name: 'S1b', lat: 40.7201, lng: -74.0001 }, // ~11m from S1 → transfer
    { name: 'S3', lat: 40.7401, lng: -73.95 }, // on second line from S1b
  ],
  routes: [
    { ref: 'A', stops: [0, 1, 2] },
    { ref: 'B', stops: [3, 4] },
  ],
};

describe('transit graph', () => {
  const g = buildGraph(line);

  it('creates line edges and a transfer edge', () => {
    expect(g.adj[0].some((e) => e.to === 1)).toBe(true);
    expect(g.adj[1].some((e) => e.to === 2)).toBe(true);
    expect(g.adj[1].some((e) => e.to === 3)).toBe(true); // transfer S1<->S1b
  });

  it('dijkstra reaches transfer-connected line', () => {
    const origin = { lat: 40.7, lng: -74.0 }; // at S0
    const t = stationTimes(g, origin);
    expect(t[0]).toBeLessThan(10); // walk 0 + wait
    expect(t[2]).toBeGreaterThan(t[1]); // farther along line
    expect(isFinite(t[4])).toBe(true); // reached via transfer to line B
    expect(t[4]).toBeGreaterThan(t[3]);
  });

  it('dijkstra reaches every station of a long connected chain (float32 staleness regression)', () => {
    // 200-station chain with irregular spacing to force float32 rounding in dist[].
    const stations = Array.from({ length: 200 }, (_, i) => ({
      name: `C${i}`,
      lat: 40.6 + i * 0.0013 + (i % 7) * 0.00003,
      lng: -74.0 + (i % 3) * 0.0002,
    }));
    const chain: SubwayData = { stations, routes: [{ ref: 'X', stops: stations.map((_, i) => i) }] };
    const cg = buildGraph(chain);
    const t = stationTimes(cg, { lat: 40.6, lng: -74.0 });
    for (let i = 0; i < t.length; i++) expect(isFinite(t[i]), `station ${i} unreachable`).toBe(true);
  });

  it('transit field: near-origin cells are walkable, far cells served by train beat walking', () => {
    const grid = { latMin: 40.69, latMax: 40.76, lngMin: -74.02, lngMax: -73.93, rows: 20, cols: 20 };
    const origin = { lat: 40.7, lng: -74.0 };
    const field = transitField(g, origin, grid);
    const originIdx = pointToCell(grid, origin);
    expect(field[originIdx]).toBeLessThan(5);
    // Cell near S2 (4.4km away): train should beat the ~70min walk
    const nearS2 = pointToCell(grid, { lat: 40.74, lng: -74.0 });
    expect(field[nearS2]).toBeLessThan(walkMin(origin, { lat: 40.74, lng: -74.0 }));
  });
});

describe('fairness', () => {
  it('equal short times score higher than equal long times', () => {
    expect(fairnessScore(10, 10)).toBeGreaterThan(fairnessScore(40, 40));
  });

  it('gap dominates: 20/20 beats 5/35 (same max... no, same total)', () => {
    expect(fairnessScore(20, 20)).toBeGreaterThan(fairnessScore(5, 35));
  });

  it('unreachable scores zero', () => {
    expect(fairnessScore(Infinity, 10)).toBe(0);
  });

  it('averageLayers averages and handles empty', () => {
    const a = comboLayer('bike', 'car', new Float32Array([10, 20]), new Float32Array([10, 40]));
    const b = comboLayer('walk', 'walk', new Float32Array([10, 20]), new Float32Array([10, 20]));
    const avg = averageLayers([a, b], 2);
    expect(avg[0]).toBeCloseTo((a.scores[0] + b.scores[0]) / 2, 5);
    expect(averageLayers([], 2)[0]).toBe(0);
  });

  it('timeField for bike is monotone in distance from origin', () => {
    const grid = { latMin: 40.69, latMax: 40.76, lngMin: -74.02, lngMax: -73.93, rows: 10, cols: 10 };
    const origin = { lat: 40.7, lng: -74.0 };
    const g = buildGraph(line);
    const f = timeField(g, origin, 'bike', grid);
    const near = pointToCell(grid, { lat: 40.7, lng: -74.0 });
    const far = pointToCell(grid, { lat: 40.755, lng: -73.935 });
    expect(f[near]).toBeLessThan(f[far]);
  });

  it('scoreAtPoint returns per-combo times', () => {
    const grid = { latMin: 40.69, latMax: 40.76, lngMin: -74.02, lngMax: -73.93, rows: 10, cols: 10 };
    const cells = grid.rows * grid.cols;
    const layer = comboLayer('bike', 'transit', new Float32Array(cells).fill(15), new Float32Array(cells).fill(18));
    const s = scoreAtPoint(grid, [layer], { lat: 40.72, lng: -73.98 });
    expect(s).not.toBeNull();
    expect(s!.combos[0]).toMatchObject({ modeA: 'bike', modeB: 'transit', tA: 15, tB: 18 });
    expect(s!.score).toBeGreaterThan(0);
  });
});

describe('venue filter', () => {
  const venues: Venue[] = [
    { id: 'a', name: 'Vegan Only Place', lat: 0, lng: 0, cat: 'restaurant', vegan: 2, tea: false, cuisine: '', addr: '' },
    { id: 'b', name: 'Veg Friendly Cafe', lat: 0, lng: 0, cat: 'cafe', vegan: 1, tea: false, cuisine: '', addr: '' },
    { id: 'c', name: 'Tea House', lat: 0, lng: 0, cat: 'cafe', vegan: 0, tea: true, cuisine: 'tea', addr: '' },
    { id: 'd', name: 'Steakhouse', lat: 0, lng: 0, cat: 'restaurant', vegan: 0, tea: false, cuisine: 'steak', addr: '' },
    { id: 'e', name: 'Museum', lat: 0, lng: 0, cat: 'activity', vegan: 0, tea: false, cuisine: '', addr: '' },
  ];
  const all = new Set(['restaurant', 'cafe', 'activity'] as const);

  it('no flags: category filter only', () => {
    expect(filterVenues(venues, { categories: all, veganOnly: false, veganFriendly: false, tea: false })).toHaveLength(5);
    expect(filterVenues(venues, { categories: new Set(['cafe']), veganOnly: false, veganFriendly: false, tea: false })).toHaveLength(2);
  });

  it('veganOnly: only level-2', () => {
    const r = filterVenues(venues, { categories: all, veganOnly: true, veganFriendly: false, tea: false });
    expect(r.map((v) => v.id)).toEqual(['a']);
  });

  it('veganFriendly is a disjoint class: excludes fully-vegan places', () => {
    const r = filterVenues(venues, { categories: all, veganOnly: false, veganFriendly: true, tea: false });
    expect(r.map((v) => v.id)).toEqual(['b']);
  });

  it('vegan classes OR tea: union', () => {
    const r = filterVenues(venues, { categories: all, veganOnly: true, veganFriendly: true, tea: true });
    expect(r.map((v) => v.id).sort()).toEqual(['a', 'b', 'c']);
  });
});
