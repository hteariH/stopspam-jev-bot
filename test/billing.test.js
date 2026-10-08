import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, exec, rows, failNext } from './helpers.js';
import * as billing from '../tgcloud/lib/storage/billing.js';
import * as config from '../tgcloud/lib/config.js';
import { parse } from '../tgcloud/lib/clock.js';

beforeEach(fresh);

const columns = (table) => new Set(rows(`PRAGMA table_info(${table})`).map((r) => r.name));

function pay(overrides = {}) {
  return billing.recordPayment({ chargeId: 'ch_1', chatId: -100123, payerUserId: 7, stars: 50,
    isRecurring: false, expiresAt: '2026-10-21T12:00:00+00:00', ...overrides });
}

test('the billing table has every column the design names', () => {
  assert.deepEqual(columns('billing'), new Set(['chat_id', 'member_count', 'member_count_at',
    'grace_until', 'paid_until', 'payer_user_id', 'stars', 'charge_id', 'notified_stage', 'updated_at']));
});

test('the payments table has every column the design names', () => {
  assert.deepEqual(columns('payments'), new Set(['telegram_payment_charge_id', 'chat_id',
    'payer_user_id', 'stars', 'is_recurring', 'expires_at', 'created_at']));
});

// Idempotency against redelivered updates rests on this.
test('the charge id is the payments primary key', () => {
  const primary = rows('PRAGMA table_info(payments)').filter((r) => r.pk).map((r) => r.name);
  assert.deepEqual(primary, ['telegram_payment_charge_id']);
});

test('tier constants match the spec', () => {
  assert.equal(config.FREE_MEMBER_LIMIT, 200);
  assert.equal(config.SMALL_MEMBER_LIMIT, 1000);
  assert.equal(config.PRICE_SMALL_STARS, 50);
  assert.equal(config.PRICE_LARGE_STARS, 250);
  assert.equal(config.GRACE_DAYS, 14);
  assert.equal(config.GRACE_WARN_DAYS, 3);
  assert.equal(config.MEMBER_COUNT_TTL_HOURS, 24);
});

// --- the billing row ---

// Callers on the moderation path must not have to branch on null.
test('an unknown chat reads as an empty row, not null', async () => {
  const row = await billing.get(-100999);
  assert.equal(row.chat_id, -100999);
  assert.equal(row.member_count, null);
  assert.equal(row.paid_until, null);
  assert.equal(row.grace_until, null);
  assert.equal(row.notified_stage, null);
});

test('empty is what a caller falls back to when the read fails', async () => {
  assert.deepEqual(billing.empty(-100123), await billing.get(-100123));
});

test('the member count round-trips and updates in place', async () => {
  await billing.setMemberCount(-100123, 640);
  let row = await billing.get(-100123);
  assert.equal(row.member_count, 640);
  assert.notEqual(row.member_count_at, null);
  await billing.setMemberCount(-100123, 1200);
  row = await billing.get(-100123);
  assert.equal(row.member_count, 1200);
});

// --- grace is written once, ever ---

test('startGrace writes a future timestamp', async () => {
  const value = await billing.startGrace(-100123);
  assert.ok(parse(value) > new Date());
  assert.equal((await billing.get(-100123)).grace_until, value);
});

// A group oscillating around 200 members must not farm free trials.
test('startGrace never overwrites an existing window', async () => {
  await billing.startGrace(-100123);
  const sentinel = '2099-01-01T00:00:00+00:00';
  exec('UPDATE billing SET grace_until = ? WHERE chat_id = ?', sentinel, -100123);
  assert.equal(await billing.startGrace(-100123), sentinel);
  assert.equal((await billing.get(-100123)).grace_until, sentinel);
});

test('startGrace preserves a member count already recorded', async () => {
  await billing.setMemberCount(-100123, 640);
  await billing.startGrace(-100123);
  assert.equal((await billing.get(-100123)).member_count, 640);
});

// --- the ledger ---

test('recording a payment credits the chat and returns true', async () => {
  assert.equal(await pay(), true);
  const row = await billing.get(-100123);
  assert.equal(row.paid_until, '2026-10-21T12:00:00+00:00');
  assert.equal(row.payer_user_id, 7);
  assert.equal(row.stars, 50);
  assert.equal(row.charge_id, 'ch_1');
});

// Telegram can redeliver an update. Without this guard one payment would
// grant sixty days.
test('a redelivered payment is ignored and grants nothing', async () => {
  await pay();
  assert.equal(await pay({ expiresAt: '2026-11-21T12:00:00+00:00' }), false);
  assert.equal((await billing.get(-100123)).paid_until, '2026-10-21T12:00:00+00:00');
});

test('a renewal has its own charge id and extends the subscription', async () => {
  await pay();
  assert.equal(await pay({ chargeId: 'ch_2', isRecurring: true, expiresAt: '2026-11-21T12:00:00+00:00' }), true);
  assert.equal((await billing.get(-100123)).paid_until, '2026-11-21T12:00:00+00:00');
});

test('every payment lands in the ledger', async () => {
  await pay();
  await pay({ chargeId: 'ch_2', isRecurring: true, expiresAt: '2026-11-21T12:00:00+00:00' });
  const ledger = rows(`SELECT telegram_payment_charge_id, is_recurring FROM payments
                       WHERE chat_id = ? ORDER BY created_at, telegram_payment_charge_id`, -100123);
  assert.deepEqual(ledger.map((r) => r.telegram_payment_charge_id), ['ch_1', 'ch_2']);
  assert.deepEqual(ledger.map((r) => r.is_recurring), [0, 1]);
});

// Grace is set once, ever - a payment must not clear it, or cancelling would
// hand back a second free trial.
test('paying does not consume the grace window', async () => {
  const grace = await billing.startGrace(-100123);
  await pay();
  assert.equal((await billing.get(-100123)).grace_until, grace);
});

// Money moved. The record is not optional.
test('a payment for a chat the bot has never seen is still recorded', async () => {
  assert.equal(await pay({ chargeId: 'ch_9', chatId: -100777, stars: 250 }), true);
  assert.equal((await billing.get(-100777)).paid_until, '2026-10-21T12:00:00+00:00');
});

// --- notice stages ---

test('the notified stage round-trips', async () => {
  await billing.setNotifiedStage(-100123, 'grace');
  assert.equal((await billing.get(-100123)).notified_stage, 'grace');
});

test('a payment clears the notice stage so a later lapse is announced', async () => {
  await billing.setNotifiedStage(-100123, 'lapsed');
  await pay();
  assert.equal((await billing.get(-100123)).notified_stage, null);
});

// The ledger is the only record that exists when a charge is disputed, so it
// must be durable before the billing upsert is even attempted, and survive
// the upsert failing.
test('the ledger row survives a failure to credit the chat', async () => {
  failNext(1, /INSERT INTO billing/);
  await assert.rejects(pay());
  assert.deepEqual(rows('SELECT chat_id, payer_user_id, stars FROM payments WHERE telegram_payment_charge_id = ?', 'ch_1'),
    [{ chat_id: -100123, payer_user_id: 7, stars: 50 }]);
});
