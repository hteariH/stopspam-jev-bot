// What the bot has been doing: row counts, the latest audit rows (which
// never contain message text) and, for each chat, when it last saw a member,
// its stored and current title and whether the bot is still in it.
//
//   npx tgcloud run endpoints/ops_status '{}' --ctx '{ops: true}'
import { api, db } from 'sdk';
import { sql } from 'sdk/db';

import { requireOps } from '../lib/ops.js';

export default async function (input, ctx) {
  requireOps(ctx);
  const limit = Math.min(Number(input && input.limit) || 10, 50);
  const counts = {};
  for (const table of ['chats', 'trust', 'reviews', 'audit', 'billing', 'payments', 'rate_events']) {
    counts[table] = (await db.get(sql`SELECT count(*) AS n FROM ${sql.raw(table)}`)).n;
  }
  const audit = await db.all(sql`SELECT id, chat_id, user_id, action, reason, risk, model, created_at
                                 FROM audit ORDER BY id DESC LIMIT ${limit}`);
  const chats = await db.all(sql`SELECT c.chat_id, c.title, c.mode, c.lang, c.log_chat_id IS NOT NULL AS has_destination,
                                        max(t.last_seen_at) AS last_message_at
                                 FROM chats c LEFT JOIN trust t ON t.chat_id = c.chat_id
                                 GROUP BY c.chat_id`);
  const me = await api.getMe();
  for (const chat of chats) {
    try {
      chat.live_title = (await api.getChat({ chat_id: chat.chat_id })).title ?? null;
    } catch (e) {
      chat.live_title = null;
      chat.error = e.description ?? String(e);
    }
    try {
      chat.bot_status = (await api.getChatMember({ chat_id: chat.chat_id, user_id: me.id })).status;
    } catch (e) {
      chat.bot_status = null;
      chat.error ??= e.description ?? String(e);
    }
  }
  return { counts, audit, chats };
}
