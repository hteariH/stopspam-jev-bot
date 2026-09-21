"""Configuration menu in a private chat with the bot.

Admin rights are checked against Telegram on every menu render and every
button press, exactly like handlers.review does for the review card: a
stale row in the chats table must never be enough to grant control over a
group's moderation settings, so the presser's status for the group being
configured is always looked up fresh, never read from our own database.
"""
import functools
import html
import logging
from datetime import datetime, timezone

from aiogram import F, Router
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import Command, CommandStart
from aiogram.types import (CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup,
                           Message)

import config
from core import guards, offer, ratelimit, tiers
from storage import billing, chats
from texts import t

log = logging.getLogger("stopspam.admin")

router = Router(name="admin")
router.message.filter(F.chat.type == ChatType.PRIVATE)

THRESHOLD_STEP = 0.05

# Hard cap on how many chats one /chats can look up and render. Nothing about
# a genuine admin needs more than this, and it bounds what a stranger can
# make the bot spend in one command.
MAX_MENU_CHATS = 20
# ...and a per-user limit on how often they can spend it at all, which the
# spec asks for on this command.
CHATS_PER_MINUTE = 3
_chats_limiter = ratelimit.RateLimiter(CHATS_PER_MINUTE)
_LANGS = ("en", "ru", "uk")
_TOGGLE_FIELDS = {"mode", "jev", "lang", "log", "gonow"}
_THRESHOLD_FIELDS = {"delete_threshold", "review_threshold", "confidence_floor"}
_DELTAS = {"+", "-"}

# SQLite's INTEGER column is a signed 64-bit value. Python ints are
# arbitrary precision, so a digit-only chat id outside this range parses
# fine with int() but then makes sqlite3 raise OverflowError when it tries
# to bind the parameter. No real Telegram chat id is outside this range, so
# it is rejected here, at validation time, mirroring handlers.review.
_SQLITE_INT_MIN = -(2**63)
_SQLITE_INT_MAX = 2**63 - 1


# A button press must always get an answer back to the admin's client, even
# if sqlite is locked or the disk is full.
_best_effort = functools.partial(guards.best_effort, log)


async def _admin_chats(bot, user_id: int) -> list:
    """Chats the caller administers, re-verified against Telegram, not cached.

    The candidate set is narrowed in storage first; only those are looked up
    against Telegram, so the number of get_chat_member calls this command can
    cause is bounded by MAX_MENU_CHATS rather than by the size of the chats
    table.
    """
    candidates = _best_effort("candidate_chats", user_id, chats.candidate_chat_ids,
                              user_id, MAX_MENU_CHATS) or []
    result = []
    for chat_id in candidates:
        if await guards.is_admin(bot, chat_id, user_id):
            chat = _best_effort("get_chat", chat_id, chats.get_chat, chat_id)
            if chat is not None:
                result.append(chat)
    return result


def _mode_label(chat, lang: str) -> str:
    return t("btn_mode_active" if chat.mode == "observe" else "btn_mode_observe", lang)


def _jev_label(chat, lang: str) -> str:
    return t("btn_jev_off" if chat.jev_enabled else "btn_jev_on", lang)


def _log_chat_label(chat, lang: str) -> str:
    """Says where this chat's cards actually go, in words.

    The menu used to print the raw log_chat_id or an em dash, and an em dash
    was what every real chat showed, since nothing wrote the column. It read
    like a setting nobody had bothered with, when it was in fact the reason
    cards were landing in the moderated group. Telegram user ids are positive
    and chat ids are negative, which is what distinguishes an admin's DM from
    a moderator group here.
    """
    if chat.log_chat_id is None or chat.log_chat_id == chat.chat_id:
        return t("log_chat_unset", lang)
    if chat.log_chat_id > 0:
        return t("log_chat_dm", lang, user_id=chat.log_chat_id)
    return t("log_chat_group", lang, chat_id=chat.log_chat_id)


def _billing_label(chat, row, lang: str) -> str:
    """The plan line, in words an admin can act on.

    Says what is happening rather than naming a tier: "no subscription - I
    report spam but do not delete it" is a sentence somebody can decide about,
    where "tier: large" is not.
    """
    now = datetime.now(timezone.utc)
    tier = tiers.tier_for(row.member_count)
    if tier == tiers.FREE:
        return t("billing_free", lang, count=row.member_count or 0,
                 limit=config.FREE_MEMBER_LIMIT)
    ent = tiers.build(tier, paid_until=row.paid_until,
                      grace_until=row.grace_until, now=now)
    if ent.reason == "subscribed":
        return t("billing_subscribed", lang,
                 days=tiers.days_left(row.paid_until, now=now))
    if ent.reason == "grace":
        return t("billing_grace", lang,
                 days=tiers.days_left(row.grace_until, now=now))
    return t("billing_none", lang)


def _menu(chat, row) -> tuple[str, InlineKeyboardMarkup]:
    lang = chat.lang
    cid = chat.chat_id
    # chat.title comes from Telegram (the group's own title) and is sent
    # with HTML parse mode, exactly like core.cards.render_card's chat_title
    # - it must be escaped before it reaches the message body, or a title
    # containing "&"/"<"/">" makes Telegram reject the whole send.
    safe_title = html.escape(chat.title) if chat.title else str(cid)
    delete_label = t("menu_delete_threshold", lang)
    review_label = t("menu_review_threshold", lang)
    body = "\n".join([
        t("menu_title", lang, title=safe_title),
        "",
        f"{t('menu_mode', lang)}: {chat.mode}",
        f"{t('menu_jev', lang)}: {'on' if chat.jev_enabled else 'off'}",
        f"{t('menu_thresholds', lang)}: {delete_label} ≥ {chat.delete_threshold:.2f}, "
        f"{review_label} ≥ {chat.review_threshold:.2f}",
        f"{t('menu_lang', lang)}: {lang}",
        f"{t('menu_log_chat', lang)}: {_log_chat_label(chat, lang)}",
        f"{t('menu_billing', lang)}: {_billing_label(chat, row, lang)}",
    ])
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=_mode_label(chat, lang), callback_data=f"cfg:{cid}:mode"),
         InlineKeyboardButton(text=_jev_label(chat, lang), callback_data=f"cfg:{cid}:jev")],
        [InlineKeyboardButton(text=f"{delete_label} −",
                              callback_data=f"cfg:{cid}:thr:delete_threshold:-"),
         InlineKeyboardButton(text=f"{delete_label} +",
                              callback_data=f"cfg:{cid}:thr:delete_threshold:+")],
        [InlineKeyboardButton(text=f"{review_label} −",
                              callback_data=f"cfg:{cid}:thr:review_threshold:-"),
         InlineKeyboardButton(text=f"{review_label} +",
                              callback_data=f"cfg:{cid}:thr:review_threshold:+")],
        [InlineKeyboardButton(text=f"{t('menu_lang', lang)}: {lang}",
                              callback_data=f"cfg:{cid}:lang")],
        [InlineKeyboardButton(text=t("btn_log_here", lang),
                              callback_data=f"cfg:{cid}:log")],
    ])
    if chats.is_observing(chat):
        keyboard.inline_keyboard.append([
            InlineKeyboardButton(text=t("btn_start_deleting", lang),
                                 callback_data=f"cfg:{cid}:gonow")])
    return body, keyboard


async def _say(message: Message, body: str) -> None:
    """Answers a DM without letting a Telegram failure escape the handler.

    Nothing here is retried or recovered - the point is only that no
    unhandled exception leaves a handler, which is this project's rule.
    """
    try:
        await message.answer(body)
    except TelegramAPIError as exc:
        log.warning("could not reply to user %s: %s", message.chat.id, exc)


@router.message(CommandStart())
async def on_start(message: Message) -> None:
    await _say(message, t("welcome"))


@router.message(Command("help"))
async def on_help(message: Message) -> None:
    await _say(message, t("help"))


@router.message(Command("privacy"))
async def on_privacy(message: Message) -> None:
    await _say(message, t("privacy"))


@router.message(Command("chats"))
async def on_chats(message: Message) -> None:
    if not _chats_limiter.allow(message.from_user.id):
        await _say(message, t("too_many_requests"))
        return
    owned = await _admin_chats(message.bot, message.from_user.id)
    if not owned:
        await _say(message, t("no_chats"))
        return
    for chat in owned:
        row = _best_effort("billing_get", chat.chat_id, billing.get,
                           chat.chat_id) or billing.empty(chat.chat_id)
        body, keyboard = _menu(chat, row)
        await _send_menu(message.bot, message, chat, row, body, keyboard)


async def _send_menu(bot, message, chat, row, body, keyboard) -> None:
    """Sends one chat's menu, with a subscribe button when one applies.

    One malformed or oversized menu must not take down /chats for every other
    chat this admin administers.
    """
    ent = tiers.build(tiers.tier_for(row.member_count), paid_until=row.paid_until,
                      grace_until=row.grace_until, now=datetime.now(timezone.utc))
    if ent.price and ent.reason != "subscribed":
        url = await offer.subscribe_link(bot, chat_id=chat.chat_id,
                                         title=chat.title or str(chat.chat_id),
                                         stars=ent.price, lang=chat.lang)
        if url:
            keyboard.inline_keyboard.append([
                InlineKeyboardButton(text=t("btn_subscribe", chat.lang, stars=ent.price),
                                     url=url)])
        else:
            body += f"\n\n<i>{html.escape(t('invoice_unavailable', chat.lang))}</i>"
    try:
        await message.answer(body, reply_markup=keyboard)
    except TelegramAPIError as exc:
        log.warning("could not send menu for chat %s: %s", chat.chat_id, exc)


def _parse_callback(data: str):
    """Validates callback data before anything touches storage or Telegram.

    Returns (chat_id, field, extra) on success, where field is one of
    None, "mode", "jev", "lang", "thr" and extra is (threshold_field, delta)
    when field == "thr", else None. Returns None on anything malformed.
    """
    parts = data.split(":")
    if len(parts) not in (2, 3, 5) or parts[0] != "cfg":
        return None

    try:
        chat_id = int(parts[1])
    except ValueError:
        return None
    if not (_SQLITE_INT_MIN <= chat_id <= _SQLITE_INT_MAX):
        return None

    if len(parts) == 2:
        return chat_id, None, None

    if len(parts) == 3:
        field = parts[2]
        if field not in _TOGGLE_FIELDS:
            return None
        return chat_id, field, None

    # len(parts) == 5: cfg:<chat_id>:thr:<field>:<delta>
    if parts[2] != "thr":
        return None
    threshold_field, delta = parts[3], parts[4]
    if threshold_field not in _THRESHOLD_FIELDS or delta not in _DELTAS:
        return None
    return chat_id, "thr", (threshold_field, delta)


@router.callback_query(F.data.startswith("cfg:"))
async def on_config(query: CallbackQuery) -> None:
    parsed = _parse_callback(query.data)
    if parsed is None:
        await query.answer()
        return
    chat_id, field, extra = parsed

    # Admin status is checked before anything about the chat's existence in
    # our own storage is revealed. Checking existence first would let a
    # forwarded or guessed button tell a non-admin whether a given chat id
    # is in the bot's database at all - a privilege boundary should not
    # leak that for free.
    if not await guards.is_admin(query.bot, chat_id, query.from_user.id):
        await query.answer(t("menu_not_admin"), show_alert=True)
        return

    chat = _best_effort("get_chat", chat_id, chats.get_chat, chat_id)
    if chat is None:
        await query.answer(t("no_chats"))
        return

    if field == "mode":
        updated = _best_effort(
            "update_chat", chat_id, chats.update_chat, chat_id,
            mode="active" if chat.mode == "observe" else "observe")
        chat = updated or chat
    elif field == "jev":
        updated = _best_effort(
            "update_chat", chat_id, chats.update_chat, chat_id,
            jev_enabled=not chat.jev_enabled)
        chat = updated or chat
    elif field == "lang":
        nxt = _LANGS[(_LANGS.index(chat.lang) + 1) % len(_LANGS)] if chat.lang in _LANGS else "en"
        updated = _best_effort("update_chat", chat_id, chats.update_chat, chat_id, lang=nxt)
        chat = updated or chat
    elif field == "log":
        # Redirects this chat's cards to the presser's own DM, so a second
        # admin can take the queue over from whoever added the bot. Their
        # admin rights for this chat were verified against Telegram above.
        updated = _best_effort(
            "update_chat", chat_id, chats.update_chat, chat_id,
            log_chat_id=query.from_user.id)
        chat = updated or chat
    elif field == "thr":
        threshold_field, delta = extra
        step = THRESHOLD_STEP if delta == "+" else -THRESHOLD_STEP
        current = getattr(chat, threshold_field)
        new_value = round(max(0.0, min(1.0, current + step)), 4)
        updated = _best_effort(
            "update_chat", chat_id, chats.update_chat, chat_id, **{threshold_field: new_value})
        chat = updated or chat
    elif field == "gonow":
        # Ends the observation window on the admin's say-so. Not gated by
        # payment: a free group can use it too. It exists because the window is
        # otherwise unconditional, so an admin who subscribes today would get
        # nothing for a week.
        updated = _best_effort(
            "update_chat", chat_id, chats.update_chat, chat_id, mode="active",
            observe_until=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        chat = updated or chat
    # field is None: bare "cfg:<chat_id>" just re-renders the current menu.

    row = _best_effort("billing_get", chat_id, billing.get, chat_id) \
        or billing.empty(chat_id)
    body, keyboard = _menu(chat, row)
    try:
        await query.message.edit_text(body, reply_markup=keyboard)
    except TelegramAPIError as exc:
        log.warning("could not edit menu for chat %s: %s", chat_id, exc)
    await query.answer()
