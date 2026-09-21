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


def _exists(chat_id: int, user_id: int) -> bool:
    """Check if a trust row exists for this (chat, user) pair."""
    row = db.connect().execute(
        "SELECT 1 FROM trust WHERE chat_id = ? AND user_id = ?", (chat_id, user_id)
    ).fetchone()
    return row is not None


def get(chat_id: int, user_id: int) -> TrustRow:
    """Get the trust row for a user in a chat, returning default 'unknown' if absent."""
    return _row(chat_id, user_id)


def seen(chat_id: int, user_id: int, joined_at: str | None = None) -> TrustRow:
    """Records that we just saw this user, and returns their history BEFORE it.

    Callers judge the current message against the author's prior record. If this
    returned the refreshed row, days_since_seen would always be ~0 and the
    30-day re-check in core.gate could never fire.
    """
    prior = _row(chat_id, user_id)
    row_existed = _exists(chat_id, user_id)
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
    if not row_existed:
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
    current = _row(chat_id, user_id)
    if current.status == ALLOWLISTED:
        return current
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
