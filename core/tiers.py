"""Which tier a chat is in, and whether it may delete.

Pure: no aiogram, no network, no database, and the clock is a parameter. That
is what lets the two boundaries (200, 1000) and the grace window be tested
exhaustively rather than through a mock of Telegram.

``config`` is imported for the four tunables, exactly as core.gate imports it
for RECHECK_AFTER_DAYS. Reading a constant is not I/O.
"""
import math
from dataclasses import dataclass
from datetime import datetime, timedelta

import config

FREE = "free"
SMALL = "small"
LARGE = "large"


@dataclass(frozen=True)
class Entitlement:
    """What a chat is allowed to do about spam, and why.

    ``active`` is the only field the policy sees. The rest exist so the log
    line, the menu and the review card can explain themselves.
    """

    tier: str
    active: bool
    reason: str
    price: int


def tier_for(member_count: int | None) -> str:
    """Which tier a group of this size is in.

    An unknown count reads as the free tier, deliberately. A chat whose count
    has never been fetched is brand new, which means it is inside its 7-day
    observation window and deleting nothing regardless; and if the lookup is
    failing for some other reason, a billing problem must not be what stops a
    group from being moderated.
    """
    if member_count is None or member_count <= config.FREE_MEMBER_LIMIT:
        return FREE
    if member_count <= config.SMALL_MEMBER_LIMIT:
        return SMALL
    return LARGE


def price_for(tier: str) -> int:
    """Stars per 30 days. Zero means there is nothing to sell."""
    return {
        FREE: 0,
        SMALL: config.PRICE_SMALL_STARS,
        LARGE: config.PRICE_LARGE_STARS,
    }.get(tier, 0)


def _parse(stamp: str | None) -> datetime | None:
    """A timestamp from our own database, or None if it is missing or bent.

    A malformed value is a bug worth finding, but the moderation path is not
    where it should surface as a crash, so it reads as absent.
    """
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(stamp)
    except ValueError:
        return None


def entitled(tier: str, *, paid_until: str | None, grace_until: str | None,
             now: datetime) -> tuple[bool, str]:
    """May this chat have spam deleted automatically, and on what grounds?

    The reason string reaches the audit row and the review card, so the order
    here is the order an admin is told about: being on the free tier beats
    having paid, and having paid beats being in the trial.
    """
    if tier == FREE:
        return True, "free_tier"
    expiry = _parse(paid_until)
    if expiry is not None and expiry > now:
        return True, "subscribed"
    grace = _parse(grace_until)
    if grace is not None and grace > now:
        return True, "grace"
    return False, "not_entitled"


def build(tier: str, *, paid_until: str | None, grace_until: str | None,
          now: datetime) -> Entitlement:
    active, reason = entitled(tier, paid_until=paid_until,
                              grace_until=grace_until, now=now)
    return Entitlement(tier=tier, active=active, reason=reason,
                       price=price_for(tier))


def count_is_stale(member_count_at: str | None, *, now: datetime) -> bool:
    """True when the cached member count is old enough to refetch.

    Never fetched, or fetched at a time we can no longer read, both count as
    stale: the cost of an extra API call once is far below the cost of a chat
    stuck on a count that can never be refreshed.
    """
    fetched = _parse(member_count_at)
    if fetched is None:
        return True
    return now - fetched >= timedelta(hours=config.MEMBER_COUNT_TTL_HOURS)


def days_left(stamp: str | None, *, now: datetime) -> int:
    """Whole days remaining, rounded up, never negative.

    Rounded up because "1 day left" is the honest thing to tell someone with
    eleven hours: rounding down would say zero while the trial still worked.
    """
    when = _parse(stamp)
    if when is None or when <= now:
        return 0
    return math.ceil((when - now).total_seconds() / 86400)
