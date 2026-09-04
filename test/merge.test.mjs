import test from 'node:test';
import assert from 'node:assert';
import { mergeChoices } from '../worker/index.js';

const pick = (option, at, by) => ({ option, at, by });

test('a new slot is added', () => {
  const { choices, changed } = mergeChoices({}, { d2: pick('hakone', 100, 'Angelo') });
  assert.strictEqual(choices.d2.option, 'hakone');
  assert.strictEqual(changed, 1);
});

test('a newer pick for the same slot wins', () => {
  const cur = { d2: pick('okutama', 100, 'Lea') };
  const { choices } = mergeChoices(cur, { d2: pick('hakone', 200, 'Angelo') });
  assert.strictEqual(choices.d2.option, 'hakone');
  assert.strictEqual(choices.d2.by, 'Angelo');
});

test('an older pick for the same slot is rejected', () => {
  const cur = { d2: pick('hakone', 200, 'Angelo') };
  const { choices, changed } = mergeChoices(cur, { d2: pick('okutama', 100, 'Lea') });
  assert.strictEqual(choices.d2.option, 'hakone', 'a stale client must not clobber');
  assert.strictEqual(changed, 0);
});

test('THE KEY CASE — offline picks on different slots both survive', () => {
  // Angelo picks Day 2 on a train; Lea picks Day 3 with no signal. Both sync later.
  const server = {};
  const a = mergeChoices(server, { d2: pick('hakone', 100, 'Angelo') });
  const b = mergeChoices(a.choices, { d3: pick('nikko', 101, 'Lea') });
  assert.strictEqual(b.choices.d2.option, 'hakone', "Angelo's pick survives");
  assert.strictEqual(b.choices.d3.option, 'nikko', "Lea's pick survives");
  assert.strictEqual(Object.keys(b.choices).length, 2);
});

test('merge is order-independent for different slots', () => {
  const x = mergeChoices(mergeChoices({}, { d2: pick('hakone', 100, 'A') }).choices,
                         { d3: pick('nikko', 101, 'L') }).choices;
  const y = mergeChoices(mergeChoices({}, { d3: pick('nikko', 101, 'L') }).choices,
                         { d2: pick('hakone', 100, 'A') }).choices;
  assert.deepStrictEqual(x, y);
});

test('merge is idempotent — replaying a queued write changes nothing', () => {
  const first = mergeChoices({}, { d2: pick('hakone', 100, 'Angelo') });
  const again = mergeChoices(first.choices, { d2: pick('hakone', 100, 'Angelo') });
  assert.strictEqual(again.changed, 0, 'a replay must not bump the version');
  assert.deepStrictEqual(again.choices, first.choices);
});

test('a same-timestamp collision resolves deterministically', () => {
  const one = mergeChoices({ d2: pick('okutama', 100, 'Angelo') }, { d2: pick('hakone', 100, 'Lea') });
  const two = mergeChoices({ d2: pick('hakone', 100, 'Lea') }, { d2: pick('okutama', 100, 'Angelo') });
  assert.strictEqual(one.choices.d2.by, 'Lea', 'higher `by` wins');
  assert.strictEqual(two.choices.d2.by, 'Lea', 'and the same way regardless of arrival order');
});

test('an empty option clears the slot', () => {
  const { choices, changed } = mergeChoices({ d2: pick('hakone', 100, 'A') }, { d2: pick('', 200, 'A') });
  assert.strictEqual(choices.d2, undefined);
  assert.strictEqual(changed, 1);
});

test('clearing an already-empty slot is a no-op', () => {
  const { changed } = mergeChoices({}, { d2: pick('', 200, 'A') });
  assert.strictEqual(changed, 0);
});

test('unrelated existing slots are preserved', () => {
  const cur = { d1: pick('gyoen', 50, 'Lea'), d2: pick('okutama', 100, 'Lea') };
  const { choices } = mergeChoices(cur, { d3: pick('mito', 150, 'Angelo') });
  assert.strictEqual(choices.d1.option, 'gyoen');
  assert.strictEqual(choices.d2.option, 'okutama');
});

test('garbage entries are skipped, not crashed on', () => {
  const { choices } = mergeChoices({}, { d1: null, d2: 'nope', d3: pick('mito', 10, 'A') });
  assert.strictEqual(choices.d1, undefined);
  assert.strictEqual(choices.d2, undefined);
  assert.strictEqual(choices.d3.option, 'mito');
});

test('oversized strings are truncated rather than stored whole', () => {
  const { choices } = mergeChoices({}, { d1: pick('x'.repeat(500), 10, 'y'.repeat(500)) });
  assert.strictEqual(choices.d1.option.length, 120);
  assert.strictEqual(choices.d1.by.length, 40);
});

test('a missing timestamp is treated as 0 and loses to anything real', () => {
  const cur = { d2: pick('hakone', 100, 'Angelo') };
  const { choices } = mergeChoices(cur, { d2: { option: 'okutama', by: 'Lea' } });
  assert.strictEqual(choices.d2.option, 'hakone');
});

test('the input object is not mutated', () => {
  const cur = { d2: pick('okutama', 100, 'Lea') };
  const snapshot = JSON.stringify(cur);
  mergeChoices(cur, { d2: pick('hakone', 200, 'Angelo') });
  assert.strictEqual(JSON.stringify(cur), snapshot);
});
