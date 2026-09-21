import json
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


def test_create_and_resolve_review():
    from storage import reviews
    rid = reviews.create(-100, 42, 555, "buy crypto now", json.dumps({"is_spam": 0.99}), 0.93)
    reviews.resolve(rid, "delete_ban", decided_by=777)
    row = reviews.get(rid)
    assert row["decision"] == "delete_ban"
    assert row["decided_by"] == 777
    assert row["decided_at"] is not None


def test_purge_clears_text_but_keeps_the_label():
    from storage import db, reviews
    rid = reviews.create(-100, 42, 555, "buy crypto now", json.dumps({}), 0.93)
    reviews.resolve(rid, "not_spam", decided_by=777)
    db.connect().execute(
        "UPDATE reviews SET expires_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (rid,)
    )
    db.connect().commit()

    assert reviews.purge_expired() == 1
    row = reviews.get(rid)
    assert row["text"] is None, "expired text must be cleared"
    assert row["decision"] == "not_spam", "the human label is the corpus, keep it"
    assert row["verdict_json"] != "", "verdict is kept for threshold tuning"


def test_audit_never_stores_text():
    from storage import audit, db
    audit.record(-100, 555, 42, 0.93, "deleted", "high_confidence_spam", model="jev-1.13.0")
    row = audit.recent(-100)[0]
    columns = {description[0] for description in
               db.connect().execute("SELECT * FROM audit").description}
    assert "text" not in columns
    assert row["action"] == "deleted"
    assert row["reason"] == "high_confidence_spam"


def expire(rid: int) -> None:
    from storage import db
    db.connect().execute(
        "UPDATE reviews SET expires_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (rid,))
    db.connect().commit()


def test_storing_new_text_erases_text_that_has_expired():
    """The 7-day erasure must not depend on one unsupervised background task.
    bot.py's housekeeping loop is not awaited and is not restarted when it
    dies from something its sqlite3.Error guard does not catch, while the bot
    keeps running and keeps storing message text.

    Production edit this catches: removing the _purge_on_the_way_past() call
    from create(). The old row's text then survives until the hourly loop
    happens to run - or forever, if it has died.
    """
    from storage import reviews
    old = reviews.create(-100, 42, 555, "buy crypto now", json.dumps({}), 0.93)
    expire(old)

    fresh = reviews.create(-100, 43, 556, "and again", json.dumps({}), 0.93)

    assert reviews.get(old)["text"] is None, "expired text goes when new text arrives"
    assert reviews.get(fresh)["text"] == "and again", "unexpired text is untouched"


def test_a_failed_purge_does_not_lose_the_review_being_created():
    """The purge is opportunistic, not a precondition: a card must still get
    a row (and therefore working buttons) when the purge cannot run.

    Production edit this catches: removing the try/except sqlite3.Error in
    _purge_on_the_way_past, which turns a transient storage hiccup during
    the purge into a lost review row and a card with no buttons.
    """
    import sqlite3

    from storage import reviews

    def boom():
        raise sqlite3.Error("database is locked")

    original = reviews.purge_expired
    reviews.purge_expired = boom
    try:
        rid = reviews.create(-100, 44, 557, "still stored", json.dumps({}), 0.93)
    finally:
        reviews.purge_expired = original
    assert reviews.get(rid)["text"] == "still stored"


def test_the_purge_guard_is_narrow():
    """Only sqlite3.Error is a storage failure worth absorbing here; anything
    else is a programming error and must still surface, per this project's
    narrow-exception-handling contract.
    """
    from storage import reviews

    def boom():
        raise ValueError("not a storage error")

    original = reviews.purge_expired
    reviews.purge_expired = boom
    try:
        with pytest.raises(ValueError):
            reviews.create(-100, 45, 558, "text", json.dumps({}), 0.93)
    finally:
        reviews.purge_expired = original
