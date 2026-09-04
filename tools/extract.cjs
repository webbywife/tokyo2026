#!/usr/bin/env node
/*
 * One-time migration: parse the hand-written option cards out of itinerary.html
 * and the places array out of map.html, merge in tools/coords.json, and emit
 * trip-data.js.
 *
 * Kept in the repo because Lea may still be editing itinerary.html during the
 * cutover — re-run it to pick her changes up rather than merging by hand.
 *
 *   node tools/extract.cjs            # writes trip-data.generated.js
 *   node tools/extract.cjs --report   # prints a summary, writes nothing
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------- helpers ---------- */

const decode = s => s
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const slug = s => decode(s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const norm = s => decode(s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/** Return the substring of one <div ...> block starting at `open`, depth-aware. */
function blockAt(html, open) {
  const tag = /<\/?div\b/gi;
  tag.lastIndex = open;
  let depth = 0, m;
  while ((m = tag.exec(html))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(open, html.indexOf('>', m.index) + 1);
  }
  return html.slice(open);
}

/* ---------- inputs ---------- */

const itin = read('itinerary.html');
const mapf = read('map.html');
const manual = JSON.parse(read('tools/coords.json'));

// coords already living in map.html
const mapPlaces = [...mapf.matchAll(
  /\{\s*day:\s*(\d+),\s*time:"([^"]*)",\s*name:"([^"]*)",\s*lat:\s*([\d.]+),\s*lon:\s*([\d.]+)([^}]*)\}/g
)].map(m => ({
  day: +m[1], time: m[2], name: decode(m[3]),
  lat: +m[4], lon: +m[5],
  shop: /shop:\s*true/.test(m[6]),
  photo: (m[6].match(/photo:"([^"]*)"/) || [])[1] || null,
  transport: (m[6].match(/transport:"([^"]*)"/) || [])[1] || null,
  note: (m[6].match(/note:"([^"]*)"/) || [])[1] || null,
}));

/* coordinate lookup: map.html first (trip-specific), then coords.json */
const coordIndex = [
  ...mapPlaces.map(p => ({ key: norm(p.name), lat: p.lat, lon: p.lon, src: 'map.html' })),
  ...Object.entries(manual)
    .filter(([k, v]) => v && typeof v === 'object' && 'lat' in v)
    .map(([k, v]) => ({ key: norm(k), lat: v.lat, lon: v.lon, src: 'coords.json' })),
];

/* Explicit card-name -> coord-key overrides. Beats fuzzy matching every time. */
const ALIASES = Object.fromEntries(
  Object.entries(manual._aliases || {})
    .filter(([k]) => !k.startsWith('_'))
    .map(([card, key]) => [norm(card), norm(key)])
);

function findCoord(name) {
  const n = norm(name);
  const aliased = ALIASES[n];
  if (aliased) {
    const hit = coordIndex.find(c => c.key === aliased);
    if (hit) return { ...hit, how: 'alias' };
  }
  let hit = coordIndex.find(c => c.key === n);
  if (hit) return { ...hit, how: 'exact' };
  // prefix match on the first two significant words, both directions
  const key = n.split(' ').slice(0, 2).join(' ');
  if (key.length > 4) {
    hit = coordIndex.find(c => c.key.startsWith(key) || n.startsWith(c.key.split(' ').slice(0, 2).join(' ')));
    if (hit) return { ...hit, how: 'fuzzy' };
  }
  return null;
}

/* Options that are travel modes or filler, not destinations. No pin, ever. */
const NOT_A_PLACE = [
  /^taxi/i, /^straight to/i, /^wherever/i, /limousine bus/i, /^keiky/i,
  /^jr to shinagawa/i, /conbini haul/i, /^an aquarium$/i, /standing soba/i,
];
const isPlace = name => !NOT_A_PLACE.some(re => re.test(decode(name)));

/* Destinations that recur across days share a group so picking one consumes it. */
const GROUP_ALIASES = {
  'kawagoe': /kawagoe/i,
  'yokohama': /yokohama/i,
  'hakone': /hakone/i,
  'nikko': /nikk/i,
  'nokogiriyama': /nokogiriyama/i,
  'enoshima': /enoshima/i,
  'teamlab': /teamlab/i,
  'nakano': /nakano/i,
  'kamakura': /kamakura/i,
  'okutama': /okutama|nippara/i,
  'mito': /mito|kairakuen/i,
};
const groupFor = name => {
  const d = decode(name);
  for (const [g, re] of Object.entries(GROUP_ALIASES)) if (re.test(d)) return g;
  return slug(d);
};

/* ---------- parse the option grids ---------- */

const panels = [...itin.matchAll(/<div class="day-panel[^"]*" data-day="([^"]+)"/g)]
  .map(m => ({ day: m[1], start: m.index }));
panels.forEach((p, i) => { p.end = i + 1 < panels.length ? panels[i + 1].start : itin.length; });

/* The Rain plan substitutes for a washed-out day, so it sorts last: it inherits
 * "already done" from days 1-4 but never imposes anything back on them. */
const DAY_ORDER = { '1': 1, '2': 2, '3': 3, '4': 4, 'rain': 5 };

const slotOverrides = JSON.parse(read('tools/slots.json'));

const slots = [];
let unresolved = [];
let unknownSlots = [];

for (const panel of panels) {
  if (panel.day === 'budget') continue;
  const html = itin.slice(panel.start, panel.end);
  let order = 0;

  const gridPositions = [...html.matchAll(/<div class="opt-grid">/g)].map(m => m.index);

  for (const gpos of gridPositions) {
    const grid = blockAt(html, gpos);

    // nearest preceding .what heading = the slot's title
    const before = html.slice(0, gpos);
    const whats = [...before.matchAll(/<div class="what">([\s\S]*?)<\/div>/g)];
    const rawTitle = whats.length ? whats[whats.length - 1][1] : '';
    const title = decode(rawTitle.replace(/<span class="cost">[\s\S]*?<\/span>/, ''));
    const cost = decode((rawTitle.match(/<span class="cost">([\s\S]*?)<\/span>/) || [])[1] || '');

    // nearest preceding .time
    const times = [...before.matchAll(/<div class="time">([\s\S]*?)<\/div>/g)];
    const time = times.length ? decode(times[times.length - 1][1]) : null;

    order += 10;
    const slotId = `d${panel.day}-${slug(title) || 'pick'}-${order}`.replace(/--+/g, '-');

    const cardPositions = [...grid.matchAll(/<div class="opt-card[^"]*">/g)].map(m => m.index);
    const options = cardPositions.map(cpos => {
      const card = blockAt(grid, cpos);
      const name = decode((card.match(/<span class="opt-name">([\s\S]*?)<\/span>/) || [])[1] || '');
      if (!name) return null;

      const metaBlock = (card.match(/<div class="opt-meta">([\s\S]*?)<\/div>/) || [])[1] || '';
      const metas = [...metaBlock.matchAll(/<span>([\s\S]*?)<\/span>/g)].map(s => decode(s[1]));
      const note = decode((card.match(/<div class="opt-note">([\s\S]*?)<\/div>/) || [])[1] || '');
      const photo = (card.match(/<img class="stop-thumb" src="([^"]+)"/) || [])[1] || null;
      const pinQ = (card.match(/query=([^"&]+)/) || [])[1];

      // Travel modes and filler never take part in exclusion — picking a taxi on
      // Day 1 must not grey out the taxi on Day 4.
      const place = isPlace(name);

      const opt = {
        id: slug(name),
        group: place ? groupFor(name) : null,
        name,
        transport: metas[0] || null,
        cost: metas[1] || null,
        note: note || null,
        photo,
        default: /class="opt-card[^"]*\bpick\b/.test(card.slice(0, 60)),
      };

      if (place) {
        const c = findCoord(name) || (pinQ && findCoord(decodeURIComponent(pinQ.replace(/\+/g, ' '))));
        if (c) { opt.lat = c.lat; opt.lon = c.lon; opt._coordSrc = `${c.src}/${c.how}`; }
        else unresolved.push({ slot: slotId, name });
      } else {
        opt.pinnable = false;
      }
      return opt;
    }).filter(Boolean);

    if (!options.length) continue;

    const ov = slotOverrides[slotId] || {};
    if (!ov.scope) unknownSlots.push(slotId);

    slots.push({
      id: slotId,
      day: panel.day,
      dayOrder: DAY_ORDER[panel.day] ?? 99,
      order,
      // 'fork' consumes a destination group; 'detail' never does. Default to the
      // safe option: an uncurated slot must not silently grey things out.
      scope: ov.scope || 'detail',
      time,
      title: ov.title || title,
      cost,
      kind: 'choice',
      options,
    });
  }
}

/* ---------- make option ids unique ----------
 * The same card can appear on two days (Kawagoe, teamLab). The id addresses one
 * card so it needs a day suffix; `group` is what ties them together for exclusion.
 */
{
  const seen = {};
  for (const slot of slots) {
    for (const opt of slot.options) {
      const base = opt.id;
      seen[base] = (seen[base] || 0) + 1;
      if (seen[base] > 1) opt.id = `${base}-d${slot.day}`;
    }
  }
  // second pass: if a base collided at all, suffix the first one too
  const counts = {};
  slots.flatMap(s => s.options).forEach(o => {
    const base = o.id.replace(/-d(\d|rain)$/, '');
    counts[base] = (counts[base] || 0) + 1;
  });
  for (const slot of slots) {
    for (const opt of slot.options) {
      if (counts[opt.id] > 1) opt.id = `${opt.id}-d${slot.day}`;
    }
  }
}

/* ---------- report ---------- */

const allOpts = slots.flatMap(s => s.options);
const placeOpts = allOpts.filter(o => o.pinnable !== false);

console.log('=== EXTRACTION REPORT ===');
console.log(`day panels         : ${panels.filter(p => p.day !== 'budget').map(p => p.day).join(', ')}`);
console.log(`choice slots       : ${slots.length}`);
console.log(`options            : ${allOpts.length}`);
console.log(`  pinnable places  : ${placeOpts.length}`);
console.log(`  travel/filler    : ${allOpts.length - placeOpts.length} (no pin by design)`);
console.log(`  WITH coords      : ${placeOpts.filter(o => o.lat).length}`);
console.log(`  MISSING coords   : ${unresolved.length}`);
console.log(`defaults marked    : ${allOpts.filter(o => o.default).length}`);

console.log(`fork slots         : ${slots.filter(s => s.scope === 'fork').length} (these consume destinations)`);
console.log(`detail slots       : ${slots.filter(s => s.scope === 'detail').length} (these never do)`);

if (unknownSlots.length) {
  console.log(`\nUNCURATED SLOTS — add to tools/slots.json (defaulted to 'detail'):`);
  unknownSlots.forEach(s => console.log(`   ${s}`));
}

/* Only fork slots take part in exclusion, so only they can conflict. */
const forkOpts = slots.filter(s => s.scope === 'fork')
  .flatMap(s => s.options.filter(o => o.group).map(o => ({ ...o, day: s.day, slot: s.id })));

const byGroup = {};
forkOpts.forEach(o => (byGroup[o.group] = byGroup[o.group] || []).push(o));

const crossDay = Object.entries(byGroup)
  .map(([g, rows]) => ({ g, rows, days: [...new Set(rows.map(r => r.day))] }))
  .filter(x => x.days.length > 1);

console.log(`\nREAL cross-day exclusions (fork slots only):`);
crossDay.forEach(({ g, rows, days }) =>
  console.log(`   ${g.padEnd(14)} days ${days.join(' + ')}`));
if (!crossDay.length) console.log('   none');

const sameSlotDupes = Object.entries(byGroup)
  .filter(([, rows]) => new Set(rows.map(r => r.slot)).size < rows.length);
if (sameSlotDupes.length) {
  console.log(`\nWARNING — same group twice in one slot (a card would grey itself):`);
  sameSlotDupes.forEach(([g]) => console.log(`   ${g}`));
}

if (unresolved.length) {
  console.log(`\nMISSING COORDS — add to tools/coords.json:`);
  unresolved.forEach(u => console.log(`   [${u.slot}] ${u.name}`));
}

const idCounts = allOpts.reduce((a, o) => ((a[o.id] = (a[o.id] || 0) + 1), a), {});
const dupIds = Object.entries(idCounts).filter(([, n]) => n > 1);
if (dupIds.length) {
  console.log(`\nDUPLICATE option ids (need a day suffix to stay addressable):`);
  dupIds.forEach(([id, n]) => console.log(`   ${n}x  ${id}`));
}

/* ---------- emit ---------- */

if (!process.argv.includes('--report')) {
  const out = `/* GENERATED by tools/extract.cjs on ${new Date().toISOString().slice(0, 10)}.
 * Review by hand, then rename to trip-data.js. Do not edit both.
 */
window.TRIP_SLOTS = ${JSON.stringify(slots, null, 2)};
`;
  fs.writeFileSync(path.join(ROOT, 'trip-data.generated.js'), out);
  console.log(`\nwrote trip-data.generated.js (${(out.length / 1024).toFixed(1)} KB)`);
}
