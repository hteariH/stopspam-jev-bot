// Creating a Stars invoice link. The outbound half of payments.
//
// Separate from handlers/payments, which only receives updates, because
// three callers need to *offer* a subscription - the settings menu, a review
// card, and a lapse notice - and none of them should import a handler module.
import * as config from '../config.js';
import { length, slice } from '../html.js';
import { logger } from '../log.js';
import { t } from '../texts.js';
import { isProgrammingError } from './guards.js';

const log = logger('stopspam.offer');

// createInvoiceLink rejects anything longer, which would make the product
// unbuyable rather than merely untidy.
export const MAX_INVOICE_TITLE = 32;
export const MAX_INVOICE_DESC = 255;
// Leaves room for the rest of the description around it.
export const MAX_GROUP_NAME = 80;

// What comes back to us in pre_checkout and successful_payment.
//
// Everything needed to credit the right chat the right amount, and nothing
// else: the payload is round-tripped through the buyer's client, so it
// carries no names and no secrets.
export function payloadFor(chatId, stars) {
  return `sub:${chatId}:${stars}`;
}

function trim(value, limit) {
  return length(value) <= limit ? value : slice(value, 0, limit - 1) + '…';
}

// A 30-day recurring Stars subscription link, or null if Telegram refused.
//
// null rather than an exception because every caller is a menu, a card or a
// notice that must still render when Telegram is having a bad minute.
export async function subscribeLink(bot, { chatId, title, stars, lang }) {
  const description = trim(
    t('invoice_description', lang, { title: trim(title || String(chatId), MAX_GROUP_NAME), stars }),
    MAX_INVOICE_DESC);
  try {
    return await bot.createInvoiceLink({
      title: trim(t('invoice_title', lang), MAX_INVOICE_TITLE),
      description,
      payload: payloadFor(chatId, stars),
      currency: 'XTR',
      prices: [{ label: t('invoice_label', lang), amount: stars }],
      subscription_period: config.SUBSCRIPTION_PERIOD,
    });
  } catch (exc) {
    if (isProgrammingError(exc)) throw exc;
    log.warning('could not create an invoice link for chat %s: %s', chatId, exc);
    return null;
  }
}
