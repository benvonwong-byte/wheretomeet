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
  // Enrichment (present when known)
  web?: string;
  tel?: string;
  hours?: string;
  desc?: string;
  wd?: string;
  img?: string;
  rating?: number; // 1-5 stars
  ratings?: number; // review count
  price?: 1 | 2 | 3 | 4; // $ to $$$$
}

export type Daypart = 'rush' | 'midday' | 'evening' | 'night';

export interface SubwayData {
  stations: { name: string; lat: number; lng: number }[];
  routes: {
    ref: string;
    /** Directed segments [fromStation, toStation, seconds] with real GTFS run times. */
    segs: [number, number, number][];
    /** Scheduled headway in seconds per daypart. */
    headway: Record<Daypart, number>;
  }[];
  /** Station-to-station transfer rules [a, b, seconds] from GTFS transfers.txt. */
  transfers: [number, number, number][];
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
