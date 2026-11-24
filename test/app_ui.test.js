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
  assert.equal(tr('en', 'no_such_key'), 'no_such_key');
});

test('the badge says what matters most', () => {
  assert.deepEqual(logic.badge({ observing: true, observe_days_left: 3, plan: 'none' }), { key: 'badge_observe', days: 3 });
  assert.deepEqual(logic.badge({ observing: false, plan: 'none' }), { key: 'badge_unpaid' });
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
  const view = { mode: 'observe', observing: true, lang: 'en', cards: { kind: 'unset', id: null } };
  assert.equal(logic.applyLocal(view, { lang: 'ru' }).lang, 'ru');
  assert.deepEqual(logic.applyLocal(view, { end_observe: true }), { ...view, mode: 'active', observing: false });
  assert.equal(logic.applyLocal(view, { log_to_me: true }).cards.kind, 'me');
  assert.equal(view.lang, 'en', 'the input view is not mutated');
});
