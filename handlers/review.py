"""Buttons on a review card. Only admins of the source chat may press them.

A card sits in the group's log chat, which can hold people who are not
admins of the group the card is about. Every press is therefore checked
against Telegram, for the chat the review belongs to - never the chat the
card happens to be sitting in, and never a value cached in the database.
"""
import logging
import sqlite3

from aiogram import F, Router
from aiogram.enums import ChatMemberStatus
from aiogram.exceptions import TelegramAPIError
from aiogram.types import CallbackQuery

from storage import audit, chats, reviews, trust
from texts import t

log = logging.getLogger("stopspam.review")

router = Router(name="review")

ADMIN_STATUSES = {ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR}
_DECISION = {"ban": "delete_ban", "del": "delete", "ok": "not_spam"}
_DONE_TEXT = {"ban": "done_ban", "del": "done_delete", "ok": "done_not_spam"}


def _best_effort(what: str, chat_id: int, fn, *args, **kwargs):
    """Runs a storage call without letting a DB failure escape the handler.

    Mirrors core.pipeline._best_effort and core.actions._best_effort: a card
    press must always get an answer back to the admin's client, even if
    sqlite is locked or the disk is full. Losing one row here (a resolved
    decision, a trust bump, an audit line) is the acceptable trade against a
    callback query that times out with no response at all.
    """
    try:
        return fn(*args, **kwargs)
    except sqlite3.Error as exc:
        log.warning("storage call failed (%s) for chat %s: %s", what, chat_id, exc)
        return None


async def _is_admin(bot, chat_id: int, user_id: int) -> bool:
    try:
        member = await bot.get_chat_member(chat_id, user_id)
    except TelegramAPIError:
        return False
    return member.status in ADMIN_STATUSES


@router.callback_query(F.data.startswith("rv:"))
async def on_card_button(query: CallbackQuery) -> None:
    _, action, raw_id = query.data.split(":", 2)
    review_id = int(raw_id)

    review = _best_effort("get_review", review_id, reviews.get, review_id)
    if review is None:
        # Either the id never existed, or the lookup itself failed. Either
        # way there is nothing left to act on, and "already handled" is the
        # honest answer: this press changes nothing.
        await query.answer(t("already_handled"))
        return

    chat = _best_effort("get_chat", review["chat_id"], chats.get_chat, review["chat_id"])
    lang = chat.lang if chat else "en"

    if review["decision"] is not None:
        await query.answer(t("already_handled", lang))
        return

    if not await _is_admin(query.bot, review["chat_id"], query.from_user.id):
        await query.answer(t("not_admin", lang), show_alert=True)
        return

    if action in ("ban", "del"):
        try:
            await query.bot.delete_message(review["chat_id"], review["message_id"])
        except TelegramAPIError as exc:
            # The message may already be gone (another admin, the user
            # themself, or a prior failed retry). The admin's decision still
            # needs to be recorded either way - a card that looks unhandled
            # forever is worse than one that's a beat behind Telegram.
            log.warning("delete from card failed for chat %s: %s", review["chat_id"], exc)
    if action == "ban":
        try:
            await query.bot.ban_chat_member(review["chat_id"], review["user_id"])
        except TelegramAPIError as exc:
            log.warning("ban from card failed for chat %s: %s", review["chat_id"], exc)
        _best_effort("mark_flagged", review["chat_id"], trust.mark_flagged,
                     review["chat_id"], review["user_id"])
    if action == "ok":
        _best_effort("allowlist", review["chat_id"], trust.allowlist,
                     review["chat_id"], review["user_id"])

    # resolve() is what makes a second press a no-op (the check above reads
    # review["decision"]), so it is the storage write that matters most to
    # land here. It runs before the audit line, which is bookkeeping only -
    # duplicating an audit row on a rare double press is harmless, but a
    # review that never resolves would let the same message be re-actioned
    # indefinitely.
    _best_effort("resolve", review["chat_id"], reviews.resolve,
                 review_id, _DECISION[action], query.from_user.id)
    _best_effort("audit", review["chat_id"], audit.record,
                 review["chat_id"], review["user_id"], review["message_id"],
                 review["risk"], f"card_{action}", f"by_admin_{query.from_user.id}")

    outcome = t(_DONE_TEXT[action], lang)
    try:
        await query.message.edit_text(f"{query.message.html_text}\n\n<i>{outcome}</i>")
    except TelegramAPIError as exc:
        log.warning("could not edit card for chat %s: %s", review["chat_id"], exc)
    await query.answer(outcome)
