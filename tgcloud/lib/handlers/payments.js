// Incoming Stars payments: the pre-checkout gate and the receipt.
//
// The successful_payment handler deliberately accepts a payment from any chat
// type - the Bot API documentation does not say whether such a message can
// ever arrive outside a private chat, and money is involved. The cost of
// missing one is an unrecorded charge with no handle on it; the cost of
// accepting one from an unexpected chat is nothing.
import * as config from '../config.js';
import * as guards from '../core/guards.js';
import * as tiers from '../core/tiers.js';
import * as billing from '../storage/billing.js';
import * as chats from '../storage/chats.js';
import { addSeconds, now, stamp } from '../clock.js';
import { escape } from '../html.js';
import { logger } from '../log.js';
import { t } from '../texts.js';

const log = logger('stopspam.payments');

const bestEffort = (...args) => guards.bestEffort(log, ...args);

// Python's int() on a payload field: optional surrounding whitespace, an
// optional sign, digits with single underscores between them. Returns a
// BigInt so a value too wide for SQLite can be rejected rather than rounded.
const INT_RE = /^\s*[+-]?\d+(?:_\d+)*\s*$/;
export const SQLITE_INT_MIN = -(2n ** 63n);
export const SQLITE_INT_MAX = 2n ** 63n - 1n;

export function pyInt(value) {
  if (typeof value !== 'string' || !INT_RE.test(value)) return null;
  return BigInt(value.trim().replace(/_/g, ''));
}

// A chat id that fits SQLite's signed 64-bit INTEGER and a JS number
// exactly. Telegram ids are at most 52 bits, so anything wider is not ours.
export function chatIdFrom(value) {
  const parsed = pyInt(value);
  if (parsed === null || parsed < SQLITE_INT_MIN || parsed > SQLITE_INT_MAX) return null;
  const n = Number(parsed);
  return Number.isSafeInteger(n) ? n : null;
}

function knownPrices() {
  return new Set([tiers.priceFor(tiers.SMALL), tiers.priceFor(tiers.LARGE)]);
}

// Which chat an invoice payload names, or null if it is not ours.
//
// Checks the shape and nothing about the price: the prefix, the field count,
// that both fields are integers, and that the chat id fits. Used on the
// successful-payment path, where the money has already moved. The price must
// NOT be checked there: it locks at subscribe time and Telegram renews at
// whatever the original invoice named, so a price change would otherwise
// make every existing subscriber's renewal unreadable while Telegram kept
// charging them.
export function parseChatId(payload) {
  const parts = String(payload).split(':');
  if (parts.length !== 3 || parts[0] !== 'sub') return null;
  if (pyInt(parts[1]) === null || pyInt(parts[2]) === null) return null;
  return chatIdFrom(parts[1]);
}

// [chatId, stars] from an invoice payload, or null if it is not ours.
//
// The star count is checked against the prices we actually sell. Without
// that, a crafted invoice could buy a subscription for one star: the payload
// round-trips through the buyer's client, so nothing in it is trustworthy on
// the way back. That check belongs at pre-checkout and only there.
export function parsePayload(payload) {
  const chatId = parseChatId(payload);
  if (chatId === null) return null;
  const stars = Number(pyInt(String(payload).split(':')[2]));
  if (!knownPrices().has(stars)) return null;
  return [chatId, stars];
}

async function chatLang(chatId) {
  const chat = await bestEffort('get_chat', chatId, chats.getChat, chatId);
  return chat ? chat.lang : 'en';
}

async function chatTitle(chatId) {
  const chat = await bestEffort('get_chat', chatId, chats.getChat, chatId);
  return chat && chat.title ? chat.title : String(chatId);
}

async function say(bot, message, body) {
  try {
    await bot.answer(message, body);
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not reply to user %s: %s', message.chat.id, exc);
  }
}

// Telegram fails the payment if this goes unanswered for ten seconds.
//
// So it does no network work and no storage work. It deliberately does not
// re-check that the payer administers the chat: the only thing that would
// prevent - somebody paying for a group they do not administer - is a gift,
// not an attack.
export async function onPreCheckout(bot, query) {
  const parsed = parsePayload(query.invoice_payload);
  const ok = parsed !== null && query.currency === 'XTR' && query.total_amount === parsed[1];
  try {
    await bot.answerPreCheckoutQuery(query.id, { ok, errorMessage: ok ? null : t('pay_rejected') });
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not answer pre_checkout %s: %s', query.id, exc);
  }
  if (!ok) {
    log.warning('refused pre_checkout %s: payload %r, %s %s',
      query.id, query.invoice_payload, query.total_amount, query.currency);
  }
}

export async function onSuccessfulPayment(bot, message) {
  const payment = message.successful_payment;
  // `from` is absent for a channel post - precisely the delivery this handler
  // accepts no chat-type filter in order to catch. The ledger column is NOT
  // NULL, so an unknown payer is recorded as 0 and shouted about instead.
  const payerUserId = message.from ? message.from.id : 0;
  if (!message.from) {
    log.error('payment %s arrived with no from_user; recording it against payer 0 - '
      + 'the charge id is the only handle on who paid', payment.telegram_payment_charge_id);
  }

  // The price is deliberately not re-checked here: see parseChatId.
  const chatId = parseChatId(payment.invoice_payload);
  if (chatId === null) {
    // Money moved and we cannot tell for whom. Nothing can be credited, but
    // this must be loud: the charge id is the only handle on it.
    log.error('payment %s from user %s has an unusable payload %r',
      payment.telegram_payment_charge_id, payerUserId, payment.invoice_payload);
    return;
  }
  // Telegram's own figure for what it charged, not the payload's copy of it.
  const stars = payment.total_amount;

  let expiry = null;
  if (payment.subscription_expiration_date) {
    const candidate = new Date(payment.subscription_expiration_date * 1000);
    // datetime.fromtimestamp raises past year 9999; a bad value must not
    // escape before recordPayment runs and leave money with no ledger row.
    if (Number.isNaN(candidate.getTime()) || candidate.getUTCFullYear() > 9999
        || candidate.getUTCFullYear() < 1) {
      log.warning('chat %s payment %s has an unusable subscription_expiration_date %r; '
        + 'falling back to a fresh %s-second subscription',
        chatId, payment.telegram_payment_charge_id, payment.subscription_expiration_date,
        config.SUBSCRIPTION_PERIOD);
    } else {
      expiry = candidate;
    }
  }
  if (expiry === null) {
    // Either the field is absent - it is optional in the Bot API - or it was
    // unusable. A missing or bad one must not leave a paying customer with
    // nothing.
    expiry = addSeconds(now(), config.SUBSCRIPTION_PERIOD);
  }
  const expiresAt = stamp(expiry);

  const recorded = await bestEffort('record_payment', chatId, billing.recordPayment, {
    chargeId: payment.telegram_payment_charge_id, chatId, payerUserId, stars,
    isRecurring: Boolean(payment.is_recurring), expiresAt,
  });

  const lang = await chatLang(chatId);
  if (recorded === null) {
    log.error('could not record payment %s for chat %s - the money moved and the ledger did not',
      payment.telegram_payment_charge_id, chatId);
    await say(bot, message, t('pay_unrecorded', lang));
    return;
  }
  if (recorded === false) {
    log.info('payment %s redelivered for chat %s, ignored', payment.telegram_payment_charge_id, chatId);
    return;
  }

  log.info('chat %s paid %s stars until %s (recurring=%s)',
    chatId, stars, expiresAt, Boolean(payment.is_recurring) ? 'True' : 'False');
  const days = tiers.daysLeft(expiresAt, { now: now() });
  // The title is the group's own, chosen by whoever named it; an unescaped
  // "&" or "<" makes Telegram reject the whole send, so the payer would be
  // charged and never thanked.
  await say(bot, message,
    t('pay_thanks', lang, { title: escape(await chatTitle(chatId)), days })
    + '\n\n' + t('pay_cancel_hint', lang));
}
