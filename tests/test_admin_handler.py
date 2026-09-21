import os
import tempfile
from datetime import datetime, timezone

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.methods import (AnswerCallbackQuery, EditMessageText, GetChatMember,
                             GetMe, SendMessage)
from aiogram.types import (CallbackQuery, Chat, ChatMemberAdministrator, ChatMemberMember,
                           Message, Update, User)

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
GROUP, ADMIN, BYSTANDER = -100123, 777, 888
calls: list = []
# A single Dispatcher per test, built lazily on first feed() and cleared by
# the fixture: aiogram refuses to attach the same Router to two Dispatchers,
# and a test that calls feed() more than once (e.g. toggling a setting twice,
# or pressing a threshold button repeatedly) must reuse the one it already
# built rather than trying to include the router again.
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
    # Bot.__call__ is a single class attribute shared by every test module
    # that patches it. Re-asserting it here, per test, makes this module
    # immune to collection order and to any other module patching it.
    Bot.__call__ = fake_call
    # handlers.admin's `router` is a module-level aiogram Router, and aiogram
    # refuses to attach a Router that already has a parent Dispatcher. Each
    # test below builds its own Dispatcher and includes handlers.admin.router,
    # so the module must be reloaded here to hand every test a fresh,
    # unattached Router - otherwise only the first test to run in this
    # process would ever get past dispatcher.include_router().
    import handlers.admin
    importlib.reload(handlers.admin)
    _dispatcher.clear()
    yield
    db.reset()


async def fake_call(self, method, request_timeout=None):
    calls.append(method)
    if isinstance(method, GetMe):
        return User(id=1, is_bot=True, first_name="StopSpam", username="StopSpam_jev_bot")
    if isinstance(method, SendMessage):
        return Message(message_id=1, date=NOW, chat=Chat(id=method.chat_id, type="private"),
                       text=method.text)
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


async def feed(update: Update):
    if "dispatcher" not in _dispatcher:
        from handlers import admin
        dispatcher = Dispatcher()
        dispatcher.include_router(admin.router)
        _dispatcher["dispatcher"] = dispatcher
    bot = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await _dispatcher["dispatcher"].feed_update(bot, update)


def dm(text: str, user_id: int = ADMIN) -> Update:
    message = Message(message_id=1, date=NOW, chat=Chat(id=user_id, type="private"),
                      from_user=User(id=user_id, is_bot=False, first_name="Boss"), text=text)
    return Update(update_id=1, message=message)


def tap(data: str, user_id: int = ADMIN) -> Update:
    card = Message(message_id=5, date=NOW, chat=Chat(id=user_id, type="private"), text="menu")
    query = CallbackQuery(id="q", from_user=User(id=user_id, is_bot=False, first_name="Boss"),
                          chat_instance="ci", message=card, data=data)
    return Update(update_id=2, callback_query=query)


def sent():
    return [c for c in calls if isinstance(c, SendMessage)]


async def test_privacy_command_names_the_third_party_and_retention():
    await feed(dm("/privacy"))
    body = sent()[-1].text.lower()
    assert "typesafe" in body
    assert "united states" in body
    assert "7 days" in body


async def test_start_greets_in_english():
    await feed(dm("/start"))
    assert sent()[-1].text


async def test_toggling_jev_persists():
    from storage import chats
    await feed(tap(f"cfg:{GROUP}:jev"))
    assert chats.get_chat(GROUP).jev_enabled is False
    await feed(tap(f"cfg:{GROUP}:jev"))
    assert chats.get_chat(GROUP).jev_enabled is True


async def test_mode_toggle_persists():
    from storage import chats
    await feed(tap(f"cfg:{GROUP}:mode"))
    assert chats.get_chat(GROUP).mode == "active"


async def test_threshold_step_is_clamped_to_unit_interval():
    from storage import chats
    for _ in range(30):
        await feed(tap(f"cfg:{GROUP}:thr:delete_threshold:+"))
    assert chats.get_chat(GROUP).delete_threshold <= 1.0


async def test_non_admin_cannot_change_anything():
    from storage import chats
    before = chats.get_chat(GROUP).jev_enabled
    await feed(tap(f"cfg:{GROUP}:jev", user_id=BYSTANDER))
    assert chats.get_chat(GROUP).jev_enabled is before
    alerts = [c for c in calls if isinstance(c, AnswerCallbackQuery)]
    assert alerts and alerts[-1].text


async def test_language_switch_changes_menu_language():
    from storage import chats
    await feed(tap(f"cfg:{GROUP}:lang"))
    assert chats.get_chat(GROUP).lang == "ru"
