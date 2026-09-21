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

from aiogram.enums import ChatMemberStatus
from aiogram.exceptions import TelegramAPIError

ADMIN_STATUSES = {ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR}


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


async def is_admin(bot, chat_id: int, user_id: int) -> bool:
    """True when the user administers or owns the chat, per Telegram right now.

    Never reads a cached value: a stale row in our own database must not be
    enough to grant control over a group's moderation.
    """
    try:
        member = await bot.get_chat_member(chat_id, user_id)
    except TelegramAPIError:
        return False
    return member.status in ADMIN_STATUSES
