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


def test_unknown_user_returns_default_row():
    from storage import trust
    row = trust.get(-100, 555)
    assert row.status == "unknown"
    assert row.clean_count == 0


def test_promotes_to_trusted_after_threshold():
    from storage import trust
    trust.seen(-100, 555)
    for _ in range(4):
        row = trust.record_clean(-100, 555, trust_after=5)
        assert row.status == "unknown"
    row = trust.record_clean(-100, 555, trust_after=5)
    assert row.status == "trusted"
    assert row.clean_count == 5


def test_flagged_user_is_never_promoted():
    from storage import trust
    trust.seen(-100, 555)
    trust.mark_flagged(-100, 555)
    for _ in range(10):
        row = trust.record_clean(-100, 555, trust_after=5)
    assert row.status == "flagged", "a flagged user must stay checked forever"


def test_allowlisted_user_is_never_demoted():
    from storage import trust
    trust.seen(-100, 555)
    trust.allowlist(-100, 555)
    row = trust.mark_flagged(-100, 555)
    assert row.status == "allowlisted"


def test_trust_is_per_chat():
    from storage import trust
    trust.seen(-100, 555)
    trust.allowlist(-100, 555)
    assert trust.get(-200, 555).status == "unknown"


def test_seen_returns_history_before_this_message():
    """Otherwise days_since_seen is always ~0 and the 30-day recheck is dead code."""
    from storage import db, trust
    trust.seen(-100, 555)
    db.connect().execute(
        "UPDATE trust SET last_seen_at = '2020-01-01T00:00:00+00:00' "
        "WHERE chat_id = -100 AND user_id = 555")
    db.connect().commit()

    prior = trust.seen(-100, 555)
    assert prior.last_seen_at == "2020-01-01T00:00:00+00:00"
    assert trust.days_since_seen(prior) > 365

    # ...and the stored row was still refreshed for next time.
    assert trust.get(-100, 555).last_seen_at != "2020-01-01T00:00:00+00:00"


def test_days_in_group_comes_from_joined_at():
    from storage import db, trust
    trust.seen(-100, 555)
    db.connect().execute(
        "UPDATE trust SET joined_at = '2020-01-01T00:00:00+00:00' "
        "WHERE chat_id = -100 AND user_id = 555")
    db.connect().commit()
    assert trust.days_in_group(trust.get(-100, 555)) > 365


def test_seen_after_allowlist_returns_prior_snapshot():
    """seen() must return pre-call state when row was created by allowlist before first seen."""
    from storage import db, trust

    # Pre-create a row via allowlist (not seen)
    trust.allowlist(-100, 555)
    old_timestamp = "2020-01-01T00:00:00+00:00"
    db.connect().execute(
        "UPDATE trust SET last_seen_at = ? WHERE chat_id = -100 AND user_id = 555",
        (old_timestamp,))
    db.connect().commit()

    # Call seen() - should return prior state with old timestamp, not refreshed one
    prior = trust.seen(-100, 555)
    assert prior.status == "allowlisted", "seen() must return prior status"
    assert prior.last_seen_at == old_timestamp, "seen() must return prior last_seen_at"

    # But the stored row was still refreshed for next time
    assert trust.get(-100, 555).last_seen_at != old_timestamp
