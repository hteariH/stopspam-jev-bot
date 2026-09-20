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


def test_ensure_chat_creates_with_spec_defaults():
    from storage import chats
    chat = chats.ensure_chat(-100123, "Test Group")
    assert chat.mode == "observe"
    assert chat.delete_threshold == 0.90
    assert chat.review_threshold == 0.55
    assert chat.confidence_floor == 0.75
    assert chat.trust_after == 5
    assert chat.lang == "en"
    assert chat.jev_enabled is True
    assert chat.observe_until is not None


def test_ensure_chat_is_idempotent_and_updates_title():
    from storage import chats
    chats.ensure_chat(-100123, "Old")
    chats.update_chat(-100123, delete_threshold=0.95)
    again = chats.ensure_chat(-100123, "New")
    assert again.title == "New"
    assert again.delete_threshold == 0.95, "ensure_chat must not reset settings"


def test_observation_window_expires():
    """Only an 'active' chat can leave observation, and only after the window."""
    from storage import chats
    chats.ensure_chat(-100123, "Test Group")
    chat = chats.update_chat(
        -100123, mode="active", observe_until="2020-01-01T00:00:00+00:00")
    assert chats.is_observing(chat) is False

    chat = chats.update_chat(-100123, observe_until="2999-01-01T00:00:00+00:00")
    assert chats.is_observing(chat) is True


def test_observe_mode_ignores_an_expired_window():
    from storage import chats
    chats.ensure_chat(-100123, "Test Group")
    chat = chats.update_chat(-100123, observe_until="2020-01-01T00:00:00+00:00")
    assert chats.is_observing(chat) is True, "mode 'observe' always observes"


def test_active_mode_still_observes_until_window_passes():
    """Mode 'active' does not shortcut the 7-day observation window."""
    from storage import chats
    chats.ensure_chat(-100123, "Test Group")
    chat = chats.update_chat(-100123, mode="active", observe_until="2999-01-01T00:00:00+00:00")
    assert chats.is_observing(chat) is True
