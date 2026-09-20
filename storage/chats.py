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
