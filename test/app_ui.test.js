import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as logic from '../app/src/logic.js';
import { STRINGS, tr } from '../app/src/i18n.js';

test('the UI language follows the Telegram client, else English', () => {
  assert.equal(logic.uiLang('ru'), 'ru');
  assert.equal(logic.uiLang('uk'), 'uk');
  assert.equal(logic.uiLang('de'), 'en');
  assert.equal(logic.uiLang(undefined), 'en');
});

test('every string exists in every language', () => {
  const keys = Object.keys(STRINGS.en).sort();
  for (const lang of ['ru', 'uk']) assert.deepEqual(Object.keys(STRINGS[lang]).sort(), keys, lang);
});

test('tr fills placeholders and falls back to the key', () => {
  assert.equal(tr('en', 'badge_observe', { days: 3 }), 'observing · 3 days left');
  assert.equal(tr('en', 'badge_observe_only'), 'observing');
  assert.equal(tr('ru', 'badge_observe_only'), 'наблюдение');
  assert.equal(tr('uk', 'badge_observe_only'), 'спостереження');
  assert.equal(tr('en', 'no_such_key'), 'no_such_key');
});

test('the badge says what matters most, without saying 0 days left', () => {
  assert.deepEqual(logic.badge({ observing: true, observe_days_left: 3, plan: 'none' }), { key: 'badge_observe', days: 3 });
  assert.deepEqual(logic.badge({ observing: true, observe_days_left: 0, plan: 'none' }), { key: 'badge_observe_only' });
  assert.deepEqual(logic.badge({ observing: true, observe_days_left: null, plan: 'free' }), { key: 'badge_observe_only' });
  assert.deepEqual(logic.badge({ observing: false, plan: 'none' }), { key: 'badge_unpaid' });
  assert.deepEqual(logic.badge({ observing: false, plan: { kind: 'none' } }), { key: 'badge_unpaid' });
  assert.deepEqual(logic.badge({ observing: false, plan: 'free' }), { key: 'badge_active' });
});

test('endpoint error codes map to messages', () => {
  const endpoint = (code) => ({ type: 'ENDPOINT_ERROR', message: code, parameters: { code } });
  assert.equal(logic.errorKey(endpoint('NOT_ADMIN')), 'err_not_admin');
  assert.equal(logic.errorKey(endpoint('RATE_LIMITED')), 'err_rate_limited');
  assert.equal(logic.errorKey(endpoint('INVALID')), 'err_invalid');
  assert.equal(logic.errorKey(endpoint('NOT_FOUND')), 'err_not_found');
  assert.equal(logic.errorKey({ type: 'UNAUTHORIZED' }), 'err_generic');
  assert.equal(logic.errorKey(new Error('x')), 'err_generic');
  for (const key of ['err_not_admin', 'err_rate_limited', 'err_invalid', 'err_not_found', 'err_generic']) {
    assert.ok(key in STRINGS.en, key);
  }
});

test('cards and numbers are labelled', () => {
  assert.equal(logic.cardsKey({ kind: 'me' }), 'cards_me');
  assert.equal(logic.cardsKey({ kind: 'group' }), 'cards_group');
  assert.equal(logic.fmt(0.9), '0.90');
});

test('the optimistic view shows the change before the server answers', () => {
  const view = { mode: 'observe', observing: true, observe_days_left: 5, lang: 'en', cards: { kind: 'unset', id: null } };
  assert.equal(logic.applyLocal(view, { lang: 'ru' }).lang, 'ru');
  assert.deepEqual(logic.applyLocal(view, { end_observe: true }), {
    ...view,
    mode: 'active',
    observing: false,
    observe_days_left: 0,
  });
  assert.equal(logic.applyLocal(view, { mode: 'active' }).observing, true, 'still inside observation window');
  const pastWindow = { ...view, observe_days_left: 0 };
  assert.deepEqual(logic.applyLocal(pastWindow, { mode: 'active' }), {
    ...pastWindow,
    mode: 'active',
    observing: false,
  });
  assert.deepEqual(logic.applyLocal({ ...pastWindow, mode: 'active', observing: false }, { mode: 'observe' }), {
    ...pastWindow,
    mode: 'observe',
    observing: true,
  });
  assert.equal(logic.applyLocal(view, { log_to_me: true }).cards.kind, 'me');
  assert.equal(view.lang, 'en', 'the input view is not mutated');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

test('serialized saves layer pending edits without flickering or racing', async () => {
  const sent = [];
  const views = [];
  const synced = [];
  let savedCount = 0;
  const errors = [];

  const q = logic.createSaveQueue({
    send(fields) {
      const d = deferred();
      sent.push({ fields, ...d });
      return d.promise;
    },
    onView: (v) => views.push(v),
    onServerView: (v) => synced.push(v),
    onSaved: () => { savedCount += 1; },
    onError: (e) => errors.push(e),
  });

  q.setServerView({ chat_id: -1, trust_after: 5, lang: 'en', plan: { kind: 'free' } });
  assert.equal(views.at(-1).trust_after, 5);
  assert.equal(synced.length, 1);
  assert.equal(savedCount, 0);

  // Rapid +/+ on trust_after: second tap computes from rendered view (6 -> 7)
  // and waits in the queue until the first app_update finishes.
  q.save({ trust_after: views.at(-1).trust_after + 1 });
  assert.equal(views.at(-1).trust_after, 6);
  assert.equal(q.serverView.trust_after, 5, 'serverView is never updated from applyLocal');

  q.save({ trust_after: views.at(-1).trust_after + 1 });
  assert.equal(views.at(-1).trust_after, 7);

  await flush();
  assert.equal(sent.length, 1, 'second call waits for first to finish');
  assert.deepEqual(sent[0].fields, { trust_after: 6 });

  sent[0].resolve({ chat_id: -1, trust_after: 6, lang: 'en', plan: { kind: 'free' } });
  await flush();
  assert.equal(q.serverView.trust_after, 6);
  assert.equal(views.at(-1).trust_after, 7, 'does not flicker back to 6 while 7 is still pending');
  assert.equal(savedCount, 1);
  assert.equal(sent.length, 2, 'second call starts after first succeeds');
  assert.deepEqual(sent[1].fields, { trust_after: 7 });

  sent[1].resolve({ chat_id: -1, trust_after: 7, lang: 'en', plan: { kind: 'free' } });
  await flush();
  assert.equal(q.serverView.trust_after, 7);
  assert.equal(views.at(-1).trust_after, 7);
  assert.equal(savedCount, 2);
  assert.equal(synced.length, 3);
  assert.equal(errors.length, 0);
});

test('a failed save drops queued follow-ups and restores the last server view', async () => {
  const sent = [];
  let current = null;
  const errors = [];

  const q = logic.createSaveQueue({
    send(fields) {
      const d = deferred();
      sent.push({ fields, ...d });
      return d.promise;
    },
    onView: (v) => { current = v; },
    onError: (e) => errors.push(e),
  });

  q.setServerView({ chat_id: -1, trust_after: 5 });
  q.save({ trust_after: current.trust_after + 1 });
  q.save({ trust_after: current.trust_after + 1 });
  assert.equal(current.trust_after, 7);

  await flush();
  assert.equal(sent.length, 1);

  const boom = { type: 'ENDPOINT_ERROR', parameters: { code: 'RATE_LIMITED' } };
  sent[0].reject(boom);
  await flush();

  assert.equal(current.trust_after, 5, 'restores server view, not optimistic 6');
  assert.equal(sent.length, 1, 'queued follow-up was dropped without calling app_update');
  assert.deepEqual(errors, [boom]);

  // Next tap after recovery computes from 5 and succeeds normally.
  q.save({ trust_after: current.trust_after + 1 });
  await flush();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].fields, { trust_after: 6 });
  sent[1].resolve({ chat_id: -1, trust_after: 6 });
  await flush();

  // Failure after an earlier confirmed save rolls back to 6, not 5.
  q.save({ trust_after: current.trust_after + 1 });
  await flush();
  sent[2].reject(boom);
  await flush();
  assert.equal(current.trust_after, 6);
  assert.equal(errors.length, 2);
});

test('popup guard prevents overlapping popups and recovers from WebAppPopupOpened', () => {
  const runPopup = logic.createPopupGuard();
  const opened = [];
  let closeFirst;

  assert.equal(runPopup((done) => { opened.push('first'); closeFirst = done; }), true);
  assert.equal(runPopup((done) => { opened.push('second'); done(); }), false);
  assert.deepEqual(opened, ['first']);

  closeFirst();
  assert.equal(runPopup(() => { throw new Error('Popup is already opened'); }), false);
  assert.equal(runPopup((done) => { opened.push('third'); done(); }), true);
  assert.deepEqual(opened, ['first', 'third']);
});

test('syncChat patches the matching chat summary from a server view', () => {
  assert.equal(logic.syncChat(null, { chat_id: -1, plan: { kind: 'free' } }), null);
  const chats = [
    { chat_id: -1, title: 'Old', mode: 'observe', observing: true, observe_days_left: 5, plan: 'none' },
    { chat_id: -2, title: 'Other', mode: 'active', observing: false, observe_days_left: 0, plan: 'free' },
  ];
  const updated = logic.syncChat(chats, {
    chat_id: -1,
    title: 'New title',
    mode: 'active',
    observing: false,
    observe_days_left: 0,
    plan: { kind: 'subscribed', days: 30 },
  });
  assert.deepEqual(updated, [
    { chat_id: -1, title: 'New title', mode: 'active', observing: false, observe_days_left: 0, plan: 'subscribed' },
    chats[1],
  ]);
  assert.equal(chats[0].title, 'Old', 'input array is not mutated');
});

test('tierRows turns the price list into ranges and prices', () => {
  const rows = logic.tierRows([
    { tier: 'free', up_to: 200, stars: null },
    { tier: 'small', up_to: 1000, stars: 50 },
    { tier: 'large', up_to: null, stars: 250 },
  ], 'small');
  assert.deepEqual(rows.map((r) => [r.rangeKey, r.range, r.priceKey, r.price.stars, r.current]), [
    ['tier_free', { from: 1, to: 200 }, 'tier_price_free', null, false],
    ['tier_small', { from: 201, to: 1000 }, 'tier_price', 50, true],
    ['tier_large', { from: 1000 }, 'tier_price', 250, false],
  ]);
  assert.equal(tr('ru', rows[1].rangeKey, rows[1].range), '201–1000 участников');
  assert.deepEqual(logic.tierRows(undefined, 'free'), []);
});
