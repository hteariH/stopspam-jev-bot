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
