// Which chats a user administers, and the budget for asking.
//
// Shared by every caller that lists "your chats", so the bound on Telegram
// lookups (MAX_MENU_CHATS candidates, CHATS_PER_MINUTE per user) is one
// piece of code, not one per screen.
import * as guards from './guards.js';
import { RateLimiter } from './ratelimit.js';
import * as chats from '../storage/chats.js';
import { logger } from '../log.js';

const log = logger('stopspam.admins');

// Hard cap on how many chats one listing can look up, which bounds what a
// stranger can make the bot spend in one request...
export const MAX_MENU_CHATS = 20;
// ...and a per-user limit on how often they can spend it at all.
export const CHATS_PER_MINUTE = 3;
export const chatsLimiter = new RateLimiter('chats', CHATS_PER_MINUTE);

const bestEffort = (...args) => guards.bestEffort(log, ...args);

// Chats the caller administers, re-verified against Telegram, not cached.
// The candidate set is narrowed in storage first, so the number of
// getChatMember calls is bounded by MAX_MENU_CHATS.
export async function adminChats(bot, userId) {
  const candidates = (await bestEffort('candidate_chats', userId, chats.candidateChatIds,
    userId, MAX_MENU_CHATS)) || [];
  const result = [];
  for (const chatId of candidates) {
    if (await guards.isAdmin(bot, chatId, userId)) {
      const chat = await bestEffort('get_chat', chatId, chats.getChat, chatId);
      if (chat !== null) result.push(chat);
    }
  }
  return result;
}
