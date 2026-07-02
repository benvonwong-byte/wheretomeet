export interface Pt {
  lat: number;
  lng: number;
}

export type Mode = 'transit' | 'bike' | 'car' | 'walk';

export interface Venue {
  id: string;
  name: string;
  lat: number;
  lng: number;
  cat: 'restaurant' | 'cafe' | 'activity';
  vegan: 0 | 1 | 2; // 0 none, 1 vegan-friendly, 2 fully vegan
  tea: boolean;
  cuisine: string;
  addr: string;
}

export interface SubwayData {
  stations: { name: string; lat: number; lng: number }[];
  routes: { ref: string; stops: number[] }[];
}

export interface GridSpec {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
  rows: number;
  cols: number;
}

/** Travel-time field over a grid, minutes per cell (row-major). */
export type TimeField = Float32Array;

export interface ComboLayer {
  modeA: Mode;
  modeB: Mode;
  /** Fairness score per cell in [0,1]. */
  scores: Float32Array;
  timesA: TimeField;
  timesB: TimeField;
}
