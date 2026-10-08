// Which ported handler an update goes to: the routing aiogram's Dispatcher
// did in the Python bot, in the same order and with the same filters.
//
//   message:  payments (successful_payment, any chat)
//             -> admin (private chats: /start, /help, /privacy, /chats)
//             -> group (groups and supergroups: /setlog, then everything else)
//   callback_query: "cfg:" -> admin, "rv:" -> review
//   pre_checkout_query -> payments
//   my_chat_member (groups and supergroups) -> group
//
// Anything that matches nothing is dropped, as aiogram dropped it.
import { api } from 'sdk';

import { makeBot } from './bot.js';
import * as admin from './handlers/admin.js';
import * as group from './handlers/group.js';
import * as payments from './handlers/payments.js';
import * as review from './handlers/review.js';
import { bestEffort } from './core/guards.js';
import * as reviews from './storage/reviews.js';
import { logger } from './log.js';

const log = logger('stopspam.dispatch');

// aiogram's Command filter: "/name", "/name args" or "/name@bot args", from
// the message text or caption. A mention must be this bot's username
// (case-insensitively); the bot's identity is only looked up when one is
// present.
async function command(bot, message, names) {
  const text = message.text || message.caption;
  if (!text) return false;
  const full = text.split(/\s+/).filter(Boolean)[0];
  if (!full || full[0] !== '/') return false;
  const body = full.slice(1);
  const at = body.indexOf('@');
  const name = at === -1 ? body : body.slice(0, at);
  const mention = at === -1 ? '' : body.slice(at + 1);
  if (!names.includes(name)) return false;
  if (mention) {
    const me = await bot.me();
    if (me.username && mention.toLowerCase() !== me.username.toLowerCase()) return false;
  }
  return true;
}

export async function dispatchMessage(message, bot = makeBot(api)) {
  if (message.successful_payment) return payments.onSuccessfulPayment(bot, message);

  const type = message.chat && message.chat.type;
  if (type === 'private') {
    if (await command(bot, message, ['start'])) return admin.onStart(bot, message);
    if (await command(bot, message, ['help'])) return admin.onHelp(bot, message);
    if (await command(bot, message, ['privacy'])) return admin.onPrivacy(bot, message);
    if (await command(bot, message, ['chats'])) return admin.onChats(bot, message);
    return undefined;
  }
  if (group.GROUP_TYPES.has(type)) {
    if (await command(bot, message, ['setlog'])) return group.onSetlog(bot, message);
    return group.onGroupMessage(bot, message);
  }
  return undefined;
}

export async function dispatchCallbackQuery(query, bot = makeBot(api)) {
  const data = query.data;
  if (typeof data !== 'string') return undefined;
  if (data.startsWith('cfg:')) return admin.onConfig(bot, query);
  if (data.startsWith('rv:')) return review.onCardButton(bot, query);
  return undefined;
}

export async function dispatchPreCheckoutQuery(query, bot = makeBot(api)) {
  return payments.onPreCheckout(bot, query);
}

export async function dispatchMyChatMember(update, bot = makeBot(api)) {
  if (!group.GROUP_TYPES.has(update.chat && update.chat.type)) return undefined;
  return group.onBotMembershipChanged(bot, update);
}

// Runs one platform handler.
//
// First it erases review text past its 7-day limit, across every chat. The
// Python bot had an hourly loop for this; the platform has no timers, so the
// erasure rides on every update the bot receives instead - from any group,
// any button, any payment - which on a bot in active groups is far more
// often than hourly. It is one UPDATE over an index on expires_at.
//
// An exception is then logged and swallowed, as aiogram's polling loop did:
// the update is acknowledged either way, so a bug can never make Telegram
// redeliver an update and repeat what already happened (a deletion, a card,
// a credited payment).
export async function guarded(kind, ctx, run) {
  const updateId = ctx && ctx.update ? ctx.update.update_id : '?';
  try {
    const cleared = await bestEffort(log, 'purge_expired', updateId, reviews.purgeExpired);
    if (cleared) log.info('purged text from %s expired reviews', cleared);
    await run();
  } catch (exc) {
    log.error('unhandled error in %s update %s: %s', kind, updateId, exc);
    console.error(exc);
  }
}
