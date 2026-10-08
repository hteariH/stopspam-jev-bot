import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, rows } from './helpers.js';
import * as clock from '../tgcloud/lib/clock.js';
import * as settings from '../tgcloud/lib/storage/settings.js';

beforeEach(fresh);

test('stamp writes the format the Python bot stored', () => {
  assert.equal(clock.stamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678))),
    '2026-01-02T03:04:05+00:00');
});

test('parse reads Python stamps, Z stamps and naive stamps as UTC', () => {
  const expected = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.equal(clock.parse('2026-01-02T03:04:05+00:00').getTime(), expected);
  assert.equal(clock.parse('2026-01-02T03:04:05Z').getTime(), expected);
  assert.equal(clock.parse('2026-01-02T03:04:05').getTime(), expected);
  assert.equal(clock.parse('2026-01-02T05:04:05+02:00').getTime(), expected);
  assert.equal(clock.parse('2026-01-02T03:04:05.123456+00:00').getTime(), expected + 123);
});

test('parse returns null for anything unreadable', () => {
  for (const bad of [null, undefined, '', 'garbage', '2026-13-45T99:99:99', 'not-a-date']) {
    assert.equal(clock.parse(bad), null, String(bad));
  }
});

test('stamps sort as strings in time order', () => {
  const a = clock.stamp(new Date(Date.UTC(2026, 0, 1, 23, 59, 59)));
  const b = clock.stamp(new Date(Date.UTC(2026, 0, 2, 0, 0, 0)));
  assert.ok(a < b);
});

test('the schema creates every table', () => {
  const names = rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((r) => r.name).filter((n) => n !== 'sqlite_sequence');
  assert.deepEqual(names, ['audit', 'billing', 'chats', 'payments', 'rate_events',
    'reviews', 'settings', 'trust']);
});

test('settings round-trip and overwrite', async () => {
  assert.equal(await settings.get('x'), null);
  await settings.set('x', 'one');
  await settings.set('x', 'two');
  assert.equal(await settings.get('x'), 'two');
});
