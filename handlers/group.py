"""Every group message passes through here."""
import logging
import sqlite3

from aiogram import F, Router
from aiogram.enums import ChatMemberStatus, ChatType
from aiogram.exceptions import TelegramAPIError
from aiogram.types import Message

import config
from core import actions, guards, pipeline, state
from core.jev import JevClient
from storage import chats, trust

log = logging.getLogger("stopspam.group")

router = Router(name="group")
router.message.filter(F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))

_client: JevClient | None = None
_limiter = actions.EnforcementLimiter(config.ENFORCEMENT_PER_MINUTE)


def set_client(client: JevClient) -> None:
    global _client
    _client = client


async def _can_delete(bot, chat_id: int) -> bool:
    try:
        me = await bot.get_chat_member(chat_id, (await bot.me()).id)
    except TelegramAPIError:
        return False
    # An owner always can; an administrator only with the explicit right.
    if me.status == ChatMemberStatus.CREATOR:
        return True
    return bool(getattr(me, "can_delete_messages", False))


@router.message()
async def on_group_message(message: Message) -> None:
    if _client is None or message.from_user is None or message.from_user.is_bot:
        return

    try:
        chat = chats.ensure_chat(message.chat.id, message.chat.title or "")
        row = trust.seen(message.chat.id, message.from_user.id)
    except sqlite3.Error as exc:
        log.warning("storage unavailable for chat %s, skipping message: %s",
                    message.chat.id, exc)
        return

    facts = state.facts_from_message(
        message,
        author_message_count=row.clean_count,
        author_days_in_group=trust.days_in_group(row),
        group_description="",
    )

    is_admin = await guards.is_admin(message.bot, message.chat.id, message.from_user.id)
    can_delete = await _can_delete(message.bot, message.chat.id)

    outcome = await pipeline.evaluate(
        _client,
        chat=chat,
        facts=facts,
        trust_row=row,
        is_admin=is_admin,
        can_delete=can_delete,
    )

    await actions.apply(message.bot, message=message, outcome=outcome,
                        chat=chat, limiter=_limiter)
