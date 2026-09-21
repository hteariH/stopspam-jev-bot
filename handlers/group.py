"""Every group message passes through here."""
import logging

from aiogram import F, Router
from aiogram.enums import ChatMemberStatus, ChatType
from aiogram.exceptions import TelegramAPIError
from aiogram.types import Message

import config
from core import actions, pipeline, state
from core.jev import JevClient
from storage import chats, trust

log = logging.getLogger("stopspam.group")

router = Router(name="group")
router.message.filter(F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))

_client: JevClient | None = None
_limiter = actions.EnforcementLimiter(config.ENFORCEMENT_PER_MINUTE)

ADMIN_STATUSES = {ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR}


def set_client(client: JevClient) -> None:
    global _client
    _client = client
    # Detach the router from whatever Dispatcher it was last included into.
    # In the running bot this is a no-op: set_client runs once at startup,
    # before include_router. Tests call it once per case, each time building
    # a fresh Dispatcher, and aiogram refuses to attach a router that already
    # has a parent - so without this, only the first test in the process
    # would ever get past include_router.
    if router.parent_router is not None:
        router.parent_router.sub_routers.remove(router)
        router._parent_router = None


async def _is_admin(bot, chat_id: int, user_id: int) -> bool:
    try:
        member = await bot.get_chat_member(chat_id, user_id)
    except TelegramAPIError:
        return False
    return member.status in ADMIN_STATUSES


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

    chat = chats.ensure_chat(message.chat.id, message.chat.title or "")
    row = trust.seen(message.chat.id, message.from_user.id)

    facts = state.facts_from_message(
        message,
        author_message_count=row.clean_count,
        author_days_in_group=trust.days_in_group(row),
        group_description="",
    )

    is_admin = await _is_admin(message.bot, message.chat.id, message.from_user.id)
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
