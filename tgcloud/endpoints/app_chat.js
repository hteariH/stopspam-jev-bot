// Mini App: one chat's settings.
import { api } from 'sdk';

import { chatIdOf, requireUser } from '../lib/app.js';
import { loadChat, render, spend } from '../lib/app_chat.js';
import { makeBot } from '../lib/bot.js';

export default async function (input, ctx) {
  const userId = requireUser(ctx);
  const chatId = chatIdOf(input);
  await spend(userId);
  const bot = makeBot(api);
  return render(bot, await loadChat(bot, chatId, userId), userId);
}
