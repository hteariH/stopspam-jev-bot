// Per-chat configuration.
import { db } from 'sdk';
import { sql } from 'sdk/db';

import * as config from '../config.js';
import { addDays, now, parse, stamp } from '../clock.js';

const FIELDS = new Set([
  'mode', 'delete_threshold', 'review_threshold', 'confidence_floor',
  'trust_after', 'log_chat_id', 'lang', 'jev_enabled', 'observe_until', 'title',
]);

function rowToConfig(row) {
  return Object.freeze({
    chat_id: row.chat_id,
    title: row.title,
    mode: row.mode,
    delete_threshold: row.delete_threshold,
    review_threshold: row.review_threshold,
    confidence_floor: row.confidence_floor,
    trust_after: row.trust_after,
    log_chat_id: row.log_chat_id,
    lang: row.lang,
    jev_enabled: Boolean(row.jev_enabled),
    observe_until: row.observe_until,
    created_at: row.created_at,
  });
}

// Chat ids this user plausibly belongs to, at most `limit` of them.
//
// /chats is a public command: anybody who can DM the bot can run it, and the
// chats table grows without bound as the bot is added to more groups.
// Verifying admin rights against Telegram for every known chat would mean
// one getChatMember call per group per stranger, which walks straight into
// Telegram's flood limits at a few hundred groups.
//
// Two kinds of row already tie a user to a chat, and both are far smaller
// than "every chat": the chat whose review cards go to this user (set when
// they added the bot), and the trust ledger rows written for every message
// they have posted. A user who is an admin of a group but has never posted
// there and did not add the bot is not in this set - they need to post once,
// or have a co-admin point the log chat at them.
//
// The limit is a hard cap, not a page: it bounds the Telegram calls one
// command can cause, which is the whole point.
export async function candidateChatIds(userId, limit) {
  const rows = await db.all(sql`SELECT chat_id FROM chats WHERE log_chat_id = ${userId}
                                UNION
                                SELECT chat_id FROM trust WHERE user_id = ${userId}
                                LIMIT ${limit}`);
  return rows.map((row) => row.chat_id);
}

export async function getChat(chatId) {
  const row = await db.get(sql`SELECT * FROM chats WHERE chat_id = ${chatId}`);
  return row ? rowToConfig(row) : null;
}

// Creates the chat on first sight; afterwards only refreshes the title.
export async function ensureChat(chatId, title) {
  const created = stamp();
  const observeUntil = stamp(addDays(now(), config.OBSERVE_DAYS));
  await db.run(sql`INSERT INTO chats (chat_id, title, mode, delete_threshold, review_threshold,
                                      confidence_floor, trust_after, lang, jev_enabled,
                                      observe_until, created_at)
                   VALUES (${chatId}, ${title}, 'observe', ${config.DEFAULT_DELETE_THRESHOLD},
                           ${config.DEFAULT_REVIEW_THRESHOLD}, ${config.DEFAULT_CONFIDENCE_FLOOR},
                           ${config.DEFAULT_TRUST_AFTER}, 'en', 1, ${observeUntil}, ${created})
                   ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title`);
  return getChat(chatId);
}

export async function updateChat(chatId, fields) {
  const unknown = Object.keys(fields).filter((name) => !FIELDS.has(name)).sort();
  if (unknown.length) throw new RangeError(`unknown chat fields: ${JSON.stringify(unknown)}`);
  let assignments = null;
  for (const [name, value] of Object.entries(fields)) {
    const bound = typeof value === 'boolean' ? Number(value) : value;
    // The name is one of FIELDS, so splicing it raw cannot inject anything.
    const one = sql`${sql.raw(name)} = ${bound ?? null}`;
    assignments = assignments ? sql`${assignments}, ${one}` : one;
  }
  await db.run(sql`UPDATE chats SET ${assignments} WHERE chat_id = ${chatId}`);
  return getChat(chatId);
}

// True while the chat is inside its observation window, whatever the mode.
export function isObserving(chat) {
  if (chat.mode === 'observe') return true;
  if (!chat.observe_until) return false;
  return parse(chat.observe_until) > now();
}
