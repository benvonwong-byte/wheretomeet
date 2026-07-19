import L from 'leaflet';
import './style.css';
import venuesData from './data/venues.json';
import supplementData from './data/supplement.json';
import subwayData from './data/subway.json';
import { NYC_GRID, pointToCell } from './lib/geo';
import { carDaypartMin } from './lib/modes';
import { buildGraph, transitPath, type TransitGraph } from './lib/transit';
import { timeField, comboLayer, minPersonField, scoreAtPoint, fairnessScore, groupScore, groupLayer } from './lib/fairness';
import { maskField } from './lib/contours';
import landmaskData from './data/landmask.json';
import { renderHeat, renderGroupBenefit } from './lib/heat';
import { filterVenues } from './lib/venues';
import { geocode, makeSuggester, type GeoHit } from './lib/geocode';
import { routedMinutes, routedField, routedGeometry } from './lib/osrm';
import { venueEmoji } from './lib/emoji';
import { loadFavs, toggleFav, seedFavs } from './lib/favs';
import { encodeShare, parseShare } from './lib/share';
import { parseMapLink, validateSubmission } from './lib/submit';
import type { Pt, Mode, Venue, ComboLayer, GroupLayer, TimeField, SubwayData, Daypart } from './lib/types';

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

// Slot identity follows the position in the plan: colors + letters are per
// SLOT (A green, B purple, …); people keep their own id for caches/markers.
const SLOT = ['a', 'b', 'c', 'd', 'e'] as const;
const PERSON_COLORS = ['#4f8f00', '#7b2cbf', '#009e8f', '#e0662a', '#2f6fd0'];
const MAX_PEOPLE = 5;

// ── State ────────────────────────────────────────────────────
// One source of truth. Every person has a stable id (never reused, never
// shifted by add/remove); caches and markers key on it. The DOM and the map
// are projections, rebuilt by renderPeople() after any roster change.
interface Person {
  id: number;
  pt: Pt;
  mode: Mode;
  name: string; // short display name (bullet click to edit)
  label: string; // committed address text — lives HERE, not in the DOM
}

let nextPersonId = 1;
const newPerson = (pt: Pt, mode: Mode): Person => ({ id: nextPersonId++, pt, mode, name: '', label: '' });

const state = {
  people: [newPerson({ lat: 40.7143, lng: -73.9614 }, 'walk')],
  emojiFilter: new Set<string>(),
  cats: new Set<Venue['cat']>(['restaurant', 'cafe', 'activity']),
  veganOnly: true, // show fully-vegan AND vegan-friendly by default (the whole vegan universe)
  veganFriendly: true,
  teaHouse: true,
  bubbleTea: false,
  glutenFree: false,
  daypart: 'midday' as Daypart,
  bias: 0, // duo: minutes; negative = person A gets the advantage
  lambda: 0.35, // group: 0 = fair to all (minimax), 1 = least total
  sortBy: 'best' as SortBy,
};

const nPeople = () => state.people.length;
const isSolo = () => nPeople() === 1;
const isDuo = () => nPeople() === 2;
const isGroup = () => nPeople() >= 3;
const personById = (id: number): Person | undefined => state.people.find((p) => p.id === id);
const personLabel = (i: number): string => state.people[i]?.name || String.fromCharCode(65 + i);
const personInitial = (i: number): string => personLabel(i).charAt(0).toUpperCase();

// ── Hydrate from a shared link — the URL hash IS the plan ────
const shared = parseShare(location.hash);
const pickMode = (ms: Mode[] | undefined, fallback: Mode): Mode =>
  ms?.length ? (MODES.find((m) => ms.includes(m.id))?.id ?? ms[0]) : fallback;
{
  const p0 = state.people[0];
  if (shared.a) {
    p0.pt = shared.a;
    p0.label = shared.labelA ?? '';
  }
  p0.mode = pickMode(shared.modesA, shared.a ? 'transit' : p0.mode);
  if (shared.nameA) p0.name = shared.nameA;
  if (shared.b && !shared.solo) {
    const p1 = newPerson(shared.b, pickMode(shared.modesB, 'transit'));
    p1.label = shared.labelB ?? '';
    if (shared.nameB) p1.name = shared.nameB;
    state.people.push(p1);
  }
  if (shared.extra && !shared.solo) {
    for (const e of shared.extra.slice(0, MAX_PEOPLE - state.people.length)) {
      const p = newPerson(e.pt, e.mode);
      p.name = e.name;
      p.label = e.label;
      state.people.push(p);
    }
  }
  if (shared.bias != null) state.bias = shared.bias;
  if (shared.lambda != null) state.lambda = shared.lambda;
  if (shared.daypart) state.daypart = shared.daypart;
}

// Favorites are keyed by the first two pins (near-me keys on yourself).
const favPts = (): [Pt, Pt] => [state.people[0].pt, (state.people[1] ?? state.people[0]).pt];
if (shared.favs?.length) seedFavs(...favPts(), shared.favs);

// Debounced: name typing calls this per keystroke and Safari rate-limits
// history.replaceState (throws past ~100 calls/30s). The share button flushes.
let urlTimer = 0;
function syncUrl(): void {
  window.clearTimeout(urlTimer);
  urlTimer = window.setTimeout(syncUrlNow, 250);
}

function syncUrlNow(): void {
  window.clearTimeout(urlTimer);
  const [p0, p1] = state.people;
  const hash = encodeShare({
    a: p0.pt,
    b: p1?.pt,
    labelA: p0.label || undefined,
    labelB: p1?.label || undefined,
    nameA: p0.name || undefined,
    nameB: p1?.name || undefined,
    modesA: [p0.mode],
    modesB: p1 ? [p1.mode] : undefined,
    bias: state.bias,
    daypart: state.daypart,
    favs: [...loadFavs(...favPts())],
    solo: isSolo() || undefined,
    extra: state.people.slice(2).map((p) => ({ pt: p.pt, mode: p.mode, name: p.name, label: p.label })),
    lambda: isGroup() ? state.lambda : undefined,
  });
  try {
    history.replaceState(null, '', hash);
  } catch {
    /* replaceState quota hit — the next sync carries the same state */
  }
}

// ── Travel-time fields, keyed by person ID (never by position) ─
const fieldCache = new Map<string, TimeField>();
// Street modes upgrade from model estimates to real OSRM-routed fields, async.
const fieldUpgrades = new Map<string, 'pending' | 'done'>();

function getField(p: Person): TimeField {
  // Transit (headway waits) and car (traffic) depend on the daypart.
  const key = p.mode === 'transit' || p.mode === 'car' ? `${p.id}:${p.mode}:${state.daypart}` : `${p.id}:${p.mode}`;
  let f = fieldCache.get(key);
  if (!f) {
    f = timeField(getGraph(state.daypart), p.pt, p.mode, GRID);
    if (p.mode === 'car') for (let i = 0; i < f.length; i++) f[i] = carDaypartMin(f[i], state.daypart);
    fieldCache.set(key, f);
  }
  if (p.mode !== 'transit' && !fieldUpgrades.has(key)) upgradeField(p.id, p.mode, key);
  return f;
}

function upgradeField(id: number, mode: Mode, key: string): void {
  fieldUpgrades.set(key, 'pending');
  const person = personById(id);
  if (!person) return;
  const pt = person.pt;
  const daypart = state.daypart;
  void routedField(pt, mode, GRID)
    .then((f) => {
      const p = personById(id); // re-resolve: the person may be gone or moved
      if (!p || p.pt !== pt) {
        // Only clear our own 'pending' — a newer upgrade may have finished
        // ('done') and must not be forced into a redundant refetch.
        if (fieldUpgrades.get(key) === 'pending') fieldUpgrades.delete(key);
        return;
      }
      if (!f) {
        fieldUpgrades.delete(key); // local server unreachable; retry on next recompute
        return;
      }
      if (mode === 'car') for (let i = 0; i < f.length; i++) f[i] = carDaypartMin(f[i], daypart);
      fieldCache.set(key, f);
      fieldUpgrades.set(key, 'done');
      scheduleRecompute();
    })
    .catch(() => fieldUpgrades.delete(key));
}

function clearPersonFields(id: number): void {
  for (const key of [...fieldCache.keys()]) if (key.startsWith(`${id}:`)) fieldCache.delete(key);
  for (const key of [...fieldUpgrades.keys()]) if (key.startsWith(`${id}:`)) fieldUpgrades.delete(key);
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

function bulletIcon(slotIdx: number, initial: string): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="marker-bullet" style="background:${PERSON_COLORS[slotIdx]}">${initial}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// Markers keyed by person id; created/positioned/pruned by syncMarkers().
const markers = new Map<number, L.Marker>();

function syncMarkers(): void {
  const liveIds = new Set(state.people.map((p) => p.id));
  for (const [id, m] of [...markers]) {
    if (!liveIds.has(id)) {
      map.removeLayer(m);
      markers.delete(id);
    }
  }
  state.people.forEach((p, i) => {
    let m = markers.get(p.id);
    if (!m) {
      m = L.marker(p.pt, { icon: bulletIcon(i, personInitial(i)), draggable: true }).addTo(map);
      m.on('dragend', () => {
        const person = personById(p.id); // stable id — survives any reordering
        if (!person) return;
        const ll = m!.getLatLng();
        person.pt = { lat: ll.lat, lng: ll.lng };
        person.label = ''; // a dragged pin no longer matches a typed address
        clearPersonFields(person.id);
        exactCache.get(person.id)?.clear();
        // Targeted clear of just this row's box — a full rebuild would wipe
        // uncommitted text the user may be typing in another row.
        const idx = state.people.indexOf(person);
        const inp = document.getElementById(`addr-${SLOT[idx]}`) as HTMLInputElement | null;
        if (inp) inp.value = '';
        closeDetail(); // open card + routes were drawn from the old spot
        coverageWarning(person);
        scheduleRecompute();
      });
      markers.set(p.id, m);
    } else {
      m.setLatLng(p.pt);
      m.setIcon(bulletIcon(i, personInitial(i)));
    }
  });
}

// ── People rows: one declarative render of the whole roster ──
// Rebuilt after every roster/identity change (never while typing). The last
// row is a GHOST slot — the next person's address box, always visible; typing
// an address there creates the person. No hidden controls, no mirror person.
let ghostMode: Mode = 'transit';

function renderPeople(): void {
  const box = document.getElementById('people')!;
  box.innerHTML = '';

  state.people.forEach((p, i) => {
    const sec = document.createElement('section');
    sec.className = 'person';
    sec.dataset.person = SLOT[i];
    sec.innerHTML =
      `<div class="person-head">` +
      `<span class="bullet" id="bullet-${SLOT[i]}" style="background:${PERSON_COLORS[i]}">${personInitial(i)}</span>` +
      `<input id="name-${SLOT[i]}" class="pname" type="text" maxlength="14" placeholder="Name" autocomplete="off" />` +
      `<input id="addr-${SLOT[i]}" type="text" autocomplete="off" />` +
      (i > 0 ? `<button class="person-remove" title="remove this person">✕</button>` : '') +
      `</div>` +
      `<div class="modes" id="modes-${SLOT[i]}"></div>`;
    box.appendChild(sec);

    const addr = sec.querySelector<HTMLInputElement>(`#addr-${SLOT[i]}`)!;
    addr.value = p.label;
    addr.placeholder = i === 0 ? '📍 Your location or an address…' : `Person ${SLOT[i].toUpperCase()} address…`;
    wireAddrInput(addr, p.id);
    wireNameInput(sec, p.id, i);
    const pillBox = sec.querySelector(`#modes-${SLOT[i]}`)!;
    const pickPill = (m: Mode): void => {
      const person = personById(p.id);
      if (!person || person.mode === m) return;
      person.mode = m;
      closeDetail(); // an open card would show times for the OLD mode
      // Repaint ONLY these pills — a full row rebuild would wipe any
      // uncommitted address text the user is typing elsewhere.
      renderModePills(pillBox, m, pickPill);
      scheduleRecompute();
    };
    renderModePills(pillBox, p.mode, pickPill);

    if (i > 0) {
      sec.querySelector<HTMLButtonElement>('.person-remove')!.onclick = () => removePerson(p.id);
    }
    if (isDuo() && i === 0) {
      const swap = document.createElement('button');
      swap.id = 'swap-ab';
      swap.title = 'Swap Person A ↔ Person B';
      swap.textContent = '⇅';
      swap.onclick = swapPersons;
      sec.appendChild(swap);
    }
  });

  // Ghost slot: the standing invitation for the next person.
  if (nPeople() < MAX_PEOPLE) {
    const i = nPeople();
    const sec = document.createElement('section');
    sec.className = 'person ghost';
    sec.dataset.person = SLOT[i];
    sec.innerHTML =
      `<div class="person-head">` +
      `<span class="bullet ghost-bullet" style="color:${PERSON_COLORS[i]};border-color:${PERSON_COLORS[i]}">${SLOT[i].toUpperCase()}</span>` +
      `<input id="addr-ghost" type="text" autocomplete="off" />` +
      `</div>` +
      `<div class="modes" id="modes-ghost"></div>`;
    box.appendChild(sec);
    const addr = sec.querySelector<HTMLInputElement>('#addr-ghost')!;
    addr.placeholder = isSolo() ? 'Add a friend to meet in the middle…' : `＋ Add person ${SLOT[i].toUpperCase()} — address…`;
    wireAddrInput(addr, 'ghost');
    const ghostBox = sec.querySelector('#modes-ghost')!;
    const pickGhost = (m: Mode): void => {
      ghostMode = m;
      renderModePills(ghostBox, m, pickGhost); // pills only — keep any typed address
    };
    renderModePills(ghostBox, ghostMode, pickGhost);
  }

  syncMarkers();
  applyNames();
  syncModeUi();
}

function renderModePills(el: Element, current: Mode, pick: (m: Mode) => void): void {
  el.innerHTML = '';
  for (const m of MODES) {
    const btn = document.createElement('button');
    btn.className = 'mode-pill' + (current === m.id ? ' on' : '');
    btn.textContent = m.label;
    btn.onclick = () => pick(m.id);
    el.appendChild(btn);
  }
}

function wireNameInput(sec: HTMLElement, personId: number, i: number): void {
  const input = sec.querySelector<HTMLInputElement>(`#name-${SLOT[i]}`)!;
  const bullet = sec.querySelector<HTMLElement>(`#bullet-${SLOT[i]}`)!;
  const person = personById(personId)!;
  input.value = person.name;
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
    const p = personById(personId);
    if (!p) return;
    p.name = input.value.trim().slice(0, 16);
    applyNames(); // names only — never rebuilds the row under the caret
    syncUrl();
  });
}

// Names touch bullets, markers, dial labels, sort chips — but never inputs.
function applyNames(): void {
  state.people.forEach((p, i) => {
    const b = document.getElementById(`bullet-${SLOT[i]}`);
    if (b) {
      b.textContent = personInitial(i);
      b.title = p.name ? `${p.name} — click to rename` : 'Click to add a name';
    }
    markers.get(p.id)?.setIcon(bulletIcon(i, personInitial(i)));
  });
  renderMapKey();
  updateBiasLabel();
  renderSortChips();
  updatePlanBar();
}

// ── Roster changes ───────────────────────────────────────────
function addPerson(hit: GeoHit): void {
  if (nPeople() >= MAX_PEOPLE) return;
  const p = newPerson(hit.pt, ghostMode);
  p.label = hit.label;
  state.people.push(p);
  ghostMode = 'transit';
  closeDetail();
  renderPeople();
  map.panTo(hit.pt);
  coverageWarning(p);
  scheduleRecompute();
}

function removePerson(id: number): void {
  const i = state.people.findIndex((p) => p.id === id);
  if (i <= 0) return; // person 0 is you — the anchor
  state.people.splice(i, 1);
  clearPersonFields(id);
  exactCache.delete(id);
  closeDetail();
  renderPeople();
  scheduleRecompute();
}

function swapPersons(): void {
  if (!isDuo()) return;
  [state.people[0], state.people[1]] = [state.people[1], state.people[0]];
  state.bias = -state.bias; // the dial is directional; the direction flipped
  closeDetail();
  renderPeople(); // caches/markers are id-keyed — they follow their person
  configureSlider();
  syncUrl();
  scheduleRecompute();
}

// Near-me: collapse the plan to just you at a location.
function enterNearMe(pt: Pt, label: string, forceWalk: boolean): void {
  for (const p of state.people.slice(1)) {
    clearPersonFields(p.id);
    exactCache.delete(p.id);
  }
  state.people.length = 1;
  const p0 = state.people[0];
  p0.pt = pt;
  p0.label = label;
  if (forceWalk) p0.mode = 'walk';
  clearPersonFields(p0.id);
  exactCache.get(p0.id)?.clear();
  closeDetail();
  renderPeople();
  map.setView(pt, 15);
  if (IS_MOBILE) sheetTo('peek'); // nearby-first: the map and its glow lead
  coverageWarning(p0);
  scheduleRecompute();
}

// ── Venue sort criteria (duo) ────────────────────────────────
type SortBy = 'best' | 'total' | 'equal' | 'a' | 'b';

const SORTS: { id: SortBy; label: string }[] = [
  { id: 'best', label: 'BEST' },
  { id: 'total', label: 'FASTEST TOTAL' },
  { id: 'equal', label: 'MOST EQUAL' },
  { id: 'a', label: 'BEST FOR A' },
  { id: 'b', label: 'BEST FOR B' },
];

function sortLabel(s: { id: SortBy; label: string }): string {
  if (s.id === 'a') return `BEST FOR ${personLabel(0).toUpperCase()}`;
  if (s.id === 'b') return `BEST FOR ${personLabel(1).toUpperCase()}`;
  return s.label;
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

// ── UI: daypart + the one slider (dial in duo, λ in group) ───
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
      for (const m of exactCache.values()) {
        for (const k of [...m.keys()]) if (k.startsWith('car:')) m.delete(k);
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
  if (isGroup()) {
    val.textContent = state.lambda <= 0.15 ? 'FAIR TO ALL' : state.lambda >= 0.85 ? 'LEAST TOTAL' : 'BALANCED';
    document.getElementById('bias-left')!.textContent = '← fair to all';
    document.getElementById('bias-right')!.textContent = 'least total →';
    return;
  }
  val.textContent =
    state.bias === 0
      ? 'FAIR'
      : state.bias < 0
        ? `${personLabel(0)} saves ${-state.bias}′`
        : `${personLabel(1)} saves ${state.bias}′`;
  document.getElementById('bias-left')!.textContent = `← ${personLabel(0)} advantage`;
  document.getElementById('bias-right')!.textContent = `${personLabel(1)} advantage →`;
}

function configureSlider(): void {
  const slider = document.getElementById('bias') as HTMLInputElement;
  if (isGroup()) {
    slider.min = '0';
    slider.max = '100';
    slider.step = '5';
    slider.value = String(Math.round(state.lambda * 100));
  } else {
    slider.min = '-20';
    slider.max = '20';
    slider.step = '5';
    slider.value = String(state.bias);
  }
  updateBiasLabel();
}

function wireBias(): void {
  const slider = document.getElementById('bias') as HTMLInputElement;
  slider.addEventListener('input', () => {
    if (isGroup()) state.lambda = +slider.value / 100;
    else state.bias = +slider.value;
    updateBiasLabel();
    scheduleRecompute();
  });
}

// Mode-dependent chrome, all in one place, driven purely by headcount.
function syncModeUi(): void {
  (document.querySelector('#tuning-panel .bias') as HTMLElement).hidden = isSolo();
  (document.getElementById('layers-panel') as HTMLElement).hidden = isSolo(); // map key: duo + group
  (document.getElementById('sort-chips') as HTMLElement).hidden = !isDuo(); // A/B sorts: duo only
  renderMapKey();
  configureSlider();
}

// The map key explains whichever heat is on screen: duo = whose side of the
// gradient, group = one benefit axis (purple → yellow → green).
function renderMapKey(): void {
  const note = document.querySelector('#layers-panel .key-note');
  const bar = document.querySelector('#layers-panel .adv-bar') as HTMLElement | null;
  const labels = document.querySelector('#layers-panel .adv-labels');
  if (!note || !bar || !labels) return;
  if (isGroup()) {
    note.textContent = 'The heat sits on the zone of recommended spots. Color = how well a spot serves the whole group:';
    bar.style.background = 'linear-gradient(90deg, #7b2cbf, #ffcd14, #61a60e)';
    labels.innerHTML =
      '<span class="adv-b">tough for some</span><span class="adv-mid">okay</span><span class="adv-a">best for everyone</span>';
  } else {
    note.textContent = 'The heat sits on the zone of recommended spots. Color = advantage:';
    bar.style.background = '';
    labels.innerHTML =
      `<span class="adv-a">${esc(personLabel(0))} sooner</span>` +
      `<span class="adv-mid">even</span>` +
      `<span class="adv-b">${esc(personLabel(1))} sooner</span>`;
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
function coverageWarning(p: Person): void {
  const outside =
    p.pt.lat < GRID.latMin || p.pt.lat > GRID.latMax || p.pt.lng < GRID.lngMin || p.pt.lng > GRID.lngMax;
  if (outside) {
    const i = state.people.indexOf(p);
    setStatus(`Heads up: ${personLabel(Math.max(i, 0))} is outside NYC coverage — no subway data there, times are rough estimates`, 5000);
  }
}

// The ONE commit path for an address — keyboard and mouse both land here,
// carrying the person's stable id (or 'ghost' = create the next person).
function commitLocation(target: number | 'ghost', hit: GeoHit, input: HTMLInputElement): void {
  input.value = hit.label;
  input.classList.remove('bad');
  if (target === 'ghost') {
    addPerson(hit);
    return;
  }
  const p = personById(target);
  if (!p) return;
  p.pt = hit.pt;
  p.label = hit.label;
  clearPersonFields(p.id);
  exactCache.get(p.id)?.clear();
  markers.get(p.id)?.setLatLng(hit.pt);
  map.panTo(hit.pt);
  closeDetail(); // open card + routes were computed from the old location
  coverageWarning(p);
  scheduleRecompute();
  syncUrl();
}

function wireAddrInput(input: HTMLInputElement, target: number | 'ghost'): void {
  const drop = document.createElement('div');
  drop.className = 'suggest';
  drop.hidden = true;
  input.parentElement!.appendChild(drop);

  let hits: GeoHit[] = [];
  let sel = -1;
  let committing = false; // one commit at a time — double-Enter can't double-add
  let suppressUntil = 0; // a just-committed input ignores late suggester results

  const close = () => {
    drop.hidden = true;
    sel = -1;
  };

  const commit = (hit: GeoHit) => {
    suppressUntil = Date.now() + 900;
    hits = [];
    close();
    commitLocation(target, hit, input); // target = person id, NEVER a row index
  };

  const renderDrop = () => {
    drop.innerHTML = '';
    drop.hidden = hits.length === 0;
    hits.forEach((h, rowIdx) => {
      const row = document.createElement('div');
      row.className = 'suggest-row' + (rowIdx === sel ? ' sel' : '');
      row.textContent = h.label;
      // pointerdown keeps the input focused (beats the blur-close); click
      // commits — mousedown alone dies silently on touch if the finger drifts.
      row.onpointerdown = (e) => e.preventDefault();
      row.onclick = () => commit(h);
      drop.appendChild(row);
    });
  };

  const suggester = makeSuggester((results) => {
    if (Date.now() < suppressUntil) return; // stale response after a commit
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
      if (!input.value.trim() || committing) return;
      const picked = sel >= 0 ? hits[sel] : hits[0];
      if (picked) {
        commit(picked);
        return;
      }
      // No suggestions — precise Nominatim fallback (guarded: a second Enter
      // while this awaits must not commit twice → duplicate people).
      committing = true;
      setStatus('Locating…');
      try {
        const hit = await geocode(input.value.trim());
        if (!hit) {
          setStatus('Address not found — try adding a borough', 2600);
          input.classList.add('bad');
          return;
        }
        commit(hit);
      } finally {
        committing = false;
      }
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
  setStatus(isSolo() ? 'Finding spots near you…' : 'Computing fair zones…');
  pending = window.setTimeout(() => {
    const vo = pendingVenuesOnly;
    pendingVenuesOnly = true;
    recompute(vo);
  }, 30);
}

// Exactly one of these is live, matching the current headcount.
let lastSolo: TimeField | null = null;
let lastLayers: ComboLayer[] = [];
let lastGroup: GroupLayer | null = null;

function coreReady(): boolean {
  if (isSolo()) return lastSolo !== null;
  if (isDuo()) return lastLayers.length > 0;
  return lastGroup !== null;
}

function recompute(venuesOnly: boolean): void {
  if (!venuesOnly || !coreReady()) {
    lastSolo = null;
    lastLayers = [];
    lastGroup = null;
    if (isSolo()) {
      lastSolo = getField(state.people[0]);
    } else if (isDuo()) {
      const [p0, p1] = state.people;
      lastLayers = [comboLayer(p0.mode, p1.mode, getField(p0), getField(p1), state.bias)];
    } else {
      lastGroup = groupLayer(state.people.map((p) => getField(p)), state.lambda);
    }
  }
  renderVenues(); // heat follows the venue list (drawn at the end of renderVenues)
  setStatus('Ready', 900);
}

// ── Heat over the recommended zone ───────────────────────────
// Solo: closeness gradient. Duo: green/yellow/purple advantage. Group:
// per-person colors blended by who reaches each spot fastest.
const LANDMASK = (landmaskData as { mask: string }).mask;
const HEAT_BOUNDS = L.latLngBounds([GRID.latMin, GRID.lngMin], [GRID.latMax, GRID.lngMax]);
let heatOverlay: L.ImageOverlay | null = null;

let shownVenueCells: number[] = []; // grid cells of the currently listed venues

function setHeat(url: string, opacity: number): void {
  if (!heatOverlay) {
    heatOverlay = L.imageOverlay(url, HEAT_BOUNDS, { opacity, className: 'glow-img', interactive: false }).addTo(map);
  } else {
    heatOverlay.setUrl(url);
  }
  heatOverlay.setOpacity(opacity);
}

function drawContours(): void {
  if (isSolo() && lastSolo) {
    // Closeness gradient: green ≤5′ from you, yellow ~15′, purple 25′+.
    const t0 = maskField(lastSolo.slice(), LANDMASK);
    const gap = new Float32Array(CELLS);
    for (let i = 0; i < CELLS; i++) {
      const t = t0[i];
      gap[i] = isFinite(t) ? Math.max(-14, Math.min(14, ((t - 15) / 10) * 14)) : 14;
    }
    setHeat(renderHeat(gap, shownVenueCells, GRID, 0).toDataURL(), 0.4);
    return;
  }
  if (isDuo() && lastLayers.length) {
    const minA = maskField(minPersonField(lastLayers, 'A', CELLS), LANDMASK);
    const minB = maskField(minPersonField(lastLayers, 'B', CELLS), LANDMASK);
    const gap = new Float32Array(CELLS);
    for (let i = 0; i < CELLS; i++) gap[i] = minA[i] - minB[i];
    setHeat(renderHeat(gap, shownVenueCells, GRID, state.bias).toDataURL(), 0.78);
    return;
  }
  if (isGroup() && lastGroup) {
    // One benefit axis: green = best for everyone at the current λ, purple =
    // somebody gets a rough trip. Tracks the fairness slider because the
    // scores are the λ-blended groupLayer output.
    const masked = maskField(lastGroup.scores.slice(), LANDMASK);
    setHeat(renderGroupBenefit(masked, shownVenueCells, GRID).toDataURL(), 0.75);
  }
}

// ── Venues ───────────────────────────────────────────────────
const gmaps = (v: Venue) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name} ${v.addr || ''} New York`)}`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Minutes for display — unreachable renders as a dash, never "Infinity′". */
const fmtMin = (t: number): string => (isFinite(t) ? `${Math.round(t)}′` : '—');

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

// ── Route drawing ────────────────────────────────────────────
const routeLayer = L.layerGroup().addTo(map);
let routeToken = 0;

async function personRoute(pt: Pt, mode: Mode, v: Venue): Promise<{ path: Pt[]; routed: boolean }> {
  const dest = { lat: v.lat, lng: v.lng };
  if (mode === 'transit') return { path: transitPath(getGraph(state.daypart), pt, dest), routed: true };
  const geo = await routedGeometry(pt, dest, mode);
  // No routing tier reachable → straight-line ESTIMATE, drawn visibly as one.
  return geo ? { path: geo, routed: true } : { path: [pt, dest], routed: false };
}

// Draw one colored leg per person. Snapshots pt/mode/color up-front so a
// roster change mid-flight can never index into the wrong person.
async function drawRoutes(v: Venue): Promise<void> {
  const token = ++routeToken;
  const legs = state.people.map((p, i) => ({ pt: p.pt, mode: p.mode, color: PERSON_COLORS[i] }));
  const paths = await Promise.all(legs.map((leg) => personRoute(leg.pt, leg.mode, v)));
  if (token !== routeToken) return; // roster changed / another venue selected
  routeLayer.clearLayers();
  paths.forEach((r, i) => {
    L.polyline(r.path, {
      color: legs[i].color,
      weight: r.routed ? 4 : 3,
      opacity: r.routed ? 0.85 : 0.45,
      // transit = schematic station hops; unrouted street = rough estimate
      dashArray: legs[i].mode === 'transit' ? '2 8' : r.routed ? undefined : '10 10',
      lineCap: 'round' as const,
      // Decorative: Leaflet paths bubble clicks to the map by default, and a
      // map click closes the very card these routes belong to.
      interactive: false,
    }).addTo(routeLayer);
  });
}

// ── Detail panel ─────────────────────────────────────────────
const detailEl = document.getElementById('detail') as HTMLElement;

function closeDetail(): void {
  detailEl.hidden = true;
  routeToken++;
  routeLayer.clearLayers();
}

function detailShell(v: Venue, rows: string, isFav: boolean): string {
  const metaBits: string[] = [];
  if (v.price) metaBits.push(`<span class="price">${'$'.repeat(v.price)}</span>`);
  if (v.cuisine) metaBits.push(esc(v.cuisine.split(';')[0].replace(/_/g, ' ')));
  const meta = metaBits.join(' · ');
  const ratingRow =
    v.rating != null
      ? `<div class="detail-rating"><span class="stars">${'★'.repeat(Math.round(v.rating))}${'☆'.repeat(5 - Math.round(v.rating))}</span> <b>${v.rating.toFixed(1)}</b>${v.ratings ? ` · ${v.ratings.toLocaleString()} reviews` : ''}</div>`
      : `<div class="detail-rating none"><span class="stars">☆☆☆☆☆</span> not yet rated</div>`;
  return (
    `<button class="detail-close" aria-label="Close">✕</button>` +
    `<button class="fav-btn detail-fav${isFav ? ' on' : ''}" title="favorite">♥</button>` +
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
    `<table class="detail-times${isGroup() ? ' group' : ''}">${rows}</table>` +
    `<div class="detail-links">` +
    (v.web ? `<a href="${esc(v.web)}" target="_blank" rel="noopener">Website ↗</a>` : '') +
    `<a href="${gmaps(v)}" target="_blank" rel="noopener">Google Maps ↗</a>` +
    `</div></div>`
  );
}

function openDetail(v: Venue, rows: string): void {
  const isFav = loadFavs(...favPts()).has(v.id);
  detailEl.innerHTML = detailShell(v, rows, isFav);
  detailEl.hidden = false;
  void drawRoutes(v);
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
    toggleFav(...favPts(), v.id);
    renderVenues();
    showDetail(v); // re-derive rows from CURRENT state — never a stale closure
  };
}

// One entry point: derives the per-person rows from current state.
function showDetail(v: Venue): void {
  const times = venueTimes(v);
  if (isSolo()) {
    const t = times.times[0];
    openDetail(
      v,
      `<tr><td><span class="ca">${esc(personLabel(0))} · ${MODE_LABEL[state.people[0].mode]}</span></td><td>${isFinite(t) ? Math.round(t) + '′' : '—'}</td></tr>`,
    );
    return;
  }
  if (isDuo()) {
    const [tA, tB] = times.times;
    const [p0, p1] = state.people;
    openDetail(
      v,
      `<tr><td><span class="ca">${esc(personLabel(0))} · ${MODE_LABEL[p0.mode]}</span></td><td>${fmtMin(tA)}</td>` +
        `<td><span class="cb">${esc(personLabel(1))} · ${MODE_LABEL[p1.mode]}</span></td><td>${fmtMin(tB)}</td>` +
        `<td class="gap">${isFinite(tA) && isFinite(tB) ? `Δ${Math.round(Math.abs(tA - tB))}′` : '—'}</td></tr>`,
    );
    return;
  }
  const worst = Math.max(...times.times);
  const total = times.times.reduce((a, b) => a + b, 0);
  const rows = state.people
    .map((p, i) => {
      const t = times.times[i];
      const far = isFinite(t) && t === worst;
      return `<tr${far ? ' class="far"' : ''}><td><span class="cg" style="color:${PERSON_COLORS[i]}">${esc(personLabel(i))} · ${MODE_LABEL[p.mode]}</span></td><td>${isFinite(t) ? Math.round(t) + '′' : '—'}</td></tr>`;
    })
    .join('');
  const summary = `<tr class="g-sum"><td>Longest ${Math.round(worst)}′</td><td>${Math.round(total)}′ total</td></tr>`;
  openDetail(v, rows + summary);
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
// street-network routing per venue. Keyed by person ID: a removed person's
// cache dies with them, a re-added person starts clean.
const exactCache = new Map<number, Map<string, number | null>>();
let refineToken = 0;

function exactFor(p: Person, v: Venue): number | null | undefined {
  return exactCache.get(p.id)?.get(`${p.mode}:${v.id}`);
}

/** Every person's minutes to this venue: street-routed where known, model otherwise. */
function venueTimes(v: Venue): { times: number[]; refined: boolean } {
  const cell = pointToCell(GRID, v);
  let refined = false;
  const times = state.people.map((p) => {
    const ex = exactFor(p, v);
    if (typeof ex === 'number') {
      refined = true;
      return ex;
    }
    const f = getField(p);
    return cell >= 0 ? f[cell] : Infinity;
  });
  return { times, refined };
}

async function refineVenues(venues: Venue[]): Promise<void> {
  const token = ++refineToken;
  const jobs: Promise<void>[] = [];
  // Snapshot id/mode/pt per person — the callback re-checks by id.
  for (const snap of state.people.map((p) => ({ id: p.id, mode: p.mode, pt: p.pt }))) {
    if (snap.mode === 'transit') continue; // GTFS engine is the authority there
    let cache = exactCache.get(snap.id);
    if (!cache) {
      cache = new Map();
      exactCache.set(snap.id, cache);
    }
    const missing = venues.filter((v) => !cache!.has(`${snap.mode}:${v.id}`));
    if (!missing.length) continue;
    const daypart = state.daypart;
    jobs.push(
      routedMinutes(snap.pt, missing, snap.mode).then((mins) => {
        if (!mins) return;
        const c = exactCache.get(snap.id); // person may be gone — write nowhere
        const live = personById(snap.id);
        // Daypart gate: car minutes are scaled by the SNAPSHOT hour — if the
        // user switched dayparts mid-flight, these values are for the wrong
        // hour and must not land in the (already purged) cache.
        if (!c || !live || live.pt !== snap.pt || state.daypart !== daypart) return;
        missing.forEach((v, k) => {
          const t = mins[k];
          c.set(`${snap.mode}:${v.id}`, snap.mode === 'car' && t != null ? carDaypartMin(t, daypart) : t);
        });
      }),
    );
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  // Through the scheduler, not renderVenues() directly: if the roster changed
  // while we were routing, recompute rebuilds the core for the NEW headcount
  // first (rendering stale group fields against fewer colors would throw).
  if (token === refineToken) scheduleRecompute(true);
}

// ── Venue list ───────────────────────────────────────────────
function filteredVenues(): Venue[] {
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
  return state.emojiFilter.size
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
}

interface Ranked {
  v: Venue;
  times: number[];
  refined: boolean;
  finalScore: number;
  headline: string; // the times cell in the row
}

function rankVenues(filtered: Venue[]): Ranked[] {
  if (isDuo()) {
    // Shortlist by model score with margin, then rank by the SAME times the
    // rows display (street-routed where available) so rank and readout agree.
    const candidates = filtered
      .map((v) => ({ v, s: scoreAtPoint(GRID, lastLayers, v) }))
      .filter((x): x is { v: Venue; s: NonNullable<ReturnType<typeof scoreAtPoint>> } => x.s !== null && x.s.score > 0.001)
      .sort((a, b) => b.s.score - a.s.score)
      .slice(0, 60);
    const enriched = candidates.map(({ v }) => {
      const { times, refined } = venueTimes(v);
      const [tA, tB] = times;
      return { v, times, refined, tA, tB, finalScore: fairnessScore(tA, tB, state.bias) };
    });
    // Viability gate: a spot must SAVE BOTH PEOPLE TIME — anything more than
    // 15 combined minutes past the best reachable venue is out.
    const minTotal = enriched.reduce((m, x) => Math.min(m, x.tA + x.tB), Infinity);
    return enriched
      .filter((x) => x.tA + x.tB <= minTotal + 15)
      .sort((x, y) => {
        switch (state.sortBy) {
          case 'total':
            return x.tA + x.tB - (y.tA + y.tB);
          case 'equal':
            return Math.abs(x.tA - x.tB) - Math.abs(y.tA - y.tB) || x.tA + x.tB - (y.tA + y.tB);
          case 'a':
            return x.tA - y.tA || x.tB - y.tB;
          case 'b':
            return x.tB - y.tB || x.tA - y.tA;
          default:
            return y.finalScore - x.finalScore;
        }
      })
      .slice(0, 40)
      .map((x) => ({
        v: x.v,
        times: x.times,
        refined: x.refined,
        finalScore: x.finalScore,
        headline: `<b class="ta">${Math.round(x.tA)}′</b>/<b class="tb">${Math.round(x.tB)}′</b>`,
      }));
  }

  // Solo + group share the same shape: times per person → score → gate.
  const enriched = filtered
    .map((v) => {
      const { times, refined } = venueTimes(v);
      const worst = Math.max(...times);
      const total = times.reduce((a, b) => a + b, 0);
      const finalScore = isSolo() ? Math.exp(-times[0] / 20) : groupScore(times, state.lambda);
      return { v, times, refined, worst, total, finalScore };
    })
    .filter((x) => isFinite(x.worst) && x.finalScore > 0.001);
  const minWorst = enriched.reduce((m, x) => Math.min(m, x.worst), Infinity);
  const slack = isSolo() ? 15 : 12;
  return enriched
    .filter((x) => x.worst <= minWorst + slack)
    .sort((x, y) => y.finalScore - x.finalScore)
    .slice(0, 40)
    .map((x) => ({
      v: x.v,
      times: x.times,
      refined: x.refined,
      finalScore: x.finalScore,
      headline: isSolo()
        ? `<b class="ta">${Math.round(x.times[0])}′</b>`
        : `<b class="ta">${Math.round(x.worst)}′</b><span class="v-total"> longest · ${Math.round(x.total)}′ total</span>`,
    }));
}

function renderVenues(): void {
  venueLayer.clearLayers();
  const listEl = document.getElementById('venues')!;
  const headEl = document.getElementById('venues-head')!;
  listEl.innerHTML = '';

  const filtered = filteredVenues();
  const scored = rankVenues(filtered);

  headEl.textContent = isSolo()
    ? `Near you · ${scored.length}`
    : isDuo()
      ? `Best spots · ${scored.length}`
      : `Fair for all ${nPeople()} · ${scored.length}`;

  if (!scored.length) {
    const hint = state.emojiFilter.size
      ? 'clear the emoji filter on the map, widen filters, or move a pin'
      : 'widen filters or move a pin';
    listEl.innerHTML = `<li class="empty">No venues in the fair zone — ${hint}.</li>`;
    shownVenueCells = [];
    drawContours();
    renderShortlist(loadFavs(...favPts()));
    syncUrl();
    return;
  }

  // Favorites float to the top.
  const favs = loadFavs(...favPts());
  const ordered = [...scored.filter((x) => favs.has(x.v.id)), ...scored.filter((x) => !favs.has(x.v.id))];

  const maxScore = Math.max(...scored.map((x) => x.finalScore)) || 1;
  for (const { v, refined, finalScore, headline } of ordered) {
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
    pin.on('click', () => showDetail(v));

    const li = document.createElement('li');
    if (isFav) li.className = 'faved';
    const meta = metaLine(v);
    li.innerHTML =
      `<span class="v-name">${venueEmoji(v)} ${esc(v.name)}</span>` +
      `<span class="v-side"><button class="fav-btn${isFav ? ' on' : ''}" title="favorite">♥</button>` +
      `<span class="v-times">${refined ? '<span class="routed" title="street-routed times">⚡</span>' : ''}${headline}</span></span>` +
      (meta ? `<span class="v-meta">${meta}</span>` : '') +
      `<span class="v-tags">${venueTags(v)}</span>`;
    li.querySelector<HTMLButtonElement>('.fav-btn')!.onclick = (e) => {
      e.stopPropagation();
      toggleFav(...favPts(), v.id);
      renderVenues();
    };
    li.onclick = () => {
      map.setView([v.lat, v.lng], Math.max(map.getZoom(), 14));
      showDetail(v);
    };
    listEl.appendChild(li);
  }

  void refineVenues(scored.map((x) => x.v));
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
    const { times } = venueTimes(v);
    const worst = Math.max(...times);
    const li = document.createElement('li');
    const timesHtml = isDuo()
      ? `<span class="sl-times"><b class="ta">${fmtMin(times[0])}</b>/<b class="tb">${fmtMin(times[1])}</b></span>`
      : `<span class="sl-times"><b class="ta">${isFinite(worst) ? fmtMin(isSolo() ? times[0] : worst) : '—'}</b></span>`;
    li.innerHTML =
      `<span class="sl-name">${venueEmoji(v)} ${esc(v.name)}</span>` + timesHtml + `<button class="sl-remove" title="remove">✕</button>`;
    li.querySelector<HTMLButtonElement>('.sl-remove')!.onclick = (e) => {
      e.stopPropagation();
      toggleFav(...favPts(), v.id);
      renderVenues();
    };
    li.onclick = () => {
      map.setView([v.lat, v.lng], Math.max(map.getZoom(), 14));
      showDetail(v);
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
    '<button id="plan-bar"><span class="pb-brand">\u{1F33F}</span><span id="plan-sum"></span><span class="pb-caret">▾</span></button>' +
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
  editor.appendChild(document.getElementById('people')!);
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

  // Solo-only invitation to go duo — opens the editor on the ghost slot.
  const bInvite = document.createElement('button');
  bInvite.id = 'b-invite';
  bInvite.innerHTML = '\u{1F465} Meeting someone? <b>Add their spot</b>';
  bInvite.onclick = () => {
    planEditorOpen(true);
    (document.getElementById('addr-ghost') as HTMLInputElement | null)?.focus();
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
    const [p0, p1] = state.people;
    sum.textContent = isGroup()
      ? `${nPeople()} people · fair zone`
      : isSolo()
        ? `${p0.label || 'Set your location'} · ${MODE_LABEL[p0.mode].toLowerCase()}`
        : `${personLabel(0)}: ${p0.label || 'set address'} ↔ ${personLabel(1)}: ${p1.label || 'set address'}`;
    bInvite.hidden = !isSolo();
  };

  // Track viewport changes (URL-bar collapse, keyboard) instantly — animating
  // these made the sheet visibly slide around on its own mid-scroll.
  window.addEventListener('resize', () => sheetTo(pos, false));
  sheetTo('half', false); // first placement: don't animate from the CSS 50vh placeholder
  updatePlanBar();
}

// ── Near-me entry ────────────────────────────────────────────
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
      enterNearMe({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 'My location 📍', true);
    },
    () => {
      setStatus('Couldn’t get your location — type an address instead', 4000);
      (document.getElementById('addr-a') as HTMLInputElement | null)?.focus();
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
  // "Plan a meetup" → point them at the ghost slot; committing an address
  // there creates Person B and flips to the duo fair-zone view.
  hideIntro();
  planEditorOpen(true); // no-op on desktop; opens the sheet editor on mobile
  (document.getElementById('addr-ghost') as HTMLInputElement | null)?.focus();
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
renderDayparts();
wireBias();
renderCatFilters();
renderDietFilters();
renderSortChips();
renderPeople(); // people rows + markers + mode chrome, all from state

if (IS_MOBILE) buildMobileLayout();
if (!shared.a && !shared.b) {
  // First view = what's nearby: near-me at the default pin. Returning
  // visitors recenter via geolocation; first-timers get the intro CTA.
  if (localStorage.getItem(INTRO_SEEN)) locateMe(true);
}

// Shortlist collapses to a badge on phones so it doesn't bury the map.
{
  const panel = document.getElementById('shortlist')!;
  if (window.matchMedia('(max-width: 760px)').matches) panel.classList.add('collapsed');
  panel.querySelector('h3')!.addEventListener('click', () => panel.classList.toggle('collapsed'));
}

document.getElementById('share-link')!.onclick = async () => {
  syncUrlNow(); // flush the debounce — the copied link must be current
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus('Link copied — send it! 💌', 2400);
  } catch {
    setStatus('Copy blocked — grab the link from the address bar', 2800);
  }
};

scheduleRecompute();
