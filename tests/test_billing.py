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


# --- the billing row ---

def test_an_unknown_chat_reads_as_an_empty_row_not_none():
    """Callers on the moderation path must not have to branch on None."""
    from storage import billing
    row = billing.get(-100999)
    assert row.chat_id == -100999
    assert row.member_count is None
    assert row.paid_until is None
    assert row.grace_until is None
    assert row.notified_stage is None


def test_empty_is_what_a_caller_falls_back_to_when_the_read_fails():
    from storage import billing
    assert billing.empty(-100123) == billing.get(-100123)


def test_member_count_round_trips():
    from storage import billing
    billing.set_member_count(-100123, 640)
    row = billing.get(-100123)
    assert row.member_count == 640
    assert row.member_count_at is not None


def test_member_count_updates_in_place():
    from storage import billing
    billing.set_member_count(-100123, 640)
    billing.set_member_count(-100123, 1200)
    assert billing.get(-100123).member_count == 1200


# --- grace is written once, ever ---

def test_start_grace_writes_a_future_timestamp():
    from datetime import datetime, timezone
    from storage import billing
    value = billing.start_grace(-100123)
    assert datetime.fromisoformat(value) > datetime.now(timezone.utc)
    assert billing.get(-100123).grace_until == value


def test_start_grace_never_overwrites_an_existing_window():
    """A group oscillating around 200 members must not farm free trials."""
    from storage import billing
    first = billing.start_grace(-100123)
    second = billing.start_grace(-100123)
    assert second == first
    assert billing.get(-100123).grace_until == first


def test_start_grace_preserves_a_member_count_already_recorded():
    from storage import billing
    billing.set_member_count(-100123, 640)
    billing.start_grace(-100123)
    assert billing.get(-100123).member_count == 640


# --- the ledger ---

def test_recording_a_payment_credits_the_chat_and_returns_true():
    from storage import billing
    assert billing.record_payment(
        charge_id="ch_1", chat_id=-100123, payer_user_id=7, stars=50,
        is_recurring=False, expires_at="2026-10-21T12:00:00+00:00") is True
    row = billing.get(-100123)
    assert row.paid_until == "2026-10-21T12:00:00+00:00"
    assert row.payer_user_id == 7
    assert row.stars == 50
    assert row.charge_id == "ch_1"


def test_a_redelivered_payment_is_ignored_and_grants_nothing():
    """Telegram can redeliver an update. Without this guard one payment would
    grant sixty days."""
    from storage import billing
    billing.record_payment(charge_id="ch_1", chat_id=-100123, payer_user_id=7,
                           stars=50, is_recurring=False,
                           expires_at="2026-10-21T12:00:00+00:00")
    assert billing.record_payment(
        charge_id="ch_1", chat_id=-100123, payer_user_id=7, stars=50,
        is_recurring=False, expires_at="2026-11-21T12:00:00+00:00") is False
    assert billing.get(-100123).paid_until == "2026-10-21T12:00:00+00:00"


def test_a_renewal_has_its_own_charge_id_and_extends_the_subscription():
    from storage import billing
    billing.record_payment(charge_id="ch_1", chat_id=-100123, payer_user_id=7,
                           stars=50, is_recurring=False,
                           expires_at="2026-10-21T12:00:00+00:00")
    assert billing.record_payment(
        charge_id="ch_2", chat_id=-100123, payer_user_id=7, stars=50,
        is_recurring=True, expires_at="2026-11-21T12:00:00+00:00") is True
    assert billing.get(-100123).paid_until == "2026-11-21T12:00:00+00:00"


def test_every_payment_lands_in_the_ledger():
    from storage import billing, db
    billing.record_payment(charge_id="ch_1", chat_id=-100123, payer_user_id=7,
                           stars=50, is_recurring=False, expires_at="2026-10-21T12:00:00+00:00")
    billing.record_payment(charge_id="ch_2", chat_id=-100123, payer_user_id=7,
                           stars=50, is_recurring=True, expires_at="2026-11-21T12:00:00+00:00")
    rows = db.connect().execute(
        "SELECT telegram_payment_charge_id, is_recurring FROM payments "
        "WHERE chat_id = ? ORDER BY created_at, telegram_payment_charge_id", (-100123,)
    ).fetchall()
    assert [r["telegram_payment_charge_id"] for r in rows] == ["ch_1", "ch_2"]
    assert [r["is_recurring"] for r in rows] == [0, 1]


def test_paying_does_not_consume_the_grace_window():
    """Grace is set once, ever - a payment must not clear it, or cancelling
    would hand back a second free trial."""
    from storage import billing
    grace = billing.start_grace(-100123)
    billing.record_payment(charge_id="ch_1", chat_id=-100123, payer_user_id=7,
                           stars=50, is_recurring=False, expires_at="2026-10-21T12:00:00+00:00")
    assert billing.get(-100123).grace_until == grace


def test_a_payment_for_a_chat_the_bot_has_never_seen_is_still_recorded():
    """Money moved. The record is not optional."""
    from storage import billing
    assert billing.record_payment(
        charge_id="ch_9", chat_id=-100777, payer_user_id=7, stars=250,
        is_recurring=False, expires_at="2026-10-21T12:00:00+00:00") is True
    assert billing.get(-100777).paid_until == "2026-10-21T12:00:00+00:00"


# --- notice stages ---

def test_notified_stage_round_trips():
    from storage import billing
    billing.set_notified_stage(-100123, "grace")
    assert billing.get(-100123).notified_stage == "grace"


def test_a_payment_clears_the_notice_stage_so_a_later_lapse_is_announced():
    from storage import billing
    billing.set_notified_stage(-100123, "lapsed")
    billing.record_payment(charge_id="ch_1", chat_id=-100123, payer_user_id=7,
                           stars=50, is_recurring=False, expires_at="2026-10-21T12:00:00+00:00")
    assert billing.get(-100123).notified_stage is None
