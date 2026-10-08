// Named values the bot cannot keep anywhere else: the TypeSafe API key and
// the cached getMe. Never logged.
import { db } from 'sdk';
import { sql } from 'sdk/db';

export const TYPESAFE_API_KEY = 'typesafe_api_key';
export const BOT_ME = 'bot_me';

export async function get(name) {
  const row = await db.get(sql`SELECT value FROM settings WHERE name = ${name}`);
  return row ? row.value : null;
}

export async function set(name, value) {
  await db.run(sql`INSERT INTO settings (name, value) VALUES (${name}, ${value})
                   ON CONFLICT (name) DO UPDATE SET value = excluded.value`);
}
