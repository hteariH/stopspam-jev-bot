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


def _columns(table: str) -> set[str]:
    from storage import db
    rows = db.connect().execute(f"PRAGMA table_info({table})").fetchall()
    return {row["name"] for row in rows}


def test_billing_table_has_every_column_the_design_names():
    assert _columns("billing") == {
        "chat_id", "member_count", "member_count_at", "grace_until", "paid_until",
        "payer_user_id", "stars", "charge_id", "notified_stage", "updated_at",
    }


def test_payments_table_has_every_column_the_design_names():
    assert _columns("payments") == {
        "telegram_payment_charge_id", "chat_id", "payer_user_id", "stars",
        "is_recurring", "expires_at", "created_at",
    }


def test_charge_id_is_the_payments_primary_key():
    """Idempotency against redelivered updates rests on this, not on a UNIQUE
    index added later, so it is asserted directly."""
    from storage import db
    info = db.connect().execute("PRAGMA table_info(payments)").fetchall()
    primary = [row["name"] for row in info if row["pk"]]
    assert primary == ["telegram_payment_charge_id"]


def test_tier_constants_match_the_spec():
    import config
    assert config.FREE_MEMBER_LIMIT == 200
    assert config.SMALL_MEMBER_LIMIT == 1000
    assert config.PRICE_SMALL_STARS == 50
    assert config.PRICE_LARGE_STARS == 250
    assert config.GRACE_DAYS == 14
    assert config.GRACE_WARN_DAYS == 3
    assert config.MEMBER_COUNT_TTL_HOURS == 24


def test_subscription_period_is_the_only_value_the_bot_api_accepts():
    import config
    assert config.SUBSCRIPTION_PERIOD == 2592000
