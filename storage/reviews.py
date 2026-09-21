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
