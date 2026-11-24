import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh } from './helpers.js';
import * as app from '../tgcloud/lib/app.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as billing from '../tgcloud/lib/storage/billing.js';
import { addDays, stamp, now, _setNow } from '../tgcloud/lib/clock.js';
import * as config from '../tgcloud/lib/config.js';

const ADMIN = 777;
let chat;

beforeEach(async () => {
  fresh();
  chat = await chats.ensureChat(-100123, 'G');
});

const code = (fn) => {
  try { fn(); } catch (e) { return e.parameters && e.parameters.code; }
  return null;
};

test('fail throws an EndpointError with code and description', () => {
  assert.throws(
    () => app.fail('INVALID', 'chat_id'),
    (e) => e.name === 'EndpointError' && e.description === 'chat_id' && e.parameters?.code === 'INVALID',
  );
  assert.throws(
    () => app.fail('FORBIDDEN'),
    (e) => e.name === 'EndpointError' && e.description === 'FORBIDDEN' && e.parameters?.code === 'FORBIDDEN',
  );
});

test('requireUser returns the verified user id', () => {
  assert.equal(app.requireUser({ initData: { user: { id: ADMIN } } }), ADMIN);
});

test('requireUser refuses anything without init data', () => {
  for (const ctx of [undefined, {}, { ops: true }, { initData: {} }, { initData: { user: {} } },
    { initData: { user: { id: '777' } } }, { initData: { user: { id: 0 } } },
    { initData: { user: { id: -5 } } }]) {
    assert.equal(code(() => app.requireUser(ctx)), 'FORBIDDEN');
  }
});

test('chatIdOf accepts only a negative safe integer', () => {
  assert.equal(app.chatIdOf({ chat_id: -100123 }), -100123);
  for (const input of [undefined, {}, { chat_id: '-1' }, { chat_id: 0 }, { chat_id: 5 },
    { chat_id: -1.5 }, { chat_id: -(2 ** 60) }]) {
    assert.equal(code(() => app.chatIdOf(input)), 'INVALID');
  }
});

test('each accepted field maps to the stored column', () => {
  assert.deepEqual(app.changes(chat, { mode: 'active' }, ADMIN), { mode: 'active' });
  assert.deepEqual(app.changes(chat, { mode: 'observe' }, ADMIN), { mode: 'observe' });
  assert.deepEqual(app.changes(chat, { jev_enabled: false }, ADMIN), { jev_enabled: false });
  assert.deepEqual(app.changes(chat, { lang: 'uk' }, ADMIN), { lang: 'uk' });
  assert.deepEqual(app.changes(chat, { trust_after: 0 }, ADMIN), { trust_after: 0 });
  assert.deepEqual(app.changes(chat, { trust_after: 50 }, ADMIN), { trust_after: 50 });
  assert.deepEqual(app.changes(chat, { confidence_floor: 0.15 }, ADMIN), { confidence_floor: 0.15 });
  assert.deepEqual(app.changes(chat, { confidence_floor: 0 }, ADMIN), { confidence_floor: 0 });
  assert.deepEqual(app.changes(chat, { confidence_floor: 1 }, ADMIN), { confidence_floor: 1 });
  assert.deepEqual(app.changes(chat, { review_threshold: 0.3 }, ADMIN), { review_threshold: 0.3 });
  assert.deepEqual(app.changes(chat, { log_to_me: true }, ADMIN), { log_chat_id: ADMIN });
  _setNow(new Date(Date.UTC(2026, 0, 1)));
  const end = app.changes(chat, { end_observe: true }, ADMIN);
  assert.equal(end.mode, 'active');
  assert.equal(end.observe_until, stamp());
});

test('bad values are refused', () => {
  for (const fields of [
    null, [], {}, { mode: 'off' }, { jev_enabled: 1 }, { lang: 'de' },
    { delete_threshold: 1.05 }, { delete_threshold: -0.05 }, { delete_threshold: 0.93 },
    { delete_threshold: '0.9' }, { delete_threshold: Number.NaN },
    { trust_after: 51 }, { trust_after: -1 }, { trust_after: 2.5 },
    { log_to_me: false }, { end_observe: false }, { log_chat_id: 5 }, { title: 'x' }, { evil: 1 },
  ]) {
    assert.equal(code(() => app.changes(chat, fields, ADMIN)), 'INVALID', JSON.stringify(fields));
  }
});

test('review above delete is refused on the merged values', () => {
  // defaults: delete 0.90, review 0.55
  assert.equal(code(() => app.changes(chat, { review_threshold: 0.95 }, ADMIN)), 'INVALID');
  assert.equal(code(() => app.changes(chat, { delete_threshold: 0.5 }, ADMIN)), 'INVALID');
  assert.deepEqual(app.changes(chat, { delete_threshold: 0.5, review_threshold: 0.5 }, ADMIN),
    { delete_threshold: 0.5, review_threshold: 0.5 });
});

test('cardsView says where cards go, relative to the caller', () => {
  const at = (log_chat_id) => app.cardsView({ ...chat, log_chat_id }, ADMIN);
  assert.deepEqual(at(null), { kind: 'unset', id: null });
  assert.deepEqual(at(chat.chat_id), { kind: 'unset', id: null });
  assert.deepEqual(at(ADMIN), { kind: 'me', id: ADMIN });
  assert.deepEqual(at(999), { kind: 'dm', id: 999 });
  assert.deepEqual(at(-100777), { kind: 'group', id: -100777 });
});

test('planView names the plan', () => {
  const at = now();
  const row = (fields) => billing.BillingRow(-1, fields);
  assert.equal(app.planView(row({ member_count: 50 }), at).kind, 'free');
  assert.equal(app.planView(row({ member_count: 50 }), at).offer_stars, null);
  const none = app.planView(row({ member_count: 640 }), at);
  assert.equal(none.kind, 'none');
  assert.ok(none.offer_stars > 0);
  const paid = app.planView(row({ member_count: 640, paid_until: stamp(addDays(at, 10)) }), at);
  assert.deepEqual([paid.kind, paid.days, paid.offer_stars], ['subscribed', 10, null]);
  const grace = app.planView(row({ member_count: 640, grace_until: stamp(addDays(at, 3)) }), at);
  assert.equal(grace.kind, 'grace');
  assert.equal(grace.days, 3);
  assert.ok(grace.offer_stars > 0);
  const large = app.planView(row({ member_count: 1500 }), at);
  assert.equal(large.kind, 'none');
  assert.ok(large.offer_stars > none.offer_stars);
});

test('chatView carries every setting and the offer', () => {
  const paidTierRow = billing.BillingRow(chat.chat_id, { member_count: 640 });
  const view = app.chatView(chat, paidTierRow, ADMIN, 'https://t.me/$x');
  for (const key of ['chat_id', 'title', 'mode', 'observing', 'observe_days_left', 'jev_enabled',
    'delete_threshold', 'review_threshold', 'confidence_floor', 'trust_after', 'lang', 'cards',
    'plan', 'subscribe_url', 'subscribe_stars']) {
    assert.ok(key in view, key);
  }
  assert.equal(view.observing, true);
  assert.equal(view.observe_days_left, 7);
  assert.equal(view.subscribe_url, 'https://t.me/$x');
  assert.equal(view.subscribe_stars, view.plan.offer_stars);

  // Free tier suppresses any subscribe offer even if a URL was passed.
  const freeView = app.chatView(chat, billing.empty(chat.chat_id), ADMIN, 'https://t.me/$x');
  assert.equal(freeView.subscribe_url, null);
  assert.equal(freeView.subscribe_stars, null);

  // Empty title falls back to stringified chat_id.
  const untitled = app.chatView({ ...chat, title: '' }, billing.empty(chat.chat_id), ADMIN, null);
  assert.equal(untitled.title, String(chat.chat_id));
});

test('summaryView is the list entry', () => {
  assert.deepEqual(app.summaryView(chat, billing.empty(chat.chat_id)), {
    chat_id: chat.chat_id, title: 'G', mode: 'observe', observing: true, observe_days_left: 7, plan: 'free',
  });
});

test('planView carries the whole price list and the current tier', () => {
  const view = app.planView(billing.BillingRow(-1, { member_count: 640 }), now());
  assert.equal(view.tier, 'small');
  assert.deepEqual(view.tiers.map((t) => [t.tier, t.up_to, t.stars]), [
    ['free', config.FREE_MEMBER_LIMIT, null],
    ['small', config.SMALL_MEMBER_LIMIT, config.PRICE_SMALL_STARS],
    ['large', null, config.PRICE_LARGE_STARS],
  ]);
  assert.equal(view.grace_days, config.GRACE_DAYS);
});
