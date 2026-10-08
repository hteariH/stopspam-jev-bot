// Per-chat trust ledger: who still needs checking and who has earned a pass.
import { db } from 'sdk';
import { sql } from 'sdk/db';

import { now, parse, stamp } from '../clock.js';

export const UNKNOWN = 'unknown';
export const TRUSTED = 'trusted';
export const FLAGGED = 'flagged';
export const ALLOWLISTED = 'allowlisted';

// Statuses that recordClean and markFlagged must not overwrite.
const STICKY = new Set([FLAGGED, ALLOWLISTED]);

export function TrustRow(fields) {
  return Object.freeze({
    chat_id: fields.chat_id,
    user_id: fields.user_id,
    clean_count: fields.clean_count,
    status: fields.status,
    joined_at: fields.joined_at,
    last_checked_at: fields.last_checked_at,
    last_seen_at: fields.last_seen_at,
  });
}

async function read(chatId, userId) {
  const row = await db.get(sql`SELECT * FROM trust WHERE chat_id = ${chatId} AND user_id = ${userId}`);
  if (row === null) {
    return TrustRow({ chat_id: chatId, user_id: userId, clean_count: 0, status: UNKNOWN,
      joined_at: null, last_checked_at: null, last_seen_at: null });
  }
  return TrustRow(row);
}

async function exists(chatId, userId) {
  const row = await db.get(sql`SELECT 1 AS present FROM trust WHERE chat_id = ${chatId} AND user_id = ${userId}`);
  return row !== null;
}

// The trust row for a user in a chat, or a default 'unknown' one if absent.
export function get(chatId, userId) {
  return read(chatId, userId);
}

// Records that we just saw this user, and returns their history BEFORE it.
//
// Callers judge the current message against the author's prior record. If
// this returned the refreshed row, daysSinceSeen would always be ~0 and the
// 30-day re-check in core/gate could never fire.
export async function seen(chatId, userId, joinedAt = null) {
  const prior = await read(chatId, userId);
  const rowExisted = await exists(chatId, userId);
  const at = stamp();
  await db.run(sql`INSERT INTO trust (chat_id, user_id, joined_at, last_seen_at)
                   VALUES (${chatId}, ${userId}, ${joinedAt || at}, ${at})
                   ON CONFLICT (chat_id, user_id) DO UPDATE SET
                       last_seen_at = excluded.last_seen_at,
                       joined_at    = COALESCE(trust.joined_at, excluded.joined_at)`);
  if (!rowExisted) return read(chatId, userId);
  return prior;
}

async function setStatus(chatId, userId, status) {
  await db.run(sql`INSERT INTO trust (chat_id, user_id, status, last_seen_at)
                   VALUES (${chatId}, ${userId}, ${status}, ${stamp()})
                   ON CONFLICT (chat_id, user_id) DO UPDATE SET status = excluded.status`);
  return read(chatId, userId);
}

export async function recordClean(chatId, userId, trustAfter) {
  const current = await read(chatId, userId);
  await db.run(sql`INSERT INTO trust (chat_id, user_id, clean_count, last_checked_at, last_seen_at)
                   VALUES (${chatId}, ${userId}, 1, ${stamp()}, ${stamp()})
                   ON CONFLICT (chat_id, user_id) DO UPDATE SET
                       clean_count     = trust.clean_count + 1,
                       last_checked_at = excluded.last_checked_at,
                       last_seen_at    = excluded.last_seen_at`);
  const updated = await read(chatId, userId);
  if (STICKY.has(current.status)) return updated;
  if (updated.clean_count >= trustAfter) return setStatus(chatId, userId, TRUSTED);
  return updated;
}

export async function markFlagged(chatId, userId) {
  const current = await read(chatId, userId);
  if (current.status === ALLOWLISTED) return current;
  return setStatus(chatId, userId, FLAGGED);
}

export function allowlist(chatId, userId) {
  return setStatus(chatId, userId, ALLOWLISTED);
}

function daysSince(value) {
  if (!value) return null;
  const then = parse(value);
  if (then === null) throw new RangeError(`unreadable timestamp: ${value}`);
  return (now() - then) / 1000 / 86400;
}

export function daysSinceSeen(row) {
  return daysSince(row.last_seen_at);
}

export function daysInGroup(row) {
  return daysSince(row.joined_at);
}
