# WHERE2MEET — Design (as built)

Date: 2026-07-02. Portfolio/demo piece, NYC-only, built autonomously per user grant.

## Decisions (user-confirmed)

- **Scope**: portfolio/demo piece.
- **Fairness**: minimize travel-time difference between the two people ("most equal").
- **Modes**: per-person OR-checkboxes (subway/bike/car/walk). Full cross-product of A-modes × B-modes = fair-zone layers; heatmap = average of active layers; layers toggleable.
- **Vegan + tea filters are flagship.** HappyCow rejected: no public API, all GitHub scrapers dead since 2018 (Imperva). Sourced from OSM Overpass instead (`diet:vegan`, `shop=tea`, cuisine tags).
- **Travel engine**: research ranked TravelTime API #1 (only NYC transit isochrones), but it needs keys/signup. For the keyless demo: own engine — OSM subway graph + Dijkstra (transit), calibrated speed models (bike/car/walk). Provider-swappable via `timeField()`.
- **Map**: Leaflet + CARTO Positron (Google Maps requires key; swap later).

## Architecture

```
scripts/fetch-{venues,subway}.mjs  → src/data/*.json   (one-time Overpass bake)
src/lib/geo.ts        grid + haversine
src/lib/modes.ts      bike/car/walk speed models
src/lib/transit.ts    subway graph, Dijkstra, transit time field
src/lib/fairness.ts   score = exp(-(gap/12)²)·exp(-max/50); combo layers; averaging
src/lib/venues.ts     category + vegan/tea filtering
src/lib/heat.ts       score field → canvas (Leaflet ImageOverlay)
src/main.ts           state, Leaflet wiring, UI
```

Fields cached per (person, mode); invalidated on pin move. Grid 148×122 (~280 m cells) over NYC bbox.

## Validation

- 18 vitest tests (graph build, Dijkstra incl. float32-staleness regression, fairness monotonicity, filters).
- Smoke vs real trips: UnionSq→TimesSq 15′ (real 12–15), TimesSq→Astoria 29′ (real 25–30), ParkSlope→JacksonHts 62′ (real 55–70).

## Known limits (demo-grade)

- Transit model ignores schedules/service changes; uniform 4′ wait, 4′ transfers.
- Car speed is a citywide average (22 km/h + 7′ overhead), no live traffic.
- OSM tag noise (e.g. a bank café tagged `tea`). Venue quality = OSM quality.
- Nominatim rate limits: fine for demo, proxy for production.
