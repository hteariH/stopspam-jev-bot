import { test } from 'node:test';
import assert from 'node:assert/strict';

import { t, STRINGS, LANGS } from '../tgcloud/lib/texts.js';
import { cardKeyboard, renderCard } from '../tgcloud/lib/core/cards.js';
import { Action, Decision } from '../tgcloud/lib/core/policy.js';
import { length } from '../tgcloud/lib/html.js';
import { SCAM } from './fixtures.js';

function card(overrides = {}) {
  return renderCard({ decision: Decision(Action.REVIEW, 0.93, 'grey_zone'), verdict: SCAM,
    authorName: 'Ann', authorId: 555, text: 'buy crypto now', chatTitle: 'Python Chat', lang: 'en',
    ...overrides });
}

const buttons = (markup) => markup.inline_keyboard.flat();

test('a card shows why it fired', () => {
  const body = card();
  for (const part of ['0.93', 'crypto', 'buy crypto now', 'Ann']) assert.ok(body.includes(part), part);
});

test('a card escapes HTML in user text', () => {
  const body = card({ decision: Decision(Action.REVIEW, 0.60, 'grey_zone'), authorName: '<b>Ann</b>',
    text: '<script>alert(1)</script>', chatTitle: 'G' });
  assert.ok(!body.includes('<script>'));
  assert.ok(body.includes('&lt;script&gt;'));
  assert.ok(!body.includes('<b>Ann</b>'));
});

test('a card truncates very long text', () => {
  const body = card({ text: 'x'.repeat(5000), chatTitle: 'G' });
  assert.ok(length(body) < 4096, 'must fit in one Telegram message');
});

test('the keyboard carries the review id', () => {
  assert.deepEqual(buttons(cardKeyboard(42, 'en')).map((b) => b.callback_data),
    ['rv:ban:42', 'rv:del:42', 'rv:ok:42']);
});

test('an unknown language falls back to English', () => {
  assert.equal(t('card_title', 'xx'), t('card_title', 'en'));
});

test('a card in Russian', () => {
  const body = card({ authorName: 'Анна', text: 'купи крипто', chatTitle: 'Python Чат', lang: 'ru' });
  for (const part of ['Похоже на спам', 'Автор', 'Чат', 'Риск', 'Тип', 'Разбор']) {
    assert.ok(body.includes(part), part);
  }
  const labels = buttons(cardKeyboard(42, 'ru')).map((b) => b.text);
  for (const label of ['Удалить и забанить', 'Удалить', 'Не спам']) assert.ok(labels.includes(label), label);
});

// All three truncation branches fire: each field one character over its cap.
test('the worst-case card stays under the Telegram limit', () => {
  const body = card({ decision: Decision(Action.REVIEW, 0.99, 'no_delete_permission'),
    authorName: '<'.repeat(129), authorId: 9999999999, text: '<'.repeat(501), chatTitle: '<'.repeat(129) });
  assert.ok(length(body) < 4096, `card length ${length(body)} exceeds the Telegram limit`);
  assert.equal(body.split('…').length - 1, 3);
});

test('the exact card layout matches the Python rendering', () => {
  assert.equal(card(), [
    '<b>Possible spam</b>',
    'Chat: Python Chat',
    'Author: Ann (<code>555</code>)',
    'Risk: 0.93 (grey_zone)',
    'Kind: crypto',
    '',
    '<b>Breakdown</b>',
    '<code>spam 0.98 · scam 0.99 · contact 1.00 · member 0.02\nseverity 2 (confidence 0.95)</code>',
    '',
    '<blockquote>buy crypto now</blockquote>',
  ].join('\n'));
});

// --- localisation coverage -------------------------------------------------

// A new key that lands without a translation is a silent English fallback.
test('every string exists in every language', () => {
  const missing = Object.entries(STRINGS)
    .filter(([, langs]) => LANGS.some((lang) => !(lang in langs)))
    .map(([key]) => key);
  assert.deepEqual(missing, []);
});

// Catches a placeholder pasted in instead of a real translation.
test('no translation is an untouched copy of the English', () => {
  const copied = Object.entries(STRINGS)
    .filter(([, langs]) => langs.uk === langs.en || langs.ru === langs.en)
    .map(([key]) => key);
  assert.deepEqual(copied, []);
});

test('the language cycle returns to English', () => {
  assert.equal(LANGS[0], 'en');
  assert.deepEqual([...LANGS].sort(), ['en', 'ru', 'uk']);
  const seen = [0, 1, 2, 3].map((step) => LANGS[(LANGS.indexOf('en') + step) % LANGS.length]);
  assert.deepEqual(seen, ['en', 'ru', 'uk', 'en']);
});

test('a Ukrainian card renders with Ukrainian labels', () => {
  const body = card({ decision: Decision(Action.REVIEW, 0.80, 'grey_zone'), chatTitle: 'G', lang: 'uk' });
  for (const key of ['card_title', 'card_author', 'card_risk', 'card_breakdown']) {
    assert.ok(body.includes(t(key, 'uk')), key);
  }
  assert.deepEqual(buttons(cardKeyboard(1, 'uk')).map((b) => b.text),
    [t('btn_ban', 'uk'), t('btn_delete', 'uk'), t('btn_not_spam', 'uk')]);
});

// createInvoiceLink rejects a title over 32 characters outright, which would
// make the product unbuyable in that language only.
test('the invoice title fits the 32-character limit in every language', () => {
  for (const lang of ['en', 'ru', 'uk']) {
    const n = length(t('invoice_title', lang));
    assert.ok(n >= 1 && n <= 32, lang);
  }
});

test('every billing key exists in every language', () => {
  const keys = ['card_not_entitled', 'btn_subscribe', 'menu_billing', 'billing_free',
    'billing_subscribed', 'billing_grace', 'billing_none', 'btn_start_deleting', 'invoice_title',
    'invoice_description', 'invoice_label', 'pay_thanks', 'pay_cancel_hint', 'pay_rejected',
    'pay_unrecorded', 'invoice_unavailable', 'notice_grace', 'notice_grace_ending', 'notice_lapsed'];
  for (const key of keys) {
    assert.ok(key in STRINGS, key);
    assert.deepEqual(Object.keys(STRINGS[key]).sort(), ['en', 'ru', 'uk'], key);
    assert.ok(['en', 'ru', 'uk'].every((lang) => STRINGS[key][lang].trim()), key);
  }
});

test('a not_entitled card says what would have happened', () => {
  const body = card({ decision: Decision(Action.REVIEW, 0.95, 'not_entitled'), lang: 'ru' });
  assert.ok(body.includes('подписки'));
});

test('an ordinary card does not mention subscriptions', () => {
  const body = card({ decision: Decision(Action.REVIEW, 0.60, 'grey_zone'), text: 'hello', lang: 'ru' });
  assert.ok(!body.includes('подписки'));
});

test('the subscribe button carries the price and a url', () => {
  const subscribe = buttons(cardKeyboard(42, 'ru', { subscribeUrl: 'https://t.me/x', stars: 250 }))
    .filter((b) => b.url === 'https://t.me/x');
  assert.equal(subscribe.length, 1);
  assert.ok(subscribe[0].text.includes('250'));
});

test('moderation buttons survive alongside the subscribe button', () => {
  const data = buttons(cardKeyboard(42, 'en', { subscribeUrl: 'https://t.me/x', stars: 50 }))
    .filter((b) => b.callback_data).map((b) => b.callback_data);
  assert.deepEqual(data, ['rv:ban:42', 'rv:del:42', 'rv:ok:42']);
});

// The review row failing to write must not also cost the sale.
test('a card with no review row can still offer the subscription', () => {
  const all = buttons(cardKeyboard(null, 'en', { subscribeUrl: 'https://t.me/x', stars: 50 }));
  assert.equal(all.length, 1);
  assert.equal(all[0].url, 'https://t.me/x');
});

test('no buttons at all returns null rather than an empty keyboard', () => {
  assert.equal(cardKeyboard(null, 'en'), null);
});

test('texts formats named fields and keeps unformatted templates verbatim', () => {
  assert.ok(t('btn_subscribe', 'en', { stars: 50 }).includes('50'));
  assert.equal(t('no_such_key'), 'no_such_key');
});
