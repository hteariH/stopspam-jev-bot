"""Creating a Stars invoice link. The outbound half of payments.

Separate from handlers.payments, which only receives updates, because three
callers need to *offer* a subscription - the settings menu, a review card, and
a lapse notice - and none of them should import a handler module to do it.
"""
import logging

from aiogram.exceptions import TelegramAPIError
from aiogram.types import LabeledPrice

import config
from texts import t

log = logging.getLogger("stopspam.offer")

# createInvoiceLink rejects anything longer, which would make the product
# unbuyable rather than merely untidy.
MAX_INVOICE_TITLE = 32
MAX_INVOICE_DESC = 255
# Leaves room for the rest of the description around it.
MAX_GROUP_NAME = 80


def payload_for(chat_id: int, stars: int) -> str:
    """What comes back to us in pre_checkout and successful_payment.

    Everything needed to credit the right chat the right amount, and nothing
    else: the payload is not shown to the user but it is round-tripped through
    their client, so it carries no names and no secrets.
    """
    return f"sub:{chat_id}:{stars}"


def _trim(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[:limit - 1] + "…"


async def subscribe_link(bot, *, chat_id: int, title: str, stars: int,
                         lang: str) -> str | None:
    """A 30-day recurring Stars subscription link, or None if Telegram refused.

    None rather than an exception because every caller is a menu, a card or a
    notice that must still render when Telegram is having a bad minute.
    """
    description = _trim(
        t("invoice_description", lang,
          title=_trim(title or str(chat_id), MAX_GROUP_NAME), stars=stars),
        MAX_INVOICE_DESC)
    try:
        return await bot.create_invoice_link(
            title=_trim(t("invoice_title", lang), MAX_INVOICE_TITLE),
            description=description,
            payload=payload_for(chat_id, stars),
            currency="XTR",
            prices=[LabeledPrice(label=t("invoice_label", lang), amount=stars)],
            subscription_period=config.SUBSCRIPTION_PERIOD,
        )
    except TelegramAPIError as exc:
        log.warning("could not create an invoice link for chat %s: %s", chat_id, exc)
        return None
