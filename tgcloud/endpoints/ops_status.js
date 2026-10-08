// What the bot has been doing: row counts, the latest audit rows (which
// never contain message text) and when each chat last saw a member.
//
//   npx tgcloud run endpoints/ops_status '{}' --ctx '{ops: true}'
import { db } from 'sdk';
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
  const chats = await db.all(sql`SELECT c.chat_id, c.mode, c.lang, c.log_chat_id IS NOT NULL AS has_destination,
                                        max(t.last_seen_at) AS last_message_at
                                 FROM chats c LEFT JOIN trust t ON t.chat_id = c.chat_id
                                 GROUP BY c.chat_id`);
  return { counts, audit, chats };
}
