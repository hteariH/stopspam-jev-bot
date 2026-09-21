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

-- The trust primary key is (chat_id, user_id), so "which chats has this
-- user been seen in" - the candidate set behind /chats - would otherwise be
-- a full scan of every member of every group the bot is in.
CREATE INDEX IF NOT EXISTS idx_trust_user ON trust (user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_chat ON reviews (chat_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_audit_chat ON audit (chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_chat ON payments (chat_id, created_at);
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
