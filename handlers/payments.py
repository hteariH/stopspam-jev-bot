"""Incoming Stars payments: the pre-checkout gate and the receipt.

Registered ahead of every other router. No existing router would swallow a
payment today - handlers.admin filters to private chats but declares no
catch-all message handler, and handlers.group's catch-all filters to group
chats - so a successful_payment message currently falls through unhandled.
Registering first states that dependency instead of relying on it staying
true.

The successful_payment handler deliberately accepts a payment from any chat
type - the Bot API documentation does not say whether such a message can
ever arrive outside a private chat, and money is involved. The cost of
missing one is an unrecorded charge with no handle on it; the cost of
accepting one from an unexpected chat is nothing. @router.message(F.successful_payment)
is specific enough on its own, and it is the only message handler in this
module, so there is nothing else for a chat-type filter to protect.
"""
import functools
import html
import logging
from datetime import datetime, timedelta, timezone

from aiogram import F, Router
from aiogram.exceptions import TelegramAPIError
from aiogram.types import Message, PreCheckoutQuery

import config
from core import guards, tiers
from storage import billing, chats
from texts import t

log = logging.getLogger("stopspam.payments")

router = Router(name="payments")

# A digit-only chat id outside this range parses fine with int() but makes
# sqlite3 raise OverflowError on binding - which is not a sqlite3.Error, so it
# would escape best_effort. Rejected here, at validation, mirroring
# handlers.admin.
_SQLITE_INT_MIN = -(2**63)
_SQLITE_INT_MAX = 2**63 - 1

_best_effort = functools.partial(guards.best_effort, log)


def _known_prices() -> set[int]:
    return {tiers.price_for(tiers.SMALL), tiers.price_for(tiers.LARGE)}


def parse_chat_id(payload: str) -> int | None:
    """Which chat an invoice payload names, or None if it is not ours.

    Checks the shape and nothing about the price: the prefix, the field count,
    that both fields are integers, and that the chat id fits sqlite's signed
    64-bit INTEGER (int() would parse a wider one happily and sqlite3 would
    then raise OverflowError, which is not a sqlite3.Error and would escape
    best_effort).

    Used on the successful-payment path, where the money has already moved.
    The price must NOT be checked there: it locks at subscribe time, Telegram
    renews at whatever the original invoice named, and config.PRICE_* is
    env-tunable - so a price rise would otherwise make every existing
    subscriber's renewal unreadable while Telegram kept charging them.
    """
    parts = payload.split(":")
    if len(parts) != 3 or parts[0] != "sub":
        return None
    try:
        chat_id = int(parts[1])
        int(parts[2])
    except ValueError:
        return None
    if not (_SQLITE_INT_MIN <= chat_id <= _SQLITE_INT_MAX):
        return None
    return chat_id


def parse_payload(payload: str) -> tuple[int, int] | None:
    """(chat_id, stars) from an invoice payload, or None if it is not ours.

    The star count is checked against the prices we actually sell. Without
    that, a crafted invoice could buy a subscription for one star: the payload
    round-trips through the buyer's client, so nothing in it is trustworthy on
    the way back.

    That check belongs at pre-checkout and only there - it is what refuses the
    crafted invoice before any money moves. See parse_chat_id for why the same
    check would destroy the record if it ran after the charge.
    """
    chat_id = parse_chat_id(payload)
    if chat_id is None:
        return None
    stars = int(payload.split(":")[2])
    if stars not in _known_prices():
        return None
    return chat_id, stars


def _lang(chat_id: int) -> str:
    chat = _best_effort("get_chat", chat_id, chats.get_chat, chat_id)
    return chat.lang if chat else "en"


def _title(chat_id: int) -> str:
    chat = _best_effort("get_chat", chat_id, chats.get_chat, chat_id)
    return (chat.title if chat and chat.title else str(chat_id))


@router.pre_checkout_query()
async def on_pre_checkout(query: PreCheckoutQuery) -> None:
    """Telegram fails the payment if this goes unanswered for ten seconds.

    So it does no network work and no storage work beyond what is already in
    memory. It deliberately does not re-check that the payer administers the
    chat: that costs a round-trip against the deadline, and the only thing it
    would prevent - somebody paying for a group they do not administer - is a
    gift, not an attack.
    """
    parsed = parse_payload(query.invoice_payload)
    ok = (parsed is not None
          and query.currency == "XTR"
          and query.total_amount == parsed[1])
    try:
        await query.answer(ok=ok, error_message=None if ok else t("pay_rejected"))
    except TelegramAPIError as exc:
        log.warning("could not answer pre_checkout %s: %s", query.id, exc)
    if not ok:
        log.warning("refused pre_checkout %s: payload %r, %s %s",
                    query.id, query.invoice_payload, query.total_amount, query.currency)


@router.message(F.successful_payment)
async def on_successful_payment(message: Message) -> None:
    payment = message.successful_payment
    # from_user is Optional in aiogram and is absent for a channel post -
    # precisely the delivery this handler accepts no chat-type filter in order
    # to catch. Reading .id off None would raise AttributeError, which is
    # neither sqlite3.Error nor TelegramAPIError, escape the handler unhandled
    # and lose the charge with no ledger row at all. The ledger column is NOT
    # NULL, so an unknown payer is recorded as 0 and shouted about instead.
    payer_user_id = message.from_user.id if message.from_user else 0
    if message.from_user is None:
        log.error("payment %s arrived with no from_user; recording it against "
                  "payer 0 - the charge id is the only handle on who paid",
                  payment.telegram_payment_charge_id)

    # The price is deliberately not re-checked here: see parse_chat_id.
    chat_id = parse_chat_id(payment.invoice_payload)
    if chat_id is None:
        # Money moved and we cannot tell for whom. Nothing can be credited,
        # but this must be loud: the charge id below is the only handle on it.
        log.error("payment %s from user %s has an unusable payload %r",
                  payment.telegram_payment_charge_id, payer_user_id,
                  payment.invoice_payload)
        return
    # Telegram's own figure for what it charged, not the payload's copy of it.
    # The payload round-trips through the buyer's client; this does not, and
    # the ledger exists to say what actually moved.
    stars = payment.total_amount

    expiry = None
    if payment.subscription_expiration_date:
        try:
            expiry = datetime.fromtimestamp(payment.subscription_expiration_date,
                                            timezone.utc)
        except (ValueError, OverflowError, OSError) as exc:
            # An out-of-range timestamp must not raise here: that would escape
            # before record_payment ever runs, leaving money moved with no
            # ledger row and no log line carrying the charge id to find it by.
            log.warning(
                "chat %s payment %s has an unusable subscription_expiration_date "
                "%r (%s); falling back to a fresh %s-second subscription",
                chat_id, payment.telegram_payment_charge_id,
                payment.subscription_expiration_date, exc, config.SUBSCRIPTION_PERIOD)
    if expiry is None:
        # Either the field is absent - it is optional in the Bot API - or it
        # was unusable. A missing or bad one must not leave a paying customer
        # with nothing.
        expiry = datetime.now(timezone.utc) + timedelta(
            seconds=config.SUBSCRIPTION_PERIOD)
    expires_at = expiry.isoformat(timespec="seconds")

    # billing.record_payment takes chat_id as a keyword-only argument, which
    # cannot be forwarded through best_effort's own **kwargs without
    # colliding with best_effort's own `chat_id` parameter (same name, both
    # keyword). Binding it into the callable first with functools.partial
    # sidesteps that collision instead of renaming either parameter.
    recorded = _best_effort(
        "record_payment", chat_id,
        functools.partial(
            billing.record_payment,
            charge_id=payment.telegram_payment_charge_id, chat_id=chat_id,
            payer_user_id=payer_user_id, stars=stars,
            is_recurring=bool(payment.is_recurring), expires_at=expires_at))

    lang = _lang(chat_id)
    if recorded is None:
        log.error("could not record payment %s for chat %s - the money moved "
                  "and the ledger did not", payment.telegram_payment_charge_id, chat_id)
        await _say(message, t("pay_unrecorded", lang))
        return
    if recorded is False:
        log.info("payment %s redelivered for chat %s, ignored",
                 payment.telegram_payment_charge_id, chat_id)
        return

    log.info("chat %s paid %s stars until %s (recurring=%s)",
             chat_id, stars, expires_at, bool(payment.is_recurring))
    days = tiers.days_left(expires_at, now=datetime.now(timezone.utc))
    # The reply goes out under the bot's default ParseMode.HTML and the title
    # is the group's own, chosen by whoever named it. An unescaped "&" or "<"
    # makes Telegram reject the whole send, so the payer would be charged and
    # never thanked. Escaped exactly as core.cards and handlers.admin do it.
    await _say(message,
               t("pay_thanks", lang, title=html.escape(_title(chat_id)), days=days)
               + "\n\n" + t("pay_cancel_hint", lang))


async def _say(message: Message, body: str) -> None:
    try:
        await message.answer(body)
    except TelegramAPIError as exc:
        log.warning("could not reply to user %s: %s", message.chat.id, exc)
