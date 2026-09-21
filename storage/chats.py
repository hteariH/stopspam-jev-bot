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


def candidate_chat_ids(user_id: int, limit: int) -> list[int]:
    """Chat ids this user plausibly belongs to, at most `limit` of them.

    /chats is a public command: anybody who can DM the bot can run it, and
    the chats table grows without bound as the bot is added to more groups.
    Verifying admin rights against Telegram for every known chat would mean
    one get_chat_member call per group per stranger, which walks straight
    into Telegram's flood limits at a few hundred groups.

    Two kinds of row already tie a user to a chat, and both are far smaller
    than "every chat": the chat whose review cards go to this user (set when
    they added the bot), and the trust ledger rows written for every message
    they have posted. A user who is an admin of a group but has never posted
    there and did not add the bot is not in this set - they need to post once,
    or have a co-admin point the log chat at them.

    The limit is a hard cap, not a page: it bounds the Telegram calls one
    command can cause, which is the whole point.
    """
    rows = db.connect().execute(
        """SELECT chat_id FROM chats WHERE log_chat_id = ?
           UNION
           SELECT chat_id FROM trust WHERE user_id = ?
           LIMIT ?""",
        (user_id, user_id, limit),
    ).fetchall()
    return [row["chat_id"] for row in rows]


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
