// Commands in a private chat with the bot.
//
// Chat settings live in the Mini App (endpoints/app_*); /chats only opens it.
// Admin rights are checked there, against Telegram, on every call.
import * as config from '../config.js';
import * as guards from '../core/guards.js';
import { logger } from '../log.js';
import { LANGS, t } from '../texts.js';

const log = logger('stopspam.admin');

function langOf(user) {
  const code = user && user.language_code;
  return LANGS.includes(code) ? code : 'en';
}

// Answers a DM without letting a Telegram failure escape the handler.
async function say(bot, message, body, options = {}) {
  try {
    await bot.answer(message, body, options);
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not reply to user %s: %s', message.chat.id, exc);
  }
}

// Prices come from config, so the text cannot drift from what is charged.
export function pricing(lang = 'en') {
  return t('pricing', lang, {
    free: config.FREE_MEMBER_LIMIT,
    small_from: config.FREE_MEMBER_LIMIT + 1,
    small_to: config.SMALL_MEMBER_LIMIT,
    small_stars: config.PRICE_SMALL_STARS,
    large_stars: config.PRICE_LARGE_STARS,
    grace: config.GRACE_DAYS,
  });
}

export async function onStart(bot, message) {
  const lang = langOf(message.from);
  await say(bot, message, `${t('welcome', lang)}\n\n${pricing(lang)}`);
}

export async function onHelp(bot, message) {
  const lang = langOf(message.from);
  await say(bot, message, `${t('help', lang)}\n\n${pricing(lang)}`);
}

export async function onPrivacy(bot, message) {
  await say(bot, message, t('privacy'));
}

export async function onChats(bot, message) {
  const lang = langOf(message.from);
  await say(bot, message, t('chats_open', lang), { replyMarkup: { inline_keyboard: [[
    { text: t('btn_open_settings', lang), web_app: { url: config.APP_URL } },
  ]] } });
}

// A button on a menu sent before the Mini App existed.
export async function onMovedMenu(bot, query) {
  try {
    await bot.answerCallbackQuery(query.id, { text: t('menu_moved', langOf(query.from)), showAlert: true });
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not answer callback %s: %s', query.id, exc);
  }
}
