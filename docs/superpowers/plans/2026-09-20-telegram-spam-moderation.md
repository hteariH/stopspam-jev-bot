# Telegram Spam & Scam Moderation Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@StopSpam_jev_bot`, a public Telegram bot that deletes high-confidence spam and scam messages using the TypeSafe Jev API and escalates every uncertain case to human admins.

**Architecture:** A message flows through `gate → state → jev → policy → action`. The gate skips trusted members so most messages cost no API call. `core/policy.py` is a pure function (probabilities in, decision out) so thresholds are testable offline. `core/jev.py` is the only module that touches the network, so a fake client makes every other module testable without a key.

**Tech Stack:** Python 3.13, aiogram 3, `typesafe-sdk`, stdlib `sqlite3`, pytest, Docker, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-20-telegram-spam-moderation-design.md`

## Global Constraints

- **Python >= 3.10** (required by `typesafe-sdk`); Docker image is `python:3.13-slim`, matching `feedback-bot`.
- **aiogram >= 3.30, < 4** — same floor as `feedback-bot`.
- **All user-visible strings are English.** The repository is public. Russian is a per-chat option added in Task 12, never the default.
- **Storage is stdlib `sqlite3`**, not `aiosqlite` — follows the existing `feedback-bot/db.py` pattern. SQLite writes here are sub-millisecond and local; do not introduce an async driver.
- **Default thresholds, copied verbatim from the spec:** `delete_threshold = 0.90`, `review_threshold = 0.55`, `confidence_floor = 0.75`, `trust_after = 5`, observation mode = 7 days, `looks_like_member` ceiling for deletion = `0.30`, Jev request timeout = 2 s, review row TTL = 7 days.
- **Never delete on uncertainty.** Every failure path resolves to ignore or review, never to a deletion. A test that asserts a deletion on an error path is a wrong test.
- **`audit` never stores message text.** Only `reviews` does, and those rows expire after 7 days.
- **Module boundaries:** `core/policy.py` must not import aiogram or make network calls. `core/jev.py` is the only module that imports `typesafe_sdk`.

---

### Task 1: Project skeleton, config, and test harness

**Files:**
- Create: `requirements.txt`, `requirements-dev.txt`, `config.py`, `pytest.ini`, `.env.example`
- Create: `core/__init__.py`, `storage/__init__.py`, `handlers/__init__.py`, `tests/__init__.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.BOT_TOKEN: str`, `config.TYPESAFE_API_KEY: str`, `config.DB_PATH: str`, `config.JEV_MODEL: str`, `config.JEV_TIMEOUT: float`, `config.OBSERVE_DAYS: int`, `config.REVIEW_TTL_DAYS: int`, `config.DEFAULT_DELETE_THRESHOLD: float`, `config.DEFAULT_REVIEW_THRESHOLD: float`, `config.DEFAULT_CONFIDENCE_FLOOR: float`, `config.DEFAULT_TRUST_AFTER: int`, `config.RECHECK_AFTER_DAYS: int`, `config.ENFORCEMENT_PER_MINUTE: int`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_config.py
import importlib


def test_defaults_match_spec(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "123:abc")
    monkeypatch.setenv("TYPESAFE_API_KEY", "ts_test")
    import config
    importlib.reload(config)

    assert config.BOT_TOKEN == "123:abc"
    assert config.DEFAULT_DELETE_THRESHOLD == 0.90
    assert config.DEFAULT_REVIEW_THRESHOLD == 0.55
    assert config.DEFAULT_CONFIDENCE_FLOOR == 0.75
    assert config.DEFAULT_TRUST_AFTER == 5
    assert config.OBSERVE_DAYS == 7
    assert config.REVIEW_TTL_DAYS == 7
    assert config.JEV_TIMEOUT == 2.0
    assert config.JEV_MODEL == "jev-latest"


def test_env_overrides_threshold(monkeypatch):
    monkeypatch.setenv("DEFAULT_DELETE_THRESHOLD", "0.95")
    import config
    importlib.reload(config)
    assert config.DEFAULT_DELETE_THRESHOLD == 0.95
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'config'`

- [ ] **Step 3: Write the files**

```
# requirements.txt
aiogram>=3.30,<4
python-dotenv>=1.0
typesafe-sdk>=0.1
```

```
# requirements-dev.txt
-r requirements.txt
pytest>=8.0
pytest-asyncio>=0.24
```

```ini
# pytest.ini
[pytest]
testpaths = tests
asyncio_mode = auto
```

```python
# config.py
"""Settings. Everything tunable lives here and in .env."""
import os

from dotenv import load_dotenv

load_dotenv()


def _float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
TYPESAFE_API_KEY = os.getenv("TYPESAFE_API_KEY", "").strip()
DB_PATH = os.getenv("DB_PATH", "stopspam.db")

JEV_MODEL = os.getenv("JEV_MODEL", "jev-latest")
JEV_TIMEOUT = _float("JEV_TIMEOUT", 2.0)

# Defaults for a freshly added chat. Admins can change these per chat.
DEFAULT_DELETE_THRESHOLD = _float("DEFAULT_DELETE_THRESHOLD", 0.90)
DEFAULT_REVIEW_THRESHOLD = _float("DEFAULT_REVIEW_THRESHOLD", 0.55)
DEFAULT_CONFIDENCE_FLOOR = _float("DEFAULT_CONFIDENCE_FLOOR", 0.75)
DEFAULT_TRUST_AFTER = _int("DEFAULT_TRUST_AFTER", 5)

OBSERVE_DAYS = _int("OBSERVE_DAYS", 7)
REVIEW_TTL_DAYS = _int("REVIEW_TTL_DAYS", 7)
RECHECK_AFTER_DAYS = _int("RECHECK_AFTER_DAYS", 30)
ENFORCEMENT_PER_MINUTE = _int("ENFORCEMENT_PER_MINUTE", 10)
```

```
# .env.example
BOT_TOKEN=
TYPESAFE_API_KEY=
DB_PATH=stopspam.db
```

Create the four empty `__init__.py` files.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_config.py -v`
Expected: PASS, 2 passed

- [ ] **Step 5: Commit**

```bash
git add requirements.txt requirements-dev.txt pytest.ini config.py .env.example core storage handlers tests
git commit -m "Add project skeleton, config defaults and pytest harness"
```

---

### Task 2: Database connection and chat configuration

**Files:**
- Create: `storage/db.py`, `storage/chats.py`
- Test: `tests/test_chats.py`

**Interfaces:**
- Consumes: `config.DB_PATH`, `config.DEFAULT_*`, `config.OBSERVE_DAYS`.
- Produces:
  - `storage.db.connect() -> sqlite3.Connection`, `storage.db.now() -> str` (UTC ISO, seconds), `storage.db.reset()` (closes the cached connection; tests use it).
  - `storage.chats.ChatConfig` dataclass with fields `chat_id, title, mode, delete_threshold, review_threshold, confidence_floor, trust_after, log_chat_id, lang, jev_enabled, observe_until, created_at`.
  - `storage.chats.ensure_chat(chat_id: int, title: str) -> ChatConfig`
  - `storage.chats.get_chat(chat_id: int) -> ChatConfig | None`
  - `storage.chats.update_chat(chat_id: int, **fields) -> ChatConfig`
  - `storage.chats.is_observing(chat: ChatConfig) -> bool`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_chats.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_chats.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'storage.db'`

- [ ] **Step 3: Write the implementation**

```python
# storage/db.py
"""SQLite storage. Schema is created on first connect."""
import sqlite3
from datetime import datetime, timezone

import config

_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
  chat_id            INTEGER PRIMARY KEY,
  title              TEXT,
  mode               TEXT    NOT NULL DEFAULT 'observe',
  delete_threshold   REAL    NOT NULL DEFAULT 0.90,
  review_threshold   REAL    NOT NULL DEFAULT 0.55,
  confidence_floor   REAL    NOT NULL DEFAULT 0.75,
  trust_after        INTEGER NOT NULL DEFAULT 5,
  log_chat_id        INTEGER,
  lang               TEXT    NOT NULL DEFAULT 'en',
  jev_enabled        INTEGER NOT NULL DEFAULT 1,
  observe_until      TEXT,
  created_at         TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS trust (
  chat_id         INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,
  clean_count     INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'unknown',
  joined_at       TEXT,
  last_checked_at TEXT,
  last_seen_at    TEXT,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL,
  message_id   INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  text         TEXT,
  verdict_json TEXT    NOT NULL,
  risk         REAL    NOT NULL,
  decision     TEXT,
  decided_by   INTEGER,
  decided_at   TEXT,
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  message_id INTEGER,
  risk       REAL,
  action     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_chat ON reviews (chat_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_audit_chat ON audit (chat_id, created_at);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(config.DB_PATH)
        _conn.row_factory = sqlite3.Row
        _conn.executescript(SCHEMA)
        _conn.commit()
    return _conn


def reset() -> None:
    """Drops the cached connection. Tests call this between cases."""
    global _conn
    if _conn is not None:
        _conn.close()
    _conn = None
```

```python
# storage/chats.py
"""Per-chat configuration."""
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import config
from storage import db

_FIELDS = (
    "mode", "delete_threshold", "review_threshold", "confidence_floor",
    "trust_after", "log_chat_id", "lang", "jev_enabled", "observe_until", "title",
)


@dataclass(frozen=True)
class ChatConfig:
    chat_id: int
    title: str | None
    mode: str
    delete_threshold: float
    review_threshold: float
    confidence_floor: float
    trust_after: int
    log_chat_id: int | None
    lang: str
    jev_enabled: bool
    observe_until: str | None
    created_at: str


def _row_to_config(row: sqlite3.Row) -> ChatConfig:
    return ChatConfig(
        chat_id=row["chat_id"],
        title=row["title"],
        mode=row["mode"],
        delete_threshold=row["delete_threshold"],
        review_threshold=row["review_threshold"],
        confidence_floor=row["confidence_floor"],
        trust_after=row["trust_after"],
        log_chat_id=row["log_chat_id"],
        lang=row["lang"],
        jev_enabled=bool(row["jev_enabled"]),
        observe_until=row["observe_until"],
        created_at=row["created_at"],
    )


def get_chat(chat_id: int) -> ChatConfig | None:
    row = db.connect().execute(
        "SELECT * FROM chats WHERE chat_id = ?", (chat_id,)
    ).fetchone()
    return _row_to_config(row) if row else None


def ensure_chat(chat_id: int, title: str) -> ChatConfig:
    """Creates the chat on first sight; afterwards only refreshes the title."""
    conn = db.connect()
    stamp = db.now()
    observe_until = (
        datetime.now(timezone.utc) + timedelta(days=config.OBSERVE_DAYS)
    ).isoformat(timespec="seconds")
    conn.execute(
        """INSERT INTO chats (chat_id, title, mode, delete_threshold, review_threshold,
                              confidence_floor, trust_after, lang, jev_enabled,
                              observe_until, created_at)
           VALUES (?, ?, 'observe', ?, ?, ?, ?, 'en', 1, ?, ?)
           ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title""",
        (chat_id, title, config.DEFAULT_DELETE_THRESHOLD, config.DEFAULT_REVIEW_THRESHOLD,
         config.DEFAULT_CONFIDENCE_FLOOR, config.DEFAULT_TRUST_AFTER, observe_until, stamp),
    )
    conn.commit()
    return get_chat(chat_id)


def update_chat(chat_id: int, **fields) -> ChatConfig:
    unknown = set(fields) - set(_FIELDS)
    if unknown:
        raise ValueError(f"unknown chat fields: {sorted(unknown)}")
    conn = db.connect()
    assignments = ", ".join(f"{name} = ?" for name in fields)
    values = [int(v) if isinstance(v, bool) else v for v in fields.values()]
    conn.execute(f"UPDATE chats SET {assignments} WHERE chat_id = ?", (*values, chat_id))
    conn.commit()
    return get_chat(chat_id)


def is_observing(chat: ChatConfig) -> bool:
    """True while the chat is inside its observation window, whatever the mode."""
    if chat.mode == "observe":
        return True
    if not chat.observe_until:
        return False
    return datetime.fromisoformat(chat.observe_until) > datetime.now(timezone.utc)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_chats.py -v`
Expected: PASS, 5 passed

- [ ] **Step 5: Commit**

```bash
git add storage/db.py storage/chats.py tests/test_chats.py
git commit -m "Add SQLite schema and per-chat configuration storage"
```

---

### Task 3: Trust ledger

**Files:**
- Create: `storage/trust.py`
- Test: `tests/test_trust.py`

**Interfaces:**
- Consumes: `storage.db.connect`, `storage.db.now`.
- Produces:
  - `storage.trust.TrustRow` dataclass: `chat_id, user_id, clean_count, status, joined_at, last_checked_at, last_seen_at`. `status` is one of `unknown | trusted | flagged | allowlisted`.
  - `storage.trust.get(chat_id: int, user_id: int) -> TrustRow` — returns a default `unknown` row if absent, never `None`.
  - `storage.trust.seen(chat_id: int, user_id: int, joined_at: str | None = None) -> TrustRow` — upserts and refreshes `last_seen_at`, but **returns the row as it was before this call**. Callers need the author's history *before* the current message; returning the refreshed row would make `days_since_seen` always ~0 and the 30-day re-check unreachable.
  - `storage.trust.days_in_group(row: TrustRow) -> float | None` — from `joined_at`.
  - `storage.trust.record_clean(chat_id: int, user_id: int, trust_after: int) -> TrustRow` — increments `clean_count`, promotes `unknown` to `trusted` at the threshold, never demotes `flagged` or `allowlisted`.
  - `storage.trust.mark_flagged(chat_id: int, user_id: int) -> TrustRow`
  - `storage.trust.allowlist(chat_id: int, user_id: int) -> TrustRow`
  - `storage.trust.days_since_seen(row: TrustRow) -> float | None`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_trust.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_trust.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'storage.trust'`

- [ ] **Step 3: Write the implementation**

```python
# storage/trust.py
"""Per-chat trust ledger: who still needs checking and who has earned a pass."""
from dataclasses import dataclass
from datetime import datetime, timezone

from storage import db

UNKNOWN, TRUSTED, FLAGGED, ALLOWLISTED = "unknown", "trusted", "flagged", "allowlisted"

# Statuses that record_clean and mark_flagged must not overwrite.
_STICKY = (FLAGGED, ALLOWLISTED)


@dataclass(frozen=True)
class TrustRow:
    chat_id: int
    user_id: int
    clean_count: int
    status: str
    joined_at: str | None
    last_checked_at: str | None
    last_seen_at: str | None


def _row(chat_id: int, user_id: int) -> TrustRow:
    row = db.connect().execute(
        "SELECT * FROM trust WHERE chat_id = ? AND user_id = ?", (chat_id, user_id)
    ).fetchone()
    if row is None:
        return TrustRow(chat_id, user_id, 0, UNKNOWN, None, None, None)
    return TrustRow(
        chat_id=row["chat_id"], user_id=row["user_id"], clean_count=row["clean_count"],
        status=row["status"], joined_at=row["joined_at"],
        last_checked_at=row["last_checked_at"], last_seen_at=row["last_seen_at"],
    )


get = _row


def seen(chat_id: int, user_id: int, joined_at: str | None = None) -> TrustRow:
    """Records that we just saw this user, and returns their history BEFORE it.

    Callers judge the current message against the author's prior record. If this
    returned the refreshed row, days_since_seen would always be ~0 and the
    30-day re-check in core.gate could never fire.
    """
    prior = _row(chat_id, user_id)
    conn = db.connect()
    stamp = db.now()
    conn.execute(
        """INSERT INTO trust (chat_id, user_id, joined_at, last_seen_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (chat_id, user_id) DO UPDATE SET
               last_seen_at = excluded.last_seen_at,
               joined_at    = COALESCE(trust.joined_at, excluded.joined_at)""",
        (chat_id, user_id, joined_at or stamp, stamp),
    )
    conn.commit()
    if prior.joined_at is None:
        return _row(chat_id, user_id)
    return prior


def _set_status(chat_id: int, user_id: int, status: str) -> TrustRow:
    conn = db.connect()
    conn.execute(
        """INSERT INTO trust (chat_id, user_id, status, last_seen_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (chat_id, user_id) DO UPDATE SET status = excluded.status""",
        (chat_id, user_id, status, db.now()),
    )
    conn.commit()
    return _row(chat_id, user_id)


def record_clean(chat_id: int, user_id: int, trust_after: int) -> TrustRow:
    current = _row(chat_id, user_id)
    conn = db.connect()
    conn.execute(
        """INSERT INTO trust (chat_id, user_id, clean_count, last_checked_at, last_seen_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (chat_id, user_id) DO UPDATE SET
               clean_count     = trust.clean_count + 1,
               last_checked_at = excluded.last_checked_at,
               last_seen_at    = excluded.last_seen_at""",
        (chat_id, user_id, db.now(), db.now()),
    )
    conn.commit()
    updated = _row(chat_id, user_id)
    if current.status in _STICKY:
        return updated
    if updated.clean_count >= trust_after:
        return _set_status(chat_id, user_id, TRUSTED)
    return updated


def mark_flagged(chat_id: int, user_id: int) -> TrustRow:
    if _row(chat_id, user_id).status == ALLOWLISTED:
        return _row(chat_id, user_id)
    return _set_status(chat_id, user_id, FLAGGED)


def allowlist(chat_id: int, user_id: int) -> TrustRow:
    return _set_status(chat_id, user_id, ALLOWLISTED)


def _days_since(stamp: str | None) -> float | None:
    if not stamp:
        return None
    delta = datetime.now(timezone.utc) - datetime.fromisoformat(stamp)
    return delta.total_seconds() / 86400


def days_since_seen(row: TrustRow) -> float | None:
    return _days_since(row.last_seen_at)


def days_in_group(row: TrustRow) -> float | None:
    return _days_since(row.joined_at)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_trust.py -v`
Expected: PASS, 7 passed

- [ ] **Step 5: Commit**

```bash
git add storage/trust.py tests/test_trust.py
git commit -m "Add per-chat trust ledger with sticky flagged and allowlisted statuses"
```

---

### Task 4: Review queue and audit log

**Files:**
- Create: `storage/reviews.py`, `storage/audit.py`
- Test: `tests/test_reviews.py`

**Interfaces:**
- Consumes: `storage.db`, `config.REVIEW_TTL_DAYS`.
- Produces:
  - `storage.reviews.create(chat_id, message_id, user_id, text, verdict_json: str, risk: float) -> int` (returns review id)
  - `storage.reviews.get(review_id: int) -> sqlite3.Row | None`
  - `storage.reviews.resolve(review_id: int, decision: str, decided_by: int) -> None` where decision is `delete_ban | delete | not_spam`
  - `storage.reviews.purge_expired() -> int` (returns rows cleared; clears `text` only, keeps the labelled decision)
  - `storage.audit.record(chat_id, user_id, message_id, risk, action, reason, model=None) -> None`
  - `storage.audit.recent(chat_id: int, limit: int = 20) -> list[sqlite3.Row]`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_reviews.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_reviews.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'storage.reviews'`

- [ ] **Step 3: Write the implementation**

```python
# storage/reviews.py
"""Grey-zone queue. Text expires after the TTL; the human label does not."""
import sqlite3
from datetime import datetime, timedelta, timezone

import config
from storage import db


def create(chat_id: int, message_id: int, user_id: int, text: str | None,
           verdict_json: str, risk: float) -> int:
    expires = (datetime.now(timezone.utc)
               + timedelta(days=config.REVIEW_TTL_DAYS)).isoformat(timespec="seconds")
    conn = db.connect()
    cursor = conn.execute(
        """INSERT INTO reviews (chat_id, message_id, user_id, text, verdict_json,
                                risk, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (chat_id, message_id, user_id, text, verdict_json, risk, db.now(), expires),
    )
    conn.commit()
    return cursor.lastrowid


def get(review_id: int) -> sqlite3.Row | None:
    return db.connect().execute(
        "SELECT * FROM reviews WHERE id = ?", (review_id,)
    ).fetchone()


def resolve(review_id: int, decision: str, decided_by: int) -> None:
    conn = db.connect()
    conn.execute(
        "UPDATE reviews SET decision = ?, decided_by = ?, decided_at = ? WHERE id = ?",
        (decision, decided_by, db.now(), review_id),
    )
    conn.commit()


def purge_expired() -> int:
    """Clears stored message text past its TTL, keeping the labelled verdict."""
    conn = db.connect()
    cursor = conn.execute(
        "UPDATE reviews SET text = NULL WHERE text IS NOT NULL AND expires_at < ?",
        (db.now(),),
    )
    conn.commit()
    return cursor.rowcount
```

```python
# storage/audit.py
"""Why the bot did what it did. Deliberately stores no message text."""
import sqlite3

from storage import db


def record(chat_id: int, user_id: int, message_id: int | None, risk: float | None,
           action: str, reason: str, model: str | None = None) -> None:
    conn = db.connect()
    conn.execute(
        """INSERT INTO audit (chat_id, user_id, message_id, risk, action, reason,
                              model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (chat_id, user_id, message_id, risk, action, reason, model, db.now()),
    )
    conn.commit()


def recent(chat_id: int, limit: int = 20) -> list[sqlite3.Row]:
    return db.connect().execute(
        "SELECT * FROM audit WHERE chat_id = ? ORDER BY id DESC LIMIT ?",
        (chat_id, limit),
    ).fetchall()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_reviews.py -v`
Expected: PASS, 3 passed

- [ ] **Step 5: Commit**

```bash
git add storage/reviews.py storage/audit.py tests/test_reviews.py
git commit -m "Add review queue with text TTL and a text-free audit log"
```

---

### Task 5: Decision policy

This is the heart of the bot. It is a pure module: no aiogram, no network, no database.

**Files:**
- Create: `core/verdict.py`, `core/policy.py`
- Test: `tests/test_policy.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `core.verdict.Verdict` frozen dataclass: `is_spam: float`, `is_scam: float`, `solicits_contact: float`, `looks_like_member: float`, `kind: str`, `severity: int`, `severity_confidence: float`, `model: str`.
  - `core.policy.Action` str enum: `DELETE = "delete"`, `REVIEW = "review"`, `IGNORE = "ignore"`.
  - `core.policy.Thresholds` frozen dataclass: `delete: float`, `review: float`, `confidence_floor: float`.
  - `core.policy.Decision` frozen dataclass: `action: Action`, `risk: float`, `reason: str`.
  - `core.policy.risk_score(v: Verdict) -> float`
  - `core.policy.decide(v: Verdict, t: Thresholds, *, observing: bool, can_delete: bool, is_admin: bool, is_allowlisted: bool) -> Decision`
  - `core.policy.MEMBER_CEILING = 0.30`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_policy.py
import pytest

from core.policy import Action, Decision, MEMBER_CEILING, Thresholds, decide, risk_score
from core.verdict import Verdict

DEFAULTS = Thresholds(delete=0.90, review=0.55, confidence_floor=0.75)


def verdict(**overrides) -> Verdict:
    base = dict(is_spam=0.0, is_scam=0.0, solicits_contact=0.0, looks_like_member=1.0,
                kind="none", severity=0, severity_confidence=1.0, model="jev-test")
    base.update(overrides)
    return Verdict(**base)


SCAM = dict(is_spam=0.98, is_scam=0.99, solicits_contact=1.0,
            looks_like_member=0.02, kind="crypto", severity=2, severity_confidence=0.95)


def ctx(**overrides):
    base = dict(observing=False, can_delete=True, is_admin=False, is_allowlisted=False)
    base.update(overrides)
    return base


# --- risk score ---

def test_risk_is_zero_for_ordinary_chatter():
    assert risk_score(verdict()) == pytest.approx(0.0)


def test_risk_is_high_for_blatant_scam():
    assert risk_score(verdict(**SCAM)) > 0.90


def test_looks_like_member_pulls_risk_down():
    loud = verdict(is_spam=0.9, severity=1, looks_like_member=0.0)
    friendly = verdict(is_spam=0.9, severity=1, looks_like_member=1.0)
    assert risk_score(friendly) < risk_score(loud)


def test_risk_is_clamped_to_unit_interval():
    assert 0.0 <= risk_score(verdict(**SCAM)) <= 1.0
    assert risk_score(verdict(looks_like_member=1.0)) >= 0.0


# --- bands ---

def test_blatant_scam_is_deleted():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx())
    assert d.action == Action.DELETE
    assert d.reason == "high_confidence_spam"


def test_grey_zone_goes_to_review():
    # risk = 0.60*0.90 + 0.30*0.5 + 0.10*0.50 - 0.25*0.20 = 0.69
    # over the 0.55 review bar, under the 0.90 delete bar.
    grey = verdict(is_spam=0.90, severity=1, severity_confidence=0.60,
                   solicits_contact=0.50, looks_like_member=0.20)
    d = decide(grey, DEFAULTS, **ctx())
    assert 0.55 <= d.risk < 0.90
    assert d.action == Action.REVIEW
    assert d.reason == "grey_zone"


def test_low_risk_is_ignored():
    d = decide(verdict(is_spam=0.2), DEFAULTS, **ctx())
    assert d.action == Action.IGNORE
    assert d.reason == "below_threshold"


# --- the property the whole model choice rests on ---

def test_high_risk_but_low_confidence_is_reviewed_not_deleted():
    unsure = verdict(**{**SCAM, "severity_confidence": 0.40})
    d = decide(unsure, DEFAULTS, **ctx())
    assert d.action == Action.REVIEW, "uncertainty must never delete"
    assert d.risk >= DEFAULTS.delete


def test_severity_zero_never_deletes_however_high_the_risk():
    harmless = verdict(is_spam=1.0, is_scam=1.0, solicits_contact=1.0,
                       looks_like_member=0.0, severity=0, severity_confidence=1.0)
    assert decide(harmless, DEFAULTS, **ctx()).action != Action.DELETE


def test_member_ceiling_blocks_deletion():
    borderline = verdict(**{**SCAM, "looks_like_member": MEMBER_CEILING + 0.01})
    assert decide(borderline, DEFAULTS, **ctx()).action != Action.DELETE


# --- guards ---

def test_admins_are_never_touched():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(is_admin=True))
    assert d.action == Action.IGNORE
    assert d.reason == "admin"


def test_allowlisted_users_are_never_touched():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(is_allowlisted=True))
    assert d.action == Action.IGNORE
    assert d.reason == "allowlisted"


def test_observation_mode_downgrades_delete_to_review():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(observing=True))
    assert d.action == Action.REVIEW
    assert d.reason == "observing"


def test_missing_delete_permission_downgrades_to_review():
    d = decide(verdict(**SCAM), DEFAULTS, **ctx(can_delete=False))
    assert d.action == Action.REVIEW
    assert d.reason == "no_delete_permission"


def test_thresholds_are_configurable():
    strict = Thresholds(delete=0.99, review=0.95, confidence_floor=0.99)
    d = decide(verdict(**SCAM), strict, **ctx())
    assert d.action == Action.REVIEW
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_policy.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.policy'`

- [ ] **Step 3: Write the implementation**

```python
# core/verdict.py
"""What Jev answered about one message. No I/O, no dependencies."""
from dataclasses import asdict, dataclass

KINDS = ("crypto", "job_mule", "phishing", "porn", "channel_promo", "impersonation", "none")


@dataclass(frozen=True)
class Verdict:
    is_spam: float
    is_scam: float
    solicits_contact: float
    looks_like_member: float
    kind: str
    severity: int
    severity_confidence: float
    model: str

    def as_dict(self) -> dict:
        return asdict(self)
```

```python
# core/policy.py
"""Probabilities in, decision out. Pure: no aiogram, no network, no database.

Tuning the bot means changing the coefficients here and re-running the tests
against the recorded corpus - not rewriting a prompt.
"""
from dataclasses import dataclass
from enum import Enum

from core.verdict import Verdict

# Weights on the positive terms sum to 1.0; the counterweight is subtracted.
W_BASE = 0.60
W_SEVERITY = 0.30
W_SOLICITS = 0.10
W_MEMBER = 0.25

# A message that reads this much like ordinary community chatter is never
# deleted automatically, however high the rest of the signals run.
MEMBER_CEILING = 0.30


class Action(str, Enum):
    DELETE = "delete"
    REVIEW = "review"
    IGNORE = "ignore"


@dataclass(frozen=True)
class Thresholds:
    delete: float
    review: float
    confidence_floor: float


@dataclass(frozen=True)
class Decision:
    action: Action
    risk: float
    reason: str


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def risk_score(v: Verdict) -> float:
    base = max(v.is_spam, v.is_scam)
    severity = v.severity / 2.0
    return _clamp(
        W_BASE * base
        + W_SEVERITY * severity
        + W_SOLICITS * v.solicits_contact
        - W_MEMBER * v.looks_like_member
    )


def decide(v: Verdict, t: Thresholds, *, observing: bool, can_delete: bool,
           is_admin: bool, is_allowlisted: bool) -> Decision:
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
        if not can_delete:
            return Decision(Action.REVIEW, risk, "no_delete_permission")
        return Decision(Action.DELETE, risk, "high_confidence_spam")

    if risk >= t.review:
        return Decision(Action.REVIEW, risk, "grey_zone")
    return Decision(Action.IGNORE, risk, "below_threshold")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_policy.py -v`
Expected: PASS, 14 passed

- [ ] **Step 5: Commit**

```bash
git add core/verdict.py core/policy.py tests/test_policy.py
git commit -m "Add pure decision policy with confidence-gated deletion"
```

---

### Task 6: Message facts and Jev state payload

**Files:**
- Create: `core/state.py`
- Test: `tests/test_state.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (aiogram types only in `facts_from_message`).
- Produces:
  - `core.state.MessageFacts` frozen dataclass: `text: str`, `link_domains: tuple[str, ...]`, `link_count: int`, `has_invite_link: bool`, `is_forward: bool`, `media_type: str | None`, `is_caption: bool`, `author_message_count: int`, `author_days_in_group: float | None`, `author_has_username: bool`, `group_title: str`, `group_description: str`.
  - `core.state.build_state(facts: MessageFacts) -> str` — pure, returns the structured document sent to Jev.
  - `core.state.facts_from_message(message, *, author_message_count: int, author_days_in_group: float | None, group_description: str) -> MessageFacts` — takes an `aiogram.types.Message`.
  - `core.state.MAX_TEXT = 2000`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_state.py
from datetime import datetime, timezone

from aiogram.types import Chat, Message, User

from core.state import MAX_TEXT, MessageFacts, build_state, facts_from_message

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def facts(**overrides) -> MessageFacts:
    base = dict(text="hello", link_domains=(), link_count=0, has_invite_link=False,
                is_forward=False, media_type=None, is_caption=False,
                author_message_count=3, author_days_in_group=10.0,
                author_has_username=True, group_title="Python Chat",
                group_description="Talk about Python")
    base.update(overrides)
    return MessageFacts(**base)


def test_state_contains_message_and_context():
    state = build_state(facts(text="buy cheap followers"))
    assert "buy cheap followers" in state
    assert "Python Chat" in state
    assert "Talk about Python" in state


def test_state_reports_author_history():
    state = build_state(facts(author_message_count=0, author_days_in_group=0.001))
    assert "0" in state
    assert "messages" in state.lower()


def test_long_text_is_truncated():
    state = build_state(facts(text="x" * (MAX_TEXT + 500)))
    assert "x" * MAX_TEXT in state
    assert "x" * (MAX_TEXT + 1) not in state


def test_state_is_deterministic():
    assert build_state(facts()) == build_state(facts())


def test_facts_extract_links_and_invite():
    message = Message(
        message_id=1, date=NOW, chat=Chat(id=-100, type="supergroup", title="Python Chat"),
        from_user=User(id=5, is_bot=False, first_name="Ann", username="ann"),
        text="see https://evil.example/win and t.me/joinchat/AAA",
    )
    extracted = facts_from_message(
        message, author_message_count=0, author_days_in_group=0.0,
        group_description="Talk about Python",
    )
    assert "evil.example" in extracted.link_domains
    assert extracted.link_count == 2
    assert extracted.has_invite_link is True
    assert extracted.author_has_username is True


def test_facts_handle_caption_only_media():
    message = Message(
        message_id=2, date=NOW, chat=Chat(id=-100, type="supergroup", title="Python Chat"),
        from_user=User(id=5, is_bot=False, first_name="Ann"),
        caption="earn 500 a day", photo=[],
    )
    extracted = facts_from_message(
        message, author_message_count=0, author_days_in_group=None, group_description="",
    )
    assert extracted.text == "earn 500 a day"
    assert extracted.is_caption is True
    assert extracted.author_has_username is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_state.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.state'`

- [ ] **Step 3: Write the implementation**

```python
# core/state.py
"""Builds the structured state Jev evaluates.

Jev is built for structured program state, so we hand it a labelled document
rather than raw text: identical wording means different things from a five-year
member and from an account that joined ninety seconds ago.
"""
import re
from dataclasses import dataclass
from urllib.parse import urlparse

MAX_TEXT = 2000

_URL_RE = re.compile(r"(?:https?://|www\.|t\.me/)[^\s<>()]+", re.IGNORECASE)
_INVITE_RE = re.compile(r"(?:t\.me/(?:joinchat/|\+)|telegram\.me/joinchat/)", re.IGNORECASE)

_MEDIA_ATTRS = ("photo", "video", "animation", "document", "audio", "voice",
                "video_note", "sticker")


@dataclass(frozen=True)
class MessageFacts:
    text: str
    link_domains: tuple[str, ...]
    link_count: int
    has_invite_link: bool
    is_forward: bool
    media_type: str | None
    is_caption: bool
    author_message_count: int
    author_days_in_group: float | None
    author_has_username: bool
    group_title: str
    group_description: str


def _domain(raw: str) -> str:
    candidate = raw if "://" in raw else f"http://{raw}"
    host = urlparse(candidate).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def build_state(facts: MessageFacts) -> str:
    age = ("unknown" if facts.author_days_in_group is None
           else f"{facts.author_days_in_group:.1f} days")
    lines = [
        "# Group",
        f"title: {facts.group_title}",
        f"description: {facts.group_description or '(none)'}",
        "",
        "# Author",
        f"messages previously sent in this group: {facts.author_message_count}",
        f"time in this group: {age}",
        f"has a username: {'yes' if facts.author_has_username else 'no'}",
        "",
        "# Message",
        f"is a media caption: {'yes' if facts.is_caption else 'no'}",
        f"media type: {facts.media_type or '(none)'}",
        f"forwarded: {'yes' if facts.is_forward else 'no'}",
        f"link count: {facts.link_count}",
        f"link domains: {', '.join(facts.link_domains) or '(none)'}",
        f"contains a Telegram invite link: {'yes' if facts.has_invite_link else 'no'}",
        "",
        "# Text",
        facts.text[:MAX_TEXT],
    ]
    return "\n".join(lines)


def facts_from_message(message, *, author_message_count: int,
                       author_days_in_group: float | None,
                       group_description: str) -> MessageFacts:
    text = message.text or message.caption or ""
    urls = _URL_RE.findall(text)
    media_type = next((name for name in _MEDIA_ATTRS
                       if getattr(message, name, None) is not None), None)
    return MessageFacts(
        text=text,
        link_domains=tuple(dict.fromkeys(_domain(u) for u in urls)),
        link_count=len(urls),
        has_invite_link=bool(_INVITE_RE.search(text)),
        is_forward=bool(getattr(message, "forward_origin", None)),
        media_type=media_type,
        is_caption=message.text is None and message.caption is not None,
        author_message_count=author_message_count,
        author_days_in_group=author_days_in_group,
        author_has_username=bool(message.from_user and message.from_user.username),
        group_title=message.chat.title or "",
        group_description=group_description or "",
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_state.py -v`
Expected: PASS, 6 passed

- [ ] **Step 5: Commit**

```bash
git add core/state.py tests/test_state.py
git commit -m "Add structured state builder and message fact extraction"
```

---

### Task 7: Jev client and fake

**Files:**
- Create: `core/jev.py`, `tests/fixtures/__init__.py`, `tests/fixtures/verdicts.py`
- Test: `tests/test_jev.py`

**Interfaces:**
- Consumes: `core.verdict.Verdict`, `config.JEV_MODEL`, `config.JEV_TIMEOUT`, `config.TYPESAFE_API_KEY`.
- Produces:
  - `core.jev.QUESTIONS` — the question dict passed to the SDK.
  - `core.jev.JevError` exception, raised for any API or network failure.
  - `core.jev.JevClient` Protocol with `async def classify(self, state: str) -> Verdict`.
  - `core.jev.TypeSafeJevClient` — real implementation; the synchronous SDK call runs in `asyncio.to_thread` with `config.JEV_TIMEOUT`.
  - `core.jev.FakeJevClient(verdicts: dict[str, Verdict], default: Verdict | None = None, fail: bool = False)` — matches on a substring of the state; raises `JevError` when `fail=True`; exposes `calls: list[str]`.
  - `tests.fixtures.verdicts.SCAM`, `.SPAM`, `.CHATTER`, `.UNSURE` — ready-made `Verdict` values.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_jev.py
import pytest

from core.jev import FakeJevClient, JevError, QUESTIONS
from tests.fixtures.verdicts import CHATTER, SCAM


def test_questions_cover_the_spec():
    assert set(QUESTIONS) == {
        "is_spam", "is_scam", "solicits_contact", "looks_like_member", "kind", "severity",
    }


def test_kind_offers_every_spec_category():
    from core.verdict import KINDS
    assert set(QUESTIONS["kind"].criteria) == set(KINDS)


def test_severity_rubric_has_three_levels():
    assert len(QUESTIONS["severity"].criteria) == 3


async def test_fake_matches_on_state_substring():
    client = FakeJevClient({"buy crypto": SCAM}, default=CHATTER)
    assert await client.classify("please buy crypto now") == SCAM
    assert await client.classify("good morning everyone") == CHATTER


async def test_fake_records_calls():
    client = FakeJevClient({}, default=CHATTER)
    await client.classify("hello")
    assert client.calls == ["hello"]


async def test_fake_can_simulate_an_outage():
    client = FakeJevClient({}, default=CHATTER, fail=True)
    with pytest.raises(JevError):
        await client.classify("hello")
```

```python
# tests/fixtures/verdicts.py
"""Ready-made verdicts standing in for real Jev answers."""
from core.verdict import Verdict

SCAM = Verdict(is_spam=0.98, is_scam=0.99, solicits_contact=1.0, looks_like_member=0.02,
               kind="crypto", severity=2, severity_confidence=0.95, model="jev-test")

SPAM = Verdict(is_spam=0.94, is_scam=0.10, solicits_contact=0.80, looks_like_member=0.05,
               kind="channel_promo", severity=1, severity_confidence=0.88, model="jev-test")

CHATTER = Verdict(is_spam=0.02, is_scam=0.01, solicits_contact=0.0, looks_like_member=0.98,
                  kind="none", severity=0, severity_confidence=0.99, model="jev-test")

UNSURE = Verdict(is_spam=0.92, is_scam=0.70, solicits_contact=0.9, looks_like_member=0.20,
                 kind="job_mule", severity=2, severity_confidence=0.40, model="jev-test")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_jev.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.jev'`

- [ ] **Step 3: Write the implementation**

```python
# core/jev.py
"""The only module that talks to the TypeSafe API.

Every question is atomic on purpose: TypeSafe evaluates them in parallel against
the same state, so asking six narrow questions costs about as much as one broad
one and gives the policy something to combine in code.
"""
import asyncio
from typing import Protocol

from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul, Score, TypeSafeError

import config
from core.verdict import Verdict

SEVERITY_RUBRIC = [
    "Harmless self-promotion or an on-topic mention of the author's own work",
    "Clear unsolicited spam: advertising or mass-posted content nobody asked for",
    "Active fraud: an attempt to take money, credentials or accounts from the reader",
]

QUESTIONS = {
    "is_spam": Noul(
        instructions="The message is unsolicited promotion, advertising, "
                     "or mass-posted content.",
    ),
    "is_scam": Noul(
        instructions="The message attempts to defraud the reader: fake earnings, "
                     "crypto giveaways, phishing, impersonated support, or requests "
                     "for credentials or a seed phrase.",
    ),
    "solicits_contact": Noul(
        instructions="The message pushes the reader to move to a private message "
                     "or an external channel.",
    ),
    "looks_like_member": Noul(
        instructions="This reads as an ordinary message from a member of this "
                     "community, given the group's topic.",
    ),
    "kind": Choice(
        instructions="Which category best describes this message",
        criteria={
            "crypto": "Crypto investment, trading signals, giveaways or wallet drainers",
            "job_mule": "Fake job or easy-money offer, often money-mule recruitment",
            "phishing": "Credential theft, fake login or fake support",
            "porn": "Adult content or dating spam",
            "channel_promo": "Promoting another channel, group or bot",
            "impersonation": "Pretending to be an admin, support or a known brand",
            "none": "Not spam of any kind",
        },
    ),
    "severity": Score(
        instructions="How harmful this message is to the group",
        criteria=SEVERITY_RUBRIC,
    ),
}


class JevError(RuntimeError):
    """Any failure reaching or parsing a Jev answer."""


class JevClient(Protocol):
    async def classify(self, state: str) -> Verdict: ...


class TypeSafeJevClient:
    """Real client, over the SDK's native async interface.

    Verified against the installed typesafe-sdk: AsyncTypeSafeClient takes
    api_key/model/timeout as keyword arguments, system_one takes state and
    questions positionally with model and timeout keyword-only, and every SDK
    failure derives from TypeSafeError.
    """

    def __init__(self, api_key: str | None = None, model: str | None = None,
                 timeout: float | None = None) -> None:
        self._model = model or config.JEV_MODEL
        self._timeout = timeout or config.JEV_TIMEOUT
        self._client = AsyncTypeSafeClient(
            api_key=api_key or config.TYPESAFE_API_KEY,
            model=self._model,
            timeout=self._timeout,
        )

    async def classify(self, state: str) -> Verdict:
        try:
            response = await self._client.system_one(
                state, QUESTIONS, model=self._model, timeout=self._timeout,
            )
        except TypeSafeError as exc:
            raise JevError(f"{type(exc).__name__}: {exc}") from exc
        except asyncio.TimeoutError as exc:
            raise JevError(f"jev timed out after {self._timeout}s") from exc
        return self._to_verdict(response)

    @staticmethod
    def _to_verdict(response) -> Verdict:
        try:
            answers = response.answers
            severity = answers["severity"]
            return Verdict(
                is_spam=answers["is_spam"].noul,
                is_scam=answers["is_scam"].noul,
                solicits_contact=answers["solicits_contact"].noul,
                looks_like_member=answers["looks_like_member"].noul,
                kind=answers["kind"].choice,
                severity=int(severity.score),
                severity_confidence=severity.confidence,
                model=getattr(response, "model", "jev"),
            )
        except (AttributeError, KeyError, TypeError, ValueError) as exc:
            raise JevError(f"unexpected Jev response shape: {exc}") from exc


class FakeJevClient:
    """Test double. Matches a substring of the state to a canned verdict."""

    def __init__(self, verdicts: dict[str, Verdict], default: Verdict | None = None,
                 fail: bool = False) -> None:
        self._verdicts = verdicts
        self._default = default
        self._fail = fail
        self.calls: list[str] = []

    async def classify(self, state: str) -> Verdict:
        self.calls.append(state)
        if self._fail:
            raise JevError("simulated outage")
        for needle, verdict in self._verdicts.items():
            if needle.lower() in state.lower():
                return verdict
        if self._default is None:
            raise JevError(f"no canned verdict matches: {state[:60]!r}")
        return self._default
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_jev.py -v`
Expected: PASS, 6 passed

- [ ] **Step 5: Commit**

```bash
git add core/jev.py tests/test_jev.py tests/fixtures
git commit -m "Add Jev client with atomic questions and an offline fake"
```

---

### Task 8: Gate — deciding what needs checking

**Files:**
- Create: `core/gate.py`
- Test: `tests/test_gate.py`

**Interfaces:**
- Consumes: `core.state.MessageFacts`, `storage.trust.TrustRow` field names, `config.RECHECK_AFTER_DAYS`.
- Produces:
  - `core.gate.GateResult` frozen dataclass: `check: bool`, `reason: str`.
  - `core.gate.has_trigger(facts: MessageFacts) -> bool`
  - `core.gate.needs_check(*, status: str, clean_count: int, trust_after: int, days_since_seen: float | None, facts: MessageFacts) -> GateResult`

Reasons produced: `allowlisted`, `flagged`, `low_history`, `trigger`, `returned_after_silence`, `trusted`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_gate.py
from core.gate import has_trigger, needs_check
from core.state import MessageFacts


def facts(**overrides) -> MessageFacts:
    base = dict(text="hello", link_domains=(), link_count=0, has_invite_link=False,
                is_forward=False, media_type=None, is_caption=False,
                author_message_count=9, author_days_in_group=100.0,
                author_has_username=True, group_title="G", group_description="")
    base.update(overrides)
    return MessageFacts(**base)


def gate(**overrides):
    base = dict(status="unknown", clean_count=0, trust_after=5,
                days_since_seen=1.0, facts=facts())
    base.update(overrides)
    return needs_check(**base)


def test_newcomer_is_checked():
    result = gate()
    assert result.check is True
    assert result.reason == "low_history"


def test_trusted_member_is_skipped():
    result = gate(status="trusted", clean_count=5)
    assert result.check is False
    assert result.reason == "trusted"


def test_allowlisted_is_never_checked():
    result = gate(status="allowlisted", clean_count=0)
    assert result.check is False
    assert result.reason == "allowlisted"


def test_flagged_is_always_checked():
    result = gate(status="flagged", clean_count=999)
    assert result.check is True
    assert result.reason == "flagged"


def test_trusted_member_posting_a_link_is_rechecked():
    result = gate(status="trusted", clean_count=50,
                  facts=facts(link_count=1, link_domains=("evil.example",)))
    assert result.check is True
    assert result.reason == "trigger"


def test_trusted_member_posting_media_with_caption_is_rechecked():
    result = gate(status="trusted", clean_count=50,
                  facts=facts(media_type="photo", is_caption=True))
    assert result.check is True


def test_trusted_member_returning_after_long_silence_is_rechecked():
    result = gate(status="trusted", clean_count=50, days_since_seen=45.0)
    assert result.check is True
    assert result.reason == "returned_after_silence"


def test_plain_text_from_trusted_member_costs_no_api_call():
    assert gate(status="trusted", clean_count=50, days_since_seen=2.0).check is False


def test_trigger_detection():
    assert has_trigger(facts(link_count=1)) is True
    assert has_trigger(facts(has_invite_link=True)) is True
    assert has_trigger(facts(is_forward=True)) is True
    assert has_trigger(facts(media_type="photo", is_caption=True)) is True
    assert has_trigger(facts(media_type="sticker", is_caption=False)) is False
    assert has_trigger(facts()) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_gate.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.gate'`

- [ ] **Step 3: Write the implementation**

```python
# core/gate.py
"""Decides whether a message is worth an API call at all.

Spam in Telegram comes overwhelmingly from accounts with no history, so a member
who has behaved for a while stops being checked. Trust is not permanent: the
trigger set still applies to everyone, which is the defence against a
long-standing account that has been compromised.
"""
from dataclasses import dataclass

import config
from core.state import MessageFacts


@dataclass(frozen=True)
class GateResult:
    check: bool
    reason: str


def has_trigger(facts: MessageFacts) -> bool:
    return bool(
        facts.link_count
        or facts.has_invite_link
        or facts.is_forward
        or (facts.media_type and facts.is_caption)
    )


def needs_check(*, status: str, clean_count: int, trust_after: int,
                days_since_seen: float | None, facts: MessageFacts) -> GateResult:
    if status == "allowlisted":
        return GateResult(False, "allowlisted")
    if status == "flagged":
        return GateResult(True, "flagged")
    if clean_count < trust_after or status == "unknown":
        return GateResult(True, "low_history")
    if has_trigger(facts):
        return GateResult(True, "trigger")
    if days_since_seen is not None and days_since_seen > config.RECHECK_AFTER_DAYS:
        return GateResult(True, "returned_after_silence")
    return GateResult(False, "trusted")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_gate.py -v`
Expected: PASS, 9 passed

- [ ] **Step 5: Commit**

```bash
git add core/gate.py tests/test_gate.py
git commit -m "Add trust gate so checked traffic is newcomers and triggers only"
```

---

### Task 9: Pipeline — wiring gate, state, Jev and policy

**Files:**
- Create: `core/pipeline.py`
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `core.gate`, `core.state`, `core.jev`, `core.policy`, `storage.chats`, `storage.trust`, `storage.audit`.
- Produces:
  - `core.pipeline.Outcome` frozen dataclass: `decision: Decision | None`, `verdict: Verdict | None`, `facts: MessageFacts | None`, `skipped: str | None`.
  - `core.pipeline.evaluate(client, *, chat, facts, trust_row, is_admin, can_delete) -> Outcome` where `chat` is a `ChatConfig` and `trust_row` a `TrustRow`. Records its own audit row. Never raises on a Jev failure.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_pipeline.py
import os
import tempfile

import pytest

from core.jev import FakeJevClient
from core.policy import Action
from core.state import MessageFacts
from tests.fixtures.verdicts import CHATTER, SCAM, UNSURE


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


def facts(**overrides) -> MessageFacts:
    base = dict(text="buy crypto now", link_domains=(), link_count=0,
                has_invite_link=False, is_forward=False, media_type=None,
                is_caption=False, author_message_count=0, author_days_in_group=0.0,
                author_has_username=False, group_title="G", group_description="")
    base.update(overrides)
    return MessageFacts(**base)


def active_chat(**overrides):
    from storage import chats
    chat = chats.ensure_chat(-100, "G")
    fields = dict(mode="active", observe_until="2020-01-01T00:00:00+00:00")
    fields.update(overrides)
    return chats.update_chat(-100, **fields)


def trust_row(**overrides):
    from storage import trust
    trust.seen(-100, 555)
    return trust.get(-100, 555)


async def run(client, *, chat=None, message_facts=None, is_admin=False, can_delete=True):
    from core import pipeline
    return await pipeline.evaluate(
        client,
        chat=chat or active_chat(),
        facts=message_facts or facts(),
        trust_row=trust_row(),
        is_admin=is_admin,
        can_delete=can_delete,
    )


async def test_scam_from_newcomer_is_deleted():
    outcome = await run(FakeJevClient({"buy crypto": SCAM}))
    assert outcome.decision.action == Action.DELETE
    assert outcome.verdict == SCAM


async def test_trusted_member_never_reaches_the_api():
    from storage import trust
    trust.seen(-100, 555)
    for _ in range(5):
        trust.record_clean(-100, 555, trust_after=5)
    from core import pipeline
    client = FakeJevClient({}, default=CHATTER)
    outcome = await pipeline.evaluate(
        client, chat=active_chat(), facts=facts(text="morning all"),
        trust_row=trust.get(-100, 555), is_admin=False, can_delete=True,
    )
    assert outcome.skipped == "trusted"
    assert outcome.decision is None
    assert client.calls == [], "the gate must short-circuit before the API"


async def test_jev_disabled_for_chat_skips_the_api():
    client = FakeJevClient({}, default=SCAM)
    outcome = await run(client, chat=active_chat(jev_enabled=False))
    assert outcome.skipped == "jev_disabled"
    assert client.calls == []


async def test_outage_never_deletes():
    outcome = await run(FakeJevClient({}, fail=True))
    assert outcome.decision is None
    assert outcome.skipped == "jev_unavailable"


async def test_outage_with_trigger_still_reaches_a_human():
    outcome = await run(
        FakeJevClient({}, fail=True),
        message_facts=facts(link_count=1, link_domains=("evil.example",)),
    )
    assert outcome.skipped == "jev_unavailable_flagged"


async def test_uncertain_verdict_is_reviewed():
    outcome = await run(FakeJevClient({"buy crypto": UNSURE}))
    assert outcome.decision.action == Action.REVIEW


async def test_observation_mode_downgrades_to_review():
    outcome = await run(
        FakeJevClient({"buy crypto": SCAM}),
        chat=active_chat(observe_until="2999-01-01T00:00:00+00:00"),
    )
    assert outcome.decision.action == Action.REVIEW
    assert outcome.decision.reason == "observing"


async def test_clean_message_builds_trust():
    from storage import trust
    await run(FakeJevClient({}, default=CHATTER), message_facts=facts(text="morning all"))
    assert trust.get(-100, 555).clean_count == 1


async def test_every_evaluation_is_audited():
    from storage import audit
    await run(FakeJevClient({"buy crypto": SCAM}))
    row = audit.recent(-100)[0]
    assert row["action"] == "delete"
    assert row["model"] == "jev-test"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_pipeline.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.pipeline'`

- [ ] **Step 3: Write the implementation**

```python
# core/pipeline.py
"""update -> gate -> state -> jev -> policy. Failure always resolves downward."""
import logging
from dataclasses import dataclass

from core import gate, policy, state
from core.jev import JevClient, JevError
from core.policy import Action, Decision, Thresholds
from core.state import MessageFacts
from core.verdict import Verdict
from storage import audit, chats, trust
from storage.chats import ChatConfig
from storage.trust import TrustRow

log = logging.getLogger("stopspam.pipeline")


@dataclass(frozen=True)
class Outcome:
    decision: Decision | None
    verdict: Verdict | None
    facts: MessageFacts | None
    skipped: str | None


async def evaluate(client: JevClient, *, chat: ChatConfig, facts: MessageFacts,
                   trust_row: TrustRow, is_admin: bool, can_delete: bool) -> Outcome:
    if is_admin:
        return Outcome(None, None, facts, "admin")

    if not chat.jev_enabled:
        return Outcome(None, None, facts, "jev_disabled")

    gated = gate.needs_check(
        status=trust_row.status,
        clean_count=trust_row.clean_count,
        trust_after=chat.trust_after,
        days_since_seen=trust.days_since_seen(trust_row),
        facts=facts,
    )
    if not gated.check:
        return Outcome(None, None, facts, gated.reason)

    try:
        verdict = await client.classify(state.build_state(facts))
    except JevError as exc:
        log.warning("jev unavailable for chat %s: %s", chat.chat_id, exc)
        reason = "jev_unavailable_flagged" if gate.has_trigger(facts) else "jev_unavailable"
        audit.record(chat.chat_id, trust_row.user_id, None, None, "failed", reason)
        return Outcome(None, None, facts, reason)

    decision = policy.decide(
        verdict,
        Thresholds(chat.delete_threshold, chat.review_threshold, chat.confidence_floor),
        observing=chats.is_observing(chat),
        can_delete=can_delete,
        is_admin=False,
        is_allowlisted=trust_row.status == trust.ALLOWLISTED,
    )

    if decision.action == Action.IGNORE:
        trust.record_clean(chat.chat_id, trust_row.user_id, chat.trust_after)
    else:
        trust.mark_flagged(chat.chat_id, trust_row.user_id)

    audit.record(chat.chat_id, trust_row.user_id, None, decision.risk,
                 decision.action.value, decision.reason, model=verdict.model)
    return Outcome(decision, verdict, facts, None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_pipeline.py -v`
Expected: PASS, 9 passed

- [ ] **Step 5: Commit**

```bash
git add core/pipeline.py tests/test_pipeline.py
git commit -m "Wire gate, state, Jev and policy into the evaluation pipeline"
```

---

### Task 10: Texts and review card rendering

**Files:**
- Create: `texts.py`, `core/cards.py`
- Test: `tests/test_cards.py`

**Interfaces:**
- Consumes: `core.verdict.Verdict`, `core.policy.Decision`.
- Produces:
  - `texts.t(key: str, lang: str = "en", **kwargs) -> str` — lookup with `en` fallback for any missing translation.
  - `texts.STRINGS: dict[str, dict[str, str]]` — `{key: {lang: template}}`.
  - `core.cards.render_card(*, decision, verdict, author_name, author_id, text, chat_title, lang) -> str` — HTML body of a review card.
  - `core.cards.card_keyboard(review_id: int, lang: str) -> InlineKeyboardMarkup` — callback data `rv:<action>:<review_id>` where action is `ban`, `del`, `ok`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_cards.py
from core.cards import card_keyboard, render_card
from core.policy import Action, Decision
from tests.fixtures.verdicts import SCAM


def test_card_shows_why_it_fired():
    body = render_card(
        decision=Decision(Action.REVIEW, 0.93, "grey_zone"), verdict=SCAM,
        author_name="Ann", author_id=555, text="buy crypto now",
        chat_title="Python Chat", lang="en",
    )
    assert "0.93" in body
    assert "crypto" in body
    assert "buy crypto now" in body
    assert "Ann" in body


def test_card_escapes_html_in_user_text():
    body = render_card(
        decision=Decision(Action.REVIEW, 0.60, "grey_zone"), verdict=SCAM,
        author_name="<b>Ann</b>", author_id=555, text="<script>alert(1)</script>",
        chat_title="G", lang="en",
    )
    assert "<script>" not in body
    assert "&lt;script&gt;" in body
    assert "<b>Ann</b>" not in body


def test_card_truncates_very_long_text():
    body = render_card(
        decision=Decision(Action.REVIEW, 0.60, "grey_zone"), verdict=SCAM,
        author_name="Ann", author_id=555, text="x" * 5000,
        chat_title="G", lang="en",
    )
    assert len(body) < 4096, "must fit in one Telegram message"


def test_keyboard_carries_the_review_id():
    markup = card_keyboard(42, "en")
    data = [b.callback_data for row in markup.inline_keyboard for b in row]
    assert data == ["rv:ban:42", "rv:del:42", "rv:ok:42"]


def test_unknown_language_falls_back_to_english():
    from texts import t
    assert t("card_title", lang="xx") == t("card_title", lang="en")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_cards.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'core.cards'`

- [ ] **Step 3: Write the implementation**

```python
# texts.py
"""All user-visible strings. English is the default and the fallback."""

STRINGS: dict[str, dict[str, str]] = {
    "card_title": {"en": "Possible spam", "ru": "Похоже на спам"},
    "card_author": {"en": "Author", "ru": "Автор"},
    "card_chat": {"en": "Chat", "ru": "Чат"},
    "card_risk": {"en": "Risk", "ru": "Риск"},
    "card_kind": {"en": "Kind", "ru": "Тип"},
    "card_breakdown": {"en": "Breakdown", "ru": "Разбор"},
    "card_deleted": {"en": "Deleted automatically", "ru": "Удалено автоматически"},
    "btn_ban": {"en": "Delete & ban", "ru": "Удалить и забанить"},
    "btn_delete": {"en": "Delete", "ru": "Удалить"},
    "btn_not_spam": {"en": "Not spam", "ru": "Не спам"},
    "done_ban": {"en": "Deleted and banned.", "ru": "Удалено, автор забанен."},
    "done_delete": {"en": "Deleted.", "ru": "Удалено."},
    "done_not_spam": {
        "en": "Marked as not spam. This user is now allowlisted here.",
        "ru": "Отмечено как не спам. Автор добавлен в белый список этого чата.",
    },
    "already_handled": {"en": "Already handled.", "ru": "Уже обработано."},
    "not_admin": {
        "en": "Only admins of that chat can use these buttons.",
        "ru": "Эти кнопки доступны только админам чата.",
    },
}


def t(key: str, lang: str = "en", **kwargs) -> str:
    template = STRINGS.get(key, {}).get(lang) or STRINGS.get(key, {}).get("en", key)
    return template.format(**kwargs) if kwargs else template
```

```python
# core/cards.py
"""Rendering of review cards. Shows the per-question breakdown so an admin can
see why the bot fired, not just that it did."""
import html

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from core.policy import Decision
from core.verdict import Verdict
from texts import t

MAX_QUOTE = 700


def render_card(*, decision: Decision, verdict: Verdict, author_name: str,
                author_id: int, text: str | None, chat_title: str, lang: str) -> str:
    quote = (text or "")[:MAX_QUOTE]
    if text and len(text) > MAX_QUOTE:
        quote += "…"
    return "\n".join([
        f"<b>{html.escape(t('card_title', lang))}</b>",
        f"{html.escape(t('card_chat', lang))}: {html.escape(chat_title)}",
        f"{html.escape(t('card_author', lang))}: "
        f"{html.escape(author_name)} (<code>{author_id}</code>)",
        f"{html.escape(t('card_risk', lang))}: {decision.risk:.2f} ({decision.reason})",
        f"{html.escape(t('card_kind', lang))}: {html.escape(verdict.kind)}",
        "",
        f"<b>{html.escape(t('card_breakdown', lang))}</b>",
        f"<code>spam {verdict.is_spam:.2f} · scam {verdict.is_scam:.2f} · "
        f"contact {verdict.solicits_contact:.2f} · member {verdict.looks_like_member:.2f}\n"
        f"severity {verdict.severity} (confidence {verdict.severity_confidence:.2f})</code>",
        "",
        f"<blockquote>{html.escape(quote)}</blockquote>",
    ])


def card_keyboard(review_id: int, lang: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text=t("btn_ban", lang), callback_data=f"rv:ban:{review_id}"),
        InlineKeyboardButton(text=t("btn_delete", lang), callback_data=f"rv:del:{review_id}"),
        InlineKeyboardButton(text=t("btn_not_spam", lang), callback_data=f"rv:ok:{review_id}"),
    ]])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_cards.py -v`
Expected: PASS, 5 passed

- [ ] **Step 5: Commit**

```bash
git add texts.py core/cards.py tests/test_cards.py
git commit -m "Add translatable strings and review card rendering"
```

---

### Task 11: Group handler and enforcement

**Files:**
- Create: `handlers/group.py`, `core/actions.py`
- Test: `tests/test_group_handler.py`

**Interfaces:**
- Consumes: `core.pipeline.evaluate`, `core.cards`, `storage.*`.
- Produces:
  - `core.actions.EnforcementLimiter(per_minute: int)` with `allow(chat_id: int) -> bool`.
  - `core.actions.apply(bot, *, message, outcome, chat) -> str` — performs the deletion and/or posts the card; returns one of `deleted`, `reviewed`, `ignored`, `rate_limited`.
  - `handlers.group.router` — an `aiogram.Router` handling group and supergroup messages.
  - `handlers.group.set_client(client)` — injects the `JevClient` used by the router.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_group_handler.py
import os
import tempfile
from datetime import datetime, timezone

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.methods import DeleteMessage, GetChatMember, GetMe, SendMessage
from aiogram.types import Chat, ChatMemberMember, ChatMemberOwner, Message, Update, User

from core.jev import FakeJevClient
from tests.fixtures.verdicts import CHATTER, SCAM

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
GROUP, SPAMMER, LOG = -100123, 555, -100999
calls: list = []


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
    yield
    db.reset()


async def fake_call(self, method, request_timeout=None):
    calls.append(method)
    if isinstance(method, GetMe):
        return User(id=1, is_bot=True, first_name="StopSpam", username="StopSpam_jev_bot")
    if isinstance(method, SendMessage):
        return Message(message_id=9001, date=NOW,
                       chat=Chat(id=method.chat_id, type="supergroup"), text=method.text)
    if isinstance(method, GetChatMember):
        if method.user_id == SPAMMER:
            return ChatMemberMember(
                user=User(id=SPAMMER, is_bot=False, first_name="Ann"), status="member")
        return ChatMemberOwner(
            user=User(id=method.user_id, is_bot=False, first_name="Boss"),
            status="creator", is_anonymous=False)
    return True


Bot.__call__ = fake_call


def group_message(text: str, user_id: int = SPAMMER, msg_id: int = 1) -> Update:
    message = Message(
        message_id=msg_id, date=NOW,
        chat=Chat(id=GROUP, type="supergroup", title="Python Chat"),
        from_user=User(id=user_id, is_bot=False, first_name="Ann", username="ann"),
        text=text,
    )
    return Update(update_id=msg_id, message=message)


async def feed(update: Update, client: FakeJevClient, *, active: bool = True):
    from handlers import group
    from storage import chats
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(
        GROUP, log_chat_id=LOG,
        mode="active" if active else "observe",
        observe_until="2020-01-01T00:00:00+00:00" if active else "2999-01-01T00:00:00+00:00",
    )
    group.set_client(client)
    bot = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dispatcher = Dispatcher()
    dispatcher.include_router(group.router)
    await dispatcher.feed_update(bot, update)


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


async def test_outage_deletes_nothing():
    await feed(group_message("buy crypto now"), FakeJevClient({}, fail=True))
    assert deletions() == []


async def test_review_row_is_created_for_the_card():
    from storage import db
    await feed(group_message("buy crypto now"), FakeJevClient({"buy crypto": SCAM}))
    rows = db.connect().execute("SELECT * FROM reviews").fetchall()
    assert len(rows) == 1
    assert rows[0]["text"] == "buy crypto now"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_group_handler.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'handlers.group'`

- [ ] **Step 3: Write the implementation**

```python
# core/actions.py
"""Executes a decision against Telegram. Nothing here decides anything."""
import json
import logging
import time
from collections import defaultdict, deque

from aiogram.exceptions import TelegramAPIError

from core.cards import card_keyboard, render_card
from core.policy import Action
from storage import audit, reviews

log = logging.getLogger("stopspam.actions")


class EnforcementLimiter:
    """Caps enforcement per chat per minute so a raid cannot turn the bot into
    a flood source and get it banned."""

    def __init__(self, per_minute: int) -> None:
        self._per_minute = per_minute
        self._events: dict[int, deque[float]] = defaultdict(deque)

    def allow(self, chat_id: int) -> bool:
        window = self._events[chat_id]
        now = time.monotonic()
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= self._per_minute:
            return False
        window.append(now)
        return True


async def apply(bot, *, message, outcome, chat, limiter: EnforcementLimiter) -> str:
    decision, verdict = outcome.decision, outcome.verdict
    if decision is None or decision.action == Action.IGNORE:
        return "ignored"

    if not limiter.allow(chat.chat_id):
        log.warning("enforcement rate limit hit in chat %s", chat.chat_id)
        audit.record(chat.chat_id, message.from_user.id, message.message_id,
                     decision.risk, "rate_limited", decision.reason)
        return "rate_limited"

    text = message.text or message.caption
    review_id = reviews.create(
        chat.chat_id, message.message_id, message.from_user.id, text,
        json.dumps(verdict.as_dict()), decision.risk,
    )

    deleted = False
    if decision.action == Action.DELETE:
        try:
            await bot.delete_message(chat.chat_id, message.message_id)
            deleted = True
        except TelegramAPIError as exc:
            log.warning("could not delete in chat %s: %s", chat.chat_id, exc)

    target = chat.log_chat_id or chat.chat_id
    body = render_card(
        decision=decision, verdict=verdict,
        author_name=message.from_user.full_name, author_id=message.from_user.id,
        text=text, chat_title=chat.title or str(chat.chat_id), lang=chat.lang,
    )
    if deleted:
        from texts import t
        body += f"\n\n<i>{t('card_deleted', chat.lang)}</i>"
    try:
        await bot.send_message(target, body,
                               reply_markup=card_keyboard(review_id, chat.lang))
    except TelegramAPIError as exc:
        log.warning("could not post card to %s: %s", target, exc)

    action = "deleted" if deleted else "reviewed"
    audit.record(chat.chat_id, message.from_user.id, message.message_id,
                 decision.risk, action, decision.reason, model=verdict.model)
    return action
```

```python
# handlers/group.py
"""Every group message passes through here."""
import logging

from aiogram import F, Router
from aiogram.enums import ChatMemberStatus, ChatType
from aiogram.exceptions import TelegramAPIError
from aiogram.types import Message

import config
from core import actions, pipeline, state
from core.jev import JevClient
from storage import chats, trust

log = logging.getLogger("stopspam.group")

router = Router(name="group")
router.message.filter(F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))

_client: JevClient | None = None
_limiter = actions.EnforcementLimiter(config.ENFORCEMENT_PER_MINUTE)

ADMIN_STATUSES = {ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR}


def set_client(client: JevClient) -> None:
    global _client
    _client = client


async def _is_admin(bot, chat_id: int, user_id: int) -> bool:
    try:
        member = await bot.get_chat_member(chat_id, user_id)
    except TelegramAPIError:
        return False
    return member.status in ADMIN_STATUSES


async def _can_delete(bot, chat_id: int) -> bool:
    try:
        me = await bot.get_chat_member(chat_id, (await bot.me()).id)
    except TelegramAPIError:
        return False
    # An owner always can; an administrator only with the explicit right.
    if me.status == ChatMemberStatus.CREATOR:
        return True
    return bool(getattr(me, "can_delete_messages", False))


@router.message()
async def on_group_message(message: Message) -> None:
    if _client is None or message.from_user is None or message.from_user.is_bot:
        return

    chat = chats.ensure_chat(message.chat.id, message.chat.title or "")
    row = trust.seen(message.chat.id, message.from_user.id)

    facts = state.facts_from_message(
        message,
        author_message_count=row.clean_count,
        author_days_in_group=trust.days_in_group(row),
        group_description="",
    )

    is_admin = await _is_admin(message.bot, message.chat.id, message.from_user.id)
    can_delete = await _can_delete(message.bot, message.chat.id)

    outcome = await pipeline.evaluate(
        _client,
        chat=chat,
        facts=facts,
        trust_row=row,
        is_admin=is_admin,
        can_delete=can_delete,
    )

    await actions.apply(message.bot, message=message, outcome=outcome,
                        chat=chat, limiter=_limiter)
```

> **Implementer note:** `pipeline.evaluate` takes the Jev client as its first
> argument, not the bot. The bot is passed separately to `actions.apply`, which is
> the only place that touches Telegram.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_group_handler.py -v`
Expected: PASS, 6 passed

- [ ] **Step 5: Commit**

```bash
git add core/actions.py handlers/group.py tests/test_group_handler.py
git commit -m "Add group handler, enforcement and review card posting"
```

---

### Task 12: Review card callbacks

**Files:**
- Create: `handlers/review.py`
- Test: `tests/test_review_handler.py`

**Interfaces:**
- Consumes: `storage.reviews`, `storage.trust`, `texts.t`.
- Produces: `handlers.review.router` handling `callback_data` matching `rv:(ban|del|ok):<id>`.

Behaviour:
- `ok` — resolves as `not_spam`, allowlists the author in that chat, answers with `done_not_spam`.
- `del` — deletes the message, resolves as `delete`.
- `ban` — deletes the message, bans the author, resolves as `delete_ban`.
- A press by a non-admin of the source chat is refused with `not_admin` and changes nothing.
- A press on an already-resolved review answers `already_handled`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_review_handler.py
import json
import os
import tempfile
from datetime import datetime, timezone

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.methods import (AnswerCallbackQuery, BanChatMember, DeleteMessage,
                             EditMessageText, GetChatMember, GetMe)
from aiogram.types import (CallbackQuery, Chat, ChatMemberAdministrator, ChatMemberMember,
                           Message, Update, User)

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
GROUP, LOG, SPAMMER, ADMIN, BYSTANDER = -100123, -100999, 555, 777, 888
calls: list = []


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    path = os.path.join(tempfile.mkdtemp(), "t.db")
    monkeypatch.setenv("DB_PATH", path)
    monkeypatch.setenv("BOT_TOKEN", "123:abc")
    import importlib
    import config
    importlib.reload(config)
    from storage import chats, db
    db.reset()
    calls.clear()
    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=LOG)
    yield
    db.reset()


async def fake_call(self, method, request_timeout=None):
    calls.append(method)
    if isinstance(method, GetMe):
        return User(id=1, is_bot=True, first_name="StopSpam", username="StopSpam_jev_bot")
    if isinstance(method, GetChatMember):
        if method.user_id == ADMIN:
            return ChatMemberAdministrator(
                user=User(id=ADMIN, is_bot=False, first_name="Boss"), status="administrator",
                can_be_edited=False, is_anonymous=False, can_manage_chat=True,
                can_delete_messages=True, can_manage_video_chats=True,
                can_restrict_members=True, can_promote_members=False,
                can_change_info=True, can_invite_users=True)
        return ChatMemberMember(
            user=User(id=method.user_id, is_bot=False, first_name="Nobody"), status="member")
    return True


Bot.__call__ = fake_call


def make_review() -> int:
    from storage import reviews
    return reviews.create(GROUP, 42, SPAMMER, "buy crypto now", json.dumps({}), 0.93)


def press(action: str, review_id: int, by: int = ADMIN) -> Update:
    card = Message(message_id=9001, date=NOW, chat=Chat(id=LOG, type="supergroup"),
                   text="card")
    query = CallbackQuery(
        id="q1", from_user=User(id=by, is_bot=False, first_name="Boss"),
        chat_instance="ci", message=card, data=f"rv:{action}:{review_id}",
    )
    return Update(update_id=1, callback_query=query)


async def feed(update: Update):
    from handlers import review
    bot = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dispatcher = Dispatcher()
    dispatcher.include_router(review.router)
    await dispatcher.feed_update(bot, update)


def answers():
    return [c for c in calls if isinstance(c, AnswerCallbackQuery)]


async def test_not_spam_allowlists_the_author():
    from storage import reviews, trust
    rid = make_review()
    await feed(press("ok", rid))
    assert trust.get(GROUP, SPAMMER).status == "allowlisted"
    assert reviews.get(rid)["decision"] == "not_spam"
    assert not [c for c in calls if isinstance(c, DeleteMessage)]


async def test_delete_removes_the_message():
    from storage import reviews
    rid = make_review()
    await feed(press("del", rid))
    deleted = [c for c in calls if isinstance(c, DeleteMessage)]
    assert deleted and deleted[0].message_id == 42
    assert reviews.get(rid)["decision"] == "delete"


async def test_ban_deletes_and_bans():
    from storage import reviews
    rid = make_review()
    await feed(press("ban", rid))
    assert [c for c in calls if isinstance(c, DeleteMessage)]
    banned = [c for c in calls if isinstance(c, BanChatMember)]
    assert banned and banned[0].user_id == SPAMMER
    assert reviews.get(rid)["decision"] == "delete_ban"


async def test_non_admin_press_changes_nothing():
    from storage import reviews
    rid = make_review()
    await feed(press("ban", rid, by=BYSTANDER))
    assert reviews.get(rid)["decision"] is None
    assert not [c for c in calls if isinstance(c, BanChatMember)]
    assert answers()[-1].text


async def test_second_press_is_refused():
    rid = make_review()
    await feed(press("del", rid))
    calls.clear()
    await feed(press("ban", rid))
    assert not [c for c in calls if isinstance(c, BanChatMember)]


async def test_card_is_edited_to_show_the_outcome():
    rid = make_review()
    await feed(press("del", rid))
    assert [c for c in calls if isinstance(c, EditMessageText)]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_review_handler.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'handlers.review'`

- [ ] **Step 3: Write the implementation**

```python
# handlers/review.py
"""Buttons on a review card. Only admins of the source chat may press them."""
import logging

from aiogram import F, Router
from aiogram.enums import ChatMemberStatus
from aiogram.exceptions import TelegramAPIError
from aiogram.types import CallbackQuery

from storage import audit, chats, reviews, trust
from texts import t

log = logging.getLogger("stopspam.review")

router = Router(name="review")

ADMIN_STATUSES = {ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR}
_DECISION = {"ban": "delete_ban", "del": "delete", "ok": "not_spam"}
_DONE_TEXT = {"ban": "done_ban", "del": "done_delete", "ok": "done_not_spam"}


@router.callback_query(F.data.startswith("rv:"))
async def on_card_button(query: CallbackQuery) -> None:
    _, action, raw_id = query.data.split(":", 2)
    review = reviews.get(int(raw_id))
    if review is None:
        await query.answer(t("already_handled"))
        return

    chat = chats.get_chat(review["chat_id"])
    lang = chat.lang if chat else "en"

    if review["decision"] is not None:
        await query.answer(t("already_handled", lang))
        return

    try:
        member = await query.bot.get_chat_member(review["chat_id"], query.from_user.id)
        is_admin = member.status in ADMIN_STATUSES
    except TelegramAPIError:
        is_admin = False
    if not is_admin:
        await query.answer(t("not_admin", lang), show_alert=True)
        return

    if action in ("ban", "del"):
        try:
            await query.bot.delete_message(review["chat_id"], review["message_id"])
        except TelegramAPIError as exc:
            log.warning("delete from card failed: %s", exc)
    if action == "ban":
        try:
            await query.bot.ban_chat_member(review["chat_id"], review["user_id"])
        except TelegramAPIError as exc:
            log.warning("ban from card failed: %s", exc)
        trust.mark_flagged(review["chat_id"], review["user_id"])
    if action == "ok":
        trust.allowlist(review["chat_id"], review["user_id"])

    reviews.resolve(int(raw_id), _DECISION[action], decided_by=query.from_user.id)
    audit.record(review["chat_id"], review["user_id"], review["message_id"],
                 review["risk"], f"card_{action}", f"by_admin_{query.from_user.id}")

    outcome = t(_DONE_TEXT[action], lang)
    try:
        await query.message.edit_text(f"{query.message.html_text}\n\n<i>{outcome}</i>")
    except TelegramAPIError:
        pass
    await query.answer(outcome)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_review_handler.py -v`
Expected: PASS, 6 passed

- [ ] **Step 5: Commit**

```bash
git add handlers/review.py tests/test_review_handler.py
git commit -m "Add review card callbacks with admin verification"
```

---

### Task 13: Admin DM menu

**Files:**
- Create: `handlers/admin.py`
- Modify: `texts.py` (add the menu strings listed below)
- Test: `tests/test_admin_handler.py`

**Interfaces:**
- Consumes: `storage.chats`, `texts.t`.
- Produces: `handlers.admin.router` — private-chat router handling `/start`, `/help`, `/privacy`, `/chats`, and callbacks `cfg:<chat_id>`, `cfg:<chat_id>:mode`, `cfg:<chat_id>:jev`, `cfg:<chat_id>:lang`, `cfg:<chat_id>:thr:<field>:<delta>`.

New `texts.py` keys (add with both `en` and `ru`): `welcome`, `help`, `privacy`, `no_chats`, `menu_title`, `menu_mode`, `menu_jev`, `menu_lang`, `menu_thresholds`, `menu_log_chat`, `menu_not_admin`, `btn_mode_observe`, `btn_mode_active`, `btn_jev_on`, `btn_jev_off`.

The `privacy` string must state, in English: that messages from checked users are sent to the TypeSafe API in the United States for classification, that message text is kept for at most 7 days in the review queue, and that admins can switch classification off per chat.

Admin rights are re-checked against Telegram on every menu render, never read from the database.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_admin_handler.py
import os
import tempfile
from datetime import datetime, timezone

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.methods import (AnswerCallbackQuery, EditMessageText, GetChatMember,
                             GetMe, SendMessage)
from aiogram.types import (CallbackQuery, Chat, ChatMemberAdministrator, ChatMemberMember,
                           Message, Update, User)

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
GROUP, ADMIN, BYSTANDER = -100123, 777, 888
calls: list = []


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    path = os.path.join(tempfile.mkdtemp(), "t.db")
    monkeypatch.setenv("DB_PATH", path)
    monkeypatch.setenv("BOT_TOKEN", "123:abc")
    import importlib
    import config
    importlib.reload(config)
    from storage import chats, db
    db.reset()
    calls.clear()
    chats.ensure_chat(GROUP, "Python Chat")
    yield
    db.reset()


async def fake_call(self, method, request_timeout=None):
    calls.append(method)
    if isinstance(method, GetMe):
        return User(id=1, is_bot=True, first_name="StopSpam", username="StopSpam_jev_bot")
    if isinstance(method, SendMessage):
        return Message(message_id=1, date=NOW, chat=Chat(id=method.chat_id, type="private"),
                       text=method.text)
    if isinstance(method, GetChatMember):
        if method.user_id == ADMIN:
            return ChatMemberAdministrator(
                user=User(id=ADMIN, is_bot=False, first_name="Boss"), status="administrator",
                can_be_edited=False, is_anonymous=False, can_manage_chat=True,
                can_delete_messages=True, can_manage_video_chats=True,
                can_restrict_members=True, can_promote_members=False,
                can_change_info=True, can_invite_users=True)
        return ChatMemberMember(
            user=User(id=method.user_id, is_bot=False, first_name="Nobody"), status="member")
    return True


Bot.__call__ = fake_call


async def feed(update: Update):
    from handlers import admin
    bot = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dispatcher = Dispatcher()
    dispatcher.include_router(admin.router)
    await dispatcher.feed_update(bot, update)


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
    assert sent()[-1].text


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_admin_handler.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'handlers.admin'`

- [ ] **Step 3: Write the implementation**

Add these keys to `texts.STRINGS` (English shown; write the Russian yourself, keeping the same meaning):

```python
"welcome": {
    "en": "I remove spam and scam messages from Telegram groups.\n\n"
          "Add me to your group, give me permission to delete messages and ban "
          "users, then send /chats here to configure me.\n\n"
          "For the first 7 days I only report what I would have removed, so you "
          "can judge my accuracy before enabling enforcement.",
    "ru": "...",
},
"privacy": {
    "en": "<b>Privacy</b>\n\n"
          "To classify a message I send its text and some metadata (link domains, "
          "whether it was forwarded, how long the author has been in the group) to "
          "the TypeSafe Jev API, which is operated in the United States.\n\n"
          "Only messages from users without established history in your group are "
          "sent, plus messages containing links, forwards or media captions.\n\n"
          "Message text is stored for at most 7 days in the review queue and is "
          "then erased. The audit log never stores message text.\n\n"
          "Any admin can switch classification off for a chat with /chats.",
    "ru": "...",
},
"no_chats": {
    "en": "I am not in any group you administer yet. Add me to a group first.",
    "ru": "...",
},
"menu_not_admin": {
    "en": "You are not an admin of that chat.",
    "ru": "...",
},
```

```python
# handlers/admin.py
"""Configuration menu in DM. Admin rights are checked against Telegram every time."""
import logging

from aiogram import F, Router
from aiogram.enums import ChatMemberStatus, ChatType
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import Command, CommandStart
from aiogram.types import (CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup,
                           Message)

from storage import chats, db
from texts import t

log = logging.getLogger("stopspam.admin")

router = Router(name="admin")
router.message.filter(F.chat.type == ChatType.PRIVATE)

ADMIN_STATUSES = {ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR}
THRESHOLD_STEP = 0.05
_LANGS = ("en", "ru")


async def _is_admin(bot, chat_id: int, user_id: int) -> bool:
    try:
        member = await bot.get_chat_member(chat_id, user_id)
    except TelegramAPIError:
        return False
    return member.status in ADMIN_STATUSES


async def _admin_chats(bot, user_id: int) -> list:
    known = db.connect().execute("SELECT chat_id FROM chats").fetchall()
    result = []
    for row in known:
        if await _is_admin(bot, row["chat_id"], user_id):
            result.append(chats.get_chat(row["chat_id"]))
    return result


def _menu(chat) -> tuple[str, InlineKeyboardMarkup]:
    lang = chat.lang
    body = "\n".join([
        f"<b>{chat.title or chat.chat_id}</b>",
        f"mode: {chat.mode}",
        f"classification: {'on' if chat.jev_enabled else 'off'}",
        f"delete >= {chat.delete_threshold:.2f}",
        f"review >= {chat.review_threshold:.2f}",
        f"confidence floor {chat.confidence_floor:.2f}",
        f"language: {lang}",
        f"log chat: {chat.log_chat_id or '(this chat)'}",
    ])
    cid = chat.chat_id
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"mode: {chat.mode}", callback_data=f"cfg:{cid}:mode"),
         InlineKeyboardButton(text=f"jev: {'on' if chat.jev_enabled else 'off'}",
                              callback_data=f"cfg:{cid}:jev")],
        [InlineKeyboardButton(text="delete −",
                              callback_data=f"cfg:{cid}:thr:delete_threshold:-"),
         InlineKeyboardButton(text="delete +",
                              callback_data=f"cfg:{cid}:thr:delete_threshold:+")],
        [InlineKeyboardButton(text="review −",
                              callback_data=f"cfg:{cid}:thr:review_threshold:-"),
         InlineKeyboardButton(text="review +",
                              callback_data=f"cfg:{cid}:thr:review_threshold:+")],
        [InlineKeyboardButton(text=f"lang: {lang}", callback_data=f"cfg:{cid}:lang")],
    ])
    return body, keyboard


@router.message(CommandStart())
async def on_start(message: Message) -> None:
    await message.answer(t("welcome"))


@router.message(Command("privacy"))
async def on_privacy(message: Message) -> None:
    await message.answer(t("privacy"))


@router.message(Command("help"))
async def on_help(message: Message) -> None:
    await message.answer(t("welcome"))


@router.message(Command("chats"))
async def on_chats(message: Message) -> None:
    owned = await _admin_chats(message.bot, message.from_user.id)
    if not owned:
        await message.answer(t("no_chats"))
        return
    for chat in owned:
        body, keyboard = _menu(chat)
        await message.answer(body, reply_markup=keyboard)


@router.callback_query(F.data.startswith("cfg:"))
async def on_config(query: CallbackQuery) -> None:
    parts = query.data.split(":")
    chat_id = int(parts[1])
    chat = chats.get_chat(chat_id)
    if chat is None:
        await query.answer(t("no_chats"))
        return

    if not await _is_admin(query.bot, chat_id, query.from_user.id):
        await query.answer(t("menu_not_admin", chat.lang), show_alert=True)
        return

    field = parts[2] if len(parts) > 2 else None
    if field == "mode":
        chat = chats.update_chat(
            chat_id, mode="active" if chat.mode == "observe" else "observe")
    elif field == "jev":
        chat = chats.update_chat(chat_id, jev_enabled=not chat.jev_enabled)
    elif field == "lang":
        nxt = _LANGS[(_LANGS.index(chat.lang) + 1) % len(_LANGS)] if chat.lang in _LANGS else "en"
        chat = chats.update_chat(chat_id, lang=nxt)
    elif field == "thr":
        name, sign = parts[3], parts[4]
        step = THRESHOLD_STEP if sign == "+" else -THRESHOLD_STEP
        current = getattr(chat, name)
        chat = chats.update_chat(chat_id, **{name: max(0.0, min(1.0, current + step))})

    body, keyboard = _menu(chat)
    try:
        await query.message.edit_text(body, reply_markup=keyboard)
    except TelegramAPIError:
        pass
    await query.answer()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_admin_handler.py -v`
Expected: PASS, 7 passed

- [ ] **Step 5: Commit**

```bash
git add handlers/admin.py texts.py tests/test_admin_handler.py
git commit -m "Add admin DM configuration menu and privacy command"
```

---

### Task 14: Entry point, README and housekeeping

**Files:**
- Create: `bot.py`, `README.md`
- Test: `tests/test_startup.py`

**Interfaces:**
- Consumes: every router and `core.jev.TypeSafeJevClient`.
- Produces: `bot.build_dispatcher() -> Dispatcher`, `bot.main()` (async), `bot.housekeeping()` (async, hourly `reviews.purge_expired()`).

`README.md` must be in English and cover: what the bot does, the observation window, the `@StopSpam_jev_bot` link, what is sent to TypeSafe and why (mirroring the `/privacy` text), how to self-host (`.env` keys, `docker compose up`), and how to run the tests.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_startup.py
import os
import tempfile

import pytest


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setenv("DB_PATH", os.path.join(tempfile.mkdtemp(), "t.db"))
    monkeypatch.setenv("BOT_TOKEN", "123:abc")
    monkeypatch.setenv("TYPESAFE_API_KEY", "ts_test")
    import importlib
    import config
    importlib.reload(config)
    from storage import db
    db.reset()
    yield
    db.reset()


def test_dispatcher_includes_every_router():
    import bot
    dispatcher = bot.build_dispatcher()
    names = {r.name for r in dispatcher.sub_routers}
    assert {"admin", "review", "group"} <= names


def test_group_router_is_last():
    """The catch-all group router must not swallow admin or callback updates."""
    import bot
    names = [r.name for r in bot.build_dispatcher().sub_routers]
    assert names[-1] == "group"


async def test_housekeeping_purges_expired_reviews():
    import json

    import bot
    from storage import db, reviews
    rid = reviews.create(-100, 1, 555, "spam", json.dumps({}), 0.9)
    db.connect().execute(
        "UPDATE reviews SET expires_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (rid,))
    db.connect().commit()

    await bot.housekeeping(once=True)
    assert reviews.get(rid)["text"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_startup.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'bot'`

- [ ] **Step 3: Write the implementation**

```python
# bot.py
"""@StopSpam_jev_bot - spam and scam moderation for Telegram groups."""
import asyncio
import logging
import sys

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import BotCommand

import config
from core.jev import TypeSafeJevClient
from handlers import admin, group, review
from storage import reviews

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("stopspam")

HOUSEKEEPING_INTERVAL = 3600


def build_dispatcher() -> Dispatcher:
    dispatcher = Dispatcher()
    # Order matters: the group router matches every group message, so the
    # specific routers are registered first.
    dispatcher.include_router(admin.router)
    dispatcher.include_router(review.router)
    dispatcher.include_router(group.router)
    return dispatcher


async def housekeeping(once: bool = False) -> None:
    while True:
        cleared = reviews.purge_expired()
        if cleared:
            log.info("purged text from %s expired reviews", cleared)
        if once:
            return
        await asyncio.sleep(HOUSEKEEPING_INTERVAL)


async def main() -> None:
    if not config.BOT_TOKEN:
        raise SystemExit("BOT_TOKEN is not set")
    if not config.TYPESAFE_API_KEY:
        raise SystemExit("TYPESAFE_API_KEY is not set")

    group.set_client(TypeSafeJevClient())
    bot = Bot(config.BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await bot.set_my_commands([
        BotCommand(command="chats", description="Configure your groups"),
        BotCommand(command="privacy", description="What data the bot sends and keeps"),
        BotCommand(command="help", description="How this bot works"),
    ])
    asyncio.create_task(housekeeping())
    await build_dispatcher().start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_startup.py -v`
Expected: PASS, 3 passed

Then run the whole suite: `python -m pytest -v`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add bot.py README.md tests/test_startup.py
git commit -m "Add entry point, housekeeping loop and README"
```

---

### Task 15: Docker and deployment

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.github/workflows/tests.yml`, `.github/workflows/deploy.yml`
- Test: manual verification steps below (this task ships configuration, not code)

**Interfaces:**
- Consumes: `bot.py`, `requirements.txt`.
- Produces: a container image running `python -u bot.py` with the database on a volume.

- [ ] **Step 1: Write the Dockerfile and compose file**

```dockerfile
# Dockerfile
FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
COPY core ./core
COPY handlers ./handlers
COPY storage ./storage

ENV DB_PATH=/data/stopspam.db
VOLUME /data
CMD ["python", "-u", "bot.py"]
```

```yaml
# docker-compose.yml
services:
  bot:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      DB_PATH: /data/stopspam.db
    volumes:
      - ./data:/data
```

- [ ] **Step 2: Verify the image builds and starts**

Run: `docker compose build`
Expected: build succeeds.

Run: `docker compose run --rm bot python -c "import bot; print(bot.build_dispatcher())"`
Expected: prints a `Dispatcher` object without raising.

- [ ] **Step 3: Add the CI workflow**

```yaml
# .github/workflows/tests.yml
name: tests
on: [push, pull_request]

jobs:
  pytest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - run: pip install -r requirements-dev.txt
      - run: python -m pytest -v
```

- [ ] **Step 4: Add the deploy workflow**

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: []
    steps:
      - uses: actions/checkout@v4
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd ${{ secrets.VPS_PATH }}
            git pull --ff-only
            docker compose up -d --build
```

> **Implementer note:** the repository is public, so `.env` must never be
> committed. Confirm `.gitignore` already lists `.env` before this task's commit,
> and set `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` and `VPS_PATH` as repository
> secrets. Match the workflow to whatever `feedback-bot` already uses on the same
> VPS if that differs from the template above.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .github
git commit -m "Add Docker image, test workflow and VPS deploy workflow"
```

---

### Task 16: End-to-end flow

A single test that runs a realistic sequence through the real dispatcher with a
fake Jev client and a fake Telegram transport, the way
`feedback-bot/tests/test_flow.py` does.

**Files:**
- Create: `tests/test_flow.py`

**Interfaces:**
- Consumes: everything built so far.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_flow.py
"""One realistic sequence end to end: newcomer spams, gets deleted, earns trust,
an admin reverses a call, and the reversed user is left alone afterwards."""
import os
import tempfile
from datetime import datetime, timezone

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.methods import DeleteMessage, GetChatMember, GetMe, SendMessage
from aiogram.types import (CallbackQuery, Chat, ChatMemberAdministrator, ChatMemberMember,
                           Message, Update, User)

from core.jev import FakeJevClient
from tests.fixtures.verdicts import CHATTER, SCAM

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
GROUP, LOG, SPAMMER, REGULAR, ADMIN = -100123, -100999, 555, 556, 777
calls: list = []


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setenv("DB_PATH", os.path.join(tempfile.mkdtemp(), "t.db"))
    monkeypatch.setenv("BOT_TOKEN", "123:abc")
    import importlib
    import config
    importlib.reload(config)
    from storage import db
    db.reset()
    calls.clear()
    yield
    db.reset()


async def fake_call(self, method, request_timeout=None):
    calls.append(method)
    if isinstance(method, GetMe):
        return User(id=1, is_bot=True, first_name="StopSpam", username="StopSpam_jev_bot")
    if isinstance(method, SendMessage):
        return Message(message_id=9000 + len(calls), date=NOW,
                       chat=Chat(id=method.chat_id, type="supergroup"), text=method.text)
    if isinstance(method, GetChatMember):
        if method.user_id in (ADMIN, 1):
            return ChatMemberAdministrator(
                user=User(id=method.user_id, is_bot=False, first_name="Boss"),
                status="administrator", can_be_edited=False, is_anonymous=False,
                can_manage_chat=True, can_delete_messages=True, can_manage_video_chats=True,
                can_restrict_members=True, can_promote_members=False,
                can_change_info=True, can_invite_users=True)
        return ChatMemberMember(
            user=User(id=method.user_id, is_bot=False, first_name="Ann"), status="member")
    return True


Bot.__call__ = fake_call


def group_message(text: str, user_id: int, msg_id: int) -> Update:
    return Update(update_id=msg_id, message=Message(
        message_id=msg_id, date=NOW,
        chat=Chat(id=GROUP, type="supergroup", title="Python Chat"),
        from_user=User(id=user_id, is_bot=False, first_name="Ann", username="ann"),
        text=text))


def deletions():
    return [c for c in calls if isinstance(c, DeleteMessage)]


async def test_full_flow():
    import bot as app
    from handlers import group
    from storage import chats, db, trust

    chats.ensure_chat(GROUP, "Python Chat")
    chats.update_chat(GROUP, log_chat_id=LOG, mode="active",
                      observe_until="2020-01-01T00:00:00+00:00")
    group.set_client(FakeJevClient({"buy crypto": SCAM}, default=CHATTER))

    telegram = Bot("123:abc", default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dispatcher = app.build_dispatcher()

    # 1. A newcomer posts a scam: deleted, card posted, author flagged.
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 1))
    assert len(deletions()) == 1
    assert trust.get(GROUP, SPAMMER).status == "flagged"

    # 2. A different newcomer chats normally five times and becomes trusted.
    for i in range(5):
        await dispatcher.feed_update(
            telegram, group_message(f"morning all {i}", REGULAR, 10 + i))
    assert trust.get(GROUP, REGULAR).status == "trusted"

    # 3. The trusted member's plain messages no longer reach the API.
    before = len(group._client.calls)
    await dispatcher.feed_update(telegram, group_message("still here", REGULAR, 20))
    assert len(group._client.calls) == before

    # 4. An admin reverses the original call from the card.
    review_id = db.connect().execute("SELECT id FROM reviews").fetchone()["id"]
    card = Message(message_id=9001, date=NOW, chat=Chat(id=LOG, type="supergroup"),
                   text="card")
    await dispatcher.feed_update(telegram, Update(update_id=30, callback_query=CallbackQuery(
        id="q", from_user=User(id=ADMIN, is_bot=False, first_name="Boss"),
        chat_instance="ci", message=card, data=f"rv:ok:{review_id}")))
    assert trust.get(GROUP, SPAMMER).status == "allowlisted"

    # 5. The reversed user is now left alone even when posting the same text.
    calls.clear()
    await dispatcher.feed_update(telegram, group_message("buy crypto now", SPAMMER, 40))
    assert deletions() == [], "an allowlisted user must never be acted upon"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_flow.py -v`
Expected: FAIL — the file is new; it fails on the first assertion that the wiring does not yet satisfy.

- [ ] **Step 3: Fix whatever the flow exposes**

No new modules. If this test fails, the bug is in the wiring between tasks 9, 11 and 12 — fix it there, and add the missing case to that task's own test file so it is caught at the unit level too.

- [ ] **Step 4: Run the full suite**

Run: `python -m pytest -v`
Expected: every test passes.

- [ ] **Step 5: Commit**

```bash
git add tests/test_flow.py
git commit -m "Add end-to-end flow test from spam deletion to admin reversal"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Jev questions, atomic, single call | 7 |
| State payload with author and group signals | 6 |
| Risk formula and three bands | 5 |
| Confidence-gated deletion | 5 (`test_high_risk_but_low_confidence_is_reviewed_not_deleted`) |
| Admins and allowlisted never acted upon | 5, 11, 12 |
| Missing delete permission degrades to review | 5, 11 |
| Observation mode, 7 days | 2, 5, 11 |
| Enforcement rate limit per group | 11 |
| Trust ledger, 5 clean messages, trigger re-check, 30-day silence | 3, 8 |
| Flagged forever, allowlist sticky | 3 |
| `chats` / `trust` / `reviews` / `audit` tables | 2, 3, 4 |
| `audit` stores no text; `reviews` TTL 7 days | 4, 14 |
| Admin DM menu, rights re-checked live | 13 |
| Review card with per-question breakdown, three buttons | 10, 12 |
| "Not spam" allowlists and labels the corpus | 12 |
| Fail-open on timeout, outage, rate limit | 7, 9, 11 |
| Privacy statement, per-chat Jev switch | 13, 14 |
| English UI, Russian option | 10, 13 |
| VPS, Docker, GitHub Actions | 15 |

No spec requirement is left without a task.

**Known gaps, deliberately deferred:** join-raid batching from the spec's failure
section is covered only by the per-group enforcement cap in Task 11, not by
request batching. Batching is an optimisation that needs real traffic to tune;
the cap already prevents the harm. Group descriptions are passed as `""` by the
group handler in Task 11 — populating them needs a `getChat` call per chat with
its own cache, which is worth adding once real false positives show it matters.
Both are listed here rather than hidden in a task.

**Type consistency:** `Verdict` field names are identical in Tasks 5, 7, 9 and 10.
`Decision.action`/`.risk`/`.reason` are used consistently in Tasks 5, 10, 11.
`trust.get`/`seen`/`record_clean`/`mark_flagged`/`allowlist`/`days_since_seen` are
used with the signatures defined in Task 3. `reviews.create`/`get`/`resolve`/
`purge_expired` match Task 4. Callback data `rv:<action>:<id>` is produced in
Task 10 and parsed in Task 12.
