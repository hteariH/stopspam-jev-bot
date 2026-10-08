// Rendering of review cards. Shows the per-question breakdown so an admin
// can see why the bot fired, not just that it did.
import { REASON_NOT_ENTITLED } from './policy.js';
import { escape, length, slice } from '../html.js';
import { fixed } from '../pyfmt.js';
import { t } from '../texts.js';

export const MAX_QUOTE = 500;
export const MAX_TITLE = 128;
export const MAX_NAME = 128;

function trim(value, limit) {
  return length(value) <= limit ? value : slice(value, 0, limit) + '…';
}

export function renderCard({ decision, verdict, authorName, authorId, text, chatTitle, lang }) {
  chatTitle = trim(chatTitle, MAX_TITLE);
  authorName = trim(authorName, MAX_NAME);
  const quote = trim(text || '', MAX_QUOTE);
  const lines = [
    `<b>${escape(t('card_title', lang))}</b>`,
    `${escape(t('card_chat', lang))}: ${escape(chatTitle)}`,
    `${escape(t('card_author', lang))}: ${escape(authorName)} (<code>${authorId}</code>)`,
    `${escape(t('card_risk', lang))}: ${fixed(decision.risk, 2)} (${escape(decision.reason)})`,
    `${escape(t('card_kind', lang))}: ${escape(verdict.kind)}`,
  ];
  if (decision.reason === REASON_NOT_ENTITLED) {
    lines.push(`<i>${escape(t('card_not_entitled', lang))}</i>`);
  }
  lines.push(
    '',
    `<b>${escape(t('card_breakdown', lang))}</b>`,
    `<code>spam ${fixed(verdict.is_spam, 2)} · scam ${fixed(verdict.is_scam, 2)} · `
      + `contact ${fixed(verdict.solicits_contact, 2)} · member ${fixed(verdict.looks_like_member, 2)}\n`
      + `severity ${verdict.severity} (confidence ${fixed(verdict.severity_confidence, 2)})</code>`,
    '',
    `<blockquote>${escape(quote)}</blockquote>`,
  );
  return lines.join('\n');
}

// The notice for a trigger-bearing message the classifier never saw.
//
// Deliberately not a card: there is no verdict to show a breakdown of and no
// decision to reverse, so buttons would be buttons that do nothing. What an
// admin needs is to know it happened and to be able to find the message.
export function renderOutageNotice({ authorName, authorId, text, chatTitle, lang }) {
  return [
    `<b>${escape(t('outage_title', lang))}</b>`,
    `${escape(t('card_chat', lang))}: ${escape(trim(chatTitle, MAX_TITLE))}`,
    `${escape(t('card_author', lang))}: ${escape(trim(authorName, MAX_NAME))} (<code>${authorId}</code>)`,
    '',
    escape(t('outage_body', lang)),
    '',
    `<blockquote>${escape(trim(text || '', MAX_QUOTE))}</blockquote>`,
  ].join('\n');
}

// The card's buttons, or null when there are none to show.
//
// The two halves are independent on purpose. A review row that failed to
// write costs the moderation buttons but must not also cost the sale, and a
// chat with no subscription to sell still gets working moderation buttons.
export function cardKeyboard(reviewId, lang, { subscribeUrl = null, stars = 0 } = {}) {
  const rows = [];
  if (reviewId !== null && reviewId !== undefined) {
    rows.push([
      { text: t('btn_ban', lang), callback_data: `rv:ban:${reviewId}` },
      { text: t('btn_delete', lang), callback_data: `rv:del:${reviewId}` },
      { text: t('btn_not_spam', lang), callback_data: `rv:ok:${reviewId}` },
    ]);
  }
  if (subscribeUrl) {
    rows.push([{ text: t('btn_subscribe', lang, { stars }), url: subscribeUrl }]);
  }
  return rows.length ? { inline_keyboard: rows } : null;
}
