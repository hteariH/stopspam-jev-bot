import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as tiers from '../tgcloud/lib/core/tiers.js';
import { stamp as toStamp, addSeconds } from '../tgcloud/lib/clock.js';

const NOW = new Date(Date.UTC(2026, 8, 21, 12, 0, 0));

function stamp({ days = 0, hours = 0 } = {}) {
  return toStamp(addSeconds(NOW, days * 86400 + hours * 3600));
}

// --- tier boundaries, exhaustively ---

for (const [count, expected] of [[0, tiers.FREE], [1, tiers.FREE], [200, tiers.FREE],
  [201, tiers.SMALL], [1000, tiers.SMALL], [1001, tiers.LARGE], [50000, tiers.LARGE]]) {
  test(`tier boundary at ${count}`, () => {
    assert.equal(tiers.tierFor(count), expected);
  });
}

// A billing lookup that never succeeded must not stop a group being moderated.
test('an unknown count reads as free', () => {
  assert.equal(tiers.tierFor(null), tiers.FREE);
});

test('prices match the spec', () => {
  assert.equal(tiers.priceFor(tiers.FREE), 0);
  assert.equal(tiers.priceFor(tiers.SMALL), 50);
  assert.equal(tiers.priceFor(tiers.LARGE), 250);
});

// --- entitlement ---

test('the free tier is always entitled even with nothing paid', () => {
  assert.deepEqual(tiers.entitled(tiers.FREE, { paidUntil: null, graceUntil: null, now: NOW }),
    [true, 'free_tier']);
});

test('a paid subscription entitles', () => {
  assert.deepEqual(tiers.entitled(tiers.LARGE, { paidUntil: stamp({ days: 5 }), graceUntil: null, now: NOW }),
    [true, 'subscribed']);
});

test('grace entitles when nothing is paid', () => {
  assert.deepEqual(tiers.entitled(tiers.SMALL, { paidUntil: null, graceUntil: stamp({ days: 3 }), now: NOW }),
    [true, 'grace']);
});

test('a subscription outranks grace', () => {
  assert.deepEqual(tiers.entitled(tiers.SMALL,
    { paidUntil: stamp({ days: 5 }), graceUntil: stamp({ days: 3 }), now: NOW }), [true, 'subscribed']);
});

test('an expired subscription and expired grace is not entitled', () => {
  assert.deepEqual(tiers.entitled(tiers.LARGE,
    { paidUntil: stamp({ days: -1 }), graceUntil: stamp({ days: -1 }), now: NOW }), [false, 'not_entitled']);
});

test('a paid tier with nothing at all is not entitled', () => {
  assert.deepEqual(tiers.entitled(tiers.SMALL, { paidUntil: null, graceUntil: null, now: NOW }),
    [false, 'not_entitled']);
});

// The boundary is strict: paid_until == now means the period is over.
test('expiry exactly now has expired', () => {
  assert.deepEqual(tiers.entitled(tiers.SMALL, { paidUntil: toStamp(NOW), graceUntil: null, now: NOW }),
    [false, 'not_entitled']);
});

// A malformed row is a bug to find in the log, not a crash in the
// moderation path. It reads as absent.
test('a corrupt timestamp does not raise', () => {
  assert.deepEqual(tiers.entitled(tiers.SMALL, { paidUntil: 'not-a-date', graceUntil: null, now: NOW }),
    [false, 'not_entitled']);
});

// --- Entitlement value ---

test('build carries the price of the tier', () => {
  const ent = tiers.build(tiers.LARGE, { paidUntil: null, graceUntil: null, now: NOW });
  assert.deepEqual([ent.tier, ent.active, ent.reason, ent.price], [tiers.LARGE, false, 'not_entitled', 250]);
});

test('build on the free tier has no price to show', () => {
  const ent = tiers.build(tiers.FREE, { paidUntil: null, graceUntil: null, now: NOW });
  assert.deepEqual([ent.active, ent.price], [true, 0]);
});

// --- staleness and countdown ---

test('a count never fetched is stale', () => {
  assert.equal(tiers.countIsStale(null, { now: NOW }), true);
});

test('a count fetched an hour ago is fresh', () => {
  assert.equal(tiers.countIsStale(stamp({ hours: -1 }), { now: NOW }), false);
});

test('a count fetched two days ago is stale', () => {
  assert.equal(tiers.countIsStale(stamp({ days: -2 }), { now: NOW }), true);
});

test('a corrupt fetch time counts as stale', () => {
  assert.equal(tiers.countIsStale('not-a-date', { now: NOW }), true);
});

test('days left rounds up so a partial day still counts', () => {
  assert.equal(tiers.daysLeft(stamp({ hours: 30 }), { now: NOW }), 2);
});

test('days left is zero once past', () => {
  assert.equal(tiers.daysLeft(stamp({ days: -1 }), { now: NOW }), 0);
  assert.equal(tiers.daysLeft(null, { now: NOW }), 0);
});
