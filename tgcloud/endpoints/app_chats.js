// Mini App: the chats the caller administers.
//
//   npx tgcloud run endpoints/app_chats '{}' --ctx '{initData:{user:{id:<id>}}}'
import { api } from 'sdk';

import { fail, requireUser, summaryView } from '../lib/app.js';
import { makeBot } from '../lib/bot.js';
import { adminChats, chatsLimiter } from '../lib/core/admins.js';
import { bestEffort } from '../lib/core/guards.js';
import { logger } from '../lib/log.js';
import * as billing from '../lib/storage/billing.js';

const log = logger('stopspam.app');

export default async function (_input, ctx) {
  const userId = requireUser(ctx);
  if (!(await chatsLimiter.allow(userId))) fail('RATE_LIMITED');
  const owned = await adminChats(makeBot(api), userId);
  const result = [];
  for (const chat of owned) {
    const row = (await bestEffort(log, 'billing_get', chat.chat_id, billing.get, chat.chat_id))
      || billing.empty(chat.chat_id);
    result.push(summaryView(chat, row));
  }
  return { chats: result };
}
