import L from 'leaflet';
import './style.css';
import venuesData from './data/venues.json';
import subwayData from './data/subway.json';
import { NYC_GRID } from './lib/geo';
import { buildGraph, type TransitGraph } from './lib/transit';
import { timeField, comboLayer, maxLayers, minPersonField, scoreAtPoint, fairnessScore } from './lib/fairness';
import { renderHeat } from './lib/heat';
import { filterVenues } from './lib/venues';
import { geocode, makeSuggester, type GeoHit } from './lib/geocode';
import { routedMinutes } from './lib/osrm';
import type { Pt, Mode, Venue, ComboLayer, TimeField, SubwayData, Daypart } from './lib/types';

// ── Static data ──────────────────────────────────────────────
const VENUES = (venuesData as { venues: Venue[] }).venues;
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
  tea: true,
  daypart: 'midday' as Daypart,
  bias: 0, // minutes; negative skews toward A, positive toward B
};

const fieldCache = new Map<string, TimeField>();

function getField(who: 'A' | 'B', mode: Mode): TimeField {
  // Transit fields depend on the daypart (headway-based waits).
  const key = mode === 'transit' ? `${who}:transit:${state.daypart}` : `${who}:${mode}`;
  let f = fieldCache.get(key);
  if (!f) {
    f = timeField(getGraph(state.daypart), state[who].pt, mode, GRID);
    fieldCache.set(key, f);
  }
  return f;
}

function clearPersonFields(who: 'A' | 'B'): void {
  for (const key of [...fieldCache.keys()]) if (key.startsWith(`${who}:`)) fieldCache.delete(key);
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
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OpenStreetMap contributors © CARTO',
  maxZoom: 19,
}).addTo(map);

const HEAT_BOUNDS = L.latLngBounds([GRID.latMin, GRID.lngMin], [GRID.latMax, GRID.lngMax]);
let heatOverlay: L.ImageOverlay | null = null;
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

function wireBias(): void {
  const slider = document.getElementById('bias') as HTMLInputElement;
  const val = document.getElementById('bias-val')!;
  slider.addEventListener('input', () => {
    state.bias = +slider.value;
    val.textContent =
      state.bias === 0 ? 'FAIR' : state.bias < 0 ? `A saves ${-state.bias}′` : `B saves ${state.bias}′`;
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
    { key: 'veganFriendly' as const, label: '🌱 VEGAN-FRIENDLY', cls: 'vegan' },
    { key: 'veganOnly' as const, label: '🌱 FULLY VEGAN', cls: 'vegan' },
    { key: 'tea' as const, label: '🍵 TEA', cls: 'tea' },
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
    lastLayers = combos.map((c) => comboLayer(c.a, c.b, getField('A', c.a), getField('B', c.b), state.bias));
    const agg = maxLayers(lastLayers, CELLS);
    const canvas = renderHeat(agg, minPersonField(lastLayers, 'A', CELLS), minPersonField(lastLayers, 'B', CELLS), GRID);
    const url = canvas.toDataURL();
    if (heatOverlay) heatOverlay.setUrl(url);
    else {
      heatOverlay = L.imageOverlay(url, HEAT_BOUNDS, {
        opacity: 0.62,
        className: 'heat-img',
        interactive: false,
      }).addTo(map);
    }
  }
  renderVenues();
  setStatus('Ready', 900);
}

// ── Venues ───────────────────────────────────────────────────
const gmaps = (v: Venue) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name} ${v.addr || ''} New York`)}`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function venueTags(v: Venue): string {
  const tags: string[] = [];
  if (v.vegan === 2) tags.push('<span class="tag vegan2">100% vegan</span>');
  else if (v.vegan === 1) tags.push('<span class="tag vegan1">vegan-friendly</span>');
  if (v.tea) tags.push('<span class="tag tea">tea</span>');
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

function metaLine(v: Venue): string {
  const bits: string[] = [];
  const stars = starsHtml(v);
  if (stars) bits.push(stars);
  if (v.price) bits.push(`<span class="price">${'$'.repeat(v.price)}</span>`);
  if (v.cuisine) bits.push(esc(v.cuisine.split(';')[0].replace(/_/g, ' ')));
  return bits.join(' · ');
}

// ── Detail panel ─────────────────────────────────────────────
const detailEl = document.getElementById('detail') as HTMLElement;

function closeDetail(): void {
  detailEl.hidden = true;
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
  detailEl.innerHTML =
    `<button class="detail-close" aria-label="Close">✕</button>` +
    (v.img ? `<img class="detail-img" src="${esc(v.img)}" alt="" onerror="this.remove()" />` : '') +
    `<div class="detail-body">` +
    `<h3>${esc(v.name)}</h3>` +
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
  detailEl.querySelector<HTMLButtonElement>('.detail-close')!.onclick = closeDetail;
}

function heatColor(t: number): string {
  if (t > 0.8) return '#ff2d78';
  if (t > 0.6) return '#ff7043';
  if (t > 0.4) return '#ffb500';
  return '#8b919c';
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
    tea: state.tea,
  });

  const scored = filtered
    .map((v) => ({ v, s: scoreAtPoint(GRID, lastLayers, v) }))
    .filter((x): x is { v: Venue; s: NonNullable<ReturnType<typeof scoreAtPoint>> } => x.s !== null && x.s.score > 0.001)
    .sort((a, b) => b.s.score - a.s.score)
    .slice(0, 40);

  headEl.textContent = `Best spots · ${scored.length}`;

  if (!scored.length) {
    listEl.innerHTML = '<li class="empty">No venues in the fair zone — widen filters or move a pin.</li>';
    return;
  }

  const maxScore = scored[0].s.score;
  for (const { v, s } of scored) {
    const { combos, refined } = effectiveCombos(v, s.combos);
    // Headline = the combo that actually earned the rank (bias-aware score, refined times).
    const best = combos.reduce((p, c) => (fairnessScore(c.tA, c.tB, state.bias) > fairnessScore(p.tA, p.tB, state.bias) ? c : p));
    // Fully-vegan places get the MTA-green ring; vegan-friendly a fainter one.
    const ring = v.vegan === 2 ? '#00e05c' : v.vegan === 1 ? '#7dedaa' : '#fff';
    const dot = L.circleMarker([v.lat, v.lng], {
      radius: v.vegan === 2 ? 7 : 6,
      color: ring,
      weight: v.vegan ? 2.5 : 1.5,
      fillColor: heatColor(s.score / maxScore),
      fillOpacity: 0.95,
      className: 'venue-dot',
    }).addTo(venueLayer);
    dot.on('click', () => showDetail(v, effectiveCombos(v, s.combos).combos));

    const li = document.createElement('li');
    const meta = metaLine(v);
    li.innerHTML =
      `<span class="v-name">${esc(v.name)}</span>` +
      `<span class="v-times">${refined ? '<span class="routed" title="street-routed times">⚡</span>' : ''}<b class="ta">${Math.round(best.tA)}′</b>/<b class="tb">${Math.round(best.tB)}′</b></span>` +
      (meta ? `<span class="v-meta">${meta}</span>` : '') +
      `<span class="v-tags">${venueTags(v)}</span>`;
    li.onclick = () => {
      map.setView([v.lat, v.lng], Math.max(map.getZoom(), 14));
      showDetail(v, effectiveCombos(v, s.combos).combos);
    };
    listEl.appendChild(li);
  }

  void refineVenues(scored.map((x) => x.v));
}

// ── Boot ─────────────────────────────────────────────────────
renderModes('A');
renderModes('B');
renderDayparts();
wireBias();
renderCatFilters();
renderDietFilters();
wireInput('A');
wireInput('B');
scheduleRecompute();
