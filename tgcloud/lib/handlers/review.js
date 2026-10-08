// Buttons on a review card. Only admins of the source chat may press them.
//
// A card sits in the group's log chat, which can hold people who are not
// admins of the group the card is about. Every press is therefore checked
// against Telegram, for the chat the review belongs to - never the chat the
// card happens to be sitting in, and never a value cached in the database.
import * as guards from '../core/guards.js';
import * as audit from '../storage/audit.js';
import * as chats from '../storage/chats.js';
import * as reviews from '../storage/reviews.js';
import * as trust from '../storage/trust.js';
import { htmlText } from '../html_text.js';
import { logger } from '../log.js';
import { t } from '../texts.js';
import { pyInt, SQLITE_INT_MAX, SQLITE_INT_MIN } from './payments.js';

const log = logger('stopspam.review');

const DECISION = { ban: 'delete_ban', del: 'delete', ok: 'not_spam' };
const DONE_TEXT = { ban: 'done_ban', del: 'done_delete', ok: 'done_not_spam' };

// A card press must always get an answer back to the admin's client, even if
// the database fails.
const bestEffort = (...args) => guards.bestEffort(log, ...args);

async function answer(bot, query, text = null, showAlert = false) {
  try {
    await bot.answerCallbackQuery(query.id, { text, showAlert });
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not answer callback %s: %s', query.id, exc);
  }
}

// Python's str.split(":", 2).
function splitTwice(data) {
  const first = data.indexOf(':');
  if (first === -1) return [data];
  const second = data.indexOf(':', first + 1);
  if (second === -1) return [data.slice(0, first), data.slice(first + 1)];
  return [data.slice(0, first), data.slice(first + 1, second), data.slice(second + 1)];
}

export async function onCardButton(bot, query) {
  // A client can send arbitrary callback data - the "rv:" prefix does not
  // guarantee a well-formed action or a numeric id. None of these shapes
  // correspond to anything actionable, so the honest answer is the same
  // "already handled" a stale review id gets below.
  const parts = splitTwice(query.data);
  if (parts.length !== 3 || !(parts[1] in DECISION)) {
    await answer(bot, query, t('already_handled'));
    return;
  }
  const [, action, rawId] = parts;
  const parsed = pyInt(rawId);
  if (parsed === null || parsed < SQLITE_INT_MIN || parsed > SQLITE_INT_MAX
      || !Number.isSafeInteger(Number(parsed))) {
    await answer(bot, query, t('already_handled'));
    return;
  }
  const reviewId = Number(parsed);

  let review;
  try {
    review = await reviews.get(reviewId);
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('storage call failed (get_review) for review %s: %s', reviewId, exc);
    review = null;
  }
  if (review === null) {
    // Either the id never existed, or the lookup itself failed. Either way
    // there is nothing left to act on.
    await answer(bot, query, t('already_handled'));
    return;
  }

  const chat = await bestEffort('get_chat', review.chat_id, chats.getChat, review.chat_id);
  const lang = chat ? chat.lang : 'en';

  if (review.decision !== null) {
    await answer(bot, query, t('already_handled', lang));
    return;
  }

  if (!(await guards.isAdmin(bot, review.chat_id, query.from.id))) {
    await answer(bot, query, t('not_admin', lang), true);
    return;
  }

  // Claim the review before doing anything destructive. reviews.resolve()
  // only succeeds for whichever caller's UPDATE lands first against a
  // still-unresolved row, so a double-tap or two admins racing on the same
  // card cannot both run the delete or ban. A storage failure is treated the
  // same as losing the race: fail closed rather than perform a destructive
  // action with no record of it.
  //
  // The review can end up resolved even if the delete or ban then fails
  // against Telegram: a card that looks unhandled forever is worse than one
  // that is a beat behind Telegram.
  const claimed = await bestEffort('resolve', review.chat_id, reviews.resolve,
    reviewId, DECISION[action], query.from.id);
  if (!claimed) {
    await answer(bot, query, t('already_handled', lang));
    return;
  }

  if (action === 'ban' || action === 'del') {
    try {
      await bot.deleteMessage(review.chat_id, review.message_id);
    } catch (exc) {
      if (guards.isProgrammingError(exc)) throw exc;
      // The message may already be gone. The review is already resolved, so
      // this only affects Telegram state, never the recorded decision.
      log.warning('delete from card failed for chat %s: %s', review.chat_id, exc);
    }
  }
  if (action === 'ban') {
    try {
      await bot.banChatMember(review.chat_id, review.user_id);
    } catch (exc) {
      if (guards.isProgrammingError(exc)) throw exc;
      log.warning('ban from card failed for chat %s: %s', review.chat_id, exc);
    }
    await bestEffort('mark_flagged', review.chat_id, trust.markFlagged, review.chat_id, review.user_id);
  }
  if (action === 'ok') {
    await bestEffort('allowlist', review.chat_id, trust.allowlist, review.chat_id, review.user_id);
  }

  await bestEffort('audit', review.chat_id, audit.record,
    review.chat_id, review.user_id, review.message_id,
    review.risk, `card_${action}`, `by_admin_${query.from.id}`);

  const outcome = t(DONE_TEXT[action], lang);
  const card = query.message;
  // An inaccessible message (date 0) or an inline one cannot be edited.
  if (card && card.date && card.chat) {
    try {
      await bot.editMessageText(card.chat.id, card.message_id, `${htmlText(card)}\n\n<i>${outcome}</i>`);
    } catch (exc) {
      if (guards.isProgrammingError(exc)) throw exc;
      log.warning('could not edit card for chat %s: %s', review.chat_id, exc);
    }
  } else {
    log.warning('could not edit card for chat %s: the card message is not accessible', review.chat_id);
  }
  await answer(bot, query, outcome);
}
