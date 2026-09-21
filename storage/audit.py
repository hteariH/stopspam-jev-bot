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
