import { describe, it, expect } from 'vitest';
import { haversineKm, NYC_GRID, cellCenter, pointToCell, cellIndex } from './geo';
import { directTimeMin, walkMin } from './modes';
import { buildGraph, stationTimes, transitField } from './transit';
import { fairnessScore, comboLayer, maxLayers, minPersonField, timeField, scoreAtPoint } from './fairness';
import { filterVenues } from './venues';
import { advantageColor } from './heat';
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

// Tiny synthetic GTFS-style subway: line A over stations 0-1-2 (real segment
// times), line B from station 3 (transfer-adjacent to 1) out to station 4.
const HW = { rush: 300, midday: 600, evening: 720, night: 1200 };
const line: SubwayData = {
  stations: [
    { name: 'S0', lat: 40.7, lng: -74.0 },
    { name: 'S1', lat: 40.72, lng: -74.0 },
    { name: 'S2', lat: 40.74, lng: -74.0 },
    { name: 'S1b', lat: 40.7201, lng: -74.0001 }, // ~11m from S1
    { name: 'S3', lat: 40.7401, lng: -73.95 },
  ],
  routes: [
    { ref: 'A', segs: [[0, 1, 180], [1, 0, 180], [1, 2, 180], [2, 1, 180]], headway: HW },
    { ref: 'B', segs: [[3, 4, 300], [4, 3, 300]], headway: HW },
  ],
  transfers: [[1, 3, 150]],
};

describe('transit graph', () => {
  const g = buildGraph(line, 'midday');

  it('street nodes connect to platforms and transfers exist', () => {
    // station 1 must reach some platform node (id >= station count)
    expect(g.adj[1].some((e) => e.to >= line.stations.length)).toBe(true);
    // GTFS transfer rule 1<->3
    expect(g.adj[1].some((e) => e.to === 3)).toBe(true);
  });

  it('dijkstra reaches transfer-connected line with real times', () => {
    const origin = { lat: 40.7, lng: -74.0 }; // at S0
    const t = stationTimes(g, origin);
    expect(t[0]).toBeLessThan(3); // walk only — wait charged at boarding
    expect(t[2]).toBeGreaterThan(t[1]); // farther along line
    expect(isFinite(t[4])).toBe(true); // via transfer to line B
    expect(t[4]).toBeGreaterThan(t[3]);
  });

  it('waits are daypart-aware: night trips slower than rush', () => {
    const origin = { lat: 40.7, lng: -74.0 };
    const rush = stationTimes(buildGraph(line, 'rush'), origin);
    const night = stationTimes(buildGraph(line, 'night'), origin);
    expect(night[2]).toBeGreaterThan(rush[2]);
    // exactly the headway/2 difference at a single boarding
    expect(night[2] - rush[2]).toBeCloseTo((HW.night - HW.rush) / 2 / 60, 1);
  });

  it('dijkstra reaches every station of a long connected chain (float32 staleness regression)', () => {
    // 200-station chain with irregular spacing to force float32 rounding in dist[].
    const stations = Array.from({ length: 200 }, (_, i) => ({
      name: `C${i}`,
      lat: 40.6 + i * 0.0013 + (i % 7) * 0.00003,
      lng: -74.0 + (i % 3) * 0.0002,
    }));
    const segs: [number, number, number][] = [];
    for (let i = 0; i + 1 < stations.length; i++) {
      segs.push([i, i + 1, 97], [i + 1, i, 97]);
    }
    const chain: SubwayData = { stations, routes: [{ ref: 'X', segs, headway: HW }], transfers: [] };
    const cg = buildGraph(chain, 'midday');
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

describe('deviation tolerance dial', () => {
  it('strict tolerance kills uneven spots that loose tolerance allows for free', () => {
    // 10/25: 15-min gap. Heavily damped under ±0, costs NOTHING under ±30.
    expect(fairnessScore(10, 25, 0)).toBeLessThan(0.02);
    expect(fairnessScore(10, 25, 30)).toBeCloseTo(fairnessScore(17.5, 17.5, 30), 6);
  });

  it('loose tolerance lets a fast-uneven spot beat a slow-even one; strict flips it', () => {
    const fastUneven: [number, number] = [8, 28]; // total 36, gap 20
    const slowEven: [number, number] = [24, 25]; // total 49, gap 1
    expect(fairnessScore(...fastUneven, 30)).toBeGreaterThan(fairnessScore(...slowEven, 30));
    expect(fairnessScore(...fastUneven, 5)).toBeLessThan(fairnessScore(...slowEven, 5));
  });

  it('symmetry between the two people', () => {
    expect(fairnessScore(12, 30, 15)).toBeCloseTo(fairnessScore(30, 12, 15), 6);
  });
});

describe('fairness', () => {
  it('equal short times score higher than equal long times', () => {
    expect(fairnessScore(10, 10)).toBeGreaterThan(fairnessScore(40, 40));
  });

  it('same total: fair split beats lopsided split', () => {
    expect(fairnessScore(20, 20)).toBeGreaterThan(fairnessScore(5, 35));
  });

  it('total time is primary: mildly-uneven fast spot beats perfectly-even slow spot', () => {
    // 12+18=30 total with 6-min gap should beat 25+25=50 total dead-even.
    expect(fairnessScore(12, 18)).toBeGreaterThan(fairnessScore(25, 25));
  });

  it('unreachable scores zero', () => {
    expect(fairnessScore(Infinity, 10)).toBe(0);
  });

  it('maxLayers takes the best combo per cell and handles empty', () => {
    const a = comboLayer('bike', 'car', new Float32Array([10, 20]), new Float32Array([10, 40]));
    const b = comboLayer('walk', 'walk', new Float32Array([10, 20]), new Float32Array([10, 20]));
    const agg = maxLayers([a, b], 2);
    expect(agg[0]).toBeCloseTo(Math.max(a.scores[0], b.scores[0]), 5);
    expect(maxLayers([], 2)[0]).toBe(0);
  });

  it('toggling on a slow combo never dims a good cell (max, not mean)', () => {
    const fast = comboLayer('bike', 'car', new Float32Array([12]), new Float32Array([15]));
    const slow = comboLayer('walk', 'walk', new Float32Array([38]), new Float32Array([39]));
    const withoutSlow = maxLayers([fast], 1)[0];
    const withSlow = maxLayers([fast, slow], 1)[0];
    expect(withSlow).toBeCloseTo(withoutSlow, 6);
  });

  it('minPersonField takes each person best active mode per cell', () => {
    const a = comboLayer('bike', 'car', new Float32Array([10, 30]), new Float32Array([12, 40]));
    const b = comboLayer('transit', 'car', new Float32Array([15, 20]), new Float32Array([12, 40]));
    const mA = minPersonField([a, b], 'A', 2);
    const mB = minPersonField([a, b], 'B', 2);
    expect([...mA]).toEqual([10, 20]);
    expect([...mB]).toEqual([12, 40]);
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

describe('advantage color', () => {
  it('diverges: A turf blue, balanced gold, B turf red — and clamps', () => {
    expect(advantageColor(-25)).toEqual([45, 100, 235]); // full A blue
    expect(advantageColor(-60)).toEqual([45, 100, 235]); // clamped
    expect(advantageColor(0)).toEqual([252, 204, 10]); // gold seam
    expect(advantageColor(25)).toEqual([235, 55, 46]); // full B red
    expect(advantageColor(60)).toEqual([235, 55, 46]); // clamped
  });

  it('interpolates smoothly between poles', () => {
    const [r, g, b] = advantageColor(-12.5); // halfway A-blue → gold
    expect(r).toBeCloseTo((45 + 252) / 2, 0);
    expect(g).toBeCloseTo((100 + 204) / 2, 0);
    expect(b).toBeCloseTo((235 + 10) / 2, 0);
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
