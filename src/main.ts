import L from 'leaflet';
import './style.css';
import venuesData from './data/venues.json';
import subwayData from './data/subway.json';
import { NYC_GRID } from './lib/geo';
import { buildGraph, transitPath, type TransitGraph } from './lib/transit';
import { timeField, comboLayer, minPersonField, scoreAtPoint, fairnessScore } from './lib/fairness';
import { buildContours } from './lib/contours';
import { renderGlow } from './lib/heat';
import { filterVenues } from './lib/venues';
import { geocode, makeSuggester, type GeoHit } from './lib/geocode';
import { routedMinutes, routedField, routedGeometry } from './lib/osrm';
import { venueEmoji } from './lib/emoji';
import { loadFavs, toggleFav, seedFavs } from './lib/favs';
import { encodeShare, parseShare } from './lib/share';
import type { Pt, Mode, Venue, ComboLayer, TimeField, SubwayData, Daypart } from './lib/types';

// ── Static data ──────────────────────────────────────────────
const VENUES = (venuesData as { venues: Venue[] }).venues;
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
  A: { pt: { lat: 40.7143, lng: -73.9614 }, modes: new Set<Mode>(['transit', 'bike']) } as Person,
  B: { pt: { lat: 40.787, lng: -73.9754 }, modes: new Set<Mode>(['transit', 'car']) } as Person,
  layerOff: new Set<string>(), // combo keys the user toggled off
  cats: new Set<Venue['cat']>(['restaurant', 'cafe', 'activity']),
  veganOnly: false,
  veganFriendly: true,
  teaHouse: true,
  bubbleTea: false,
  daypart: 'midday' as Daypart,
  tolerance: 15, // max acceptable minutes of deviation between the two travel times
  sortBy: 'best' as SortBy,
};

// Hydrate from a shared link — the URL hash IS the plan.
const shared = parseShare(location.hash);
if (shared.a) state.A.pt = shared.a;
if (shared.b) state.B.pt = shared.b;
if (shared.modesA) state.A.modes = new Set(shared.modesA);
if (shared.modesB) state.B.modes = new Set(shared.modesB);
if (shared.tolerance != null) state.tolerance = shared.tolerance;
if (shared.daypart) state.daypart = shared.daypart;
if (shared.favs?.length) seedFavs(state.A.pt, state.B.pt, shared.favs);

function syncUrl(): void {
  const hash = encodeShare({
    a: state.A.pt,
    b: state.B.pt,
    labelA: (document.getElementById('addr-a') as HTMLInputElement).value || undefined,
    labelB: (document.getElementById('addr-b') as HTMLInputElement).value || undefined,
    modesA: [...state.A.modes],
    modesB: [...state.B.modes],
    tolerance: state.tolerance,
    daypart: state.daypart,
    favs: [...loadFavs(state.A.pt, state.B.pt)],
  });
  history.replaceState(null, '', hash);
}

const fieldCache = new Map<string, TimeField>();
// Street modes upgrade from model estimates to real OSRM-routed fields, async.
const fieldUpgrades = new Map<string, 'pending' | 'done'>();

function getField(who: 'A' | 'B', mode: Mode): TimeField {
  // Transit fields depend on the daypart (headway-based waits).
  const key = mode === 'transit' ? `${who}:transit:${state.daypart}` : `${who}:${mode}`;
  let f = fieldCache.get(key);
  if (!f) {
    f = timeField(getGraph(state.daypart), state[who].pt, mode, GRID);
    fieldCache.set(key, f);
  }
  if (mode !== 'transit' && !fieldUpgrades.has(key)) upgradeField(who, mode, key);
  return f;
}

function upgradeField(who: 'A' | 'B', mode: Mode, key: string): void {
  fieldUpgrades.set(key, 'pending');
  const pt = state[who].pt;
  void routedField(pt, mode, GRID).then((f) => {
    if (state[who].pt !== pt) return; // pin moved while routing — stale
    if (!f) {
      fieldUpgrades.delete(key); // local server unreachable; retry on next recompute
      return;
    }
    fieldCache.set(key, f);
    fieldUpgrades.set(key, 'done');
    scheduleRecompute();
  });
}

function clearPersonFields(who: 'A' | 'B'): void {
  for (const key of [...fieldCache.keys()]) if (key.startsWith(`${who}:`)) fieldCache.delete(key);
  for (const key of [...fieldUpgrades.keys()]) if (key.startsWith(`${who}:`)) fieldUpgrades.delete(key);
}

const comboKey = (a: Mode, b: Mode) => `${a}|${b}`;

function activeCombos(): { a: Mode; b: Mode; key: string; on: boolean }[] {
  const out: { a: Mode; b: Mode; key: string; on: boolean }[] = [];
  for (const m of MODES) {
    if (!state.A.modes.has(m.id)) continue;
    for (const n of MODES) {
      if (!state.B.modes.has(n.id)) continue;
      const key = comboKey(m.id, n.id);
      out.push({ a: m.id, b: n.id, key, on: !state.layerOff.has(key) });
    }
  }
  return out;
}

// ── Map ──────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: false }).setView([40.745, -73.96], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution: '© OpenStreetMap contributors © CARTO',
  maxZoom: 19,
}).addTo(map);

const contourLayer = L.layerGroup().addTo(map);
const venueLayer = L.layerGroup().addTo(map);

function bulletIcon(who: 'A' | 'B'): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="marker-bullet ${who.toLowerCase()}">${who}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function makePersonMarker(who: 'A' | 'B'): L.Marker {
  const marker = L.marker(state[who].pt, { icon: bulletIcon(who), draggable: true }).addTo(map);
  marker.on('dragend', () => {
    const ll = marker.getLatLng();
    state[who].pt = { lat: ll.lat, lng: ll.lng };
    clearPersonFields(who);
    exactCache[who].clear();
    (document.getElementById(`addr-${who.toLowerCase()}`) as HTMLInputElement).value = '';
    scheduleRecompute();
  });
  return marker;
}

const markers = { A: makePersonMarker('A'), B: makePersonMarker('B') };

// ── UI: mode pills ───────────────────────────────────────────
function renderModes(who: 'A' | 'B'): void {
  const el = document.getElementById(`modes-${who.toLowerCase()}`)!;
  el.innerHTML = '';
  for (const m of MODES) {
    const btn = document.createElement('button');
    btn.className = 'mode-pill' + (state[who].modes.has(m.id) ? ' on' : '');
    btn.textContent = m.label;
    btn.onclick = () => {
      const set = state[who].modes;
      if (set.has(m.id)) {
        if (set.size === 1) return; // keep at least one mode
        set.delete(m.id);
      } else {
        set.add(m.id);
      }
      renderModes(who);
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
        return -fairnessScore(c.tA, c.tB, state.tolerance); // lower = better
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
    chip.textContent = s.label;
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
      renderDayparts();
      scheduleRecompute();
    };
    el.appendChild(chip);
  }
}

function wireTolerance(): void {
  const slider = document.getElementById('bias') as HTMLInputElement;
  const val = document.getElementById('bias-val')!;
  slider.addEventListener('input', () => {
    state.tolerance = +slider.value;
    val.textContent = state.tolerance === 0 ? 'EQUAL TIMES' : `±${state.tolerance}′`;
    scheduleRecompute();
  });
}

// ── UI: layer legend ─────────────────────────────────────────
function renderLayers(): void {
  const el = document.getElementById('layers')!;
  el.innerHTML = '';
  for (const c of activeCombos()) {
    const row = document.createElement('div');
    row.className = 'layer-row' + (c.on ? '' : ' off');
    row.innerHTML =
      `<span class="sw"></span>` +
      `<span class="bullet bullet-a mini">A</span><span class="lbl">${MODE_LABEL[c.a]}</span>` +
      `<span class="lbl">×</span>` +
      `<span class="bullet bullet-b mini">B</span><span class="lbl">${MODE_LABEL[c.b]}</span>`;
    row.onclick = () => {
      if (state.layerOff.has(c.key)) state.layerOff.delete(c.key);
      else state.layerOff.add(c.key);
      scheduleRecompute();
    };
    el.appendChild(row);
  }
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
function applyLocation(who: 'A' | 'B', hit: GeoHit, input: HTMLInputElement): void {
  input.value = hit.label;
  input.classList.remove('bad');
  state[who].pt = hit.pt;
  clearPersonFields(who);
  exactCache[who].clear();
  markers[who].setLatLng(hit.pt);
  map.panTo(hit.pt);
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
      row.onmousedown = (e) => {
        e.preventDefault(); // beat the blur
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

function scheduleRecompute(venuesOnly = false): void {
  window.clearTimeout(pending);
  setStatus('Computing fair zones…');
  pending = window.setTimeout(() => recompute(venuesOnly), 30);
}

let lastLayers: ComboLayer[] = [];

function recompute(venuesOnly: boolean): void {
  renderLayers();
  if (!venuesOnly || lastLayers.length === 0) {
    const combos = activeCombos().filter((c) => c.on);
    lastLayers = combos.map((c) => comboLayer(c.a, c.b, getField('A', c.a), getField('B', c.b), state.tolerance));
    drawContours();
  }
  renderVenues();
  setStatus('Ready', 900);
}

// ── Radial glow + 5-minute rings ─────────────────────────────
// A warm bloom marks the optimum (hue leans toward whoever is closer);
// concentric rings step outward in 5-minute increments of combined time,
// vivid at the core and cooling/fading with distance.
const GLOW_BOUNDS = L.latLngBounds([GRID.latMin, GRID.lngMin], [GRID.latMax, GRID.lngMax]);
let glowOverlay: L.ImageOverlay | null = null;

const RING_COLORS = ['#e0403a', '#e8652e', '#eb9035', '#daa74d', '#c2a76d', '#a89f85', '#93948e', '#7f8b96'];

function drawContours(): void {
  contourLayer.clearLayers();
  if (lastLayers.length === 0) return;
  const minA = minPersonField(lastLayers, 'A', CELLS);
  const minB = minPersonField(lastLayers, 'B', CELLS);
  const total = new Float32Array(CELLS);
  const gap = new Float32Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    total[i] = minA[i] + minB[i];
    gap[i] = minA[i] - minB[i];
  }

  const url = renderGlow(total, gap, GRID).toDataURL();
  if (glowOverlay) glowOverlay.setUrl(url);
  else {
    glowOverlay = L.imageOverlay(url, GLOW_BOUNDS, {
      opacity: 0.8,
      className: 'glow-img',
      interactive: false,
    }).addTo(map);
  }

  const sets = buildContours(total, gap, GRID);
  const n = sets.length;
  for (const set of sets) {
    const f = 1 - set.rank / Math.max(n - 1, 1); // 1 = innermost
    const color = RING_COLORS[Math.min(set.rank, RING_COLORS.length - 1)];
    const segments = set.batches.flatMap((b) => b.segments) as unknown as L.LatLngExpression[][];
    if (!segments.length) continue;
    // halo pass (the glow around each ring), then crisp core
    L.polyline(segments, {
      color,
      weight: 7 + 4 * f,
      opacity: 0.07 + 0.1 * f,
      interactive: false,
      lineCap: 'round',
    }).addTo(contourLayer);
    L.polyline(segments, {
      color,
      weight: 1.1 + 1.7 * f,
      opacity: 0.35 + 0.55 * f,
      interactive: false,
      lineCap: 'round',
    }).addTo(contourLayer);
    // Minute labels on the four inner rings.
    if (set.rank < 4) {
      const all = set.batches.flatMap((b) => b.segments);
      const seg = all[Math.floor(all.length / 2)];
      if (seg) {
        L.marker([(seg[0].lat + seg[1].lat) / 2, (seg[0].lng + seg[1].lng) / 2], {
          icon: L.divIcon({
            className: '',
            html: `<div class="ring-label" style="color:${color}">${Math.round(set.level)}′</div>`,
            iconSize: [40, 16],
            iconAnchor: [20, 8],
          }),
          interactive: false,
        }).addTo(contourLayer);
      }
    }
  }
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

async function personRoute(who: 'A' | 'B', mode: Mode, v: Venue): Promise<Pt[]> {
  const origin = state[who].pt;
  const dest = { lat: v.lat, lng: v.lng };
  if (mode === 'transit') return transitPath(getGraph(state.daypart), origin, dest);
  return (await routedGeometry(origin, dest, mode)) ?? [origin, dest];
}

async function drawRoutes(v: Venue, modeA: Mode, modeB: Mode): Promise<void> {
  const token = ++routeToken;
  const [pathA, pathB] = await Promise.all([personRoute('A', modeA, v), personRoute('B', modeB, v)]);
  if (token !== routeToken) return; // another venue selected meanwhile
  routeLayer.clearLayers();
  const style = (color: string, mode: Mode) => ({
    color,
    weight: 4,
    opacity: 0.85,
    dashArray: mode === 'transit' ? '2 8' : undefined, // transit = schematic station hops
    lineCap: 'round' as const,
  });
  const a = L.polyline(pathA, style('#6d3fd4', modeA)).addTo(routeLayer);
  const b = L.polyline(pathB, style('#d63c44', modeB)).addTo(routeLayer);
  map.fitBounds(a.getBounds().extend(b.getBounds()), {
    paddingTopLeft: [40, 40],
    paddingBottomRight: [40, 220],
    maxZoom: 14,
  });
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
    .map(
      (c) =>
        `<tr><td><span class="ca">A · ${MODE_LABEL[c.modeA]}</span></td><td>${Math.round(c.tA)}′</td>` +
        `<td><span class="cb">B · ${MODE_LABEL[c.modeB]}</span></td><td>${Math.round(c.tB)}′</td>` +
        `<td class="gap">Δ${Math.round(Math.abs(c.tA - c.tB))}′</td></tr>`,
    )
    .join('');
  const meta = metaLine(v);
  const isFav = loadFavs(state.A.pt, state.B.pt).has(v.id);
  detailEl.innerHTML =
    `<button class="detail-close" aria-label="Close">✕</button>` +
    `<button class="fav-btn detail-fav${isFav ? ' on' : ''}" title="favorite for this pair">♥</button>` +
    (v.img ? `<img class="detail-img" src="${esc(v.img)}" alt="" onerror="this.remove()" />` : '') +
    `<div class="detail-body">` +
    `<h3>${venueEmoji(v)} ${esc(v.name)}</h3>` +
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
  detailEl.querySelector<HTMLButtonElement>('.detail-close')!.onclick = closeDetail;
  detailEl.querySelector<HTMLButtonElement>('.detail-fav')!.onclick = () => {
    toggleFav(state.A.pt, state.B.pt, v.id);
    renderVenues();
    showDetail(v, combos);
  };
}

// Warm ramp for venue dot fills on the light map: sand → orange → crimson.
function heatColor(t: number): string {
  if (t > 0.8) return '#d63c44';
  if (t > 0.6) return '#e07b2a';
  if (t > 0.4) return '#dbb13b';
  return '#b3ac96';
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
  for (const who of ['A', 'B'] as const) {
    for (const mode of state[who].modes) {
      if (mode === 'transit') continue; // GTFS engine is the authority there
      const missing = venues.filter((v) => !exactCache[who].has(`${mode}:${v.id}`));
      if (!missing.length) continue;
      jobs.push(
        routedMinutes(state[who].pt, missing, mode).then((mins) => {
          if (!mins) return;
          missing.forEach((v, i) => exactCache[who].set(`${mode}:${v.id}`, mins[i]));
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

  const filtered = filterVenues(VENUES, {
    categories: state.cats,
    veganOnly: state.veganOnly,
    veganFriendly: state.veganFriendly,
    teaHouse: state.teaHouse,
    bubbleTea: state.bubbleTea,
  });

  // Shortlist by model score with margin, then rank by the SAME times the rows
  // display (street-routed where available) so rank and readout never disagree.
  const candidates = filtered
    .map((v) => ({ v, s: scoreAtPoint(GRID, lastLayers, v) }))
    .filter((x): x is { v: Venue; s: NonNullable<ReturnType<typeof scoreAtPoint>> } => x.s !== null && x.s.score > 0.001)
    .sort((a, b) => b.s.score - a.s.score)
    .slice(0, 60);

  const scored = candidates
    .map(({ v, s }) => {
      const eff = effectiveCombos(v, s.combos);
      const finalScore = eff.combos.reduce((m, c) => Math.max(m, fairnessScore(c.tA, c.tB, state.tolerance)), 0);
      const best = pickCombo(eff.combos, state.sortBy);
      return { v, s, eff, finalScore, best };
    })
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

  headEl.textContent = `Best spots · ${scored.length}`;

  if (!scored.length) {
    listEl.innerHTML = '<li class="empty">No venues in the fair zone — widen filters or move a pin.</li>';
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
    pin.bindTooltip(tipHtml(v), { direction: 'top', offset: [0, -12], className: 'venue-tip' });
    pin.on('click', () => showDetail(v, effectiveCombos(v, s.combos).combos));

    const li = document.createElement('li');
    if (isFav) li.className = 'faved';
    const meta = metaLine(v);
    li.innerHTML =
      `<span class="v-name">${venueEmoji(v)} ${esc(v.name)}</span>` +
      `<span class="v-side"><button class="fav-btn${isFav ? ' on' : ''}" title="favorite for this pair">♥</button>` +
      `<span class="v-times">${refined ? '<span class="routed" title="street-routed times">⚡</span>' : ''}<b class="ta">${Math.round(best.tA)}′</b>/<b class="tb">${Math.round(best.tB)}′</b></span></span>` +
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
  renderShortlist(favs);
  syncUrl();
}

// ── Shortlist panel (the shareable picks list) ───────────────
function renderShortlist(favs: Set<string>): void {
  const panel = document.getElementById('shortlist')!;
  const list = document.getElementById('shortlist-items')!;
  const items = [...favs].map((id) => VENUE_BY_ID.get(id)).filter((v): v is Venue => !!v);
  panel.hidden = items.length === 0;
  list.innerHTML = '';
  for (const v of items) {
    const s = scoreAtPoint(GRID, lastLayers, v);
    const combos = s ? effectiveCombos(v, s.combos).combos : [];
    const best = combos.length ? pickCombo(combos, state.sortBy) : null;
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="sl-name">${venueEmoji(v)} ${esc(v.name)}</span>` +
      (best
        ? `<span class="sl-times"><b class="ta">${Math.round(best.tA)}′</b>/<b class="tb">${Math.round(best.tB)}′</b></span>`
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

// ── Boot ─────────────────────────────────────────────────────
renderModes('A');
renderModes('B');
renderDayparts();
wireTolerance();
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
  slider.value = String(state.tolerance);
  document.getElementById('bias-val')!.textContent = state.tolerance === 0 ? 'EQUAL TIMES' : `±${state.tolerance}′`;
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
