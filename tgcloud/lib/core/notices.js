// Telling an admin before the bot stops deleting, and after it has.
//
// The bot going quiet is the failure this exists to prevent: a group that
// grows past the free limit and silently stops being enforced is the bot
// failing at its job exactly when the group became worth attacking.
import * as config from '../config.js';
import * as actions from './actions.js';
import * as guards from './guards.js';
import * as offer from './offer.js';
import * as tiers from './tiers.js';
import * as billing from '../storage/billing.js';
import { now as clockNow } from '../clock.js';
import { escape } from '../html.js';
import { logger } from '../log.js';
import { t } from '../texts.js';

const log = logger('stopspam.notices');

export const STAGE_GRACE = 'grace';
export const STAGE_GRACE_ENDING = 'grace_ending';
export const STAGE_LAPSED = 'lapsed';

// Stages only ever move forward. A chat that dips back under the member
// limit and climbs out again must not re-announce a trial it already had.
const ORDER = [STAGE_GRACE, STAGE_GRACE_ENDING, STAGE_LAPSED];

const TEXT = {
  [STAGE_GRACE]: 'notice_grace',
  [STAGE_GRACE_ENDING]: 'notice_grace_ending',
  [STAGE_LAPSED]: 'notice_lapsed',
};

// Which notice this chat is due, or null.
//
// Pure, so every transition can be tested without a bot. The stage flag is
// what bounds how often anything is sent - stronger than a timer, because a
// stage that has been announced is never announced again at all. Which is
// also why a wrong stage here is expensive: stages only move forward, so
// whichever one lands first blocks every correct one after it.
//
// `observing` silences everything, mirroring the precedence core/policy
// already applies - a chat inside its 7-day observation window is deleting
// nothing regardless, has not been offered anything yet, and must not be
// told its subscription has ended.
export function nextStage(entitlement, { graceUntil, notifiedStage, observing, now }) {
  if (entitlement.tier === tiers.FREE) return null;
  if (observing) return null;

  let candidate = null;
  if (entitlement.reason === 'grace') {
    const remaining = tiers.daysLeft(graceUntil, { now });
    candidate = remaining <= config.GRACE_WARN_DAYS ? STAGE_GRACE_ENDING : STAGE_GRACE;
  } else if (entitlement.reason === 'not_entitled') {
    candidate = STAGE_LAPSED;
  }

  if (candidate === null) return null;
  if (notifiedStage === null || notifiedStage === undefined) return candidate;
  if (!ORDER.includes(notifiedStage)) return candidate;
  return ORDER.indexOf(candidate) > ORDER.indexOf(notifiedStage) ? candidate : null;
}

// Sends the due notice, if any, and records that it went out.
//
// The stage is recorded only after Telegram accepted the message. Recording
// it first would burn the one announcement a chat gets on a send that never
// arrived, and the admin would never be told at all.
//
// `row` must carry the grace window that is actually in force, including one
// opened on this very message - a row read before startGrace has
// grace_until=null, which computes zero days left and announces a trial
// that "ends in 0 days" on the day it started.
export async function maybeNotify(bot, { chat, row, entitlement, observing }) {
  const now = clockNow();
  const stage = nextStage(entitlement, {
    graceUntil: row.grace_until, notifiedStage: row.notified_stage, observing, now,
  });
  if (stage === null) return;

  const target = actions.cardDestination(chat);
  if (target === null) {
    log.warning('chat %s has no destination: %s notice skipped', chat.chat_id, stage);
    return;
  }

  const days = tiers.daysLeft(stage !== STAGE_LAPSED ? row.grace_until : row.paid_until, { now });
  // chat.title is the group's own, chosen by whoever named it, and this goes
  // out as HTML. A title containing "&", "<" or ">" makes Telegram reject the
  // whole send - and since a failed send records no stage, that rejection
  // would repeat on every evaluation.
  const body = t(TEXT[stage], chat.lang, {
    title: chat.title ? escape(chat.title) : String(chat.chat_id),
    limit: config.FREE_MEMBER_LIMIT,
    days,
  });

  let keyboard = null;
  const url = await offer.subscribeLink(bot, {
    chatId: chat.chat_id, title: chat.title || String(chat.chat_id),
    stars: entitlement.price, lang: chat.lang,
  });
  if (url) {
    keyboard = { inline_keyboard: [[{ text: t('btn_subscribe', chat.lang, { stars: entitlement.price }), url }]] };
  }

  try {
    await bot.sendMessage(target, body, { replyMarkup: keyboard });
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not send the %s notice for chat %s: %s', stage, chat.chat_id, exc);
    return;
  }

  await guards.bestEffort(log, 'set_notified_stage', chat.chat_id,
    billing.setNotifiedStage, chat.chat_id, stage);
}
