import os
import tempfile
from datetime import datetime, timezone

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramNetworkError
from aiogram.methods import DeleteMessage, GetChatMember, GetMe, SendMessage
from aiogram.types import Chat, ChatMemberMember, ChatMemberOwner, Message, Update, User

from core.jev import FakeJevClient
from tests.fixtures.verdicts import CHATTER, SCAM

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
GROUP, SPAMMER, LOG = -100123, 555, -100999
calls: list = []
# User ids whose get_chat_member call fake_call should fail, standing in for
# a transient Telegram error on the admin lookup.
unreachable: set = set()


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    path = os.path.join(tempfile.mkdtemp(), "t.db")
    monkeypatch.setenv("DB_PATH", path)
    monkeypatch.setenv("BOT_TOKEN", "123:abc")
    import importlib
    import config
    importlib.reload(config)
    from storage import db
    db.reset()
    calls.clear()
    unreachable.clear()
    # Bot.__call__ is a single class attribute shared by every test module
    # that patches it. pytest imports (collects) all test files before
    # running any test, so whichever module was imported last would win for
    # every test in the session if this assignment lived at module level.
    # Re-asserting it here, per test, makes this module immune to collection
    # order and to any other module patching the same attribute.
    Bot.__call__ = fake_call
    # handlers.group's `router` is a module-level aiogram Router, and aiogram
    # refuses to attach a Router that already has a parent Dispatcher. Each
    # test below builds its own Dispatcher and includes handlers.group.router,
    # so the module must be reloaded here to hand every test a fresh, unattached
    # Router — otherwise only the first test to run in this process would ever
    # get past dispatcher.include_router().
    import handlers.group
    importlib.reload(handlers.group)
    yield
    db.reset()


async def fake_call(self, method, request_timeout=None):
    calls.append(method)
    if isinstance(method, GetMe):
        return User(id=1, is_bot=True, first_name="StopSpam", username="StopSpam_jev_bot")
    if isinstance(method, SendMessage):
        return Message(message_id=9001, date=NOW,
                       chat=Chat(id=method.chat_id, type="supergroup"), text=method.text)
    if isinstance(method, GetChatMember):
        if method.user_id in unreachable:
            raise TelegramNetworkError(method=method, message="lookup failed")
        if method.user_id == SPAMMER:
            return ChatMemberMember(
                user=User(id=SPAMMER, is_bot=False, first_name="Ann"), status="member")
        return ChatMemberOwner(
            user=User(id=method.user_id, is_bot=False, first_name="Boss"),
            status="creator", is_anonymous=False)
    return True


def group_message(text: str, user_id: int = SPAMMER, msg_id: int = 1) -> Update:
    message = Message(
        message_id=msg_id, date=NOW,
        chat=Chat(id=GROUP, type="supergroup", title="Python Chat"),
        from_user=User(id=user_id, is_bot=False, first_name="Ann", username="ann"),
        text=text,
    )
    return Update(update_id=msg_id, message=message)


async def feed(update: Update, client: FakeJevClient, *, active: bool = True):
    from handlers import group
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(
        GROUP, log_chat_id=LOG,
        mode="active" if active else "observe",
        observe_until="2020-01-01T00:00:00+00:00" if active else "2999-01-01T00:00:00+00:00",
    )
    group.set_client(client)
    bot = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dispatcher = Dispatcher()
    dispatcher.include_router(group.router)
    await dispatcher.feed_update(bot, update)


def deletions():
    return [c for c in calls if isinstance(c, DeleteMessage)]


def cards_to(chat_id):
    return [c for c in calls if isinstance(c, SendMessage) and c.chat_id == chat_id]


async def test_scam_is_deleted_and_logged():
    await feed(group_message("buy crypto now"), FakeJevClient({"buy crypto": SCAM}))
    assert len(deletions()) == 1
    assert deletions()[0].message_id == 1
    assert cards_to(LOG), "a deletion is still reported to the log chat"


async def test_ordinary_message_is_left_alone():
    await feed(group_message("morning all"), FakeJevClient({}, default=CHATTER))
    assert deletions() == []
    assert cards_to(LOG) == []


async def test_observation_mode_reports_without_deleting():
    await feed(group_message("buy crypto now"), FakeJevClient({"buy crypto": SCAM}),
               active=False)
    assert deletions() == []
    assert cards_to(LOG), "observation mode still shows admins what it would have done"


async def test_admin_message_is_never_checked():
    client = FakeJevClient({}, default=SCAM)
    await feed(group_message("buy crypto now", user_id=777, msg_id=2), client)
    assert deletions() == []
    assert client.calls == []


async def test_outage_deletes_nothing():
    from storage import db
    await feed(group_message("buy crypto now"), FakeJevClient({}, fail=True))
    assert deletions() == []
    assert cards_to(LOG) == []
    # An empty deletions() list alone can't tell a handled outage from a crash
    # before the delete was ever attempted. The pipeline's own outage path
    # audits the failure before returning, so its presence is proof the
    # handler ran the message all the way through rather than raising early.
    rows = db.connect().execute(
        "SELECT * FROM audit WHERE chat_id = ?", (GROUP,)).fetchall()
    assert len(rows) == 1
    assert rows[0]["action"] == "failed"
    assert rows[0]["reason"] == "jev_unavailable"


async def test_review_row_is_created_for_the_card():
    from storage import db
    await feed(group_message("buy crypto now"), FakeJevClient({"buy crypto": SCAM}))
    rows = db.connect().execute("SELECT * FROM reviews").fetchall()
    assert len(rows) == 1
    assert rows[0]["text"] == "buy crypto now"


async def test_failed_admin_lookup_never_acts_on_a_possible_admin():
    """A transient get_chat_member failure must not downgrade a possible
    admin to an ordinary member for this message.

    Production edit this catches: making guards.admin_check return
    AdminCheck.NOT_ADMIN (the old `return False`) on TelegramAPIError, or
    dropping the UNKNOWN branch in on_group_message. Either one classifies
    this message and deletes it, since SCAM clears the delete band.
    """
    unreachable.add(SPAMMER)
    client = FakeJevClient({"buy crypto": SCAM})
    await feed(group_message("buy crypto now"), client)
    assert deletions() == [], "a user whose admin status is unknown is not acted upon"
    assert cards_to(LOG) == []
    assert client.calls == [], "an unknown admin status costs no classifier call either"


async def test_a_reachable_lookup_still_acts():
    """The paired positive case: the same message, same fixtures, with the
    lookup working. Without this, the test above would also pass if
    on_group_message stopped acting on anything at all.
    """
    client = FakeJevClient({"buy crypto": SCAM})
    await feed(group_message("buy crypto now"), client)
    assert len(deletions()) == 1
    assert client.calls
