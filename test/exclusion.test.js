const test = require('node:test');
const assert = require('node:assert');
const X = require('../app/exclusion.js');

/* ---------- fixtures ---------- */

const fork = (id, day, dayOrder, order, options) =>
  ({ id, day, dayOrder, order, scope: 'fork', options });
const detail = (id, day, dayOrder, order, options) =>
  ({ id, day, dayOrder, order, scope: 'detail', options });
const opt = (id, group, extra) => Object.assign({ id, group }, extra);

/** Day 2 and Day 3 both offer Nokogiriyama — the real conflict in the trip data. */
function twoForks() {
  return [
    fork('d2', '2', 2, 10, [opt('okutama', 'okutama', { default: true }), opt('nokogiri-2', 'nokogiriyama')]),
    fork('d3', '3', 3, 10, [opt('mito', 'mito', { default: true }), opt('nokogiri-3', 'nokogiriyama')]),
  ];
}
const pick = (slotId, optionId, by) => ({ [slotId]: { option: optionId, at: 1, by: by || 'Angelo' } });

const find = (slots, slotId, optId) =>
  slots.find(s => s.id === slotId).options.find(o => o.id === optId);

/* ---------- consuming forward ---------- */

test('picking a destination greys it out on a later day', () => {
  const r = X.resolve(twoForks(), pick('d2', 'nokogiri-2'));
  const later = find(r, 'd3', 'nokogiri-3');
  assert.ok(later.doneBy, 'Day 3 Nokogiriyama should be marked done');
  assert.strictEqual(later.doneBy.day, '2', 'and should credit Day 2');
});

test('an option consumed by a LATER day stays available', () => {
  const r = X.resolve(twoForks(), pick('d3', 'nokogiri-3'));
  assert.strictEqual(find(r, 'd2', 'nokogiri-2').doneBy, null,
    'picking on Day 3 must not retroactively grey out Day 2');
});

test('a slot never greys out its own picked option', () => {
  const r = X.resolve(twoForks(), pick('d2', 'nokogiri-2'));
  const self = find(r, 'd2', 'nokogiri-2');
  assert.strictEqual(self.doneBy, null);
  assert.strictEqual(self.isPicked, true);
});

test('unrelated destinations are untouched', () => {
  const r = X.resolve(twoForks(), pick('d2', 'nokogiri-2'));
  assert.strictEqual(find(r, 'd3', 'mito').doneBy, null);
});

/* ---------- detail slots must not consume ---------- */

test('detail slots never consume — Okutama must not grey out its own afternoon', () => {
  const slots = [
    fork('d2-main', '2', 2, 10, [opt('okutama-day', 'okutama', { default: true })]),
    detail('d2-pm', '2', 2, 20, [opt('lake-okutama', 'okutama', { default: true })]),
    fork('d3-main', '3', 3, 10, [opt('okutama-again', 'okutama')]),
  ];
  const r = X.resolve(slots, {});
  assert.strictEqual(find(r, 'd2-pm', 'lake-okutama').doneBy, null,
    'the afternoon sub-stop must stay available');
  assert.ok(find(r, 'd3-main', 'okutama-again').doneBy,
    'but the Day 3 fork should still see Okutama as used');
});

test('a pick inside a detail slot consumes nothing', () => {
  const slots = [
    detail('d1-dinner', '1', 1, 40, [opt('nakano-food', 'nakano', { default: true })]),
    fork('drain', 'rain', 5, 10, [opt('nakano-rain', 'nakano')]),
  ];
  const r = X.resolve(slots, {});
  assert.strictEqual(find(r, 'drain', 'nakano-rain').doneBy, null);
});

/* ---------- same-day ordering ---------- */

test('within one day, an earlier fork consumes for a later fork', () => {
  const slots = [
    fork('a', '1', 1, 10, [opt('x', 'teamlab', { default: true })]),
    fork('b', '1', 1, 20, [opt('y', 'teamlab')]),
  ];
  const r = X.resolve(slots, {});
  assert.ok(find(r, 'b', 'y').doneBy, 'later slot on the same day should be greyed');
  assert.strictEqual(find(r, 'a', 'x').doneBy, null);
});

/* ---------- the Rain plan sorts last ---------- */

test('the rain plan inherits done-ness from earlier days', () => {
  const slots = [
    fork('d1', '1', 1, 30, [opt('teamlab-d1', 'teamlab', { default: true })]),
    fork('drain', 'rain', 5, 10, [opt('teamlab-rain', 'teamlab', { default: true })]),
  ];
  const r = X.resolve(slots, {});
  assert.ok(find(r, 'drain', 'teamlab-rain').doneBy);
  assert.strictEqual(find(r, 'drain', 'teamlab-rain').doneBy.day, '1');
});

test('a rain-plan pick never greys out a numbered day', () => {
  const slots = [
    fork('d1', '1', 1, 30, [opt('other', 'kawagoe', { default: true }), opt('teamlab-d1', 'teamlab')]),
    fork('drain', 'rain', 5, 10, [opt('teamlab-rain', 'teamlab', { default: true })]),
  ];
  const r = X.resolve(slots, {});
  assert.strictEqual(find(r, 'd1', 'teamlab-d1').doneBy, null);
});

/* ---------- travel modes ---------- */

test('options with no group never participate — taxi on Day 1 must not kill taxi on Day 4', () => {
  const slots = [
    fork('d1', '1', 1, 10, [opt('taxi-1', null, { default: true })]),
    fork('d4', '4', 4, 30, [opt('taxi-4', null, { default: true })]),
  ];
  const r = X.resolve(slots, {});
  assert.strictEqual(find(r, 'd4', 'taxi-4').doneBy, null);
});

/* ---------- defaults and robustness ---------- */

test('with no stored choices the defaults are what consume', () => {
  const r = X.resolve(twoForks(), {});
  assert.strictEqual(r.find(s => s.id === 'd2').picked, 'okutama');
  assert.strictEqual(find(r, 'd3', 'nokogiri-3').doneBy, null,
    'nothing picked Nokogiriyama, so Day 3 keeps it');
});

test('a stored choice pointing at a deleted option falls back to the default', () => {
  const r = X.resolve(twoForks(), pick('d2', 'option-that-no-longer-exists'));
  assert.strictEqual(r.find(s => s.id === 'd2').picked, 'okutama',
    'must not render a slot with nothing picked');
});

test('a slot with no default and no choice simply has none picked', () => {
  const slots = [fork('d1', '1', 1, 10, [opt('a', 'x'), opt('b', 'y')])];
  const r = X.resolve(slots, {});
  assert.strictEqual(r[0].picked, null);
});

test('alsoConsumes covers overlapping destinations', () => {
  const slots = [
    fork('d4', '4', 4, 10, [opt('kamakura-enoshima', 'kamakura', { default: true, alsoConsumes: ['enoshima'] })]),
    fork('d5', 'rain', 5, 10, [opt('enoshima-solo', 'enoshima')]),
  ];
  const r = X.resolve(slots, {});
  assert.ok(find(r, 'd5', 'enoshima-solo').doneBy,
    'picking Kamakura+Enoshima should consume standalone Enoshima too');
});

test('the earliest consumer is credited, not the latest', () => {
  const slots = [
    fork('d1', '1', 1, 10, [opt('k1', 'kawagoe', { default: true })]),
    fork('d2', '2', 2, 10, [opt('k2', 'kawagoe', { default: true })]),
    fork('d4', '4', 4, 10, [opt('k4', 'kawagoe')]),
  ];
  const r = X.resolve(slots, {});
  assert.strictEqual(find(r, 'd4', 'k4').doneBy.day, '1');
});

test('resolve does not mutate its inputs', () => {
  const slots = twoForks();
  const snapshot = JSON.stringify(slots);
  X.resolve(slots, pick('d2', 'nokogiri-2'));
  assert.strictEqual(JSON.stringify(slots), snapshot);
});

test('pickedBy is surfaced so the UI can say who chose it', () => {
  const r = X.resolve(twoForks(), pick('d2', 'nokogiri-2', 'Lea'));
  assert.strictEqual(r.find(s => s.id === 'd2').pickedBy, 'Lea');
});
