// Loading and rendering one chat for the Mini App.
//
// Admin rights are asked of Telegram on every call, before the chat is read
// from storage, exactly as the old /chats menu did on every button press:
// a stale row must never be enough to grant control over a group, and a
// non-admin must not learn whether a chat id is known to the bot at all.
import * as guards from './core/guards.js';
import * as offer from './core/offer.js';
import { RateLimiter } from './core/ratelimit.js';
import * as billing from './storage/billing.js';
import * as chats from './storage/chats.js';
import { chatView, fail, planView } from './app.js';
import { logger } from './log.js';

const log = logger('stopspam.app');

// One getChatMember per call; a settings screen with sliders makes a few
// calls a minute, a script making hundreds is refused.
export const APP_PER_MINUTE = 30;
const appLimiter = new RateLimiter('app', APP_PER_MINUTE);

export async function spend(userId) {
  if (!(await appLimiter.allow(userId))) fail('RATE_LIMITED');
}

export async function loadChat(bot, chatId, userId) {
  if (!(await guards.isAdmin(bot, chatId, userId))) fail('NOT_ADMIN');
  const chat = await chats.getChat(chatId);
  if (chat === null) fail('NOT_FOUND');
  return chat;
}

export async function render(bot, chat, userId) {
  const row = (await guards.bestEffort(log, 'billing_get', chat.chat_id, billing.get, chat.chat_id))
    || billing.empty(chat.chat_id);
  const stars = planView(row).offer_stars;
  const url = stars
    ? await offer.subscribeLink(bot, { chatId: chat.chat_id, title: chat.title, stars, lang: chat.lang })
    : null;
  return chatView(chat, row, userId, url);
}
