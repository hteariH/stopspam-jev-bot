// Every group message passes through here.
import * as config from '../config.js';
import * as actions from '../core/actions.js';
import * as guards from '../core/guards.js';
import * as notices from '../core/notices.js';
import * as pipeline from '../core/pipeline.js';
import * as state from '../core/state.js';
import * as tiers from '../core/tiers.js';
import { TypeSafeJevClient } from '../core/jev.js';
import { RateLimiter } from '../core/ratelimit.js';
import * as billing from '../storage/billing.js';
import * as chats from '../storage/chats.js';
import * as trust from '../storage/trust.js';
import { now } from '../clock.js';
import { logger } from '../log.js';
import { t } from '../texts.js';

const log = logger('stopspam.group');

export const GROUP_TYPES = new Set(['group', 'supergroup']);

let client = null;
const limiter = new RateLimiter('enforcement', config.ENFORCEMENT_PER_MINUTE);

// /setlog verifies the caller against Telegram once per candidate chat, so
// it is bounded and rate-limited exactly like /chats is.
export const MAX_SETLOG_CHATS = 20;
export const SETLOG_PER_MINUTE = 2;
const setlogLimiter = new RateLimiter('setlog', SETLOG_PER_MINUTE);

// The classifier the group handler uses. Tests install a fake; otherwise it
// is the real TypeSafe client, made on first use.
export function setClient(value) {
  client = value;
}

function getClient() {
  if (client === null) client = new TypeSafeJevClient();
  return client;
}

// Replies in a group without letting a Telegram failure escape a handler.
async function say(bot, message, body) {
  try {
    await bot.answer(message, body);
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not reply in chat %s: %s', message.chat.id, exc);
  }
}

async function chatLang(chatId) {
  const chat = await guards.bestEffort(log, 'get_chat', chatId, chats.getChat, chatId);
  return chat ? chat.lang : 'en';
}

async function canDelete(bot, chatId) {
  let me;
  try {
    me = await bot.getChatMember(chatId, (await bot.me()).id);
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    return false;
  }
  // An owner always can; an administrator only with the explicit right.
  if (me.status === 'creator') return true;
  return Boolean(me.can_delete_messages);
}

// The group's size, refetched at most once per cache window.
//
// A failed lookup returns the cached value, including null. That is the free
// tier, and it is the right way to fail: a billing lookup must never be what
// stops a group from being moderated.
async function memberCount(bot, chatId, row) {
  if (!tiers.countIsStale(row.member_count_at, { now: now() })) return row.member_count;
  let count;
  try {
    count = await bot.getChatMemberCount(chatId);
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('member count lookup failed for chat %s: %s', chatId, exc);
    return row.member_count;
  }
  await guards.bestEffort(log, 'set_member_count', chatId, billing.setMemberCount, chatId, count);
  return count;
}

// Whether this chat may have spam deleted automatically, and why.
//
// Returns the billing row alongside it so the caller can decide whether a
// notice is due without reading the same row twice. The row is null only
// when storage failed.
//
// Also the only place the free trial is opened. The trial starts on the
// first message where the tier requires payment *and* the chat is out of its
// observation window: starting it earlier would burn half the window during
// a week in which the bot deletes nothing anyway.
async function entitlementFor(bot, chat) {
  const at = now();
  let row = await guards.bestEffort(log, 'billing_get', chat.chat_id, billing.get, chat.chat_id);
  if (row === null) {
    // Storage failed. The verdict is unaffected; only the question of
    // permission failed, and a lost subscription beats a group silently
    // going unmoderated.
    return [tiers.Entitlement({ tier: tiers.FREE, active: true, reason: 'billing_unavailable', price: 0 }), null];
  }

  const tier = tiers.tierFor(await memberCount(bot, chat.chat_id, row));
  let graceUntil = row.grace_until;
  if (tier !== tiers.FREE && graceUntil === null && !chats.isObserving(chat)) {
    graceUntil = await guards.bestEffort(log, 'start_grace', chat.chat_id, billing.startGrace, chat.chat_id);
    if (graceUntil === null) {
      // Storage failed on the write this time rather than the read, and the
      // ruling is unconditional: a billing problem must never disarm
      // moderation.
      return [tiers.Entitlement({ tier, active: true, reason: 'billing_unavailable',
        price: tiers.priceFor(tier) }), row];
    }
    // The caller hands this row to core/notices, which needs the window that
    // is now in force; the row was read before startGrace.
    row = Object.freeze({ ...row, grace_until: graceUntil });
  }

  return [tiers.build(tier, { paidUntil: row.paid_until, graceUntil, now: at }), row];
}

// Records who added the bot, as that chat's review-card destination.
//
// This is what gives every group a private destination from the moment the
// bot arrives. Only ever fills an empty destination: a chat that already has
// one has had it chosen by an admin, and a re-promotion must not quietly take
// it back.
export async function onBotMembershipChanged(bot, update) {
  if (!update.from || update.from.is_bot) return;
  if (['left', 'kicked'].includes(update.new_chat_member.status)) return;
  try {
    const chat = await chats.ensureChat(update.chat.id, update.chat.title || '');
    if (chat.log_chat_id === null) {
      await chats.updateChat(update.chat.id, { log_chat_id: update.from.id });
      log.info('chat %s: review cards will go to user %s, who added the bot', update.chat.id, update.from.id);
    }
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not record the log chat for %s: %s', update.chat.id, exc);
  }
}

// Points the review cards of the caller's groups at this chat.
//
// Run in a dedicated moderator group by an admin of it. The caller is
// verified against Telegram both here and for every group being redirected,
// so nobody can aim another group's cards - which quote its members'
// messages - at a chat they do not administer. This chat is skipped if it is
// itself one of the caller's groups: a chat is never its own destination.
export async function onSetlog(bot, message) {
  if (!message.from || message.from.is_bot) return;
  const here = message.chat.id;
  const userId = message.from.id;
  const lang = await chatLang(here);

  if (!(await setlogLimiter.allow(userId))) {
    await say(bot, message, t('too_many_requests', lang));
    return;
  }

  if ((await guards.adminCheck(bot, here, userId)) !== guards.AdminCheck.ADMIN) {
    await say(bot, message, t('setlog_not_admin', lang));
    return;
  }

  const candidates = (await guards.bestEffort(log, 'candidate_chats', here,
    chats.candidateChatIds, userId, MAX_SETLOG_CHATS)) || [];
  let redirected = 0;
  for (const chatId of candidates) {
    if (chatId === here) continue;
    if (!(await guards.isAdmin(bot, chatId, userId))) continue;
    if ((await guards.bestEffort(log, 'set_log_chat', chatId, chats.updateChat,
      chatId, { log_chat_id: here })) !== null) {
      redirected += 1;
    }
  }

  if (redirected) {
    log.info('chat %s now receives the cards of %s chat(s), set by user %s', here, redirected, userId);
    await say(bot, message, t('setlog_done', lang, { count: redirected }));
  } else {
    await say(bot, message, t('setlog_none', lang));
  }
}

export async function onGroupMessage(bot, message) {
  if (!message.from || message.from.is_bot) return;

  // Joins, leaves, pins, title changes and captionless media all arrive
  // here. There is nothing to classify in any of them, and a Jev call plus
  // two getChatMember calls on every join is most of the spend in a group
  // with normal churn.
  if (!(message.text || message.caption)) return;

  let chat;
  let row;
  try {
    chat = await chats.ensureChat(message.chat.id, message.chat.title || '');
    row = await trust.seen(message.chat.id, message.from.id);
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('storage unavailable for chat %s, skipping message: %s', message.chat.id, exc);
    return;
  }

  const facts = state.factsFromMessage(message, {
    authorMessageCount: row.clean_count,
    authorDaysInGroup: trust.daysInGroup(row),
    groupDescription: '',
  });

  // The only place in the bot where the answer to "is this an admin?"
  // decides whether somebody gets acted upon. A failed lookup must therefore
  // not read as "ordinary member": the message is dropped instead -
  // unchecked, unclassified, with no API call spent - which is the spec's
  // rule that uncertainty resolves to not acting.
  const check = await guards.adminCheck(bot, message.chat.id, message.from.id);
  if (check === guards.AdminCheck.UNKNOWN) {
    log.warning('admin status unknown for user %s in chat %s, skipping message',
      message.from.id, message.chat.id);
    return;
  }
  const isAdmin = check === guards.AdminCheck.ADMIN;
  const deletable = await canDelete(bot, message.chat.id);
  const [entitlement, billingRow] = await entitlementFor(bot, chat);
  // Notices ride the once-per-24-hours member-count refresh rather than
  // running on every message: core/notices records no stage when the send
  // fails, so for a destination that never pressed Start every message would
  // otherwise cost an invoice link plus a failing send, forever. The row
  // here was read before the refresh, so its timestamp still says whether
  // this message was the due one.
  if (billingRow !== null && tiers.countIsStale(billingRow.member_count_at, { now: now() })) {
    await notices.maybeNotify(bot, { chat, row: billingRow, entitlement,
      observing: chats.isObserving(chat) });
  }

  const outcome = await pipeline.evaluate(getClient(), {
    chat, facts, trustRow: row, isAdmin, canDelete: deletable, entitlement,
  });

  await actions.apply(bot, { message, outcome, chat, limiter });
}

// Tests only.
export { entitlementFor as _entitlement };
