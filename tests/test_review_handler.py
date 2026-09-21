import json
import os
import tempfile
from datetime import datetime, timezone

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.methods import (AnswerCallbackQuery, BanChatMember, DeleteMessage,
                             EditMessageText, GetChatMember, GetMe)
from aiogram.types import (CallbackQuery, Chat, ChatMemberAdministrator, ChatMemberMember,
                           Message, Update, User)

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
GROUP, LOG, SPAMMER, ADMIN, BYSTANDER = -100123, -100999, 555, 777, 888
calls: list = []
# A single Dispatcher per test, built lazily on first feed() and cleared by
# the fixture: aiogram refuses to attach the same Router to two Dispatchers,
# and a test that presses a card twice (e.g. a double press) must reuse the
# one it already built rather than trying to include the router again.
_dispatcher: dict = {}


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    path = os.path.join(tempfile.mkdtemp(), "t.db")
    monkeypatch.setenv("DB_PATH", path)
    monkeypatch.setenv("BOT_TOKEN", "123:abc")
    import importlib
    import config
    importlib.reload(config)
    from storage import chats, db
    db.reset()
    calls.clear()
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=LOG)
    # Bot.__call__ is a single class attribute shared by every test module
    # that patches it. pytest imports (collects) all test files before
    # running any test, so whichever module was imported last would win for
    # every test in the session if this assignment lived at module level.
    # Re-asserting it here, per test, makes this module immune to collection
    # order and to any other module patching the same attribute.
    Bot.__call__ = fake_call
    # handlers.review's `router` is a module-level aiogram Router, and aiogram
    # refuses to attach a Router that already has a parent Dispatcher. Each
    # test below builds its own Dispatcher and includes handlers.review.router,
    # so the module must be reloaded here to hand every test a fresh,
    # unattached Router - otherwise only the first test to run in this
    # process would ever get past dispatcher.include_router().
    import handlers.review
    importlib.reload(handlers.review)
    _dispatcher.clear()
    yield
    db.reset()


async def fake_call(self, method, request_timeout=None):
    calls.append(method)
    if isinstance(method, GetMe):
        return User(id=1, is_bot=True, first_name="StopSpam", username="StopSpam_jev_bot")
    if isinstance(method, GetChatMember):
        if method.user_id == ADMIN:
            return ChatMemberAdministrator(
                user=User(id=ADMIN, is_bot=False, first_name="Boss"), status="administrator",
                can_be_edited=False, is_anonymous=False, can_manage_chat=True,
                can_delete_messages=True, can_manage_video_chats=True,
                can_restrict_members=True, can_promote_members=False,
                can_change_info=True, can_invite_users=True,
                can_post_stories=False, can_edit_stories=False, can_delete_stories=False,
                can_send_welcome_messages=False)
        return ChatMemberMember(
            user=User(id=method.user_id, is_bot=False, first_name="Nobody"), status="member")
    return True


def make_review() -> int:
    from storage import reviews
    return reviews.create(GROUP, 42, SPAMMER, "buy crypto now", json.dumps({}), 0.93)


def press(action: str, review_id: int, by: int = ADMIN) -> Update:
    return press_raw(f"rv:{action}:{review_id}", by=by)


def press_raw(data: str, by: int = ADMIN) -> Update:
    card = Message(message_id=9001, date=NOW, chat=Chat(id=LOG, type="supergroup"),
                   text="card")
    query = CallbackQuery(
        id="q1", from_user=User(id=by, is_bot=False, first_name="Boss"),
        chat_instance="ci", message=card, data=data,
    )
    return Update(update_id=1, callback_query=query)


async def feed(update: Update):
    if "dispatcher" not in _dispatcher:
        from handlers import review
        dispatcher = Dispatcher()
        dispatcher.include_router(review.router)
        _dispatcher["dispatcher"] = dispatcher
    bot = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await _dispatcher["dispatcher"].feed_update(bot, update)


def answers():
    return [c for c in calls if isinstance(c, AnswerCallbackQuery)]


async def test_not_spam_allowlists_the_author():
    from storage import reviews, trust
    rid = make_review()
    await feed(press("ok", rid))
    assert trust.get(GROUP, SPAMMER).status == "allowlisted"
    assert reviews.get(rid)["decision"] == "not_spam"
    assert not [c for c in calls if isinstance(c, DeleteMessage)]


async def test_delete_removes_the_message():
    from storage import reviews
    rid = make_review()
    await feed(press("del", rid))
    deleted = [c for c in calls if isinstance(c, DeleteMessage)]
    assert deleted and deleted[0].message_id == 42
    assert reviews.get(rid)["decision"] == "delete"


async def test_ban_deletes_and_bans():
    from storage import reviews, trust
    rid = make_review()
    await feed(press("ban", rid))
    assert [c for c in calls if isinstance(c, DeleteMessage)]
    banned = [c for c in calls if isinstance(c, BanChatMember)]
    assert banned and banned[0].user_id == SPAMMER
    assert reviews.get(rid)["decision"] == "delete_ban"
    # A banned author must also be marked flagged in the trust ledger - this
    # is the write that keeps them from ever being silently re-trusted, and
    # it is easy to lose in a refactor since nothing else in this test
    # touches it.
    assert trust.get(GROUP, SPAMMER).status == "flagged"


async def test_non_admin_press_changes_nothing():
    from storage import reviews
    rid = make_review()
    await feed(press("ban", rid, by=BYSTANDER))
    assert reviews.get(rid)["decision"] is None
    assert not [c for c in calls if isinstance(c, BanChatMember)]
    assert answers()[-1].text


async def test_second_press_is_refused():
    rid = make_review()
    await feed(press("del", rid))
    calls.clear()
    await feed(press("ban", rid))
    assert not [c for c in calls if isinstance(c, BanChatMember)]


async def test_concurrent_presses_only_one_wins():
    """Two overlapping presses on the same review must not both act.

    The handler has an await point (the admin verification against
    Telegram) between reading "review is unresolved" and atomically
    claiming it. This simulates a second admin's press landing in exactly
    that window: by the time this press's own admin check returns, the
    review has already been resolved by someone else. reviews.resolve()'s
    atomic claim must then fail for this press, and none of its destructive
    actions (ban, delete) may run - the racer's decision must stand
    untouched, not be overwritten by whichever call happens to finish last.
    """
    from storage import reviews
    rid = make_review()

    async def racing_call(self, method, request_timeout=None):
        if isinstance(method, GetChatMember) and method.user_id == ADMIN:
            reviews.resolve(rid, "delete", decided_by=999)
        return await fake_call(self, method, request_timeout)

    Bot.__call__ = racing_call
    await feed(press("ban", rid))

    assert reviews.get(rid)["decision"] == "delete", "the racer's decision must not be overwritten"
    assert reviews.get(rid)["decided_by"] == 999
    assert not [c for c in calls if isinstance(c, BanChatMember)]
    assert not [c for c in calls if isinstance(c, DeleteMessage)]
    assert answers(), "the losing press must still get an answer, not a hanging spinner"


async def test_card_is_edited_to_show_the_outcome():
    from texts import t
    rid = make_review()
    await feed(press("del", rid))
    edits = [c for c in calls if isinstance(c, EditMessageText)]
    assert edits
    assert t("done_delete", "en") in edits[0].text


async def test_callback_data_missing_id_is_answered_not_crashed():
    await feed(press_raw("rv:ban"))
    assert not [c for c in calls if isinstance(c, (DeleteMessage, BanChatMember))]
    assert answers()


async def test_callback_data_non_numeric_id_is_answered_not_crashed():
    await feed(press_raw("rv:ban:abc"))
    assert not [c for c in calls if isinstance(c, (DeleteMessage, BanChatMember))]
    assert answers()


async def test_unknown_verb_is_answered_not_crashed():
    from storage import reviews
    rid = make_review()
    await feed(press_raw(f"rv:xyz:{rid}"))
    assert reviews.get(rid)["decision"] is None
    assert not [c for c in calls if isinstance(c, (DeleteMessage, BanChatMember))]
    assert answers()
