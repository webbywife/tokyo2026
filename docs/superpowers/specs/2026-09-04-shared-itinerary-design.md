# Tokyo 2026 — shared, stateful itinerary

**Date:** 2026-09-04 · **Trip starts:** 2026-09-10 (6 days out) · **Users:** Angelo, Lea

## Problem

The itinerary is a static page. Four things it can't do:

1. Angelo and Lea can't see each other's picks. `localStorage` is per-browser by definition.
2. Picks don't survive. Clearing site data wipes the trip.
3. Picking Hakone on Day 2 still offers Hakone on Day 3. Nothing knows a choice was consumed.
4. Options have no coordinates. 53 of 67 cards link to a Google Maps *search string*; 14 have nothing.

One root cause: **trip content is hand-written HTML duplicated across two files.**

- `itinerary.html` — 67 option cards across 20 `.opt-grid` blocks
- `map.html` — a separate 64-entry `places` array

They drift (67 vs 64), and neither has stable identity. The choice engine stores
`saved[gridIndex] = cardIndex`, so a reordered card silently repoints every saved choice,
and there is no way to express "Hakone is taken."

## Approach

Extract places into one data file with stable IDs and coordinates. Render the option grids
and the maps from it. **Leave the hand-written prose alone.**

That last constraint is deliberate. Lea's voice is in the narrative stops, hiccup lists and
weather blocks, and there is a lot of it. Converting the option cards and map pins delivers
all four requirements; converting the prose would burn two of six days and risk the thing
that makes the page hers.

| Stays hand-written HTML | Becomes data |
| --- | --- |
| Prose timeline, hiccups, weather blocks, budget worksheet, boarding-pass header | The 67 option cards |
| Narrative `.stop` entries (gain a `data-place` hook) | The 64 map places |

## 1. Data model — `trip-data.js`

One array, plain objects, no build step. Two entry kinds.

```js
// Fixed stop — always happens, renders in the prose timeline and on the map
{ id:'hotel', day:1, time:'06:15', kind:'stop',
  name:'APA Hotel Shinjuku-Gyoemmae',
  lat:35.69003, lon:139.70892,
  note:'Home base, all 3 nights.' },

// Choice slot — 2-3 options, exactly one picked
{ id:'day2-main', day:2, order:10, time:'07:30', kind:'choice',
  title:'Pick your whole-day trip',
  options:[
    { id:'okutama', group:'okutama', name:'Okutama — Nippara caves',
      lat:35.8081, lon:139.0011, cost:'~¥2,100 rail + ¥900 caves',
      note:'Cool mountain air 90 minutes out.', photo:'…', default:true },
    { id:'hakone', group:'hakone', name:'Hakone',
      lat:35.2324, lon:139.1069, cost:'¥6,100 Free Pass', note:'…' },
  ]},
```

**`group` is the exclusion mechanism.** The same destination appearing on multiple days
shares a group. Picking `hakone` on Day 2 consumes group `hakone` everywhere later, with no
hand-maintained exclusion lists. Optional `alsoConsumes:['enoshima']` covers cross-destination
overlap (Kamakura+Enoshima eats standalone Enoshima).

Ordering is `(day, order)`. That is what makes "within the day or the next days" work.

### Editing contract

Lea edits this one file instead of two. Adding a stop no longer means separately editing the
map. Required per option: `id`, `group`, `name`, `lat`, `lon`. Everything else optional.
Documented in the README with a worked example.

## 2. Exclusion engine

Pure function, no I/O.

```
consumedGroups(choices, data) -> Map<group, {day, order, slotId}>
isDone(option, slot)          -> the consuming pick, if it is strictly earlier than slot
```

Strictly earlier means lower `day`, or same `day` and lower `order`. An option consumed by a
*later* slot is not done — you can still change your mind in either direction.

**Render:** dimmed but readable, `✓ Done on Day 2`, tappable. Tapping clears the *earlier*
pick, since un-consuming is the only coherent meaning of undo here.

Edge cases:
- A picked option is never dimmed in its own slot.
- If data changes under a stored choice (option id no longer exists), drop that choice and
  fall back to `default:true`. Never render a broken slot.
- Two slots on the same day with the same `order` is a data error; fail loudly in the console.

## 3. Shared state — Cloudflare Worker + KV

### Storage

One KV key, `tokyo2026`:

```js
{ version: 42,
  choices: {
    'day2-main': { option:'hakone', at:1789…, by:'Angelo' },
    'day3-main': { option:'mito',   at:1789…, by:'Lea' }
  }}
```

**Per-slot timestamps, not one blob.** If both pick different slots while offline, both
survive the merge; only a same-slot collision resolves last-write-wins. A single blob would
silently eat one person's picks, which is exactly the failure mode of two people on separate
trains with patchy signal.

### Merge

```
merge(local, remote) -> per slot, take the higher `at`; ties break on `by` (stable sort)
```

Commutative and idempotent, so replaying a queue of writes converges.

### Worker API

| Route | Behaviour |
| --- | --- |
| `GET /state` | Returns the doc + `ETag`. `If-None-Match` yields 304. |
| `PUT /state` | Requires `Authorization`. Merges the submitted slots, bumps `version`, returns the merged doc. |

Writes merge server-side rather than overwrite, so a stale client can never clobber.

### Auth, given a public repo

`webbywife/tokyo2026` is public, so **no token ships in the source.** First visit shows a
one-time pairing prompt: paste the trip key, pick your name (Angelo or Lea). Both go in
`localStorage`; the key signs writes. Two devices, entered once each.

Reads are open. The payload is a list of Tokyo day trips, and gating reads would mean
shipping a read token in public source, defeating the point.

Hardening (cheap, worth it): cap the payload, reject unknown slot ids, and keep the last 10
versions in KV so a bad write is recoverable.

### Offline

`localStorage` is what renders. Always, instantly. **The network only ever upgrades it.**

- Boot: paint from cache immediately, then fetch.
- Write: apply locally, enqueue, flush when online.
- Poll: every 15s while the tab is visible, plus on `focus` and `visibilitychange`, plus right
  after a write. ETag keeps a no-change poll at 304.
- Offline: queue survives reload in `localStorage`.

**Known caveat:** Workers KV is eventually consistent, up to ~60s to propagate globally. For
"which mountain are we going to on Friday" that is fine. Sub-second sync would require
Durable Objects; not worth the complexity here unless 60s proves annoying in practice.

## 4. Maps

Both maps render from `trip-data.js`.

- **Per-day map, embedded in each day tab.** Numbered pins in visit order, a polyline in that
  order, fitted to the day's bounds. Reflects live picks, so choosing Hakone redraws Day 2.
- **`map.html` stays the whole-trip view**, generated from the shared array instead of its own
  copy. The 67-vs-64 drift becomes structurally impossible.

All 67 options get real coordinates. Currently zero do.

**Caveat:** pins and routes work offline from cache, but Leaflet's OSM tiles need signal.
Offline tile packs are out of scope.

## 5. Hotel change

Hotel moved to **APA Hotel Shinjuku-Gyoemmae**, `35.69003, 139.70892` (Shinjuku 2-2-8),
0.86 km east of the Odakyu Century Southern Tower. Coordinate is block-level; OSM has no APA
buildings tagged in Shinjuku ward.

Closer now: Shinjuku-gyoemmae 4 min (was 16), Shinjuku-sanchome 7 (was 15), Gyoen 10 (was 14),
Thermae-Yu 11 (was 18).

Stale text to fix: TMG deck claims "~10-min walk", now 27. Bus arrival claims "steps from
Busta Shinjuku", now 13 min. Southern Terrace café claims "~2-min walk", now 15.

**Open questions for Angelo and Lea** (content, not code):
- Day 1 airport last leg. Limousine bus to Busta is now a 13-min walk with luggage after a
  red-eye. Marunouchi from Shinjuku-sanchome, or a taxi from Busta, likely beats it.
- Day-trip departures need +6 min. Day 2's 07:30 Hakone Free Pass deadline was sized for the
  old 9-minute walk.
- Early check-in for the 06:15 nap. APA is stricter than the Odakyu was.

## Testing

The two pure functions are where the real bugs live, so they get real unit tests:

- **Exclusion** — consumed-later is not done; consumed-earlier is; same-day ordering;
  self-slot never dims; missing option id falls back to default.
- **Merge** — per-slot wins; commutative; idempotent; offline queue replay converges.

Rendering is verified on a real mobile viewport, not just desktop. This gets used one-handed
on a train.

## Delivery order

Each stage ships standalone, so running out of runway still leaves the app better than today.

| | Work | Why this order |
| --- | --- | --- |
| 1 | `trip-data.js`; render option grids from it | Unblocks everything else |
| 2 | Per-day maps, ordered pins, routes; `map.html` off shared data | Most useful on the ground; works offline |
| 3 | Worker + KV, pairing, offline queue | Needs stable IDs from stage 1 |
| 4 | Exclusion engine + `✓ Done on Day N` | Needs stages 1 and 3 |
| 5 | Hotel text fixes, real-device pass | — |

## Risks

- **Lea is editing concurrently** (last commit 26h ago). Stage 1 restructures the option cards
  in `itinerary.html`. Needs a heads-up before starting, or we collide.
- **Committing straight to `main`**, which is what Pages serves. A bad push breaks the page
  she is actively using. Mitigation: verify locally before every push, keep commits small and
  revertable.
- **Six days.** Stages 1 and 2 are the core value; 3 and 4 are the ambitious half.
