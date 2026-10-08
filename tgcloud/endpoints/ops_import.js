// Accepts one batch of rows from the Python bot's SQLite database, during
// the move to the platform. Run by tools/migrate_from_sqlite.mjs.
//
// Rows keep their ids: review cards already sitting in admins' chats carry
// rv:<id> buttons, which must still find their review after the move. Every
// insert is ON CONFLICT DO NOTHING, so re-running a batch after a failure
// adds nothing twice.
import { db, EndpointError } from 'sdk';
import { sql } from 'sdk/db';

import { requireOps } from '../lib/ops.js';

// Table -> columns accepted, which is also what makes splicing the names
// into the SQL safe.
export const COLUMNS = {
  chats: ['chat_id', 'title', 'mode', 'delete_threshold', 'review_threshold', 'confidence_floor',
    'trust_after', 'log_chat_id', 'lang', 'jev_enabled', 'observe_until', 'created_at'],
  trust: ['chat_id', 'user_id', 'clean_count', 'status', 'joined_at', 'last_checked_at', 'last_seen_at'],
  reviews: ['id', 'chat_id', 'message_id', 'user_id', 'text', 'verdict_json', 'risk', 'decision',
    'decided_by', 'decided_at', 'created_at', 'expires_at'],
  audit: ['id', 'chat_id', 'user_id', 'message_id', 'risk', 'action', 'reason', 'model', 'created_at'],
  billing: ['chat_id', 'member_count', 'member_count_at', 'grace_until', 'paid_until', 'payer_user_id',
    'stars', 'charge_id', 'notified_stage', 'updated_at'],
  payments: ['telegram_payment_charge_id', 'chat_id', 'payer_user_id', 'stars', 'is_recurring',
    'expires_at', 'created_at'],
};

function joined(parts) {
  return parts.reduce((all, part) => (all === null ? part : sql`${all}, ${part}`), null);
}

export default async function (input, ctx) {
  requireOps(ctx);
  const table = input && input.table;
  const rows = input && input.rows;
  if (!(table in COLUMNS)) throw new EndpointError(`unknown table: ${table}`, { code: 'BAD_TABLE' });
  if (!Array.isArray(rows)) throw new EndpointError('rows must be an array', { code: 'BAD_ROWS' });
  const columns = COLUMNS[table];
  let inserted = 0;
  for (const row of rows) {
    const unknown = Object.keys(row).filter((name) => !columns.includes(name));
    if (unknown.length) throw new EndpointError(`unknown columns for ${table}: ${unknown}`, { code: 'BAD_COLUMNS' });
    const names = Object.keys(row);
    const result = await db.run(sql`INSERT INTO ${sql.raw(table)} (${sql.raw(names.join(', '))})
                                    VALUES (${joined(names.map((name) => sql`${row[name] ?? null}`))})
                                    ON CONFLICT DO NOTHING`);
    inserted += result.rowsAffected;
  }
  return { table, received: rows.length, inserted };
}
