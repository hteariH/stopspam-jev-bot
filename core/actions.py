"""Executes a decision against Telegram. Nothing here decides anything."""
import json
import logging
import time
from collections import defaultdict, deque

from aiogram.exceptions import TelegramAPIError

from core.cards import card_keyboard, render_card
from core.policy import Action
from storage import audit, reviews

log = logging.getLogger("stopspam.actions")


class EnforcementLimiter:
    """Caps enforcement per chat per minute so a raid cannot turn the bot into
    a flood source and get it banned."""

    def __init__(self, per_minute: int) -> None:
        self._per_minute = per_minute
        self._events: dict[int, deque[float]] = defaultdict(deque)

    def allow(self, chat_id: int) -> bool:
        window = self._events[chat_id]
        now = time.monotonic()
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= self._per_minute:
            return False
        window.append(now)
        return True


async def apply(bot, *, message, outcome, chat, limiter: EnforcementLimiter) -> str:
    decision, verdict = outcome.decision, outcome.verdict
    if decision is None or decision.action == Action.IGNORE:
        return "ignored"

    if not limiter.allow(chat.chat_id):
        log.warning("enforcement rate limit hit in chat %s", chat.chat_id)
        audit.record(chat.chat_id, message.from_user.id, message.message_id,
                     decision.risk, "rate_limited", decision.reason)
        return "rate_limited"

    text = message.text or message.caption
    review_id = reviews.create(
        chat.chat_id, message.message_id, message.from_user.id, text,
        json.dumps(verdict.as_dict()), decision.risk,
    )

    deleted = False
    if decision.action == Action.DELETE:
        try:
            await bot.delete_message(chat.chat_id, message.message_id)
            deleted = True
        except TelegramAPIError as exc:
            log.warning("could not delete in chat %s: %s", chat.chat_id, exc)

    target = chat.log_chat_id or chat.chat_id
    body = render_card(
        decision=decision, verdict=verdict,
        author_name=message.from_user.full_name, author_id=message.from_user.id,
        text=text, chat_title=chat.title or str(chat.chat_id), lang=chat.lang,
    )
    if deleted:
        from texts import t
        body += f"\n\n<i>{t('card_deleted', chat.lang)}</i>"
    try:
        await bot.send_message(target, body,
                               reply_markup=card_keyboard(review_id, chat.lang))
    except TelegramAPIError as exc:
        log.warning("could not post card to %s: %s", target, exc)

    action = "deleted" if deleted else "reviewed"
    audit.record(chat.chat_id, message.from_user.id, message.message_id,
                 decision.risk, action, decision.reason, model=verdict.model)
    return action
