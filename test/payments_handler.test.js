import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, rows, respond, logs, telegramError } from './helpers.js';
import { bot, calls } from './telegram.js';
import { dispatchMessage, dispatchPreCheckoutQuery } from '../tgcloud/lib/dispatch.js';
import * as payments from '../tgcloud/lib/handlers/payments.js';
import * as billing from '../tgcloud/lib/storage/billing.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import { parse } from '../tgcloud/lib/clock.js';

beforeEach(fresh);

function paymentMessage({ chargeId, payload, userId = 7, expiration = 1790000000, amount = null,
  chatType = 'private', chatId = null }) {
  const message = {
    message_id: 1, date: 1,
    chat: { id: chatId ?? (userId || 1), type: chatType },
    successful_payment: {
      currency: 'XTR',
      total_amount: amount ?? (Number(String(payload).split(':')[2]) || 0),
      invoice_payload: payload,
      telegram_payment_charge_id: chargeId,
      provider_payment_charge_id: 'prov_1',
      is_recurring: true,
    },
  };
  if (expiration !== null) message.successful_payment.subscription_expiration_date = expiration;
  if (userId !== null) message.from = { id: userId, is_bot: false, first_name: 'Payer' };
  return message;
}

const pay = (fields) => dispatchMessage(paymentMessage(fields), bot());
const replies = () => calls('sendMessage').map((p) => p.text);
const daysFromNow = (stamp) => (parse(stamp) - Date.now()) / 86400000;

test('a well-formed payload parses', () => {
  assert.deepEqual(payments.parsePayload('sub:-100123:50'), [-100123, 50]);
});

const MALFORMED = ['', 'sub', 'sub:-100123', 'sub:-100123:50:extra', 'buy:-100123:50',
  'sub:notanumber:50', 'sub:-100123:notanumber'];

for (const payload of MALFORMED) {
  test(`a malformed payload is refused: ${JSON.stringify(payload)}`, () => {
    assert.equal(payments.parsePayload(payload), null);
    assert.equal(payments.parseChatId(payload), null);
  });
}

// The amount is the only thing standing between a crafted invoice and a
// subscription bought for one star.
test('a price that is not one of ours is refused', () => {
  assert.equal(payments.parsePayload('sub:-100123:1'), null);
});

test('a chat id outside the SQLite integer range is refused', () => {
  assert.equal(payments.parsePayload(`sub:${2n ** 63n}:50`), null);
  assert.equal(payments.parseChatId(`sub:${2n ** 63n}:50`), null);
});

test('payload integers are read as Python int() reads them', () => {
  assert.equal(payments.parseChatId('sub: -100123 :50'), -100123);
  assert.equal(payments.parseChatId('sub:-100_123:50'), -100123);
  assert.equal(payments.parseChatId('sub:-100__123:50'), null);
  assert.equal(payments.parseChatId('sub:+5:50'), 5);
  assert.equal(payments.parseChatId('sub:1.5:50'), null);
});

test('a valid payment credits the chat and writes the ledger', async () => {
  await chats.ensureChat(-100123, 'Group');
  await pay({ chargeId: 'ch_1', payload: 'sub:-100123:50' });
  const row = await billing.get(-100123);
  assert.notEqual(row.paid_until, null);
  assert.equal(row.stars, 50);
  assert.equal(row.paid_until, '2026-09-21T14:13:20+00:00');
});

test('a redelivered payment grants nothing and stays quiet', async () => {
  await chats.ensureChat(-100123, 'Group');
  await pay({ chargeId: 'ch_1', payload: 'sub:-100123:50' });
  const paid = (await billing.get(-100123)).paid_until;
  const thanked = replies().length;
  await pay({ chargeId: 'ch_1', payload: 'sub:-100123:50', expiration: 1799999999 });
  assert.equal((await billing.get(-100123)).paid_until, paid);
  assert.equal(replies().length, thanked, 'a redelivery must not thank the user twice');
});

test('a payment for an unknown chat is still recorded', async () => {
  await pay({ chargeId: 'ch_9', payload: 'sub:-100777:250' });
  assert.notEqual((await billing.get(-100777)).paid_until, null);
});

// subscription_expiration_date is optional in the Bot API.
test('a payment with no expiry still grants thirty days', async () => {
  await chats.ensureChat(-100123, 'Group');
  await pay({ chargeId: 'ch_1', payload: 'sub:-100123:50', expiration: null });
  assert.ok(daysFromNow((await billing.get(-100123)).paid_until) >= 29);
});

// A bad timestamp must not escape before the ledger row is written.
test('a payment with an out-of-range expiry still records and grants thirty days', async () => {
  await chats.ensureChat(-100123, 'Group');
  await pay({ chargeId: 'ch_1', payload: 'sub:-100123:50', expiration: 99999999999999999999 });
  assert.equal((await billing.get(-100123)).stars, 50);
  assert.ok(daysFromNow((await billing.get(-100123)).paid_until) >= 29);
});

// Whether Telegram can deliver a successful_payment outside a private chat
// is undocumented, so a payment is recorded wherever it lands.
test('a successful payment from a group chat is still recorded', async () => {
  await chats.ensureChat(-100123, 'Group');
  await pay({ chargeId: 'ch_grp', payload: 'sub:-100123:50', chatType: 'supergroup', chatId: -100999 });
  assert.notEqual((await billing.get(-100123)).paid_until, null);
  assert.equal((await billing.get(-100123)).stars, 50);
});

function preCheckout(payload, currency, amount) {
  return { id: 'pcq_1', from: { id: 7, is_bot: false, first_name: 'P' }, currency,
    total_amount: amount, invoice_payload: payload };
}

test('pre-checkout accepts a valid invoice', async () => {
  await dispatchPreCheckoutQuery(preCheckout('sub:-100123:50', 'XTR', 50), bot());
  assert.deepEqual(calls('answerPreCheckoutQuery'), [{ pre_checkout_query_id: 'pcq_1', ok: true }]);
});

for (const [payload, currency, amount] of [['garbage', 'XTR', 50], ['sub:-100123:50', 'USD', 50],
  ['sub:-100123:50', 'XTR', 250]]) {
  test(`pre-checkout refuses ${payload} ${currency} ${amount}`, async () => {
    await dispatchPreCheckoutQuery(preCheckout(payload, currency, amount), bot());
    const [answer] = calls('answerPreCheckoutQuery');
    assert.equal(answer.ok, false);
    assert.ok(answer.error_message);
  });
}

// Telegram fails the payment if the query goes unanswered for ten seconds,
// so the handler must never raise on its way to answering.
test('pre-checkout never raises even when Telegram fails', async () => {
  respond('answerPreCheckoutQuery', telegramError('boom'));
  await payments.onPreCheckout(bot(), preCheckout('sub:-100123:50', 'XTR', 50));
});

// The money path validates the shape of a payload and nothing about what we
// charge today, because the price locks at subscribe time.
test('a chat id parses without judging the price', () => {
  assert.equal(payments.parseChatId('sub:-100123:50'), -100123);
  assert.equal(payments.parseChatId('sub:-100123:1'), -100123);
});

// Telegram keeps charging a renewing subscriber the amount their original
// invoice named, and a renewal sends no pre_checkout_query.
test('a renewal at a price we no longer sell is still credited', async () => {
  await chats.ensureChat(-100123, 'Group');
  await pay({ chargeId: 'ch_old_price', payload: 'sub:-100123:80', amount: 80 });
  const row = await billing.get(-100123);
  assert.notEqual(row.paid_until, null, 'an existing subscriber stopped being credited');
  assert.equal(row.stars, 80);
  assert.deepEqual(rows('SELECT stars FROM payments WHERE telegram_payment_charge_id = ?', 'ch_old_price'),
    [{ stars: 80 }]);
});

// The payload round-trips through the buyer's client; total_amount does not.
test("the amount recorded is Telegram's figure, not the payload's", async () => {
  await chats.ensureChat(-100123, 'Group');
  await pay({ chargeId: 'ch_amt', payload: 'sub:-100123:50', amount: 250 });
  assert.equal((await billing.get(-100123)).stars, 250);
});

// A channel post carries no `from`; the payment must still be recorded and
// the missing payer logged loudly with the charge id.
test('a payment with no from_user is still recorded', async () => {
  await chats.ensureChat(-100123, 'Group');
  await pay({ chargeId: 'ch_nouser', payload: 'sub:-100123:50', userId: null, chatType: 'channel', chatId: -100500 });
  assert.notEqual((await billing.get(-100123)).paid_until, null);
  assert.deepEqual(rows('SELECT payer_user_id FROM payments WHERE telegram_payment_charge_id = ?', 'ch_nouser'),
    [{ payer_user_id: 0 }]);
  assert.ok(logs.some((r) => r.level === 'error' && r.message.includes('ch_nouser')));
});

test('a payment with no from_user and a bad payload still logs the charge', async () => {
  await pay({ chargeId: 'ch_bad', payload: 'garbage', userId: null, expiration: null, chatType: 'channel', chatId: -100500 });
  assert.ok(logs.some((r) => r.level === 'error' && r.message.includes('ch_bad')));
});

// A group named "Dogs & Cats" would otherwise have its receipt rejected - the
// payer charged and never thanked.
test('the thank-you escapes a group title Telegram would reject', async () => {
  await chats.ensureChat(-100123, 'Dogs & Cats <b>');
  await pay({ chargeId: 'ch_esc', payload: 'sub:-100123:50' });
  assert.ok(replies().length, 'the payer was not thanked at all');
  assert.ok(replies()[0].includes('Dogs &amp; Cats &lt;b&gt;'));
  assert.ok(!replies()[0].includes('Dogs & Cats'));
});

test('a ledger written but a chat not credited is reported to the payer', async () => {
  const { failNext } = await import('./helpers.js');
  failNext(1, /INSERT INTO billing/);
  await pay({ chargeId: 'ch_half', payload: 'sub:-100123:50' });
  assert.equal(rows('SELECT * FROM payments').length, 1);
  assert.ok(logs.some((r) => r.level === 'error' && r.message.includes('ch_half')));
  assert.equal(replies().length, 1);
});
