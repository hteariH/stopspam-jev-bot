// Grey-zone queue. Text expires after the TTL; the human label does not.
import { db } from 'sdk';
import { sql } from 'sdk/db';

import * as config from '../config.js';
import { addDays, now, stamp } from '../clock.js';
import { isProgrammingError } from '../core/guards.js';
import { logger } from '../log.js';

const log = logger('stopspam.reviews');

// Erases expired text whenever new text is stored.
//
// Tying the purge to create() ties erasure to the event that creates the
// debt: no new message text is stored without expired text being cleared in
// the same call. The group handler also purges at the start of every group
// update, which is what erases text in a group that has gone quiet - there
// is no background loop on the platform.
//
// A failure here must not lose the review row that was just written, so it
// is logged rather than raised; the next update will try again.
async function purgeOnTheWayPast() {
  let cleared;
  try {
    cleared = await purgeExpired();
  } catch (exc) {
    if (isProgrammingError(exc)) throw exc;
    log.warning('opportunistic purge failed: %s', exc);
    return;
  }
  if (cleared) log.info('purged text from %s expired reviews', cleared);
}

export async function create(chatId, messageId, userId, text, verdictJson, risk) {
  const expires = stamp(addDays(now(), config.REVIEW_TTL_DAYS));
  const result = await db.run(sql`INSERT INTO reviews (chat_id, message_id, user_id, text, verdict_json,
                                                       risk, created_at, expires_at)
                                  VALUES (${chatId}, ${messageId}, ${userId}, ${text ?? null},
                                          ${verdictJson}, ${risk}, ${stamp()}, ${expires})
                                  RETURNING id`);
  const reviewId = result.rows.length ? result.rows[0].id : result.lastInsertRowid;
  await purgeOnTheWayPast();
  return reviewId;
}

export async function get(reviewId) {
  return db.get(sql`SELECT * FROM reviews WHERE id = ${reviewId}`);
}

// Claims and resolves a review, but only if nobody has resolved it yet.
//
// The `decision IS NULL` clause makes this an atomic compare-and-set: two
// overlapping callers (a double-tap, two admins racing on the same card) can
// both read a review with `decision IS NULL` before either writes, but only
// one UPDATE can match this WHERE clause once the other has committed. The
// return value tells the caller whether *it* won the claim, so destructive
// side effects can be gated on actually owning the review.
export async function resolve(reviewId, decision, decidedBy) {
  const result = await db.run(sql`UPDATE reviews SET decision = ${decision}, decided_by = ${decidedBy},
                                                     decided_at = ${stamp()}
                                  WHERE id = ${reviewId} AND decision IS NULL`);
  return result.rowsAffected > 0;
}

// Clears stored message text past its TTL, keeping the labelled verdict.
export async function purgeExpired() {
  const result = await db.run(sql`UPDATE reviews SET text = NULL
                                  WHERE text IS NOT NULL AND expires_at < ${stamp()}`);
  return result.rowsAffected;
}
