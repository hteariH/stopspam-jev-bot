import pytest

from core import offer


class FakeBot:
    def __init__(self, raises=None):
        self.raises = raises
        self.calls = []

    async def create_invoice_link(self, **kwargs):
        if self.raises is not None:
            raise self.raises
        self.calls.append(kwargs)
        return "https://t.me/invoice/abc"


async def test_the_invoice_is_a_thirty_day_star_subscription():
    bot = FakeBot()
    await offer.subscribe_link(bot, chat_id=-100123, title="My Group",
                               stars=50, lang="en")
    call = bot.calls[0]
    assert call["currency"] == "XTR"
    assert call["subscription_period"] == 2592000
    assert [p.amount for p in call["prices"]] == [50]
    assert len(call["prices"]) == 1, "Stars invoices must carry exactly one price"


async def test_the_payload_carries_the_chat_and_the_price():
    bot = FakeBot()
    await offer.subscribe_link(bot, chat_id=-100123, title="G", stars=250, lang="en")
    assert bot.calls[0]["payload"] == "sub:-100123:250"


async def test_the_title_and_description_stay_inside_telegrams_limits():
    """Telegram rejects the whole call over these, which would make the
    product unbuyable rather than merely ugly."""
    bot = FakeBot()
    await offer.subscribe_link(bot, chat_id=-100123, title="G" * 4000,
                               stars=50, lang="ru")
    call = bot.calls[0]
    assert 1 <= len(call["title"]) <= 32
    assert 1 <= len(call["description"]) <= 255


async def test_a_telegram_failure_returns_none_rather_than_raising():
    from aiogram.exceptions import TelegramAPIError
    bot = FakeBot(raises=TelegramAPIError(method=None, message="nope"))
    assert await offer.subscribe_link(bot, chat_id=-1, title="G",
                                      stars=50, lang="en") is None
