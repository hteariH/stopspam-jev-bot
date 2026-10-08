// Executes a decision against Telegram. Nothing here decides anything.
import * as guards from './guards.js';
import * as offer from './offer.js';
import * as pipeline from './pipeline.js';
import { cardKeyboard, renderCard, renderOutageNotice } from './cards.js';
import { Action, REASON_NOT_ENTITLED } from './policy.js';
import { asDict } from './verdict.js';
import * as audit from '../storage/audit.js';
import * as reviews from '../storage/reviews.js';
import { logger } from '../log.js';
import { t } from '../texts.js';

const log = logger('stopspam.actions');

// apply()'s contract is that a decision already made must reach Telegram
// even if the database fails. reviews.create's return value - the review id -
// decides whether the card can carry working buttons, so here the result
// matters and not only the attempt.
const bestEffort = (...args) => guards.bestEffort(log, ...args);

// aiogram's User.full_name.
export function fullName(user) {
  return user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name;
}

// Where this chat's review cards go, or null if nowhere.
//
// Never the moderated group itself, and there is no fallback that could make
// it so. A card quotes the message the bot just decided about, names its
// author and their user id, and carries Delete and Ban buttons; posting that
// into the group it came from republishes the spam to every member and hands
// them the moderation buttons.
//
// A Telegram user id is a valid chat id for a direct message, so a chat's
// destination is either an admin's DM (a positive id, recorded when they
// added the bot or claimed the cards from the menu) or a moderator group (a
// negative id, set with /setlog). When it is neither, the card is skipped and
// logged: nowhere is better than the group itself, and the audit row still
// records the decision, so nothing is lost silently.
export function cardDestination(chat) {
  if (chat.log_chat_id === null || chat.log_chat_id === undefined || chat.log_chat_id === chat.chat_id) {
    return null;
  }
  return chat.log_chat_id;
}

// Tells the destination chat about a message the classifier never saw.
//
// The pipeline has already audited the failure, so this only has to reach a
// person. It sends no buttons: there is no verdict behind it and no decision
// to reverse.
async function reportOutage(bot, { message, chat }) {
  const target = cardDestination(chat);
  if (target === null) {
    log.warning('chat %s has no review destination: outage notice for message %s skipped',
      chat.chat_id, message.message_id);
    return 'ignored';
  }
  const body = renderOutageNotice({
    authorName: fullName(message.from), authorId: message.from.id,
    text: message.text ?? message.caption ?? null,
    chatTitle: chat.title || String(chat.chat_id), lang: chat.lang,
  });
  try {
    await bot.sendMessage(target, body);
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not post outage notice to %s: %s', target, exc);
    return 'ignored';
  }
  return 'outage_reported';
}

export async function apply(bot, { message, outcome, chat, limiter }) {
  const { decision, verdict } = outcome;
  if (decision === null) {
    if (outcome.skipped === pipeline.UNAVAILABLE_WITH_TRIGGER) return reportOutage(bot, { message, chat });
    return 'ignored';
  }
  if (decision.action === Action.IGNORE) return 'ignored';

  if (!(await limiter.allow(chat.chat_id))) {
    log.warning('enforcement rate limit hit in chat %s', chat.chat_id);
    await bestEffort('audit_rate_limited', chat.chat_id, audit.record,
      chat.chat_id, message.from.id, message.message_id,
      decision.risk, 'rate_limited', decision.reason, verdict.model);
    return 'rate_limited';
  }

  const text = message.text ?? message.caption ?? null;
  // A missing review row must not cancel an already-decided action: a
  // confident deletion still happens, and the card still reaches admins. It
  // just can't carry buttons bound to a row that doesn't exist.
  const reviewId = await bestEffort('create_review', chat.chat_id, reviews.create,
    chat.chat_id, message.message_id, message.from.id,
    text, JSON.stringify(asDict(verdict)), decision.risk);

  let deleted = false;
  if (decision.action === Action.DELETE) {
    try {
      await bot.deleteMessage(chat.chat_id, message.message_id);
      deleted = true;
    } catch (exc) {
      if (guards.isProgrammingError(exc)) throw exc;
      log.warning('could not delete in chat %s: %s', chat.chat_id, exc);
    }
  }

  const target = cardDestination(chat);
  let cardSent = false;
  if (target === null) {
    log.warning('chat %s has no review destination: card skipped (%s, risk %.2f). '
      + 'An admin can set one with /setlog in the chat that should receive '
      + 'cards, or from the /chats menu.', chat.chat_id, decision.action, decision.risk);
  } else {
    let body = renderCard({
      decision, verdict,
      authorName: fullName(message.from), authorId: message.from.id,
      text, chatTitle: chat.title || String(chat.chat_id), lang: chat.lang,
    });
    if (deleted) body += `\n\n<i>${t('card_deleted', chat.lang)}</i>`;
    // The invoice link is fetched only when there is something to sell, so an
    // ordinary card still costs no extra Telegram call.
    let subscribeUrl = null;
    let stars = 0;
    if (decision.reason === REASON_NOT_ENTITLED && outcome.entitlement !== null) {
      stars = outcome.entitlement.price;
      subscribeUrl = await offer.subscribeLink(bot, {
        chatId: chat.chat_id, title: chat.title || String(chat.chat_id), stars, lang: chat.lang,
      });
    }
    const keyboard = cardKeyboard(reviewId, chat.lang, { subscribeUrl, stars });
    try {
      await bot.sendMessage(target, body, { replyMarkup: keyboard });
      cardSent = true;
    } catch (exc) {
      if (guards.isProgrammingError(exc)) throw exc;
      log.warning('could not post card to %s: %s', target, exc);
    }
  }

  // A deletion happened whatever became of the card. An undelivered card,
  // though, must not be audited as "reviewed": that reason implies a human
  // saw the message, and nobody did.
  let action;
  let reason;
  if (deleted) [action, reason] = ['deleted', decision.reason];
  else if (cardSent) [action, reason] = ['reviewed', decision.reason];
  else [action, reason] = ['degraded', `${decision.reason}/card_undelivered`];
  await bestEffort('audit_enforcement', chat.chat_id, audit.record,
    chat.chat_id, message.from.id, message.message_id, decision.risk, action, reason, verdict.model);
  return action;
}
