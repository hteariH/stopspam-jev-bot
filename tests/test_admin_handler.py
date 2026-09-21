import os
import tempfile
from datetime import datetime, timezone

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest
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
    from storage import chats, db, trust
    db.reset()
    calls.clear()
    chats.ensure_chat(GROUP, "Python Chat")
    # /chats only considers chats this user is plausibly in - a trust row (a
    # message they posted) or a log chat pointed at them. An admin who has
    # posted in their own group is the ordinary case; without this the menu
    # tests would be testing an admin the bot has never seen anywhere.
    trust.seen(GROUP, ADMIN)
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
        # Telegram's HTML parse mode only understands a fixed set of tags
        # (b, i, code, ...). "<chat>" is not one of them, so a real send of
        # an unescaped group title containing it would be rejected with
        # exactly this error - this simulates that rejection so a handler
        # that forgets to escape user-controlled text is caught here rather
        # than only in production.
        if "<chat>" in (method.text or ""):
            raise TelegramBadRequest(method=method, message="Bad Request: can't parse entities")
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
    text = sent()[-1].text
    # Specific enough that the wrong string, the wrong key (t() falls back
    # to returning the bare key itself for an unknown one) or the Russian
    # translation (written in Cyrillic, so it never contains "spam") would
    # all fail this, unlike a bare truthiness check.
    assert "spam" in text.lower()
    assert "/chats" in text


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


async def test_mode_toggle_does_not_touch_observe_until():
    # Decision 2's central guarantee: the mode toggle flips only between
    # "observe" and "active" and must never write observe_until - flipping
    # mode is not how a chat leaves or re-enters its observation window.
    from storage import chats
    before = chats.get_chat(GROUP).observe_until
    assert before is not None
    await feed(tap(f"cfg:{GROUP}:mode"))
    assert chats.get_chat(GROUP).observe_until == before


async def test_bare_chat_callback_rerenders_menu_without_changing_state():
    from storage import chats
    before = chats.get_chat(GROUP)
    await feed(tap(f"cfg:{GROUP}"))
    assert chats.get_chat(GROUP) == before
    edits = [c for c in calls if isinstance(c, EditMessageText)]
    assert edits and edits[-1].reply_markup is not None


async def test_group_title_with_markup_is_escaped_and_does_not_crash_chats():
    # chat.title is Telegram-controlled free text (the group's own title)
    # rendered into an HTML-parse-mode message, exactly like
    # core.cards.render_card's chat_title. Unescaped, "<chat>" is not a tag
    # Telegram's HTML mode understands, so a real send would be rejected -
    # the fake_call above simulates that rejection. This must not crash
    # /chats, and the title must reach the admin escaped, not stripped.
    from storage import chats
    chats.update_chat(GROUP, title="R&D <chat>")
    await feed(dm("/chats"))
    text = sent()[-1].text
    assert "<chat>" not in text
    assert "&lt;chat&gt;" in text
    assert "&amp;" in text


def lookups():
    return [c for c in calls if isinstance(c, GetChatMember)]


async def test_a_stranger_costs_no_telegram_lookups():
    """/chats is public: anyone who can DM the bot can run it. It must not
    walk the whole chats table asking Telegram about a user who has no
    connection to any of those chats.

    Production edit this catches: restoring the old
    `SELECT chat_id FROM chats` in _admin_chats, which asks Telegram about
    every known chat for every caller.
    """
    from storage import chats
    for i in range(5):
        chats.ensure_chat(-200 - i, f"Group {i}")
    await feed(dm("/chats", user_id=BYSTANDER))
    assert lookups() == [], "no candidate chats means no Telegram calls at all"
    assert sent() and "not in any group" in sent()[-1].text


async def test_candidate_set_is_capped_however_many_chats_match():
    """The cap is a hard bound on Telegram calls per command, not a page.

    Production edit this catches: dropping the LIMIT from
    chats.candidate_chat_ids, or raising MAX_MENU_CHATS above the number of
    matching rows - both make this command issue one get_chat_member per
    matching chat without bound.
    """
    from handlers import admin
    from storage import chats, trust
    extra = admin.MAX_MENU_CHATS + 10
    for i in range(extra):
        chats.ensure_chat(-300 - i, f"Group {i}")
        trust.seen(-300 - i, ADMIN)
    await feed(dm("/chats"))
    assert len(lookups()) <= admin.MAX_MENU_CHATS


async def test_repeated_chats_from_one_user_is_rate_limited():
    """The spec asks for a simple per-user rate limit on this command.

    Production edit this catches: removing the _chats_limiter check at the
    top of on_chats, which lets one user spend the bot's Telegram budget as
    fast as they can send the command.
    """
    from handlers import admin
    for _ in range(admin.CHATS_PER_MINUTE):
        await feed(dm("/chats"))
    calls.clear()
    await feed(dm("/chats"))
    assert lookups() == [], "a refused command must not reach Telegram at all"
    assert "Too many requests" in sent()[-1].text


async def test_the_budget_is_per_user_not_global():
    """One noisy stranger must not lock a real admin out of their own menu."""
    from handlers import admin
    for _ in range(admin.CHATS_PER_MINUTE + 1):
        await feed(dm("/chats", user_id=BYSTANDER))
    calls.clear()
    await feed(dm("/chats"))
    assert "Too many requests" not in sent()[-1].text


async def test_the_log_button_redirects_cards_to_the_pressing_admin():
    """Lets a second admin take the review queue over from whoever added the
    bot, without anyone touching the database.

    Production edit this catches: removing the "log" arm of on_config, or
    dropping "log" from _TOGGLE_FIELDS - the button then silently re-renders
    the menu and changes nothing.
    """
    from storage import chats
    assert chats.get_chat(GROUP).log_chat_id is None
    await feed(tap(f"cfg:{GROUP}:log"))
    assert chats.get_chat(GROUP).log_chat_id == ADMIN


async def test_a_non_admin_cannot_claim_the_review_queue():
    """The cards quote the group's messages, so pointing them at yourself is
    an admin-only action like every other one in this menu."""
    from storage import chats
    await feed(tap(f"cfg:{GROUP}:log", user_id=BYSTANDER))
    assert chats.get_chat(GROUP).log_chat_id is None


async def test_the_menu_says_where_cards_go_when_nowhere():
    """The menu used to print an em dash for the log chat, which is what
    every real chat showed, and read like an unset nicety rather than the
    reason cards were landing in the moderated group.

    Production edit this catches: restoring
    `{chat.log_chat_id or '—'}` in _menu.
    """
    await feed(dm("/chats"))
    body = sent()[-1].text
    line = body.split("Review cards go to")[1].splitlines()[0]
    assert "no destination is set" in line
    assert "cards are not delivered" in line


async def test_the_menu_names_the_admin_whose_dm_receives_the_cards():
    from storage import chats
    chats.update_chat(GROUP, log_chat_id=ADMIN)
    await feed(dm("/chats"))
    body = sent()[-1].text
    assert f"admin {ADMIN}" in body


async def test_privacy_admits_the_two_cases_it_used_to_omit():
    """The old text promised only "users without established history, plus
    links, forwards and media captions". The gate also sends every message
    from a flagged user forever (core/gate.py, status == "flagged") and
    re-checks a trusted member returning after 30 days of silence
    (days_since_seen > RECHECK_AFTER_DAYS). This is a public promise and
    README.md commits in writing that the two must agree.

    Production edit this catches: restoring the old two-line summary, which
    mentions neither case.
    """
    await feed(dm("/privacy"))
    body = sent()[-1].text.lower()
    assert "flagged" in body and "does not stop" in body
    assert "30 days" in body
    assert "5 clean messages" in body


async def test_privacy_names_what_is_never_sent():
    """The other half of an honest description: admins, allowlisted users and
    messages with no text at all never leave the group."""
    await feed(dm("/privacy"))
    body = sent()[-1].text.lower()
    assert "never send" in body
    assert "admins and owners" in body
    assert "neither text nor a caption" in body
