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
