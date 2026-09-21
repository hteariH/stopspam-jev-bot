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
