"""Shared safety primitives.

Both things here existed as three or four near-identical private copies across
``handlers/`` and ``core/``. They are consolidated because they are exactly the
kind of code that must not drift:

- ``is_admin`` is the security primitive the whole product rests on. The spec
  makes "administrators and group owners are never acted upon" a hard-coded,
  unconfigurable guard, so one copy of this check going wrong is a wrong
  deletion in somebody else's group.
- ``best_effort`` is the contract that a decision already made still reaches
  Telegram when sqlite is locked or the disk is full. Two of the old copies
  returned the call's result and one silently returned ``None``, so a caller
  moved between modules would have changed meaning without changing shape.
"""
import logging
import sqlite3
from enum import Enum

from aiogram.enums import ChatMemberStatus
from aiogram.exceptions import TelegramAPIError

log = logging.getLogger("stopspam.guards")

ADMIN_STATUSES = {ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR}


class AdminCheck(str, Enum):
    """The three honest answers to "does this user administer this chat?"

    UNKNOWN exists because Telegram can simply fail to answer, and the two
    kinds of caller want opposite things from that failure. A caller deciding
    whether to *act on* a user must not read a failed lookup as "ordinary
    member"; a caller deciding whether to *grant* someone control must not
    read it as "administrator". Collapsing the failure into a bool inside this
    module would silently pick one of those for both.
    """

    ADMIN = "admin"
    NOT_ADMIN = "not_admin"
    UNKNOWN = "unknown"


def best_effort(log: logging.Logger, what: str, chat_id: int, fn, *args, **kwargs):
    """Runs a storage call without letting a DB failure escape the caller.

    Returns the call's result, or ``None`` if it failed. Callers that need to
    distinguish the two (``reviews.create``'s return value decides whether a
    card can carry working buttons) can; callers that only want the write
    attempted can ignore it.

    Losing one row here - a trust bump, an audit line, a resolved decision -
    is the accepted trade against dropping a message from moderation entirely
    or leaving a button press unanswered. The warning is what keeps a
    persistent storage problem from going unnoticed, since the row that would
    have recorded it is gone either way.

    ``log`` is passed in rather than taken from this module so each warning
    still carries the calling module's logger name.
    """
    try:
        return fn(*args, **kwargs)
    except sqlite3.Error as exc:
        log.warning("storage call failed (%s) for chat %s: %s", what, chat_id, exc)
        return None


async def admin_check(bot, chat_id: int, user_id: int) -> AdminCheck:
    """Asks Telegram whether the user administers or owns the chat, right now.

    Never reads a cached value: a stale row in our own database must not be
    enough to grant control over a group's moderation.

    A Telegram failure returns UNKNOWN rather than a guess. The spec's
    governing rule is that any uncertainty resolves to not acting, and a
    transient API error is exactly that uncertainty.
    """
    try:
        member = await bot.get_chat_member(chat_id, user_id)
    except TelegramAPIError as exc:
        log.warning("admin lookup failed for user %s in chat %s: %s",
                    user_id, chat_id, exc)
        return AdminCheck.UNKNOWN
    return AdminCheck.ADMIN if member.status in ADMIN_STATUSES else AdminCheck.NOT_ADMIN


async def is_admin(bot, chat_id: int, user_id: int) -> bool:
    """True only when Telegram positively confirms the user is an admin.

    Use this where a False *denies* something - a settings menu, a review-card
    button - so that a failed lookup fails closed. Do NOT use it to decide
    whether a user may be acted upon: there a False permits the action, and a
    failed lookup would turn a possible admin into an ordinary member.
    Call admin_check() and handle UNKNOWN explicitly for that.
    """
    return await admin_check(bot, chat_id, user_id) is AdminCheck.ADMIN
