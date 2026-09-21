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
    def __init__(self, *, charge_id, payload, user_id, expiration, amount=None):
        self.successful_payment = _FakeSuccessfulPayment(
            telegram_payment_charge_id=charge_id,
            invoice_payload=payload,
            subscription_expiration_date=expiration,
            is_recurring=True,
            # Telegram reports what it actually charged. Defaulting it to the
            # payload's own figure is what a real invoice produces, so a test
            # that does not care about the amount still gets a truthful one.
            total_amount=_amount_from(payload) if amount is None else amount,
            currency="XTR",
        )
        # None stands in for a channel post, where the Bot API omits from_user.
        self.from_user = _FakeUser(user_id) if user_id is not None else None
        self.chat = _FakeChat(user_id if user_id is not None else -100999)
        self.replies = []

    async def answer(self, text):
        self.replies.append(text)


def _amount_from(payload: str) -> int:
    parts = payload.split(":")
    try:
        return int(parts[2])
    except (IndexError, ValueError):
        return 0


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


async def test_a_payment_with_an_out_of_range_expiry_still_records_and_grants_thirty_days():
    """datetime.fromtimestamp raises OverflowError/ValueError/OSError on a bad
    timestamp. That must not escape before record_payment runs and before an
    ERROR log carries the charge id - the exact "money moved, no record, no
    handle on it" outcome the design forbids."""
    from datetime import datetime, timezone
    from handlers import payments
    from storage import billing, chats
    chats.ensure_chat(-100123, "Group")
    await payments.on_successful_payment(
        FakeMessage(charge_id="ch_1", payload="sub:-100123:50",
                    user_id=7, expiration=99999999999999999999))
    assert billing.get(-100123).stars == 50
    paid = datetime.fromisoformat(billing.get(-100123).paid_until)
    assert (paid - datetime.now(timezone.utc)).days >= 29


async def test_a_successful_payment_from_a_group_chat_is_still_recorded():
    """The router used to filter to private chats only. Whether Telegram can
    ever deliver a successful_payment outside a private chat is undocumented,
    so the filter was removed rather than guessed at: a payment must be
    recorded in full wherever it lands, since the money has already moved by
    the time this handler runs."""
    import importlib
    from datetime import datetime, timezone

    from aiogram import Bot, Dispatcher
    from aiogram.methods import SendMessage
    from aiogram.types import Chat, Message, SuccessfulPayment, Update, User

    import handlers.payments
    from storage import billing, chats

    # payments.router is a module-level aiogram Router, and aiogram refuses
    # to attach a Router that already has a parent Dispatcher. Other test
    # modules (tests/test_flow.py, tests/test_startup.py) also build a
    # Dispatcher from bot.build_dispatcher() in the same process, so this
    # test reloads the module itself rather than relying on run order to
    # hand it an unattached Router.
    importlib.reload(handlers.payments)
    payments = handlers.payments

    chats.ensure_chat(-100123, "Group")

    async def fake_call(self, method, request_timeout=None):
        if isinstance(method, SendMessage):
            return Message(message_id=2, date=datetime.now(timezone.utc),
                           chat=Chat(id=method.chat_id, type="supergroup"),
                           text=method.text)
        return True

    # Bot.__call__ is a class attribute shared by every test module that
    # patches it; other modules reassign it in their own fixtures, so a bare
    # reassignment here (mirroring tests/test_admin_handler.py) is safe.
    Bot.__call__ = fake_call

    dispatcher = Dispatcher()
    dispatcher.include_router(payments.router)
    bot = Bot("123:abc")

    message = Message(
        message_id=1, date=datetime.now(timezone.utc),
        chat=Chat(id=-100999, type="supergroup"),
        from_user=User(id=7, is_bot=False, first_name="Payer"),
        successful_payment=SuccessfulPayment(
            currency="XTR", total_amount=50, invoice_payload="sub:-100123:50",
            telegram_payment_charge_id="ch_grp",
            provider_payment_charge_id="prov_1",
            subscription_expiration_date=1790000000, is_recurring=True,
        ),
    )
    await dispatcher.feed_update(bot, Update(update_id=1, message=message))

    assert billing.get(-100123).paid_until is not None
    assert billing.get(-100123).stars == 50


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


async def test_a_chat_id_parses_without_judging_the_price():
    """parse_chat_id is what the money path uses. It validates the shape of a
    payload and nothing about what we charge today, because the price locks at
    subscribe time and config.PRICE_* is env-tunable."""
    from handlers import payments
    assert payments.parse_chat_id("sub:-100123:50") == -100123
    assert payments.parse_chat_id("sub:-100123:1") == -100123


@pytest.mark.parametrize("payload", [
    "", "sub", "sub:-100123", "sub:-100123:50:extra", "buy:-100123:50",
    "sub:notanumber:50", "sub:-100123:notanumber",
])
def test_parse_chat_id_still_refuses_a_malformed_payload(payload):
    from handlers import payments
    assert payments.parse_chat_id(payload) is None


def test_parse_chat_id_refuses_a_chat_id_outside_sqlites_integer_range():
    """int() parses it fine and sqlite3 then raises OverflowError, which is
    not a sqlite3.Error and would escape best_effort."""
    from handlers import payments
    assert payments.parse_chat_id(f"sub:{2**63}:50") is None


async def test_a_renewal_at_a_price_we_no_longer_sell_is_still_credited(monkeypatch):
    """Raising a price must not stop crediting the subscribers already on the
    old one.

    The price locks at subscribe time, so Telegram keeps charging a renewing
    subscriber the amount their original invoice named. Refusing that payload
    here would write no ledger row and never extend paid_until, while the money
    kept moving - and a recurring renewal sends no pre_checkout_query, so
    nothing upstream would catch it.
    """
    import config
    from handlers import payments
    from storage import billing, chats, db
    chats.ensure_chat(-100123, "Group")
    monkeypatch.setattr(config, "PRICE_SMALL_STARS", 80)
    monkeypatch.setattr(config, "PRICE_LARGE_STARS", 400)

    await payments.on_successful_payment(FakeMessage(
        charge_id="ch_old_price", payload="sub:-100123:50", user_id=7,
        expiration=1790000000, amount=50))

    row = billing.get(-100123)
    assert row.paid_until is not None, "an existing subscriber stopped being credited"
    assert row.stars == 50, "the amount recorded is the one Telegram charged"
    ledger = db.connect().execute(
        "SELECT stars FROM payments WHERE telegram_payment_charge_id = ?",
        ("ch_old_price",)).fetchall()
    assert [r["stars"] for r in ledger] == [50]


async def test_the_amount_recorded_is_telegrams_figure_not_the_payloads():
    """The payload round-trips through the buyer's client; total_amount does
    not. When they disagree, the ledger records the one that moved money."""
    from handlers import payments
    from storage import billing, chats
    chats.ensure_chat(-100123, "Group")
    await payments.on_successful_payment(FakeMessage(
        charge_id="ch_amt", payload="sub:-100123:50", user_id=7,
        expiration=1790000000, amount=250))
    assert billing.get(-100123).stars == 250


async def test_a_payment_with_no_from_user_is_still_recorded(caplog):
    """A channel post carries no from_user. The chat-type filter was removed
    precisely so such a payment is still recorded, so reading .id off None
    here would raise AttributeError - neither sqlite3.Error nor
    TelegramAPIError - escape the handler, and lose the charge entirely.
    """
    import logging
    from handlers import payments
    from storage import billing, chats, db
    chats.ensure_chat(-100123, "Group")
    with caplog.at_level(logging.ERROR, logger="stopspam.payments"):
        await payments.on_successful_payment(FakeMessage(
            charge_id="ch_nouser", payload="sub:-100123:50", user_id=None,
            expiration=1790000000))
    assert billing.get(-100123).paid_until is not None
    ledger = db.connect().execute(
        "SELECT payer_user_id FROM payments WHERE telegram_payment_charge_id = ?",
        ("ch_nouser",)).fetchall()
    assert len(ledger) == 1, "the charge left no ledger row"
    assert "ch_nouser" in caplog.text, (
        "the missing payer must be logged loudly, naming the charge id - it is "
        "the only handle on a charge nobody can be matched to")


async def test_a_payment_with_no_from_user_and_a_bad_payload_still_logs_the_charge(caplog):
    """The other unguarded site. Nothing can be credited here, so the log line
    carrying the charge id is all that is left of the money."""
    import logging
    from handlers import payments
    with caplog.at_level(logging.ERROR, logger="stopspam.payments"):
        await payments.on_successful_payment(FakeMessage(
            charge_id="ch_bad", payload="garbage", user_id=None, expiration=None))
    assert "ch_bad" in caplog.text


async def test_the_thank_you_escapes_a_group_title_telegram_would_reject():
    """The reply goes out under ParseMode.HTML. A group named "Dogs & Cats"
    would otherwise have its receipt rejected by Telegram - the payer charged
    and never thanked."""
    from handlers import payments
    from storage import chats
    chats.ensure_chat(-100123, "Dogs & Cats <b>")
    message = FakeMessage(charge_id="ch_esc", payload="sub:-100123:50",
                          user_id=7, expiration=1790000000)
    await payments.on_successful_payment(message)
    assert message.replies, "the payer was not thanked at all"
    assert "Dogs &amp; Cats &lt;b&gt;" in message.replies[0]
    assert "Dogs & Cats" not in message.replies[0]
