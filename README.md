# Tokyo 2026 — Itinerary

A self-contained, static trip planner for a **day-trip-focused** 4-day trip based in Tokyo,
**9–14 September 2026** (MNL ⇄ HND, NAIA Terminal 1). Same layout and feature set as the
`sk2026` itinerary.

**Live:** https://webbywife.github.io/tokyo2026/

## Files

| File | What it is |
| --- | --- |
| `itinerary.html` | The whole itinerary — one page, no build step. Boarding-pass header, stat tiles, "read the sky first" call-out, per-day tabs (Day 1–4 + Rain plan + Budget), per-destination live weather, outfit photos, tap-to-pick option cards, a shopping slot per evening, budget worksheet. |
| `map.html` | Leaflet trip map — every stop as a day-coloured pin (incl. a grey "Rain plan" layer), 🛍️ shopping pins, train/bus pins, filter toggles, photo popups with Street View links. Zoomed out to span Okutama → the Ibaraki coast → the Shōnan coast. |
| `index.html` | Redirect to `itinerary.html`. |

## Trip shape — repeat visit, so it goes where we haven't been

Hakone, Nikkō and Yokohama are all *done*, so they survive only as "(revisit)" cards
on the day forks. The defaults go somewhere new:

- **Day 1 · Thu 10 Sep** — Land 04:45, bag drop 07:15, then **Chōfu** (Jindai-ji temple, soba, the botanical gardens) to fill the seven-hour gap before a 15:00 check-in; a short ease-in outing near Shinjuku after
- **Day 2 · Fri 11 Sep** — **Okutama**: Nippara limestone caves (11 °C in any weather), Hatonosu gorge, Lake Okutama
- **Day 3 · Sat 12 Sep** — **Mito**: Kairakuen (one of the three great gardens) + Hitachi Seaside Park's kochia hills, the Ōarai sea torii
- **Day 4 · Sun 13 Sep** — **Kamakura + Enoshima**: Great Buddha, Hasedera, the Enoden coast, Enoshima shrine & sea caves — then the late-night transfer to Haneda for the 01:00 flight
- **Rain plan** — weatherproof in-Tokyo swaps (teamLab, Ueno museums, Nakano Broadway, city onsen) for when a typhoon suspends the day-trip railways
- **Budget** — editable per-person worksheet, USD line items, PHP total, doughnut chart

Central Tokyo is deliberately just the evenings near Shinjuku + the Rain-plan tab.

## Shopping

Every evening carries one shopping slot, placed where it actually fits the geography
and the closing times — the point being that most of it shuts at 20:00 while the
electronics floors run to 22:00 and Don Quijote never closes.

| Day | Slot | What |
| --- | --- | --- |
| 1 | 21:00 | Electronics scouting — Yodobashi Shinjuku West, BIC Camera, Don Quijote |
| 2 | 18:30 | Stationery & clothes — Sekaido, Loft, Beams Japan, Uniqlo/GU |
| 3 | 18:45 | Food to bring home — Ameyoko at Ueno (the express lands there), Mito nattō & hoshi-imo |
| 4 | 19:45 | The take-home haul — Don Quijote, Isetan depachika, plus Kamakura hato sabure earlier |

Day 1 is deliberately a *pricing* run, not a buying one: you scout, then buy on Day 4
once you know what fits in the bag. Tax-free is 10% off, ¥5,000 minimum, per store
per day — so purchases want clustering. The budget tab has a **Shopping & omiyage**
category to match.

## Weather handling (mid-September = tail of typhoon season)

- Each day's weather block pulls a **live per-destination forecast** (Open-Meteo, one call, four coordinates) — Tokyo, Okutama, Mito & the Ibaraki coast, Kamakura — not just central Tokyo.
- The hero has a **"read the sky first"** block: put the wind-sensitive trip (Nokogiriyama's ropeway, or Hakone's) on the calmest day, **Mito** on the driest (it's wide open, with little shelter), and **Okutama** on the wettest — the cave holds 11 °C whatever the sky is doing. The tab order is only a default.
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
