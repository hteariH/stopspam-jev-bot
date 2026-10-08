// Row counts per table, compared against the old database after the
// import, and the key's presence (never its value).
import { db } from 'sdk';
import { sql } from 'sdk/db';

import { requireOps } from '../lib/ops.js';
import * as settings from '../lib/storage/settings.js';

const TABLES = ['chats', 'trust', 'reviews', 'audit', 'billing', 'payments'];

export default async function (_input, ctx) {
  requireOps(ctx);
  const counts = {};
  for (const table of TABLES) {
    counts[table] = (await db.get(sql`SELECT count(*) AS n FROM ${sql.raw(table)}`)).n;
  }
  return { counts, typesafe_key_set: Boolean(await settings.get(settings.TYPESAFE_API_KEY)) };
}
