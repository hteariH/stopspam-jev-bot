"""Buttons on a review card. Only admins of the source chat may press them.

A card sits in the group's log chat, which can hold people who are not
admins of the group the card is about. Every press is therefore checked
against Telegram, for the chat the review belongs to - never the chat the
card happens to be sitting in, and never a value cached in the database.
"""
import functools
import logging
import sqlite3

from aiogram import F, Router
from aiogram.exceptions import TelegramAPIError
from aiogram.types import CallbackQuery

from core import guards
from storage import audit, chats, reviews, trust
from texts import t

log = logging.getLogger("stopspam.review")

router = Router(name="review")

_DECISION = {"ban": "delete_ban", "del": "delete", "ok": "not_spam"}
_DONE_TEXT = {"ban": "done_ban", "del": "done_delete", "ok": "done_not_spam"}

# SQLite's INTEGER column is a signed 64-bit value. Python ints are
# arbitrary precision, so a digit-only id outside this range parses fine
# with int() but then makes sqlite3 raise OverflowError when it tries to
# bind the parameter - an exception reviews.get() can't be wrapped against
# without asking the database a question that can never have an answer. No
# real review id can be outside this range anyway (they come from an
# AUTOINCREMENT primary key), so it is rejected here, at validation time.
_SQLITE_INT_MIN = -(2**63)
_SQLITE_INT_MAX = 2**63 - 1


# A card press must always get an answer back to the admin's client, even if
# sqlite is locked or the disk is full.
_best_effort = functools.partial(guards.best_effort, log)


@router.callback_query(F.data.startswith("rv:"))
async def on_card_button(query: CallbackQuery) -> None:
    # A client can send arbitrary callback data - the "rv:" prefix filter
    # above does not guarantee a well-formed action or a numeric id. None of
    # these shapes correspond to anything actionable, so the honest answer
    # is the same "already handled" a stale/unknown review id gets below;
    # the point is that every path answers the query and none of them raise.
    parts = query.data.split(":", 2)
    if len(parts) != 3 or parts[1] not in _DECISION:
        await query.answer(t("already_handled"))
        return
    _, action, raw_id = parts
    try:
        review_id = int(raw_id)
    except ValueError:
        await query.answer(t("already_handled"))
        return
    if not (_SQLITE_INT_MIN <= review_id <= _SQLITE_INT_MAX):
        await query.answer(t("already_handled"))
        return

    try:
        review = reviews.get(review_id)
    except sqlite3.Error as exc:
        log.warning("storage call failed (get_review) for review %s: %s", review_id, exc)
        review = None
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

    if not await guards.is_admin(query.bot, review["chat_id"], query.from_user.id):
        await query.answer(t("not_admin", lang), show_alert=True)
        return

    # Claim the review before doing anything destructive. reviews.resolve()
    # only succeeds (returns True) for whichever caller's UPDATE lands first
    # against a still-unresolved row, so this is the point that makes two
    # overlapping presses on the same review - a double-tap, or two admins
    # racing on the same card - safe: everyone who arrives after the first
    # successful claim gets `False` here and stops, instead of both racers
    # reading "unresolved", both passing the admin check above, and both
    # running the delete/ban. A storage failure (caught by _best_effort,
    # returning None) is treated the same as losing the race: fail closed
    # rather than perform a destructive action with no record of it.
    #
    # This does mean the review can end up marked resolved even if the
    # delete or ban below then fails against Telegram - the admin still
    # sees the normal "done" outcome and the edited card, with only a
    # warning in the logs. That is the trade decision 4 already makes for
    # this task: a Telegram failure must not abort the bookkeeping, and a
    # card that looks unhandled forever is worse than one that is a beat
    # behind Telegram.
    claimed = _best_effort("resolve", review["chat_id"], reviews.resolve,
                           review_id, _DECISION[action], query.from_user.id)
    if not claimed:
        await query.answer(t("already_handled", lang))
        return

    if action in ("ban", "del"):
        try:
            await query.bot.delete_message(review["chat_id"], review["message_id"])
        except TelegramAPIError as exc:
            # The message may already be gone (another admin, the user
            # themself, or a prior failed retry). The review is already
            # claimed and resolved above, so this failure only affects
            # Telegram state, never whether the decision gets recorded.
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

    _best_effort("audit", review["chat_id"], audit.record,
                 review["chat_id"], review["user_id"], review["message_id"],
                 review["risk"], f"card_{action}", f"by_admin_{query.from_user.id}")

    outcome = t(_DONE_TEXT[action], lang)
    try:
        await query.message.edit_text(f"{query.message.html_text}\n\n<i>{outcome}</i>")
    except TelegramAPIError as exc:
        log.warning("could not edit card for chat %s: %s", review["chat_id"], exc)
    await query.answer(outcome)
