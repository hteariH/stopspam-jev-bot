// Billing state per chat, and the append-only ledger of Stars payments.
//
// Kept apart from storage/chats on purpose: the moderation settings and the
// money are read by different code for different reasons.
import { db } from 'sdk';
import { sql } from 'sdk/db';

import * as config from '../config.js';
import { addDays, now, stamp } from '../clock.js';

const FIELDS = ['member_count', 'member_count_at', 'grace_until', 'paid_until',
  'payer_user_id', 'stars', 'charge_id', 'notified_stage'];

export function BillingRow(chatId, fields = {}) {
  const row = { chat_id: chatId };
  for (const name of FIELDS) row[name] = fields[name] ?? null;
  return Object.freeze(row);
}

// This chat's billing state, or an empty one.
//
// Returns a row rather than null so the moderation path never has to branch
// on absence: a chat nobody has ever paid for and a chat with no row are the
// same thing to every caller.
export async function get(chatId) {
  const row = await db.get(sql`SELECT * FROM billing WHERE chat_id = ${chatId}`);
  return row === null ? empty(chatId) : BillingRow(chatId, row);
}

// An all-null row, for a caller whose read failed.
export function empty(chatId) {
  return BillingRow(chatId);
}

export async function setMemberCount(chatId, count) {
  const at = stamp();
  await db.run(sql`INSERT INTO billing (chat_id, member_count, member_count_at, updated_at)
                   VALUES (${chatId}, ${count}, ${at}, ${at})
                   ON CONFLICT (chat_id) DO UPDATE SET
                     member_count    = excluded.member_count,
                     member_count_at = excluded.member_count_at,
                     updated_at      = excluded.updated_at`);
}

// Opens the free trial of enforcement, once and once only.
//
// The COALESCE is the whole point: a second call returns the window already
// in force rather than a fresh one, so a group crossing 200 members back and
// forth cannot farm an unbounded series of free trials. It is done in SQL
// rather than read-then-write so two concurrent messages cannot both decide
// the column is empty.
export async function startGrace(chatId) {
  const at = stamp();
  const proposed = stamp(addDays(now(), config.GRACE_DAYS));
  await db.run(sql`INSERT INTO billing (chat_id, grace_until, updated_at)
                   VALUES (${chatId}, ${proposed}, ${at})
                   ON CONFLICT (chat_id) DO UPDATE SET
                     grace_until = COALESCE(billing.grace_until, excluded.grace_until),
                     updated_at  = excluded.updated_at`);
  return (await get(chatId)).grace_until;
}

// Records one Stars payment and credits the chat.
//
// Returns false when this charge id has already been seen, in which case
// nothing at all is written: Telegram can redeliver an update, and without
// this guard one payment would grant sixty days.
//
// The ledger row is written on its own, before the chat is credited. That
// ordering is the whole point of this function: a failing credit must never
// take the ledger row down with it and leave a charge that moved real money
// with no record a dispute could be answered from. Crediting the chat is the
// recoverable half - a redelivery or a manual fix can still do it - so it is
// the half allowed to fail. Each statement commits on its own, so a throw
// from the second leaves the first in place.
export async function recordPayment({ chargeId, chatId, payerUserId, stars, isRecurring, expiresAt }) {
  const at = stamp();
  const ledger = await db.run(sql`INSERT OR IGNORE INTO payments (telegram_payment_charge_id, chat_id,
                                                                   payer_user_id, stars, is_recurring,
                                                                   expires_at, created_at)
                                  VALUES (${chargeId}, ${chatId}, ${payerUserId}, ${stars},
                                          ${isRecurring ? 1 : 0}, ${expiresAt}, ${at})`);
  if (ledger.rowsAffected === 0) return false;

  // grace_until is deliberately absent from the update list. It is set once,
  // ever - clearing it here would hand back a second free trial to anyone who
  // paid for one month and cancelled.
  await db.run(sql`INSERT INTO billing (chat_id, paid_until, payer_user_id, stars,
                                        charge_id, notified_stage, updated_at)
                   VALUES (${chatId}, ${expiresAt}, ${payerUserId}, ${stars}, ${chargeId}, NULL, ${at})
                   ON CONFLICT (chat_id) DO UPDATE SET
                     paid_until     = excluded.paid_until,
                     payer_user_id  = excluded.payer_user_id,
                     stars          = excluded.stars,
                     charge_id      = excluded.charge_id,
                     notified_stage = NULL,
                     updated_at     = excluded.updated_at`);
  return true;
}

export async function setNotifiedStage(chatId, stage) {
  const at = stamp();
  await db.run(sql`INSERT INTO billing (chat_id, notified_stage, updated_at)
                   VALUES (${chatId}, ${stage}, ${at})
                   ON CONFLICT (chat_id) DO UPDATE SET
                     notified_stage = excluded.notified_stage,
                     updated_at     = excluded.updated_at`);
}
