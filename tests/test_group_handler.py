import os
import tempfile
from datetime import datetime, timezone

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramNetworkError
from aiogram.methods import (CreateInvoiceLink, DeleteMessage, GetChatMember,
                             GetChatMemberCount, GetMe, SendMessage)
from aiogram.types import (Chat, ChatMemberLeft, ChatMemberMember, ChatMemberOwner,
                           ChatMemberUpdated, Message, Update, User)

from core.jev import FakeJevClient
from tests.fixtures.verdicts import CHATTER, SCAM

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
GROUP, SPAMMER, LOG = -100123, 555, -100999
# A card destination every send to fails, standing in for the admin who never
# pressed Start or who blocked the bot.
UNREACHABLE_LOG = -100888
ADMIN, MODCHAT = 777, -100777
# One Dispatcher per test, built lazily and cleared by the fixture: aiogram
# refuses to attach the same Router to two Dispatchers, so a test that feeds
# more than one update must reuse the one it already built.
_dispatcher: dict = {}
calls: list = []
# User ids whose get_chat_member call fake_call should fail, standing in for
# a transient Telegram error on the admin lookup.
unreachable: set = set()
# (chat_id, user_id) pairs fake_call should report as an ordinary member
# rather than the owner it reports by default. Lets one test give a user
# admin rights in one chat and not in another.
plain_members: set = set()
# The member count fake_call reports, and a record of how often it was asked.
# A list rather than an int so fake_call can mutate it without `global`.
MEMBERS = [150]
count_calls: list = []
# Non-empty makes the next count lookup fail, the way `unreachable` does for
# GetChatMember.
count_fails: list = []


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
    plain_members.clear()
    MEMBERS[0] = 150
    count_calls.clear()
    count_fails.clear()
    _dispatcher.clear()
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
        if method.chat_id == UNREACHABLE_LOG:
            raise TelegramNetworkError(method=method, message="chat not found")
        return Message(message_id=9001, date=NOW,
                       chat=Chat(id=method.chat_id, type="supergroup"), text=method.text)
    if isinstance(method, GetChatMember):
        if method.user_id in unreachable:
            raise TelegramNetworkError(method=method, message="lookup failed")
        if method.user_id == SPAMMER or (method.chat_id, method.user_id) in plain_members:
            return ChatMemberMember(
                user=User(id=method.user_id, is_bot=False, first_name="Ann"),
                status="member")
        return ChatMemberOwner(
            user=User(id=method.user_id, is_bot=False, first_name="Boss"),
            status="creator", is_anonymous=False)
    if isinstance(method, CreateInvoiceLink):
        # A real link, not the bare True the fallback returns: a billing
        # notice puts it on an InlineKeyboardButton, whose url field will not
        # take a bool.
        return "https://t.me/$invoice_test"
    if isinstance(method, GetChatMemberCount):
        count_calls.append(method)
        if count_fails:
            raise TelegramNetworkError(method=method, message="count failed")
        return MEMBERS[0]
    return True


def group_message(text: str, user_id: int = SPAMMER, msg_id: int = 1) -> Update:
    message = Message(
        message_id=msg_id, date=NOW,
        chat=Chat(id=GROUP, type="supergroup", title="Python Chat"),
        from_user=User(id=user_id, is_bot=False, first_name="Ann", username="ann"),
        text=text,
    )
    return Update(update_id=msg_id, message=message)


async def dispatch(update: Update):
    from handlers import group
    if "d" not in _dispatcher:
        dispatcher = Dispatcher()
        dispatcher.include_router(group.router)
        _dispatcher["d"] = dispatcher
    bot = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await _dispatcher["d"].feed_update(bot, update)


def a_bot() -> Bot:
    return Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))


async def feed(update: Update, client: FakeJevClient, *, active: bool = True,
               log_chat: int | None = LOG):
    from handlers import group
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(
        GROUP, log_chat_id=log_chat,
        mode="active" if active else "observe",
        observe_until="2020-01-01T00:00:00+00:00" if active else "2999-01-01T00:00:00+00:00",
    )
    group.set_client(client)
    await dispatch(update)


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


async def test_outage_on_a_plain_message_says_nothing():
    """A message with no link, forward or media caption is left alone in
    silence during an outage - the spec only promises a review for
    trigger-bearing ones, and notifying on every unchecked message would bury
    the ones that matter.
    """
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


def membership(chat_id: int, adder: int, *, left: bool = False) -> Update:
    """The my_chat_member update Telegram sends when the bot is added."""
    member = User(id=1, is_bot=True, first_name="StopSpam")
    return Update(update_id=99, my_chat_member=ChatMemberUpdated(
        chat=Chat(id=chat_id, type="supergroup", title="Python Chat"),
        from_user=User(id=adder, is_bot=False, first_name="Boss"),
        date=NOW,
        old_chat_member=ChatMemberLeft(user=member, status="left"),
        new_chat_member=(ChatMemberLeft(user=member, status="left") if left
                         else ChatMemberMember(user=member, status="member")),
    ))


def command(text: str, chat_id: int, user_id: int) -> Update:
    return Update(update_id=98, message=Message(
        message_id=77, date=NOW,
        chat=Chat(id=chat_id, type="supergroup", title="Mod Room"),
        from_user=User(id=user_id, is_bot=False, first_name="Boss"),
        text=text,
        entities=[{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}],
    ))


def audit_rows():
    from storage import db
    return db.connect().execute(
        "SELECT * FROM audit WHERE chat_id = ?", (GROUP,)).fetchall()


async def test_a_card_is_never_posted_into_the_moderated_group():
    """The whole of F1. With no destination set - which was every real
    deployment, since nothing wrote log_chat_id - the old code fell back to
    the group itself and republished the message it had just deleted, with
    Delete and Ban buttons every member could press.

    Production edit this catches: restoring
    `target = chat.log_chat_id or chat.chat_id` in core.actions.apply, or
    dropping the None branch of actions.card_destination.
    """
    await feed(group_message("buy crypto now"), FakeJevClient({"buy crypto": SCAM}),
               log_chat=None)
    assert cards_to(GROUP) == [], "the moderated group is never a card destination"
    assert len(deletions()) == 1, "the deletion itself still happens"


async def test_a_destination_equal_to_the_group_is_refused():
    """Belt and braces: even a log_chat_id that names the group itself - from
    an older database, or a future code path - must not be posted to.

    Production edit this catches: dropping the `log_chat_id == chat_id` arm
    of actions.card_destination.
    """
    await feed(group_message("buy crypto now"), FakeJevClient({"buy crypto": SCAM}),
               log_chat=GROUP)
    assert cards_to(GROUP) == []


async def test_an_undelivered_card_is_audited_as_degraded_not_reviewed():
    """In observation mode nothing is deleted, so the card is the entire
    outcome. If it went nowhere, an audit row saying "reviewed" claims a
    human saw a message nobody saw.

    Production edit this catches: restoring the old
    `action = "deleted" if deleted else "reviewed"` in core.actions.apply.
    """
    await feed(group_message("buy crypto now"), FakeJevClient({"buy crypto": SCAM}),
               active=False, log_chat=None)
    assert deletions() == []
    rows = [r for r in audit_rows() if r["action"] != "review"]
    assert [r["action"] for r in rows] == ["degraded"]
    assert "card_undelivered" in rows[0]["reason"]


async def test_a_delivered_card_is_still_audited_as_reviewed():
    """The paired positive case, so the test above cannot pass by the audit
    row simply never saying "reviewed" any more."""
    await feed(group_message("buy crypto now"), FakeJevClient({"buy crypto": SCAM}),
               active=False)
    assert cards_to(LOG)
    assert "reviewed" in [r["action"] for r in audit_rows()]


async def test_adding_the_bot_records_the_adder_as_the_destination():
    """Every group gets a private destination from the moment the bot arrives.

    Production edit this catches: removing on_bot_membership_changed, or its
    update_chat call - then log_chat_id stays NULL, which is the state that
    made F1 happen in every real deployment.
    """
    from storage import chats
    await dispatch(membership(GROUP, ADMIN))
    assert chats.get_chat(GROUP).log_chat_id == ADMIN


async def test_the_bot_leaving_records_nothing():
    """A left/kicked update is not an arrival and must not create a chat row.

    Production edit this catches: dropping the LEFT/KICKED early return.
    """
    from storage import chats
    await dispatch(membership(GROUP, ADMIN, left=True))
    assert chats.get_chat(GROUP) is None


async def test_an_existing_destination_survives_the_bot_being_re_added():
    """A destination an admin chose must not be quietly taken back by a
    re-promotion or a re-add.

    Production edit this catches: removing the `if chat.log_chat_id is None`
    condition, which would hand the cards back to whoever last touched the
    bot's membership.
    """
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=MODCHAT)
    await dispatch(membership(GROUP, ADMIN))
    assert chats.get_chat(GROUP).log_chat_id == MODCHAT


async def test_setlog_points_the_callers_groups_at_this_chat():
    """How someone moves cards out of one admin's DM and into a moderator
    group.

    Production edit this catches: removing the chats.update_chat call in
    on_setlog, or the handler itself - the group's cards would stay in the
    adder's DM with no way to move them from inside Telegram.
    """
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=ADMIN)
    chats.ensure_chat(MODCHAT, "Mod Room")
    await dispatch(command("/setlog", MODCHAT, ADMIN))
    assert chats.get_chat(GROUP).log_chat_id == MODCHAT


async def test_setlog_never_makes_a_chat_its_own_destination():
    """Run in the moderated group itself, /setlog must not aim that group's
    cards at that group - the exact thing F1 is about.

    Production edit this catches: removing `if chat_id == here: continue`
    from on_setlog.
    """
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=ADMIN)
    await dispatch(command("/setlog", GROUP, ADMIN))
    assert chats.get_chat(GROUP).log_chat_id == ADMIN


async def test_setlog_needs_admin_rights_in_the_destination_chat_too():
    """The caller here administers GROUP but is an ordinary member of
    MODCHAT. Without the check on the destination chat they could dump
    GROUP's cards - which quote GROUP's messages, with their authors' names
    and ids - into a room GROUP's admins do not control.

    Production edit this catches: dropping the guards.admin_check call at the
    top of on_setlog, or accepting anything but AdminCheck.ADMIN. The
    per-candidate check further down does not cover this: it only asks about
    GROUP, which this caller does administer.
    """
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=ADMIN)
    chats.ensure_chat(MODCHAT, "Mod Room")
    plain_members.add((MODCHAT, ADMIN))
    await dispatch(command("/setlog", MODCHAT, ADMIN))
    assert chats.get_chat(GROUP).log_chat_id == ADMIN
    assert cards_to(MODCHAT), "the refusal is said out loud, not swallowed"
    assert "Only an admin" in cards_to(MODCHAT)[-1].text


async def test_setlog_only_moves_chats_the_caller_administers():
    """The per-candidate check: a caller who administers the destination
    still cannot move a group they do not administer.

    Production edit this catches: dropping the guards.is_admin call inside
    on_setlog's loop.
    """
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=ADMIN)
    chats.ensure_chat(MODCHAT, "Mod Room")
    plain_members.add((GROUP, ADMIN))
    await dispatch(command("/setlog", MODCHAT, ADMIN))
    assert chats.get_chat(GROUP).log_chat_id == ADMIN


async def test_setlog_does_not_reach_the_classifier():
    """The command must be handled by its own handler, not fall through to
    the catch-all and be classified as a group message.

    Production edit this catches: registering on_setlog after
    on_group_message, where the catch-all would swallow it.
    """
    from handlers import group
    from storage import chats
    chats.ensure_chat(MODCHAT, "Mod Room")
    client = FakeJevClient({}, default=SCAM)
    group.set_client(client)
    await dispatch(command("/setlog", MODCHAT, ADMIN))
    assert client.calls == []


async def test_outage_on_a_trigger_bearing_message_reaches_a_human():
    """The spec's failure handling: during an outage a message that carried
    triggers still reaches a human. Before this, the pipeline computed a
    distinct reason for it, audited it, and core.actions threw the outcome
    away as "ignored" - so every link, invite and forward from an unknown
    account passed unseen.

    Production edit this catches: removing the UNAVAILABLE_WITH_TRIGGER
    branch at the top of core.actions.apply, which restores the old silent
    "ignored" return.
    """
    await feed(group_message("look at https://evil.example/free"),
               FakeJevClient({}, fail=True))
    notices = cards_to(LOG)
    assert notices, "a trigger-bearing message left unchecked is reported"
    assert deletions() == [], "an outage never deletes"
    assert notices[-1].reply_markup is None, (
        "no verdict behind it and nothing to reverse, so no buttons")
    body = notices[-1].text
    assert "Not checked" in body
    assert "evil.example" in body, "an admin must be able to find the message"
    assert str(SPAMMER) in body


async def test_an_outage_notice_is_never_posted_into_the_moderated_group():
    """The outage notice quotes the message too, so it obeys the same rule
    the review card does.

    Production edit this catches: using `chat.log_chat_id or chat.chat_id`
    inside _report_outage instead of actions.card_destination.
    """
    await feed(group_message("look at https://evil.example/free"),
               FakeJevClient({}, fail=True), log_chat=None)
    assert cards_to(GROUP) == []


def service_message(**extra) -> Update:
    """A message with no text and no caption: a join, a pin, a bare photo."""
    return Update(update_id=55, message=Message(
        message_id=55, date=NOW,
        chat=Chat(id=GROUP, type="supergroup", title="Python Chat"),
        from_user=User(id=SPAMMER, is_bot=False, first_name="Ann"),
        **extra,
    ))


async def test_a_join_costs_no_classifier_call():
    """@router.message() matches joins, leaves, pins and title changes, and
    the gate returns low_history for anyone new - so the bot used to spend a
    Jev call asking whether nothing is spam, plus two get_chat_member calls,
    on every one of them. In a group with normal join churn that is most of
    the spend.

    Production edit this catches: removing the `if not (message.text or
    message.caption): return` guard in on_group_message.
    """
    client = FakeJevClient({}, default=CHATTER)
    await feed(service_message(
        new_chat_members=[User(id=SPAMMER, is_bot=False, first_name="Ann")]), client)
    assert client.calls == [], "there is nothing in a join to classify"
    assert [c for c in calls if isinstance(c, GetChatMember)] == []


async def test_a_captionless_photo_costs_no_classifier_call():
    client = FakeJevClient({}, default=CHATTER)
    await feed(service_message(photo=[]), client)
    assert client.calls == []


async def test_a_captioned_photo_is_still_checked():
    """The paired positive case: media is judged by its caption, per the
    spec, so the guard must key on text-or-caption and not on media at all.
    """
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=LOG, mode="active",
                      observe_until="2020-01-01T00:00:00+00:00")
    client = FakeJevClient({"buy crypto": SCAM})
    from handlers import group
    group.set_client(client)
    await dispatch(Update(update_id=56, message=Message(
        message_id=56, date=NOW,
        chat=Chat(id=GROUP, type="supergroup", title="Python Chat"),
        from_user=User(id=SPAMMER, is_bot=False, first_name="Ann"),
        caption="buy crypto now", photo=[])))
    assert client.calls, "a caption is the message, and must still be checked"
    assert len(deletions()) == 1


async def test_a_confident_deletion_survives_a_locked_review_table(monkeypatch):
    """core.actions._best_effort's whole contract: a decision already made
    must reach Telegram even when sqlite is locked. The review row only
    decides whether the card can carry buttons bound to it, so without a row
    the card still goes out - it just cannot offer Delete, Ban or Not spam.

    Production edit this catches: calling reviews.create directly instead of
    through _best_effort (the sqlite3.Error then escapes apply() and the
    handler, and the message is never deleted), or making the card
    conditional on review_id (the deletion would go unreported).
    """
    import sqlite3

    from storage import reviews

    def boom(*args, **kwargs):
        raise sqlite3.Error("database is locked")

    monkeypatch.setattr(reviews, "create", boom)
    await feed(group_message("buy crypto now"), FakeJevClient({"buy crypto": SCAM}))
    assert len(deletions()) == 1, "a confident deletion still happens"
    assert len(cards_to(LOG)) == 1, "and is still reported"
    assert cards_to(LOG)[0].reply_markup is None, (
        "buttons would be bound to a review row that does not exist")


async def test_a_message_is_skipped_when_the_chat_row_cannot_be_read(monkeypatch):
    """Without a chat config there are no thresholds, no mode and no
    destination, so there is nothing to decide with. The handler skips the
    message rather than guessing - and skipping means not deleting.

    Production edit this catches: removing the try/except sqlite3.Error
    around ensure_chat/trust.seen in on_group_message, which lets the error
    escape the handler, or moving the evaluation above it.
    """
    import sqlite3

    from storage import chats

    def boom(*args, **kwargs):
        raise sqlite3.Error("database is locked")

    from handlers import group
    # The chat is set up first, exactly as feed() would, so the only thing
    # this test changes is the read that happens inside the handler.
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=LOG, mode="active",
                      observe_until="2020-01-01T00:00:00+00:00")
    client = FakeJevClient({"buy crypto": SCAM})
    group.set_client(client)

    monkeypatch.setattr(chats, "ensure_chat", boom)
    await dispatch(group_message("buy crypto now"))
    assert deletions() == [], "no delete is attempted without a chat config"
    assert cards_to(LOG) == []
    assert client.calls == [], "and no classifier call is spent either"


async def test_a_locked_audit_table_does_not_cancel_the_action(monkeypatch):
    """The audit row is the record of a decision, not a precondition for it.

    Production edit this catches: calling audit.record directly in
    core.actions.apply instead of through _best_effort.
    """
    import sqlite3

    from storage import audit

    def boom(*args, **kwargs):
        raise sqlite3.Error("database is locked")

    monkeypatch.setattr(audit, "record", boom)
    await feed(group_message("buy crypto now"), FakeJevClient({"buy crypto": SCAM}))
    assert len(deletions()) == 1
    assert len(cards_to(LOG)) == 1


async def test_entitlement_is_free_when_the_group_is_small():
    from core import tiers
    from handlers import group
    from storage import chats
    chat = chats.ensure_chat(GROUP, "Small Group")
    MEMBERS[0] = 150
    ent, _ = await group._entitlement(a_bot(), chat)
    assert ent.tier == tiers.FREE
    assert ent.active is True


async def test_a_large_unpaid_group_outside_observation_gets_grace_once():
    from core import tiers
    from handlers import group
    from storage import billing, chats
    chats.ensure_chat(GROUP, "Big Group")
    chats.update_chat(GROUP, mode="active", observe_until="2020-01-01T00:00:00+00:00")
    chat = chats.get_chat(GROUP)
    MEMBERS[0] = 5000

    first, _ = await group._entitlement(a_bot(), chat)
    assert first.tier == tiers.LARGE
    assert (first.active, first.reason) == (True, "grace")

    opened = billing.get(GROUP).grace_until
    second, _ = await group._entitlement(a_bot(), chat)
    assert billing.get(GROUP).grace_until == opened, "grace must be set once, ever"
    assert second.reason == "grace"


async def test_grace_does_not_start_while_the_chat_is_still_observing():
    """Otherwise half the trial burns during a week when nothing is deleted
    anyway, and the admin evaluates a product they never saw working."""
    from handlers import group
    from storage import billing, chats
    chat = chats.ensure_chat(GROUP, "Big New Group")  # observe_until is in the future
    MEMBERS[0] = 5000
    ent, _ = await group._entitlement(a_bot(), chat)
    assert billing.get(GROUP).grace_until is None
    assert ent.active is False


async def test_the_member_count_is_not_refetched_within_the_cache_window():
    from handlers import group
    from storage import chats
    chat = chats.ensure_chat(GROUP, "Group")
    MEMBERS[0] = 150
    await group._entitlement(a_bot(), chat)
    await group._entitlement(a_bot(), chat)
    assert len(count_calls) == 1


async def test_a_failed_member_count_lookup_does_not_disarm_moderation():
    """A billing lookup must never be what stops a group being moderated."""
    from handlers import group
    from storage import chats
    chat = chats.ensure_chat(GROUP, "Group")
    count_fails.append(True)
    ent, _ = await group._entitlement(a_bot(), chat)
    assert ent.active is True


async def test_a_failed_refetch_keeps_the_cached_tier():
    """A paying large group whose refetch fails must not silently demote to
    free - that would hand it the service unbilled and never open grace."""
    from core import tiers
    from handlers import group
    from storage import billing, chats, db
    chats.ensure_chat(GROUP, "Big Group")
    chats.update_chat(GROUP, mode="active", observe_until="2020-01-01T00:00:00+00:00")
    billing.set_member_count(GROUP, 5000)
    # set_member_count stamps member_count_at to now, so age it past the TTL -
    # otherwise the refetch is skipped entirely and this test proves nothing.
    conn = db.connect()
    conn.execute("UPDATE billing SET member_count_at = ? WHERE chat_id = ?",
                 ("2020-01-01T00:00:00+00:00", GROUP))
    conn.commit()

    count_fails.append(True)
    ent, _ = await group._entitlement(a_bot(), chats.get_chat(GROUP))
    assert len(count_calls) == 1, "the refetch must actually have been attempted"
    assert ent.tier == tiers.LARGE, "a failed refetch must not demote a paying group to free"


async def test_the_message_that_opens_grace_announces_a_trial_that_has_days_left():
    """The row handed to notices must carry the window just opened.

    _entitlement reads the billing row before it calls start_grace, so the row
    it returns still says grace_until=None unless it is refreshed. Notices
    computed from that read zero days left, which lands on grace_ending and
    tells the admin "the free trial ends in 0 days" on the day it started -
    and because stages only move forward, that one wrong notice blocks the
    real grace and lapse notices for good.
    """
    from core import notices
    from storage import billing
    MEMBERS[0] = 5000

    await feed(group_message("morning all"), FakeJevClient({}, default=CHATTER))

    assert billing.get(GROUP).grace_until is not None, "grace was never opened"
    assert billing.get(GROUP).notified_stage == notices.STAGE_GRACE, (
        "the trial must be announced as a trial, not as one ending today")
    body = cards_to(LOG)[-1].text
    assert "14 more days" in body, f"wrong day count in the notice: {body!r}"
    assert "ends in 0 days" not in body


async def test_a_large_group_still_observing_is_told_nothing():
    """Its first message ever reads as not_entitled, because nothing has been
    offered to it yet. Announcing that as a lapse tells a brand-new group its
    subscription ended, and burns the lapsed flag so no later notice can ever
    be sent."""
    from storage import billing
    MEMBERS[0] = 5000

    await feed(group_message("morning all"), FakeJevClient({}, default=CHATTER),
               active=False)

    assert cards_to(LOG) == [], "an observing chat was told something"
    assert billing.get(GROUP).notified_stage is None


async def test_a_failed_start_grace_leaves_the_chat_entitled(monkeypatch):
    """A billing problem must never disarm moderation, and the rule is
    unconditional: the sibling failure one branch up (a failed billing read)
    already resolves to entitled. A None from start_grace would otherwise
    leave grace_until unset, which builds not_entitled and stops a group being
    enforced over a locked database."""
    import sqlite3

    from handlers import group
    from storage import billing, chats

    chats.ensure_chat(GROUP, "Big Group")
    chats.update_chat(GROUP, mode="active", observe_until="2020-01-01T00:00:00+00:00")
    MEMBERS[0] = 5000

    def boom(*args, **kwargs):
        raise sqlite3.Error("database is locked")

    monkeypatch.setattr(billing, "start_grace", boom)
    ent, _ = await group._entitlement(a_bot(), chats.get_chat(GROUP))
    assert ent.active is True, "a locked database disarmed moderation"
    assert ent.reason == "billing_unavailable"


async def test_notices_are_evaluated_once_per_cache_window_not_per_message():
    """core.notices records no stage when the send fails, so nothing else
    bounds this. For a chat whose destination is a user who blocked the bot,
    every later message would cost a create_invoice_link plus a failing
    send_message, forever."""
    from storage import billing
    MEMBERS[0] = 5000

    client = FakeJevClient({}, default=CHATTER)
    # The destination is a chat every send fails for, so the notice is never
    # delivered and no stage is recorded - which is exactly the case nothing
    # else bounds.
    await feed(group_message("morning all", msg_id=1), client,
               log_chat=UNREACHABLE_LOG)
    assert billing.get(GROUP).notified_stage is None, (
        "the send failed, so no stage may be recorded - otherwise this test "
        "would be proving the stage flag rather than the cache window")
    first = len([c for c in calls if isinstance(c, CreateInvoiceLink)])
    assert first == 1, "the first message must evaluate the notice"

    await dispatch(group_message("morning again", msg_id=2))
    again = len([c for c in calls if isinstance(c, CreateInvoiceLink)])
    assert again == 1, (
        "a second message inside the same cache window evaluated the notice "
        "again; a chat whose destination never answers would retry forever")
