// Configuration menu in a private chat with the bot.
//
// Admin rights are checked against Telegram on every menu render and every
// button press, exactly like handlers/review does for the review card: a
// stale row in the chats table must never be enough to grant control over a
// group's moderation settings.
import * as config from '../config.js';
import * as guards from '../core/guards.js';
import * as offer from '../core/offer.js';
import * as tiers from '../core/tiers.js';
import { RateLimiter } from '../core/ratelimit.js';
import * as billing from '../storage/billing.js';
import * as chats from '../storage/chats.js';
import { now, stamp } from '../clock.js';
import { escape } from '../html.js';
import { logger } from '../log.js';
import { fixed } from '../pyfmt.js';
import { LANGS, t } from '../texts.js';
import { chatIdFrom } from './payments.js';

const log = logger('stopspam.admin');

export const THRESHOLD_STEP = 0.05;

// Hard cap on how many chats one /chats can look up and render, which bounds
// what a stranger can make the bot spend in one command...
export const MAX_MENU_CHATS = 20;
// ...and a per-user limit on how often they can spend it at all.
export const CHATS_PER_MINUTE = 3;
const chatsLimiter = new RateLimiter('chats', CHATS_PER_MINUTE);
const TOGGLE_FIELDS = new Set(['mode', 'jev', 'lang', 'log', 'gonow']);
const THRESHOLD_FIELDS = new Set(['delete_threshold', 'review_threshold', 'confidence_floor']);
const DELTAS = new Set(['+', '-']);

// A button press must always get an answer back to the admin's client, even
// if the database fails.
const bestEffort = (...args) => guards.bestEffort(log, ...args);

// Chats the caller administers, re-verified against Telegram, not cached.
// The candidate set is narrowed in storage first, so the number of
// getChatMember calls is bounded by MAX_MENU_CHATS.
async function adminChats(bot, userId) {
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

function modeLabel(chat, lang) {
  return t(chat.mode === 'observe' ? 'btn_mode_active' : 'btn_mode_observe', lang);
}

function jevLabel(chat, lang) {
  return t(chat.jev_enabled ? 'btn_jev_off' : 'btn_jev_on', lang);
}

// Says where this chat's cards actually go, in words. Telegram user ids are
// positive and chat ids are negative, which is what distinguishes an admin's
// DM from a moderator group here.
function logChatLabel(chat, lang) {
  if (chat.log_chat_id === null || chat.log_chat_id === chat.chat_id) return t('log_chat_unset', lang);
  if (chat.log_chat_id > 0) return t('log_chat_dm', lang, { user_id: chat.log_chat_id });
  return t('log_chat_group', lang, { chat_id: chat.log_chat_id });
}

// The plan line, in words an admin can act on: "no subscription - I report
// spam but do not delete it" is a sentence somebody can decide about, where
// "tier: large" is not.
function billingLabel(chat, row, lang) {
  const at = now();
  const tier = tiers.tierFor(row.member_count);
  if (tier === tiers.FREE) {
    return t('billing_free', lang, { count: row.member_count || 0, limit: config.FREE_MEMBER_LIMIT });
  }
  const ent = tiers.build(tier, { paidUntil: row.paid_until, graceUntil: row.grace_until, now: at });
  if (ent.reason === 'subscribed') return t('billing_subscribed', lang, { days: tiers.daysLeft(row.paid_until, { now: at }) });
  if (ent.reason === 'grace') return t('billing_grace', lang, { days: tiers.daysLeft(row.grace_until, { now: at }) });
  return t('billing_none', lang);
}

export function menu(chat, row) {
  const lang = chat.lang;
  const cid = chat.chat_id;
  // chat.title comes from Telegram (the group's own title) and is sent as
  // HTML - it must be escaped, or a title containing "&"/"<"/">" makes
  // Telegram reject the whole send.
  const safeTitle = chat.title ? escape(chat.title) : String(cid);
  const deleteLabel = t('menu_delete_threshold', lang);
  const reviewLabel = t('menu_review_threshold', lang);
  const body = [
    t('menu_title', lang, { title: safeTitle }),
    '',
    `${t('menu_mode', lang)}: ${chat.mode}`,
    `${t('menu_jev', lang)}: ${chat.jev_enabled ? 'on' : 'off'}`,
    `${t('menu_thresholds', lang)}: ${deleteLabel} ≥ ${fixed(chat.delete_threshold, 2)}, `
      + `${reviewLabel} ≥ ${fixed(chat.review_threshold, 2)}`,
    `${t('menu_lang', lang)}: ${lang}`,
    `${t('menu_log_chat', lang)}: ${logChatLabel(chat, lang)}`,
    `${t('menu_billing', lang)}: ${billingLabel(chat, row, lang)}`,
  ].join('\n');
  const keyboard = { inline_keyboard: [
    [{ text: modeLabel(chat, lang), callback_data: `cfg:${cid}:mode` },
      { text: jevLabel(chat, lang), callback_data: `cfg:${cid}:jev` }],
    [{ text: `${deleteLabel} −`, callback_data: `cfg:${cid}:thr:delete_threshold:-` },
      { text: `${deleteLabel} +`, callback_data: `cfg:${cid}:thr:delete_threshold:+` }],
    [{ text: `${reviewLabel} −`, callback_data: `cfg:${cid}:thr:review_threshold:-` },
      { text: `${reviewLabel} +`, callback_data: `cfg:${cid}:thr:review_threshold:+` }],
    [{ text: `${t('menu_lang', lang)}: ${lang}`, callback_data: `cfg:${cid}:lang` }],
    [{ text: t('btn_log_here', lang), callback_data: `cfg:${cid}:log` }],
  ] };
  if (chats.isObserving(chat)) {
    keyboard.inline_keyboard.push([{ text: t('btn_start_deleting', lang), callback_data: `cfg:${cid}:gonow` }]);
  }
  return [body, keyboard];
}

// Answers a DM without letting a Telegram failure escape the handler.
async function say(bot, message, body) {
  try {
    await bot.answer(message, body);
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not reply to user %s: %s', message.chat.id, exc);
  }
}

async function answer(bot, query, text = null, showAlert = false) {
  try {
    await bot.answerCallbackQuery(query.id, { text, showAlert });
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not answer callback %s: %s', query.id, exc);
  }
}

export async function onStart(bot, message) {
  await say(bot, message, t('welcome'));
}

export async function onHelp(bot, message) {
  await say(bot, message, t('help'));
}

export async function onPrivacy(bot, message) {
  await say(bot, message, t('privacy'));
}

export async function onChats(bot, message) {
  if (!(await chatsLimiter.allow(message.from.id))) {
    await say(bot, message, t('too_many_requests'));
    return;
  }
  const owned = await adminChats(bot, message.from.id);
  if (!owned.length) {
    await say(bot, message, t('no_chats'));
    return;
  }
  for (const chat of owned) {
    const row = (await bestEffort('billing_get', chat.chat_id, billing.get, chat.chat_id))
      || billing.empty(chat.chat_id);
    const [body, keyboard] = menu(chat, row);
    await sendMenu(bot, message, chat, row, body, keyboard);
  }
}

// Appends the subscribe button to a rendered menu, or says why it cannot.
//
// Both render paths go through here, so they share one answer to "is this
// chat being offered a subscription right now?". Returns the body, which may
// have gained a line; the keyboard is appended to in place.
async function withOffer(bot, chat, row, body, keyboard) {
  const ent = tiers.build(tiers.tierFor(row.member_count),
    { paidUntil: row.paid_until, graceUntil: row.grace_until, now: now() });
  if (ent.price && ent.reason !== 'subscribed') {
    const url = await offer.subscribeLink(bot, {
      chatId: chat.chat_id, title: chat.title || String(chat.chat_id), stars: ent.price, lang: chat.lang,
    });
    if (url) {
      keyboard.inline_keyboard.push([{ text: t('btn_subscribe', chat.lang, { stars: ent.price }), url }]);
    } else {
      body += `\n\n<i>${escape(t('invoice_unavailable', chat.lang))}</i>`;
    }
  }
  return body;
}

// Sends one chat's menu. One malformed or oversized menu must not take down
// /chats for every other chat this admin administers.
async function sendMenu(bot, message, chat, row, body, keyboard) {
  body = await withOffer(bot, chat, row, body, keyboard);
  try {
    await bot.answer(message, body, { replyMarkup: keyboard });
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not send menu for chat %s: %s', chat.chat_id, exc);
  }
}

// Validates callback data before anything touches storage or Telegram.
//
// Returns [chatId, field, extra] on success, where field is one of null,
// "mode", "jev", "lang", "log", "gonow", "thr" and extra is
// [thresholdField, delta] when field is "thr". null on anything malformed.
export function parseCallback(data) {
  const parts = data.split(':');
  if (![2, 3, 5].includes(parts.length) || parts[0] !== 'cfg') return null;
  const chatId = chatIdFrom(parts[1]);
  if (chatId === null) return null;

  if (parts.length === 2) return [chatId, null, null];

  if (parts.length === 3) {
    const field = parts[2];
    if (!TOGGLE_FIELDS.has(field)) return null;
    return [chatId, field, null];
  }

  // cfg:<chat_id>:thr:<field>:<delta>
  if (parts[2] !== 'thr') return null;
  const [, , , thresholdField, delta] = parts;
  if (!THRESHOLD_FIELDS.has(thresholdField) || !DELTAS.has(delta)) return null;
  return [chatId, 'thr', [thresholdField, delta]];
}

// round(x, 4) for the threshold steps, which are never exact ties.
function round4(x) {
  return Math.round(x * 10000) / 10000;
}

export async function onConfig(bot, query) {
  const parsed = parseCallback(query.data);
  if (parsed === null) {
    await answer(bot, query);
    return;
  }
  const [chatId, field, extra] = parsed;

  // Admin status is checked before anything about the chat's existence in
  // our own storage is revealed, so a forwarded or guessed button cannot
  // tell a non-admin whether a chat id is in the bot's database at all.
  if (!(await guards.isAdmin(bot, chatId, query.from.id))) {
    await answer(bot, query, t('menu_not_admin'), true);
    return;
  }

  let chat = await bestEffort('get_chat', chatId, chats.getChat, chatId);
  if (chat === null) {
    await answer(bot, query, t('no_chats'));
    return;
  }

  const update = async (fields) => (await bestEffort('update_chat', chatId, chats.updateChat, chatId, fields)) || chat;
  if (field === 'mode') {
    chat = await update({ mode: chat.mode === 'observe' ? 'active' : 'observe' });
  } else if (field === 'jev') {
    chat = await update({ jev_enabled: !chat.jev_enabled });
  } else if (field === 'lang') {
    const nxt = LANGS.includes(chat.lang) ? LANGS[(LANGS.indexOf(chat.lang) + 1) % LANGS.length] : 'en';
    chat = await update({ lang: nxt });
  } else if (field === 'log') {
    // Redirects this chat's cards to the presser's own DM, so a second admin
    // can take the queue over from whoever added the bot. Their admin rights
    // for this chat were verified against Telegram above.
    chat = await update({ log_chat_id: query.from.id });
  } else if (field === 'thr') {
    const [thresholdField, delta] = extra;
    const step = delta === '+' ? THRESHOLD_STEP : -THRESHOLD_STEP;
    const newValue = round4(Math.max(0.0, Math.min(1.0, chat[thresholdField] + step)));
    chat = await update({ [thresholdField]: newValue });
  } else if (field === 'gonow') {
    // Ends the observation window on the admin's say-so. Not gated by
    // payment: it exists because the window is otherwise unconditional, so
    // an admin who subscribes today would get nothing for a week.
    chat = await update({ mode: 'active', observe_until: stamp() });
  }
  // field null: bare "cfg:<chat_id>" just re-renders the current menu.

  const row = (await bestEffort('billing_get', chatId, billing.get, chatId)) || billing.empty(chatId);
  let [body, keyboard] = menu(chat, row);
  body = await withOffer(bot, chat, row, body, keyboard);
  const card = query.message;
  if (card && card.date && card.chat) {
    try {
      await bot.editMessageText(card.chat.id, card.message_id, body, { replyMarkup: keyboard });
    } catch (exc) {
      if (guards.isProgrammingError(exc)) throw exc;
      log.warning('could not edit menu for chat %s: %s', chatId, exc);
    }
  } else {
    log.warning('could not edit menu for chat %s: the menu message is not accessible', chatId);
  }
  await answer(bot, query);
}
