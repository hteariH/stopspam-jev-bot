from datetime import datetime, timedelta, timezone

import pytest

from core import tiers

NOW = datetime(2026, 9, 21, 12, 0, 0, tzinfo=timezone.utc)


def stamp(**delta) -> str:
    return (NOW + timedelta(**delta)).isoformat(timespec="seconds")


# --- tier boundaries, exhaustively ---

@pytest.mark.parametrize("count,expected", [
    (0, tiers.FREE),
    (1, tiers.FREE),
    (200, tiers.FREE),
    (201, tiers.SMALL),
    (1000, tiers.SMALL),
    (1001, tiers.LARGE),
    (50_000, tiers.LARGE),
])
def test_tier_boundaries(count, expected):
    assert tiers.tier_for(count) == expected


def test_unknown_count_reads_as_free():
    """A billing lookup that never succeeded must not stop a group being
    moderated."""
    assert tiers.tier_for(None) == tiers.FREE


def test_prices_match_the_spec():
    assert tiers.price_for(tiers.FREE) == 0
    assert tiers.price_for(tiers.SMALL) == 50
    assert tiers.price_for(tiers.LARGE) == 250


# --- entitlement ---

def test_free_tier_is_always_entitled_even_with_nothing_paid():
    assert tiers.entitled(tiers.FREE, paid_until=None, grace_until=None,
                          now=NOW) == (True, "free_tier")


def test_paid_subscription_entitles():
    assert tiers.entitled(tiers.LARGE, paid_until=stamp(days=5),
                          grace_until=None, now=NOW) == (True, "subscribed")


def test_grace_entitles_when_nothing_is_paid():
    assert tiers.entitled(tiers.SMALL, paid_until=None,
                          grace_until=stamp(days=3), now=NOW) == (True, "grace")


def test_subscription_outranks_grace():
    active, reason = tiers.entitled(tiers.SMALL, paid_until=stamp(days=5),
                                    grace_until=stamp(days=3), now=NOW)
    assert (active, reason) == (True, "subscribed")


def test_expired_subscription_and_expired_grace_is_not_entitled():
    assert tiers.entitled(tiers.LARGE, paid_until=stamp(days=-1),
                          grace_until=stamp(days=-1), now=NOW) == (False, "not_entitled")


def test_paid_tier_with_nothing_at_all_is_not_entitled():
    assert tiers.entitled(tiers.SMALL, paid_until=None, grace_until=None,
                          now=NOW) == (False, "not_entitled")


def test_expiry_exactly_now_has_expired():
    """The boundary is strict: paid_until == now means the period is over."""
    assert tiers.entitled(tiers.SMALL, paid_until=NOW.isoformat(timespec="seconds"),
                          grace_until=None, now=NOW) == (False, "not_entitled")


def test_a_corrupt_timestamp_does_not_raise():
    """A malformed row is a bug to find in the log, not a crash in the
    moderation path. It reads as absent."""
    assert tiers.entitled(tiers.SMALL, paid_until="not-a-date",
                          grace_until=None, now=NOW) == (False, "not_entitled")


# --- Entitlement value ---

def test_build_carries_the_price_of_the_tier():
    ent = tiers.build(tiers.LARGE, paid_until=None, grace_until=None, now=NOW)
    assert (ent.tier, ent.active, ent.reason, ent.price) == (
        tiers.LARGE, False, "not_entitled", 250)


def test_build_on_free_tier_has_no_price_to_show():
    ent = tiers.build(tiers.FREE, paid_until=None, grace_until=None, now=NOW)
    assert (ent.active, ent.price) == (True, 0)


# --- staleness and countdown ---

def test_a_count_never_fetched_is_stale():
    assert tiers.count_is_stale(None, now=NOW) is True


def test_a_count_fetched_an_hour_ago_is_fresh():
    assert tiers.count_is_stale(stamp(hours=-1), now=NOW) is False


def test_a_count_fetched_two_days_ago_is_stale():
    assert tiers.count_is_stale(stamp(days=-2), now=NOW) is True


def test_a_corrupt_fetch_time_counts_as_stale():
    assert tiers.count_is_stale("not-a-date", now=NOW) is True


def test_days_left_rounds_up_so_a_partial_day_still_counts():
    assert tiers.days_left(stamp(hours=30), now=NOW) == 2


def test_days_left_is_zero_once_past():
    assert tiers.days_left(stamp(days=-1), now=NOW) == 0
    assert tiers.days_left(None, now=NOW) == 0
