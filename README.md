# Tokyo 2026 — Itinerary

A self-contained, static trip planner for a 4-day Tokyo + Hakone trip, **9–14 September 2026**
(MNL ⇄ HND, NAIA Terminal 1). Same layout and feature set as the `sk2026` itinerary.

**Live:** https://webbywife.github.io/tokyo2026/

## Files

| File | What it is |
| --- | --- |
| `itinerary.html` | The whole itinerary — one page, no build step. Boarding-pass header, stat tiles, per-day tabs (Day 1–4 + Budget), live weather, outfit photos, tap-to-pick option cards, budget worksheet. |
| `map.html` | Leaflet trip map — every stop as a day-coloured pin, shopping pins, train/bus pins, filter toggles, photo popups with Street View links. |
| `index.html` | Redirect to `itinerary.html`. |

## Trip shape

- **Day 1 · Thu 10 Sep** — Touchdown & slow Shinjuku (red-eye recovery: Shinjuku Gyoen, Meiji Jingu, free Gov't Building deck)
- **Day 2 · Fri 11 Sep** — Old Tokyo: Asakusa, Skytree, Ueno, Akihabara
- **Day 3 · Sat 12 Sep** — Day trip: the Hakone loop (Free Pass — mountain railway, ropeway, Lake Ashi pirate ship)
- **Day 4 · Sun 13 Sep** — Shibuya, teamLab & the late-night transfer to Haneda for the 01:00 flight
- **Budget** — editable per-person worksheet, USD line items, PHP total, doughnut chart

## Features (matches `sk2026`)

- Tabbed day switcher with prev/next navigation
- **Live weather** via [Open-Meteo](https://open-meteo.com/) (no API key) — falls back to seasonal averages outside the ~16-day window
- **Tap-to-pick option cards** — every time slot has 2–3 choices; picks persist in `localStorage`; "Reset my choices" clears them
- **Budget worksheet** — every figure editable; totals, per-day average, PHP conversion and chart update live (Chart.js)
- Outfit-idea photos with click-to-zoom lightbox
- Fully responsive; single file each, only external deps are Google Fonts, Chart.js, Leaflet, and OpenStreetMap tiles

## Editing

Everything is inline HTML/CSS/JS. To change a stop, edit the matching `.stop` block in `itinerary.html`.
To change a map pin, edit the `places` array in `map.html`. No install, no build — open the file in a browser.

Landmark photos are hot-linked from Wikimedia Commons; outfit photos from Pexels.
