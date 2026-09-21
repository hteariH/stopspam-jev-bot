"""One realistic sequence end to end: newcomer spams, gets deleted, earns trust,
an admin reverses a call, and the reversed user is left alone afterwards."""
import os
import tempfile
from datetime import datetime, timezone

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.methods import (CreateInvoiceLink, DeleteMessage, GetChatMember,
                             GetChatMemberCount, GetMe, SendMessage)
from aiogram.types import (CallbackQuery, Chat, ChatMemberAdministrator, ChatMemberMember,
                           Message, SuccessfulPayment, Update, User)

from core.jev import FakeJevClient
from tests.fixtures.verdicts import CHATTER, SCAM

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
GROUP, LOG, SPAMMER, REGULAR, ADMIN = -100123, -100999, 555, 556, 777
calls: list = []
MEMBERS = [150]


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setenv("DB_PATH", os.path.join(tempfile.mkdtemp(), "t.db"))
    monkeypatch.setenv("BOT_TOKEN", "123:abc")
    import importlib
    import config
    importlib.reload(config)
    from storage import db
    db.reset()
    calls.clear()
    MEMBERS[0] = 150
    # Bot.__call__ is a single class attribute shared by every test module
    # that patches it; re-assert it here so collection order in the same
    # session never lets another module's fake win (see test_group_handler.py).
    Bot.__call__ = fake_call
    # admin.router, review.router, group.router and payments.router are
    # module-level aiogram Routers, and aiogram refuses to attach a Router
    # that already has a parent Dispatcher. This file calls
    # bot.build_dispatcher() once per test, so each router module must be
    # reloaded here to hand every test a fresh, unattached Router - mirrors
    # tests/test_startup.py.
    import handlers.admin
    import handlers.group
    import handlers.payments
    import handlers.review
    importlib.reload(handlers.admin)
    importlib.reload(handlers.review)
    importlib.reload(handlers.group)
    importlib.reload(handlers.payments)
    yield
    db.reset()


async def fake_call(self, method, request_timeout=None):
    calls.append(method)
    if isinstance(method, GetMe):
        return User(id=1, is_bot=True, first_name="StopSpam", username="StopSpam_jev_bot")
    if isinstance(method, SendMessage):
        return Message(message_id=9000 + len(calls), date=NOW,
                       chat=Chat(id=method.chat_id, type="supergroup"), text=method.text)
    if isinstance(method, GetChatMember):
        if method.user_id in (ADMIN, 1):
            return ChatMemberAdministrator(
                user=User(id=method.user_id, is_bot=False, first_name="Boss"),
                status="administrator", can_be_edited=False, is_anonymous=False,
                can_manage_chat=True, can_delete_messages=True, can_manage_video_chats=True,
                can_restrict_members=True, can_promote_members=False,
                can_change_info=True, can_invite_users=True,
                can_post_stories=False, can_edit_stories=False, can_delete_stories=False,
                can_send_welcome_messages=False)
        return ChatMemberMember(
            user=User(id=method.user_id, is_bot=False, first_name="Ann"), status="member")
    if isinstance(method, GetChatMemberCount):
        return MEMBERS[0]
    if isinstance(method, CreateInvoiceLink):
        return "https://t.me/invoice/test"
    return True


def group_message(text: str, user_id: int, msg_id: int) -> Update:
    return Update(update_id=msg_id, message=Message(
        message_id=msg_id, date=NOW,
        chat=Chat(id=GROUP, type="supergroup", title="Python Chat"),
        from_user=User(id=user_id, is_bot=False, first_name="Ann", username="ann"),
        text=text))


def deletions():
    return [c for c in calls if isinstance(c, DeleteMessage)]


async def test_full_flow():
    import bot as app
    from handlers import group
    from storage import chats, db, trust

    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=LOG, mode="active",
                      observe_until="2020-01-01T00:00:00+00:00")
    group.set_client(FakeJevClient({"buy crypto": SCAM}, default=CHATTER))

    telegram = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dispatcher = app.build_dispatcher()

    # 1. A newcomer posts a scam: deleted, card posted, author flagged.
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 1))
    assert len(deletions()) == 1
    assert trust.get(GROUP, SPAMMER).status == "flagged"

    # 2. A different newcomer chats normally five times and becomes trusted.
    for i in range(5):
        await dispatcher.feed_update(
            telegram, group_message(f"morning all {i}", REGULAR, 10 + i))
    assert trust.get(GROUP, REGULAR).status == "trusted"

    # 3. The trusted member's plain messages no longer reach the API.
    before = len(group._client.calls)
    await dispatcher.feed_update(telegram, group_message("still here", REGULAR, 20))
    assert len(group._client.calls) == before

    # 4. An admin reverses the original call from the card.
    review_id = db.connect().execute(
        "SELECT id FROM reviews WHERE chat_id = ? AND user_id = ?",
        (GROUP, SPAMMER)).fetchone()["id"]
    card = Message(message_id=9001, date=NOW, chat=Chat(id=LOG, type="supergroup"),
                   text="card")
    await dispatcher.feed_update(telegram, Update(update_id=30, callback_query=CallbackQuery(
        id="q", from_user=User(id=ADMIN, is_bot=False, first_name="Boss"),
        chat_instance="ci", message=card, data=f"rv:ok:{review_id}")))
    assert trust.get(GROUP, SPAMMER).status == "allowlisted"

    # 5. The reversed user is now left alone even when posting the same text -
    # not just no deletion, but no API call at all, the same way step 3
    # proves a trusted member costs no call.
    calls.clear()
    before = len(group._client.calls)
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 40))
    assert deletions() == [], "an allowlisted user must never be acted upon"
    assert len(group._client.calls) == before, "an allowlisted user must never reach the API"


def _active_group(members: int) -> None:
    """A group past its observation window, with cards going somewhere."""
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=LOG, mode="active",
                      observe_until="2020-01-01T00:00:00+00:00")
    MEMBERS[0] = members


def _burn_the_trial() -> None:
    """Opens the 14-day trial and pushes it into the past.

    Written this way rather than by never opening it, because the set-once rule
    means an expired window must not reopen - which is exactly what these tests
    need to rely on.
    """
    from storage import billing, db
    billing.start_grace(GROUP)
    conn = db.connect()
    conn.execute("UPDATE billing SET grace_until = ? WHERE chat_id = ?",
                 ("2020-01-01T00:00:00+00:00", GROUP))
    conn.commit()


def _dispatch():
    import bot as app
    from handlers import group
    group.set_client(FakeJevClient({"buy crypto": SCAM}, default=CHATTER))
    telegram = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    return telegram, app.build_dispatcher()


def cards_sent():
    """Review cards only.

    The billing notice from Task 10 also goes to LOG, so counting every
    SendMessage to LOG would count the notice as a second card. A review card
    is the one carrying the rv: moderation buttons; the notice carries only a
    subscribe URL.
    """
    return [c for c in calls
            if isinstance(c, SendMessage) and c.chat_id == LOG
            and c.reply_markup is not None
            and any((b.callback_data or "").startswith("rv:")
                    for row in c.reply_markup.inline_keyboard for b in row)]


def payment_update(update_id: int, charge_id: str, stars: int) -> Update:
    """A real successful_payment update, so router registration is covered too."""
    return Update(update_id=update_id, message=Message(
        message_id=update_id, date=NOW,
        chat=Chat(id=ADMIN, type="private"),
        from_user=User(id=ADMIN, is_bot=False, first_name="Boss"),
        successful_payment=SuccessfulPayment(
            currency="XTR", total_amount=stars,
            invoice_payload=f"sub:{GROUP}:{stars}",
            telegram_payment_charge_id=charge_id,
            provider_payment_charge_id="p")))


async def test_an_unpaid_large_group_reports_spam_without_deleting_it():
    """The whole feature in one path: classified, carded, not deleted, sold to."""
    _active_group(5000)
    _burn_the_trial()
    telegram, dispatcher = _dispatch()
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 1))

    assert deletions() == []
    assert len(cards_sent()) == 1
    assert any(b.url for row in cards_sent()[0].reply_markup.inline_keyboard
               for b in row), "the card must carry the subscribe button"


async def test_a_large_group_inside_its_trial_still_deletes():
    from storage import billing
    _active_group(5000)
    telegram, dispatcher = _dispatch()
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 1))
    assert len(deletions()) == 1
    assert billing.get(GROUP).grace_until is not None, \
        "a grace window is only opened for a paid tier, so this proves the " \
        "member count was really read as LARGE and not misread as free"


async def test_a_small_group_deletes_without_ever_paying():
    _active_group(150)
    telegram, dispatcher = _dispatch()
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 1))
    assert len(deletions()) == 1


async def test_paying_turns_deletion_back_on_for_the_same_message():
    _active_group(5000)
    _burn_the_trial()
    telegram, dispatcher = _dispatch()
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 1))
    assert deletions() == []

    await dispatcher.feed_update(telegram, payment_update(2, "ch_1", 250))
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 3))
    assert len(deletions()) == 1


async def test_an_admins_message_is_untouched_whatever_the_tier():
    """Payment gates the action, never the judgment - and never the guard that
    admins are not acted upon."""
    from handlers import group
    _active_group(5000)
    _burn_the_trial()
    telegram, dispatcher = _dispatch()
    before = len(group._client.calls)
    await dispatcher.feed_update(telegram, group_message("buy crypto now", ADMIN, 1))
    assert deletions() == []
    assert len(group._client.calls) == before, "an admin must never reach the classifier"
