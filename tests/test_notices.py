import os
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

from core import notices, tiers


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


class FakeBot:
    def __init__(self, raises=None):
        self.sent = []
        self._raises = raises

    async def send_message(self, chat_id, text, reply_markup=None):
        if self._raises is not None:
            raise self._raises
        self.sent.append((chat_id, text, reply_markup))

    async def create_invoice_link(self, **kwargs):
        return "https://t.me/$invoice_test"


NOW = datetime(2026, 9, 21, 12, 0, 0, tzinfo=timezone.utc)


def stamp(**delta) -> str:
    return (NOW + timedelta(**delta)).isoformat(timespec="seconds")


def ent(reason, tier=tiers.LARGE):
    return tiers.Entitlement(tier=tier, active=reason != "not_entitled",
                             reason=reason, price=250)


def test_a_fresh_trial_is_announced():
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=14),
                              notified_stage=None, observing=False,
                              now=NOW) == notices.STAGE_GRACE


def test_a_trial_already_announced_is_not_announced_again():
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=14),
                              notified_stage=notices.STAGE_GRACE,
                              observing=False, now=NOW) is None


def test_the_end_of_the_trial_is_warned_about_once():
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=2),
                              notified_stage=notices.STAGE_GRACE,
                              observing=False, now=NOW) == notices.STAGE_GRACE_ENDING
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=2),
                              notified_stage=notices.STAGE_GRACE_ENDING,
                              observing=False, now=NOW) is None


def test_losing_entitlement_is_announced_even_with_no_trial_before_it():
    """A chat that paid and lapsed never had a grace stage recorded."""
    assert notices.next_stage(ent("not_entitled"), grace_until=None,
                              notified_stage=None, observing=False,
                              now=NOW) == notices.STAGE_LAPSED


def test_stages_only_move_forward():
    """Otherwise a chat oscillating around the threshold re-announces its
    trial every time it dips back."""
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=14),
                              notified_stage=notices.STAGE_LAPSED,
                              observing=False, now=NOW) is None


def test_a_paid_chat_is_told_nothing():
    assert notices.next_stage(ent("subscribed"), grace_until=None,
                              notified_stage=None, observing=False, now=NOW) is None


def test_a_free_chat_is_told_nothing():
    assert notices.next_stage(ent("free_tier", tier=tiers.FREE), grace_until=None,
                              notified_stage=None, observing=False, now=NOW) is None


async def test_a_notice_is_sent_once_and_the_stage_is_recorded():
    from storage import billing, chats
    chats.ensure_chat(-100123, "G")
    chats.update_chat(-100123, log_chat_id=999)
    billing.start_grace(-100123)
    bot = FakeBot()
    chat = chats.get_chat(-100123)

    await notices.maybe_notify(bot, chat=chat, row=billing.get(-100123),
                               entitlement=ent("grace"), observing=False)
    assert len(bot.sent) == 1
    assert billing.get(-100123).notified_stage == notices.STAGE_GRACE

    await notices.maybe_notify(bot, chat=chat, row=billing.get(-100123),
                               entitlement=ent("grace"), observing=False)
    assert len(bot.sent) == 1


async def test_a_chat_with_nowhere_to_send_records_no_stage():
    """Otherwise the stage advances against a notice nobody received, and the
    admin is never told at all."""
    from storage import billing, chats
    chats.ensure_chat(-100123, "G")   # no log_chat_id
    billing.start_grace(-100123)
    bot = FakeBot()
    await notices.maybe_notify(bot, chat=chats.get_chat(-100123),
                               row=billing.get(-100123),
                               entitlement=ent("grace"), observing=False)
    assert bot.sent == []
    assert billing.get(-100123).notified_stage is None


async def test_a_telegram_failure_records_no_stage_either():
    from aiogram.exceptions import TelegramAPIError
    from storage import billing, chats
    chats.ensure_chat(-100123, "G")
    chats.update_chat(-100123, log_chat_id=999)
    billing.start_grace(-100123)
    bot = FakeBot(raises=TelegramAPIError(method=None, message="boom"))
    await notices.maybe_notify(bot, chat=chats.get_chat(-100123),
                               row=billing.get(-100123),
                               entitlement=ent("grace"), observing=False)
    assert billing.get(-100123).notified_stage is None


def test_a_chat_inside_its_observation_window_is_told_nothing():
    """A brand-new large group reads as not_entitled on its very first
    message, because nothing has been offered to it yet. Announcing that as
    "the subscription has ended" is wrong on its own, and worse than wrong
    afterwards: stages only move forward, so the lapsed flag would block the
    grace and grace_ending notices this chat has not had yet, and the real
    lapse would never be announced either. core.policy already ranks
    observing above not_entitled; this is the same precedence.
    """
    assert notices.next_stage(ent("not_entitled"), grace_until=None,
                              notified_stage=None, observing=True,
                              now=NOW) is None


def test_observation_silences_the_trial_notices_too():
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=14),
                              notified_stage=None, observing=True,
                              now=NOW) is None


async def test_an_observing_chat_records_no_stage_at_all():
    """The flag is the damage: once set it is never unset, so a stage recorded
    here costs the chat every notice below it, permanently."""
    from storage import billing, chats
    chats.ensure_chat(-100123, "Big New Group")
    chats.update_chat(-100123, log_chat_id=999)
    bot = FakeBot()
    await notices.maybe_notify(bot, chat=chats.get_chat(-100123),
                               row=billing.get(-100123),
                               entitlement=ent("not_entitled"), observing=True)
    assert bot.sent == []
    assert billing.get(-100123).notified_stage is None


async def test_the_notice_escapes_a_group_title_telegram_would_reject():
    """A group named "Dogs & Cats" would otherwise fail its billing notice
    deterministically - and a failed send records no stage, so it would be
    retried on every evaluation, forever."""
    from storage import billing, chats
    chats.ensure_chat(-100123, "Dogs & Cats <b>")
    chats.update_chat(-100123, log_chat_id=999)
    billing.start_grace(-100123)
    bot = FakeBot()
    await notices.maybe_notify(bot, chat=chats.get_chat(-100123),
                               row=billing.get(-100123),
                               entitlement=ent("grace"), observing=False)
    assert len(bot.sent) == 1, "the notice was not sent at all"
    body = bot.sent[0][1]
    assert "Dogs &amp; Cats &lt;b&gt;" in body
    assert "Dogs & Cats" not in body, "raw ampersand left in an HTML send"
    assert billing.get(-100123).notified_stage == notices.STAGE_GRACE
