"""Grey-zone queue. Text expires after the TTL; the human label does not."""
import logging
import sqlite3
from datetime import datetime, timedelta, timezone

import config
from storage import db

log = logging.getLogger("stopspam.reviews")


def _purge_on_the_way_past() -> None:
    """Erases expired text whenever new text is stored.

    purge_expired() is the only thing that erases stored message text, and
    until now the only thing that called it was one unsupervised task in
    bot.py. That task is not awaited and is not restarted when it dies from
    something its own sqlite3.Error guard does not catch - while the bot
    keeps running and keeps storing text. The 7-day erasure promised in
    README.md and behind /privacy would then quietly stop being true, with
    nothing but a log line to say so.

    Tying the purge to create() ties erasure to the event that creates the
    debt: no new message text is stored without expired text being cleared
    in the same call, whatever became of the hourly loop. The loop stays as
    the mechanism that erases text in a quiet group, where nothing new is
    being written to trigger this.

    A failure here must not lose the review row that was just written, so it
    is logged rather than raised; the hourly loop will try again.
    """
    try:
        cleared = purge_expired()
    except sqlite3.Error as exc:
        log.warning("opportunistic purge failed: %s", exc)
        return
    if cleared:
        log.info("purged text from %s expired reviews", cleared)


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
    review_id = cursor.lastrowid
    _purge_on_the_way_past()
    return review_id


def get(review_id: int) -> sqlite3.Row | None:
    return db.connect().execute(
        "SELECT * FROM reviews WHERE id = ?", (review_id,)
    ).fetchone()


def resolve(review_id: int, decision: str, decided_by: int) -> bool:
    """Claims and resolves a review, but only if nobody has resolved it yet.

    The `decision IS NULL` clause makes this an atomic compare-and-set: two
    overlapping callers (a double-tap, two admins racing on the same card)
    can both read a review with `decision IS NULL` before either writes, but
    only one UPDATE can match this WHERE clause once the other has
    committed. The return value tells the caller whether *it* was the one
    that won the claim, so a caller can gate its destructive side effects on
    actually owning the review rather than merely having seen it unresolved.
    """
    conn = db.connect()
    cursor = conn.execute(
        """UPDATE reviews SET decision = ?, decided_by = ?, decided_at = ?
           WHERE id = ? AND decision IS NULL""",
        (decision, decided_by, db.now(), review_id),
    )
    conn.commit()
    return cursor.rowcount > 0


def purge_expired() -> int:
    """Clears stored message text past its TTL, keeping the labelled verdict."""
    conn = db.connect()
    cursor = conn.execute(
        "UPDATE reviews SET text = NULL WHERE text IS NOT NULL AND expires_at < ?",
        (db.now(),),
    )
    conn.commit()
    return cursor.rowcount
