# Tokyo 2026 — Itinerary

A self-contained, static trip planner for a **day-trip-focused** 4-day trip based in Tokyo,
**9–14 September 2026** (MNL ⇄ HND, NAIA Terminal 1). Same layout and feature set as the
`sk2026` itinerary.

**Live:** https://webbywife.github.io/tokyo2026/

## Files

| File | What it is |
| --- | --- |
| `itinerary.html` | The whole itinerary — one page, no build step. Boarding-pass header, stat tiles, "read the sky first" call-out, per-day tabs (Day 1–4 + Rain plan + Budget), per-destination live weather, outfit photos, tap-to-pick option cards, budget worksheet. |
| `map.html` | Leaflet trip map — every stop as a day-coloured pin (incl. a grey "Rain plan" layer), shopping pins, train/bus pins, filter toggles, photo popups with Street View links. Zoomed out to span Nikkō → Hakone → the Shōnan coast. |
| `index.html` | Redirect to `itinerary.html`. |

## Trip shape — repeat visit, so it lives outside the city

- **Day 1 · Thu 10 Sep** — Land + ease into **Yokohama** (red-eye recovery: nap, then Chinatown / harbour / museums — all indoors, weatherproof)
- **Day 2 · Fri 11 Sep** — **Hakone**: onsen, Ōwakudani ropeway, Lake Ashi pirate ship, open-air art museum (Free Pass)
- **Day 3 · Sat 12 Sep** — **Nikkō**: Tōshō-gū & the shrine complex, Rinnō-ji, Kegon Falls / Lake Chūzenji
- **Day 4 · Sun 13 Sep** — **Kamakura + Enoshima**: Great Buddha, Hasedera, the Enoden coast, Enoshima shrine & sea caves — then the late-night transfer to Haneda for the 01:00 flight
- **Rain plan** — weatherproof in-Tokyo swaps (teamLab, Ueno museums, Nakano Broadway, city onsen) for when a typhoon suspends the day-trip railways
- **Budget** — editable per-person worksheet, USD line items, PHP total, doughnut chart

Central Tokyo is deliberately just the evenings near Shinjuku + the Rain-plan tab.

## Weather handling (mid-September = tail of typhoon season)

- Each day's weather block pulls a **live per-destination forecast** (Open-Meteo, one call, four coordinates) — Yokohama, Hakone, Nikkō, Kamakura — not just central Tokyo.
- The hero has a **"read the sky first"** block: assign the clearest/calmest day to Hakone, a settled day to Nikkō, a light-rain-OK day to Kamakura, the worst day to Yokohama or the Rain plan. The tab order is only a default.
- Every day's hiccups list its own typhoon / line-suspension contingency (Odakyū, Tōbu, Enoden), and the budget carries a "$25 weather slack" line for rebooking a stormed-out trip.

## Features (matches `sk2026`)

- Tabbed switcher with prev/next navigation
- Live weather via [Open-Meteo](https://open-meteo.com/) (no API key), per destination
- Tap-to-pick option cards — picks persist in `localStorage` (`tokyoItineraryChoices_v2`); "Reset my choices" clears them
- Budget worksheet — every figure editable; totals, per-day average, PHP conversion and chart update live (Chart.js)
- Outfit-idea photos with click-to-zoom lightbox
- Single file each; external deps are only Google Fonts, Chart.js, Leaflet, and OpenStreetMap tiles

## Editing

Everything is inline HTML/CSS/JS. Edit the matching `.stop` block in `itinerary.html`, or the
`places` array in `map.html`. No install, no build — open the file in a browser.
Landmark photos are hot-linked from Wikimedia Commons (1280px thumbnails); outfit photos from Pexels.

---

## Where it's deployed

| What | URL |
| --- | --- |
| Site (Cloudflare Pages) | https://tokyo2026-8j9.pages.dev |
| Site (GitHub Pages, still live) | https://webbywife.github.io/tokyo2026/ |
| Shared-state API | https://tokyo2026-sync.jiggsfoo.workers.dev |

Both site URLs serve the same thing. GitHub Pages is deliberately left running so
existing links keep working.

## Autodeploy

Every push to `main` runs the tests, then deploys the site to Pages and the sync
worker to Cloudflare. See `.github/workflows/deploy.yml`.

**One-time setup — needs a Cloudflare API token:**

1. Go to https://dash.cloudflare.com/profile/api-tokens → *Create Token* → *Custom token*
2. Scope it to the **Jose Angelo Abarentos** account only, with:
   - Account · Cloudflare Pages · **Edit**
   - Account · Workers Scripts · **Edit**
   - Account · Workers KV Storage · **Edit**
3. Add it to the repo:
   ```sh
   gh secret set CLOUDFLARE_API_TOKEN --repo webbywife/tokyo2026
   ```

Until that secret exists the deploy jobs fail loudly (by design — better than
silently skipping and leaving you thinking it shipped).

## The shared trip key

Choices sync between phones through the worker. Reads are open; **writes need a
shared key**, which is a Worker secret and is never committed — the repo is public.

Each device asks for it once, then remembers it. The key lives locally in
`.trip-key` (gitignored). To rotate it:

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" > .trip-key
wrangler secret put TRIP_KEY < .trip-key
```

## Working on it

```sh
npm test              # 31 tests, no dependencies needed
npm run extract       # re-parse itinerary.html -> trip-data.generated.js
npm run extract:report  # what the extractor found, writes nothing
node tools/build.cjs  # assemble dist/ (explicit allowlist, not the repo root)

npm run deploy:worker # manual worker deploy
npm run deploy:site   # manual site deploy
```

### How the trip data works

`tools/extract.cjs` parses the option cards out of `itinerary.html` and the places
array out of `map.html` into one file, merging coordinates from `tools/coords.json`.
Re-run it after editing the HTML rather than hand-syncing two files.

`tools/slots.json` classifies each choice slot:

- **`fork`** — a whole-day destination. Picking it *consumes* that destination, so it
  shows as "Done on Day N" in every later fork.
- **`detail`** — a sub-choice inside a day you already committed to (which afternoon
  stop, how to reach the airport). These consume nothing.

That distinction matters: without it, picking the Okutama day trip would grey out
Okutama's own afternoon.
