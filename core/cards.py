"""Rendering of review cards. Shows the per-question breakdown so an admin can
see why the bot fired, not just that it did."""
import html

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from core.policy import Decision
from core.verdict import Verdict
from texts import t

MAX_QUOTE = 700


def render_card(*, decision: Decision, verdict: Verdict, author_name: str,
                author_id: int, text: str | None, chat_title: str, lang: str) -> str:
    quote = (text or "")[:MAX_QUOTE]
    if text and len(text) > MAX_QUOTE:
        quote += "…"
    return "\n".join([
        f"<b>{html.escape(t('card_title', lang))}</b>",
        f"{html.escape(t('card_chat', lang))}: {html.escape(chat_title)}",
        f"{html.escape(t('card_author', lang))}: "
        f"{html.escape(author_name)} (<code>{author_id}</code>)",
        f"{html.escape(t('card_risk', lang))}: {decision.risk:.2f} ({decision.reason})",
        f"{html.escape(t('card_kind', lang))}: {html.escape(verdict.kind)}",
        "",
        f"<b>{html.escape(t('card_breakdown', lang))}</b>",
        f"<code>spam {verdict.is_spam:.2f} · scam {verdict.is_scam:.2f} · "
        f"contact {verdict.solicits_contact:.2f} · member {verdict.looks_like_member:.2f}\n"
        f"severity {verdict.severity} (confidence {verdict.severity_confidence:.2f})</code>",
        "",
        f"<blockquote>{html.escape(quote)}</blockquote>",
    ])


def card_keyboard(review_id: int, lang: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text=t("btn_ban", lang), callback_data=f"rv:ban:{review_id}"),
        InlineKeyboardButton(text=t("btn_delete", lang), callback_data=f"rv:del:{review_id}"),
        InlineKeyboardButton(text=t("btn_not_spam", lang), callback_data=f"rv:ok:{review_id}"),
    ]])
