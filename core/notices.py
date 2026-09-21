"""Telling an admin before the bot stops deleting, and after it has.

The bot going quiet is the failure this exists to prevent: a group that grows
past the free limit and silently stops being enforced is the bot failing at
its job exactly when the group became worth attacking.
"""
import logging
from datetime import datetime, timezone

from aiogram.exceptions import TelegramAPIError
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

import config
from core import actions, guards, offer, tiers
from storage import billing
from texts import t

log = logging.getLogger("stopspam.notices")

STAGE_GRACE = "grace"
STAGE_GRACE_ENDING = "grace_ending"
STAGE_LAPSED = "lapsed"

# Stages only ever move forward. A chat that dips back under the member limit
# and climbs out again must not re-announce a trial it already had.
_ORDER = (STAGE_GRACE, STAGE_GRACE_ENDING, STAGE_LAPSED)

_TEXT = {
    STAGE_GRACE: "notice_grace",
    STAGE_GRACE_ENDING: "notice_grace_ending",
    STAGE_LAPSED: "notice_lapsed",
}


def next_stage(entitlement, *, grace_until: str | None,
               notified_stage: str | None, now: datetime) -> str | None:
    """Which notice this chat is due, or None.

    Pure, so every transition can be tested without a bot. The stage flag is
    what bounds how often anything is sent - stronger than a timer, because a
    stage that has been announced is never announced again at all.
    """
    if entitlement.tier == tiers.FREE:
        return None

    candidate = None
    if entitlement.reason == "grace":
        remaining = tiers.days_left(grace_until, now=now)
        candidate = (STAGE_GRACE_ENDING if remaining <= config.GRACE_WARN_DAYS
                     else STAGE_GRACE)
    elif entitlement.reason == "not_entitled":
        candidate = STAGE_LAPSED

    if candidate is None:
        return None
    if notified_stage is None:
        return candidate
    if notified_stage not in _ORDER:
        return candidate
    return candidate if _ORDER.index(candidate) > _ORDER.index(notified_stage) else None


async def maybe_notify(bot, *, chat, row, entitlement) -> None:
    """Sends the due notice, if any, and records that it went out.

    The stage is recorded only after Telegram accepted the message. Recording
    it first would burn the one announcement a chat gets on a send that never
    arrived, and the admin would never be told at all.
    """
    now = datetime.now(timezone.utc)
    stage = next_stage(entitlement, grace_until=row.grace_until,
                       notified_stage=row.notified_stage, now=now)
    if stage is None:
        return

    target = actions.card_destination(chat)
    if target is None:
        log.warning("chat %s has no destination: %s notice skipped",
                    chat.chat_id, stage)
        return

    days = tiers.days_left(
        row.grace_until if stage != STAGE_LAPSED else row.paid_until, now=now)
    body = t(_TEXT[stage], chat.lang, title=chat.title or str(chat.chat_id),
             limit=config.FREE_MEMBER_LIMIT, days=days)

    keyboard = None
    url = await offer.subscribe_link(bot, chat_id=chat.chat_id,
                                     title=chat.title or str(chat.chat_id),
                                     stars=entitlement.price, lang=chat.lang)
    if url:
        keyboard = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(
                text=t("btn_subscribe", chat.lang, stars=entitlement.price), url=url)]])

    try:
        await bot.send_message(target, body, reply_markup=keyboard)
    except TelegramAPIError as exc:
        log.warning("could not send the %s notice for chat %s: %s",
                    stage, chat.chat_id, exc)
        return

    guards.best_effort(log, "set_notified_stage", chat.chat_id,
                       billing.set_notified_stage, chat.chat_id, stage)
