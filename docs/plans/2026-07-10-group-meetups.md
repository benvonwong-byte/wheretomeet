# Group Meetups Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the 2-person (A/B) fair-meeting app to 1–5 people, where 3+ uses a group "blend" fairness model (cap the longest trip, then minimize total), tuned by a Fairness↔Efficiency slider.

**Architecture:** Phase 1 mechanically renames `state.A`/`state.B` → `state.people[]` with **zero behavior change** (array always length 2, `solo` flag kept) so the 57-test suite + browser parity guard it. Phase 2 lets `people.length` vary 1–5, folds `solo` into `length===1`, adds a pure group-scoring layer, a single-hue fair-zone glow, the λ slider, and add/remove-people UI. Design: `docs/plans/2026-07-10-group-meetups-design.md`.

**Tech Stack:** Vite + TypeScript + Leaflet, vitest. Pure logic in `src/lib/*`, UI in `src/main.ts`.

---

## PHASE 1 — Refactor to `people[]`, zero behavior change

The whole phase is guarded by: `npx tsc --noEmit && npx vitest run` (57 green) and a browser parity check of near-me + duo. No new tests here — it's a rename; the existing suite IS the safety net.

### Task 1: Person type carries its own name; introduce `state.people`

**Files:** Modify `src/main.ts` (state block ~line 47-68), `src/lib/types.ts` if Person is shared (it's local to main.ts — keep it there).

**Step 1:** Change the `Person` interface to `{ pt: Pt; modes: Set<Mode>; name: string }`.

**Step 2:** Replace `A`/`B`/`nameA`/`nameB` in `state` with:
```ts
people: [
  { pt: { lat: 40.7143, lng: -73.9614 }, modes: new Set<Mode>(['transit']), name: '' },
  { pt: { lat: 40.787, lng: -73.9754 }, modes: new Set<Mode>(['transit']), name: '' },
] as Person[],
```
Keep `solo`, `bias`, everything else. Add accessors right after the state literal:
```ts
const A = () => state.people[0];
const B = () => state.people[1];
```

**Step 3:** `npx tsc --noEmit` — expect a wall of errors at every `state.A`/`state.B`/`state.nameA`/`state.nameB`. That error list is the task-2 worklist.

### Task 2: Rewrite every A/B touchpoint to `people[]` (index-keyed)

**Files:** `src/main.ts` (all ~111 touchpoints).

Mechanical mapping — apply consistently:
- `state.A` → `A()` / `state.people[0]`; `state.B` → `B()`.
- `state.nameA` → `state.people[0].name`; `state.nameB` → `state.people[1].name`.
- `personLabel('A')`/`personInitial('A')` → take an index: `personLabel(i: number)` returns `state.people[i].name || String.fromCharCode(65+i)` ("A","B"...). Update all callers.
- **Field cache keys:** `` `${who}:${mode}` `` where `who` was `'A'|'B'` → use the person **index**: `` `${i}:${mode}` `` / `` `${i}:${mode}:${daypart}` ``. Update `getField`, `upgradeField`, `clearPersonFields`, `swapPersons`'s rename map.
- **`getField(who, mode)`**, `upgradeField`, `clearPersonFields`, `coverageWarning`, `applyLocation`, `wireInput`, `renderModes`, `makePersonMarker`: change `who: 'A'|'B'` param to `i: number`.
- **`exactCache`:** `{ A: Map, B: Map }` → `exactCache: Map<string, number | null>[]` (array, `exactCache[i]`). Init `[new Map(), new Map()]`. Update every `exactCache.A`/`.B` and `effectiveCombos`/`refineVenues`.
- **`markers`:** `{ A, B }` → `markers: L.Marker[]` = `[makePersonMarker(0), makePersonMarker(1)]`. Update all `markers.A`/`.B`.
- **`bulletIcon(who)`**, `applyNames`, bullet-click name editing: index-based; DOM ids `bullet-a`/`bullet-b`, `addr-a`/`addr-b`, `name-a`/`name-b`, `modes-a`/`modes-b` stay as-is for now (map index 0→'a', 1→'b' via `` const slot = (i:number) => ['a','b'][i] ``).
- **`activeCombos`** (uses `state.A.modes`/`state.B.modes`): keep returning `{a,b}` combos from `people[0].modes × people[1].modes`; solo path uses `people[0]`.
- **`comboLayer`/`getField` call in `recompute`:** unchanged logic, now via `getField(0,...)`, `getField(1,...)`.
- **`drawContours`** `minPersonField(lastLayers, 'A'…)` — keep 'A'/'B' string in fairness.ts for phase 1 (comboLayer still has timesA/timesB). No change needed there.
- **`showDetail`/`renderVenues`/`renderShortlist`/`drawRoutes`/`syncUrl`/`swapPersons`/`soloUi`/`enterSolo`/`exitSolo`/mobile `updatePlanBar`/`b-invite`:** swap `state.A`→`A()`, `state.B`→`B()`, names accordingly.
- **`syncUrl`/`parseShare` hydration:** still `a=`/`b=`; write `A().pt`/`B().pt`, `people[0].name`/`people[1].name`. No format change in phase 1.

**Step (verify):** `npx tsc --noEmit` clean → `npx vitest run` 57 green → `npm run build` ok.

### Task 3: Browser parity check + commit

**Step 1:** `preview_start`; check **near-me (mobile default)**: solo boots, single times, closeness glow. Check **duo**: type B, advantage heat + dial return, detail shows 2 rows, swap works, share link round-trips.
**Step 2:** Commit: `Refactor A/B state to people[] array (no behavior change)`.

---

## PHASE 2 — Group model for 3–5 people

### Task 4: `groupScore` + `groupLayer` (pure, TDD)

**Files:** Create test in `src/lib/fairness.test.ts` (new) or append to `src/lib/engine.test.ts`; modify `src/lib/fairness.ts`, `src/lib/types.ts`.

**Step 1 — failing test** (append to `engine.test.ts`):
```ts
import { groupScore } from './fairness';
describe('groupScore (3+ people blend)', () => {
  it('λ=0 is minimax: ranks by the longest trip', () => {
    // Spot A balanced 24/26/28 (worst 28) beats Spot B 12/18/40 (worst 40)
    expect(groupScore([24,26,28], 0)).toBeGreaterThan(groupScore([12,18,40], 0));
  });
  it('λ=1 is efficient: ranks by total/mean', () => {
    // Spot B mean 23.3 beats Spot A mean 26
    expect(groupScore([12,18,40], 1)).toBeGreaterThan(groupScore([24,26,28], 1));
  });
  it('is monotonic decreasing in cost (more minutes = lower score)', () => {
    expect(groupScore([10,10,10], 0.5)).toBeGreaterThan(groupScore([30,30,30], 0.5));
  });
  it('ignores unreachable (Infinity) persons gracefully → 0', () => {
    expect(groupScore([10, Infinity, 12], 0.5)).toBe(0);
  });
});
```
**Step 2:** Run → fail (`groupScore` undefined).
**Step 3 — implement** in `fairness.ts`:
```ts
const GROUP_SCALE = 35;
/** Blend cost → score for N people. λ 0=minimax(worst), 1=efficient(mean). */
export function groupScore(times: number[], lambda: number): number {
  if (!times.length) return 0;
  let worst = 0, sum = 0;
  for (const t of times) {
    if (!isFinite(t)) return 0; // someone can't get there → not a group option
    if (t > worst) worst = t;
    sum += t;
  }
  const mean = sum / times.length;
  const cost = (1 - lambda) * worst + lambda * mean;
  return Math.exp(-cost / GROUP_SCALE);
}
```
**Step 4:** Run → 4 pass. **Step 5:** Commit `feat: groupScore blend for 3+ people`.

**Step 6 — groupLayer** (mirrors comboLayer for N fields). Add to `types.ts`:
```ts
export interface GroupLayer { scores: Float32Array; times: TimeField[]; }
```
Add to `fairness.ts`:
```ts
export function groupLayer(fields: TimeField[], lambda: number): GroupLayer {
  const cells = fields[0].length;
  const scores = new Float32Array(cells);
  const row: number[] = new Array(fields.length);
  for (let i = 0; i < cells; i++) {
    for (let p = 0; p < fields.length; p++) row[p] = fields[p][i];
    scores[i] = groupScore(row, lambda);
  }
  return { scores, times: fields };
}
```
Test: `groupLayer([f1,f2,f3], 0.3).scores[k]` equals `groupScore([f1[k],f2[k],f3[k]],0.3)`. Commit.

### Task 5: Fair-zone heat (single hue)

**Files:** Modify `src/lib/heat.ts`, `src/lib/heat` test.

**Step 1 — test:** `renderFairZone(scoreField, venueCells, grid)` returns a canvas of `grid.cols×grid.rows`; a high-score cell near a venue has alpha > a low-score cell. (Assert on `getImageData` alpha.)
**Step 2:** implement `renderFairZone` reusing the venue-anchored gaussian-glow structure of `renderHeat`, but color = fixed warm-green `[97,166,14]` with **alpha ∝ normalized score** (brightest at best). Export it.
**Step 3:** pass; commit `feat: single-hue fair-zone glow`.

### Task 6: Variable-length people + mode by headcount

**Files:** `src/main.ts`.

**Step 1:** Introduce `const mode = () => state.people.length === 1 ? 'solo' : state.people.length === 2 ? 'duo' : 'group';`. Replace reads of `state.solo` with `mode() === 'solo'`; keep writing behavior via add/remove (Task 8). `enterSolo`/`exitSolo` become "set people to length 1 / grow to 2".
**Step 2:** `recompute`: branch —
- `solo`: existing closeness path (people[0] field mirrored).
- `duo`: existing `comboLayer` directional path (unchanged).
- `group`: `lastGroup = groupLayer(state.people.map((_,i)=>getField(i, [...people[i].modes][0])), lambda())`.
Keep `lastLayers` for duo; add `lastGroup: GroupLayer | null` for group. `scoreAtPoint` for group samples each field at the venue cell (or uses refined exact times) → `groupScore`.
**Step 3:** `drawContours`: `group` → `renderFairZone(lastGroup.scores, shownVenueCells, GRID)`; `duo`/`solo` unchanged.
**Step 4:** verify duo/solo still identical (tsc + tests + browser). Commit.

### Task 7: Venue ranking, rows, detail for N people

**Files:** `src/main.ts`.

- **Ranking (group):** per venue build `times[] = people.map((p,i) => refined exact time or field sample)`; `finalScore = groupScore(times, lambda())`; `worst = max`, `total = sum`. Viability gate: `worst ≤ minWorst + 12`.
- **Row:** group → `⏱ {worst}′ longest · {total}′ total`; duo/solo unchanged.
- **Detail card:** group → one row per person color-coded (`personLabel(i)` · mode · time) + summary `worst / total`. Reuse the color palette (Task 8).
- Commit `feat: group ranking + N-person detail`.

### Task 8: Add/remove-people UI + 5-color palette + slider λ

**Files:** `src/main.ts`, `index.html`, `src/style.css`.

- **Palette:** `const PERSON_COLORS = ['#4f8f00','#7b2cbf','#009e8f','#e0662a','#2f6fd0'];` used in `bulletIcon`, markers, detail rows, CSS person dots. Extend `.bullet-a/.bullet-b` → generated inline styles by index.
- **Person list:** render `.person` rows from `state.people` into a container (`#people`); each row: bullet (color i), addr input, mode pills, name-on-tap; rows 1+ get a `×` remove. `＋ Add a person` button when `length < 5`: pushes a Person seeded at the map center, grows `exactCache`/`markers`, `renderPeople()`, recompute. Remove: splice person i, drop its marker/caches, recompute; if length hits 2→duo, 1→solo.
- **DOM ids:** move from fixed `addr-a/b` to `addr-p{i}` (update `wireInput`, `applyLocation`, `syncUrl`). Keep back-compat parse.
- **Slider:** in `group`, the `#bias` slider becomes λ (0–100 → 0–1, default 35); label swaps to "FAIR TO ALL ↔ LEAST TOTAL"; `oninput` sets `state.lambda` and `scheduleRecompute(true)`. In `duo` it stays the directional dial. Add `state.lambda: number` (0..1, default 0.35).
- **Swap:** hide at `length !== 2`.
- Commit `feat: add/remove people, 5-color palette, fairness slider`.

### Task 9: Generalized share links + back-compat (TDD)

**Files:** `src/lib/share.ts`, `src/lib/engine.test.ts`.

**Step 1 — tests:**
```ts
it('round-trips N people via p= params', () => {
  const h = encodeShare({ people: [{pt:{lat:40.71,lng:-73.96},mode:'transit',name:'Me'}, ...], lambda: 0.4, daypart:'midday', bias:0 });
  const s = parseShare(h);
  expect(s.people.length).toBe(3); expect(s.lambda).toBeCloseTo(0.4);
});
it('back-compat: old a=/b=/t= still loads as a 2-person directional plan', () => {
  const s = parseShare('#a=40.71,-73.96&b=40.78,-73.97&am=s&bm=c&t=10&d=m');
  expect(s.people.length).toBe(2); expect(s.bias).toBe(10);
});
```
**Step 2:** extend `ShareState` with `people?: {pt,mode,name}[]` and `lambda?`. Encode as `p=lat,lng,modeChar,name` repeated (or `p1=`,`p2=`…) + `l=` for λ*100. `parseShare`: if `p`-params present use them; else fall back to existing `a=/b=` → people[0..1] (with `am/bm/na/nb`). Keep `t=` (bias) and add `l=` (λ).
**Step 3:** hydrate `state.people` from `shared.people` in main.ts boot; `syncUrl` writes `p=`+`l=` when `length>2`, else keeps `a=/b=/t=` (so existing 2-person links stay stable). Commit.

### Task 10: Full verification + deploy

- `npx tsc --noEmit && npx vitest run` (all green) `&& npm run build`.
- Browser: 1/2/3/4/5 people — near-me, duo (parity), group glow + slider + ranking, add/remove, mobile sheet, share round-trip for a 3-person plan. Screenshot each.
- Adversarial code-review pass on the group scoring + share diff (Agent), fix findings.
- Commit, push, watch deploy, verify live bundle.

---

## Notes
- DRY: `personLabel(i)`, `PERSON_COLORS`, `slot(i)` are the shared helpers — no per-person copy-paste.
- YAGNI: no drag-reorder, no per-person handicaps (deferred), no >5 people.
- Performance: fields cached per index; a pin move recomputes one field. N≤5 hard cap.
- Each task ends green + committed; Phase 1 must be behavior-identical before Phase 2 begins.
