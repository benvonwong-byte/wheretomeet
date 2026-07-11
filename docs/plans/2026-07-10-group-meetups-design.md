# Group Meetups — extending A/B to up to 5 people

Design v1 · 2026-07-10 · human-facing version: `2026-07-10-group-meetups-design.html`

## Decisions (locked with user)

1. **Fair = a blend.** First cap the longest single trip (minimax); among near-ties prefer the lowest total.
2. **Group dial = a Fairness ↔ Efficiency slider** (tunes the blend).
3. **2-person stays exactly as today.** Headcount picks the mode: 1 = near-me, 2 = A/B, 3–5 = group.
4. **Build both phases now** (plan first, then implement all).

## 1. Fairness math

At a candidate spot each person has a travel time. Summarize with `worst = max(tᵢ)` and `mean = Σtᵢ/N`.

```
cost(λ) = (1−λ)·worst + λ·mean      # λ=0 strict fairness (minimax) · λ=1 efficient (least total)
score   = exp(−cost / 35)           # higher = better; same shape as today's fairnessScore
```

The 2-person `exp(−total/45)·exp(−evenness²)` formula is untouched. The blend is the N≥3 generalization.

Worked example (3 people), default λ≈0.35:
- Spot A (balanced) 24/26/28 → worst 28, mean 26 → cost 27.3
- Spot B (one far) 12/18/40 → worst 40, mean 23 → cost 34.1
- λ=0 → A wins (28<40). λ=1 → B wins (23<26). The slider flips the winner. This example becomes a test fixture.

## 2. Three modes by headcount

| People | Mode | Scoring | Map | Slider |
|---|---|---|---|---|
| 1 | Near-me (existing solo) | closeness to you | closeness gradient | hidden |
| 2 | Duo (A/B, **unchanged**) | total × evenness + directional bias | green↔purple advantage heat | directional dial |
| 3–5 | Group (**new**) | blend (worst-cap + total) | single-hue fair-zone glow | fairness ↔ efficiency |

Same slider element and same heat overlay reused; they mean different things at 2 vs 3+.

## 3. Scoring & ranking (group)

- One travel-time field per person, keyed `${personId}:${mode}:${daypart}`, cached independently.
- Per venue: sample each field → model times; refine top spots with street-routed per-person times (per-person `exactCache`).
- Rank by blend `score`. Viability gate keys on `worst`: only surface venues where `worst ≤ bestWorst + ~12′`.
- Venue row: longest trip + total (e.g. `28′ longest · 78′ total`). Detail card: one color-coded row per person + a worst/total summary.

## 4. Map

- Person palette (white-ringed): P1 you green `#4f8f00`, P2 purple `#7b2cbf`, P3 teal `#009e8f`, P4 coral `#e0662a`, P5 blue `#2f6fd0`.
- Fair-zone glow (3+): venue-anchored heat as a single warm-green intensity (brightest = fairest). Map key "brighter = fairer for everyone." Shift toward gold if it competes with P1-green (fine-tune).

## 5. Slider

Same element as the A/B dial. Group mode: `λ ∈ [0,1]`, default ≈0.35 (leaning fair); drag re-scores + reshapes glow live. 2-person: stays directional dial.

## 6. UI — add/remove people

- Two fixed A/B blocks → a rendered list of person rows (address + mode pills + name-on-tap).
- `＋ Add a person` while count < 5. Each person past the first has a `×` remove.
- Person 1 = you, not removable. Removing to 2 → duo, to 1 → near-me; modes flip automatically.
- Swap button hides at 3+.
- Mobile: person list in the existing plan-editor sheet; "Add a friend" invite → "Add people."

## 7. Data model & share

- Refactor `state.A`/`state.B` → `state.people: Person[]` (index 0 = you). `people.length` drives the mode. Biggest change; ship behavior-preserving first.
- Share URL: repeated person param `p=lat,lng,mode,name` + `l=` for λ. Old `a=/b=/t=` links keep working (→ people[0..1] + directional bias).

## 8. Performance (machine crashes under load)

- Hard cap N ≤ 5. Fields cached per person → moving one pin recomputes one field.
- Route draws N legs on tap only; geometry cache dedups. Blend scoring O(cells × N), negligible. No new servers, no polling.

## 9. Testing

- `groupScore`: minimax at λ=0, mean at λ=1, monotonic; worked example as fixture.
- Viability gate on `worst`.
- Share round-trips N people + back-compat (old `a=/b=/t=` → 2-person directional).
- Headcount transitions 1↔2↔3 flip slider/heat/scoring.

## 10. Phasing

1. **Refactor to `people[]`, behavior-preserving.** No user-visible change; 1 and 2 identical to today; all tests green.
2. **Add the group model.** Blend scoring + fair-zone glow + fairness slider + add/remove UI + generalized share.

## 11. Risks & open questions

- A/B → people[] rename is broad → mitigated by behavior-preserving phase 1 + test suite.
- Glow hue vs person-green → shift toward gold if needed (implementation detail).
- Venue row density → longest+total keeps rows scannable; per-person one tap away.
- **Open (v1 default = fixed):** should the viability slack (~12′) tighten as the slider moves toward strict fairness? Leaning fixed.
