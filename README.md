# WHERE2MEET

Fair meeting zones for two people in New York City. Enter two addresses (or drag the A/B pins), pick each person's travel modes, and a heatmap shows where meeting is *fair* — where both arrive in similar time. Real vegan, tea, cafe, restaurant, and activity venues are ranked inside the hot zone.

## How it works

- **Fairness rule**: minimize the travel-time *gap* between the two people, damped by max time (`exp(-(gap/12)²) · exp(-max/50)`). The **balance dial** shifts the ideal gap ±20′ toward either person.
- **Layers**: each Person-A-mode × Person-B-mode pair is its own fair-zone layer (e.g. `A·BIKE × B·SUBWAY`). The heatmap is the average of active layers; toggle layers in the legend or by unchecking modes.
- **Transit**: built from the **official MTA GTFS schedule feed** — 496 stations, real segment run times (median of ~8,500 weekday trips), `transfers.txt` rules, and headway-derived waits that change with the time-of-day selector (rush/midday/evening/night). Boarding waits are charged per boarding, including at transfers, via a street/platform expanded graph. Validated against real trips (Times Sq→Astoria 31′ rush / 34′ night; real 25–30). Buses not yet modeled; walk access/egress uses a Manhattan-grid detour factor.
- **Bike / car / walk**: heatmap uses calibrated speed + detour-factor models; the **ranked venue list is refined with real street-network routing** (OSRM/Valhalla public servers, table API) when reachable — ⚡ marks routed times. Car includes parking overhead.
- **Venues**: 12,231 NYC venues baked from OSM Overpass — including 59 fully-vegan, 547 vegan-friendly, and 235 tea spots (`diet:vegan`, `shop=tea`, `cuisine` tags).
- **Geocoding**: Nominatim, NYC-biased. No API keys anywhere.

## Run

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # engine test suite
```

## Refresh data

```sh
npm run fetch:venues      # OSM Overpass → src/data/venues.json (drops closed-tagged places)
npm run fetch:subway      # OSM Overpass → src/data/subway.json
npm run enrich:wikidata   # free photos + descriptions for landmarks/museums (no key)
```

## Ratings, prices, photos, closed-status (needs a free-tier Google key)

Star ratings, review counts, `$$` price levels, storefront photos, and definitive
permanently-closed removal come from Google Places. One-time setup:

1. Create a key at console.cloud.google.com → enable **Places API (New)**
2. Put `GOOGLE_PLACES_API_KEY=...` in `.env.local`
3. `npm run enrich:google` — enriches the vegan + tea subset (~850 lookups,
   inside Google's monthly free tier) and removes closed venues.
   Add `--all` for every venue (12k+ calls, costs real money), `--desc` for
   editorial descriptions.

The UI renders stars/price/photos automatically once the data is present.

## Swapping in commercial APIs

The travel engine is a pure function `timeField(graph, origin, mode, grid)` — to use TravelTime API isochrones or Google Maps instead, replace that one call site behind a server proxy. Leaflet/CARTO tiles swap to Google Maps with an API key.

Data © OpenStreetMap contributors (ODbL). Travel times are estimates.
