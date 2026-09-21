import os
import tempfile

import pytest


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    path = os.path.join(tempfile.mkdtemp(), "t.db")
    monkeypatch.setenv("DB_PATH", path)
    import importlib
    import config
    importlib.reload(config)
    from storage import db
    db.reset()
    yield
    db.reset()


class FakeMessage:
    def __init__(self, *, charge_id, payload, user_id, expiration):
        self.successful_payment = _FakeSuccessfulPayment(
            telegram_payment_charge_id=charge_id,
            invoice_payload=payload,
            subscription_expiration_date=expiration,
            is_recurring=True,
            total_amount=None,
            currency="XTR",
        )
        self.from_user = _FakeUser(user_id)
        self.chat = _FakeChat(user_id)
        self.replies = []

    async def answer(self, text):
        self.replies.append(text)


class _FakeSuccessfulPayment:
    def __init__(self, *, telegram_payment_charge_id, invoice_payload,
                subscription_expiration_date, is_recurring, total_amount, currency):
        self.telegram_payment_charge_id = telegram_payment_charge_id
        self.invoice_payload = invoice_payload
        self.subscription_expiration_date = subscription_expiration_date
        self.is_recurring = is_recurring
        self.total_amount = total_amount
        self.currency = currency


class _FakeUser:
    def __init__(self, user_id):
        self.id = user_id


class _FakeChat:
    def __init__(self, chat_id):
        self.id = chat_id


class FakePreCheckout:
    def __init__(self, *, payload, currency, amount, raises=None):
        self.id = "pcq_1"
        self.invoice_payload = payload
        self.currency = currency
        self.total_amount = amount
        self.raises = raises
        self.answered_ok = None

    async def answer(self, ok, error_message=None):
        if self.raises is not None:
            raise self.raises
        self.answered_ok = ok


def test_a_well_formed_payload_parses():
    from handlers import payments
    assert payments.parse_payload("sub:-100123:50") == (-100123, 50)


@pytest.mark.parametrize("payload", [
    "", "sub", "sub:-100123", "sub:-100123:50:extra", "buy:-100123:50",
    "sub:notanumber:50", "sub:-100123:notanumber",
])
def test_malformed_payloads_are_refused(payload):
    from handlers import payments
    assert payments.parse_payload(payload) is None


def test_a_price_that_is_not_one_of_ours_is_refused():
    """The amount is the only thing standing between a crafted invoice and a
    subscription bought for one star."""
    from handlers import payments
    assert payments.parse_payload("sub:-100123:1") is None


def test_a_chat_id_outside_sqlites_integer_range_is_refused():
    from handlers import payments
    assert payments.parse_payload(f"sub:{2**63}:50") is None


async def test_a_valid_payment_credits_the_chat_and_writes_the_ledger():
    from handlers import payments
    from storage import billing, chats
    chats.ensure_chat(-100123, "Group")
    query = FakeMessage(charge_id="ch_1", payload="sub:-100123:50",
                        user_id=7, expiration=1790000000)
    await payments.on_successful_payment(query)
    assert billing.get(-100123).paid_until is not None
    assert billing.get(-100123).stars == 50


async def test_a_redelivered_payment_grants_nothing_and_stays_quiet():
    from handlers import payments
    from storage import billing, chats
    chats.ensure_chat(-100123, "Group")
    first = FakeMessage(charge_id="ch_1", payload="sub:-100123:50",
                        user_id=7, expiration=1790000000)
    await payments.on_successful_payment(first)
    paid = billing.get(-100123).paid_until

    second = FakeMessage(charge_id="ch_1", payload="sub:-100123:50",
                         user_id=7, expiration=1799999999)
    await payments.on_successful_payment(second)
    assert billing.get(-100123).paid_until == paid
    assert second.replies == [], "a redelivery must not thank the user twice"


async def test_a_payment_for_an_unknown_chat_is_still_recorded():
    from handlers import payments
    from storage import billing
    message = FakeMessage(charge_id="ch_9", payload="sub:-100777:250",
                          user_id=7, expiration=1790000000)
    await payments.on_successful_payment(message)
    assert billing.get(-100777).paid_until is not None


async def test_a_payment_with_no_expiry_still_grants_thirty_days():
    """subscription_expiration_date is optional in the Bot API; a missing one
    must not leave a paying customer with nothing."""
    from datetime import datetime, timezone
    from handlers import payments
    from storage import billing, chats
    chats.ensure_chat(-100123, "Group")
    await payments.on_successful_payment(
        FakeMessage(charge_id="ch_1", payload="sub:-100123:50",
                    user_id=7, expiration=None))
    paid = datetime.fromisoformat(billing.get(-100123).paid_until)
    assert (paid - datetime.now(timezone.utc)).days >= 29


async def test_pre_checkout_accepts_a_valid_invoice():
    from handlers import payments
    query = FakePreCheckout(payload="sub:-100123:50", currency="XTR", amount=50)
    await payments.on_pre_checkout(query)
    assert query.answered_ok is True


@pytest.mark.parametrize("payload,currency,amount", [
    ("garbage", "XTR", 50),
    ("sub:-100123:50", "USD", 50),
    ("sub:-100123:50", "XTR", 250),
])
async def test_pre_checkout_refuses_anything_that_does_not_add_up(
        payload, currency, amount):
    from handlers import payments
    query = FakePreCheckout(payload=payload, currency=currency, amount=amount)
    await payments.on_pre_checkout(query)
    assert query.answered_ok is False


async def test_pre_checkout_is_always_answered_even_when_telegram_fails():
    """Telegram fails the payment if the query goes unanswered for ten
    seconds, so the handler must never raise on its way to answering."""
    from aiogram.exceptions import TelegramAPIError
    from handlers import payments
    query = FakePreCheckout(payload="sub:-100123:50", currency="XTR", amount=50,
                            raises=TelegramAPIError(method=None, message="boom"))
    await payments.on_pre_checkout(query)  # must not raise
