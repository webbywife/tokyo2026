#!/usr/bin/env node
/*
 * Assemble the deployable site into dist/.
 *
 * The repo also holds the spec, tests, the extractor and its data files, none of
 * which belong on a public CDN. Deploying the repo root would ship all of it plus
 * .git, so we copy an explicit allowlist instead.
 *
 *   node tools/build.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/* Explicit allowlist. Add here when a new served file appears. */
const FILES = ['index.html', 'itinerary.html', 'map.html', 'trip-data.js'];
const DIRS = ['app'];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

let copied = 0, skipped = [];

for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { skipped.push(f); continue; }
  fs.copyFileSync(src, path.join(DIST, f));
  copied++;
}

for (const d of DIRS) {
  const src = path.join(ROOT, d);
  if (!fs.existsSync(src)) { skipped.push(d + '/'); continue; }
  fs.cpSync(src, path.join(DIST, d), { recursive: true });
  copied += fs.readdirSync(src).length;
}

const size = f => {
  const p = path.join(DIST, f);
  return fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).reduce((n, x) => n + fs.statSync(path.join(p, x)).size, 0)
    : fs.statSync(p).size;
};

console.log('built dist/');
fs.readdirSync(DIST).forEach(f => console.log(`  ${(size(f) / 1024).toFixed(1).padStart(7)} KB  ${f}`));
if (skipped.length) console.log(`  (not present yet: ${skipped.join(', ')})`);
console.log(`\n${copied} item(s) copied`);
