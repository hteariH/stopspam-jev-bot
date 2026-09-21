"""Executes a decision against Telegram. Nothing here decides anything."""
import functools
import json
import logging

from aiogram.exceptions import TelegramAPIError

from core import guards
from core.cards import card_keyboard, render_card
from core.policy import Action
from core.ratelimit import RateLimiter
from storage import audit, reviews
from texts import t

log = logging.getLogger("stopspam.actions")

# apply()'s contract is that a decision already made must reach Telegram even
# if sqlite is locked or the disk is full. reviews.create's return value - the
# review id - decides whether the card can carry working buttons, so here the
# result matters and not only the attempt.
_best_effort = functools.partial(guards.best_effort, log)


def card_destination(chat) -> int | None:
    """Where this chat's review cards go, or None if nowhere.

    Never the moderated group itself, and there is no fallback that could
    make it so. A card quotes the message the bot just decided about, names
    its author and their user id, and carries Delete and Ban buttons; posting
    that into the group it came from republishes the spam to every member and
    hands them the moderation buttons - and during the first 7 days, when the
    bot deletes nothing by design, it would do that for every grey-zone
    message. The spec's fallback is the admin's DM precisely to avoid this.

    A Telegram user id is a valid chat id for a direct message, so a chat's
    destination is either an admin's DM (a positive id, recorded when they
    added the bot or claimed the cards from the menu) or a moderator group
    (a negative id, set with /setlog). When it is neither, the card is
    skipped and logged: nowhere is better than the group itself, and the
    audit row still records the decision, so nothing is lost silently.
    """
    if chat.log_chat_id is None or chat.log_chat_id == chat.chat_id:
        return None
    return chat.log_chat_id


async def apply(bot, *, message, outcome, chat, limiter: RateLimiter) -> str:
    decision, verdict = outcome.decision, outcome.verdict
    if decision is None or decision.action == Action.IGNORE:
        return "ignored"

    if not limiter.allow(chat.chat_id):
        log.warning("enforcement rate limit hit in chat %s", chat.chat_id)
        _best_effort("audit_rate_limited", chat.chat_id, audit.record,
                     chat.chat_id, message.from_user.id, message.message_id,
                     decision.risk, "rate_limited", decision.reason, model=verdict.model)
        return "rate_limited"

    text = message.text or message.caption
    # A missing review row must not cancel an already-decided action: a
    # confident deletion still happens, and the card still reaches admins.
    # It just can't carry buttons bound to a row that doesn't exist.
    review_id = _best_effort("create_review", chat.chat_id, reviews.create,
                             chat.chat_id, message.message_id, message.from_user.id,
                             text, json.dumps(verdict.as_dict()), decision.risk)

    deleted = False
    if decision.action == Action.DELETE:
        try:
            await bot.delete_message(chat.chat_id, message.message_id)
            deleted = True
        except TelegramAPIError as exc:
            log.warning("could not delete in chat %s: %s", chat.chat_id, exc)

    target = card_destination(chat)
    card_sent = False
    if target is None:
        log.warning(
            "chat %s has no review destination: card skipped (%s, risk %.2f). "
            "An admin can set one with /setlog in the chat that should receive "
            "cards, or from the /chats menu.",
            chat.chat_id, decision.action.value, decision.risk)
    else:
        body = render_card(
            decision=decision, verdict=verdict,
            author_name=message.from_user.full_name, author_id=message.from_user.id,
            text=text, chat_title=chat.title or str(chat.chat_id), lang=chat.lang,
        )
        if deleted:
            body += f"\n\n<i>{t('card_deleted', chat.lang)}</i>"
        keyboard = card_keyboard(review_id, chat.lang) if review_id is not None else None
        try:
            await bot.send_message(target, body, reply_markup=keyboard)
            card_sent = True
        except TelegramAPIError as exc:
            log.warning("could not post card to %s: %s", target, exc)

    # A deletion happened whatever became of the card. An undelivered card,
    # though, must not be audited as "reviewed": that reason implies a human
    # saw the message, and nobody did.
    if deleted:
        action, reason = "deleted", decision.reason
    elif card_sent:
        action, reason = "reviewed", decision.reason
    else:
        action, reason = "degraded", f"{decision.reason}/card_undelivered"
    _best_effort("audit_enforcement", chat.chat_id, audit.record,
                 chat.chat_id, message.from_user.id, message.message_id,
                 decision.risk, action, reason, model=verdict.model)
    return action
