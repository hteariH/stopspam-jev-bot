// Why the bot did what it did. Deliberately stores no message text.
import { db } from 'sdk';
import { sql } from 'sdk/db';

import { stamp } from '../clock.js';

export async function record(chatId, userId, messageId, risk, action, reason, model = null) {
  await db.run(sql`INSERT INTO audit (chat_id, user_id, message_id, risk, action, reason,
                                      model, created_at)
                   VALUES (${chatId}, ${userId}, ${messageId ?? null}, ${risk ?? null}, ${action},
                           ${reason}, ${model ?? null}, ${stamp()})`);
}

export async function recent(chatId, limit = 20) {
  return db.all(sql`SELECT * FROM audit WHERE chat_id = ${chatId} ORDER BY id DESC LIMIT ${limit}`);
}
