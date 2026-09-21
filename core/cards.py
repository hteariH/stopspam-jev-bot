"""Rendering of review cards. Shows the per-question breakdown so an admin can
see why the bot fired, not just that it did."""
import html

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from core.policy import Decision, REASON_NOT_ENTITLED
from core.verdict import Verdict
from texts import t

MAX_QUOTE = 500
MAX_TITLE = 128
MAX_NAME = 128


def _trim(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[:limit] + "…"


def render_card(*, decision: Decision, verdict: Verdict, author_name: str,
                author_id: int, text: str | None, chat_title: str, lang: str) -> str:
    chat_title = _trim(chat_title, MAX_TITLE)
    author_name = _trim(author_name, MAX_NAME)
    quote = _trim(text or "", MAX_QUOTE)
    lines = [
        f"<b>{html.escape(t('card_title', lang))}</b>",
        f"{html.escape(t('card_chat', lang))}: {html.escape(chat_title)}",
        f"{html.escape(t('card_author', lang))}: "
        f"{html.escape(author_name)} (<code>{author_id}</code>)",
        f"{html.escape(t('card_risk', lang))}: {decision.risk:.2f} ({html.escape(decision.reason)})",
        f"{html.escape(t('card_kind', lang))}: {html.escape(verdict.kind)}",
    ]
    if decision.reason == REASON_NOT_ENTITLED:
        lines.append(f"<i>{html.escape(t('card_not_entitled', lang))}</i>")
    lines += [
        "",
        f"<b>{html.escape(t('card_breakdown', lang))}</b>",
        f"<code>spam {verdict.is_spam:.2f} · scam {verdict.is_scam:.2f} · "
        f"contact {verdict.solicits_contact:.2f} · member {verdict.looks_like_member:.2f}\n"
        f"severity {verdict.severity} (confidence {verdict.severity_confidence:.2f})</code>",
        "",
        f"<blockquote>{html.escape(quote)}</blockquote>",
    ]
    return "\n".join(lines)


def render_outage_notice(*, author_name: str, author_id: int, text: str | None,
                         chat_title: str, lang: str) -> str:
    """The notice for a trigger-bearing message the classifier never saw.

    The spec's failure handling says a message left alone during an outage
    "becomes a review card" if it carried triggers. This is deliberately not
    a card: there is no verdict to show a breakdown of and no decision to
    reverse, so buttons would be buttons that do nothing. What an admin needs
    is to know it happened and to be able to find the message, which is the
    author, the chat and enough of the text to recognise it.
    """
    return "\n".join([
        f"<b>{html.escape(t('outage_title', lang))}</b>",
        f"{html.escape(t('card_chat', lang))}: "
        f"{html.escape(_trim(chat_title, MAX_TITLE))}",
        f"{html.escape(t('card_author', lang))}: "
        f"{html.escape(_trim(author_name, MAX_NAME))} (<code>{author_id}</code>)",
        "",
        html.escape(t("outage_body", lang)),
        "",
        f"<blockquote>{html.escape(_trim(text or '', MAX_QUOTE))}</blockquote>",
    ])


def card_keyboard(review_id: int | None, lang: str, *, subscribe_url: str | None = None,
                  stars: int = 0) -> InlineKeyboardMarkup | None:
    """The card's buttons, or None when there are none to show.

    The two halves are independent on purpose. A review row that failed to
    write costs the moderation buttons but must not also cost the sale, and a
    chat with no subscription to sell still gets working moderation buttons.
    """
    rows = []
    if review_id is not None:
        rows.append([
            InlineKeyboardButton(text=t("btn_ban", lang), callback_data=f"rv:ban:{review_id}"),
            InlineKeyboardButton(text=t("btn_delete", lang), callback_data=f"rv:del:{review_id}"),
            InlineKeyboardButton(text=t("btn_not_spam", lang), callback_data=f"rv:ok:{review_id}"),
        ])
    if subscribe_url:
        rows.append([InlineKeyboardButton(text=t("btn_subscribe", lang, stars=stars),
                                          url=subscribe_url)])
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None
