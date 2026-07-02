import type { Pt, GridSpec } from './types';

const R = 6371; // km

export function haversineKm(a: Pt, b: Pt): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const NYC_GRID: GridSpec = {
  latMin: 40.55,
  latMax: 40.92,
  lngMin: -74.06,
  lngMax: -73.7,
  rows: 148,
  cols: 122,
};

export function cellCenter(grid: GridSpec, row: number, col: number): Pt {
  return {
    lat: grid.latMin + ((row + 0.5) / grid.rows) * (grid.latMax - grid.latMin),
    lng: grid.lngMin + ((col + 0.5) / grid.cols) * (grid.lngMax - grid.lngMin),
  };
}

export function cellIndex(grid: GridSpec, row: number, col: number): number {
  return row * grid.cols + col;
}

/** Nearest cell index for a point, or -1 if outside the grid. */
export function pointToCell(grid: GridSpec, p: Pt): number {
  const row = Math.floor(((p.lat - grid.latMin) / (grid.latMax - grid.latMin)) * grid.rows);
  const col = Math.floor(((p.lng - grid.lngMin) / (grid.lngMax - grid.lngMin)) * grid.cols);
  if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) return -1;
  return cellIndex(grid, row, col);
}
