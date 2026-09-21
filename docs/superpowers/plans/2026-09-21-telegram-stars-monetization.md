# Telegram Stars Monetization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate automatic deletion behind a Telegram Stars subscription for groups over 200 members, leaving every other behaviour of the bot identical on every tier.

**Architecture:** Tier is a pure function of the group's Telegram member count, cached for 24 hours. Entitlement is a pure function of the tier and two timestamps. It enters the moderation path as one extra keyword argument to `policy.decide()`, producing a review card with reason `not_entitled` where a paid chat would have deleted. Payments are recurring 30-day Stars subscriptions; each `successful_payment` writes `paid_until` from Telegram's own `subscription_expiration_date`, so there is no renewal job and no expiry job.

**Tech Stack:** Python 3.13, aiogram 3.31, stdlib `sqlite3`, pytest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-telegram-stars-monetization-design.md`

## Global Constraints

Copied from the spec and from the moderation design it extends. Every task's requirements implicitly include this section.

- **Payment gates the action, never the judgment.** No task may change how a message is classified or scored.
- **A billing problem must never disarm moderation.** Every billing failure resolves toward *entitled*.
- Exception discipline, unchanged: catch `sqlite3.Error` for storage and `TelegramAPIError` for Telegram. **Never a bare `Exception`.** No unhandled exception may escape a handler.
- Storage calls that must not break the caller go through `guards.best_effort(log, what, chat_id, fn, *args, **kwargs)`, which returns the result or `None`.
- Every user-visible string lives in `texts.py` with **en, ru and uk**. An existing test fails the build if any language is missing.
- `storage/db.py` runs `executescript(SCHEMA)` with `CREATE TABLE IF NOT EXISTS` on every connect. **New tables are picked up automatically. No migration is to be written.**
- `payments` is append-only. Nothing deletes from it, nothing updates it.
- `subscription_period` must be exactly `2592000`. The Bot API accepts no other value.
- Tier prices: 0 / 50 / 250 stars. Member boundaries: `<= 200` free, `<= 1000` small, above that large.
- Tests must exercise the code they claim to cover. A test that passes against a deliberately broken implementation is a defect, not coverage.
- Run the suite with `./.venv/Scripts/python.exe -m pytest -q`.

### One deliberate deviation from the spec

The spec says `core/tiers.py` "imports dataclasses and datetime, nothing else". It also imports `config`, exactly as `core/gate.py` already does for `RECHECK_AFTER_DAYS`. Constants are not I/O, and one source of truth for tunables beats duplicating four numbers. The spec's *intent* — no network, no database, testable with an injected clock — is preserved in full.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `core/tiers.py` | Pure. Member count → tier → price, the `entitled()` predicate, the `Entitlement` value, staleness math. |
| `storage/billing.py` | sqlite only. The per-chat billing row and the append-only payments ledger. |
| `core/offer.py` | Creates a Stars invoice link. The only outbound half of payments. |
| `core/notices.py` | Which billing notice is due, and sending it. |
| `handlers/payments.py` | Inbound half: `pre_checkout_query` and `successful_payment`. |
| `tests/test_tiers.py`, `tests/test_billing.py`, `tests/test_offer.py`, `tests/test_notices.py`, `tests/test_payments_handler.py` | Their tests. |

**Modified**

`config.py`, `storage/db.py`, `core/policy.py`, `core/pipeline.py`, `core/cards.py`, `core/actions.py`, `handlers/group.py`, `handlers/admin.py`, `texts.py`, `bot.py`, `README.md`, and the existing tests whose call sites change.

### Call sites that WILL break, and where they are

Two signature changes ripple. They are listed here so no implementer discovers them by surprise:

- `policy.decide()` gains a required keyword `entitled`. Call sites: `core/pipeline.py:66`, and twelve calls in `tests/test_policy.py` which all route through one `ctx()` helper at `tests/test_policy.py:20` — **one line fixes all twelve**.
- `pipeline.evaluate()` gains a required keyword `entitlement`. Call sites: `handlers/group.py:189`, `tests/test_pipeline.py:50`, `tests/test_pipeline.py:80`.
- `cards.card_keyboard()` changes shape. Call sites: `core/actions.py:126`, `tests/test_cards.py:40`, `:64`, `:137`.

---

## Task 1: Config constants and schema

**Files:**
- Modify: `config.py:33` (append)
- Modify: `storage/db.py:9-69` (the `SCHEMA` string)
- Test: `tests/test_billing.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `config.FREE_MEMBER_LIMIT`, `config.SMALL_MEMBER_LIMIT`, `config.PRICE_SMALL_STARS`, `config.PRICE_LARGE_STARS`, `config.GRACE_DAYS`, `config.GRACE_WARN_DAYS`, `config.MEMBER_COUNT_TTL_HOURS`, `config.SUBSCRIPTION_PERIOD` — all `int`. Tables `billing` and `payments`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_billing.py`:

```python
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_billing.py -q`
Expected: FAIL — `sqlite3.OperationalError: no such table: billing` and `AttributeError: module 'config' has no attribute 'FREE_MEMBER_LIMIT'`.

- [ ] **Step 3: Add the constants**

Append to `config.py`:

```python

# Billing. Tier is a function of the group's Telegram member count; the API
# cost is not an input to the price (see the monetization design), so these
# are product decisions, not derived numbers.
FREE_MEMBER_LIMIT = _int("FREE_MEMBER_LIMIT", 200)
SMALL_MEMBER_LIMIT = _int("SMALL_MEMBER_LIMIT", 1000)
PRICE_SMALL_STARS = _int("PRICE_SMALL_STARS", 50)
PRICE_LARGE_STARS = _int("PRICE_LARGE_STARS", 250)

# The free trial of enforcement, and how long before it ends we say so.
GRACE_DAYS = _int("GRACE_DAYS", 14)
GRACE_WARN_DAYS = _int("GRACE_WARN_DAYS", 3)

# get_chat_member_count is an API call, so the answer is cached this long.
MEMBER_COUNT_TTL_HOURS = _int("MEMBER_COUNT_TTL_HOURS", 24)

# Not tunable: createInvoiceLink rejects every other value today.
SUBSCRIPTION_PERIOD = 2592000
```

- [ ] **Step 4: Add the tables**

In `storage/db.py`, insert into the `SCHEMA` string immediately after the `audit` table definition and before the `-- The trust primary key` comment:

```sql
-- Billing state per chat. Separate from `chats` so the moderation config and
-- the money stay independently readable, and so this table can be dropped
-- without touching a single moderation setting.
CREATE TABLE IF NOT EXISTS billing (
  chat_id         INTEGER PRIMARY KEY,
  member_count    INTEGER,
  member_count_at TEXT,
  grace_until     TEXT,
  paid_until      TEXT,
  payer_user_id   INTEGER,
  stars           INTEGER,
  charge_id       TEXT,
  notified_stage  TEXT,
  updated_at      TEXT    NOT NULL
);

-- Append-only. Telegram sends no "payment revoked" update, so this is the
-- only record that will exist when a charge is disputed or when
-- refundStarPayment has to be called by hand. Nothing deletes from it and
-- nothing updates it. The charge id is the primary key because that is what
-- makes a redelivered update harmless.
CREATE TABLE IF NOT EXISTS payments (
  telegram_payment_charge_id TEXT PRIMARY KEY,
  chat_id       INTEGER NOT NULL,
  payer_user_id INTEGER NOT NULL,
  stars         INTEGER NOT NULL,
  is_recurring  INTEGER NOT NULL DEFAULT 0,
  expires_at    TEXT,
  created_at    TEXT    NOT NULL
);
```

And add to the index block at the end of `SCHEMA`:

```sql
CREATE INDEX IF NOT EXISTS idx_payments_chat ON payments (chat_id, created_at);
```

- [ ] **Step 5: Run the whole suite**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Commit**

```bash
git add config.py storage/db.py tests/test_billing.py
git commit -m "Add billing constants and the billing and payments tables"
```

---

## Task 2: core/tiers.py — the pure tier and entitlement math

**Files:**
- Create: `core/tiers.py`
- Test: `tests/test_tiers.py` (create)

**Interfaces:**
- Consumes: `config` constants from Task 1.
- Produces:
  - `FREE = "free"`, `SMALL = "small"`, `LARGE = "large"`
  - `Entitlement` frozen dataclass with fields `tier: str`, `active: bool`, `reason: str`, `price: int`
  - `tier_for(member_count: int | None) -> str`
  - `price_for(tier: str) -> int`
  - `entitled(tier: str, *, paid_until: str | None, grace_until: str | None, now: datetime) -> tuple[bool, str]`
  - `build(tier: str, *, paid_until: str | None, grace_until: str | None, now: datetime) -> Entitlement`
  - `count_is_stale(member_count_at: str | None, *, now: datetime) -> bool`
  - `days_left(stamp: str | None, *, now: datetime) -> int`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_tiers.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from core import tiers

NOW = datetime(2026, 9, 21, 12, 0, 0, tzinfo=timezone.utc)


def stamp(**delta) -> str:
    return (NOW + timedelta(**delta)).isoformat(timespec="seconds")


# --- tier boundaries, exhaustively ---

@pytest.mark.parametrize("count,expected", [
    (0, tiers.FREE),
    (1, tiers.FREE),
    (200, tiers.FREE),
    (201, tiers.SMALL),
    (1000, tiers.SMALL),
    (1001, tiers.LARGE),
    (50_000, tiers.LARGE),
])
def test_tier_boundaries(count, expected):
    assert tiers.tier_for(count) == expected


def test_unknown_count_reads_as_free():
    """A billing lookup that never succeeded must not stop a group being
    moderated."""
    assert tiers.tier_for(None) == tiers.FREE


def test_prices_match_the_spec():
    assert tiers.price_for(tiers.FREE) == 0
    assert tiers.price_for(tiers.SMALL) == 50
    assert tiers.price_for(tiers.LARGE) == 250


# --- entitlement ---

def test_free_tier_is_always_entitled_even_with_nothing_paid():
    assert tiers.entitled(tiers.FREE, paid_until=None, grace_until=None,
                          now=NOW) == (True, "free_tier")


def test_paid_subscription_entitles():
    assert tiers.entitled(tiers.LARGE, paid_until=stamp(days=5),
                          grace_until=None, now=NOW) == (True, "subscribed")


def test_grace_entitles_when_nothing_is_paid():
    assert tiers.entitled(tiers.SMALL, paid_until=None,
                          grace_until=stamp(days=3), now=NOW) == (True, "grace")


def test_subscription_outranks_grace():
    active, reason = tiers.entitled(tiers.SMALL, paid_until=stamp(days=5),
                                    grace_until=stamp(days=3), now=NOW)
    assert (active, reason) == (True, "subscribed")


def test_expired_subscription_and_expired_grace_is_not_entitled():
    assert tiers.entitled(tiers.LARGE, paid_until=stamp(days=-1),
                          grace_until=stamp(days=-1), now=NOW) == (False, "not_entitled")


def test_paid_tier_with_nothing_at_all_is_not_entitled():
    assert tiers.entitled(tiers.SMALL, paid_until=None, grace_until=None,
                          now=NOW) == (False, "not_entitled")


def test_expiry_exactly_now_has_expired():
    """The boundary is strict: paid_until == now means the period is over."""
    assert tiers.entitled(tiers.SMALL, paid_until=NOW.isoformat(timespec="seconds"),
                          grace_until=None, now=NOW) == (False, "not_entitled")


def test_a_corrupt_timestamp_does_not_raise():
    """A malformed row is a bug to find in the log, not a crash in the
    moderation path. It reads as absent."""
    assert tiers.entitled(tiers.SMALL, paid_until="not-a-date",
                          grace_until=None, now=NOW) == (False, "not_entitled")


# --- Entitlement value ---

def test_build_carries_the_price_of_the_tier():
    ent = tiers.build(tiers.LARGE, paid_until=None, grace_until=None, now=NOW)
    assert (ent.tier, ent.active, ent.reason, ent.price) == (
        tiers.LARGE, False, "not_entitled", 250)


def test_build_on_free_tier_has_no_price_to_show():
    ent = tiers.build(tiers.FREE, paid_until=None, grace_until=None, now=NOW)
    assert (ent.active, ent.price) == (True, 0)


# --- staleness and countdown ---

def test_a_count_never_fetched_is_stale():
    assert tiers.count_is_stale(None, now=NOW) is True


def test_a_count_fetched_an_hour_ago_is_fresh():
    assert tiers.count_is_stale(stamp(hours=-1), now=NOW) is False


def test_a_count_fetched_two_days_ago_is_stale():
    assert tiers.count_is_stale(stamp(days=-2), now=NOW) is True


def test_a_corrupt_fetch_time_counts_as_stale():
    assert tiers.count_is_stale("not-a-date", now=NOW) is True


def test_days_left_rounds_up_so_a_partial_day_still_counts():
    assert tiers.days_left(stamp(hours=30), now=NOW) == 2


def test_days_left_is_zero_once_past():
    assert tiers.days_left(stamp(days=-1), now=NOW) == 0
    assert tiers.days_left(None, now=NOW) == 0
```

- [ ] **Step 2: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_tiers.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.tiers'`.

- [ ] **Step 3: Write `core/tiers.py`**

```python
"""Which tier a chat is in, and whether it may delete.

Pure: no aiogram, no network, no database, and the clock is a parameter. That
is what lets the two boundaries (200, 1000) and the grace window be tested
exhaustively rather than through a mock of Telegram.

``config`` is imported for the four tunables, exactly as core.gate imports it
for RECHECK_AFTER_DAYS. Reading a constant is not I/O.
"""
import math
from dataclasses import dataclass
from datetime import datetime, timedelta

import config

FREE = "free"
SMALL = "small"
LARGE = "large"


@dataclass(frozen=True)
class Entitlement:
    """What a chat is allowed to do about spam, and why.

    ``active`` is the only field the policy sees. The rest exist so the log
    line, the menu and the review card can explain themselves.
    """

    tier: str
    active: bool
    reason: str
    price: int


def tier_for(member_count: int | None) -> str:
    """Which tier a group of this size is in.

    An unknown count reads as the free tier, deliberately. A chat whose count
    has never been fetched is brand new, which means it is inside its 7-day
    observation window and deleting nothing regardless; and if the lookup is
    failing for some other reason, a billing problem must not be what stops a
    group from being moderated.
    """
    if member_count is None or member_count <= config.FREE_MEMBER_LIMIT:
        return FREE
    if member_count <= config.SMALL_MEMBER_LIMIT:
        return SMALL
    return LARGE


def price_for(tier: str) -> int:
    """Stars per 30 days. Zero means there is nothing to sell."""
    return {
        FREE: 0,
        SMALL: config.PRICE_SMALL_STARS,
        LARGE: config.PRICE_LARGE_STARS,
    }.get(tier, 0)


def _parse(stamp: str | None) -> datetime | None:
    """A timestamp from our own database, or None if it is missing or bent.

    A malformed value is a bug worth finding, but the moderation path is not
    where it should surface as a crash, so it reads as absent.
    """
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(stamp)
    except ValueError:
        return None


def entitled(tier: str, *, paid_until: str | None, grace_until: str | None,
             now: datetime) -> tuple[bool, str]:
    """May this chat have spam deleted automatically, and on what grounds?

    The reason string reaches the audit row and the review card, so the order
    here is the order an admin is told about: being on the free tier beats
    having paid, and having paid beats being in the trial.
    """
    if tier == FREE:
        return True, "free_tier"
    expiry = _parse(paid_until)
    if expiry is not None and expiry > now:
        return True, "subscribed"
    grace = _parse(grace_until)
    if grace is not None and grace > now:
        return True, "grace"
    return False, "not_entitled"


def build(tier: str, *, paid_until: str | None, grace_until: str | None,
          now: datetime) -> Entitlement:
    active, reason = entitled(tier, paid_until=paid_until,
                              grace_until=grace_until, now=now)
    return Entitlement(tier=tier, active=active, reason=reason,
                       price=price_for(tier))


def count_is_stale(member_count_at: str | None, *, now: datetime) -> bool:
    """True when the cached member count is old enough to refetch.

    Never fetched, or fetched at a time we can no longer read, both count as
    stale: the cost of an extra API call once is far below the cost of a chat
    stuck on a count that can never be refreshed.
    """
    fetched = _parse(member_count_at)
    if fetched is None:
        return True
    return now - fetched >= timedelta(hours=config.MEMBER_COUNT_TTL_HOURS)


def days_left(stamp: str | None, *, now: datetime) -> int:
    """Whole days remaining, rounded up, never negative.

    Rounded up because "1 day left" is the honest thing to tell someone with
    eleven hours: rounding down would say zero while the trial still worked.
    """
    when = _parse(stamp)
    if when is None or when <= now:
        return 0
    return math.ceil((when - now).total_seconds() / 86400)
```

- [ ] **Step 4: Run the tests**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_tiers.py -q`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add core/tiers.py tests/test_tiers.py
git commit -m "Add the pure tier and entitlement arithmetic"
```

---

## Task 3: storage/billing.py — the billing row and the ledger

**Files:**
- Create: `storage/billing.py`
- Test: `tests/test_billing.py` (append to the file created in Task 1)

**Interfaces:**
- Consumes: the `billing` and `payments` tables from Task 1.
- Produces:
  - `BillingRow` frozen dataclass: `chat_id: int`, `member_count: int | None`, `member_count_at: str | None`, `grace_until: str | None`, `paid_until: str | None`, `payer_user_id: int | None`, `stars: int | None`, `charge_id: str | None`, `notified_stage: str | None`
  - `get(chat_id: int) -> BillingRow` — an all-`None` row when absent, never `None` itself
  - `set_member_count(chat_id: int, count: int) -> None`
  - `start_grace(chat_id: int) -> str` — returns the `grace_until` in force, writing it only if absent
  - `record_payment(*, charge_id: str, chat_id: int, payer_user_id: int, stars: int, is_recurring: bool, expires_at: str) -> bool` — `False` when the charge id was already recorded
  - `set_notified_stage(chat_id: int, stage: str) -> None`
  - `empty(chat_id: int) -> BillingRow` — an all-`None` row, for callers whose `get` failed

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_billing.py`:

```python
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_billing.py -q`
Expected: FAIL — `ImportError: cannot import name 'billing' from 'storage'`.

- [ ] **Step 3: Write `storage/billing.py`**

```python
"""Billing state per chat, and the append-only ledger of Stars payments.

Kept apart from storage.chats on purpose: the moderation settings and the
money are read by different code for different reasons, and this table can be
dropped without touching a single moderation setting.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import config
from storage import db

_FIELDS = ("member_count", "member_count_at", "grace_until", "paid_until",
           "payer_user_id", "stars", "charge_id", "notified_stage")


@dataclass(frozen=True)
class BillingRow:
    chat_id: int
    member_count: int | None
    member_count_at: str | None
    grace_until: str | None
    paid_until: str | None
    payer_user_id: int | None
    stars: int | None
    charge_id: str | None
    notified_stage: str | None


def get(chat_id: int) -> BillingRow:
    """This chat's billing state, or an empty one.

    Returns a row rather than None so the moderation path never has to branch
    on absence: a chat nobody has ever paid for and a chat with no row are the
    same thing to every caller.
    """
    row = db.connect().execute(
        "SELECT * FROM billing WHERE chat_id = ?", (chat_id,)
    ).fetchone()
    if row is None:
        return empty(chat_id)
    return BillingRow(chat_id, *(row[name] for name in _FIELDS))


def empty(chat_id: int) -> BillingRow:
    """An all-None row, for a caller whose read failed.

    Exists so no caller has to spell out how many None fields BillingRow has -
    a count that would silently rot the next time a column is added.
    """
    return BillingRow(chat_id, *(None for _ in _FIELDS))


def set_member_count(chat_id: int, count: int) -> None:
    conn = db.connect()
    stamp = db.now()
    conn.execute(
        """INSERT INTO billing (chat_id, member_count, member_count_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (chat_id) DO UPDATE SET
             member_count    = excluded.member_count,
             member_count_at = excluded.member_count_at,
             updated_at      = excluded.updated_at""",
        (chat_id, count, stamp, stamp),
    )
    conn.commit()


def start_grace(chat_id: int) -> str:
    """Opens the free trial of enforcement, once and once only.

    The COALESCE is the whole point: a second call returns the window already
    in force rather than a fresh one, so a group crossing 200 members back and
    forth cannot farm an unbounded series of free trials. It is done in SQL
    rather than read-then-write so two concurrent messages cannot both decide
    the column is empty.
    """
    conn = db.connect()
    stamp = db.now()
    proposed = (datetime.now(timezone.utc)
                + timedelta(days=config.GRACE_DAYS)).isoformat(timespec="seconds")
    conn.execute(
        """INSERT INTO billing (chat_id, grace_until, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (chat_id) DO UPDATE SET
             grace_until = COALESCE(billing.grace_until, excluded.grace_until),
             updated_at  = excluded.updated_at""",
        (chat_id, proposed, stamp),
    )
    conn.commit()
    return get(chat_id).grace_until


def record_payment(*, charge_id: str, chat_id: int, payer_user_id: int, stars: int,
                   is_recurring: bool, expires_at: str) -> bool:
    """Records one Stars payment and credits the chat.

    Returns False when this charge id has already been seen, in which case
    nothing at all is written: Telegram can redeliver an update, and without
    this guard one payment would grant sixty days.

    The ledger row is written first and is never rolled back, because the
    ledger is the only place a disputed charge can be looked up later.
    """
    conn = db.connect()
    stamp = db.now()
    cursor = conn.execute(
        """INSERT OR IGNORE INTO payments (telegram_payment_charge_id, chat_id,
                                           payer_user_id, stars, is_recurring,
                                           expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (charge_id, chat_id, payer_user_id, stars, int(is_recurring), expires_at, stamp),
    )
    if cursor.rowcount == 0:
        conn.commit()
        return False

    # grace_until is deliberately absent from the update list. It is set once,
    # ever - clearing it here would hand back a second free trial to anyone who
    # paid for one month and cancelled.
    conn.execute(
        """INSERT INTO billing (chat_id, paid_until, payer_user_id, stars,
                                charge_id, notified_stage, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT (chat_id) DO UPDATE SET
             paid_until     = excluded.paid_until,
             payer_user_id  = excluded.payer_user_id,
             stars          = excluded.stars,
             charge_id      = excluded.charge_id,
             notified_stage = NULL,
             updated_at     = excluded.updated_at""",
        (chat_id, expires_at, payer_user_id, stars, charge_id, stamp),
    )
    conn.commit()
    return True


def set_notified_stage(chat_id: int, stage: str) -> None:
    conn = db.connect()
    stamp = db.now()
    conn.execute(
        """INSERT INTO billing (chat_id, notified_stage, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (chat_id) DO UPDATE SET
             notified_stage = excluded.notified_stage,
             updated_at     = excluded.updated_at""",
        (chat_id, stage, stamp),
    )
    conn.commit()
```

- [ ] **Step 4: Run the tests**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_billing.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add storage/billing.py tests/test_billing.py
git commit -m "Add billing storage with a set-once grace window and an idempotent ledger"
```

---

## Task 4: texts.py — every new string in en, ru and uk

**Files:**
- Modify: `texts.py` (add keys to `STRINGS`)
- Test: the existing language-completeness test covers these automatically; add two length guards.

**Interfaces:**
- Consumes: nothing.
- Produces: the keys below, usable as `t(key, lang, **kwargs)`.

**Why this comes before the UI tasks:** Tasks 6 through 10 all render these keys. Adding them first means no task has to invent a key name and no two tasks invent different ones.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_cards.py`:

```python
def test_invoice_title_fits_telegrams_32_character_limit_in_every_language():
    """createInvoiceLink rejects a title over 32 characters outright, which
    would make the product unbuyable in that language only - exactly the kind
    of failure nobody notices until a Ukrainian admin tries to pay."""
    from texts import t
    for lang in ("en", "ru", "uk"):
        assert 1 <= len(t("invoice_title", lang)) <= 32, lang


def test_every_new_billing_key_exists_in_every_language():
    from texts import STRINGS
    keys = [
        "card_not_entitled", "btn_subscribe", "menu_billing", "billing_free",
        "billing_subscribed", "billing_grace", "billing_none",
        "btn_start_deleting", "invoice_title", "invoice_description",
        "invoice_label", "pay_thanks", "pay_cancel_hint", "pay_rejected",
        "pay_unrecorded", "invoice_unavailable", "notice_grace",
        "notice_grace_ending", "notice_lapsed",
    ]
    for key in keys:
        assert key in STRINGS, key
        assert set(STRINGS[key]) == {"en", "ru", "uk"}, key
        assert all(STRINGS[key][lang].strip() for lang in ("en", "ru", "uk")), key
```

- [ ] **Step 2: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_cards.py -q`
Expected: FAIL — `assert 'card_not_entitled' in STRINGS`.

- [ ] **Step 3: Add the keys**

Add these entries to the `STRINGS` dict in `texts.py`, following the file's existing formatting. Placeholders in braces are formatted by `t()`; a key with no placeholder must contain no braces.

```python
    "card_not_entitled": {
        "en": "I would have deleted this, but this group has no subscription.",
        "ru": "Я бы это удалил, но у группы нет подписки.",
        "uk": "Я б це видалив, але в групи немає підписки.",
    },
    "btn_subscribe": {
        "en": "Subscribe — {stars} ⭐/month",
        "ru": "Подписка — {stars} ⭐/мес",
        "uk": "Підписка — {stars} ⭐/міс",
    },
    "menu_billing": {"en": "Plan", "ru": "Тариф", "uk": "Тариф"},
    "billing_free": {
        "en": "free ({count} members, under {limit})",
        "ru": "бесплатный ({count} участников, до {limit})",
        "uk": "безкоштовний ({count} учасників, до {limit})",
    },
    "billing_subscribed": {
        "en": "paid, {days} days left",
        "ru": "оплачено, осталось дней: {days}",
        "uk": "оплачено, залишилось днів: {days}",
    },
    "billing_grace": {
        "en": "free trial, {days} days left",
        "ru": "пробный период, осталось дней: {days}",
        "uk": "пробний період, залишилось днів: {days}",
    },
    "billing_none": {
        "en": "no subscription — I report spam but do not delete it",
        "ru": "нет подписки — спам показываю, но не удаляю",
        "uk": "немає підписки — спам показую, але не видаляю",
    },
    "btn_start_deleting": {
        "en": "Seen enough — start deleting",
        "ru": "Хватит наблюдать — начать удалять",
        "uk": "Досить спостерігати — почати видаляти",
    },
    "invoice_title": {
        "en": "StopSpam: auto-delete",
        "ru": "StopSpam: автоудаление",
        "uk": "StopSpam: автовидалення",
    },
    "invoice_description": {
        "en": "Automatic deletion of spam and scam in {title}. "
              "{stars} ⭐ every 30 days, cancel any time.",
        "ru": "Автоматическое удаление спама и скама в {title}. "
              "{stars} ⭐ каждые 30 дней, можно отменить в любой момент.",
        "uk": "Автоматичне видалення спаму й шахрайства в {title}. "
              "{stars} ⭐ кожні 30 днів, скасувати можна будь-коли.",
    },
    "invoice_label": {
        "en": "30 days", "ru": "30 дней", "uk": "30 днів",
    },
    "pay_thanks": {
        "en": "Payment received. I will delete spam in {title} automatically "
              "for the next {days} days, and the subscription renews by itself.",
        "ru": "Оплата получена. Ближайшие {days} дней я буду удалять спам "
              "в {title} автоматически, подписка продлевается сама.",
        "uk": "Оплату отримано. Найближчі {days} днів я видалятиму спам "
              "у {title} автоматично, підписка подовжується сама.",
    },
    "pay_cancel_hint": {
        "en": "You can cancel it in Telegram: Settings → My Stars → Subscriptions.",
        "ru": "Отменить можно в Telegram: Настройки → Мои звёзды → Подписки.",
        "uk": "Скасувати можна в Telegram: Налаштування → Мої зірки → Підписки.",
    },
    "pay_rejected": {
        "en": "I could not recognise this invoice, so nothing was charged. "
              "Please open the subscription button in /chats again.",
        "ru": "Я не распознал этот счёт, деньги не списаны. "
              "Откройте кнопку подписки в /chats ещё раз.",
        "uk": "Я не розпізнав цей рахунок, гроші не списано. "
              "Відкрийте кнопку підписки в /chats ще раз.",
    },
    "pay_unrecorded": {
        "en": "Your payment went through, but I could not record it. "
              "Nothing is lost — contact the bot's author with this message.",
        "ru": "Оплата прошла, но я не смог её записать. "
              "Ничего не потеряно — напишите автору бота, показав это сообщение.",
        "uk": "Оплата пройшла, але я не зміг її записати. "
              "Нічого не втрачено — напишіть автору бота, показавши це повідомлення.",
    },
    "invoice_unavailable": {
        "en": "Telegram would not give me a payment link just now. Try again in a minute.",
        "ru": "Telegram сейчас не выдал ссылку на оплату. Попробуйте через минуту.",
        "uk": "Telegram зараз не видав посилання на оплату. Спробуйте за хвилину.",
    },
    "notice_grace": {
        "en": "{title} has grown past {limit} members, so automatic deletion now "
              "needs a subscription. It keeps working free for {days} more days.",
        "ru": "В {title} стало больше {limit} участников, поэтому автоудаление "
              "теперь требует подписки. Ещё {days} дней оно работает бесплатно.",
        "uk": "У {title} стало більше {limit} учасників, тому автовидалення "
              "тепер потребує підписки. Ще {days} днів воно працює безкоштовно.",
    },
    "notice_grace_ending": {
        "en": "The free trial for {title} ends in {days} days. After that I will "
              "keep reporting spam, but I will stop deleting it.",
        "ru": "Пробный период для {title} заканчивается через {days} дней. "
              "Потом я продолжу показывать спам, но перестану его удалять.",
        "uk": "Пробний період для {title} завершується за {days} днів. "
              "Потім я й далі показуватиму спам, але перестану його видаляти.",
    },
    "notice_lapsed": {
        "en": "The subscription for {title} has ended. I am still checking every "
              "message and still sending you these cards — I am just not deleting "
              "anything until it is renewed.",
        "ru": "Подписка для {title} закончилась. Я по-прежнему проверяю каждое "
              "сообщение и присылаю карточки — просто ничего не удаляю, "
              "пока её не продлят.",
        "uk": "Підписка для {title} завершилася. Я й далі перевіряю кожне "
              "повідомлення та надсилаю картки — просто нічого не видаляю, "
              "доки її не подовжать.",
    },
```

- [ ] **Step 4: Run the whole suite**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS. The pre-existing completeness test now also covers the new keys.

- [ ] **Step 5: Commit**

```bash
git add texts.py tests/test_cards.py
git commit -m "Add billing copy in English, Russian and Ukrainian"
```

---

## Task 5: Entitlement reaches the decision

This is the core of the feature and the one change that cannot be half-done: `policy.decide()`, `pipeline.evaluate()` and `handlers/group.py` must move together or the suite is red in between.

**Files:**
- Modify: `core/policy.py:57-77`
- Modify: `core/pipeline.py:39-85`
- Modify: `handlers/group.py:1-30` (imports), and `:189` (the `evaluate` call)
- Modify: `tests/test_policy.py:20` (the `ctx` helper)
- Modify: `tests/test_pipeline.py:50`, `:80`
- Test: `tests/test_policy.py`, `tests/test_group_handler.py`

**Interfaces:**
- Consumes: `tiers.Entitlement`, `tiers.build`, `tiers.tier_for`, `tiers.count_is_stale`, `tiers.FREE` (Task 2); `billing.get`, `billing.set_member_count`, `billing.start_grace` (Task 3).
- Produces:
  - `policy.REASON_NOT_ENTITLED = "not_entitled"`
  - `policy.decide(v, t, *, observing, can_delete, is_admin, is_allowlisted, entitled)`
  - `pipeline.evaluate(client, *, chat, facts, trust_row, is_admin, can_delete, entitlement)`
  - `handlers.group._entitlement(bot, chat) -> tuple[tiers.Entitlement, billing.BillingRow | None]` — the row comes back so Task 10 can decide on a notice without a second read; it is `None` only when storage failed
  - `pipeline.Outcome` gains `entitlement: tiers.Entitlement | None = None`

- [ ] **Step 1: Write the failing policy tests**

Append to `tests/test_policy.py`:

```python
def test_unentitled_chat_reviews_what_it_would_have_deleted():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(entitled=False))
    assert d.action == Action.REVIEW
    assert d.reason == "not_entitled"


def test_entitled_chat_still_deletes():
    assert decide(verdict(**SCAM), DEFAULTS, **ctx(entitled=True)).action == Action.DELETE


def test_observing_is_reported_ahead_of_not_entitled():
    """Inside the observation window nothing is deleted on any tier, so
    advertising a subscription there would be selling something the admin does
    not yet need."""
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(observing=True, entitled=False))
    assert d.reason == "observing"


def test_not_entitled_is_reported_ahead_of_missing_delete_rights():
    """Telling an admin to buy a subscription when the real problem is that
    they never gave the bot delete rights would be a lie - but so would the
    reverse, and the subscription is the one the bot can actually fix."""
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(entitled=False, can_delete=False))
    assert d.reason == "not_entitled"


def test_entitlement_never_promotes_a_grey_zone_message():
    """Payment buys enforcement of a verdict, never a harsher verdict."""
    grey = verdict(is_spam=0.7, severity=1, severity_confidence=0.5, looks_like_member=0.1)
    paid = decide(grey, DEFAULTS, **ctx(entitled=True))
    unpaid = decide(grey, DEFAULTS, **ctx(entitled=False))
    assert paid.action == unpaid.action == Action.REVIEW
    assert paid.reason == unpaid.reason == "grey_zone"


def test_entitlement_does_not_change_the_risk_score():
    paid = decide(verdict(**SCAM), DEFAULTS, **ctx(entitled=True))
    unpaid = decide(verdict(**SCAM), DEFAULTS, **ctx(entitled=False))
    assert paid.risk == unpaid.risk
```

Change the `ctx` helper at `tests/test_policy.py:20` — this one line fixes all twelve pre-existing calls:

```python
def ctx(**overrides):
    base = dict(observing=False, can_delete=True, is_admin=False,
                is_allowlisted=False, entitled=True)
    base.update(overrides)
    return base
```

- [ ] **Step 2: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_policy.py -q`
Expected: FAIL — `TypeError: decide() got an unexpected keyword argument 'entitled'`.

- [ ] **Step 3: Change `core/policy.py`**

Add a module constant just below `MEMBER_CEILING`:

```python
# The reason a confident deletion became a review card because the group has
# no subscription. Named because core.cards keys the subscribe button off it.
REASON_NOT_ENTITLED = "not_entitled"
```

Replace the signature and the `deletable` block:

```python
def decide(v: Verdict, t: Thresholds, *, observing: bool, can_delete: bool,
           is_admin: bool, is_allowlisted: bool, entitled: bool) -> Decision:
    if is_admin:
        return Decision(Action.IGNORE, 0.0, "admin")
    if is_allowlisted:
        return Decision(Action.IGNORE, 0.0, "allowlisted")

    risk = risk_score(v)

    deletable = (
        risk >= t.delete
        and v.severity >= 1
        and v.severity_confidence >= t.confidence_floor
        and v.looks_like_member <= MEMBER_CEILING
    )
    if deletable:
        if observing:
            return Decision(Action.REVIEW, risk, "observing")
        if not entitled:
            return Decision(Action.REVIEW, risk, REASON_NOT_ENTITLED)
        if not can_delete:
            return Decision(Action.REVIEW, risk, "no_delete_permission")
        return Decision(Action.DELETE, risk, "high_confidence_spam")

    if risk >= t.review:
        return Decision(Action.REVIEW, risk, "grey_zone")
    return Decision(Action.IGNORE, risk, "below_threshold")
```

Note that `entitled` is checked *inside* the `deletable` branch only. Billing cannot make an innocent message look guilty; it can only stop a guilty one being removed.

- [ ] **Step 4: Run the policy tests**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_policy.py -q`
Expected: PASS.

- [ ] **Step 5: Thread the entitlement through `core/pipeline.py`**

Add the import at the top:

```python
from core import gate, guards, policy, state, tiers
```

Change `evaluate`'s signature and its call to `policy.decide`:

```python
async def evaluate(client: JevClient, *, chat: ChatConfig, facts: MessageFacts,
                   trust_row: TrustRow, is_admin: bool, can_delete: bool,
                   entitlement: tiers.Entitlement) -> Outcome:
```

```python
    decision = policy.decide(
        verdict,
        Thresholds(chat.delete_threshold, chat.review_threshold, chat.confidence_floor),
        observing=chats.is_observing(chat),
        can_delete=can_delete,
        is_admin=False,
        is_allowlisted=trust_row.status == trust.ALLOWLISTED,
        entitled=entitlement.active,
    )
```

Update the two calls in `tests/test_pipeline.py` (lines 50 and 80) to pass an entitled value. Add this helper near the top of that file and pass `entitlement=ENTITLED` at both call sites:

```python
from core import tiers

ENTITLED = tiers.Entitlement(tier=tiers.FREE, active=True, reason="free_tier", price=0)
```

- [ ] **Step 6: Write the failing group-handler test**

Append to `tests/test_group_handler.py`, following that file's existing fixture style for building a fake bot and message:

```python
@pytest.mark.asyncio
async def test_entitlement_is_free_when_the_group_is_small():
    from handlers import group
    from storage import chats
    from core import tiers

    chat = chats.ensure_chat(-100123, "Small Group")
    bot = FakeBot(member_count=150)
    ent, _ = await group._entitlement(bot, chat)
    assert ent.tier == tiers.FREE
    assert ent.active is True


@pytest.mark.asyncio
async def test_a_large_unpaid_group_outside_observation_gets_grace_once():
    from handlers import group
    from storage import billing, chats
    from core import tiers

    chats.ensure_chat(-100123, "Big Group")
    chats.update_chat(-100123, mode="active", observe_until="2020-01-01T00:00:00+00:00")
    chat = chats.get_chat(-100123)

    bot = FakeBot(member_count=5000)
    first, _ = await group._entitlement(bot, chat)
    assert first.tier == tiers.LARGE
    assert (first.active, first.reason) == (True, "grace")

    opened = billing.get(-100123).grace_until
    second, _ = await group._entitlement(bot, chat)
    assert billing.get(-100123).grace_until == opened, "grace must be set once, ever"
    assert second.reason == "grace"


@pytest.mark.asyncio
async def test_grace_does_not_start_while_the_chat_is_still_observing():
    """Otherwise half the trial burns during a week when nothing is deleted
    anyway, and the admin evaluates a product they never saw working."""
    from handlers import group
    from storage import billing, chats

    chat = chats.ensure_chat(-100123, "Big New Group")  # observe_until is in the future
    bot = FakeBot(member_count=5000)
    ent, _ = await group._entitlement(bot, chat)
    assert billing.get(-100123).grace_until is None
    assert ent.active is False


@pytest.mark.asyncio
async def test_the_member_count_is_not_refetched_within_the_cache_window():
    from handlers import group
    from storage import chats

    chat = chats.ensure_chat(-100123, "Group")
    bot = FakeBot(member_count=150)
    await group._entitlement(bot, chat)
    await group._entitlement(bot, chat)
    assert bot.member_count_calls == 1


@pytest.mark.asyncio
async def test_a_failed_member_count_lookup_does_not_disarm_moderation():
    from handlers import group
    from storage import chats

    chat = chats.ensure_chat(-100123, "Group")
    bot = FakeBot(member_count_raises=TelegramAPIError(method=None, message="boom"))
    ent, _ = await group._entitlement(bot, chat)
    assert ent.active is True
```

Extend the test file's fake bot with `member_count`, `member_count_calls` and `member_count_raises`, implementing:

```python
    async def get_chat_member_count(self, chat_id):
        self.member_count_calls += 1
        if self.member_count_raises is not None:
            raise self.member_count_raises
        return self.member_count
```

- [ ] **Step 7: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_group_handler.py -q`
Expected: FAIL — `AttributeError: module 'handlers.group' has no attribute '_entitlement'`.

- [ ] **Step 8: Add `_entitlement` to `handlers/group.py`**

Add to the imports:

```python
from datetime import datetime, timezone

from core import actions, guards, pipeline, ratelimit, state, tiers
from storage import billing, chats, trust
```

Add these two functions immediately after `_can_delete`:

```python
async def _member_count(bot, chat_id: int, row) -> int | None:
    """The group's size, refetched at most once per cache window.

    A failed lookup returns the cached value, including None. That is the
    free tier, and it is the right way to fail: a billing lookup must never
    be what stops a group being moderated.
    """
    if not tiers.count_is_stale(row.member_count_at, now=datetime.now(timezone.utc)):
        return row.member_count
    try:
        count = await bot.get_chat_member_count(chat_id)
    except TelegramAPIError as exc:
        log.warning("member count lookup failed for chat %s: %s", chat_id, exc)
        return row.member_count
    guards.best_effort(log, "set_member_count", chat_id,
                       billing.set_member_count, chat_id, count)
    return count


async def _entitlement(bot, chat) -> tuple[tiers.Entitlement, billing.BillingRow | None]:
    """Whether this chat may have spam deleted automatically, and why.

    Returns the billing row alongside it so the caller can decide whether a
    notice is due without reading the same row twice. The row is None only
    when storage failed.

    Also the only place the free trial is opened. The trial starts on the
    first message where the tier requires payment *and* the chat is out of
    its observation window: starting it earlier would burn half the window
    during a week in which the bot deletes nothing anyway.
    """
    now = datetime.now(timezone.utc)
    row = guards.best_effort(log, "billing_get", chat.chat_id, billing.get, chat.chat_id)
    if row is None:
        # Storage failed. The verdict is unaffected; only the question of
        # permission failed, and a lost subscription beats a group silently
        # going unmoderated.
        return tiers.Entitlement(tier=tiers.FREE, active=True,
                                 reason="billing_unavailable", price=0), None

    tier = tiers.tier_for(await _member_count(bot, chat.chat_id, row))
    grace_until = row.grace_until
    if tier != tiers.FREE and grace_until is None and not chats.is_observing(chat):
        grace_until = guards.best_effort(log, "start_grace", chat.chat_id,
                                         billing.start_grace, chat.chat_id)

    return tiers.build(tier, paid_until=row.paid_until,
                       grace_until=grace_until, now=now), row
```

Add the entitlement to `Outcome` in `core/pipeline.py`, so the card in Task 8 can
name a price without re-deriving it:

```python
@dataclass(frozen=True)
class Outcome:
    decision: Decision | None
    verdict: Verdict | None
    facts: MessageFacts | None
    skipped: str | None
    entitlement: tiers.Entitlement | None = None
```

and return it from the success path:

```python
    return Outcome(decision, verdict, facts, None, entitlement)
```

Then change the `evaluate` call at the end of `on_group_message`:

```python
    outcome = await pipeline.evaluate(
        _client,
        chat=chat,
        facts=facts,
        trust_row=row,
        is_admin=is_admin,
        can_delete=can_delete,
        entitlement=entitlement,
    )
```

with the call hoisted just above it, because Task 10 needs the row:

```python
    entitlement, billing_row = await _entitlement(message.bot, chat)
```

- [ ] **Step 9: Run the whole suite**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS, every test.

- [ ] **Step 10: Commit**

```bash
git add core/policy.py core/pipeline.py handlers/group.py tests/
git commit -m "Gate automatic deletion on the chat's entitlement"
```

---

## Task 6: One log line per paid API call, naming its chat

**Files:**
- Modify: `core/pipeline.py`
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `tiers.Entitlement` (Task 2), `policy.REASON_NOT_ENTITLED` (Task 5).
- Produces: no new callable. Two log records on the `stopspam.pipeline` logger.

**Why this is its own task:** today `core/pipeline.py` logs only when Jev is *unavailable*, so successful spend — which is all of it — is invisible. Without this, "which chats are costing me money" can only be answered by querying the audit table.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_pipeline.py`:

```python
@pytest.mark.asyncio
async def test_every_successful_classification_logs_its_chat(caplog):
    caplog.set_level(logging.INFO, logger="stopspam.pipeline")
    await run_pipeline()  # the file's existing helper, which classifies one message
    lines = [r.getMessage() for r in caplog.records if "jev call" in r.getMessage()]
    assert len(lines) == 1
    assert "-100123" in lines[0]


@pytest.mark.asyncio
async def test_the_call_log_names_the_tier_so_free_spend_is_visible(caplog):
    caplog.set_level(logging.INFO, logger="stopspam.pipeline")
    await run_pipeline(entitlement=tiers.Entitlement(
        tier=tiers.LARGE, active=False, reason="not_entitled", price=250))
    line = next(r.getMessage() for r in caplog.records if "jev call" in r.getMessage())
    assert "tier=large" in line
    assert "entitled=no" in line


@pytest.mark.asyncio
async def test_withheld_enforcement_is_logged_with_its_chat(caplog):
    caplog.set_level(logging.INFO, logger="stopspam.pipeline")
    await run_pipeline(
        verdict=SCAM_VERDICT,
        entitlement=tiers.Entitlement(tier=tiers.LARGE, active=False,
                                      reason="not_entitled", price=250))
    assert any("enforcement withheld in chat -100123" in r.getMessage()
               for r in caplog.records)


@pytest.mark.asyncio
async def test_a_failed_call_still_produces_exactly_one_line_for_that_chat(caplog):
    """Every call to TypeSafe produces one line naming its chat, whether it
    succeeded or failed - otherwise spend cannot be counted from the log."""
    caplog.set_level(logging.INFO, logger="stopspam.pipeline")
    await run_pipeline(client=FailingClient())
    lines = [r.getMessage() for r in caplog.records if "-100123" in r.getMessage()]
    assert len(lines) == 1
    assert "jev unavailable" in lines[0]
```

Adapt `run_pipeline` to the helper already present in `tests/test_pipeline.py`, giving it optional `entitlement`, `verdict` and `client` arguments defaulting to the values the existing tests use.

- [ ] **Step 2: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_pipeline.py -q`
Expected: FAIL — `assert len(lines) == 1` with `lines == []`.

- [ ] **Step 3: Add the logging**

Add `import time` to the top of `core/pipeline.py`. Replace the classify block:

```python
    started = time.monotonic()
    try:
        verdict = await client.classify(state.build_state(facts))
    except JevError as exc:
        log.warning("jev unavailable for chat %s: %s", chat.chat_id, exc)
        reason = UNAVAILABLE_WITH_TRIGGER if gate.has_trigger(facts) else UNAVAILABLE
        _best_effort("audit", chat.chat_id, audit.record,
                     chat.chat_id, trust_row.user_id, None, None, "failed", reason)
        return Outcome(None, None, facts, reason)

    # One line per billable call, naming the chat that caused it. This is the
    # only record of successful spend outside the audit table, and it is what
    # makes "which chats are costing me money, and are any of them paying?"
    # answerable with grep.
    log.info("jev call for chat %s (user %s, %s, tier=%s, entitled=%s) took %d ms",
             chat.chat_id, trust_row.user_id, gated.reason, entitlement.tier,
             "yes" if entitlement.active else "no",
             (time.monotonic() - started) * 1000)
```

And after `decision` is computed, before the trust bookkeeping:

```python
    if decision.reason == policy.REASON_NOT_ENTITLED:
        log.info("enforcement withheld in chat %s: tier %s has no subscription "
                 "(risk %.2f)", chat.chat_id, entitlement.tier, decision.risk)
```

- [ ] **Step 4: Run the tests**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_pipeline.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/pipeline.py tests/test_pipeline.py
git commit -m "Log every classifier call with the chat that caused it"
```

---

## Task 7: core/offer.py and handlers/payments.py — buying and being paid

**Files:**
- Create: `core/offer.py`
- Create: `handlers/payments.py`
- Modify: `bot.py:33-40`
- Test: `tests/test_offer.py`, `tests/test_payments_handler.py` (create)

**Interfaces:**
- Consumes: `tiers.price_for`, `tiers.days_left` (Task 2); `billing.record_payment` (Task 3); the text keys from Task 4.
- Produces:
  - `offer.subscribe_link(bot, *, chat_id: int, title: str, stars: int, lang: str) -> str | None`
  - `offer.payload_for(chat_id: int, stars: int) -> str`
  - `payments.parse_payload(payload: str) -> tuple[int, int] | None`
  - `payments.router`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_offer.py`:

```python
import pytest

from core import offer


class FakeBot:
    def __init__(self, raises=None):
        self.raises = raises
        self.calls = []

    async def create_invoice_link(self, **kwargs):
        if self.raises is not None:
            raise self.raises
        self.calls.append(kwargs)
        return "https://t.me/invoice/abc"


@pytest.mark.asyncio
async def test_the_invoice_is_a_thirty_day_star_subscription():
    bot = FakeBot()
    await offer.subscribe_link(bot, chat_id=-100123, title="My Group",
                               stars=50, lang="en")
    call = bot.calls[0]
    assert call["currency"] == "XTR"
    assert call["subscription_period"] == 2592000
    assert [p.amount for p in call["prices"]] == [50]
    assert len(call["prices"]) == 1, "Stars invoices must carry exactly one price"


@pytest.mark.asyncio
async def test_the_payload_carries_the_chat_and_the_price():
    bot = FakeBot()
    await offer.subscribe_link(bot, chat_id=-100123, title="G", stars=250, lang="en")
    assert bot.calls[0]["payload"] == "sub:-100123:250"


@pytest.mark.asyncio
async def test_the_title_and_description_stay_inside_telegrams_limits():
    """Telegram rejects the whole call over these, which would make the
    product unbuyable rather than merely ugly."""
    bot = FakeBot()
    await offer.subscribe_link(bot, chat_id=-100123, title="G" * 4000,
                               stars=50, lang="ru")
    call = bot.calls[0]
    assert 1 <= len(call["title"]) <= 32
    assert 1 <= len(call["description"]) <= 255


@pytest.mark.asyncio
async def test_a_telegram_failure_returns_none_rather_than_raising():
    from aiogram.exceptions import TelegramAPIError
    bot = FakeBot(raises=TelegramAPIError(method=None, message="nope"))
    assert await offer.subscribe_link(bot, chat_id=-1, title="G",
                                      stars=50, lang="en") is None
```

Create `tests/test_payments_handler.py`, reusing the `fresh_db` fixture pattern from `tests/test_billing.py`:

```python
def test_a_well_formed_payload_parses():
    from handlers import payments
    assert payments.parse_payload("sub:-100123:50") == (-100123, 50)


@pytest.mark.parametrize("payload", [
    "", "sub", "sub:-100123", "sub:-100123:50:extra", "buy:-100123:50",
    "sub:notanumber:50", "sub:-100123:notanumber",
])
def test_malformed_payloads_are_refused(payload):
    from handlers import payments
    assert payments.parse_payload(payload) is None


def test_a_price_that_is_not_one_of_ours_is_refused():
    """The amount is the only thing standing between a crafted invoice and a
    subscription bought for one star."""
    from handlers import payments
    assert payments.parse_payload("sub:-100123:1") is None


def test_a_chat_id_outside_sqlites_integer_range_is_refused():
    from handlers import payments
    assert payments.parse_payload(f"sub:{2**63}:50") is None


@pytest.mark.asyncio
async def test_a_valid_payment_credits_the_chat_and_writes_the_ledger():
    from handlers import payments
    from storage import billing, chats
    chats.ensure_chat(-100123, "Group")
    query = FakeMessage(charge_id="ch_1", payload="sub:-100123:50",
                        user_id=7, expiration=1790000000)
    await payments.on_successful_payment(query)
    assert billing.get(-100123).paid_until is not None
    assert billing.get(-100123).stars == 50


@pytest.mark.asyncio
async def test_a_redelivered_payment_grants_nothing_and_stays_quiet():
    from handlers import payments
    from storage import billing, chats
    chats.ensure_chat(-100123, "Group")
    first = FakeMessage(charge_id="ch_1", payload="sub:-100123:50",
                        user_id=7, expiration=1790000000)
    await payments.on_successful_payment(first)
    paid = billing.get(-100123).paid_until

    second = FakeMessage(charge_id="ch_1", payload="sub:-100123:50",
                         user_id=7, expiration=1799999999)
    await payments.on_successful_payment(second)
    assert billing.get(-100123).paid_until == paid
    assert second.replies == [], "a redelivery must not thank the user twice"


@pytest.mark.asyncio
async def test_a_payment_for_an_unknown_chat_is_still_recorded():
    from handlers import payments
    from storage import billing
    message = FakeMessage(charge_id="ch_9", payload="sub:-100777:250",
                          user_id=7, expiration=1790000000)
    await payments.on_successful_payment(message)
    assert billing.get(-100777).paid_until is not None


@pytest.mark.asyncio
async def test_a_payment_with_no_expiry_still_grants_thirty_days():
    """subscription_expiration_date is optional in the Bot API; a missing one
    must not leave a paying customer with nothing."""
    from datetime import datetime, timezone
    from handlers import payments
    from storage import billing, chats
    chats.ensure_chat(-100123, "Group")
    await payments.on_successful_payment(
        FakeMessage(charge_id="ch_1", payload="sub:-100123:50",
                    user_id=7, expiration=None))
    paid = datetime.fromisoformat(billing.get(-100123).paid_until)
    assert (paid - datetime.now(timezone.utc)).days >= 29


@pytest.mark.asyncio
async def test_pre_checkout_accepts_a_valid_invoice():
    from handlers import payments
    query = FakePreCheckout(payload="sub:-100123:50", currency="XTR", amount=50)
    await payments.on_pre_checkout(query)
    assert query.answered_ok is True


@pytest.mark.asyncio
@pytest.mark.parametrize("payload,currency,amount", [
    ("garbage", "XTR", 50),
    ("sub:-100123:50", "USD", 50),
    ("sub:-100123:50", "XTR", 250),
])
async def test_pre_checkout_refuses_anything_that_does_not_add_up(
        payload, currency, amount):
    from handlers import payments
    query = FakePreCheckout(payload=payload, currency=currency, amount=amount)
    await payments.on_pre_checkout(query)
    assert query.answered_ok is False


@pytest.mark.asyncio
async def test_pre_checkout_is_always_answered_even_when_telegram_fails():
    """Telegram fails the payment if the query goes unanswered for ten
    seconds, so the handler must never raise on its way to answering."""
    from aiogram.exceptions import TelegramAPIError
    from handlers import payments
    query = FakePreCheckout(payload="sub:-100123:50", currency="XTR", amount=50,
                            raises=TelegramAPIError(method=None, message="boom"))
    await payments.on_pre_checkout(query)  # must not raise
```

Write `FakeMessage` and `FakePreCheckout` in the test file. `FakeMessage` needs `successful_payment` (with `telegram_payment_charge_id`, `invoice_payload`, `subscription_expiration_date`, `is_recurring`, `total_amount`, `currency`), `from_user.id`, a `replies` list, and an async `answer(text)` appending to it. `FakePreCheckout` needs `id`, `invoice_payload`, `currency`, `total_amount`, an `answered_ok` attribute and an async `answer(ok, error_message=None)` that records it or raises.

- [ ] **Step 2: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_offer.py tests/test_payments_handler.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.offer'`.

- [ ] **Step 3: Write `core/offer.py`**

```python
"""Creating a Stars invoice link. The outbound half of payments.

Separate from handlers.payments, which only receives updates, because three
callers need to *offer* a subscription - the settings menu, a review card, and
a lapse notice - and none of them should import a handler module to do it.
"""
import logging

from aiogram.exceptions import TelegramAPIError
from aiogram.types import LabeledPrice

import config
from texts import t

log = logging.getLogger("stopspam.offer")

# createInvoiceLink rejects anything longer, which would make the product
# unbuyable rather than merely untidy.
MAX_INVOICE_TITLE = 32
MAX_INVOICE_DESC = 255
# Leaves room for the rest of the description around it.
MAX_GROUP_NAME = 80


def payload_for(chat_id: int, stars: int) -> str:
    """What comes back to us in pre_checkout and successful_payment.

    Everything needed to credit the right chat the right amount, and nothing
    else: the payload is not shown to the user but it is round-tripped through
    their client, so it carries no names and no secrets.
    """
    return f"sub:{chat_id}:{stars}"


def _trim(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[:limit - 1] + "…"


async def subscribe_link(bot, *, chat_id: int, title: str, stars: int,
                         lang: str) -> str | None:
    """A 30-day recurring Stars subscription link, or None if Telegram refused.

    None rather than an exception because every caller is a menu, a card or a
    notice that must still render when Telegram is having a bad minute.
    """
    description = _trim(
        t("invoice_description", lang,
          title=_trim(title or str(chat_id), MAX_GROUP_NAME), stars=stars),
        MAX_INVOICE_DESC)
    try:
        return await bot.create_invoice_link(
            title=_trim(t("invoice_title", lang), MAX_INVOICE_TITLE),
            description=description,
            payload=payload_for(chat_id, stars),
            currency="XTR",
            prices=[LabeledPrice(label=t("invoice_label", lang), amount=stars)],
            subscription_period=config.SUBSCRIPTION_PERIOD,
        )
    except TelegramAPIError as exc:
        log.warning("could not create an invoice link for chat %s: %s", chat_id, exc)
        return None
```

- [ ] **Step 4: Write `handlers/payments.py`**

```python
"""Incoming Stars payments: the pre-checkout gate and the receipt.

Registered ahead of every other router. No existing router would swallow a
payment today - handlers.admin filters to private chats but declares no
catch-all message handler, and handlers.group's catch-all filters to group
chats - so a successful_payment message currently falls through unhandled.
Registering first states that dependency instead of relying on it staying
true.
"""
import functools
import logging
from datetime import datetime, timedelta, timezone

from aiogram import F, Router
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramAPIError
from aiogram.types import Message, PreCheckoutQuery

import config
from core import guards, tiers
from storage import billing, chats
from texts import t

log = logging.getLogger("stopspam.payments")

router = Router(name="payments")
router.message.filter(F.chat.type == ChatType.PRIVATE)

# A digit-only chat id outside this range parses fine with int() but makes
# sqlite3 raise OverflowError on binding - which is not a sqlite3.Error, so it
# would escape best_effort. Rejected here, at validation, mirroring
# handlers.admin.
_SQLITE_INT_MIN = -(2**63)
_SQLITE_INT_MAX = 2**63 - 1

_best_effort = functools.partial(guards.best_effort, log)


def _known_prices() -> set[int]:
    return {tiers.price_for(tiers.SMALL), tiers.price_for(tiers.LARGE)}


def parse_payload(payload: str) -> tuple[int, int] | None:
    """(chat_id, stars) from an invoice payload, or None if it is not ours.

    The star count is checked against the prices we actually sell. Without
    that, a crafted invoice could buy a subscription for one star: the payload
    round-trips through the buyer's client, so nothing in it is trustworthy on
    the way back.
    """
    parts = payload.split(":")
    if len(parts) != 3 or parts[0] != "sub":
        return None
    try:
        chat_id, stars = int(parts[1]), int(parts[2])
    except ValueError:
        return None
    if not (_SQLITE_INT_MIN <= chat_id <= _SQLITE_INT_MAX):
        return None
    if stars not in _known_prices():
        return None
    return chat_id, stars


def _lang(chat_id: int) -> str:
    chat = _best_effort("get_chat", chat_id, chats.get_chat, chat_id)
    return chat.lang if chat else "en"


def _title(chat_id: int) -> str:
    chat = _best_effort("get_chat", chat_id, chats.get_chat, chat_id)
    return (chat.title if chat and chat.title else str(chat_id))


@router.pre_checkout_query()
async def on_pre_checkout(query: PreCheckoutQuery) -> None:
    """Telegram fails the payment if this goes unanswered for ten seconds.

    So it does no network work and no storage work beyond what is already in
    memory. It deliberately does not re-check that the payer administers the
    chat: that costs a round-trip against the deadline, and the only thing it
    would prevent - somebody paying for a group they do not administer - is a
    gift, not an attack.
    """
    parsed = parse_payload(query.invoice_payload)
    ok = (parsed is not None
          and query.currency == "XTR"
          and query.total_amount == parsed[1])
    try:
        await query.answer(ok=ok, error_message=None if ok else t("pay_rejected"))
    except TelegramAPIError as exc:
        log.warning("could not answer pre_checkout %s: %s", query.id, exc)
    if not ok:
        log.warning("refused pre_checkout %s: payload %r, %s %s",
                    query.id, query.invoice_payload, query.total_amount, query.currency)


@router.message(F.successful_payment)
async def on_successful_payment(message: Message) -> None:
    payment = message.successful_payment
    parsed = parse_payload(payment.invoice_payload)
    if parsed is None:
        # Money moved and we cannot tell for whom. Nothing can be credited,
        # but this must be loud: the charge id below is the only handle on it.
        log.error("payment %s from user %s has an unusable payload %r",
                  payment.telegram_payment_charge_id, message.from_user.id,
                  payment.invoice_payload)
        return
    chat_id, stars = parsed

    if payment.subscription_expiration_date:
        expiry = datetime.fromtimestamp(payment.subscription_expiration_date,
                                        timezone.utc)
    else:
        # The field is optional in the Bot API. A missing one must not leave a
        # paying customer with nothing.
        expiry = datetime.now(timezone.utc) + timedelta(
            seconds=config.SUBSCRIPTION_PERIOD)
    expires_at = expiry.isoformat(timespec="seconds")

    recorded = _best_effort(
        "record_payment", chat_id, billing.record_payment,
        charge_id=payment.telegram_payment_charge_id, chat_id=chat_id,
        payer_user_id=message.from_user.id, stars=stars,
        is_recurring=bool(payment.is_recurring), expires_at=expires_at)

    lang = _lang(chat_id)
    if recorded is None:
        log.error("could not record payment %s for chat %s - the money moved "
                  "and the ledger did not", payment.telegram_payment_charge_id, chat_id)
        await _say(message, t("pay_unrecorded", lang))
        return
    if recorded is False:
        log.info("payment %s redelivered for chat %s, ignored",
                 payment.telegram_payment_charge_id, chat_id)
        return

    log.info("chat %s paid %s stars until %s (recurring=%s)",
             chat_id, stars, expires_at, bool(payment.is_recurring))
    days = tiers.days_left(expires_at, now=datetime.now(timezone.utc))
    await _say(message, t("pay_thanks", lang, title=_title(chat_id), days=days)
               + "\n\n" + t("pay_cancel_hint", lang))


async def _say(message: Message, body: str) -> None:
    try:
        await message.answer(body)
    except TelegramAPIError as exc:
        log.warning("could not reply to user %s: %s", message.chat.id, exc)
```

- [ ] **Step 5: Register the router in `bot.py`**

Change `build_dispatcher`:

```python
def build_dispatcher() -> Dispatcher:
    dispatcher = Dispatcher()
    # Order matters: the group router matches every group message, so the
    # specific routers are registered first. Payments come first of all -
    # nothing else claims a successful_payment today, and this states that
    # rather than relying on it.
    dispatcher.include_router(payments.router)
    dispatcher.include_router(admin.router)
    dispatcher.include_router(review.router)
    dispatcher.include_router(group.router)
    return dispatcher
```

and the import:

```python
from handlers import admin, group, payments, review
```

- [ ] **Step 6: Run the whole suite**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add core/offer.py handlers/payments.py bot.py tests/test_offer.py tests/test_payments_handler.py
git commit -m "Sell and receive 30-day Stars subscriptions"
```

---

## Task 8: The review card asks for the subscription

**Files:**
- Modify: `core/cards.py` — `render_card` and `card_keyboard`
- Modify: `core/actions.py:110-131`
- Test: `tests/test_cards.py`

**Interfaces:**
- Consumes: `policy.REASON_NOT_ENTITLED` (Task 5), `Outcome.entitlement` (Task 5), `offer.subscribe_link` (Task 7), texts `card_not_entitled` and `btn_subscribe` (Task 4).
- Produces: `cards.card_keyboard(review_id: int | None, lang: str, *, subscribe_url: str | None = None, stars: int = 0) -> InlineKeyboardMarkup | None`

**Where the tests go, and why not `tests/test_actions.py`.** That file today holds
only two rate-limiter tests: no bot fake, no helpers for driving `actions.apply`.
Inventing that scaffolding here would duplicate what `tests/test_flow.py` already
does with a real dispatcher. So the rendering is tested in `tests/test_cards.py`,
which needs no fakes at all, and the wiring through `actions.apply` is covered by
the end-to-end test in Task 11.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_cards.py`. Note that this file has no shared verdict
fixture — every existing test builds what it needs inline — so these do too:

```python
def _verdict():
    from core.verdict import Verdict
    return Verdict(is_spam=0.98, is_scam=0.99, solicits_contact=1.0,
                   looks_like_member=0.02, kind="crypto", severity=2,
                   severity_confidence=0.95, model="jev-test")


def test_a_not_entitled_card_says_what_would_have_happened():
    from core.policy import Action, Decision
    body = render_card(
        decision=Decision(Action.REVIEW, 0.95, "not_entitled"), verdict=_verdict(),
        author_name="A", author_id=1, text="buy crypto",
        chat_title="G", lang="ru")
    assert "подписки" in body


def test_an_ordinary_card_does_not_mention_subscriptions():
    from core.policy import Action, Decision
    body = render_card(
        decision=Decision(Action.REVIEW, 0.60, "grey_zone"), verdict=_verdict(),
        author_name="A", author_id=1, text="hello", chat_title="G", lang="ru")
    assert "подписки" not in body


def test_the_subscribe_button_carries_the_price_and_a_url():
    markup = card_keyboard(42, "ru", subscribe_url="https://t.me/x", stars=250)
    buttons = [b for row in markup.inline_keyboard for b in row]
    subscribe = [b for b in buttons if b.url == "https://t.me/x"]
    assert len(subscribe) == 1
    assert "250" in subscribe[0].text


def test_moderation_buttons_survive_alongside_the_subscribe_button():
    markup = card_keyboard(42, "en", subscribe_url="https://t.me/x", stars=50)
    data = [b.callback_data for row in markup.inline_keyboard for b in row
            if b.callback_data]
    assert data == ["rv:ban:42", "rv:del:42", "rv:ok:42"]


def test_a_card_with_no_review_row_can_still_offer_the_subscription():
    """The review row failing to write must not also cost the sale."""
    markup = card_keyboard(None, "en", subscribe_url="https://t.me/x", stars=50)
    buttons = [b for row in markup.inline_keyboard for b in row]
    assert len(buttons) == 1
    assert buttons[0].url == "https://t.me/x"


def test_no_buttons_at_all_returns_none_rather_than_an_empty_keyboard():
    assert card_keyboard(None, "en") is None
```

The three pre-existing `card_keyboard` calls in that file (lines 40, 64, 137) pass
a review id positionally and keep working unchanged.

- [ ] **Step 2: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_cards.py -q`
Expected: FAIL — `TypeError: card_keyboard() got an unexpected keyword argument 'subscribe_url'`.

- [ ] **Step 3: Change `core/cards.py`**

Change the import line:

```python
from core.policy import Decision, REASON_NOT_ENTITLED
```

In `render_card`, replace the single `return "\n".join([...])` with a list that can
carry one extra line:

```python
    lines = [
        f"<b>{html.escape(t('card_title', lang))}</b>",
        f"{html.escape(t('card_chat', lang))}: {html.escape(chat_title)}",
        f"{html.escape(t('card_author', lang))}: "
        f"{html.escape(author_name)} (<code>{author_id}</code>)",
        f"{html.escape(t('card_risk', lang))}: {decision.risk:.2f} ({html.escape(decision.reason)})",
        f"{html.escape(t('card_kind', lang))}: {html.escape(verdict.kind)}",
    ]
    if decision.reason == REASON_NOT_ENTITLED:
        lines.append(f"<i>{html.escape(t('card_not_entitled', lang))}</i>")
    lines += [
        "",
        f"<b>{html.escape(t('card_breakdown', lang))}</b>",
        f"<code>spam {verdict.is_spam:.2f} · scam {verdict.is_scam:.2f} · "
        f"contact {verdict.solicits_contact:.2f} · member {verdict.looks_like_member:.2f}\n"
        f"severity {verdict.severity} (confidence {verdict.severity_confidence:.2f})</code>",
        "",
        f"<blockquote>{html.escape(quote)}</blockquote>",
    ]
    return "\n".join(lines)
```

Replace `card_keyboard` entirely:

```python
def card_keyboard(review_id: int | None, lang: str, *, subscribe_url: str | None = None,
                  stars: int = 0) -> InlineKeyboardMarkup | None:
    """The card's buttons, or None when there are none to show.

    The two halves are independent on purpose. A review row that failed to
    write costs the moderation buttons but must not also cost the sale, and a
    chat with no subscription to sell still gets working moderation buttons.
    """
    rows = []
    if review_id is not None:
        rows.append([
            InlineKeyboardButton(text=t("btn_ban", lang), callback_data=f"rv:ban:{review_id}"),
            InlineKeyboardButton(text=t("btn_delete", lang), callback_data=f"rv:del:{review_id}"),
            InlineKeyboardButton(text=t("btn_not_spam", lang), callback_data=f"rv:ok:{review_id}"),
        ])
    if subscribe_url:
        rows.append([InlineKeyboardButton(text=t("btn_subscribe", lang, stars=stars),
                                          url=subscribe_url)])
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None
```

- [ ] **Step 4: Change `core/actions.py`**

Change the imports:

```python
from core import guards, offer, pipeline, tiers
from core.policy import Action, REASON_NOT_ENTITLED
```

Inside `apply`, in the `else:` branch where the card body is built, replace the line
`keyboard = card_keyboard(review_id, chat.lang) if review_id is not None else None`
with:

```python
        # The invoice link is fetched only when there is something to sell, so
        # an ordinary card still costs no extra Telegram call.
        subscribe_url, stars = None, 0
        if decision.reason == REASON_NOT_ENTITLED and outcome.entitlement is not None:
            stars = outcome.entitlement.price
            subscribe_url = await offer.subscribe_link(
                bot, chat_id=chat.chat_id, title=chat.title or str(chat.chat_id),
                stars=stars, lang=chat.lang)
        keyboard = card_keyboard(review_id, chat.lang,
                                 subscribe_url=subscribe_url, stars=stars)
```

`card_keyboard` now returns `None` by itself when there is nothing to show, so the
old `if review_id is not None` guard is deleted rather than moved.

- [ ] **Step 5: Run the whole suite**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/cards.py core/actions.py tests/test_cards.py
git commit -m "Offer the subscription on the card that shows what was not deleted"
```

---

## Task 9: The settings menu shows the plan and sells it

**Files:**
- Modify: `handlers/admin.py:40` (`_TOGGLE_FIELDS`), `:102-138` (`_menu`), `:224-283` (`on_config`)
- Test: `tests/test_admin_handler.py`

**Interfaces:**
- Consumes: `billing.get` (Task 3), `tiers` (Task 2), `offer.subscribe_link` (Task 7), texts from Task 4.
- Produces: the `cfg:<chat_id>:gonow` callback, and a plan line in the menu body.

**Note on `_menu`:** it is currently synchronous and pure. Creating an invoice link is async and hits Telegram. Keep `_menu` synchronous — it renders the plan *line* and the "start deleting" button from data already loaded, and the subscribe button is attached by the async caller. This is what keeps the menu renderable in a test without a bot.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_admin_handler.py`:

```python
def test_the_menu_names_the_plan_for_a_free_group():
    from handlers import admin
    from storage import billing, chats
    chats.ensure_chat(-100123, "Small")
    billing.set_member_count(-100123, 150)
    body, _ = admin._menu(chats.get_chat(-100123), billing.get(-100123))
    assert "Plan" in body or "Тариф" in body
    assert "150" in body


def test_the_menu_tells_an_unpaid_large_group_that_nothing_is_deleted():
    from handlers import admin
    from storage import billing, chats
    chats.ensure_chat(-100123, "Big")
    billing.set_member_count(-100123, 5000)
    body, _ = admin._menu(chats.get_chat(-100123), billing.get(-100123))
    assert "no subscription" in body


def test_the_start_deleting_button_appears_only_while_observing():
    from handlers import admin
    from storage import billing, chats
    chats.ensure_chat(-100123, "G")
    observing_body, observing_kb = admin._menu(chats.get_chat(-100123),
                                               billing.get(-100123))
    labels = [b.callback_data for row in observing_kb.inline_keyboard for b in row]
    assert any(d and d.endswith(":gonow") for d in labels)

    chats.update_chat(-100123, mode="active",
                      observe_until="2020-01-01T00:00:00+00:00")
    _, done_kb = admin._menu(chats.get_chat(-100123), billing.get(-100123))
    labels = [b.callback_data for row in done_kb.inline_keyboard for b in row]
    assert not any(d and d.endswith(":gonow") for d in labels)


@pytest.mark.asyncio
async def test_pressing_start_deleting_ends_the_observation_window():
    from handlers import admin
    from storage import chats
    chats.ensure_chat(-100123, "G")
    query = FakeCallback(data="cfg:-100123:gonow", user_id=7, admin=True)
    await admin.on_config(query)
    chat = chats.get_chat(-100123)
    assert chat.mode == "active"
    assert chats.is_observing(chat) is False


@pytest.mark.asyncio
async def test_a_non_admin_cannot_end_the_observation_window():
    from handlers import admin
    from storage import chats
    chats.ensure_chat(-100123, "G")
    query = FakeCallback(data="cfg:-100123:gonow", user_id=7, admin=False)
    await admin.on_config(query)
    assert chats.is_observing(chats.get_chat(-100123)) is True


def test_gonow_is_an_accepted_callback_field():
    from handlers import admin
    assert admin._parse_callback("cfg:-100123:gonow") == (-100123, "gonow", None)
```

- [ ] **Step 2: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_admin_handler.py -q`
Expected: FAIL — `TypeError: _menu() takes 1 positional argument but 2 were given`.

- [ ] **Step 3: Change `handlers/admin.py`**

Add imports:

```python
from datetime import datetime, timezone

from core import guards, offer, ratelimit, tiers
from storage import billing, chats
```

Add `"gonow"` to the toggle fields:

```python
_TOGGLE_FIELDS = {"mode", "jev", "lang", "log", "gonow"}
```

Add a helper above `_menu`:

```python
def _billing_label(chat, row, lang: str) -> str:
    """The plan line, in words an admin can act on.

    Says what is happening rather than naming a tier: "no subscription - I
    report spam but do not delete it" is a sentence somebody can decide about,
    where "tier: large" is not.
    """
    now = datetime.now(timezone.utc)
    tier = tiers.tier_for(row.member_count)
    if tier == tiers.FREE:
        return t("billing_free", lang, count=row.member_count or 0,
                 limit=config.FREE_MEMBER_LIMIT)
    ent = tiers.build(tier, paid_until=row.paid_until,
                      grace_until=row.grace_until, now=now)
    if ent.reason == "subscribed":
        return t("billing_subscribed", lang,
                 days=tiers.days_left(row.paid_until, now=now))
    if ent.reason == "grace":
        return t("billing_grace", lang,
                 days=tiers.days_left(row.grace_until, now=now))
    return t("billing_none", lang)
```

Change `_menu`'s signature to `def _menu(chat, row) -> tuple[str, InlineKeyboardMarkup]:`, add the plan line to `body`:

```python
        f"{t('menu_billing', lang)}: {_billing_label(chat, row, lang)}",
```

and append a conditional row to the keyboard, after the `btn_log_here` row:

```python
    if chats.is_observing(chat):
        keyboard.inline_keyboard.append([
            InlineKeyboardButton(text=t("btn_start_deleting", lang),
                                 callback_data=f"cfg:{cid}:gonow")])
```

In `on_chats`, load the billing row alongside the chat and attach the subscribe button when there is one to sell:

```python
    for chat in owned:
        row = _best_effort("billing_get", chat.chat_id, billing.get,
                           chat.chat_id) or billing.empty(chat.chat_id)
        body, keyboard = _menu(chat, row)
        await _send_menu(message.bot, message, chat, row, body, keyboard)
```

with a helper that adds the button:

```python
async def _send_menu(bot, message, chat, row, body, keyboard) -> None:
    """Sends one chat's menu, with a subscribe button when one applies.

    One malformed or oversized menu must not take down /chats for every other
    chat this admin administers.
    """
    ent = tiers.build(tiers.tier_for(row.member_count), paid_until=row.paid_until,
                      grace_until=row.grace_until, now=datetime.now(timezone.utc))
    if ent.price and ent.reason != "subscribed":
        url = await offer.subscribe_link(bot, chat_id=chat.chat_id,
                                         title=chat.title or str(chat.chat_id),
                                         stars=ent.price, lang=chat.lang)
        if url:
            keyboard.inline_keyboard.append([
                InlineKeyboardButton(text=t("btn_subscribe", chat.lang, stars=ent.price),
                                     url=url)])
        else:
            body += f"\n\n<i>{html.escape(t('invoice_unavailable', chat.lang))}</i>"
    try:
        await message.answer(body, reply_markup=keyboard)
    except TelegramAPIError as exc:
        log.warning("could not send menu for chat %s: %s", chat.chat_id, exc)
```

In `on_config`, add the `gonow` branch alongside the others and load the billing row before re-rendering:

```python
    elif field == "gonow":
        # Ends the observation window on the admin's say-so. Not gated by
        # payment: a free group can use it too. It exists because the window is
        # otherwise unconditional, so an admin who subscribes today would get
        # nothing for a week.
        updated = _best_effort(
            "update_chat", chat_id, chats.update_chat, chat_id, mode="active",
            observe_until=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        chat = updated or chat
```

and replace the final render:

```python
    row = _best_effort("billing_get", chat_id, billing.get, chat_id) \
        or billing.empty(chat_id)
    body, keyboard = _menu(chat, row)
```

`observe_until` is already listed in `chats._FIELDS`, so `chats.update_chat`
accepts it and no change is needed there. `handlers/admin.py` does **not**
currently import `config`, and `_billing_label` needs it — add `import config`
at the top of the file.

- [ ] **Step 4: Run the whole suite**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add handlers/admin.py tests/test_admin_handler.py
git commit -m "Show the plan in the settings menu and let an admin end observation"
```

---

## Task 10: core/notices.py — telling an admin before the bot goes quiet

**Files:**
- Create: `core/notices.py`
- Modify: `handlers/group.py` (call it from `_entitlement`'s caller)
- Test: `tests/test_notices.py` (create)

**Interfaces:**
- Consumes: `tiers` (Task 2), `billing.set_notified_stage` (Task 3), `actions.card_destination`, `offer.subscribe_link` (Task 7), texts `notice_grace`, `notice_grace_ending`, `notice_lapsed` (Task 4).
- Produces:
  - `notices.STAGE_GRACE`, `notices.STAGE_GRACE_ENDING`, `notices.STAGE_LAPSED`
  - `notices.next_stage(entitlement, *, grace_until, notified_stage, now) -> str | None`
  - `notices.maybe_notify(bot, *, chat, row, entitlement) -> None`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_notices.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from core import notices, tiers

NOW = datetime(2026, 9, 21, 12, 0, 0, tzinfo=timezone.utc)


def stamp(**delta) -> str:
    return (NOW + timedelta(**delta)).isoformat(timespec="seconds")


def ent(reason, tier=tiers.LARGE):
    return tiers.Entitlement(tier=tier, active=reason != "not_entitled",
                             reason=reason, price=250)


def test_a_fresh_trial_is_announced():
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=14),
                              notified_stage=None, now=NOW) == notices.STAGE_GRACE


def test_a_trial_already_announced_is_not_announced_again():
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=14),
                              notified_stage=notices.STAGE_GRACE, now=NOW) is None


def test_the_end_of_the_trial_is_warned_about_once():
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=2),
                              notified_stage=notices.STAGE_GRACE,
                              now=NOW) == notices.STAGE_GRACE_ENDING
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=2),
                              notified_stage=notices.STAGE_GRACE_ENDING,
                              now=NOW) is None


def test_losing_entitlement_is_announced_even_with_no_trial_before_it():
    """A chat that paid and lapsed never had a grace stage recorded."""
    assert notices.next_stage(ent("not_entitled"), grace_until=None,
                              notified_stage=None, now=NOW) == notices.STAGE_LAPSED


def test_stages_only_move_forward():
    """Otherwise a chat oscillating around the threshold re-announces its
    trial every time it dips back."""
    assert notices.next_stage(ent("grace"), grace_until=stamp(days=14),
                              notified_stage=notices.STAGE_LAPSED, now=NOW) is None


def test_a_paid_chat_is_told_nothing():
    assert notices.next_stage(ent("subscribed"), grace_until=None,
                              notified_stage=None, now=NOW) is None


def test_a_free_chat_is_told_nothing():
    assert notices.next_stage(ent("free_tier", tier=tiers.FREE), grace_until=None,
                              notified_stage=None, now=NOW) is None


@pytest.mark.asyncio
async def test_a_notice_is_sent_once_and_the_stage_is_recorded():
    from storage import billing, chats
    chats.ensure_chat(-100123, "G")
    chats.update_chat(-100123, log_chat_id=999)
    billing.start_grace(-100123)
    bot = FakeBot()
    chat = chats.get_chat(-100123)

    await notices.maybe_notify(bot, chat=chat, row=billing.get(-100123),
                               entitlement=ent("grace"))
    assert len(bot.sent) == 1
    assert billing.get(-100123).notified_stage == notices.STAGE_GRACE

    await notices.maybe_notify(bot, chat=chat, row=billing.get(-100123),
                               entitlement=ent("grace"))
    assert len(bot.sent) == 1


@pytest.mark.asyncio
async def test_a_chat_with_nowhere_to_send_records_no_stage():
    """Otherwise the stage advances against a notice nobody received, and the
    admin is never told at all."""
    from storage import billing, chats
    chats.ensure_chat(-100123, "G")   # no log_chat_id
    billing.start_grace(-100123)
    bot = FakeBot()
    await notices.maybe_notify(bot, chat=chats.get_chat(-100123),
                               row=billing.get(-100123), entitlement=ent("grace"))
    assert bot.sent == []
    assert billing.get(-100123).notified_stage is None


@pytest.mark.asyncio
async def test_a_telegram_failure_records_no_stage_either():
    from aiogram.exceptions import TelegramAPIError
    from storage import billing, chats
    chats.ensure_chat(-100123, "G")
    chats.update_chat(-100123, log_chat_id=999)
    billing.start_grace(-100123)
    bot = FakeBot(raises=TelegramAPIError(method=None, message="boom"))
    await notices.maybe_notify(bot, chat=chats.get_chat(-100123),
                               row=billing.get(-100123), entitlement=ent("grace"))
    assert billing.get(-100123).notified_stage is None
```

Use the same `fresh_db` fixture as `tests/test_billing.py`. `FakeBot` needs an async `send_message(chat_id, text, reply_markup=None)` appending to `sent` or raising, and an async `create_invoice_link(**kwargs)` returning a URL.

- [ ] **Step 2: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_notices.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.notices'`.

- [ ] **Step 3: Write `core/notices.py`**

```python
"""Telling an admin before the bot stops deleting, and after it has.

The bot going quiet is the failure this exists to prevent: a group that grows
past the free limit and silently stops being enforced is the bot failing at
its job exactly when the group became worth attacking.
"""
import logging

from datetime import datetime, timezone

from aiogram.exceptions import TelegramAPIError
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

import config
from core import actions, guards, offer, tiers
from storage import billing
from texts import t

log = logging.getLogger("stopspam.notices")

STAGE_GRACE = "grace"
STAGE_GRACE_ENDING = "grace_ending"
STAGE_LAPSED = "lapsed"

# Stages only ever move forward. A chat that dips back under the member limit
# and climbs out again must not re-announce a trial it already had.
_ORDER = (STAGE_GRACE, STAGE_GRACE_ENDING, STAGE_LAPSED)

_TEXT = {
    STAGE_GRACE: "notice_grace",
    STAGE_GRACE_ENDING: "notice_grace_ending",
    STAGE_LAPSED: "notice_lapsed",
}


def next_stage(entitlement, *, grace_until: str | None,
               notified_stage: str | None, now: datetime) -> str | None:
    """Which notice this chat is due, or None.

    Pure, so every transition can be tested without a bot. The stage flag is
    what bounds how often anything is sent - stronger than a timer, because a
    stage that has been announced is never announced again at all.
    """
    if entitlement.tier == tiers.FREE:
        return None

    candidate = None
    if entitlement.reason == "grace":
        remaining = tiers.days_left(grace_until, now=now)
        candidate = (STAGE_GRACE_ENDING if remaining <= config.GRACE_WARN_DAYS
                     else STAGE_GRACE)
    elif entitlement.reason == "not_entitled":
        candidate = STAGE_LAPSED

    if candidate is None:
        return None
    if notified_stage is None:
        return candidate
    if notified_stage not in _ORDER:
        return candidate
    return candidate if _ORDER.index(candidate) > _ORDER.index(notified_stage) else None


async def maybe_notify(bot, *, chat, row, entitlement) -> None:
    """Sends the due notice, if any, and records that it went out.

    The stage is recorded only after Telegram accepted the message. Recording
    it first would burn the one announcement a chat gets on a send that never
    arrived, and the admin would never be told at all.
    """
    now = datetime.now(timezone.utc)
    stage = next_stage(entitlement, grace_until=row.grace_until,
                       notified_stage=row.notified_stage, now=now)
    if stage is None:
        return

    target = actions.card_destination(chat)
    if target is None:
        log.warning("chat %s has no destination: %s notice skipped",
                    chat.chat_id, stage)
        return

    days = tiers.days_left(
        row.grace_until if stage != STAGE_LAPSED else row.paid_until, now=now)
    body = t(_TEXT[stage], chat.lang, title=chat.title or str(chat.chat_id),
             limit=config.FREE_MEMBER_LIMIT, days=days)

    keyboard = None
    url = await offer.subscribe_link(bot, chat_id=chat.chat_id,
                                     title=chat.title or str(chat.chat_id),
                                     stars=entitlement.price, lang=chat.lang)
    if url:
        keyboard = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(
                text=t("btn_subscribe", chat.lang, stars=entitlement.price), url=url)]])

    try:
        await bot.send_message(target, body, reply_markup=keyboard)
    except TelegramAPIError as exc:
        log.warning("could not send the %s notice for chat %s: %s",
                    stage, chat.chat_id, exc)
        return

    guards.best_effort(log, "set_notified_stage", chat.chat_id,
                       billing.set_notified_stage, chat.chat_id, stage)
```

- [ ] **Step 4: Call it from the group handler**

`_entitlement` already returns the billing row alongside the entitlement (Task 5),
so no signature changes here. In `on_group_message`, between the `_entitlement`
call and `pipeline.evaluate`, add:

```python
    if billing_row is not None:
        await notices.maybe_notify(message.bot, chat=chat, row=billing_row,
                                   entitlement=entitlement)
```

The row is `None` only on the storage-failure path, which is why the caller
checks. Add `notices` to the `core` import in `handlers/group.py`.

- [ ] **Step 5: Run the whole suite**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/notices.py handlers/group.py tests/
git commit -m "Warn an admin before the bot stops deleting, and once after"
```

---

## Task 11: Documentation and the end-to-end path

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Test: `tests/test_flow.py`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

**Why the README matters here:** it describes what the bot does to a stranger deciding whether to trust it, and it currently says the bot deletes confident spam full stop. That is now true only below 200 members or with a subscription. Leaving it is a promise the software no longer keeps.

- [ ] **Step 1: Write the failing end-to-end tests**

These go in `tests/test_flow.py` and use the machinery that file already has:
`fake_call` patched onto `Bot.__call__`, the module-level `calls` list,
`group_message()` and `deletions()`.

**First, extend `fake_call`** — this is not optional and not cosmetic. It
currently ends with `return True` for any unrecognised method. `get_chat_member_count`
would therefore return `True`, and because `True <= 200` is true in Python, **every
chat would silently read as the free tier and every test below would pass for the
wrong reason.** Add these two branches before that final `return True`:

```python
    if isinstance(method, GetChatMemberCount):
        return MEMBERS[0]
    if isinstance(method, CreateInvoiceLink):
        return "https://t.me/invoice/test"
```

with the imports and the knob at module level:

```python
from aiogram.methods import (CreateInvoiceLink, DeleteMessage, GetChatMember,
                             GetChatMemberCount, GetMe, SendMessage)
from aiogram.types import SuccessfulPayment

MEMBERS = [150]
```

**Second, in the `fresh` fixture**, reset the knob and reload the new router
alongside the three already reloaded there — `bot.build_dispatcher()` is called
once per test and aiogram refuses to attach a Router that already has a parent:

```python
    MEMBERS[0] = 150
    import handlers.payments
    importlib.reload(handlers.payments)
```

**Then the tests:**

```python
def _active_group(members: int) -> None:
    """A group past its observation window, with cards going somewhere."""
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=LOG, mode="active",
                      observe_until="2020-01-01T00:00:00+00:00")
    MEMBERS[0] = members


def _burn_the_trial() -> None:
    """Opens the 14-day trial and pushes it into the past.

    Written this way rather than by never opening it, because the set-once rule
    means an expired window must not reopen - which is exactly what these tests
    need to rely on.
    """
    from storage import billing, db
    billing.start_grace(GROUP)
    conn = db.connect()
    conn.execute("UPDATE billing SET grace_until = ? WHERE chat_id = ?",
                 ("2020-01-01T00:00:00+00:00", GROUP))
    conn.commit()


def _dispatch():
    import bot as app
    from handlers import group
    group.set_client(FakeJevClient({"buy crypto": SCAM}, default=CHATTER))
    telegram = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    return telegram, app.build_dispatcher()


def cards_sent():
    return [c for c in calls if isinstance(c, SendMessage) and c.chat_id == LOG]


def payment_update(update_id: int, charge_id: str, stars: int) -> Update:
    """A real successful_payment update, so router registration is covered too."""
    return Update(update_id=update_id, message=Message(
        message_id=update_id, date=NOW,
        chat=Chat(id=ADMIN, type="private"),
        from_user=User(id=ADMIN, is_bot=False, first_name="Boss"),
        successful_payment=SuccessfulPayment(
            currency="XTR", total_amount=stars,
            invoice_payload=f"sub:{GROUP}:{stars}",
            telegram_payment_charge_id=charge_id,
            provider_payment_charge_id="p")))


async def test_an_unpaid_large_group_reports_spam_without_deleting_it():
    """The whole feature in one path: classified, carded, not deleted, sold to."""
    _active_group(5000)
    _burn_the_trial()
    telegram, dispatcher = _dispatch()
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 1))

    assert deletions() == []
    assert len(cards_sent()) == 1
    assert any(b.url for row in cards_sent()[0].reply_markup.inline_keyboard
               for b in row), "the card must carry the subscribe button"


async def test_a_large_group_inside_its_trial_still_deletes():
    _active_group(5000)
    telegram, dispatcher = _dispatch()
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 1))
    assert len(deletions()) == 1


async def test_a_small_group_deletes_without_ever_paying():
    _active_group(150)
    telegram, dispatcher = _dispatch()
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 1))
    assert len(deletions()) == 1


async def test_paying_turns_deletion_back_on_for_the_same_message():
    _active_group(5000)
    _burn_the_trial()
    telegram, dispatcher = _dispatch()
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 1))
    assert deletions() == []

    await dispatcher.feed_update(telegram, payment_update(2, "ch_1", 250))
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 3))
    assert len(deletions()) == 1


async def test_an_admins_message_is_untouched_whatever_the_tier():
    """Payment gates the action, never the judgment - and never the guard that
    admins are not acted upon."""
    from handlers import group
    _active_group(5000)
    _burn_the_trial()
    telegram, dispatcher = _dispatch()
    before = len(group._client.calls)
    await dispatcher.feed_update(telegram, group_message("buy crypto now", ADMIN, 1))
    assert deletions() == []
    assert len(group._client.calls) == before, "an admin must never reach the API"
```

- [ ] **Step 2: Run them and watch them fail**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_flow.py -q`
Expected: FAIL on the missing `setup_chat` helper, then on behaviour until Tasks 1-10 are all in.

- [ ] **Step 3: Update `README.md`**

Replace the section "## The first 7 days: observation only" heading block by adding a new section immediately after "## What it does, and what it does not":

```markdown
## What it costs

Groups of **200 members or fewer use the whole bot for free**, including
automatic deletion, with no time limit.

Above that, automatic deletion needs a subscription, paid in Telegram
Stars from the `/chats` menu:

| Members | Price |
|---|---|
| up to 200 | free |
| 201 – 1000 | 50 ⭐ per 30 days |
| over 1000 | 250 ⭐ per 30 days |

A group that grows past 200 gets **14 days of full enforcement for free**
before anything changes, and is told when that starts and before it ends.

Without a subscription the bot does not switch off. It still checks every
message it would have checked, still writes its audit log, and still sends
review cards to the admins — it just does not delete anything itself. The
card says so, and carries the button to change it.

Nothing about payment changes how a message is judged. The classifier, the
thresholds, the confidence floor and the guard that admins are never acted
upon are identical on every tier. Payment gates what may be done about a
message, never the judgment of it.

Subscriptions renew every 30 days and can be cancelled at any time in
Telegram under Settings → My Stars → Subscriptions. The price is fixed when
you subscribe and does not change if the group grows.
```

Also update the "## Self-hosting" section: a self-hosted bot has its own
`BOT_TOKEN`, so its payments go to whoever runs it. Add one line after the
`docker compose up` block:

```markdown
A self-hosted instance bills to its own bot, so the tier limits above apply
only to the public `@StopSpam_jev_bot`. To turn billing off entirely, set
`FREE_MEMBER_LIMIT` to a number no group will reach.
```

- [ ] **Step 4: Update `.env.example`**

Append:

```
# Billing (optional; these are the defaults)
FREE_MEMBER_LIMIT=200
SMALL_MEMBER_LIMIT=1000
PRICE_SMALL_STARS=50
PRICE_LARGE_STARS=250
GRACE_DAYS=14
GRACE_WARN_DAYS=3
MEMBER_COUNT_TTL_HOURS=24
```

- [ ] **Step 5: Run the whole suite**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS, every test.

- [ ] **Step 6: Commit**

```bash
git add README.md .env.example tests/test_flow.py
git commit -m "Document the tiers and cover the unpaid-to-paid path end to end"
```

---

## Self-review notes

Run against the spec after writing; recorded here so the executor knows what was checked.

**Spec coverage.** Every section maps to a task: tiers → 1, 2; member-count staleness → 2, 5; grace set-once and its start condition → 3, 5; price lock → no code needed (it is a consequence of Telegram renewing at the invoice amount, recorded in the README in Task 11); passive lapse → 3, 7; the policy change → 5; data model → 1, 3; invoice and pre-checkout and successful payment and renewals → 7; the three offer surfaces → 8 (card), 9 (menu), 10 (notices); ending observation early → 9; observability → 6; failure rulings → 3, 5, 7, 10; out-of-scope items are absent from every task.

**Two places the plan deliberately differs from the spec, both noted at their task:**

1. `core/tiers.py` imports `config`, which the spec's wording excludes. It follows `core/gate.py`, and the spec's intent (no I/O, injected clock) holds.
2. The spec says notices are evaluated "on the same once-per-24-hours path as the member-count refresh". They are evaluated on every message instead, because `notified_stage` is a strictly stronger bound — a stage that has been announced is never announced again at all, where a daily timer would allow one per day forever. The row is already in memory, so it costs nothing.

**One trap worth naming.** `tests/test_flow.py` and `tests/test_group_handler.py`
patch `Bot.__call__` wholesale, which bypasses aiogram's return-type validation. An
unhandled method falls through to `return True`, and `True <= 200` is true in Python
— so a missing `GetChatMemberCount` branch makes every chat read as the free tier and
makes the billing tests pass for the wrong reason. Task 11 Step 1 adds the branch
explicitly; do not skip it.

**One risk this plan cannot remove.** `handlers/group.py` now calls `get_chat_member_count` once per chat per day on the message path. In a bot across thousands of groups this is a daily burst of Telegram calls proportional to the number of *active* chats, spread naturally by traffic. It is bounded and self-throttling, but it is new outbound load on the hot path and the first thing to look at if Telegram starts rate-limiting the bot.
