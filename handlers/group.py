"""Every group message passes through here."""
import logging
import sqlite3

from aiogram import F, Router
from aiogram.enums import ChatMemberStatus, ChatType
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import Command
from aiogram.types import ChatMemberUpdated, Message

import config
from core import actions, guards, pipeline, ratelimit, state
from core.jev import JevClient
from storage import chats, trust
from texts import t

log = logging.getLogger("stopspam.group")

_GROUP_TYPES = {ChatType.GROUP, ChatType.SUPERGROUP}

router = Router(name="group")
router.message.filter(F.chat.type.in_(_GROUP_TYPES))
# The filter above is registered on the message observer only, so the
# my_chat_member observer needs its own.
router.my_chat_member.filter(F.chat.type.in_(_GROUP_TYPES))

_client: JevClient | None = None
_limiter = ratelimit.RateLimiter(config.ENFORCEMENT_PER_MINUTE)

# /setlog verifies the caller against Telegram once per candidate chat, so it
# is bounded and rate-limited exactly like /chats is.
MAX_SETLOG_CHATS = 20
SETLOG_PER_MINUTE = 2
_setlog_limiter = ratelimit.RateLimiter(SETLOG_PER_MINUTE)


def set_client(client: JevClient) -> None:
    global _client
    _client = client


async def _say(message: Message, body: str) -> None:
    """Replies in a group without letting a Telegram failure escape a handler."""
    try:
        await message.answer(body)
    except TelegramAPIError as exc:
        log.warning("could not reply in chat %s: %s", message.chat.id, exc)


def _lang(chat_id: int) -> str:
    chat = guards.best_effort(log, "get_chat", chat_id, chats.get_chat, chat_id)
    return chat.lang if chat else "en"


async def _can_delete(bot, chat_id: int) -> bool:
    try:
        me = await bot.get_chat_member(chat_id, (await bot.me()).id)
    except TelegramAPIError:
        return False
    # An owner always can; an administrator only with the explicit right.
    if me.status == ChatMemberStatus.CREATOR:
        return True
    return bool(getattr(me, "can_delete_messages", False))


@router.my_chat_member()
async def on_bot_membership_changed(update: ChatMemberUpdated) -> None:
    """Records who added the bot, as that chat's review-card destination.

    This is what gives every group a private destination from the moment the
    bot arrives. Without it a freshly added chat has none, and core.actions
    refuses to post cards at all rather than posting them into the group
    being moderated - so this handler is what makes the bot useful on day
    one, not merely safe.

    Only ever fills an empty destination: a chat that already has one has had
    it chosen by an admin, and a re-promotion must not quietly take it back.
    """
    if update.from_user is None or update.from_user.is_bot:
        return
    if update.new_chat_member.status in (ChatMemberStatus.LEFT, ChatMemberStatus.KICKED):
        return
    try:
        chat = chats.ensure_chat(update.chat.id, update.chat.title or "")
        if chat.log_chat_id is None:
            chats.update_chat(update.chat.id, log_chat_id=update.from_user.id)
            log.info("chat %s: review cards will go to user %s, who added the bot",
                     update.chat.id, update.from_user.id)
    except sqlite3.Error as exc:
        log.warning("could not record the log chat for %s: %s", update.chat.id, exc)


@router.message(Command("setlog"))
async def on_setlog(message: Message) -> None:
    """Points the review cards of the caller's groups at this chat.

    Run in a dedicated moderator group by an admin of it, this is how cards
    stop going to one person's DM and start going somewhere a moderation team
    can see them. The caller is verified against Telegram both here and for
    every group being redirected, so nobody can aim another group's cards -
    which quote its members' messages - at a chat they do not administer.

    This chat is skipped if it is itself one of the caller's groups: a chat is
    never its own card destination.
    """
    if message.from_user is None or message.from_user.is_bot:
        return
    here, user_id = message.chat.id, message.from_user.id
    lang = _lang(here)

    if not _setlog_limiter.allow(user_id):
        await _say(message, t("too_many_requests", lang))
        return

    if await guards.admin_check(message.bot, here, user_id) is not guards.AdminCheck.ADMIN:
        await _say(message, t("setlog_not_admin", lang))
        return

    candidates = guards.best_effort(log, "candidate_chats", here,
                                    chats.candidate_chat_ids, user_id,
                                    MAX_SETLOG_CHATS) or []
    redirected = 0
    for chat_id in candidates:
        if chat_id == here:
            continue
        if not await guards.is_admin(message.bot, chat_id, user_id):
            continue
        if guards.best_effort(log, "set_log_chat", chat_id, chats.update_chat,
                              chat_id, log_chat_id=here) is not None:
            redirected += 1

    if redirected:
        log.info("chat %s now receives the cards of %s chat(s), set by user %s",
                 here, redirected, user_id)
        await _say(message, t("setlog_done", lang, count=redirected))
    else:
        await _say(message, t("setlog_none", lang))


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

    # This is the only place in the bot where the answer to "is this an
    # admin?" decides whether somebody gets acted upon rather than whether
    # they get handed control of something. A failed lookup here must
    # therefore not read as "ordinary member": that would turn a transient
    # Telegram error into a deletion aimed at a possible administrator,
    # against the one guard the spec says cannot be configured away. The
    # message is dropped instead - unchecked, unclassified, with no API call
    # spent - which is the spec's rule that uncertainty resolves to not
    # acting. A message lost to an outage is recoverable; a deleted admin
    # post is not.
    check = await guards.admin_check(message.bot, message.chat.id, message.from_user.id)
    if check is guards.AdminCheck.UNKNOWN:
        log.warning("admin status unknown for user %s in chat %s, skipping message",
                    message.from_user.id, message.chat.id)
        return
    is_admin = check is guards.AdminCheck.ADMIN
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
