import L from 'leaflet';
import './style.css';
import venuesData from './data/venues.json';
import supplementData from './data/supplement.json';
import subwayData from './data/subway.json';
import { NYC_GRID, pointToCell } from './lib/geo';
import { carDaypartMin } from './lib/modes';
import { buildGraph, transitPath, type TransitGraph } from './lib/transit';
import { timeField, comboLayer, minPersonField, scoreAtPoint, fairnessScore } from './lib/fairness';
import { maskField } from './lib/contours';
import landmaskData from './data/landmask.json';
import { renderHeat } from './lib/heat';
import { filterVenues } from './lib/venues';
import { geocode, makeSuggester, type GeoHit } from './lib/geocode';
import { routedMinutes, routedField, routedGeometry } from './lib/osrm';
import { venueEmoji } from './lib/emoji';
import { loadFavs, toggleFav, seedFavs } from './lib/favs';
import { encodeShare, parseShare } from './lib/share';
import { parseMapLink, validateSubmission } from './lib/submit';
import type { Pt, Mode, Venue, ComboLayer, TimeField, SubwayData, Daypart } from './lib/types';

// ── Static data ──────────────────────────────────────────────
// venues.json = OSM-baked; supplement.json = hand-curated non-OSM spots;
// localStorage = this visitor's own community submissions. All one pool.
const SUBMIT_KEY = 'w2m:submitted';
function loadSubmitted(): Venue[] {
  try {
    const arr = JSON.parse(localStorage.getItem(SUBMIT_KEY) ?? '[]');
    if (!Array.isArray(arr)) return [];
    // Drop malformed rows (hand-edited storage / old schema) so boot can't crash.
    return arr.filter(
      (v) => v && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.lat === 'number' && typeof v.lng === 'number',
    );
  } catch {
    return [];
  }
}
const VENUES: Venue[] = [
  ...(venuesData as { venues: Venue[] }).venues,
  ...(supplementData as { venues: Venue[] }).venues,
  ...loadSubmitted(),
];
const VENUE_BY_ID = new Map(VENUES.map((v) => [v.id, v]));
const SUBWAY = subwayData as unknown as SubwayData;
const graphCache = new Map<Daypart, TransitGraph>();

function getGraph(daypart: Daypart): TransitGraph {
  let g = graphCache.get(daypart);
  if (!g) {
    g = buildGraph(SUBWAY, daypart);
    graphCache.set(daypart, g);
  }
  return g;
}

const GRID = NYC_GRID;
const CELLS = GRID.rows * GRID.cols;

const MODES: { id: Mode; label: string }[] = [
  { id: 'transit', label: 'SUBWAY' },
  { id: 'bike', label: 'BIKE' },
  { id: 'car', label: 'CAR' },
  { id: 'walk', label: 'WALK' },
];
const MODE_LABEL = Object.fromEntries(MODES.map((m) => [m.id, m.label])) as Record<Mode, string>;

// ── State ────────────────────────────────────────────────────
interface Person {
  pt: Pt;
  modes: Set<Mode>;
}

const state = {
  A: { pt: { lat: 40.7143, lng: -73.9614 }, modes: new Set<Mode>(['transit']) } as Person,
  B: { pt: { lat: 40.787, lng: -73.9754 }, modes: new Set<Mode>(['transit']) } as Person,
  emojiFilter: new Set<string>(),
  cats: new Set<Venue['cat']>(['restaurant', 'cafe', 'activity']),
  veganOnly: true, // show fully-vegan AND vegan-friendly by default (the whole vegan universe)
  veganFriendly: true,
  teaHouse: true,
  bubbleTea: false,
  glutenFree: false,
  daypart: 'midday' as Daypart,
  nameA: '',
  nameB: '',
  bias: 0, // minutes: negative = A gets the advantage, positive = B does
  sortBy: 'best' as SortBy,
  solo: false, // near-me browsing: B mirrors A and stays hidden until set
};

// Hydrate from a shared link — the URL hash IS the plan.
const shared = parseShare(location.hash);
if (shared.a) state.A.pt = shared.a;
if (shared.b) state.B.pt = shared.b;
// One mode per person now; old multi-mode links collapse by a fixed priority
// (MODES order), not the sharer's arbitrary toggle order.
const pickMode = (ms: Mode[]): Mode => MODES.find((m) => ms.includes(m.id))?.id ?? ms[0];
if (shared.modesA?.length) state.A.modes = new Set([pickMode(shared.modesA)]);
if (shared.modesB?.length) state.B.modes = new Set([pickMode(shared.modesB)]);
if (shared.nameA) state.nameA = shared.nameA;
if (shared.nameB) state.nameB = shared.nameB;
if (shared.bias != null) state.bias = shared.bias;
if (shared.daypart) state.daypart = shared.daypart;
if (shared.favs?.length) seedFavs(state.A.pt, state.B.pt, shared.favs);

// Throttled to 1/s: every render syncs, and iOS Safari throws once
// replaceState exceeds ~100 calls per 30s.
let syncTimer = 0;
let lastSyncAt = 0;

function syncUrl(): void {
  const now = Date.now();
  if (now - lastSyncAt < 1000) {
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(syncUrl, 1000 - (now - lastSyncAt));
    return;
  }
  lastSyncAt = now;
  const hash = encodeShare({
    a: state.A.pt,
    b: state.B.pt,
    labelA: (document.getElementById('addr-a') as HTMLInputElement).value || undefined,
    labelB: (document.getElementById('addr-b') as HTMLInputElement).value || undefined,
    nameA: state.nameA || undefined,
    nameB: state.nameB || undefined,
    modesA: [...state.A.modes],
    modesB: [...state.B.modes],
    bias: state.bias,
    daypart: state.daypart,
    favs: [...loadFavs(state.A.pt, state.B.pt)],
    solo: state.solo || undefined,
  });
  try {
    history.replaceState(null, '', hash);
  } catch {
    /* replaceState quota hit — the next sync carries the same state */
  }
}

const fieldCache = new Map<string, TimeField>();
// Street modes upgrade from model estimates to real OSRM-routed fields, async.
const fieldUpgrades = new Map<string, 'pending' | 'done'>();

function getField(who: 'A' | 'B', mode: Mode): TimeField {
  // Transit (headway waits) and car (traffic) depend on the daypart.
  const key = mode === 'transit' || mode === 'car' ? `${who}:${mode}:${state.daypart}` : `${who}:${mode}`;
  let f = fieldCache.get(key);
  if (!f) {
    f = timeField(getGraph(state.daypart), state[who].pt, mode, GRID);
    if (mode === 'car') for (let i = 0; i < f.length; i++) f[i] = carDaypartMin(f[i], state.daypart);
    fieldCache.set(key, f);
  }
  if (mode !== 'transit' && !fieldUpgrades.has(key)) upgradeField(who, mode, key);
  return f;
}

function upgradeField(who: 'A' | 'B', mode: Mode, key: string): void {
  fieldUpgrades.set(key, 'pending');
  const pt = state[who].pt;
  const daypart = state.daypart;
  void routedField(pt, mode, GRID).then((f) => {
    if (state[who].pt !== pt) return; // pin moved while routing — stale
    if (!f) {
      fieldUpgrades.delete(key); // local server unreachable; retry on next recompute
      return;
    }
    if (mode === 'car') for (let i = 0; i < f.length; i++) f[i] = carDaypartMin(f[i], daypart);
    fieldCache.set(key, f);
    fieldUpgrades.set(key, 'done');
    scheduleRecompute();
  });
}

function clearPersonFields(who: 'A' | 'B'): void {
  for (const key of [...fieldCache.keys()]) if (key.startsWith(`${who}:`)) fieldCache.delete(key);
  for (const key of [...fieldUpgrades.keys()]) if (key.startsWith(`${who}:`)) fieldUpgrades.delete(key);
}

function activeCombos(): { a: Mode; b: Mode }[] {
  if (state.solo) return [...state.A.modes].map((mode) => ({ a: mode, b: mode }));
  const out: { a: Mode; b: Mode }[] = [];
  for (const m of MODES) {
    if (!state.A.modes.has(m.id)) continue;
    for (const n of MODES) {
      if (!state.B.modes.has(n.id)) continue;
      out.push({ a: m.id, b: n.id });
    }
  }
  return out;
}

// ── Map ──────────────────────────────────────────────────────
// innerWidth can transiently read 0 (webview boot) — default to desktop then.
const VP_W = window.innerWidth || document.documentElement.clientWidth;
const IS_MOBILE = VP_W > 0 && VP_W <= 760;
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;

// The mobile layout rebuilds the DOM at boot, so crossing the 760px breakpoint
// live (phone rotation) strands mobile DOM under desktop CSS — reload instead;
// the URL hash carries the whole plan across.
window.matchMedia('(max-width: 760px)').addEventListener('change', (e) => {
  if (e.matches !== IS_MOBILE) location.reload();
});

// Boot-time auto-locate must not yank the map from under a user who has
// already started browsing.
let userInteracted = false;
window.addEventListener('pointerdown', () => (userInteracted = true), { once: true, capture: true });

const map = L.map('map', { zoomControl: false }).setView([40.745, -73.96], 12);
if (!IS_MOBILE) L.control.zoom({ position: 'bottomright' }).addTo(map); // touch pinches instead
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OpenStreetMap contributors © CARTO',
  maxZoom: 19,
}).addTo(map);

const venueLayer = L.layerGroup().addTo(map);

const personLabel = (who: 'A' | 'B'): string => (who === 'A' ? state.nameA : state.nameB) || who;
const personInitial = (who: 'A' | 'B'): string => personLabel(who).charAt(0).toUpperCase();

function bulletIcon(who: 'A' | 'B'): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="marker-bullet ${who.toLowerCase()}">${personInitial(who)}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function makePersonMarker(who: 'A' | 'B'): L.Marker {
  const marker = L.marker(state[who].pt, { icon: bulletIcon(who), draggable: true }).addTo(map);
  marker.on('dragend', () => {
    const ll = marker.getLatLng();
    state[who].pt = { lat: ll.lat, lng: ll.lng };
    if (state.solo && who === 'A') {
      state.B.pt = state.A.pt;
      exactCache.B.clear();
    }
    clearPersonFields(who);
    exactCache[who].clear();
    (document.getElementById(`addr-${who.toLowerCase()}`) as HTMLInputElement).value = '';
    coverageWarning(who);
    scheduleRecompute();
  });
  return marker;
}

const markers = { A: makePersonMarker('A'), B: makePersonMarker('B') };

// ── Swap A ↔ B ───────────────────────────────────────────────
function swapPersons(): void {
  const tmp = state.A;
  state.A = state.B;
  state.B = tmp;

  // Rename cached fields instead of recomputing them.
  const rename = (k: string) => (k.startsWith('A:') ? 'B' + k.slice(1) : k.startsWith('B:') ? 'A' + k.slice(1) : k);
  const fields = [...fieldCache].map(([k, v]) => [rename(k), v] as const);
  fieldCache.clear();
  for (const [k, v] of fields) fieldCache.set(k, v);
  const upgrades = [...fieldUpgrades].map(([k, v]) => [rename(k), v] as const);
  fieldUpgrades.clear();
  for (const [k, v] of upgrades) fieldUpgrades.set(k, v);
  const tmpExact = exactCache.A;
  exactCache.A = exactCache.B;
  exactCache.B = tmpExact;

  markers.A.setLatLng(state.A.pt);
  markers.B.setLatLng(state.B.pt);
  const inA = document.getElementById('addr-a') as HTMLInputElement;
  const inB = document.getElementById('addr-b') as HTMLInputElement;
  [inA.value, inB.value] = [inB.value, inA.value];
  [state.nameA, state.nameB] = [state.nameB, state.nameA];
  state.bias = -state.bias;
  (document.getElementById('bias') as HTMLInputElement).value = String(state.bias);
  const nA = document.getElementById('name-a') as HTMLInputElement;
  const nB = document.getElementById('name-b') as HTMLInputElement;
  [nA.value, nB.value] = [nB.value, nA.value];
  applyNames();
  renderModes('A');
  renderModes('B');
  closeDetail();
  scheduleRecompute();
}

// ── UI: mode pills ───────────────────────────────────────────
function renderModes(who: 'A' | 'B'): void {
  const el = document.getElementById(`modes-${who.toLowerCase()}`)!;
  el.innerHTML = '';
  for (const m of MODES) {
    const btn = document.createElement('button');
    btn.className = 'mode-pill' + (state[who].modes.has(m.id) ? ' on' : '');
    btn.textContent = m.label;
    btn.onclick = () => {
      if (state[who].modes.has(m.id)) return;
      state[who].modes = new Set([m.id]);
      if (state.solo && who === 'A') state.B.modes = new Set([m.id]);
      renderModes(who);
      closeDetail(); // an open card would show combos for the OLD mode
      scheduleRecompute();
    };
    el.appendChild(btn);
  }
}

// ── Venue sort criteria ──────────────────────────────────────
type SortBy = 'best' | 'total' | 'equal' | 'a' | 'b';

const SORTS: { id: SortBy; label: string }[] = [
  { id: 'best', label: 'BEST' },
  { id: 'total', label: 'FASTEST TOTAL' },
  { id: 'equal', label: 'MOST EQUAL' },
  { id: 'a', label: 'BEST FOR A' },
  { id: 'b', label: 'BEST FOR B' },
];

function sortLabel(s: { id: SortBy; label: string }): string {
  if (s.id === 'a') return `BEST FOR ${personLabel('A').toUpperCase()}`;
  if (s.id === 'b') return `BEST FOR ${personLabel('B').toUpperCase()}`;
  return s.label;
}

type Combo = { modeA: Mode; modeB: Mode; tA: number; tB: number };

/** The combo that wins under the current criterion — also the headline shown. */
function pickCombo(combos: Combo[], sortBy: SortBy): Combo {
  const metric = (c: Combo): number => {
    switch (sortBy) {
      case 'total':
        return c.tA + c.tB;
      case 'equal':
        return Math.abs(c.tA - c.tB);
      case 'a':
        return c.tA;
      case 'b':
        return c.tB;
      default:
        return -fairnessScore(c.tA, c.tB, state.bias); // lower = better
    }
  };
  return combos.reduce((p, c) => (metric(c) < metric(p) ? c : p));
}

function renderSortChips(): void {
  const el = document.getElementById('sort-chips')!;
  el.innerHTML = '';
  for (const s of SORTS) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.sortBy === s.id ? ' on' : '');
    chip.textContent = sortLabel(s);
    chip.onclick = () => {
      if (state.sortBy === s.id) return;
      state.sortBy = s.id;
      renderSortChips();
      scheduleRecompute(true);
    };
    el.appendChild(chip);
  }
}

// ── UI: daypart + bias dial ──────────────────────────────────
const DAYPARTS: { id: Daypart; label: string }[] = [
  { id: 'rush', label: 'RUSH HOUR' },
  { id: 'midday', label: 'MIDDAY' },
  { id: 'evening', label: 'EVENING' },
  { id: 'night', label: 'LATE NIGHT' },
];

function renderDayparts(): void {
  const el = document.getElementById('dayparts')!;
  el.innerHTML = '';
  for (const d of DAYPARTS) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.daypart === d.id ? ' on' : '');
    chip.textContent = d.label;
    chip.onclick = () => {
      if (state.daypart === d.id) return;
      state.daypart = d.id;
      // Refined car times are daypart-scaled — force a re-fetch at the new hour.
      for (const who of ['A', 'B'] as const) {
        for (const k of [...exactCache[who].keys()]) if (k.startsWith('car:')) exactCache[who].delete(k);
      }
      renderDayparts();
      closeDetail();
      scheduleRecompute();
    };
    el.appendChild(chip);
  }
}

function updateBiasLabel(): void {
  const val = document.getElementById('bias-val')!;
  val.textContent =
    state.bias === 0
      ? 'FAIR'
      : state.bias < 0
        ? `${personLabel('A')} saves ${-state.bias}′`
        : `${personLabel('B')} saves ${state.bias}′`;
  document.getElementById('bias-left')!.textContent = `← ${personLabel('A')} advantage`;
  document.getElementById('bias-right')!.textContent = `${personLabel('B')} advantage →`;
}

function wireBias(): void {
  const slider = document.getElementById('bias') as HTMLInputElement;
  slider.addEventListener('input', () => {
    state.bias = +slider.value;
    updateBiasLabel();
    scheduleRecompute();
  });
}

// ── UI: filters ──────────────────────────────────────────────
const CATS: { id: Venue['cat']; label: string }[] = [
  { id: 'restaurant', label: 'RESTAURANTS' },
  { id: 'cafe', label: 'CAFES' },
  { id: 'activity', label: 'ACTIVITIES' },
];

function renderCatFilters(): void {
  const el = document.getElementById('cat-filters')!;
  el.innerHTML = '';
  for (const c of CATS) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.cats.has(c.id) ? ' on' : '');
    chip.textContent = c.label;
    chip.onclick = () => {
      if (state.cats.has(c.id)) state.cats.delete(c.id);
      else state.cats.add(c.id);
      renderCatFilters();
      scheduleRecompute(true);
    };
    el.appendChild(chip);
  }
}

function renderDietFilters(): void {
  const el = document.getElementById('diet-filters')!;
  el.innerHTML = '';
  const defs = [
    { key: 'veganFriendly' as const, label: '🌿 VEGAN-FRIENDLY', cls: 'vegan' },
    { key: 'veganOnly' as const, label: '🌱 FULLY VEGAN', cls: 'vegan' },
    { key: 'teaHouse' as const, label: '🍵 TEA HOUSE', cls: 'tea' },
    { key: 'bubbleTea' as const, label: '🧋 BUBBLE TEA', cls: 'boba' },
    { key: 'glutenFree' as const, label: '🌾 GLUTEN-FREE', cls: 'gf' },
  ];
  for (const d of defs) {
    const chip = document.createElement('button');
    chip.className = `chip hero ${d.cls}` + (state[d.key] ? ' on' : '');
    chip.textContent = d.label;
    chip.onclick = () => {
      state[d.key] = !state[d.key];
      renderDietFilters();
      scheduleRecompute(true);
    };
    el.appendChild(chip);
  }
}

// ── UI: geocode inputs with autocomplete ─────────────────────
function coverageWarning(who: 'A' | 'B'): void {
  const p = state[who].pt;
  const outside = p.lat < GRID.latMin || p.lat > GRID.latMax || p.lng < GRID.lngMin || p.lng > GRID.lngMax;
  if (outside) {
    setStatus(`Heads up: ${who} is outside NYC coverage — no subway data there, times are rough estimates`, 5000);
  }
}

function warnIfOutsideCoverage(who: 'A' | 'B', pt: Pt): void {
  const inside =
    pt.lat >= GRID.latMin && pt.lat <= GRID.latMax && pt.lng >= GRID.lngMin && pt.lng <= GRID.lngMax;
  if (!inside) {
    setStatus(`Heads up: ${who} is outside NYC coverage — subway can't reach there, times are rough estimates`, 5000);
  }
}

function applyLocation(who: 'A' | 'B', hit: GeoHit, input: HTMLInputElement): void {
  input.value = hit.label;
  input.classList.remove('bad');
  if (state.solo && who === 'B') exitSolo();
  state[who].pt = hit.pt;
  if (state.solo && who === 'A') {
    state.B.pt = hit.pt;
    exactCache.B.clear();
  }
  warnIfOutsideCoverage(who, hit.pt);
  clearPersonFields(who);
  exactCache[who].clear();
  markers[who].setLatLng(hit.pt);
  map.panTo(hit.pt);
  coverageWarning(who);
  scheduleRecompute();
}

function wireInput(who: 'A' | 'B'): void {
  const input = document.getElementById(`addr-${who.toLowerCase()}`) as HTMLInputElement;
  const drop = document.createElement('div');
  drop.className = 'suggest';
  drop.hidden = true;
  input.parentElement!.appendChild(drop);

  let hits: GeoHit[] = [];
  let sel = -1;

  const close = () => {
    drop.hidden = true;
    sel = -1;
  };

  const renderDrop = () => {
    drop.innerHTML = '';
    drop.hidden = hits.length === 0;
    hits.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'suggest-row' + (i === sel ? ' sel' : '');
      row.textContent = h.label;
      // pointerdown keeps the input focused (beats the blur-close); click
      // commits — mousedown alone dies silently on touch if the finger drifts.
      row.onpointerdown = (e) => e.preventDefault();
      row.onclick = () => {
        close();
        applyLocation(who, h, input);
      };
      drop.appendChild(row);
    });
  };

  const suggester = makeSuggester((results) => {
    hits = results;
    sel = -1;
    renderDrop();
  });

  input.addEventListener('input', () => {
    input.classList.remove('bad');
    suggester(input.value);
  });

  input.addEventListener('blur', () => window.setTimeout(close, 150));

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault();
      sel = (sel + 1) % hits.length;
      renderDrop();
    } else if (e.key === 'ArrowUp' && hits.length) {
      e.preventDefault();
      sel = (sel - 1 + hits.length) % hits.length;
      renderDrop();
    } else if (e.key === 'Escape') {
      close();
    } else if (e.key === 'Enter') {
      if (!input.value.trim()) return;
      const picked = sel >= 0 ? hits[sel] : hits[0];
      close();
      if (picked) {
        applyLocation(who, picked, input);
        return;
      }
      // No suggestions — precise Nominatim fallback.
      setStatus('Locating…');
      const hit = await geocode(input.value.trim());
      if (!hit) {
        setStatus('Address not found — try adding a borough', 2600);
        input.classList.add('bad');
        return;
      }
      applyLocation(who, hit, input);
    }
  });
}

// ── Status toast ─────────────────────────────────────────────
const statusEl = document.getElementById('status')!;
let statusTimer = 0;

function setStatus(msg: string, autoHide = 0): void {
  statusEl.textContent = msg;
  statusEl.hidden = false;
  window.clearTimeout(statusTimer);
  if (autoHide) statusTimer = window.setTimeout(() => (statusEl.hidden = true), autoHide);
}

// ── Recompute pipeline ───────────────────────────────────────
let pending = 0;
let pendingVenuesOnly = true;

function scheduleRecompute(venuesOnly = false): void {
  pendingVenuesOnly = pendingVenuesOnly && venuesOnly; // a full request never downgrades
  updatePlanBar();
  window.clearTimeout(pending);
  setStatus(state.solo ? 'Finding spots near you…' : 'Computing fair zones…');
  pending = window.setTimeout(() => {
    const vo = pendingVenuesOnly;
    pendingVenuesOnly = true;
    recompute(vo);
  }, 30);
}

let lastLayers: ComboLayer[] = [];

function recompute(venuesOnly: boolean): void {
  if (!venuesOnly || lastLayers.length === 0) {
    const combos = activeCombos();
    lastLayers = combos.map((c) => {
      const fA = getField('A', c.a);
      const fB = state.solo ? fA : getField('B', c.b);
      return comboLayer(c.a, c.b, fA, fB, state.bias);
    });
  }
  renderVenues(); // heat follows the venue list (drawn at the end of renderVenues)
  setStatus('Ready', 900);
}

// ── Advantage heatmap over the recommended zone ──────────────
// Bold, opaque heat concentrated where meeting is quickest for BOTH people:
// leafy green = closer for A, star yellow = even, cow purple = closer for B.
// Clipped to land by the baked mask; fades out past the recommended zone.
const LANDMASK = (landmaskData as { mask: string }).mask;
const HEAT_BOUNDS = L.latLngBounds([GRID.latMin, GRID.lngMin], [GRID.latMax, GRID.lngMax]);
let heatOverlay: L.ImageOverlay | null = null;

let shownVenueCells: number[] = []; // grid cells of the currently listed venues

function drawContours(): void {
  if (lastLayers.length === 0) return;
  const gap = new Float32Array(CELLS);
  const minA = maskField(minPersonField(lastLayers, 'A', CELLS), LANDMASK);
  if (state.solo) {
    // Advantage is meaningless solo (gap ≡ 0) — the glow becomes a closeness
    // gradient instead: green ≤5′ from you, yellow ~15′, purple 25′+.
    for (let i = 0; i < CELLS; i++) {
      const t = minA[i];
      gap[i] = isFinite(t) ? Math.max(-14, Math.min(14, ((t - 15) / 10) * 14)) : 14;
    }
  } else {
    const minB = maskField(minPersonField(lastLayers, 'B', CELLS), LANDMASK);
    for (let i = 0; i < CELLS; i++) {
      gap[i] = minA[i] - minB[i];
    }
  }

  const url = renderHeat(gap, shownVenueCells, GRID, state.solo ? 0 : state.bias).toDataURL();
  if (!heatOverlay) {
    heatOverlay = L.imageOverlay(url, HEAT_BOUNDS, {
      opacity: 0.78,
      className: 'glow-img',
      interactive: false,
    }).addTo(map);
  } else {
    heatOverlay.setUrl(url);
  }
  heatOverlay.setOpacity(state.solo ? 0.4 : 0.78); // whisper-light under a zoomed-in view
}

// ── Venues ───────────────────────────────────────────────────
const gmaps = (v: Venue) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name} ${v.addr || ''} New York`)}`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function venueTags(v: Venue): string {
  const tags: string[] = [];
  if (v.vegan === 2) tags.push('<span class="tag vegan2">🌱 100% vegan</span>');
  else if (v.vegan === 1) tags.push('<span class="tag vegan1">🌿 vegan-friendly</span>');
  if (v.tea === 1) tags.push('<span class="tag tea">🍵 tea house</span>');
  else if (v.tea === 2) tags.push('<span class="tag boba">🧋 bubble tea</span>');
  if (v.gf === 2) tags.push('<span class="tag gf">🌾 100% gluten-free</span>');
  else if (v.gf === 1) tags.push('<span class="tag gf">🌾 GF options</span>');
  tags.push(`<span class="tag">${v.cat}</span>`);
  return tags.join('');
}

function starsHtml(v: Venue): string {
  if (v.rating == null) return '';
  const full = Math.round(v.rating);
  const stars = '★'.repeat(full) + '☆'.repeat(5 - full);
  const count = v.ratings ? ` (${v.ratings.toLocaleString()})` : '';
  return `<span class="stars">${stars}</span> <b>${v.rating.toFixed(1)}</b>${count}`;
}

function tipHtml(v: Venue): string {
  const bits = [`${venueEmoji(v)} <b>${esc(v.name)}</b>`];
  const stars = starsHtml(v);
  if (stars) bits.push(stars);
  if (v.cuisine) bits.push(esc(v.cuisine.split(';')[0].replace(/_/g, ' ')));
  return bits.join(' · ');
}

function metaLine(v: Venue): string {
  const bits: string[] = [];
  const stars = starsHtml(v);
  if (stars) bits.push(stars);
  if (v.price) bits.push(`<span class="price">${'$'.repeat(v.price)}</span>`);
  if (v.cuisine) bits.push(esc(v.cuisine.split(';')[0].replace(/_/g, ' ')));
  return bits.join(' · ');
}

// ── Route drawing (A & B paths to the selected venue) ────────
const routeLayer = L.layerGroup().addTo(map);
let routeToken = 0;

async function personRoute(who: 'A' | 'B', mode: Mode, v: Venue): Promise<{ path: Pt[]; routed: boolean }> {
  const origin = state[who].pt;
  const dest = { lat: v.lat, lng: v.lng };
  if (mode === 'transit') return { path: transitPath(getGraph(state.daypart), origin, dest), routed: true };
  const geo = await routedGeometry(origin, dest, mode);
  // No routing tier reachable → straight-line ESTIMATE, drawn visibly as one.
  return geo ? { path: geo, routed: true } : { path: [origin, dest], routed: false };
}

async function drawRoutes(v: Venue, modeA: Mode, modeB: Mode): Promise<void> {
  const token = ++routeToken;
  const [ra, rb] = await Promise.all([personRoute('A', modeA, v), state.solo ? null : personRoute('B', modeB, v)]);
  if (token !== routeToken) return; // another venue selected meanwhile
  routeLayer.clearLayers();
  const style = (color: string, mode: Mode, routed: boolean) => ({
    color,
    weight: routed ? 4 : 3,
    opacity: routed ? 0.85 : 0.45,
    // transit = schematic station hops; unrouted street = rough estimate
    dashArray: mode === 'transit' ? '2 8' : routed ? undefined : '10 10',
    lineCap: 'round' as const,
    // Decorative: Leaflet paths bubble clicks to the map by default, and a
    // map click closes the very card these routes belong to.
    interactive: false,
  });
  // Keep the user's viewport — auto-fitting to the route yanked the zoom out.
  L.polyline(ra.path, style('#4f8f00', modeA, ra.routed)).addTo(routeLayer);
  if (rb) L.polyline(rb.path, style('#7b2cbf', modeB, rb.routed)).addTo(routeLayer);
}

// ── Detail panel ─────────────────────────────────────────────
const detailEl = document.getElementById('detail') as HTMLElement;

function closeDetail(): void {
  detailEl.hidden = true;
  routeToken++;
  routeLayer.clearLayers();
}

function showDetail(v: Venue, combos: { modeA: Mode; modeB: Mode; tA: number; tB: number }[]): void {
  const rows = combos
    .map((c) =>
      state.solo
        ? `<tr><td><span class="ca">${esc(personLabel('A'))} · ${MODE_LABEL[c.modeA]}</span></td><td>${Math.round(c.tA)}′</td></tr>`
        : `<tr><td><span class="ca">${esc(personLabel('A'))} · ${MODE_LABEL[c.modeA]}</span></td><td>${Math.round(c.tA)}′</td>` +
          `<td><span class="cb">${esc(personLabel('B'))} · ${MODE_LABEL[c.modeB]}</span></td><td>${Math.round(c.tB)}′</td>` +
          `<td class="gap">Δ${Math.round(Math.abs(c.tA - c.tB))}′</td></tr>`,
    )
    .join('');
  // Cuisine/price only — the rating gets its own prominent row.
  const metaBits: string[] = [];
  if (v.price) metaBits.push(`<span class="price">${'$'.repeat(v.price)}</span>`);
  if (v.cuisine) metaBits.push(esc(v.cuisine.split(';')[0].replace(/_/g, ' ')));
  const meta = metaBits.join(' · ');
  const ratingRow =
    v.rating != null
      ? `<div class="detail-rating"><span class="stars">${'★'.repeat(Math.round(v.rating))}${'☆'.repeat(5 - Math.round(v.rating))}</span> <b>${v.rating.toFixed(1)}</b>${v.ratings ? ` · ${v.ratings.toLocaleString()} reviews` : ''}</div>`
      : `<div class="detail-rating none"><span class="stars">☆☆☆☆☆</span> not yet rated</div>`;
  const isFav = loadFavs(state.A.pt, state.B.pt).has(v.id);
  detailEl.innerHTML =
    `<button class="detail-close" aria-label="Close">✕</button>` +
    `<button class="fav-btn detail-fav${isFav ? ' on' : ''}" title="favorite for this pair">♥</button>` +
    (v.img ? `<img class="detail-img" src="${esc(v.img)}" alt="" onerror="this.remove()" />` : '') +
    `<div class="detail-body">` +
    `<h3>${venueEmoji(v)} ${esc(v.name)}</h3>` +
    ratingRow +
    (meta ? `<div class="detail-meta">${meta}</div>` : '') +
    `<div class="detail-tags">${venueTags(v)}</div>` +
    (v.desc ? `<p class="detail-desc">${esc(v.desc)}</p>` : '') +
    `<div class="detail-facts">` +
    (v.addr ? `<div>📍 ${esc(v.addr)}</div>` : '') +
    (v.hours ? `<div>🕐 ${esc(v.hours.length > 64 ? v.hours.slice(0, 64) + '…' : v.hours)}</div>` : '') +
    (v.tel ? `<div>📞 ${esc(v.tel)}</div>` : '') +
    `</div>` +
    `<table class="detail-times">${rows}</table>` +
    `<div class="detail-links">` +
    (v.web ? `<a href="${esc(v.web)}" target="_blank" rel="noopener">Website ↗</a>` : '') +
    `<a href="${gmaps(v)}" target="_blank" rel="noopener">Google Maps ↗</a>` +
    `</div></div>`;
  detailEl.hidden = false;
  const headline = pickCombo(combos, state.sortBy);
  void drawRoutes(v, headline.modeA, headline.modeB);
  if (IS_MOBILE) {
    // The card sits at the top of the sheet — a list scrolled at full would
    // otherwise leave it stranded above the screen.
    detailEl.closest('#rail')!.scrollTop = 0;
    sheetTo('half');
    map.panInside([v.lat, v.lng], {
      paddingTopLeft: [24, 130],
      paddingBottomRight: [24, Math.round(window.innerHeight * 0.55)],
    });
  }
  detailEl.querySelector<HTMLButtonElement>('.detail-close')!.onclick = closeDetail;
  detailEl.querySelector<HTMLButtonElement>('.detail-fav')!.onclick = () => {
    toggleFav(state.A.pt, state.B.pt, v.id);
    renderVenues();
    showDetail(v, combos);
  };
}

// Venue dot fills: neutral → star yellow → heart red (pops over the heat).
function heatColor(t: number): string {
  if (t > 0.8) return '#e0445a';
  if (t > 0.6) return '#f08c1d';
  if (t > 0.4) return '#e2b400';
  return '#a8ad9f';
}

// ── Exact street routing (OSRM) ──────────────────────────────
// Model times paint the heatmap; the ranked list gets refined with real
// street-network routing per venue. Cache: `${mode}:${venueId}` → minutes.
const exactCache = { A: new Map<string, number | null>(), B: new Map<string, number | null>() };
let refineToken = 0;

function effectiveCombos(
  v: Venue,
  combos: { modeA: Mode; modeB: Mode; tA: number; tB: number }[],
): { combos: { modeA: Mode; modeB: Mode; tA: number; tB: number }[]; refined: boolean } {
  let refined = false;
  const out = combos.map((c) => {
    const eA = exactCache.A.get(`${c.modeA}:${v.id}`);
    const eB = exactCache.B.get(`${c.modeB}:${v.id}`);
    if (typeof eA === 'number' || typeof eB === 'number') refined = true;
    return { ...c, tA: typeof eA === 'number' ? eA : c.tA, tB: typeof eB === 'number' ? eB : c.tB };
  });
  return { combos: out, refined };
}

async function refineVenues(venues: Venue[]): Promise<void> {
  const token = ++refineToken;
  const jobs: Promise<void>[] = [];
  const persons = state.solo ? (['A'] as const) : (['A', 'B'] as const);
  for (const who of persons) {
    for (const mode of state[who].modes) {
      if (mode === 'transit') continue; // GTFS engine is the authority there
      const missing = venues.filter((v) => !exactCache[who].has(`${mode}:${v.id}`));
      if (!missing.length) continue;
      const daypart = state.daypart;
      jobs.push(
        routedMinutes(state[who].pt, missing, mode).then((mins) => {
          if (!mins) return;
          missing.forEach((v, i) => {
            const t = mins[i];
            const val = mode === 'car' && t != null ? carDaypartMin(t, daypart) : t;
            exactCache[who].set(`${mode}:${v.id}`, val);
            if (state.solo) exactCache.B.set(`${mode}:${v.id}`, val); // B mirrors A
          });
        }),
      );
    }
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  if (token === refineToken) renderVenues(); // no missing left → no re-refine loop
}

function renderVenues(): void {
  venueLayer.clearLayers();
  const listEl = document.getElementById('venues')!;
  const headEl = document.getElementById('venues-head')!;
  listEl.innerHTML = '';

  // Legend counts come from the pre-emoji filter pass so options stay visible.
  const preEmoji = filterVenues(VENUES, {
    categories: state.cats,
    veganOnly: state.veganOnly,
    veganFriendly: state.veganFriendly,
    teaHouse: state.teaHouse,
    bubbleTea: state.bubbleTea,
    glutenFree: state.glutenFree,
  });
  const emojiCounts = new Map<string, number>();
  for (const v of preEmoji) {
    const e = venueEmoji(v);
    emojiCounts.set(e, (emojiCounts.get(e) ?? 0) + 1);
  }
  renderEmojiLegend(emojiCounts);
  const filtered = state.emojiFilter.size
    ? filterVenues(VENUES, {
        categories: state.cats,
        veganOnly: state.veganOnly,
        veganFriendly: state.veganFriendly,
        teaHouse: state.teaHouse,
        bubbleTea: state.bubbleTea,
        glutenFree: state.glutenFree,
        emoji: state.emojiFilter,
      })
    : preEmoji;

  // Shortlist by model score with margin, then rank by the SAME times the rows
  // display (street-routed where available) so rank and readout never disagree.
  const candidates = filtered
    .map((v) => ({ v, s: scoreAtPoint(GRID, lastLayers, v) }))
    .filter((x): x is { v: Venue; s: NonNullable<ReturnType<typeof scoreAtPoint>> } => x.s !== null && x.s.score > 0.001)
    .sort((a, b) => b.s.score - a.s.score)
    .slice(0, 60);

  const enriched = candidates.map(({ v, s }) => {
    const eff = effectiveCombos(v, s.combos);
    const finalScore = eff.combos.reduce((m, c) => Math.max(m, fairnessScore(c.tA, c.tB, state.bias)), 0);
    const best = pickCombo(eff.combos, state.sortBy);
    const shownTotal = best.tA + best.tB;
    return { v, s, eff, finalScore, best, shownTotal };
  });

  // Viability gate: a spot must SAVE BOTH PEOPLE TIME. Anything more than
  // 15 combined minutes past the best reachable venue is out, no matter how
  // perfectly equal the split is — equality ranks within the time-savers.
  // Gated on the same combo the row displays, so what you see always passes.
  const minVenueTotal = enriched.reduce((m, x) => Math.min(m, x.shownTotal), Infinity);
  const scored = enriched
    .filter((x) => x.shownTotal <= minVenueTotal + (state.solo ? 30 : 15))
    .sort((x, y) => {
      switch (state.sortBy) {
        case 'total':
          return x.best.tA + x.best.tB - (y.best.tA + y.best.tB);
        case 'equal':
          return Math.abs(x.best.tA - x.best.tB) - Math.abs(y.best.tA - y.best.tB) || x.best.tA + x.best.tB - (y.best.tA + y.best.tB);
        case 'a':
          return x.best.tA - y.best.tA || x.best.tB - y.best.tB;
        case 'b':
          return x.best.tB - y.best.tB || x.best.tA - y.best.tA;
        default:
          return y.finalScore - x.finalScore;
      }
    })
    .slice(0, 40);

  headEl.textContent = state.solo ? `Near you · ${scored.length}` : `Best spots · ${scored.length}`;

  if (!scored.length) {
    const hint = state.emojiFilter.size
      ? 'clear the emoji filter on the map, widen filters, or move a pin'
      : 'widen filters or move a pin';
    listEl.innerHTML = `<li class="empty">No venues in the fair zone — ${hint}.</li>`;
    shownVenueCells = [];
    drawContours();
    renderShortlist(loadFavs(state.A.pt, state.B.pt));
    syncUrl();
    return;
  }

  // Favorites for this A↔B pair float to the top.
  const favs = loadFavs(state.A.pt, state.B.pt);
  const ordered = [...scored.filter((x) => favs.has(x.v.id)), ...scored.filter((x) => !favs.has(x.v.id))];

  const maxScore = Math.max(...scored.map((x) => x.finalScore)) || 1;
  for (const { v, s, eff, finalScore, best } of ordered) {
    const { refined } = eff;
    const isFav = favs.has(v.id);
    // Ring color: fully-vegan MTA green, vegan-friendly fainter; fav = pink.
    const ring = isFav ? '#ff2d78' : v.vegan === 2 ? '#00e05c' : v.vegan === 1 ? '#7dedaa' : '#fff';
    const pin = L.marker([v.lat, v.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="venue-pin${v.rating != null && v.rating >= 4.5 ? ' top-rated' : ''}" style="background:${heatColor(finalScore / maxScore)};border-color:${ring}">${venueEmoji(v)}${v.vegan === 2 ? '<span class="pin-leaf">🌱</span>' : ''}${isFav ? '<span class="pin-fav">♥</span>' : ''}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
    }).addTo(venueLayer);
    if (!IS_TOUCH && !IS_MOBILE) pin.bindTooltip(tipHtml(v), { direction: 'top', offset: [0, -12], className: 'venue-tip' });
    pin.on('click', () => showDetail(v, effectiveCombos(v, s.combos).combos));

    const li = document.createElement('li');
    if (isFav) li.className = 'faved';
    const meta = metaLine(v);
    li.innerHTML =
      `<span class="v-name">${venueEmoji(v)} ${esc(v.name)}</span>` +
      `<span class="v-side"><button class="fav-btn${isFav ? ' on' : ''}" title="favorite for this pair">♥</button>` +
      `<span class="v-times">${refined ? '<span class="routed" title="street-routed times">⚡</span>' : ''}${
        state.solo ? `<b class="ta">${Math.round(best.tA)}′</b>` : `<b class="ta">${Math.round(best.tA)}′</b>/<b class="tb">${Math.round(best.tB)}′</b>`
      }</span></span>` +
      (meta ? `<span class="v-meta">${meta}</span>` : '') +
      `<span class="v-tags">${venueTags(v)}</span>`;
    li.querySelector<HTMLButtonElement>('.fav-btn')!.onclick = (e) => {
      e.stopPropagation();
      toggleFav(state.A.pt, state.B.pt, v.id);
      renderVenues();
    };
    li.onclick = () => {
      map.setView([v.lat, v.lng], Math.max(map.getZoom(), 14));
      showDetail(v, effectiveCombos(v, s.combos).combos);
    };
    listEl.appendChild(li);
  }

  void refineVenues(candidates.map((x) => x.v));
  shownVenueCells = scored.map((x) => pointToCell(GRID, x.v));
  drawContours();
  renderShortlist(favs);
  syncUrl();
}


// ── Emoji legend (map side) — tap to filter by venue type ────
function renderEmojiLegend(counts: Map<string, number>): void {
  const el = document.getElementById('emoji-legend')!;
  el.innerHTML = '';
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const e of state.emojiFilter) {
    if (!top.some(([emoji]) => emoji === e)) top.push([e, counts.get(e) ?? 0]);
  }
  el.hidden = top.length < 2 && state.emojiFilter.size === 0;
  if (el.hidden) return;
  for (const [emoji, n] of top) {
    const btn = document.createElement('button');
    btn.className = 'em' + (state.emojiFilter.has(emoji) ? ' on' : '');
    btn.textContent = emoji;
    btn.title = `${n} spots — tap to filter`;
    btn.onclick = () => {
      if (state.emojiFilter.has(emoji)) state.emojiFilter.delete(emoji);
      else state.emojiFilter.add(emoji);
      scheduleRecompute(true);
    };
    el.appendChild(btn);
  }
}

// ── Shortlist panel (the shareable picks list) ───────────────
function renderShortlist(favs: Set<string>): void {
  const panel = document.getElementById('shortlist')!;
  const list = document.getElementById('shortlist-items')!;
  const items = [...favs].map((id) => VENUE_BY_ID.get(id)).filter((v): v is Venue => !!v);
  panel.hidden = items.length === 0;
  panel.querySelector('h3')!.innerHTML = `♥ Your shortlist (${items.length}) <span class="sl-caret">▾</span>`;
  list.innerHTML = '';
  for (const v of items) {
    const s = scoreAtPoint(GRID, lastLayers, v);
    const combos = s ? effectiveCombos(v, s.combos).combos : [];
    const best = combos.length ? pickCombo(combos, state.sortBy) : null;
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="sl-name">${venueEmoji(v)} ${esc(v.name)}</span>` +
      (best
        ? `<span class="sl-times">${state.solo ? `<b class="ta">${Math.round(best.tA)}′</b>` : `<b class="ta">${Math.round(best.tA)}′</b>/<b class="tb">${Math.round(best.tB)}′</b>`}</span>`
        : '') +
      `<button class="sl-remove" title="remove">✕</button>`;
    li.querySelector<HTMLButtonElement>('.sl-remove')!.onclick = (e) => {
      e.stopPropagation();
      toggleFav(state.A.pt, state.B.pt, v.id);
      renderVenues();
    };
    li.onclick = () => {
      map.setView([v.lat, v.lng], Math.max(map.getZoom(), 14));
      if (s) showDetail(v, effectiveCombos(v, s.combos).combos);
    };
    list.appendChild(li);
  }
}


// ── Mobile layout: full-screen map + bottom sheet ───────────
// Patterns per Material 3 / Apple HIG / Google-Maps-style sheets: translateY
// snaps (peek/half/full), one scrollable chip strip, plan pill that expands
// to the address editor, locate FAB, no zoom buttons on touch.
type SheetPos = 'peek' | 'half' | 'full';
let sheetTo: (pos: SheetPos, animate?: boolean) => void = () => {};
let planEditorOpen: (open: boolean) => void = () => {};
let updatePlanBar: () => void = () => {};

function buildMobileLayout(): void {
  document.body.classList.add('m');
  const rail = document.getElementById('rail')!;

  const mtop = document.createElement('div');
  mtop.id = 'mtop';
  mtop.innerHTML =
    '<div class="mtop-row">' +
    '<button id="plan-bar"><span class="pb-brand">\u{1F33F}</span><span id="plan-sum"></span><span class="pb-caret">\u25BE</span></button>' +
    '</div>' +
    '<div id="mchips"></div>';
  document.body.appendChild(mtop);
  mtop.querySelector('.mtop-row')!.appendChild(document.getElementById('about-btn')!);
  const chips = document.getElementById('mchips')!;
  const findPanel = document.getElementById('diet-filters')!.closest('.panel') as HTMLElement;
  chips.appendChild(document.getElementById('diet-filters')!);
  chips.appendChild(document.getElementById('cat-filters')!);
  chips.appendChild(document.getElementById('emoji-legend')!);
  findPanel.style.display = 'none'; // emptied — its filters live in the strip now

  const editor = document.createElement('div');
  editor.id = 'plan-editor';
  editor.hidden = true;
  editor.appendChild(document.querySelector('.person[data-person="A"]')!);
  editor.appendChild(document.querySelector('.person[data-person="B"]')!);
  editor.appendChild(document.getElementById('tuning-panel')!);
  const done = document.createElement('button');
  done.id = 'plan-done';
  done.textContent = 'Show results';
  editor.appendChild(done);
  document.body.appendChild(editor);

  const handle = document.createElement('div');
  handle.id = 'sheet-handle';
  handle.innerHTML = '<div class="grip"></div>';
  rail.prepend(handle);
  rail.insertBefore(document.getElementById('detail')!, handle.nextSibling);
  // Shortlist tucks under the list header so peek always leads with the count.
  rail.querySelector('.venues-panel')!.insertBefore(document.getElementById('shortlist')!, document.getElementById('sort-chips'));
  // Submit-a-spot rides above the list — below it, the half-height sheet never scrolls far enough to tap it.
  rail.querySelector('.venues-panel')!.insertBefore(document.getElementById('add-spot')!, document.getElementById('venues'));

  const fab = document.createElement('button');
  fab.id = 'locate-fab';
  fab.title = 'Use my location';
  fab.textContent = '\u{1F4CD}';
  fab.onclick = () => locateMe(); // wrapper: onclick would pass the event as onlyIfIdle
  document.body.appendChild(fab);

  // Solo-only invitation to go duo — opens the editor on Person B.
  const bInvite = document.createElement('button');
  bInvite.id = 'b-invite';
  bInvite.innerHTML = '\u{1F465} Meeting someone? <b>Add their spot</b>';
  bInvite.onclick = () => {
    planEditorOpen(true);
    (document.getElementById('addr-b') as HTMLInputElement).focus();
  };
  mtop.appendChild(bInvite);

  map.attributionControl.setPosition('topright');
  window.setTimeout(() => map.invalidateSize(), 60);

  // Safe-area inset, readable only through a probe element.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  const safeBottom = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();

  const offsets = (): Record<SheetPos, number> => ({
    full: mtop.offsetHeight + 8,
    half: Math.round(window.innerHeight * 0.5),
    peek: window.innerHeight - (100 + safeBottom),
  });

  let pos: SheetPos = 'peek';
  sheetTo = (p: SheetPos, animate = true) => {
    pos = p;
    rail.classList.toggle('snap', animate);
    rail.classList.toggle('at-full', p === 'full');
    const off = offsets()[p];
    rail.style.transform = `translateY(${off}px)`;
    // The rail hangs `off` px below the viewport — pad the bottom to match so
    // the last rows can scroll into view (read by the CSS padding-bottom).
    rail.style.setProperty('--sheet-off', `${off}px`);
    if (p === 'peek') rail.scrollTop = 0; // peek always leads with the header
    fab.classList.toggle('gone', p !== 'peek');
  };

  // Drag: 1:1 follow on the handle + list header, velocity-aware snap.
  let y0 = 0;
  let o0 = 0;
  let lastY = 0;
  let lastT = 0;
  let vel = 0;
  let moved = false;
  let dragging = false;
  const dragStart = (e: PointerEvent) => {
    if (!e.isPrimary) return; // a second finger must not re-base the drag
    dragging = true;
    moved = false;
    vel = 0; // stale fling velocity would replay on a plain tap in dragEnd
    y0 = e.clientY;
    // Read the LIVE transform, not the snap target — grabbing mid-animation
    // teleported the sheet to where the animation was headed.
    const m = new DOMMatrixReadOnly(getComputedStyle(rail).transform);
    o0 = m.m42 || offsets()[pos];
    lastY = e.clientY;
    lastT = e.timeStamp;
    rail.classList.remove('snap');
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const dragMove = (e: PointerEvent) => {
    if (!dragging || !e.isPrimary) return;
    if (Math.abs(e.clientY - y0) > 6) moved = true;
    const off = offsets();
    const next = Math.min(off.peek, Math.max(off.full, o0 + (e.clientY - y0)));
    rail.style.transform = `translateY(${next}px)`;
    const dt = e.timeStamp - lastT;
    if (dt > 0) vel = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = e.timeStamp;
  };
  const dragEnd = (e: PointerEvent) => {
    if (!dragging || !e.isPrimary) return;
    dragging = false;
    const off = offsets();
    const cur = o0 + (e.clientY - y0);
    let target: SheetPos;
    if (Math.abs(vel) > 0.5) {
      target = vel > 0 ? (pos === 'full' ? 'half' : 'peek') : pos === 'peek' ? 'half' : 'full';
    } else {
      target = (Object.keys(off) as SheetPos[]).reduce((a, b) =>
        Math.abs(off[a] - cur) < Math.abs(off[b] - cur) ? a : b,
      );
    }
    sheetTo(target);
  };
  for (const surf of [handle, document.getElementById('venues-head')!]) {
    surf.addEventListener('pointerdown', dragStart);
    surf.addEventListener('pointermove', dragMove);
    surf.addEventListener('pointerup', dragEnd);
    surf.addEventListener('pointercancel', dragEnd);
  }
  handle.onclick = () => {
    // A drag's trailing click must not double-jump the snap; distance beats
    // velocity as the tap test (vel is noisy on slow drags).
    if (!moved) sheetTo(pos === 'peek' ? 'half' : pos === 'half' ? 'full' : 'peek');
  };

  planEditorOpen = (open: boolean) => {
    editor.hidden = !open;
    mtop.classList.toggle('editing', open);
    if (open) sheetTo('peek');
  };
  (document.getElementById('plan-bar') as HTMLButtonElement).onclick = () => planEditorOpen(editor.hidden);
  done.onclick = () => planEditorOpen(false);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !editor.hidden) planEditorOpen(false);
  });
  map.on('click', () => {
    planEditorOpen(false);
    if (!detailEl.hidden) {
      closeDetail();
      sheetTo('peek');
    }
  });

  updatePlanBar = () => {
    const sum = document.getElementById('plan-sum')!;
    const va = (document.getElementById('addr-a') as HTMLInputElement).value.trim();
    const vb = (document.getElementById('addr-b') as HTMLInputElement).value.trim();
    const mode = MODE_LABEL[[...state.A.modes][0]].toLowerCase();
    sum.textContent = state.solo
      ? `${va || 'Set your location'} \u00b7 ${mode}`
      : `${personLabel('A')}: ${va || 'set address'} \u2194 ${personLabel('B')}: ${vb || 'set address'}`;
    bInvite.hidden = !state.solo;
  };

  // Track viewport changes (URL-bar collapse, keyboard) instantly — animating
  // these made the sheet visibly slide around on its own mid-scroll.
  window.addEventListener('resize', () => sheetTo(pos, false));
  sheetTo('half', false); // first placement: don't animate from the CSS 50vh placeholder
  updatePlanBar();
}

// ── Solo mode: "what's vegan near me" — A only, B joins later ─
function soloUi(on: boolean): void {
  (document.querySelector('#tuning-panel .bias') as HTMLElement).hidden = on;
  (document.getElementById('layers-panel') as HTMLElement).hidden = on;
  (document.getElementById('swap-ab') as HTMLElement).hidden = on;
  (document.getElementById('modes-b') as HTMLElement).hidden = on;
  (document.getElementById('sort-chips') as HTMLElement).hidden = on;
  (document.getElementById('addr-b') as HTMLInputElement).placeholder = on
    ? 'Add a friend to meet in the middle…'
    : 'Person B address…';
  (document.getElementById('addr-a') as HTMLInputElement).placeholder = on
    ? '📍 Your location or an address…'
    : 'Person A address…';
}

function enterSolo(pt: Pt, label: string, forceWalk: boolean): void {
  state.solo = true;
  state.A.pt = pt;
  state.B.pt = pt;
  if (forceWalk) {
    state.A.modes = new Set(['walk']);
    state.B.modes = new Set(['walk']);
  }
  (document.getElementById('addr-a') as HTMLInputElement).value = label;
  (document.getElementById('addr-b') as HTMLInputElement).value = '';
  clearPersonFields('A');
  clearPersonFields('B');
  exactCache.A.clear();
  exactCache.B.clear();
  markers.A.setLatLng(pt);
  map.removeLayer(markers.B);
  soloUi(true);
  renderModes('A');
  closeDetail();
  map.setView(pt, 15);
  if (IS_MOBILE) sheetTo('peek'); // nearby-first: the map and its glow lead
  coverageWarning('A');
  scheduleRecompute();
}

function exitSolo(): void {
  state.solo = false;
  markers.B.addTo(map);
  soloUi(false);
  renderModes('B');
}

function locateMe(onlyIfIdle = false): void {
  if (!('geolocation' in navigator)) {
    setStatus('Your browser has no location access — type an address instead', 4000);
    return;
  }
  setStatus('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // Boot-time locate resolves seconds in — don't yank a session in progress.
      if (onlyIfIdle && userInteracted) return;
      enterSolo({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 'My location 📍', true);
    },
    () => {
      setStatus('Couldn\u2019t get your location — type an address instead', 4000);
      (document.getElementById('addr-a') as HTMLInputElement).focus();
    },
    { timeout: 8000, maximumAge: 60000 },
  );
}

// ── Intro / about ────────────────────────────────────────────
const introEl = document.getElementById('intro')!;
const INTRO_SEEN = 'w2m:intro';

function hideIntro(): void {
  introEl.hidden = true;
  localStorage.setItem(INTRO_SEEN, '1');
}
document.getElementById('about-btn')!.onclick = () => {
  introEl.hidden = false;
};
document.getElementById('intro-x')!.onclick = hideIntro;
document.getElementById('intro-go')!.onclick = () => {
  // "Plan a meetup" → stay in solo but point them at Person B; typing an
  // address there flips to the duo fair-zone view (applyLocation → exitSolo).
  hideIntro();
  planEditorOpen(true); // no-op on desktop; opens the sheet editor on mobile
  (document.getElementById('addr-b') as HTMLInputElement).focus();
};
document.getElementById('intro-near')!.onclick = () => {
  hideIntro();
  locateMe();
};
introEl.onclick = (e) => {
  if (e.target === introEl) hideIntro();
};
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !introEl.hidden) hideIntro();
});
// First visit only — and never over a shared plan someone sent you.
if (!localStorage.getItem(INTRO_SEEN) && !shared.a && !shared.b) introEl.hidden = false;

// ── Submit a missing spot ────────────────────────────────────
function saveSubmitted(list: Venue[]): void {
  localStorage.setItem(SUBMIT_KEY, JSON.stringify(list));
}

function buildSubmitUi(): void {
  const modal = document.getElementById('submit-modal')!;
  const nameEl = document.getElementById('sub-name') as HTMLInputElement;
  const locEl = document.getElementById('sub-loc') as HTMLInputElement;
  const msgEl = document.getElementById('sub-msg')!;
  const goEl = document.getElementById('sub-go') as HTMLButtonElement;
  const formEl = document.getElementById('sub-form')!;
  const doneEl = document.getElementById('sub-done')!;
  let vegan: 1 | 2 = 2;
  let cat: Venue['cat'] = 'restaurant';

  const seg = (id: string, pick: (val: string) => void) => {
    const box = document.getElementById(id)!;
    box.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        box.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        pick(b.dataset.val!);
      }),
    );
  };
  seg('sub-vegan', (v) => (vegan = v === '1' ? 1 : 2));
  seg('sub-cat', (c) => (cat = c as Venue['cat']));

  const msg = (t: string) => {
    msgEl.textContent = t;
    msgEl.hidden = !t;
  };
  const open = () => {
    formEl.hidden = false;
    doneEl.hidden = true;
    msg('');
    modal.hidden = false;
    nameEl.focus();
  };
  const close = () => {
    modal.hidden = true;
  };
  document.getElementById('add-spot')!.onclick = open;
  document.getElementById('submit-x')!.onclick = close;
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };

  goEl.onclick = async () => {
    const name = nameEl.value.trim();
    const locRaw = locEl.value.trim();
    if (!name) return msg('What’s the spot called?');
    if (!locRaw) return msg('Add its address or paste a Google Maps link.');

    let pt = parseMapLink(locRaw);
    let addr = pt ? '' : locRaw;
    if (!pt) {
      goEl.disabled = true;
      goEl.textContent = 'Checking…';
      const hit = await geocode(locRaw);
      goEl.disabled = false;
      goEl.textContent = 'Check & add';
      if (!hit) return msg('Couldn’t find that address — add the borough, or paste a Google Maps link.');
      pt = hit.pt;
      addr = hit.label;
    }

    const res = validateSubmission({ name, pt, vegan, cat, addr }, VENUES);
    if (!res.ok) return msg(res.reason);

    // Passed the checks → into the mix (live + persisted on this device).
    VENUES.push(res.venue);
    VENUE_BY_ID.set(res.venue.id, res.venue);
    const stored = loadSubmitted();
    stored.push(res.venue);
    saveSubmitted(stored);

    // Make sure it can actually show: enable its diet class + category, clear
    // any narrowing emoji filter, then recompute and fly to it.
    state.cats.add(res.venue.cat);
    if (res.venue.vegan === 2) state.veganOnly = true;
    else state.veganFriendly = true;
    state.emojiFilter.clear();
    state.glutenFree = false; // submitted spots carry no gf tag; GF would hide them
    renderCatFilters();
    renderDietFilters();
    scheduleRecompute(true);
    map.setView([res.venue.lat, res.venue.lng], 15);

    // Success panel + a one-tap way to get it added for everyone.
    const payload = JSON.stringify({ name: res.venue.name, lat: res.venue.lat, lng: res.venue.lng, vegan, cat, addr }, null, 2);
    const mail =
      `mailto:hi@vonwong.com?subject=${encodeURIComponent('Thyme & Place — new vegan spot')}` +
      `&body=${encodeURIComponent(`Please add this spot for everyone:\n\n${res.venue.name}\n${addr}\n\n${payload}`)}`;
    (document.getElementById('sub-mail') as HTMLAnchorElement).href = mail;
    (document.getElementById('sub-done-name') as HTMLElement).textContent = res.venue.name;
    formEl.hidden = true;
    doneEl.hidden = false;
    nameEl.value = '';
    locEl.value = '';
  };

  document.getElementById('sub-close')!.onclick = close;
}

// ── Boot ─────────────────────────────────────────────────────
buildSubmitUi();
renderModes('A');
renderModes('B');
renderDayparts();
wireBias();
renderCatFilters();
renderDietFilters();
renderSortChips();
wireInput('A');
wireInput('B');

// Restore shared-link UI state (labels, dial position).
if (shared.labelA) (document.getElementById('addr-a') as HTMLInputElement).value = shared.labelA;
if (shared.labelB) (document.getElementById('addr-b') as HTMLInputElement).value = shared.labelB;
{
  const slider = document.getElementById('bias') as HTMLInputElement;
  slider.value = String(state.bias);
  updateBiasLabel();
}

if (IS_MOBILE) buildMobileLayout();
if (shared.solo && shared.a) {
  enterSolo(shared.a, shared.labelA ?? 'Shared location 📍', false);
} else if (!shared.a && !shared.b) {
  // First view (desktop + mobile) = what's nearby: solo at the default pin so
  // Person A is never an empty prompt. Recenter on the real location — the
  // intro CTA is the first-visit gesture, returning visitors get the browser
  // prompt / a prior grant.
  enterSolo(state.A.pt, '', true);
  if (localStorage.getItem('w2m:intro')) locateMe(true);
}

function applyNames(): void {
  const ba = document.getElementById('bullet-a')!;
  const bb = document.getElementById('bullet-b')!;
  ba.textContent = personInitial('A');
  bb.textContent = personInitial('B');
  ba.title = state.nameA ? `${state.nameA} — click to rename` : 'Click to add a name';
  bb.title = state.nameB ? `${state.nameB} — click to rename` : 'Click to add a name';
  markers.A.setIcon(bulletIcon('A'));
  markers.B.setIcon(bulletIcon('B'));
  document.querySelector('.adv-labels .adv-a')!.textContent = `${personLabel('A')} sooner`;
  document.querySelector('.adv-labels .adv-b')!.textContent = `${personLabel('B')} sooner`;
  updateBiasLabel();
  renderSortChips();
}

for (const who of ['A', 'B'] as const) {
  const input = document.getElementById(`name-${who.toLowerCase()}`) as HTMLInputElement;
  const bullet = document.getElementById(`bullet-${who.toLowerCase()}`)!;
  input.value = who === 'A' ? state.nameA : state.nameB;
  // Click the bullet to name the person; Enter/blur commits and restores it.
  bullet.addEventListener('click', () => {
    input.classList.add('editing');
    input.focus();
    input.select();
  });
  input.addEventListener('blur', () => input.classList.remove('editing'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') input.blur();
  });
  input.addEventListener('input', () => {
    if (who === 'A') state.nameA = input.value.trim().slice(0, 16);
    else state.nameB = input.value.trim().slice(0, 16);
    applyNames();
    syncUrl();
  });
}
applyNames();

document.getElementById('swap-ab')!.onclick = swapPersons;

// Shortlist collapses to a badge on phones so it doesn't bury the map.
{
  const panel = document.getElementById('shortlist')!;
  if (window.matchMedia('(max-width: 760px)').matches) panel.classList.add('collapsed');
  panel.querySelector('h3')!.addEventListener('click', () => panel.classList.toggle('collapsed'));
}

document.getElementById('share-link')!.onclick = async () => {
  syncUrl();
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus('Link copied — send it! 💌', 2400);
  } catch {
    setStatus('Copy blocked — grab the link from the address bar', 2800);
  }
};

scheduleRecompute();
