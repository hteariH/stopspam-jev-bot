// Mini App: change some of one chat's settings; returns the new view.
import { api } from 'sdk';

import { changes, chatIdOf, requireUser } from '../lib/app.js';
import { loadChat, render, spend } from '../lib/app_chat.js';
import { makeBot } from '../lib/bot.js';
import * as chats from '../lib/storage/chats.js';

export default async function (input, ctx) {
  const userId = requireUser(ctx);
  const chatId = chatIdOf(input);
  await spend(userId);
  const bot = makeBot(api);
  const chat = await loadChat(bot, chatId, userId);
  const fields = changes(chat, input.fields, userId);
  return render(bot, await chats.updateChat(chatId, fields), userId);
}
