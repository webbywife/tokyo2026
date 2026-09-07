#!/usr/bin/env node
/*
 * Trace the rail corridors this trip actually uses out of OpenStreetMap, so the
 * per-day maps can draw the line the train really follows instead of a straight
 * dashed hop across the mountains.
 *
 *   node tools/rail.cjs            # fetch -> stitch -> clip -> simplify -> trip-routes.js
 *   node tools/rail.cjs --report   # say what it found, write nothing
 *
 * These are SHAPES ONLY. There is no timetable and no routing engine here: a
 * traced corridor tells you which way the track bends, never when a train runs
 * or whether it is running today. Live times stay with the transit deep links.
 *
 * Re-run when a corridor changes. Output is committed, so the site never calls
 * Overpass at runtime — it must work on a Tokyo platform with one bar.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = process.argv.includes('--report');
const DISCOVER = process.argv.includes('--discover');

/* Overpass is slow and rate-limits hard, and this tool is inherently iterative,
 * so responses are cached on disk. Delete the directory to force a refresh. */
const CACHE = path.join(__dirname, '.rail-cache');
const cacheKey = q => require('crypto').createHash('sha1').update(q).digest('hex').slice(0, 16) + '.json';
function cacheGet(q) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE, cacheKey(q)), 'utf8')); } catch (e) { return null; }
}
function cachePut(q, v) {
  try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(path.join(CACHE, cacheKey(q)), JSON.stringify(v)); }
  catch (e) {}
}

/* Overpass mirrors, in preference order. NOTE: overpass.osm.ch is deliberately
 * absent — it serves a Switzerland-only extract and answers Japanese queries
 * with a cheerful, valid, empty result. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = 'tokyo2026-trip-planner/1.0 (personal use; contact via github.com/jiggsfoo)';

/* Each corridor is one or more line-hops, hand-specified: this is the route we
 * are actually taking, not something a router guessed. `line` is matched against
 * the OSM route relation name; from/to are clipped to the nearest point on the
 * traced line, so station anchors only need to be roughly right. */
const CORRIDORS = [
  { id: 'd1-chofu', day: '1', label: 'Keiō Line · Shinjuku → Chōfu', color: '#C0362C',
    legs: [{ line: ['京王線'], from: [35.68990, 139.70055], to: [35.65190, 139.54402] }] },

  { id: 'd2-okutama', day: '2', label: 'JR Chūō + Ōme Line · Shinjuku → Okutama', color: '#A8641C',
    legs: [
      { line: ['中央本線', '中央線'], from: [35.68990, 139.70055], to: [35.69866, 139.41372] }, // Shinjuku → Tachikawa
      { line: ['青梅線'],             from: [35.69866, 139.41372], to: [35.80930, 139.09660] }, // Tachikawa → Okutama
    ] },

  { id: 'd3-mito', day: '3', label: 'JR Jōban Line · Ueno → Mito → Katsuta', color: '#2E7D4F',
    legs: [{ line: ['常磐線'], from: [35.71380, 139.77720], to: [36.38150, 140.53170] }] },

  { id: 'd4-kamakura', day: '4', label: 'JR Shōnan–Shinjuku Line · Shinjuku → Kamakura', color: '#6B4FB0',
    legs: [{ line: ['湘南新宿ライン', '横須賀線'], from: [35.68990, 139.70055], to: [35.31900, 139.55068] }] },

  { id: 'd4-enoden', day: '4', label: 'Enoden · Kamakura → Katase-Enoshima', color: '#6B4FB0',
    legs: [{ line: ['江ノ島電鉄'],                                      // Enoden Kamakura → Enoshima
             from: [35.31839, 139.55009], to: [35.31104, 139.48754] }] },

  { id: 'd4-odakyu', day: '4', label: 'Odakyū · Katase-Enoshima → Shinjuku', color: '#6B4FB0',
    legs: [
      { line: ['小田急電鉄江ノ島線', '小田急江ノ島線', '江ノ島線', '江の島線'],
        from: [35.30887, 139.48350], to: [35.53100, 139.43600] },   // Katase-Enoshima → Sagami-Ōno
      { line: ['小田急電鉄小田原線', '小田急小田原線', '小田原線'],
        from: [35.53100, 139.43600], to: [35.68990, 139.70055] },   // → Shinjuku
    ] },
];

/* ---------- overpass ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function overpass(query, attempt = 0) {
  const hit = cacheGet(query);
  if (hit) return hit;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
        body: query,
      });
      if (res.status === 429 || res.status === 504) continue;      // busy mirror, try the next
      if (!res.ok) continue;
      const json = JSON.parse(await res.text());
      if (json.elements) { cachePut(query, json.elements); return json.elements; }
    } catch (e) { /* try the next mirror */ }
  }
  if (attempt < 2) { await sleep(4000 * (attempt + 1)); return overpass(query, attempt + 1); }
  throw new Error('every Overpass mirror failed or rate-limited');
}

/**
 * Track geometry for a railway line. `patterns` is tried in order, because OSM
 * names these inconsistently — some carry the operator prefix, some don't, and
 * private lines are tagged route=train about as often as route=railway.
 */
const FURNITURE = /^(stop|platform|station|label|entrance|hail_and_ride)/;
/* A name match also drags in freight spurs (常磐線隅田川貨物線) and unrelated
 * branches (中央本線辰野支線, which is in Nagano). Those are not our train. */
const NOT_OUR_LINE = /(貨物|支線|回送|旧線)/;

async function lineGeometry(patterns) {
  for (const name of [].concat(patterns)) {
    const els = await overpass(`[out:json][timeout:240];` +
      `relation["type"="route"]["route"~"^(railway|train|light_rail)$"]["name"~"${name}"];out geom;`);
    /* One candidate PER RELATION, never pooled. A line is mapped as separate
     * up and down relations that touch at every station, so pooling lets the
     * stitcher hop tracks and come back — which is how the Jōban traced 186 km
     * against a real 121. */
    const candidates = [];
    for (const rel of els) {
      const relName = (rel.tags && rel.tags.name) || '(unnamed)';
      if (NOT_OUR_LINE.test(relName)) continue;
      const ways = [];
      for (const m of rel.members || []) {
        if (m.type !== 'way' || !m.geometry) continue;
        if (FURNITURE.test(m.role || '')) continue;   // keep the running line, drop the platforms
        ways.push(m.geometry.map(g => [g.lat, g.lon]));
      }
      if (ways.length) candidates.push({ name: relName, ways });
    }
    if (candidates.length) return { candidates, matched: name };
  }
  return { candidates: [], matched: null };
}

/** Raw track ways by operator in a box — for lines with no usable route relation. */
async function operatorGeometry(operator, bbox) {
  const els = await overpass(`[out:json][timeout:240];` +
    `way["railway"~"^(rail|tram|light_rail|narrow_gauge)$"]["operator"~"${operator}"]` +
    `(${bbox.join(',')});out geom;`);
  const ways = els.filter(w => w.geometry).map(w => w.geometry.map(g => [g.lat, g.lon]));
  return ways.length ? { candidates: [{ name: operator + ' (ways)', ways }], matched: operator }
                     : { candidates: [], matched: null };
}

/* ---------- geometry ---------- */

const EPS = 1e-7;
const same = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

/** Metres between two lat/lon points (equirectangular; fine at this scale). */
function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const x = (b[1] - a[1]) * rad * Math.cos((a[0] + b[0]) / 2 * rad);
  const y = (b[0] - a[0]) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

/** Join ways into the longest continuous chains they can form. */
function stitch(ways, joinTol) {
  joinTol = joinTol == null ? 12 : joinTol;
  const pool = ways.filter(w => w.length > 1).map(w => w.slice());
  const chains = [];
  while (pool.length) {
    let chain = pool.pop();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i];
        const head = chain[0], tail = chain[chain.length - 1];
        if (same(tail, w[0]))                     { chain = chain.concat(w.slice(1)); }
        else if (same(tail, w[w.length - 1]))     { chain = chain.concat(w.slice().reverse().slice(1)); }
        else if (same(head, w[w.length - 1]))     { chain = w.slice(0, -1).concat(chain); }
        else if (same(head, w[0]))                { chain = w.slice().reverse().slice(0, -1).concat(chain); }
        else continue;
        pool.splice(i, 1); grew = true; break;
      }
    }
    chains.push(chain);
  }

  /* Second pass: ways either side of a relation boundary often come within a
   * few metres without sharing a node, which is what leaves a line like the
   * Odakyū Odawara in 54 pieces. Join anything that nearly touches. */
  let joined = true;
  while (joined) {
    joined = false;
    outer:
    for (let i = 0; i < chains.length; i++) {
      for (let k = 0; k < chains.length; k++) {
        if (i === k) continue;
        const A = chains[i], B = chains[k];
        const ends = [
          [metres(A[A.length - 1], B[0]),               () => A.concat(B.slice(1))],
          [metres(A[A.length - 1], B[B.length - 1]),    () => A.concat(B.slice().reverse().slice(1))],
          [metres(A[0], B[B.length - 1]),               () => B.concat(A.slice(1))],
          [metres(A[0], B[0]),                          () => B.slice().reverse().concat(A.slice(1))],
        ].sort((x, y) => x[0] - y[0])[0];
        if (ends[0] > joinTol) continue;                // touching, not merely nearby
        chains[i] = ends[1]();
        chains.splice(k, 1);
        joined = true;
        break outer;
      }
    }
  }
  return chains.sort((a, b) => b.length - a.length);
}

const nearestIndex = (chain, pt) => {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < chain.length; i++) {
    const d = metres(chain[i], pt);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, dist: bestD };
};

/**
 * The chain that best carries this hop: both anchors must sit close to it, and
 * a double-tracked line yields two near-identical chains, so prefer the longer.
 */
function pickChain(chains, from, to) {
  let best = null;
  for (const c of chains) {
    if (c.length < 2) continue;
    const a = nearestIndex(c, from), b = nearestIndex(c, to);
    const worst = Math.max(a.dist, b.dist);
    if (worst > 3000) continue;                                  // not this track
    const span = Math.abs(b.index - a.index);
    if (!best || span > best.span) best = { chain: c, a, b, span, worst };
  }
  return best;
}

/** Douglas–Peucker, in metres. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const perp = (p, a, b) => {
    const A = metres(a, p), B = metres(b, p), C = metres(a, b);
    if (C < 1e-6) return A;
    const s = (A + B + C) / 2;
    const area = Math.max(0, s * (s - A) * (s - B) * (s - C));
    return 2 * Math.sqrt(area) / C;
  };
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let far = -1, farD = tolerance;
    for (let i = lo + 1; i < hi; i++) {
      const d = perp(points[i], points[lo], points[hi]);
      if (d > farD) { farD = d; far = i; }
    }
    if (far > 0) { keep[far] = true; stack.push([lo, far], [far, hi]); }
  }
  return points.filter((_, i) => keep[i]);
}

const lengthKm = pts => {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += metres(pts[i - 1], pts[i]);
  return m / 1000;
};

/* ---------- build ---------- */

(async () => {
  const out = [];
  const problems = [];

  for (const corridor of CORRIDORS) {
    const parts = [];
    let rawPoints = 0;

    for (const leg of corridor.legs) {
      let geo;
      try {
        geo = leg.operator ? await operatorGeometry(leg.operator, leg.bbox)
                           : await lineGeometry(leg.line);
      } catch (e) { problems.push(`${corridor.id}: ${leg.line || leg.operator} — ${e.message}`); continue; }

      const what = leg.operator || [].concat(leg.line).join(',');
      if (!geo.candidates.length) { problems.push(`${corridor.id}: no track geometry for ${what}`); continue; }

      /* Try every relation and keep the most DIRECT fit. Rail between two points
       * is rarely more than ~1.7x the straight line, so a longer trace means the
       * chain doubled back and should lose to a tighter one. */
      const crow = metres(leg.from, leg.to) / 1000;
      let best = null;
      for (const cand of geo.candidates) {
        const hit = pickChain(stitch(cand.ways, leg.joinTol), leg.from, leg.to);
        if (!hit) continue;
        const lo = Math.min(hit.a.index, hit.b.index), hi = Math.max(hit.a.index, hit.b.index);
        const seg = hit.chain.slice(lo, hi + 1);
        const km = lengthKm(seg);
        if (km / crow > 2.2) continue;                            // doubled back somewhere
        if (km < crow * 0.98) continue;                           // shorter than crow-flies = a fragment
        if (!best || km < best.km) best = { seg, km, worst: hit.worst, rev: hit.a.index > hit.b.index, name: cand.name };
      }
      if (!best) {
        problems.push(`${corridor.id}: ${what} — no candidate within 3 km of both anchors and ` +
                      `between 1.0x and 2.2x the ${crow.toFixed(1)} km straight line (${geo.candidates.length} tried)`);
        continue;
      }
      if (DISCOVER) console.log(`   "${geo.matched}" -> ${best.name}  ${best.km.toFixed(1)} km ` +
        `(${(best.km / crow).toFixed(2)}x crow) from ${geo.candidates.length} candidates`);

      const seg = best.rev ? best.seg.slice().reverse() : best.seg;  // always travel from -> to
      rawPoints += seg.length;
      parts.push({ line: what, points: seg, snap: Math.round(best.worst) });
      await sleep(1500);                                          // be a good Overpass citizen
    }

    if (!parts.length) continue;

    // Join the hops, then simplify once across the whole corridor.
    let path = [];
    for (const p of parts) path = path.length ? path.concat(p.points.slice(1)) : p.points.slice();
    const simplified = simplify(path, 35).map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]);

    out.push({
      id: corridor.id, day: corridor.day, label: corridor.label, color: corridor.color,
      from: corridor.legs[0].from, to: corridor.legs[corridor.legs.length - 1].to,
      km: +lengthKm(simplified).toFixed(1),
      path: simplified,
    });

    console.log(`${corridor.id.padEnd(13)} ${String(rawPoints).padStart(5)} pts -> ${String(simplified.length).padStart(4)} ` +
      `| ${String(lengthKm(simplified).toFixed(1)).padStart(6)} km | snap ${parts.map(p => p.snap + 'm').join('/')} | ${corridor.label}`);
  }

  if (problems.length) {
    console.log('\nPROBLEMS:');
    problems.forEach(p => console.log('   ' + p));
  }

  if (REPORT) { console.log('\n--report: nothing written'); return; }

  const body = `/* GENERATED by tools/rail.cjs on ${new Date().toISOString().slice(0, 10)}.
 * Real rail geometry from OpenStreetMap, © OpenStreetMap contributors (ODbL).
 *
 * SHAPES ONLY — these say which way the track bends, never when a train runs.
 * Live departures stay with the transit links in the popups. Re-run the tool to
 * refresh; the site never calls Overpass at runtime.
 */
window.TRIP_ROUTES = ${JSON.stringify(out, null, 1)};
`;
  fs.writeFileSync(path.join(ROOT, 'trip-routes.js'), body);
  console.log(`\nwrote trip-routes.js — ${out.length} corridors, ${(body.length / 1024).toFixed(1)} KB`);
})();
