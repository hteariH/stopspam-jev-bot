"""Tests for core.ratelimit.RateLimiter.

core.actions.apply() itself is exercised end-to-end in
tests/test_group_handler.py; this covers the limiter as the pure, injectable
piece it is: no Telegram objects, no storage.
"""
from core.ratelimit import RateLimiter


def test_refuses_once_the_per_minute_budget_is_spent():
    limiter = RateLimiter(per_minute=3)
    chat_id = 1
    assert limiter.allow(chat_id) is True
    assert limiter.allow(chat_id) is True
    assert limiter.allow(chat_id) is True
    assert limiter.allow(chat_id) is False


def test_budget_is_tracked_per_chat_not_globally():
    limiter = RateLimiter(per_minute=1)
    assert limiter.allow(1) is True
    assert limiter.allow(1) is False
    # A second chat has never enforced anything and must get its own budget -
    # if the limiter tracked one shared window across all chats, this would
    # also be refused because chat 1 already spent it.
    assert limiter.allow(2) is True
